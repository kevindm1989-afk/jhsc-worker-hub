// /api/excel-imports/* — Milestone 1.11 S2.
//
// Routes (ADR-0010 §3.9 / §3.10 / §3.11):
//
//   POST   /api/excel-imports               — create pending import.
//                                              Envelope-encrypts the
//                                              source filename + optional
//                                              Inspection Review snapshot.
//                                              Emits excel_import.uploaded.
//   GET    /api/excel-imports               — list metadata for the
//                                              actor's imports.
//   GET    /api/excel-imports/:id           — detail (decrypts source
//                                              filename for display).
//   GET    /api/excel-imports/:id/items     — paginated per-row items.
//   PATCH  /api/excel-imports/:id           — pending → preview
//                                              transition.
//   POST   /api/excel-imports/:id/items     — batch-insert excel_import_
//                                              items in the preview state.
//   POST   /api/excel-imports/:id/commit    — STEP-UP gated single-shot
//                                              transaction. Walks every
//                                              item; INSERTs / PATCHes /
//                                              skips per its status;
//                                              emits per-row chain
//                                              anchors with the additive
//                                              createdByImportId field
//                                              + the batch
//                                              excel_import.committed
//                                              anchor.
//   POST   /api/excel-imports/:id/cancel    — cancel a pending/preview
//                                              import. Cancellation
//                                              chain anchor deferred to
//                                              1.12 (runbook §11).
//   POST   /api/excel-imports/:id/reverse   — STEP-UP gated 30-day
//                                              reverse. Soft-deletes
//                                              created action_items
//                                              (status='Cancelled' +
//                                              section='archived');
//                                              reverts updated rows
//                                              from beforeStateJson;
//                                              emits excel_import.
//                                              reversed.
//
// Middleware order mirrors recommendations / inspections / action-items:
//   authMiddleware -> idempotencyKey -> rateLimit -> bodyLimit.
//
// SINGLE-TENANT SIMPLIFICATION: any authenticated rep can list/read any
// import they created. Cross-actor reads are NOT supported — the
// imported_by_user_id check is the boundary. A future workplace-roles
// table is a runbook follow-up; the single-tenant scope is bounded.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { append } from '@jhsc/audit';
import {
  actionItemRisk,
  actionItemSection,
  actionItemType,
  excelImportItemStatus,
  excelImportSchemaVersion,
  type ActionItemSection,
  type ActionItemType,
  type ActionItemRisk,
  type ExcelImportStatus,
  type ExcelImportItemStatus,
  type ExcelImportSchemaVersion,
} from '@jhsc/shared-types';
import { getDb } from '../../db/client';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { idempotencyKey } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rate-limit';
import {
  sealExcelImportField,
  sealOptionalExcelImportField,
  openExcelImportField,
} from '../../excel-imports/crypto';
import { allocateSequenceNumber } from '../action-items';

export const excelImportsRoute = new Hono();

excelImportsRoute.use('*', authMiddleware());
// 1.10 (ADR-0009 §3.4): idempotencyKey AFTER auth, BEFORE rate-limit.
excelImportsRoute.use('*', idempotencyKey());
// Modest cap since commits are heavyweight. Per ADR §3.10, per-actor
// commit + reverse rate-limits are stricter (5/hour + 3/hour
// respectively); those are enforced inline on those routes via the
// in-memory token bucket pattern (mirrors 1.8 / 1.9 export limits).
excelImportsRoute.use('*', rateLimit({ name: 'excel-imports', capacity: 30, refillPerSecond: 5 }));
// 2 MB body cap. The raw .xlsx file is NEVER uploaded to the server
// (non-negotiable #11); the largest body in this group is the items
// batch — 5000 rows × ~400 bytes of envelope-encrypted metadata each
// ≈ 2 MB worst-case.
excelImportsRoute.use(
  '*',
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// ---------------------------------------------------------------------------
// Per-actor commit + reverse rate buckets (ADR §3.10)
// ---------------------------------------------------------------------------
//
// Token-bucket per actor — separate buckets for commit + reverse so the
// reverse path doesn't share quota with the commit path. Same shape as
// apps/api/src/routes/inspections/exports.ts: in-memory, restart resets,
// pg-boss backed limiter is a 1.12 follow-up (runbook §11).

interface ActorBucket {
  tokens: number;
  lastRefillMs: number;
}

const COMMIT_CAPACITY = 5;
const COMMIT_REFILL_PER_HOUR = 5;
const REVERSE_CAPACITY = 3;
const REVERSE_REFILL_PER_HOUR = 3;

const commitBuckets = new Map<string, ActorBucket>();
const reverseBuckets = new Map<string, ActorBucket>();

function consumeBucket(
  buckets: Map<string, ActorBucket>,
  capacity: number,
  refillPerHour: number,
  userId: string,
): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b) {
    b = { tokens: capacity, lastRefillMs: now };
    buckets.set(userId, b);
  }
  const elapsedHours = (now - b.lastRefillMs) / (3600 * 1000);
  b.tokens = Math.min(capacity, b.tokens + elapsedHours * refillPerHour);
  b.lastRefillMs = now;
  if (b.tokens < 1) {
    const needed = 1 - b.tokens;
    const secs = Math.ceil((needed / refillPerHour) * 3600);
    return { ok: false, retryAfterSeconds: secs };
  }
  b.tokens -= 1;
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test-only: reset every per-actor commit + reverse bucket. */
export function _resetExcelImportBucketsForTests(): void {
  commitBuckets.clear();
  reverseBuckets.clear();
}

