// /api/inspections/* + /api/inspection-templates/* — Milestone 1.8 S2.
//
// Routes (ADR-0007 §3.11):
//
//   GET    /api/inspection-templates           — active versions list
//   GET    /api/inspection-templates/:id       — template detail w/ sections
//   POST   /api/inspection-templates           — create CUSTOM template only
//                                                (seeded codes are read-only;
//                                                see ADR-0007 §3.4 / T-I8)
//
//   GET    /api/inspections                    — list with filters
//   GET    /api/inspections/:id                — detail (findings + sigs)
//   POST   /api/inspections                    — create from active template
//                                                version; pins template
//                                                _version_id (non-negotiable
//                                                #13). Emits inspection.created.
//   PATCH  /api/inspections/:id                — state transitions
//                                                scheduled -> in_progress
//                                                in_progress -> awaiting_signatures
//                                                complete -> archived
//
//   POST   /api/inspections/:id/findings       — create finding; envelope-
//                                                encrypts observation /
//                                                corrective_action /
//                                                responsible_party. Emits
//                                                inspection_finding.created.
//   PATCH  /api/inspections/findings/:id       — update finding (in_progress
//                                                state only; immutable post
//                                                awaiting_signatures). No
//                                                chain anchor in 1.8 — bounded
//                                                by the create anchor.
//   GET    /api/inspections/findings/:id       — detail w/ decrypted PI;
//                                                step-up gated (60s).
//   POST   /api/inspections/findings/:id/promote
//                                              — manual promote to action_items.
//                                                THE #15 fail-closed gate:
//                                                inspectionPromotability() blocks
//                                                X/G. UNIQUE FK + advisory lock
//                                                block double-promotion (T-I16).
//                                                Emits inspection_finding.promoted.
//
//   POST   /api/inspections/:id/signatures     — sign as a role. Per-role
//                                                UNIQUE in schema. Three-sig
//                                                completion logic for rack.
//                                                Emits inspection.signed.
//
// Middleware order mirrors evidence: authMiddleware -> rateLimit ->
// bodyLimit. 256KB body cap (vs evidence's 64KB) because a finding with
// observation + corrective-action + responsible_party text can
// legitimately push past 64KB once we add markdown-free description
// fields in the 8KB/each range, and S3 will introduce batch finding
// patches.
//
// SINGLE-TENANT SIMPLIFICATION (ADR-0007 §3.8): signature-role
// authorization is "any authenticated rep can sign as any of inspector
// / supervisor / jhsc_worker_co_chair." The role label tracks WHO they
// sign AS, not a separate workplace_roles enforcement. A workplace-
// roles table lands in a future release; documented in the runbook.

import { sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { append } from '@jhsc/audit';
import {
  actionItemRisk,
  inspectionConductState,
  inspectionFindingStatusAbcx,
  inspectionFindingStatusGar,
  inspectionPromotability,
  inspectionSignatureRole,
  inspectionStatusVocabKind,
  inspectionTemplateCode,
  type ActionItemRisk,
  type InspectionConductState,
  type InspectionSignatureRole,
  type InspectionStatusVocabKind,
  type InspectionTemplateCode,
} from '@jhsc/shared-types';
import { getDb } from '../../db/client';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { idempotencyKey } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rate-limit';
import { openOptionalField, sealField, sealOptionalField } from '../../inspections/crypto';
import { sealField as sealActionItemField } from '../../action-items/crypto';
import { noHtmlBounded } from '../../lib/string-validators';
import { allocateSequenceNumber } from '../action-items';
import { inspectionsExportsRoute } from './exports';

export { inspectionsExportsRoute } from './exports';

export const inspectionsRoute = new Hono();
// Mount the exports sub-route under /api/inspections/exports. S4 (PDF
// export) shares the inspections route group's auth + rate-limit
// middleware via authMiddleware re-applied inside exports.ts. Keeping
// the exports surface in its own file because the render-decrypt-anchor
// pipeline is substantial enough to warrant the separation; the create
// flow alone is ~250 lines.
inspectionsRoute.route('/exports', inspectionsExportsRoute);

inspectionsRoute.use('*', authMiddleware());
// 1.10 (ADR-0009 §3.4): idempotencyKey AFTER auth, BEFORE rate-limit.
inspectionsRoute.use('*', idempotencyKey());
// Same ordering rationale as evidence + action-items: rateLimit BEFORE
// bodyLimit so spammed oversize POSTs still drain the bucket.
inspectionsRoute.use('*', rateLimit({ name: 'inspections', capacity: 60, refillPerSecond: 10 }));
// 256KB body cap — larger than the 64KB used by evidence + action-items
// because (a) a single finding can carry observation + corrective_action
// + responsible_party in the kilobyte range each, and (b) custom-
// template POSTs ship a sections array with up to 30 sections * 30
// items * ~250 char fields. Bounded enough that one malicious POST
// can't pin memory; large enough that legitimate authoring works.
inspectionsRoute.use(
  '*',
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

// Zone ID Zod schema — refined against config/workplace.ts's ZoneId
// union per ADR-0007 §3.3 / T-I7. Centralized here (every inspections
// route imports this) so a future route can't forget to validate.
const ZONE_IDS = [
  'zone_1',
  'zone_2',
  'zone_3',
  'zone_4',
  'zone_5',
  'zone_6',
  'zone_7',
  'zone_8',
  'zone_9',
  'zone_10',
] as const;
const zoneIdSchema = z.enum(ZONE_IDS);

const uuidParam = z.string().uuid();

// Custom template authoring: structural-only Zod schema. NO HTML, NO
// markdown. The route REJECTS any string field containing '<' or '>' so
// even a future renderer that mishandles escaping cannot land XSS
// content via the template surface (T-I11). Max sizes from ADR-0007 §3.5.
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
// `noHtmlBounded` lives in `apps/api/src/lib/string-validators.ts` so
// the recommendations route can share the same refinement (priv-F14
// close-out from the 1.9 S5 review). The helper also strips C0/C1
// control characters + BiDi overrides — defenses we always wanted on
// the inspections route's free-text surfaces and now apply uniformly.

const templateItemSchema = z
  .object({
    key: z
      .string()
      .regex(KEY_PATTERN, 'key must be snake_case, 1-64 chars, starting with a letter'),
    label: noHtmlBounded({ min: 1, max: 240 }),
    helpText: noHtmlBounded({ max: 480 }).optional(),
  })
  .strict();

const templateSectionSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN, 'section key must be snake_case'),
    label: noHtmlBounded({ min: 1, max: 240 }),
    items: z.array(templateItemSchema).min(1).max(30),
  })
  .strict();

const createTemplateBody = z
  .object({
    // 1.10 (ADR-0009 §3.3): optional client-generated UUID v4.
    clientId: z.string().uuid().optional(),
    // Custom-only at the route layer (ADR-0007 §3.4 + the seeded codes
    // are append-only via the seeder). Schema accepts the full enum so
    // a future workflow can ratchet here; the route rejects non-custom.
    templateCode: z.enum(inspectionTemplateCode),
    displayName: noHtmlBounded({ min: 1, max: 120 }),
    statusVocab: z.enum(inspectionStatusVocabKind),
    cadence: z.enum(['monthly', 'quarterly', 'annual', 'ad_hoc']),
    requiresThreeSignatures: z.boolean().default(false),
    sections: z.array(templateSectionSchema).min(1).max(30),
  })
  .strict();

const createInspectionBody = z
  .object({
    // 1.10 (ADR-0009 §3.3): optional client-generated UUID v4.
    clientId: z.string().uuid().optional(),
    templateVersionId: z.string().uuid(),
    zoneId: zoneIdSchema,
    scheduledFor: z.string().datetime().optional(),
  })
  .strict();

const inspectionListQuery = z.object({
  state: z.enum(inspectionConductState).optional(),
  zoneId: zoneIdSchema.optional(),
  templateCode: z.enum(inspectionTemplateCode).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const patchInspectionBody = z
  .object({
    state: z.enum(inspectionConductState),
  })
  .strict();

// statusValue is validated against the template's status_vocab at the
// route layer (not in Zod) since the per-row vocab is dynamic. The
// schema's check just bounds the alphabet.
const findingStatusValueRaw = z.string().regex(/^[A-Z]$/);

// 1.9 priv-F8 close-out (ADR-0008 §3.12): responsibleParty becomes a
// discriminatedUnion('kind', ['user_ref', 'name_text']). 'user_ref'
// surfaces an internal owner by user id (no encryption, no PI in the
// name field — the rep is in users); 'name_text' captures an external
// party whose name is envelope-encrypted (the 1.8 path). The migration
// 0008 CHECK enforces kind / _user_id / _ct alignment at the DB
// layer; this Zod schema enforces it at the route. Pre-1.9 rows with
// kind=NULL stay valid because the column is nullable.
const responsiblePartySchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('user_ref'), userId: z.string().uuid() }).strict(),
    z
      .object({ kind: z.literal('name_text'), nameText: noHtmlBounded({ min: 1, max: 200 }) })
      .strict(),
  ])
  .optional();

const createFindingBody = z
  .object({
    // 1.10 (ADR-0009 §3.3): optional client-generated UUID v4.
    clientId: z.string().uuid().optional(),
    sectionKey: z.string().regex(KEY_PATTERN),
    itemKey: z.string().regex(KEY_PATTERN),
    statusVocab: z.enum(inspectionStatusVocabKind),
    statusValue: findingStatusValueRaw,
    observation: noHtmlBounded({ max: 8000 }).optional(),
    correctiveAction: noHtmlBounded({ max: 8000 }).optional(),
    responsibleParty: responsiblePartySchema,
  })
  .strict();

// PATCH finding — in_progress only (chain-of-custody discipline). We
// also restrict the editable surface to:
//   - statusValue within the same vocab
//   - observation / correctiveAction (add, change, or clear via null)
//   - responsibleParty (the discriminated union; null to clear)
// Other fields are immutable for the lifetime of the finding row.
const patchFindingBody = z
  .object({
    statusValue: findingStatusValueRaw.optional(),
    observation: noHtmlBounded({ max: 8000 }).nullable().optional(),
    correctiveAction: noHtmlBounded({ max: 8000 }).nullable().optional(),
    // For PATCH, the dual-shape accepts a discriminated union to set
    // (matching create) OR null to clear back to "no responsible party"
    // (kind=NULL on the row). An optional/undefined value leaves the
    // existing row unchanged.
    responsibleParty: z
      .union([
        z.object({ kind: z.literal('user_ref'), userId: z.string().uuid() }).strict(),
        z
          .object({ kind: z.literal('name_text'), nameText: noHtmlBounded({ min: 1, max: 200 }) })
          .strict(),
        z.null(),
      ])
      .optional(),
  })
  .strict();

const promoteFindingBody = z
  .object({
    // 1.10 (ADR-0009 §3.3): optional client-generated UUID v4. Used as
    // the canonical action_items.id created by this promotion. The
    // finding's id is the URL param; clientId here is the NEW action
    // item the promote creates.
    clientId: z.string().uuid().optional(),
    risk: z.enum(actionItemRisk),
  })
  .strict();