// ---------------------------------------------------------------------------
// Sentinel for transaction rollback paths
// ---------------------------------------------------------------------------

class ExcelImportWriteAborted extends Error {
  readonly payload: { status: number; body: Record<string, unknown> };
  constructor(payload: { status: number; body: Record<string, unknown> }) {
    super(`excel_import_write_aborted: ${payload.status}`);
    this.name = 'ExcelImportWriteAborted';
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const uuidParam = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64-char lowercase hex (SHA-256)');

const createBody = z
  .object({
    sourceFilename: z.string().min(1).max(255),
    sourceSha256: hex64,
    schemaVersion: z.enum(excelImportSchemaVersion),
    rowCount: z.number().int().min(0).max(50000),
    // Optional opaque JSONB snapshot of the Inspection Review sheet.
    // The parser produced a `{rows: string[][]}` shape; we accept any
    // JSON object here and store the canonical-JSON form.
    inspectionReviewSnapshot: z.record(z.unknown()).optional(),
  })
  .strict();

const patchBody = z.object({}).strict();
const cancelBody = z.object({}).strict();
const commitBody = z.object({}).strict();
const reverseBody = z.object({}).strict();

const itemsBatchBody = z
  .object({
    items: z
      .array(
        z
          .object({
            sourceRowIndex: z.number().int().min(0).max(50000),
            section: z.enum(actionItemSection),
            contentHash: hex64,
            status: z.enum(excelImportItemStatus),
            beforeState: z.record(z.unknown()).optional(),
            clientId: z.string().uuid(),
            // The rep's preview-finalized per-row decisions. Sensitive
            // fields are already envelope-encrypted client-side. We
            // accept opaque base64 strings for the ciphertexts here
            // and decode at INSERT time.
            actionItemRow: z
              .object({
                type: z.enum(actionItemType),
                typeSubtype: z.string().max(64).nullable().optional(),
                descriptionCt: z
                  .string()
                  .min(1)
                  .max(64 * 1024),
                descriptionDekCt: z.string().min(1).max(8192),
                recommendedActionCt: z
                  .string()
                  .max(64 * 1024)
                  .nullable()
                  .optional(),
                recommendedActionDekCt: z.string().max(8192).nullable().optional(),
                raisedByCt: z.string().max(8192).nullable().optional(),
                raisedByDekCt: z.string().max(8192).nullable().optional(),
                followUpOwnerCt: z.string().max(8192).nullable().optional(),
                followUpOwnerDekCt: z.string().max(8192).nullable().optional(),
                department: z.string().max(120).nullable().optional(),
                status: z
                  .enum([
                    'Not Started',
                    'In Progress',
                    'Blocked',
                    'Pending Review',
                    'Closed',
                    'Cancelled',
                  ])
                  .default('Not Started'),
                risk: z.enum(actionItemRisk),
                startDate: isoDate,
                targetDate: isoDate.nullable().optional(),
                closedDate: isoDate.nullable().optional(),
                tags: z.array(z.string().max(64)).max(16).default([]),
                // For 'updated' decisions only — the existing
                // action_item being patched.
                actionItemId: z.string().uuid().optional(),
                ifMatchVersion: z.number().int().min(1).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(5000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  // Node + Bun + the test env all support Buffer.from(b64, 'base64').
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * Canonical-JSON-stringify an object for stable envelope encryption.
 * Same canonicalization as @jhsc/audit so the chain hash is
 * reproducible across runtimes.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// POST /api/excel-imports — create pending import
// ---------------------------------------------------------------------------

excelImportsRoute.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const db = getDb();

  // Envelope-encrypt the source filename (T-X19) + optional
  // inspection-review snapshot (T-X13).
  const filenameSealed = sealExcelImportField(body.sourceFilename);
  const snapshotSealed = sealOptionalExcelImportField(
    body.inspectionReviewSnapshot ? canonicalJson(body.inspectionReviewSnapshot) : null,
  );
  const sourceSha256Bytes = hexToBytes(body.sourceSha256);

  const importId = crypto.randomUUID();

  const created = await db.transaction(async (tx) => {
    const chainRow = await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'excel_import.uploaded',
        importId,
        sourceSha256: body.sourceSha256,
        rowCount: body.rowCount,
        schemaVersion: body.schemaVersion,
      },
      resourceType: 'excel_imports',
      resourceId: importId,
    });

    const rows = (await tx.execute(sql`
      INSERT INTO excel_imports (
        id, imported_by_user_id,
        source_filename_ct, source_filename_dek_ct,
        source_sha256, schema_version, row_count, status,
        inspection_review_snapshot_ct, inspection_review_snapshot_dek_ct,
        audit_idx
      )
      VALUES (
        ${importId}, ${auth.userId},
        ${Buffer.from(filenameSealed.ct) as unknown as Uint8Array},
        ${Buffer.from(filenameSealed.dekCt) as unknown as Uint8Array},
        ${Buffer.from(sourceSha256Bytes) as unknown as Uint8Array},
        ${body.schemaVersion}, ${body.rowCount}, 'pending',
        ${snapshotSealed ? (Buffer.from(snapshotSealed.ct) as unknown as Uint8Array) : null},
        ${snapshotSealed ? (Buffer.from(snapshotSealed.dekCt) as unknown as Uint8Array) : null},
        ${chainRow.idx}
      )
      RETURNING created_at::text AS created_at
    `)) as unknown as Array<{ created_at: string }>;
    return { createdAt: rows[0]!.created_at, auditIdx: Number(chainRow.idx) };
  });

  return c.json(
    {
      id: importId,
      status: 'pending' as ExcelImportStatus,
      createdAt: created.createdAt,
      auditIdx: created.auditIdx,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// PATCH /api/excel-imports/:id — pending → preview transition
// ---------------------------------------------------------------------------

excelImportsRoute.patch('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = patchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id, status, imported_by_user_id
        FROM excel_imports
        WHERE id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        status: string;
        imported_by_user_id: string;
      }>;
      if (rows.length === 0) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = rows[0]!;
      if (row.imported_by_user_id !== auth.userId) {
        // Same single-tenant posture as recommendations — we 404 cross-
        // actor reads to avoid disclosing the existence of the row.
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      if (row.status !== 'pending') {
        throw new ExcelImportWriteAborted({
          status: 422,
          body: { error: 'invalid_state_transition', from: row.status, to: 'preview' },
        });
      }
      const upd = (await tx.execute(sql`
        UPDATE excel_imports
        SET status = 'preview', previewed_at = now()
        WHERE id = ${idParsed.data}
        RETURNING previewed_at::text AS previewed_at
      `)) as unknown as Array<{ previewed_at: string }>;
      return { previewedAt: upd[0]!.previewed_at };
    });
    return c.json({
      id: idParsed.data,
      status: 'preview' as ExcelImportStatus,
      previewedAt: result.previewedAt,
    });
  } catch (err) {
    if (err instanceof ExcelImportWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/excel-imports/:id/items — batch-insert excel_import_items
// ---------------------------------------------------------------------------

excelImportsRoute.post('/:id/items', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = itemsBatchBody.safeParse(await c.req.json().catch(() => null));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const body = bodyParsed.data;
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id, status, imported_by_user_id
        FROM excel_imports
        WHERE id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string; imported_by_user_id: string }>;
      if (rows.length === 0) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = rows[0]!;
      if (row.imported_by_user_id !== auth.userId) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      if (row.status !== 'preview') {
        throw new ExcelImportWriteAborted({
          status: 422,
          body: { error: 'invalid_state_transition', from: row.status, to: 'preview_items' },
        });
      }

      // Atomic batch INSERT. UNIQUE(import_id, content_hash) catches
      // duplicate content_hashes within the same import; the SQL
      // UNIQUE violation propagates as a 422 to the route.
      let insertedCount = 0;
      for (const item of body.items) {
        try {
          await tx.execute(sql`
            INSERT INTO excel_import_items (
              import_id, source_row_index, section,
              content_hash, status, before_state_json
            )
            VALUES (
              ${idParsed.data},
              ${item.sourceRowIndex},
              ${item.section},
              ${Buffer.from(hexToBytes(item.contentHash)) as unknown as Uint8Array},
              ${item.status},
              ${item.beforeState ? JSON.stringify({ ...item.beforeState, actionItemRow: item.actionItemRow, clientId: item.clientId }) : JSON.stringify({ actionItemRow: item.actionItemRow, clientId: item.clientId })}::jsonb
            )
          `);
          insertedCount++;
        } catch (e) {
          // Drizzle surfaces UNIQUE violations as Postgres errors with
          // code 23505. We don't get the typed enum here; substring-
          // match the SQLSTATE-bearing error message.
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('excel_import_items_import_content_hash_unique')) {
            throw new ExcelImportWriteAborted({
              status: 422,
              body: {
                error: 'duplicate_content_hash',
                contentHash: item.contentHash,
                sourceRowIndex: item.sourceRowIndex,
              },
            });
          }
          throw e;
        }
      }
      return { insertedCount };
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof ExcelImportWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/excel-imports/:id/commit — single-shot transaction
// ---------------------------------------------------------------------------

excelImportsRoute.post('/:id/commit', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = commitBody.safeParse(await c.req.json().catch(() => ({})));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');

  // (1) CSRF guard is at the root middleware level; the x-requested-with
  //     header has already been verified by csrfHeaderGuard before
  //     reaching this route.

  // (2) Step-up freshness (ADR §3.10).
  const challenge = checkStepUpFreshness(auth, {
    action: 'excel_import.commit',
    maxAgeSeconds: 60,
  });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }

  // (3) Per-actor commit rate limit (5/hour).
  const bucket = consumeBucket(commitBuckets, COMMIT_CAPACITY, COMMIT_REFILL_PER_HOUR, auth.userId);
  if (!bucket.ok) {
    c.header('Retry-After', String(bucket.retryAfterSeconds));
    return c.json({ error: 'rate_limited', retryAfterSeconds: bucket.retryAfterSeconds }, 429);
  }

  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      // SELECT FOR UPDATE on the import + the imported_by_user_id check.
      const importRows = (await tx.execute(sql`
        SELECT id, status, imported_by_user_id, source_sha256, schema_version, row_count
        FROM excel_imports
        WHERE id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        status: string;
        imported_by_user_id: string;
        source_sha256: Uint8Array;
        schema_version: string;
        row_count: number;
      }>;
      if (importRows.length === 0) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const importRow = importRows[0]!;
      if (importRow.imported_by_user_id !== auth.userId) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      if (importRow.status !== 'preview') {
        throw new ExcelImportWriteAborted({
          status: 422,
          body: { error: 'invalid_state_transition', from: importRow.status, to: 'committed' },
        });
      }

      // Pull every item for this import.
      const itemRows = (await tx.execute(sql`
        SELECT id, source_row_index, section, content_hash, status, before_state_json
        FROM excel_import_items
        WHERE import_id = ${idParsed.data}
        ORDER BY source_row_index ASC, id ASC
      `)) as unknown as Array<{
        id: string;
        source_row_index: number;
        section: string;
        content_hash: Uint8Array;
        status: string;
        before_state_json: Record<string, unknown> | null;
      }>;

      // Conflict-pending rows block the commit (ADR §3.9 — the rep must
      // resolve every conflict in preview before commit).
      const unresolved = itemRows.filter((r) => r.status === 'conflict_pending');
      if (unresolved.length > 0) {
        throw new ExcelImportWriteAborted({
          status: 422,
          body: { error: 'conflicts_unresolved', count: unresolved.length },
        });
      }

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      const conflictResolvedCount = 0; // populated when 1.12 lands the rep-driven resolution flow

      for (const item of itemRows) {
        const itemStatus = item.status as ExcelImportItemStatus;
        const payload = (item.before_state_json ?? {}) as {
          actionItemRow?: Record<string, unknown>;
          clientId?: string;
        };
        const aiRow = payload.actionItemRow ?? null;
        const clientId = payload.clientId ?? null;

        if (itemStatus === 'created') {
          if (!aiRow || !clientId) {
            throw new ExcelImportWriteAborted({
              status: 422,
              body: {
                error: 'item_missing_action_item_row',
                itemId: item.id,
              },
            });
          }
          const ai = aiRow as {
            type: ActionItemType;
            typeSubtype: string | null;
            descriptionCt: string;
            descriptionDekCt: string;
            recommendedActionCt: string | null;
            recommendedActionDekCt: string | null;
            raisedByCt: string | null;
            raisedByDekCt: string | null;
            followUpOwnerCt: string | null;
            followUpOwnerDekCt: string | null;
            department: string | null;
            status: string;
            risk: ActionItemRisk;
            startDate: string;
            targetDate: string | null;
            closedDate: string | null;
            tags: ReadonlyArray<string>;
          };

          const sequenceNumber = await allocateSequenceNumber(tx, item.section);
          const newActionItemId = clientId;
          const descCt = base64ToBytes(ai.descriptionCt);
          const descDekCt = base64ToBytes(ai.descriptionDekCt);
          const recCt = ai.recommendedActionCt ? base64ToBytes(ai.recommendedActionCt) : null;
          const recDekCt = ai.recommendedActionDekCt
            ? base64ToBytes(ai.recommendedActionDekCt)
            : null;
          const raisedCt = ai.raisedByCt ? base64ToBytes(ai.raisedByCt) : null;
          const raisedDekCt = ai.raisedByDekCt ? base64ToBytes(ai.raisedByDekCt) : null;
          const fuCt = ai.followUpOwnerCt ? base64ToBytes(ai.followUpOwnerCt) : null;
          const fuDekCt = ai.followUpOwnerDekCt ? base64ToBytes(ai.followUpOwnerDekCt) : null;

          // Emit the per-row chain anchor FIRST so the action_items
          // INSERT has a populated audit_idx. Mirrors the 1.6 native-
          // create path (action-items/index.ts:338).
          const chainRow = await append(tx, {
            actorId: auth.userId,
            payload: {
              kind: 'action_item.created',
              itemId: newActionItemId,
              itemType: ai.type,
              section: item.section as ActionItemSection,
              risk: ai.risk,
              // Additive close-out per ADR §3.9 + the shared-types
              // retrofit. Every chain row created by this commit
              // carries the batch id; the auditor can grep the chain
              // for `createdByImportId == <import>` and reconstruct
              // the per-import action_item list.
              createdByImportId: idParsed.data,
            },
            resourceType: 'action_items',
            resourceId: newActionItemId,
          });

          await tx.execute(sql`
            INSERT INTO action_items (
              id, sequence_number, type, type_subtype,
              description_ct, description_dek_ct,
              recommended_action_ct, recommended_action_dek_ct,
              raised_by_ct, raised_by_dek_ct,
              follow_up_owner_ct, follow_up_owner_dek_ct,
              department, status, risk, section,
              start_date, target_date, closed_date,
              source_type, source_id, tags
            )
            VALUES (
              ${newActionItemId}, ${sequenceNumber}, ${ai.type}, ${ai.typeSubtype ?? null},
              ${Buffer.from(descCt) as unknown as Uint8Array},
              ${Buffer.from(descDekCt) as unknown as Uint8Array},
              ${recCt ? (Buffer.from(recCt) as unknown as Uint8Array) : null},
              ${recDekCt ? (Buffer.from(recDekCt) as unknown as Uint8Array) : null},
              ${raisedCt ? (Buffer.from(raisedCt) as unknown as Uint8Array) : null},
              ${raisedDekCt ? (Buffer.from(raisedDekCt) as unknown as Uint8Array) : null},
              ${fuCt ? (Buffer.from(fuCt) as unknown as Uint8Array) : null},
              ${fuDekCt ? (Buffer.from(fuDekCt) as unknown as Uint8Array) : null},
              ${ai.department ?? null}, ${ai.status}, ${ai.risk}, ${item.section},
              ${ai.startDate}, ${ai.targetDate ?? null}, ${ai.closedDate ?? null},
              'excel_import', ${idParsed.data}, ${ai.tags as unknown as string[]}::text[]
            )
          `);

          // Bootstrap action_item_moves row (mirror 1.6 create path).
          await tx.execute(sql`
            INSERT INTO action_item_moves (
              action_item_id, moved_by_user_id, from_section, to_section, audit_idx
            )
            VALUES (
              ${newActionItemId}, ${auth.userId}, NULL, ${item.section}, ${chainRow.idx}
            )
          `);

          // Bind the import item to the new action_item + the audit row.
          await tx.execute(sql`
            UPDATE excel_import_items
            SET action_item_id = ${newActionItemId},
                audit_idx = ${chainRow.idx}
            WHERE id = ${item.id}
          `);
          createdCount++;
        } else if (itemStatus === 'updated') {
          if (!aiRow) {
            throw new ExcelImportWriteAborted({
              status: 422,
              body: { error: 'item_missing_action_item_row', itemId: item.id },
            });
          }
          const ai = aiRow as {
            actionItemId?: string;
            ifMatchVersion?: number;
            status: string;
            risk: ActionItemRisk;
            targetDate: string | null;
            closedDate: string | null;
            tags: ReadonlyArray<string>;
          };
          if (!ai.actionItemId || !ai.ifMatchVersion) {
            throw new ExcelImportWriteAborted({
              status: 422,
              body: { error: 'update_missing_action_item_id_or_etag', itemId: item.id },
            });
          }

          // SELECT FOR UPDATE + version check (the offline-prepared
          // preview captured the etag; defensive against the row drifting
          // between preview and commit).
          const ex = (await tx.execute(sql`
            SELECT id, version
            FROM action_items
            WHERE id = ${ai.actionItemId}
            FOR UPDATE
          `)) as unknown as Array<{ id: string; version: number }>;
          if (ex.length === 0) {
            throw new ExcelImportWriteAborted({
              status: 422,
              body: { error: 'update_target_not_found', actionItemId: ai.actionItemId },
            });
          }
          if (ex[0]!.version !== ai.ifMatchVersion) {
            throw new ExcelImportWriteAborted({
              status: 409,
              body: {
                error: 'version_conflict',
                actionItemId: ai.actionItemId,
                expectedVersion: ai.ifMatchVersion,
                currentVersion: ex[0]!.version,
              },
            });
          }
          const newVersion = ex[0]!.version + 1;
          await tx.execute(sql`
            UPDATE action_items
            SET status = ${ai.status},
                risk = ${ai.risk},
                target_date = ${ai.targetDate ?? null},
                closed_date = ${ai.closedDate ?? null},
                tags = ${ai.tags as unknown as string[]}::text[],
                version = ${newVersion}
            WHERE id = ${ai.actionItemId}
          `);

          const chainRow = await append(tx, {
            actorId: auth.userId,
            payload: {
              kind: 'action_item.updated',
              itemId: ai.actionItemId,
              changedFields: ['status', 'risk', 'target_date', 'closed_date', 'tags'],
              createdByImportId: idParsed.data,
            },
            resourceType: 'action_items',
            resourceId: ai.actionItemId,
          });
          await tx.execute(sql`
            UPDATE excel_import_items
            SET action_item_id = ${ai.actionItemId},
                audit_idx = ${chainRow.idx}
            WHERE id = ${item.id}
          `);
          updatedCount++;
        } else if (itemStatus === 'skipped') {
          // No-op on the action_items table. Provenance: if the rep
          // recorded an existingActionItemId in beforeState, bind it.
          const existingId = (payload as { existingActionItemId?: string }).existingActionItemId;
          if (existingId) {
            await tx.execute(sql`
              UPDATE excel_import_items
              SET action_item_id = ${existingId}
              WHERE id = ${item.id}
            `);
          }
          skippedCount++;
        }
      }

      // Stamp the import row + the batch-level chain anchor.
      //
      // step_up_jti: the 1.1 session JWT doesn't yet expose a jti on the
      // ValidatedAccess context; the column is reserved for the 1.12
      // action-bound-token ratchet (see ADR §3.10 — until 1.12 lands
      // action-bound tokens, the action label is cosmetic). Documented
      // residual: the column stays NULL on 1.11 commits + the runbook
      // (S5) surfaces the 1.12 ratchet that populates it.
      await tx.execute(sql`
        UPDATE excel_imports
        SET status = 'committed', committed_at = now(), step_up_jti = NULL
        WHERE id = ${idParsed.data}
      `);

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'excel_import.committed',
          importId: idParsed.data,
          createdCount,
          updatedCount,
          skippedCount,
          conflictResolvedCount,
        },
        resourceType: 'excel_imports',
        resourceId: idParsed.data,
      });

      return { createdCount, updatedCount, skippedCount, conflictResolvedCount };
    });

    return c.json({
      id: idParsed.data,
      status: 'committed' as ExcelImportStatus,
      ...result,
    });
  } catch (err) {
    if (err instanceof ExcelImportWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/excel-imports/:id/cancel — cancel a pending/preview import
// ---------------------------------------------------------------------------
//
// State guard: pending or preview. No chain anchor is emitted; per
// ADR §3.9 the upload anchor already bound the abandoned event, and
// the 1.11 chain-kind contract is the three kinds (uploaded /
// committed / reversed). A future `excel_import.cancelled` kind is a
// 1.12 follow-up — the runbook (S5) documents the residual.

excelImportsRoute.post('/:id/cancel', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = cancelBody.safeParse(await c.req.json().catch(() => ({})));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();
  try {
    const result = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id, status, imported_by_user_id
        FROM excel_imports
        WHERE id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string; imported_by_user_id: string }>;
      if (rows.length === 0) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = rows[0]!;
      if (row.imported_by_user_id !== auth.userId) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      if (row.status !== 'pending' && row.status !== 'preview') {
        throw new ExcelImportWriteAborted({
          status: 422,
          body: { error: 'invalid_state_transition', from: row.status, to: 'cancelled' },
        });
      }
      const upd = (await tx.execute(sql`
        UPDATE excel_imports
        SET status = 'cancelled', cancelled_at = now()
        WHERE id = ${idParsed.data}
        RETURNING cancelled_at::text AS cancelled_at
      `)) as unknown as Array<{ cancelled_at: string }>;
      return { cancelledAt: upd[0]!.cancelled_at };
    });
    return c.json({
      id: idParsed.data,
      status: 'cancelled' as ExcelImportStatus,
      cancelledAt: result.cancelledAt,
    });
  } catch (err) {
    if (err instanceof ExcelImportWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/excel-imports/:id/reverse — 30-day reverse
// ---------------------------------------------------------------------------

excelImportsRoute.post('/:id/reverse', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = reverseBody.safeParse(await c.req.json().catch(() => ({})));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');

  // (1) Step-up freshness (ADR §3.11).
  const challenge = checkStepUpFreshness(auth, {
    action: 'excel_import.reverse',
    maxAgeSeconds: 60,
  });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }

  // (2) Per-actor reverse rate limit (3/hour).
  const bucket = consumeBucket(
    reverseBuckets,
    REVERSE_CAPACITY,
    REVERSE_REFILL_PER_HOUR,
    auth.userId,
  );
  if (!bucket.ok) {
    c.header('Retry-After', String(bucket.retryAfterSeconds));
    return c.json({ error: 'rate_limited', retryAfterSeconds: bucket.retryAfterSeconds }, 429);
  }

  const db = getDb();
  try {
    const result = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id, status, imported_by_user_id, committed_at,
               (committed_at > now() - interval '30 days') AS within_window
        FROM excel_imports
        WHERE id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        status: string;
        imported_by_user_id: string;
        committed_at: Date | null;
        within_window: boolean;
      }>;
      if (rows.length === 0) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = rows[0]!;
      if (row.imported_by_user_id !== auth.userId) {
        throw new ExcelImportWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      if (row.status !== 'committed') {
        throw new ExcelImportWriteAborted({
          status: 422,
          body: { error: 'invalid_state_transition', from: row.status, to: 'reversed' },
        });
      }
      if (!row.within_window) {
        throw new ExcelImportWriteAborted({
          status: 410,
          body: { error: 'import_too_old_to_reverse', committedAt: row.committed_at },
        });
      }

      // Walk the items + reverse each per its status. The reverse path
      // is partial-success-capable per ADR §3.11: a created item whose
      // action_item has been edited since the import (version > 1)
      // refuses to delete and is recorded as 'refused'; an updated
      // item whose action_item has been edited since the import
      // (version > beforeState.ifMatchVersion + 1) also refuses.
      const itemRows = (await tx.execute(sql`
        SELECT id, status, action_item_id, before_state_json
        FROM excel_import_items
        WHERE import_id = ${idParsed.data}
        ORDER BY source_row_index ASC, id ASC
      `)) as unknown as Array<{
        id: string;
        status: string;
        action_item_id: string | null;
        before_state_json: Record<string, unknown> | null;
      }>;

      let deletedCount = 0;
      let revertedCount = 0;
      let refusedCount = 0;

      for (const item of itemRows) {
        if (item.status === 'skipped') continue;
        if (item.status === 'created') {
          if (!item.action_item_id) {
            refusedCount++;
            continue;
          }
          // Refuse if the action_item has been edited since the
          // import (version > 1). Soft-delete via status='Cancelled' +
          // section='archived' for chain-of-custody preservation —
          // the chain row's action_item_id reference stays valid (the
          // action_items.id row remains; only its status flips). ADR
          // §3.11 + ON DELETE SET NULL pairing.
          const ai = (await tx.execute(sql`
            SELECT version FROM action_items WHERE id = ${item.action_item_id} FOR UPDATE
          `)) as unknown as Array<{ version: number }>;
          if (ai.length === 0) {
            // Already gone — count as deleted (the reverse intent is met).
            deletedCount++;
            continue;
          }
          if (ai[0]!.version > 1) {
            refusedCount++;
            continue;
          }
          await tx.execute(sql`
            UPDATE action_items
            SET status = 'Cancelled', section = 'archived', version = version + 1
            WHERE id = ${item.action_item_id}
          `);
          deletedCount++;
        } else if (item.status === 'updated') {
          if (!item.action_item_id) {
            refusedCount++;
            continue;
          }
          const before = item.before_state_json as {
            actionItemRow?: {
              status?: string;
              risk?: ActionItemRisk;
              targetDate?: string | null;
              closedDate?: string | null;
              tags?: ReadonlyArray<string>;
              ifMatchVersion?: number;
            };
            priorStatus?: string;
            priorRisk?: ActionItemRisk;
            priorTargetDate?: string | null;
            priorClosedDate?: string | null;
            priorTags?: ReadonlyArray<string>;
          } | null;
          if (!before) {
            refusedCount++;
            continue;
          }
          // Refuse if subsequent edits happened beyond the import's
          // bump. We don't have the post-import version inline; we
          // approximate: the row should currently have version =
          // ifMatchVersion + 1 (the bump the commit applied). Anything
          // higher means the rep edited after import.
          const ai = (await tx.execute(sql`
            SELECT version, status, risk, target_date::text AS target_date,
                   closed_date::text AS closed_date, tags
            FROM action_items WHERE id = ${item.action_item_id} FOR UPDATE
          `)) as unknown as Array<{
            version: number;
            status: string;
            risk: string;
            target_date: string | null;
            closed_date: string | null;
            tags: string[];
          }>;
          if (ai.length === 0) {
            refusedCount++;
            continue;
          }
          const expectedVersion = (before.actionItemRow?.ifMatchVersion ?? 0) + 1;
          if (ai[0]!.version > expectedVersion) {
            refusedCount++;
            continue;
          }
          // Revert to prior fields stored in beforeState.
          const priorStatus = before.priorStatus ?? ai[0]!.status;
          const priorRisk = before.priorRisk ?? (ai[0]!.risk as ActionItemRisk);
          const priorTargetDate = before.priorTargetDate ?? null;
          const priorClosedDate = before.priorClosedDate ?? null;
          const priorTags = before.priorTags ?? [];
          await tx.execute(sql`
            UPDATE action_items
            SET status = ${priorStatus},
                risk = ${priorRisk},
                target_date = ${priorTargetDate},
                closed_date = ${priorClosedDate},
                tags = ${priorTags as unknown as string[]}::text[],
                version = version + 1
            WHERE id = ${item.action_item_id}
          `);
          revertedCount++;
        }
      }

      // Stamp the import row + the reverse chain anchor.
      const reversedAtRows = (await tx.execute(sql`
        UPDATE excel_imports
        SET status = 'reversed', reversed_at = now()
        WHERE id = ${idParsed.data}
        RETURNING reversed_at::text AS reversed_at
      `)) as unknown as Array<{ reversed_at: string }>;
      const reversedAt = reversedAtRows[0]!.reversed_at;

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'excel_import.reversed',
          importId: idParsed.data,
          reversedAt,
          deletedCount,
          revertedCount,
          refusedCount,
        },
        resourceType: 'excel_imports',
        resourceId: idParsed.data,
      });

      return { deletedCount, revertedCount, refusedCount, reversedAt };
    });
    return c.json({
      id: idParsed.data,
      status: 'reversed' as ExcelImportStatus,
      ...result,
    });
  } catch (err) {
    if (err instanceof ExcelImportWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 410 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/excel-imports — list metadata for the actor's imports
// ---------------------------------------------------------------------------

excelImportsRoute.get('/', async (c) => {
  const auth = c.get('auth');
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT
      ei.id,
      ei.status,
      encode(ei.source_sha256, 'hex') AS source_sha256_hex,
      ei.schema_version,
      ei.row_count,
      ei.created_at::text AS created_at,
      ei.previewed_at::text AS previewed_at,
      ei.committed_at::text AS committed_at,
      ei.cancelled_at::text AS cancelled_at,
      ei.reversed_at::text AS reversed_at,
      (SELECT COUNT(*) FROM excel_import_items WHERE import_id = ei.id AND status = 'created')::int AS created_count,
      (SELECT COUNT(*) FROM excel_import_items WHERE import_id = ei.id AND status = 'updated')::int AS updated_count,
      (SELECT COUNT(*) FROM excel_import_items WHERE import_id = ei.id AND status = 'skipped')::int AS skipped_count,
      (SELECT COUNT(*) FROM excel_import_items WHERE import_id = ei.id AND status = 'conflict_pending')::int AS conflict_pending_count
    FROM excel_imports ei
    WHERE ei.imported_by_user_id = ${auth.userId}
    ORDER BY ei.created_at DESC, ei.id DESC
    LIMIT 200
  `)) as unknown as Array<{
    id: string;
    status: string;
    source_sha256_hex: string;
    schema_version: string;
    row_count: number;
    created_at: string;
    previewed_at: string | null;
    committed_at: string | null;
    cancelled_at: string | null;
    reversed_at: string | null;
    created_count: number;
    updated_count: number;
    skipped_count: number;
    conflict_pending_count: number;
  }>;
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      status: r.status as ExcelImportStatus,
      sourceSha256: r.source_sha256_hex,
      schemaVersion: r.schema_version as ExcelImportSchemaVersion,
      rowCount: Number(r.row_count),
      createdAt: r.created_at,
      previewedAt: r.previewed_at,
      committedAt: r.committed_at,
      cancelledAt: r.cancelled_at,
      reversedAt: r.reversed_at,
      counts: {
        created: Number(r.created_count),
        updated: Number(r.updated_count),
        skipped: Number(r.skipped_count),
        conflictPending: Number(r.conflict_pending_count),
      },
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/excel-imports/:id — detail
// ---------------------------------------------------------------------------

excelImportsRoute.get('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const auth = c.get('auth');
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT
      id, status, imported_by_user_id,
      source_filename_ct, source_filename_dek_ct,
      encode(source_sha256, 'hex') AS source_sha256_hex,
      schema_version, row_count,
      created_at::text AS created_at,
      previewed_at::text AS previewed_at,
      committed_at::text AS committed_at,
      cancelled_at::text AS cancelled_at,
      reversed_at::text AS reversed_at,
      audit_idx
    FROM excel_imports
    WHERE id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    status: string;
    imported_by_user_id: string;
    source_filename_ct: Uint8Array;
    source_filename_dek_ct: Uint8Array;
    source_sha256_hex: string;
    schema_version: string;
    row_count: number;
    created_at: string;
    previewed_at: string | null;
    committed_at: string | null;
    cancelled_at: string | null;
    reversed_at: string | null;
    audit_idx: number | string;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;
  if (r.imported_by_user_id !== auth.userId) {
    return c.json({ error: 'not_found' }, 404);
  }
  const sourceFilename = openExcelImportField({
    ct: r.source_filename_ct,
    dekCt: r.source_filename_dek_ct,
  });
  return c.json({
    id: r.id,
    status: r.status as ExcelImportStatus,
    sourceFilename,
    sourceSha256: r.source_sha256_hex,
    schemaVersion: r.schema_version as ExcelImportSchemaVersion,
    rowCount: Number(r.row_count),
    createdAt: r.created_at,
    previewedAt: r.previewed_at,
    committedAt: r.committed_at,
    cancelledAt: r.cancelled_at,
    reversedAt: r.reversed_at,
    auditIdx: Number(r.audit_idx),
  });
});

// ---------------------------------------------------------------------------
// GET /api/excel-imports/:id/items — paginated per-row items
// ---------------------------------------------------------------------------

const itemsListQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.min(500, Math.max(1, Number.parseInt(v, 10) || 100)) : 100)),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(0, Number.parseInt(v, 10) || 0) : 0)),
});

excelImportsRoute.get('/:id/items', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const queryParsed = itemsListQuery.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  if (!queryParsed.success) {
    return c.json({ error: 'invalid_query', issues: queryParsed.error.flatten() }, 400);
  }
  const { limit, offset } = queryParsed.data;
  const auth = c.get('auth');
  const db = getDb();

  // Boundary check — the import must be the actor's. Single SELECT
  // walks the join so cross-actor reads return 404.
  const guard = (await db.execute(sql`
    SELECT 1 FROM excel_imports
    WHERE id = ${idParsed.data} AND imported_by_user_id = ${auth.userId}
    LIMIT 1
  `)) as unknown as Array<unknown>;
  if (guard.length === 0) return c.json({ error: 'not_found' }, 404);

  const rows = (await db.execute(sql`
    SELECT
      id, source_row_index, section,
      encode(content_hash, 'hex') AS content_hash_hex,
      status, action_item_id, audit_idx,
      created_at::text AS created_at
    FROM excel_import_items
    WHERE import_id = ${idParsed.data}
    ORDER BY source_row_index ASC, id ASC
    LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as Array<{
    id: string;
    source_row_index: number;
    section: string;
    content_hash_hex: string;
    status: string;
    action_item_id: string | null;
    audit_idx: number | string | null;
    created_at: string;
  }>;
  const totalRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM excel_import_items WHERE import_id = ${idParsed.data}
  `)) as unknown as Array<{ n: number }>;
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      sourceRowIndex: r.source_row_index,
      section: r.section as ActionItemSection,
      contentHash: r.content_hash_hex,
      status: r.status as ExcelImportItemStatus,
      actionItemId: r.action_item_id,
      auditIdx: r.audit_idx !== null ? Number(r.audit_idx) : null,
      createdAt: r.created_at,
    })),
    total: Number(totalRows[0]?.n ?? 0),
    limit,
    offset,
  });
});

// Re-export the helper for tests + future callers.
export { bytesToHex };