const signBody = z
  .object({
    // 1.10 (ADR-0009 §3.3): optional client-generated UUID v4.
    clientId: z.string().uuid().optional(),
    role: z.enum(inspectionSignatureRole),
    note: noHtmlBounded({ max: 2000 }).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Sentinel for transaction rollback paths (same shape as hazards /
// action-items routes).
// ---------------------------------------------------------------------------

class InspectionWriteAborted extends Error {
  readonly payload: { status: number; body: Record<string, unknown> };
  constructor(payload: { status: number; body: Record<string, unknown> }) {
    super(`inspection_write_aborted: ${payload.status}`);
    this.name = 'InspectionWriteAborted';
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Helper: in-vocab validation. Mirror the Zod refinement but runs at
 * the route layer because the vocab is per-template. */
function statusValueInVocab(vocab: InspectionStatusVocabKind, value: string): boolean {
  if (vocab === 'ABC_X')
    return (inspectionFindingStatusAbcx as ReadonlyArray<string>).includes(value);
  if (vocab === 'GAR') return (inspectionFindingStatusGar as ReadonlyArray<string>).includes(value);
  return false;
}

interface TemplateSectionShape {
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<{ key: string; label: string; helpText?: string }>;
}

function findSection(
  sections: ReadonlyArray<TemplateSectionShape>,
  sectionKey: string,
): TemplateSectionShape | null {
  return sections.find((s) => s.key === sectionKey) ?? null;
}

function findItem(
  section: TemplateSectionShape,
  itemKey: string,
): { key: string; label: string; helpText?: string } | null {
  return section.items.find((i) => i.key === itemKey) ?? null;
}

// ---------------------------------------------------------------------------
// Inspection templates — separate Hono sub-app, mounted at the parent
// /api/inspection-templates path. Keeping them in this same file because
// they're tiny and share the same middleware stack.
// ---------------------------------------------------------------------------

export const inspectionTemplatesRoute = new Hono();
inspectionTemplatesRoute.use('*', authMiddleware());
// 1.10 (ADR-0009 §3.4): idempotencyKey AFTER auth, BEFORE rate-limit.
inspectionTemplatesRoute.use('*', idempotencyKey());
inspectionTemplatesRoute.use(
  '*',
  rateLimit({ name: 'inspection-templates', capacity: 60, refillPerSecond: 10 }),
);
inspectionTemplatesRoute.use(
  '*',
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// GET /api/inspection-templates — active versions of every template_code.
inspectionTemplatesRoute.get('/', async (c) => {
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, template_code, version_number, display_name, status_vocab,
           requires_three_signatures, cadence
    FROM inspection_templates
    WHERE retired_at IS NULL
    ORDER BY template_code ASC, version_number DESC
  `)) as unknown as Array<{
    id: string;
    template_code: string;
    version_number: number;
    display_name: string;
    status_vocab: string;
    requires_three_signatures: boolean;
    cadence: string;
  }>;
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      templateCode: r.template_code as InspectionTemplateCode,
      versionNumber: r.version_number,
      displayName: r.display_name,
      statusVocab: r.status_vocab as InspectionStatusVocabKind,
      requiresThreeSignatures: r.requires_three_signatures,
      cadence: r.cadence,
    })),
  });
});

// GET /api/inspection-templates/:id — detail with full `sections`.
inspectionTemplatesRoute.get('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, template_code, version_number, display_name, status_vocab,
           requires_three_signatures, cadence, sections,
           created_at::text AS created_at,
           retired_at::text AS retired_at
    FROM inspection_templates
    WHERE id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    template_code: string;
    version_number: number;
    display_name: string;
    status_vocab: string;
    requires_three_signatures: boolean;
    cadence: string;
    sections: unknown;
    created_at: string;
    retired_at: string | null;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;
  return c.json({
    id: r.id,
    templateCode: r.template_code as InspectionTemplateCode,
    versionNumber: r.version_number,
    displayName: r.display_name,
    statusVocab: r.status_vocab as InspectionStatusVocabKind,
    requiresThreeSignatures: r.requires_three_signatures,
    cadence: r.cadence,
    sections: r.sections,
    createdAt: r.created_at,
    retiredAt: r.retired_at,
  });
});

// POST /api/inspection-templates — create a NEW custom template OR a new
// version of an existing custom code. Seeded codes (zone_monthly /
// rack_inspection) are read-only; the route rejects template_code !==
// 'custom'. (Custom-template chain anchors are a 1.9 follow-up — see
// runbook; the seeded chain anchor pattern is documented in S1.)
inspectionTemplatesRoute.post('/', async (c) => {
  const parsed = createTemplateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  if (body.templateCode !== 'custom') {
    return c.json({ error: 'seeded_template_immutable', templateCode: body.templateCode }, 422);
  }
  const auth = c.get('auth');
  const db = getDb();

  // 1.10 (ADR-0009 §3.3): ratchet-level idempotency. created_by_user_id
  // is the actor scope. NB inspection_templates is append-only — a
  // clientId reuse + same actor returns the existing version row at
  // 200; cross-actor returns 409.
  if (body.clientId) {
    const existing = (await db.execute(sql`
      SELECT id, template_code, version_number, created_by_user_id
      FROM inspection_templates
      WHERE id = ${body.clientId}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      template_code: string;
      version_number: number;
      created_by_user_id: string | null;
    }>;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.created_by_user_id !== auth.userId) {
        return c.json({ error: 'client_id_conflict' }, 409);
      }
      return c.json(
        {
          id: row.id,
          templateCode: row.template_code as InspectionTemplateCode,
          versionNumber: row.version_number,
        },
        200,
      );
    }
  }

  const created = await db.transaction(async (tx) => {
    // Allocate the next version_number for `custom`. The partial UNIQUE
    // INDEX `inspection_templates_active_version` on (template_code)
    // WHERE retired_at IS NULL keeps "at most one active version per
    // code" — so if a custom v1 is already active, we either bump the
    // existing version OR the caller must retire v1 first. For S2 we
    // allow MAX+1: the new row IS the active one and the old row is
    // implicitly superseded by the partial unique constraint... actually
    // the partial unique would CONFLICT if both rows have retired_at IS
    // NULL. Mark the prior active row's retired_at to now() inside the
    // same transaction so the bump is append-only at the row level
    // (ADR-0007 §3.1) and the active-version index is satisfied.
    const existingActive = (await tx.execute(sql`
      SELECT id, version_number FROM inspection_templates
      WHERE template_code = ${body.templateCode} AND retired_at IS NULL
      FOR UPDATE
    `)) as unknown as Array<{ id: string; version_number: number }>;
    const nextVersion = existingActive[0] ? existingActive[0].version_number + 1 : 1;
    if (existingActive[0]) {
      await tx.execute(
        sql`UPDATE inspection_templates SET retired_at = now() WHERE id = ${existingActive[0].id}`,
      );
    }
    const sectionsJson = JSON.stringify(body.sections);
    // 1.10 §3.3: use clientId when present as the canonical row id.
    const rows = body.clientId
      ? ((await tx.execute(sql`
          INSERT INTO inspection_templates (
            id, template_code, version_number, status_vocab, display_name,
            cadence, sections, requires_three_signatures, created_by_user_id
          )
          VALUES (
            ${body.clientId}, ${body.templateCode}, ${nextVersion}, ${body.statusVocab},
            ${body.displayName}, ${body.cadence},
            ${sectionsJson}::jsonb,
            ${body.requiresThreeSignatures}, ${auth.userId}
          )
          RETURNING id
        `)) as unknown as Array<{ id: string }>)
      : ((await tx.execute(sql`
          INSERT INTO inspection_templates (
            template_code, version_number, status_vocab, display_name,
            cadence, sections, requires_three_signatures, created_by_user_id
          )
          VALUES (
            ${body.templateCode}, ${nextVersion}, ${body.statusVocab},
            ${body.displayName}, ${body.cadence},
            ${sectionsJson}::jsonb,
            ${body.requiresThreeSignatures}, ${auth.userId}
          )
          RETURNING id
        `)) as unknown as Array<{ id: string }>);
    return { id: rows[0]!.id, versionNumber: nextVersion };
  });
  return c.json({
    id: created.id,
    templateCode: body.templateCode,
    versionNumber: created.versionNumber,
  });
});

// ---------------------------------------------------------------------------
// POST /api/inspections — create from an active template_version (#13).
// ---------------------------------------------------------------------------

inspectionsRoute.post('/', async (c) => {
  const parsed = createInspectionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const db = getDb();

  // 1.10 (ADR-0009 §3.3): ratchet-level idempotency. The
  // conducted_by_user_id column anchors the actor — a rep replaying
  // their own clientId returns the existing row at 200; cross-actor
  // returns 409.
  if (body.clientId) {
    const existing = (await db.execute(sql`
      SELECT i.id, i.state, i.scheduled_for::text AS scheduled_for,
             i.conducted_by_user_id, t.template_code, i.template_version_id, i.zone_id
      FROM inspections i
      JOIN inspection_templates t ON t.id = i.template_version_id
      WHERE i.id = ${body.clientId}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      state: string;
      scheduled_for: string | null;
      conducted_by_user_id: string;
      template_code: string;
      template_version_id: string;
      zone_id: string;
    }>;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.conducted_by_user_id !== auth.userId) {
        return c.json({ error: 'client_id_conflict' }, 409);
      }
      return c.json(
        {
          id: row.id,
          templateCode: row.template_code as InspectionTemplateCode,
          templateVersionId: row.template_version_id,
          zoneId: row.zone_id,
          state: row.state as InspectionConductState,
          scheduledFor: row.scheduled_for,
        },
        200,
      );
    }
  }

  // Verify the template version exists AND is not retired. Once
  // retired, NEW inspections can't bind to it; existing inspections
  // that already pinned it remain valid (ADR-0007 §3.1).
  const template = (await db.execute(sql`
    SELECT id, template_code FROM inspection_templates
    WHERE id = ${body.templateVersionId} AND retired_at IS NULL
    LIMIT 1
  `)) as unknown as Array<{ id: string; template_code: string }>;
  if (template.length === 0) {
    return c.json({ error: 'template_version_not_active' }, 422);
  }
  const templateCode = template[0]!.template_code as InspectionTemplateCode;

  try {
    const created = await db.transaction(async (tx) => {
      // sec/priv-F1-style anchor-first ordering: chain row first so the
      // inspections.audit_idx FK has a real target. Mirror hazards
      // create path; inspection.created is emitted with stable
      // identifiers only (no PI). 1.10 §3.3: use clientId when present.
      const inspectionId = body.clientId ?? crypto.randomUUID();
      const chainRow = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'inspection.created',
          inspectionId,
          templateCode,
          templateVersionId: body.templateVersionId,
          conductedByUserId: auth.userId,
          zoneId: body.zoneId,
          scheduledFor: body.scheduledFor ?? null,
        },
        resourceType: 'inspections',
        resourceId: inspectionId,
      });
      await tx.execute(sql`
        INSERT INTO inspections (
          id, template_version_id, zone_id, conducted_by_user_id,
          state, scheduled_for, audit_idx
        )
        VALUES (
          ${inspectionId}, ${body.templateVersionId}, ${body.zoneId}, ${auth.userId},
          'scheduled', ${body.scheduledFor ?? null}, ${chainRow.idx}
        )
      `);
      return { id: inspectionId };
    });
    return c.json({
      id: created.id,
      templateCode,
      templateVersionId: body.templateVersionId,
      zoneId: body.zoneId,
      state: 'scheduled' as InspectionConductState,
      scheduledFor: body.scheduledFor ?? null,
    });
  } catch (err) {
    if (err instanceof InspectionWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections — list w/ filters.
// ---------------------------------------------------------------------------

inspectionsRoute.get('/', async (c) => {
  const parsed = inspectionListQuery.safeParse({
    state: c.req.query('state'),
    zoneId: c.req.query('zoneId'),
    templateCode: c.req.query('templateCode'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const { state, zoneId, templateCode, from, to } = parsed.data;
  const db = getDb();
  // No envelope crypto on the list path; row metadata is non-PI per
  // ADR-0007. No evidence.list_accessed-style anchor either — the
  // metadata here is non-sensitive (zone id, state, scheduled-for,
  // conducted-by uuid). Findings carry the PI surface; this endpoint
  // doesn't return them.
  const rows = (await db.execute(sql`
    SELECT i.id, i.template_version_id, t.template_code,
           i.zone_id, i.state,
           i.scheduled_for::text AS scheduled_for,
           i.started_at::text AS started_at,
           i.completed_at::text AS completed_at,
           i.conducted_by_user_id,
           i.created_at::text AS created_at
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_version_id
    WHERE 1=1
      ${state ? sql`AND i.state = ${state}` : sql``}
      ${zoneId ? sql`AND i.zone_id = ${zoneId}` : sql``}
      ${templateCode ? sql`AND t.template_code = ${templateCode}` : sql``}
      ${from ? sql`AND i.scheduled_for >= ${from}::timestamptz` : sql``}
      ${to ? sql`AND i.scheduled_for <= ${to}::timestamptz` : sql``}
    ORDER BY COALESCE(i.scheduled_for, i.created_at) DESC, i.id DESC
    LIMIT 200
  `)) as unknown as Array<{
    id: string;
    template_version_id: string;
    template_code: string;
    zone_id: string;
    state: string;
    scheduled_for: string | null;
    started_at: string | null;
    completed_at: string | null;
    conducted_by_user_id: string;
    created_at: string;
  }>;
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      templateCode: r.template_code as InspectionTemplateCode,
      templateVersionId: r.template_version_id,
      zoneId: r.zone_id,
      state: r.state as InspectionConductState,
      scheduledFor: r.scheduled_for,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      conductedByUserId: r.conducted_by_user_id,
      createdAt: r.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/inspections/:id — detail.
// ---------------------------------------------------------------------------

inspectionsRoute.get('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const db = getDb();

  const rows = (await db.execute(sql`
    SELECT i.id, i.template_version_id, t.template_code, t.display_name,
           t.status_vocab, t.cadence, t.requires_three_signatures, t.sections,
           i.zone_id, i.state, i.conducted_by_user_id,
           i.scheduled_for::text AS scheduled_for,
           i.started_at::text AS started_at,
           i.completed_at::text AS completed_at,
           i.created_at::text AS created_at
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_version_id
    WHERE i.id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    template_version_id: string;
    template_code: string;
    display_name: string;
    status_vocab: string;
    cadence: string;
    requires_three_signatures: boolean;
    sections: unknown;
    zone_id: string;
    state: string;
    conducted_by_user_id: string;
    scheduled_for: string | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;

  // Findings — metadata + has_* flags, NEVER decrypted observation/
  // corrective-action/responsible-party. Step-up gated detail endpoint
  // is the only way to read those (mirror of T-I12 / T-H4 from 1.5).
  const findingRows = (await db.execute(sql`
    SELECT id, section_key, section_label, item_key, item_label,
           status_vocab, status_value,
           (observation_ct IS NOT NULL) AS has_observation,
           (corrective_action_ct IS NOT NULL) AS has_corrective_action,
           (responsible_party_ct IS NOT NULL) AS has_responsible_party,
           promoted_action_item_id,
           created_at::text AS created_at
    FROM inspection_findings
    WHERE inspection_id = ${idParsed.data}
    ORDER BY created_at ASC
  `)) as unknown as Array<{
    id: string;
    section_key: string;
    section_label: string;
    item_key: string;
    item_label: string;
    status_vocab: string;
    status_value: string;
    has_observation: boolean;
    has_corrective_action: boolean;
    has_responsible_party: boolean;
    promoted_action_item_id: string | null;
    created_at: string;
  }>;

  // Signatures — metadata + has_note flag (T-I22 mirror of T-I12).
  const signatureRows = (await db.execute(sql`
    SELECT id, role, signed_by_user_id, signed_at::text AS signed_at,
           (note_ct IS NOT NULL) AS has_note
    FROM inspection_signatures
    WHERE inspection_id = ${idParsed.data}
    ORDER BY signed_at ASC
  `)) as unknown as Array<{
    id: string;
    role: string;
    signed_by_user_id: string;
    signed_at: string;
    has_note: boolean;
  }>;

  return c.json({
    id: r.id,
    templateCode: r.template_code as InspectionTemplateCode,
    templateVersionId: r.template_version_id,
    templateDisplayName: r.display_name,
    statusVocab: r.status_vocab as InspectionStatusVocabKind,
    cadence: r.cadence,
    requiresThreeSignatures: r.requires_three_signatures,
    sections: r.sections,
    zoneId: r.zone_id,
    state: r.state as InspectionConductState,
    conductedByUserId: r.conducted_by_user_id,
    scheduledFor: r.scheduled_for,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    findings: findingRows.map((f) => ({
      id: f.id,
      sectionKey: f.section_key,
      sectionLabel: f.section_label,
      itemKey: f.item_key,
      itemLabel: f.item_label,
      statusVocab: f.status_vocab as InspectionStatusVocabKind,
      statusValue: f.status_value,
      hasObservation: f.has_observation,
      hasCorrectiveAction: f.has_corrective_action,
      hasResponsibleParty: f.has_responsible_party,
      promotedActionItemId: f.promoted_action_item_id,
      createdAt: f.created_at,
    })),
    signatures: signatureRows.map((s) => ({
      id: s.id,
      role: s.role as InspectionSignatureRole,
      signedByUserId: s.signed_by_user_id,
      signedAt: s.signed_at,
      hasNote: s.has_note,
    })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/inspections/:id — state transitions.
//
// Allowed in 1.8:
//   scheduled            -> in_progress           (sets started_at)
//   in_progress          -> awaiting_signatures   (requires >=1 finding)
//   complete             -> archived              (no clock)
//
// Other transitions return 422. NO new audit kind for state changes
// (the six kinds from S1 are the contract); the lifecycle is bounded by
// inspection.created + inspection_finding.created + inspection.signed.
// The runbook documents this.
// ---------------------------------------------------------------------------

interface AllowedTransition {
  readonly from: InspectionConductState;
  readonly to: InspectionConductState;
  readonly setStartedAt?: boolean;
  readonly requireFinding?: boolean;
}

const STATE_TRANSITIONS: ReadonlyArray<AllowedTransition> = [
  { from: 'scheduled', to: 'in_progress', setStartedAt: true },
  { from: 'in_progress', to: 'awaiting_signatures', requireFinding: true },
  { from: 'complete', to: 'archived' },
];

inspectionsRoute.patch('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = patchInspectionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const targetState = parsed.data.state;
  const db = getDb();
  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, state FROM inspections WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; state: string }>;
      if (locked.length === 0) {
        throw new InspectionWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const from = locked[0]!.state as InspectionConductState;
      const rule = STATE_TRANSITIONS.find((t) => t.from === from && t.to === targetState);
      if (!rule) {
        throw new InspectionWriteAborted({
          status: 422,
          body: {
            error: 'illegal_state_transition',
            from,
            to: targetState,
          },
        });
      }
      if (rule.requireFinding) {
        const findings = (await tx.execute(sql`
          SELECT 1 FROM inspection_findings WHERE inspection_id = ${idParsed.data} LIMIT 1
        `)) as unknown as Array<unknown>;
        if (findings.length === 0) {
          throw new InspectionWriteAborted({
            status: 422,
            body: { error: 'no_findings_to_advance' },
          });
        }
      }
      if (rule.setStartedAt) {
        await tx.execute(
          sql`UPDATE inspections SET state = ${targetState}, started_at = now() WHERE id = ${idParsed.data}`,
        );
      } else {
        await tx.execute(
          sql`UPDATE inspections SET state = ${targetState} WHERE id = ${idParsed.data}`,
        );
      }
      return { id: idParsed.data, state: targetState };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof InspectionWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/findings — create a finding.
// ---------------------------------------------------------------------------

inspectionsRoute.post('/:id/findings', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = createFindingBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const db = getDb();

  // Verify inspection + load the pinned template's sections snapshot.
  const ctx = (await db.execute(sql`
    SELECT i.id, i.state, t.status_vocab, t.sections
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_version_id
    WHERE i.id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    state: string;
    status_vocab: string;
    sections: unknown;
  }>;
  if (ctx.length === 0) return c.json({ error: 'not_found' }, 404);
  const { state, status_vocab: templateVocab, sections } = ctx[0]!;
  // sec-F7 / T-I41 close-out: drop 'awaiting_signatures' from the
  // allow-list. Once an inspection advances to awaiting_signatures
  // (the inspector has signed a rack inspection), no new findings can
  // be added — preserving the chain-of-custody "the inspector
  // documented findings while walking; signatures attest to the
  // findings as seen." This is asymmetric with the prior shape (POST
  // accepted awaiting_signatures, PATCH did not); the symmetry now is
  // that all finding authoring must precede the first signature.
  if (state !== 'scheduled' && state !== 'in_progress') {
    return c.json({ error: 'inspection_not_open_for_findings', state }, 422);
  }
  if (body.statusVocab !== templateVocab) {
    return c.json(
      { error: 'status_vocab_mismatch', expected: templateVocab, got: body.statusVocab },
      422,
    );
  }
  if (!statusValueInVocab(body.statusVocab, body.statusValue)) {
    return c.json(
      { error: 'status_value_out_of_vocab', vocab: body.statusVocab, value: body.statusValue },
      422,
    );
  }
  const sectionList = (sections as ReadonlyArray<TemplateSectionShape>) ?? [];
  const section = findSection(sectionList, body.sectionKey);
  if (!section) {
    return c.json({ error: 'unknown_section_key', sectionKey: body.sectionKey }, 422);
  }
  const item = findItem(section, body.itemKey);
  if (!item) {
    return c.json(
      { error: 'unknown_item_key', sectionKey: body.sectionKey, itemKey: body.itemKey },
      422,
    );
  }

  // Encrypt the PI fields (T-I13).
  const obsSealed = sealOptionalField(body.observation);
  const correctiveSealed = sealOptionalField(body.correctiveAction);

  // 1.9 priv-F8 close-out: responsibleParty dual-shape — set
  // responsible_party_kind + responsible_party_user_id for 'user_ref'
  // (no encryption); set responsible_party_kind + encrypted name pair
  // for 'name_text'. The migration 0008 CHECK constraint enforces the
  // alignment at the DB layer.
  let respKind: 'user_ref' | 'name_text' | null = null;
  let respUserId: string | null = null;
  let respNameSealed: { ct: Uint8Array; dekCt: Uint8Array } | null = null;
  if (body.responsibleParty) {
    if (body.responsibleParty.kind === 'user_ref') {
      respKind = 'user_ref';
      respUserId = body.responsibleParty.userId;
    } else {
      respKind = 'name_text';
      respNameSealed = sealField(body.responsibleParty.nameText);
    }
  }
  const hasResponsibleParty = respKind !== null;

  // 1.10 (ADR-0009 §3.3): ratchet-level idempotency. The finding row
  // has no actor column; use the inspection's conducted_by_user_id as
  // the same-actor scope. A different actor reusing a finding clientId
  // returns 409; the same actor returns the existing row at 200.
  if (body.clientId) {
    const existing = (await db.execute(sql`
      SELECT f.id, f.inspection_id, f.section_key, f.section_label,
             f.item_key, f.item_label, f.status_vocab, f.status_value,
             f.observation_ct IS NOT NULL AS has_observation,
             f.corrective_action_ct IS NOT NULL AS has_corrective_action,
             f.responsible_party_kind IS NOT NULL AS has_responsible_party,
             i.conducted_by_user_id
      FROM inspection_findings f
      JOIN inspections i ON i.id = f.inspection_id
      WHERE f.id = ${body.clientId} AND f.inspection_id = ${idParsed.data}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      inspection_id: string;
      section_key: string;
      section_label: string;
      item_key: string;
      item_label: string;
      status_vocab: string;
      status_value: string;
      has_observation: boolean;
      has_corrective_action: boolean;
      has_responsible_party: boolean;
      conducted_by_user_id: string;
    }>;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.conducted_by_user_id !== auth.userId) {
        return c.json({ error: 'client_id_conflict' }, 409);
      }
      return c.json(
        {
          id: row.id,
          inspectionId: row.inspection_id,
          sectionKey: row.section_key,
          sectionLabel: row.section_label,
          itemKey: row.item_key,
          itemLabel: row.item_label,
          statusVocab: row.status_vocab as InspectionStatusVocabKind,
          statusValue: row.status_value,
          hasObservation: row.has_observation,
          hasCorrectiveAction: row.has_corrective_action,
          hasResponsibleParty: row.has_responsible_party,
        },
        200,
      );
    }
  }

  const findingId = body.clientId ?? crypto.randomUUID();
  await db.transaction(async (tx) => {
    const chainRow = await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'inspection_finding.created',
        inspectionId: idParsed.data,
        findingId,
        sectionKey: body.sectionKey,
        statusVocab: body.statusVocab,
        statusValue: body.statusValue,
        hasObservation: obsSealed !== null,
        hasCorrectiveAction: correctiveSealed !== null,
      },
      resourceType: 'inspection_findings',
      resourceId: findingId,
    });
    await tx.execute(sql`
      INSERT INTO inspection_findings (
        id, inspection_id,
        section_key, section_label, item_key, item_label,
        status_vocab, status_value,
        observation_ct, observation_dek_ct,
        corrective_action_ct, corrective_action_dek_ct,
        responsible_party_kind, responsible_party_user_id,
        responsible_party_ct, responsible_party_dek_ct,
        audit_idx
      )
      VALUES (
        ${findingId}, ${idParsed.data},
        ${body.sectionKey}, ${section.label}, ${body.itemKey}, ${item.label},
        ${body.statusVocab}, ${body.statusValue},
        ${obsSealed ? (Buffer.from(obsSealed.ct) as unknown as Uint8Array) : null},
        ${obsSealed ? (Buffer.from(obsSealed.dekCt) as unknown as Uint8Array) : null},
        ${correctiveSealed ? (Buffer.from(correctiveSealed.ct) as unknown as Uint8Array) : null},
        ${correctiveSealed ? (Buffer.from(correctiveSealed.dekCt) as unknown as Uint8Array) : null},
        ${respKind},
        ${respUserId},
        ${respNameSealed ? (Buffer.from(respNameSealed.ct) as unknown as Uint8Array) : null},
        ${respNameSealed ? (Buffer.from(respNameSealed.dekCt) as unknown as Uint8Array) : null},
        ${chainRow.idx}
      )
    `);
  });

  return c.json({
    id: findingId,
    inspectionId: idParsed.data,
    sectionKey: body.sectionKey,
    sectionLabel: section.label,
    itemKey: body.itemKey,
    itemLabel: item.label,
    statusVocab: body.statusVocab,
    statusValue: body.statusValue,
    hasObservation: obsSealed !== null,
    hasCorrectiveAction: correctiveSealed !== null,
    hasResponsibleParty,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/inspections/findings/:id — update finding.
//
// Editable fields: status_value (within vocab), observation,
// corrective_action, responsible_party. The inspection MUST be in the
// 'in_progress' state — once it advances to awaiting_signatures or
// later, findings are immutable. This is the chain-of-custody discipline
// from the prompt; no new chain anchor is emitted because the update
// surface is bounded by the create anchor (which carried the status
// signal). A future 1.9 ratchet can introduce inspection_finding.updated
// when the editable surface expands.
// ---------------------------------------------------------------------------

inspectionsRoute.patch('/findings/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = patchFindingBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT f.id, f.inspection_id, f.status_vocab, f.promoted_action_item_id,
               i.state
        FROM inspection_findings f
        JOIN inspections i ON i.id = f.inspection_id
        WHERE f.id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        inspection_id: string;
        status_vocab: string;
        promoted_action_item_id: string | null;
        state: string;
      }>;
      if (rows.length === 0) {
        throw new InspectionWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = rows[0]!;
      if (row.state !== 'in_progress') {
        throw new InspectionWriteAborted({
          status: 422,
          body: { error: 'finding_immutable_in_state', state: row.state },
        });
      }
      // sec-F5 / T-I39 close-out: once a finding has been promoted to
      // an action item, the substantive fields (statusValue,
      // observation, correctiveAction) become immutable. The
      // promote handler sealed the action_item description against
      // the finding's section/item labels at promote time; later
      // status/observation/corrective_action edits would let a rep
      // promote-then-cover-tracks (promote an A finding, mutate to X
      // so the inspection record reads "no issue" while the open
      // INSP action item stands). responsibleParty edits remain
      // allowed because that field most often needs amendment
      // without changing the finding's substance.
      if (row.promoted_action_item_id !== null) {
        const mutatesSubstantive =
          body.statusValue !== undefined ||
          body.observation !== undefined ||
          body.correctiveAction !== undefined;
        if (mutatesSubstantive) {
          throw new InspectionWriteAborted({
            status: 422,
            body: {
              error: 'finding_immutable_after_promote',
              promotedActionItemId: row.promoted_action_item_id,
            },
          });
        }
      }
      if (
        body.statusValue !== undefined &&
        !statusValueInVocab(row.status_vocab as InspectionStatusVocabKind, body.statusValue)
      ) {
        throw new InspectionWriteAborted({
          status: 422,
          body: { error: 'status_value_out_of_vocab', vocab: row.status_vocab },
        });
      }
      const setParts: SQL[] = [];
      if (body.statusValue !== undefined) {
        setParts.push(sql`status_value = ${body.statusValue}`);
      }
      function applyEncryptedField(
        column: 'observation' | 'corrective_action',
        value: string | null | undefined,
      ): void {
        if (value === undefined) return;
        if (value === null) {
          setParts.push(sql.raw(`${column}_ct = NULL`));
          setParts.push(sql.raw(`${column}_dek_ct = NULL`));
          return;
        }
        const sealed = sealField(value);
        setParts.push(
          sql`${sql.raw(`${column}_ct`)} = ${Buffer.from(sealed.ct) as unknown as Uint8Array}`,
        );
        setParts.push(
          sql`${sql.raw(`${column}_dek_ct`)} = ${Buffer.from(sealed.dekCt) as unknown as Uint8Array}`,
        );
      }
      applyEncryptedField('observation', body.observation);
      applyEncryptedField('corrective_action', body.correctiveAction);
      // 1.9 priv-F8 close-out: responsibleParty dual-shape on PATCH.
      // undefined → no change. null → clear (kind, user_id, _ct, _dek_ct
      // all NULL). 'user_ref' → set kind + user_id, clear encrypted
      // name. 'name_text' → set kind + encrypted name, clear user_id.
      // The migration 0008 CHECK constraint enforces the alignment;
      // setting all four columns in one UPDATE keeps a partial-write
      // mid-flight from violating the CHECK.
      if (body.responsibleParty !== undefined) {
        if (body.responsibleParty === null) {
          setParts.push(sql`responsible_party_kind = NULL`);
          setParts.push(sql`responsible_party_user_id = NULL`);
          setParts.push(sql`responsible_party_ct = NULL`);
          setParts.push(sql`responsible_party_dek_ct = NULL`);
        } else if (body.responsibleParty.kind === 'user_ref') {
          setParts.push(sql`responsible_party_kind = 'user_ref'`);
          setParts.push(sql`responsible_party_user_id = ${body.responsibleParty.userId}`);
          setParts.push(sql`responsible_party_ct = NULL`);
          setParts.push(sql`responsible_party_dek_ct = NULL`);
        } else {
          const sealed = sealField(body.responsibleParty.nameText);
          setParts.push(sql`responsible_party_kind = 'name_text'`);
          setParts.push(sql`responsible_party_user_id = NULL`);
          setParts.push(
            sql`responsible_party_ct = ${Buffer.from(sealed.ct) as unknown as Uint8Array}`,
          );
          setParts.push(
            sql`responsible_party_dek_ct = ${Buffer.from(sealed.dekCt) as unknown as Uint8Array}`,
          );
        }
      }
      if (setParts.length === 0) {
        throw new InspectionWriteAborted({ status: 400, body: { error: 'no_changes' } });
      }
      await tx.execute(sql`
        UPDATE inspection_findings SET ${sql.join(setParts, sql`, `)} WHERE id = ${idParsed.data}
      `);
      return { id: idParsed.data };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof InspectionWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 400 | 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/inspections/findings/:id — decrypted detail; step-up gated.
// ---------------------------------------------------------------------------

inspectionsRoute.get('/findings/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

  const auth = c.get('auth');
  // 60s step-up freshness floor (T-I30). The action string is echoed
  // in the WWW-Authenticate challenge header for the client's step-up
  // modal; the server enforces only the (actor, freshness-window)
  // tuple, NOT a per-action binding. True per-action binding is a
  // 1.12 hardening item (sec-F1 close-out from 1.9 S5 review,
  // documented in docs/runbooks/recommendations.md §11).
  const challenge = checkStepUpFreshness(auth, {
    action: 'inspection.finding.read',
    maxAgeSeconds: 60,
  });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }

  const db = getDb();
  // 1.9 priv-F3 close-out (ADR-0008 §3.12): wrap the read + the new
  // `inspection_finding.read` chain anchor in one transaction. The
  // anchor fires AFTER the step-up gate passes AND inside the same
  // transaction as the SELECT so a chain row only lands when an
  // authorized decrypt actually completes. The pre-1.9 handler was
  // read-only with no per-read trail; the 1.8 runbook called this
  // out as a 1.9 deferred item. Same posture as the 1.7
  // evidence.read pattern.
  const result = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id, inspection_id, section_key, section_label, item_key, item_label,
             status_vocab, status_value,
             observation_ct, observation_dek_ct,
             corrective_action_ct, corrective_action_dek_ct,
             responsible_party_kind, responsible_party_user_id,
             responsible_party_ct, responsible_party_dek_ct,
             promoted_action_item_id,
             created_at::text AS created_at,
             updated_at::text AS updated_at
      FROM inspection_findings
      WHERE id = ${idParsed.data}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      inspection_id: string;
      section_key: string;
      section_label: string;
      item_key: string;
      item_label: string;
      status_vocab: string;
      status_value: string;
      observation_ct: Uint8Array | null;
      observation_dek_ct: Uint8Array | null;
      corrective_action_ct: Uint8Array | null;
      corrective_action_dek_ct: Uint8Array | null;
      responsible_party_kind: string | null;
      responsible_party_user_id: string | null;
      responsible_party_ct: Uint8Array | null;
      responsible_party_dek_ct: Uint8Array | null;
      promoted_action_item_id: string | null;
      created_at: string;
      updated_at: string;
    }>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'inspection_finding.read',
        findingId: r.id,
        inspectionId: r.inspection_id,
      },
      resourceType: 'inspection_findings',
      resourceId: r.id,
    });
    return r;
  });
  if (!result) return c.json({ error: 'not_found' }, 404);
  const r = result;
  // 1.9 priv-F8 close-out: project responsibleParty as the
  // discriminated union shape. 'user_ref' surfaces the user id; the
  // encrypted-name path is decrypted only when kind === 'name_text'.
  // Pre-1.9 rows with kind=NULL but encrypted-name set (open findings
  // authored under the 1.8 contract) read as null here — the rep
  // re-edits the responsible-party field on first edit to opt the row
  // into the 'name_text' kind.
  let responsibleParty:
    | { kind: 'user_ref'; userId: string }
    | { kind: 'name_text'; nameText: string }
    | null;
  if (r.responsible_party_kind === 'user_ref' && r.responsible_party_user_id !== null) {
    responsibleParty = { kind: 'user_ref', userId: r.responsible_party_user_id };
  } else if (
    r.responsible_party_kind === 'name_text' &&
    r.responsible_party_ct !== null &&
    r.responsible_party_dek_ct !== null
  ) {
    responsibleParty = {
      kind: 'name_text',
      nameText: openOptionalField({
        ct: r.responsible_party_ct,
        dekCt: r.responsible_party_dek_ct,
      }) as string,
    };
  } else {
    responsibleParty = null;
  }
  return c.json({
    id: r.id,
    inspectionId: r.inspection_id,
    sectionKey: r.section_key,
    sectionLabel: r.section_label,
    itemKey: r.item_key,
    itemLabel: r.item_label,
    statusVocab: r.status_vocab as InspectionStatusVocabKind,
    statusValue: r.status_value,
    observation: openOptionalField({ ct: r.observation_ct, dekCt: r.observation_dek_ct }),
    correctiveAction: openOptionalField({
      ct: r.corrective_action_ct,
      dekCt: r.corrective_action_dek_ct,
    }),
    responsibleParty,
    promotedActionItemId: r.promoted_action_item_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
});

// ---------------------------------------------------------------------------
// POST /api/inspections/findings/:id/promote — THE #15 fail-closed gate.
// ---------------------------------------------------------------------------

inspectionsRoute.post('/findings/:id/promote', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = promoteFindingBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const risk: ActionItemRisk = parsed.data.risk;
  const auth = c.get('auth');
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // 1.10 (ADR-0009 §3.3): ratchet-level idempotency. The promote
  // creates a NEW action item; clientId here is that new id. The
  // finding's UNIQUE on promoted_action_item_id is the structural
  // backstop (T-I16). A clientId reuse where the existing action_item
  // belongs to the same actor (via the create move row) returns 200
  // with the same shape; cross-actor returns 409.
  if (parsed.data.clientId) {
    const existing = (await db.execute(sql`
      SELECT ai.id, ai.risk,
             m.moved_by_user_id AS created_by_user_id
      FROM action_items ai
      LEFT JOIN action_item_moves m
        ON m.action_item_id = ai.id AND m.from_section IS NULL
      WHERE ai.id = ${parsed.data.clientId}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      risk: string;
      created_by_user_id: string | null;
    }>;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.created_by_user_id !== auth.userId) {
        return c.json({ error: 'client_id_conflict' }, 409);
      }
      return c.json(
        {
          findingId: idParsed.data,
          actionItemId: row.id,
          risk: row.risk as ActionItemRisk,
        },
        200,
      );
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE on the finding row before any check — serializes
      // concurrent POSTs so the double-promotion guard is race-safe
      // (T-I16). The schema's UNIQUE index on promoted_action_item_id
      // is the second line of defense.
      // sec-F3 close-out: the SELECT no longer reads observation /
      // corrective_action / responsible_party ciphertext. The promote
      // handler no longer needs to decrypt these — the action-item
      // description is derived from the template-snapshot labels only.
      const findingRows = (await tx.execute(sql`
        SELECT id, inspection_id, status_vocab, status_value,
               section_label, item_label,
               promoted_action_item_id
        FROM inspection_findings
        WHERE id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        inspection_id: string;
        status_vocab: string;
        status_value: string;
        section_label: string;
        item_label: string;
        promoted_action_item_id: string | null;
      }>;
      if (findingRows.length === 0) {
        throw new InspectionWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const f = findingRows[0]!;
      // THE #15 FAIL-CLOSED GATE (T-I15). Runs before any DB write. X
      // (ABC+X) and G (GAR) fail-close. Future vocabs that omit a
      // `promotable: false` marker are also rejected by the helper.
      if (!inspectionPromotability(f.status_vocab as InspectionStatusVocabKind, f.status_value)) {
        throw new InspectionWriteAborted({
          status: 422,
          body: {
            error: 'not_promotable_status',
            statusVocab: f.status_vocab,
            statusValue: f.status_value,
          },
        });
      }
      if (f.promoted_action_item_id !== null) {
        throw new InspectionWriteAborted({
          status: 422,
          body: { error: 'already_promoted', actionItemId: f.promoted_action_item_id },
        });
      }

      // sec-F3 / T-I37 close-out: derive a NON-PI action-item
      // description from the finding's section/item label snapshot
      // ONLY. The pre-S5 implementation welded the decrypted
      // observation + corrective_action plaintext into the description,
      // which then became readable via the no-step-up
      // `GET /api/action-items/:id` route — bypassing the
      // `inspection.finding.read` step-up gate (T-I30) in two
      // unrelated authenticated calls. The promote no longer widens
      // the PI surface. Anyone wanting the finding text takes the
      // step-up gated `GET /api/inspections/findings/:id` route.
      //
      // Section/item labels are template-snapshotted at finding
      // create time (non-PI per T-I12 / ADR-0007 §3.5 — template
      // content is non-PI by construction).
      const descriptionText = `Promoted from inspection finding: ${f.section_label} / ${f.item_label}. Open the finding for full context.`;
      const descSealed = sealActionItemField(descriptionText);

      // Allocate next per-section sequence number for new_business.
      const sequenceNumber = await allocateSequenceNumber(tx, 'new_business');

      // INSERT action_items. type='INSP' per CLAUDE.md taxonomy (INSP =
      // inspection-derived). source_type='inspection' triggers the
      // 1.6+1.8 action_items_source_fk_guard trigger which validates
      // source_id against inspection_findings (T-I18). meeting_id stays
      // NULL — ADR-0007 §3.7 documented forward seam to the 1.x meetings
      // backfill. 1.10 §3.3: use clientId when present as the canonical
      // action_items.id.
      const actionItemRows = parsed.data.clientId
        ? ((await tx.execute(sql`
            INSERT INTO action_items (
              id, sequence_number, type,
              description_ct, description_dek_ct,
              status, risk, section,
              start_date,
              source_type, source_id, tags
            )
            VALUES (
              ${parsed.data.clientId}, ${sequenceNumber}, 'INSP',
              ${Buffer.from(descSealed.ct) as unknown as Uint8Array},
              ${Buffer.from(descSealed.dekCt) as unknown as Uint8Array},
              'Not Started', ${risk}, 'new_business',
              ${today},
              'inspection', ${idParsed.data}, '{}'::text[]
            )
            RETURNING id
          `)) as unknown as Array<{ id: string }>)
        : ((await tx.execute(sql`
            INSERT INTO action_items (
              sequence_number, type,
              description_ct, description_dek_ct,
              status, risk, section,
              start_date,
              source_type, source_id, tags
            )
            VALUES (
              ${sequenceNumber}, 'INSP',
              ${Buffer.from(descSealed.ct) as unknown as Uint8Array},
              ${Buffer.from(descSealed.dekCt) as unknown as Uint8Array},
              'Not Started', ${risk}, 'new_business',
              ${today},
              'inspection', ${idParsed.data}, '{}'::text[]
            )
            RETURNING id
          `)) as unknown as Array<{ id: string }>);
      const actionItemId = actionItemRows[0]!.id;

      // action_item.created chain anchor fires (existing pattern from
      // 1.6 — the action-items route's POST handler emits this on every
      // create, including this server-side INSERT route). Our path is a
      // direct INSERT (not via the route), so emit it here for parity.
      const aiChain = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'action_item.created',
          itemId: actionItemId,
          itemType: 'INSP',
          section: 'new_business',
          risk,
        },
        resourceType: 'action_items',
        resourceId: actionItemId,
      });
      // Bootstrap action_item_moves row so the move history starts at
      // create time, matching the route's pattern.
      await tx.execute(sql`
        INSERT INTO action_item_moves (
          action_item_id, moved_by_user_id, from_section, to_section, audit_idx
        )
        VALUES (${actionItemId}, ${auth.userId}, NULL, 'new_business', ${aiChain.idx})
      `);

      // Bind the finding back to the action item (T-I17 bidirectional
      // FK closure inside one transaction).
      await tx.execute(sql`
        UPDATE inspection_findings
        SET promoted_action_item_id = ${actionItemId}
        WHERE id = ${idParsed.data}
      `);

      // Emit inspection_finding.promoted.
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'inspection_finding.promoted',
          findingId: idParsed.data,
          actionItemId,
          risk,
        },
        resourceType: 'inspection_findings',
        resourceId: idParsed.data,
      });

      return { findingId: idParsed.data, actionItemId, risk };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof InspectionWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/inspections/:id/signatures — sign as a role.
// ---------------------------------------------------------------------------

inspectionsRoute.post('/:id/signatures', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = signBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const { role, note } = parsed.data;

  // SINGLE-TENANT SIMPLIFICATION (ADR-0007 §3.8): any authenticated rep
  // can sign as any of the three roles. The role label tracks WHO they
  // sign AS; workplace-roles-table enforcement lands in a future release.
  // T-I20: the (inspection_id, role) UNIQUE index in the schema prevents
  // double-signing the same role.

  const noteSealed = sealOptionalField(note);
  const db = getDb();

  // 1.10 (ADR-0009 §3.3): ratchet-level idempotency. Signature has
  // signed_by_user_id as the actor scope. Same-actor + same-clientId
  // returns the existing row at 200; cross-actor returns 409. NB the
  // (inspection_id, role) UNIQUE already enforces "at most one of each
  // role per inspection" — a different clientId with the same role
  // hits that UNIQUE downstream and surfaces as 409 role_already_signed.
  if (parsed.data.clientId) {
    const existing = (await getDb().execute(sql`
      SELECT s.id, s.role, s.signed_at::text AS signed_at,
             s.signed_by_user_id, i.state
      FROM inspection_signatures s
      JOIN inspections i ON i.id = s.inspection_id
      WHERE s.id = ${parsed.data.clientId} AND s.inspection_id = ${idParsed.data}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      role: string;
      signed_at: string;
      signed_by_user_id: string;
      state: string;
    }>;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.signed_by_user_id !== auth.userId) {
        return c.json({ error: 'client_id_conflict' }, 409);
      }
      return c.json(
        { signatureId: row.id, inspectionState: row.state as InspectionConductState },
        200,
      );
    }
  }

  const signatureId = parsed.data.clientId ?? crypto.randomUUID();

  try {
    const result = await db.transaction(async (tx) => {
      const ctxRows = (await tx.execute(sql`
        SELECT i.id, i.state, t.requires_three_signatures
        FROM inspections i
        JOIN inspection_templates t ON t.id = i.template_version_id
        WHERE i.id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        state: string;
        requires_three_signatures: boolean;
      }>;
      if (ctxRows.length === 0) {
        throw new InspectionWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const { state, requires_three_signatures: requiresThree } = ctxRows[0]!;
      if (state !== 'in_progress' && state !== 'awaiting_signatures') {
        throw new InspectionWriteAborted({
          status: 422,
          body: { error: 'inspection_not_open_for_signatures', state },
        });
      }

      // Append the chain row first so the FK is non-null on INSERT
      // (sec-F1 pattern from 1.5/1.6/1.7).
      const chainRow = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'inspection.signed',
          inspectionId: idParsed.data,
          signatureId,
          role,
        },
        resourceType: 'inspection_signatures',
        resourceId: signatureId,
      });

      try {
        await tx.execute(sql`
          INSERT INTO inspection_signatures (
            id, inspection_id, signed_by_user_id, role, note_ct, note_dek_ct, audit_idx
          )
          VALUES (
            ${signatureId}, ${idParsed.data}, ${auth.userId}, ${role},
            ${noteSealed ? (Buffer.from(noteSealed.ct) as unknown as Uint8Array) : null},
            ${noteSealed ? (Buffer.from(noteSealed.dekCt) as unknown as Uint8Array) : null},
            ${chainRow.idx}
          )
        `);
      } catch (err) {
        // The UNIQUE(inspection_id, role) constraint is the route's
        // race-safe guard. Postgres reports this as a unique_violation
        // (23505); surface as 409.
        if (
          err instanceof Error &&
          ('code' in err
            ? (err as { code?: string }).code === '23505'
            : err.message.includes('23505'))
        ) {
          throw new InspectionWriteAborted({
            status: 409,
            body: { error: 'role_already_signed', role },
          });
        }
        throw err;
      }

      // Auto-complete logic. For zone_monthly (requires_three_signatures
      // = false) the inspector signature transitions to 'complete'. For
      // rack (requires_three_signatures = true) we transition to
      // 'complete' only when all three roles have a signature.
      let nextState: InspectionConductState = state as InspectionConductState;
      if (!requiresThree && role === 'inspector') {
        nextState = 'complete';
      } else if (requiresThree) {
        const counts = (await tx.execute(sql`
          SELECT COUNT(DISTINCT role)::int AS n
          FROM inspection_signatures
          WHERE inspection_id = ${idParsed.data}
        `)) as unknown as Array<{ n: number }>;
        if (Number(counts[0]!.n) >= 3) {
          nextState = 'complete';
        }
      }
      if (nextState !== state) {
        await tx.execute(sql`
          UPDATE inspections
          SET state = ${nextState}, completed_at = now()
          WHERE id = ${idParsed.data}
        `);
      } else if (state === 'in_progress' && requiresThree) {
        // Bump in_progress -> awaiting_signatures once any signature
        // lands for three-sig templates so the UI reflects "now waiting
        // on signatures." A non-three-sig template skips this — the
        // first inspector signature already advanced to complete above.
        await tx.execute(sql`
          UPDATE inspections SET state = 'awaiting_signatures' WHERE id = ${idParsed.data}
        `);
        nextState = 'awaiting_signatures';
      }

      return { signatureId, inspectionState: nextState };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof InspectionWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    throw err;
  }
});
