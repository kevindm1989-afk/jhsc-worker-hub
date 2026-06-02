// /api/recommendations/* — Milestone 1.9 S2.
//
// Routes (ADR-0008 §3.1):
//
//   POST   /api/recommendations               — create draft. Optionally
//                                                accepts citations on
//                                                create; the four-way Zod
//                                                gate (corpus presence +
//                                                dense positions + marker
//                                                density) runs only when
//                                                citations are present.
//                                                Emits recommendation.drafted.
//   GET    /api/recommendations               — list w/ filters (status,
//                                                jurisdiction, drafted_at
//                                                range). Projects the
//                                                computed deadline; never
//                                                returns title / body
//                                                ciphertext bytes.
//   GET    /api/recommendations/:id           — detail (metadata + has_*
//                                                flags + citation list +
//                                                response metadata). NO
//                                                decrypted text; the
//                                                /:id/reveal route is the
//                                                step-up gated decrypt
//                                                surface.
//   GET    /api/recommendations/:id/reveal    — decrypted title + body +
//                                                response bodies. Step-up
//                                                gated, 60s freshness floor
//                                                (action='recommendation.read').
//   PATCH  /api/recommendations/:id           — draft-state-only edits.
//                                                Allow-list: title, body,
//                                                jurisdiction (REJECTED to
//                                                preserve per-jurisdiction
//                                                sequence-number coherence),
//                                                citations (full replace).
//   POST   /api/recommendations/:id/submit    — THE bridge to action_items.
//                                                Re-validates citations
//                                                against the live corpus
//                                                (T-R7 / T-R8); re-validates
//                                                marker density; INSERTs
//                                                action_items row +
//                                                recommendation_action_item
//                                                _links row; emits
//                                                recommendation.submitted.
//   POST   /api/recommendations/:id/responses — append-only response
//                                                capture. Position
//                                                allocated via per-
//                                                recommendation advisory
//                                                lock (T-R10). Cap 50
//                                                (T-R42 / SQL CHECK).
//   POST   /api/recommendations/:id/resolve   — requires response_received
//                                                state. Linked action_item
//                                                moves to
//                                                completed_this_period +
//                                                status='Closed'. Emits
//                                                recommendation.resolved.
//   POST   /api/recommendations/:id/withdraw  — side state. Reason is an
//                                                enum for PI-cleanliness.
//                                                Linked action_item (if any)
//                                                moves to archived +
//                                                Cancelled. Emits
//                                                recommendation.withdrawn.
//
// Middleware order mirrors inspections / action-items: authMiddleware ->
// rateLimit -> bodyLimit. 256KB body cap because recommendation bodies
// are long-form prose (200-2000 words typical).
//
// SINGLE-TENANT SIMPLIFICATION (ADR-0008): any authenticated rep can
// submit, respond, resolve, or withdraw any recommendation. The drafted_by
// label tracks WHO drafted it; a workplace-roles-table enforcement
// remains a future release per ADR-0007 §3.8's same posture.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { append } from '@jhsc/audit';
import {
  computeRecommendationDeadline,
  recommendationJurisdiction,
  recommendationStatus,
  type RecommendationJurisdiction,
  type RecommendationStatus,
} from '@jhsc/shared-types';
import { getDb } from '../../db/client';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { rateLimit } from '../../middleware/rate-limit';
import { openRecommendationField, sealRecommendationField } from '../../recommendations/crypto';
import { sealField as sealActionItemField } from '../../action-items/crypto';
import { computeCitationRowsHash } from '../../recommendations/citations';
import { noHtmlBounded } from '../../lib/string-validators';
import { allocateSequenceNumber } from '../action-items';
import { registerRecommendationExportHandlers } from './exports';

export const recommendationsRoute = new Hono();

recommendationsRoute.use('*', authMiddleware());
// Same ordering rationale as inspections: rateLimit BEFORE bodyLimit so
// spammed oversize POSTs still drain the bucket.
recommendationsRoute.use(
  '*',
  rateLimit({ name: 'recommendations', capacity: 60, refillPerSecond: 10 }),
);
// 256KB body cap — same as inspections. Recommendation bodies + citations
// are kilobyte-range each but bounded enough that one malicious POST
// cannot pin memory.
recommendationsRoute.use(
  '*',
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// S4 (ADR-0008 §3.8 / §3.9): mount the export + signed-bundle handlers
// onto this group. They handle:
//   POST /:id/exports          — render + sign + store + anchor
//   GET  /exports/:id/download — re-fetch + TOCTOU verify + serve
//   GET  /exports              — list (metadata only)
// The handlers reuse the route group's authMiddleware + rateLimit +
// bodyLimit (a tighter 64KB body cap is applied inline on POST since
// the export body is empty).
registerRecommendationExportHandlers(recommendationsRoute);

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const uuidParam = z.string().uuid();

const citationSchema = z
  .object({
    statuteCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9._-]+$/, 'statuteCode must match the corpus alphabet'),
    clauseId: z.string().uuid(),
    versionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
    position: z.number().int().min(1).max(500),
  })
  .strict();

// S5 priv-F14 close-out: title + body Zod refinements use the shared
// `noHtmlBounded` helper, which rejects HTML (`<`/`>`), C0/C1 control
// characters, and BiDi overrides (U+202A-U+202E + U+2066-U+2069).
// Reps drafting long-form prose can paste from Word/Outlook without
// thinking about it; the refinement catches hostile BiDi sequences
// that would re-order rendered text in the signed PDF (the rep sees
// "approve this" while the employer reads "deny this"). The helper
// lives in `apps/api/src/lib/string-validators.ts` and is shared
// with the inspections route.
const createBody = z
  .object({
    title: noHtmlBounded({ min: 1, max: 200 }),
    body: noHtmlBounded({ min: 1, max: 16000 }),
    jurisdiction: z.enum(recommendationJurisdiction),
    citations: z.array(citationSchema).max(500).optional(),
  })
  .strict();

const patchBody = z
  .object({
    title: noHtmlBounded({ min: 1, max: 200 }).optional(),
    body: noHtmlBounded({ min: 1, max: 16000 }).optional(),
    // jurisdiction is accepted in the schema so a hand-crafted body
    // reaches the route handler (which surfaces a clear 422), rather
    // than rejecting with a confusing generic 400. The handler asserts
    // jurisdiction is unchanged before any write.
    jurisdiction: z.enum(recommendationJurisdiction).optional(),
    citations: z.array(citationSchema).max(500).optional(),
  })
  .strict();

const listQuery = z.object({
  status: z.enum(recommendationStatus).optional(),
  jurisdiction: z.enum(recommendationJurisdiction).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const submitBody = z.object({}).strict();
const resolveBody = z.object({}).strict();

const responseBody = z
  .object({
    // S5 priv-F14 close-out: noHtmlBounded refinement on both fields
    // — same rationale as the create / patch bodies above.
    authorRole: noHtmlBounded({ min: 1, max: 120 }),
    body: noHtmlBounded({ min: 1, max: 8000 }),
  })
  .strict();

// Withdrawal reason is a PI-clean enum (ADR-0008 §3.1). The SQL column
// caps at 200 chars; the route's enum is the tighter gate. The rep's
// free-text reason is intentionally NOT stored anywhere (the encrypted-
// free-text path is a documented forward seam in ADR-0008 §3.2).
const WITHDRAW_REASONS = ['rescinded', 'superseded', 'addressed_pre_submission'] as const;
type WithdrawReason = (typeof WITHDRAW_REASONS)[number];
const withdrawBody = z
  .object({
    reason: z.enum(WITHDRAW_REASONS),
  })
  .strict();

// ---------------------------------------------------------------------------
// Sentinel for transaction rollback paths (mirror inspections /
// action-items pattern).
// ---------------------------------------------------------------------------

class RecommendationWriteAborted extends Error {
  readonly payload: { status: number; body: Record<string, unknown> };
  constructor(payload: { status: number; body: Record<string, unknown> }) {
    super(`recommendation_write_aborted: ${payload.status}`);
    this.name = 'RecommendationWriteAborted';
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface CitationInput {
  readonly statuteCode: string;
  readonly clauseId: string;
  readonly versionDate: string;
  readonly position: number;
}

/**
 * The four-way citation Zod gate (ADR-0008 §3.3 / T-R6 / T-R7 / T-R8):
 *
 *   1. Every (statuteCode, clauseId, versionDate) triple exists in
 *      legal_clauses (corpus-presence gate; FK-equivalent without the
 *      hard FK that would block corpus rotation).
 *   2. Positions are dense 1..N with no gaps or duplicates.
 *   3. Every `[[cite:N]]` marker in the body has a matching position
 *      entry in the citation list.
 *   4. Every citation list entry has a corresponding `[[cite:N]]`
 *      marker in the body.
 *
 * Reuses the same logic at create (when citations are present) and at
 * submit (re-validation against the live corpus per T-R8 corpus-drift
 * close-out).
 */
async function validateCitations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  body: string,
  citations: ReadonlyArray<CitationInput>,
): Promise<{ error: string; details?: Record<string, unknown> } | null> {
  // (2) Dense positions check — sort + verify the sequence is 1..N
  // with no gaps and no duplicates.
  const positions = citations
    .map((c) => c.position)
    .slice()
    .sort((a, b) => a - b);
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] !== i + 1) {
      return {
        error: 'citation_positions_not_dense',
        details: { expected: i + 1, got: positions[i] ?? null, positions },
      };
    }
  }

  // (3) + (4) Marker density. Parse [[cite:N]] markers from the body.
  // ADR-0008 §3.3 requires every marker to have a matching position
  // AND vice versa.
  const markerPositions = new Set<number>();
  const markerRegex = /\[\[cite:(\d+)\]\]/g;
  for (;;) {
    const match = markerRegex.exec(body);
    if (!match) break;
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) {
      return { error: 'citation_marker_mismatch', details: { reason: 'invalid_marker_index' } };
    }
    markerPositions.add(n);
  }
  const citationPositions = new Set(citations.map((c) => c.position));
  // Every marker must have a matching citation.
  for (const m of markerPositions) {
    if (!citationPositions.has(m)) {
      return {
        error: 'citation_marker_mismatch',
        details: { reason: 'marker_without_citation', position: m },
      };
    }
  }
  // Every citation must have a matching marker.
  for (const p of citationPositions) {
    if (!markerPositions.has(p)) {
      return {
        error: 'citation_marker_mismatch',
        details: { reason: 'citation_without_marker', position: p },
      };
    }
  }

  // (1) Corpus-presence gate. Each triple must resolve in legal_clauses
  // joined to statutes via statute_code. Runs per-citation; bounded by
  // the route's max of 500 citations per request.
  for (const c of citations) {
    const rows = (await tx.execute(sql`
      SELECT 1
      FROM clauses cl
      JOIN statutes s ON s.id = cl.statute_id
      WHERE s.code = ${c.statuteCode}
        AND cl.id = ${c.clauseId}
        AND cl.version_date = ${c.versionDate}::date
      LIMIT 1
    `)) as unknown as Array<unknown>;
    if (rows.length === 0) {
      return {
        error: 'citation_corpus_drift',
        details: {
          statuteCode: c.statuteCode,
          clauseId: c.clauseId,
          versionDate: c.versionDate,
          position: c.position,
        },
      };
    }
  }

  return null;
}

/**
 * Allocate the next per-jurisdiction recommendation_number under an
 * advisory-lock keyed on `recommendation.number.<jurisdiction>` (ADR-0008
 * §3.2). Mirrors the 1.6 allocateSequenceNumber pattern. The per-
 * jurisdiction key means ON and CA-FED sequences advance independently;
 * the UNIQUE (jurisdiction, recommendation_number) is the structural
 * backstop (T-R5).
 */
async function allocateRecommendationNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  jurisdiction: RecommendationJurisdiction,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('recommendation.number.' || ${jurisdiction}))`,
  );
  const rows = (await tx.execute(sql`
    SELECT COALESCE(MAX(recommendation_number), 0) + 1 AS n
    FROM recommendations
    WHERE jurisdiction = ${jurisdiction}
  `)) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]!.n);
}

/**
 * Allocate the next per-recommendation response position under an
 * advisory-lock keyed on the recommendation id (ADR-0008 §3.4 / T-R10).
 * Concurrent responders serialize; the UNIQUE (recommendation_id,
 * position) is the structural backstop.
 */
async function allocateResponsePosition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  recommendationId: string,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('recommendation_response.position.' || ${recommendationId}))`,
  );
  const rows = (await tx.execute(sql`
    SELECT COALESCE(MAX(position), 0) + 1 AS n
    FROM recommendation_responses
    WHERE recommendation_id = ${recommendationId}
  `)) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]!.n);
}

// ---------------------------------------------------------------------------
// POST /api/recommendations — create draft
// ---------------------------------------------------------------------------

recommendationsRoute.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const db = getDb();

  // sec-F1-style anchor-first ordering: chain row first so the
  // recommendations.audit_idx FK has a real target. Mirrors hazards /
  // inspections create paths.
  const recommendationId = crypto.randomUUID();

  try {
    const created = await db.transaction(async (tx) => {
      // Validate citations BEFORE allocating the number — failed
      // validation should not burn a sequence number.
      if (body.citations && body.citations.length > 0) {
        const err = await validateCitations(tx, body.body, body.citations);
        if (err) {
          throw new RecommendationWriteAborted({
            status: 422,
            body: { error: err.error, ...(err.details ?? {}) },
          });
        }
      }

      const recommendationNumber = await allocateRecommendationNumber(tx, body.jurisdiction);

      const titleSealed = sealRecommendationField(body.title);
      const bodySealed = sealRecommendationField(body.body);

      const chainRow = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'recommendation.drafted',
          recommendationId,
          recommendationNumber,
          jurisdiction: body.jurisdiction,
        },
        resourceType: 'recommendations',
        resourceId: recommendationId,
      });

      const insertedRows = (await tx.execute(sql`
        INSERT INTO recommendations (
          id, recommendation_number,
          title_ct, title_dek_ct,
          body_ct, body_dek_ct,
          jurisdiction, status, drafted_by_user_id, audit_idx
        )
        VALUES (
          ${recommendationId}, ${recommendationNumber},
          ${Buffer.from(titleSealed.ct) as unknown as Uint8Array},
          ${Buffer.from(titleSealed.dekCt) as unknown as Uint8Array},
          ${Buffer.from(bodySealed.ct) as unknown as Uint8Array},
          ${Buffer.from(bodySealed.dekCt) as unknown as Uint8Array},
          ${body.jurisdiction}, 'draft', ${auth.userId}, ${chainRow.idx}
        )
        RETURNING drafted_at::text AS drafted_at
      `)) as unknown as Array<{ drafted_at: string }>;

      if (body.citations && body.citations.length > 0) {
        for (const cite of body.citations) {
          await tx.execute(sql`
            INSERT INTO recommendation_citations (
              recommendation_id, statute_code, clause_id, version_date, position
            )
            VALUES (
              ${recommendationId}, ${cite.statuteCode}, ${cite.clauseId},
              ${cite.versionDate}::date, ${cite.position}
            )
          `);
        }
      }

      return { recommendationNumber, draftedAt: insertedRows[0]!.drafted_at };
    });

    return c.json(
      {
        id: recommendationId,
        recommendationNumber: created.recommendationNumber,
        jurisdiction: body.jurisdiction,
        status: 'draft' as RecommendationStatus,
        draftedAt: created.draftedAt,
      },
      201,
    );
  } catch (err) {
    if (err instanceof RecommendationWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/recommendations — list with filters
// ---------------------------------------------------------------------------

recommendationsRoute.get('/', async (c) => {
  const parsed = listQuery.safeParse({
    status: c.req.query('status'),
    jurisdiction: c.req.query('jurisdiction'),
    from: c.req.query('from'),
    to: c.req.query('to'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const { status, jurisdiction, from, to } = parsed.data;
  const db = getDb();

  // T-R5 / T-R11: list endpoint projects metadata + computed deadline
  // only. Title / body / response body ciphertext bytes are NEVER in
  // the list response. Per-row count joins (citation_count,
  // response_count, has_response) are computed via correlated subqueries
  // — the page-size LIMIT 200 bounds the worst case.
  const rows = (await db.execute(sql`
    SELECT r.id, r.recommendation_number, r.jurisdiction, r.status,
           r.drafted_at::text AS drafted_at,
           r.submitted_at::text AS submitted_at,
           (SELECT COUNT(*) FROM recommendation_citations rc WHERE rc.recommendation_id = r.id)::int AS citation_count,
           (SELECT COUNT(*) FROM recommendation_responses rr WHERE rr.recommendation_id = r.id)::int AS response_count
    FROM recommendations r
    WHERE 1=1
      ${status ? sql`AND r.status = ${status}` : sql``}
      ${jurisdiction ? sql`AND r.jurisdiction = ${jurisdiction}` : sql``}
      ${from ? sql`AND r.drafted_at >= ${from}::timestamptz` : sql``}
      ${to ? sql`AND r.drafted_at <= ${to}::timestamptz` : sql``}
    ORDER BY r.drafted_at DESC, r.id DESC
    LIMIT 200
  `)) as unknown as Array<{
    id: string;
    recommendation_number: number;
    jurisdiction: string;
    status: string;
    drafted_at: string;
    submitted_at: string | null;
    citation_count: number;
    response_count: number;
  }>;

  return c.json({
    items: rows.map((r) => {
      const jurisdictionTyped = r.jurisdiction as RecommendationJurisdiction;
      const deadline =
        r.submitted_at !== null
          ? computeRecommendationDeadline(new Date(r.submitted_at), jurisdictionTyped)
          : null;
      return {
        id: r.id,
        recommendationNumber: r.recommendation_number,
        jurisdiction: jurisdictionTyped,
        status: r.status as RecommendationStatus,
        draftedAt: r.drafted_at,
        submittedAt: r.submitted_at,
        deadline: deadline ? deadline.toISOString() : null,
        citationCount: Number(r.citation_count),
        hasResponse: Number(r.response_count) > 0,
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// GET /api/recommendations/:id — detail (metadata + flags; no decrypted text)
// ---------------------------------------------------------------------------

recommendationsRoute.get('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const db = getDb();

  const rows = (await db.execute(sql`
    SELECT id, recommendation_number, jurisdiction, status, drafted_by_user_id,
           drafted_at::text AS drafted_at,
           submitted_at::text AS submitted_at,
           resolved_at::text AS resolved_at,
           withdrawn_at::text AS withdrawn_at,
           withdrawn_reason
    FROM recommendations
    WHERE id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    recommendation_number: number;
    jurisdiction: string;
    status: string;
    drafted_by_user_id: string;
    drafted_at: string;
    submitted_at: string | null;
    resolved_at: string | null;
    withdrawn_at: string | null;
    withdrawn_reason: string | null;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;

  const citationRows = (await db.execute(sql`
    SELECT statute_code, clause_id, version_date::text AS version_date, position
    FROM recommendation_citations
    WHERE recommendation_id = ${idParsed.data}
    ORDER BY position ASC
  `)) as unknown as Array<{
    statute_code: string;
    clause_id: string;
    version_date: string;
    position: number;
  }>;

  const responseRows = (await db.execute(sql`
    SELECT id, position, received_at::text AS received_at, received_by_user_id,
           (author_role_ct IS NOT NULL) AS has_author_role,
           (body_ct IS NOT NULL) AS has_body
    FROM recommendation_responses
    WHERE recommendation_id = ${idParsed.data}
    ORDER BY position ASC
  `)) as unknown as Array<{
    id: string;
    position: number;
    received_at: string;
    received_by_user_id: string;
    has_author_role: boolean;
    has_body: boolean;
  }>;

  const linkRows = (await db.execute(sql`
    SELECT action_item_id, link_kind
    FROM recommendation_action_item_links
    WHERE recommendation_id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{ action_item_id: string; link_kind: string }>;

  const jurisdictionTyped = r.jurisdiction as RecommendationJurisdiction;
  const deadline =
    r.submitted_at !== null
      ? computeRecommendationDeadline(new Date(r.submitted_at), jurisdictionTyped)
      : null;

  return c.json({
    id: r.id,
    recommendationNumber: r.recommendation_number,
    jurisdiction: jurisdictionTyped,
    status: r.status as RecommendationStatus,
    draftedByUserId: r.drafted_by_user_id,
    draftedAt: r.drafted_at,
    submittedAt: r.submitted_at,
    resolvedAt: r.resolved_at,
    withdrawnAt: r.withdrawn_at,
    withdrawnReason: r.withdrawn_reason,
    deadline: deadline ? deadline.toISOString() : null,
    // The PI surface: only presence flags, never the bytes themselves.
    hasTitle: true,
    hasBody: true,
    citations: citationRows.map((c) => ({
      statuteCode: c.statute_code,
      clauseId: c.clause_id,
      versionDate: c.version_date,
      position: c.position,
    })),
    responses: responseRows.map((rr) => ({
      id: rr.id,
      position: rr.position,
      receivedAt: rr.received_at,
      receivedByUserId: rr.received_by_user_id,
      hasAuthorRole: rr.has_author_role,
      hasBody: rr.has_body,
    })),
    linkedActionItemId: linkRows[0]?.action_item_id ?? null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/recommendations/:id/reveal — step-up gated decrypt surface
// ---------------------------------------------------------------------------

recommendationsRoute.get('/:id/reveal', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

  const auth = c.get('auth');
  // 60s step-up freshness floor. The action string is echoed in the
  // WWW-Authenticate challenge header for the client's UX; the server
  // enforces only the (actor, freshness-window) tuple, NOT a
  // per-action binding. A fresh grant for any prior step-up action
  // within the 60s window is accepted here. True per-action binding
  // is a 1.12 hardening item (sec-F1 close-out, runbook §11).
  const challenge = checkStepUpFreshness(auth, {
    action: 'recommendation.read',
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
  const rows = (await db.execute(sql`
    SELECT id, recommendation_number, jurisdiction, status,
           title_ct, title_dek_ct, body_ct, body_dek_ct
    FROM recommendations
    WHERE id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    recommendation_number: number;
    jurisdiction: string;
    status: string;
    title_ct: Uint8Array;
    title_dek_ct: Uint8Array;
    body_ct: Uint8Array;
    body_dek_ct: Uint8Array;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;

  const title = openRecommendationField({ ct: r.title_ct, dekCt: r.title_dek_ct });
  const recBody = openRecommendationField({ ct: r.body_ct, dekCt: r.body_dek_ct });

  const responseRows = (await db.execute(sql`
    SELECT id, position, received_at::text AS received_at, received_by_user_id,
           author_role_ct, author_role_dek_ct, body_ct, body_dek_ct
    FROM recommendation_responses
    WHERE recommendation_id = ${idParsed.data}
    ORDER BY position ASC
  `)) as unknown as Array<{
    id: string;
    position: number;
    received_at: string;
    received_by_user_id: string;
    author_role_ct: Uint8Array;
    author_role_dek_ct: Uint8Array;
    body_ct: Uint8Array;
    body_dek_ct: Uint8Array;
  }>;

  // NO chain anchor on reveal in 1.9. Same posture as the 1.8 finding
  // decrypt close-out — a recommendation.read kind is a documented
  // runbook follow-up so the contract stays at the nine kinds S1 added.

  return c.json({
    id: r.id,
    recommendationNumber: r.recommendation_number,
    jurisdiction: r.jurisdiction as RecommendationJurisdiction,
    status: r.status as RecommendationStatus,
    title,
    body: recBody,
    responses: responseRows.map((rr) => ({
      id: rr.id,
      position: rr.position,
      receivedAt: rr.received_at,
      receivedByUserId: rr.received_by_user_id,
      authorRole: openRecommendationField({
        ct: rr.author_role_ct,
        dekCt: rr.author_role_dek_ct,
      }),
      body: openRecommendationField({ ct: rr.body_ct, dekCt: rr.body_dek_ct }),
    })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/recommendations/:id — draft-state-only edits
// ---------------------------------------------------------------------------

recommendationsRoute.patch('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, recommendation_number, status, jurisdiction, body_ct, body_dek_ct
        FROM recommendations WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        recommendation_number: number;
        status: string;
        jurisdiction: string;
        body_ct: Uint8Array;
        body_dek_ct: Uint8Array;
      }>;
      if (locked.length === 0) {
        throw new RecommendationWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = locked[0]!;
      if (row.status !== 'draft') {
        throw new RecommendationWriteAborted({
          status: 422,
          body: { error: 'not_draft_state', status: row.status },
        });
      }
      // Jurisdiction is intentionally immutable after draft save to
      // preserve the per-jurisdiction recommendation_number coherence
      // (the number was allocated under the original jurisdiction's
      // sequence). A jurisdiction change would also invalidate any
      // citation already validated against a jurisdiction-scoped corpus
      // picker.
      if (body.jurisdiction !== undefined && body.jurisdiction !== row.jurisdiction) {
        throw new RecommendationWriteAborted({
          status: 422,
          body: {
            error: 'jurisdiction_immutable_after_draft_save',
            jurisdiction: row.jurisdiction,
          },
        });
      }

      // S5 sec-F4 close-out (T-R44): compute priorCitationsHash from
      // the EXISTING citation rows BEFORE any DELETE so the chain
      // anchor records what was there. (Empty input is hashed
      // deterministically; the anchor distinguishes empty-before /
      // empty-after / churn between non-empty sets.)
      const priorCitationRows = (await tx.execute(sql`
        SELECT statute_code, clause_id, version_date::text AS version_date, position
        FROM recommendation_citations
        WHERE recommendation_id = ${idParsed.data}
        ORDER BY position ASC
      `)) as unknown as Array<{
        statute_code: string;
        clause_id: string;
        version_date: string;
        position: number;
      }>;
      const priorCitationsForHash = priorCitationRows.map((r) => ({
        statuteCode: r.statute_code,
        clauseId: r.clause_id,
        versionDate: r.version_date,
        position: r.position,
      }));
      const priorCitationsHash = computeCitationRowsHash(priorCitationsForHash);

      // Determine the body text the citation gate will validate against:
      // either the incoming patched body, or the existing decrypted body
      // when only citations changed. (Used for both the body-only
      // sec-F8 re-validation path AND the body+citations path.)
      let bodyText: string | null = null;
      if (body.body !== undefined || body.citations !== undefined) {
        bodyText =
          body.body !== undefined
            ? body.body
            : openRecommendationField({ ct: row.body_ct, dekCt: row.body_dek_ct });
      }

      if (body.citations !== undefined && bodyText !== null) {
        const err = await validateCitations(tx, bodyText, body.citations);
        if (err) {
          throw new RecommendationWriteAborted({
            status: 422,
            body: { error: err.error, ...(err.details ?? {}) },
          });
        }
      } else if (body.body !== undefined && body.citations === undefined) {
        // S5 sec-F8 close-out: body-only PATCH must re-validate the
        // new body against the EXISTING citation set. Otherwise a rep
        // can edit the body to add dangling `[[cite:N]]` markers (or
        // remove markers that leave citation rows unreferenced) and
        // the failure surfaces only at submit time — a 422 here is
        // friendlier than a 422 at submit when the rep has 2000 words
        // queued up.
        const err = await validateCitations(tx, bodyText!, priorCitationsForHash);
        if (err) {
          throw new RecommendationWriteAborted({
            status: 422,
            body: { error: err.error, ...(err.details ?? {}) },
          });
        }
      }

      const setFragments: ReturnType<typeof sql>[] = [];
      if (body.title !== undefined) {
        const sealed = sealRecommendationField(body.title);
        setFragments.push(sql`title_ct = ${Buffer.from(sealed.ct) as unknown as Uint8Array}`);
        setFragments.push(
          sql`title_dek_ct = ${Buffer.from(sealed.dekCt) as unknown as Uint8Array}`,
        );
      }
      if (body.body !== undefined) {
        const sealed = sealRecommendationField(body.body);
        setFragments.push(sql`body_ct = ${Buffer.from(sealed.ct) as unknown as Uint8Array}`);
        setFragments.push(sql`body_dek_ct = ${Buffer.from(sealed.dekCt) as unknown as Uint8Array}`);
      }
      if (setFragments.length > 0) {
        await tx.execute(sql`
          UPDATE recommendations SET ${sql.join(setFragments, sql`, `)}
          WHERE id = ${idParsed.data}
        `);
      }

      if (body.citations !== undefined) {
        // Full replacement: delete existing rows + insert the new set.
        await tx.execute(sql`
          DELETE FROM recommendation_citations WHERE recommendation_id = ${idParsed.data}
        `);
        for (const cite of body.citations) {
          await tx.execute(sql`
            INSERT INTO recommendation_citations (
              recommendation_id, statute_code, clause_id, version_date, position
            )
            VALUES (
              ${idParsed.data}, ${cite.statuteCode}, ${cite.clauseId},
              ${cite.versionDate}::date, ${cite.position}
            )
          `);
        }
      }

      // S5 sec-F4 close-out (T-R44): emit a recommendation.draft_patched
      // chain anchor when the PATCH actually mutated something.
      // priorCitationsHash + newCitationsHash capture citation churn;
      // bodyChanged is a boolean tracking whether the request included
      // a `body` field (we don't decrypt the existing body just to
      // compare — pragmatic choice documented in the anchor's shared-
      // types comment). A no-op PATCH (e.g. body sent but unchanged
      // and citations sent but unchanged) still anchors because the
      // route can't cheaply tell the difference; the chain row is
      // structurally a no-PI receipt either way.
      const hasMutation =
        body.title !== undefined || body.body !== undefined || body.citations !== undefined;
      if (hasMutation) {
        const newCitations = body.citations ?? priorCitationsForHash;
        const newCitationsHash = computeCitationRowsHash(newCitations);
        await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'recommendation.draft_patched',
            recommendationId: idParsed.data,
            recommendationNumber: row.recommendation_number,
            priorCitationsHash,
            newCitationsHash,
            bodyChanged: body.body !== undefined,
          },
          resourceType: 'recommendations',
          resourceId: idParsed.data,
        });
      }
      return { id: idParsed.data };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RecommendationWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/:id/submit — THE bridge to action_items
// ---------------------------------------------------------------------------

recommendationsRoute.post('/:id/submit', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = submitBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, recommendation_number, jurisdiction, status,
               body_ct, body_dek_ct
        FROM recommendations WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        recommendation_number: number;
        jurisdiction: string;
        status: string;
        body_ct: Uint8Array;
        body_dek_ct: Uint8Array;
      }>;
      if (locked.length === 0) {
        throw new RecommendationWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = locked[0]!;
      if (row.status !== 'draft') {
        throw new RecommendationWriteAborted({
          status: 422,
          body: { error: 'not_draft_state', status: row.status },
        });
      }
      const jurisdictionTyped = row.jurisdiction as RecommendationJurisdiction;

      // Re-validate the citation set against the LIVE corpus + the
      // marker density of the CURRENT body. T-R7 / T-R8 close-out: a
      // corpus rotation between draft and submit retires a triple that
      // was valid at create time; the re-validation catches it and
      // rejects with 422 citation_corpus_drift.
      const citationRows = (await tx.execute(sql`
        SELECT statute_code, clause_id, version_date::text AS version_date, position
        FROM recommendation_citations
        WHERE recommendation_id = ${idParsed.data}
        ORDER BY position ASC
      `)) as unknown as Array<{
        statute_code: string;
        clause_id: string;
        version_date: string;
        position: number;
      }>;
      const citations: ReadonlyArray<CitationInput> = citationRows.map((cr) => ({
        statuteCode: cr.statute_code,
        clauseId: cr.clause_id,
        versionDate: cr.version_date,
        position: cr.position,
      }));
      const decryptedBody = openRecommendationField({
        ct: row.body_ct,
        dekCt: row.body_dek_ct,
      });
      // validateCitations covers all four gates including dense
      // positions (which the schema already enforces structurally on
      // INSERT) and corpus presence. Citations may legitimately be
      // empty on submit if the rep authored a recommendation that
      // doesn't cite a specific clause — in that case marker density
      // check is automatically satisfied (no markers, no positions).
      const validationErr = await validateCitations(tx, decryptedBody, citations);
      if (validationErr) {
        throw new RecommendationWriteAborted({
          status: 422,
          body: { error: validationErr.error, ...(validationErr.details ?? {}) },
        });
      }

      // Allocate the action_items sequence number under section
      // 'recommendation'. Reuses the 1.6 allocator (scope key
      // 'action_items.seq.recommendation').
      const actionItemSequenceNumber = await allocateSequenceNumber(tx, 'recommendation');

      // T-R12 close-out: derive a PI-CLEAN action-item description.
      // The recommendation number + jurisdiction are non-PI; the
      // description points the reader at the recommendation detail
      // route for the full text rather than welding title / body
      // plaintext into the action-item description (same posture as
      // 1.8 sec-F3 finding-promote derived description).
      const actionItemDescription = `Recommendation #${row.recommendation_number} (${jurisdictionTyped}): Open the recommendation for full text.`;
      const descSealed = sealActionItemField(actionItemDescription);
      const today = new Date().toISOString().slice(0, 10);

      // Pre-allocate the action_item id so the chain payload + the link
      // row reference the same value.
      const actionItemId = crypto.randomUUID();

      // INSERT the action_items row. type='REC' per CLAUDE.md taxonomy.
      // source_type='recommendation' triggers the 1.9-extended
      // action_items_source_fk_guard trigger which validates source_id
      // against recommendations (T-R14). section='recommendation' lands
      // the item in the minutes' recommendation bucket; status defaults
      // to 'Not Started'; risk defaults to 'Medium' (the recommendation
      // itself does not carry a risk per ADR-0008 §3.5 — the rep can
      // edit risk later via the standard action-items PATCH route).
      await tx.execute(sql`
        INSERT INTO action_items (
          id, sequence_number, type,
          description_ct, description_dek_ct,
          status, risk, section,
          start_date,
          source_type, source_id, tags
        )
        VALUES (
          ${actionItemId}, ${actionItemSequenceNumber}, 'REC',
          ${Buffer.from(descSealed.ct) as unknown as Uint8Array},
          ${Buffer.from(descSealed.dekCt) as unknown as Uint8Array},
          'Not Started', 'Medium', 'recommendation',
          ${today},
          'recommendation', ${idParsed.data}, '{}'::text[]
        )
      `);

      // action_item.created chain anchor — mirrors the
      // inspection-promote handler's parity emission. Bootstrap an
      // action_item_moves row at create time so the move history starts
      // alongside.
      const aiChain = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'action_item.created',
          itemId: actionItemId,
          itemType: 'REC',
          section: 'recommendation',
          risk: 'Medium',
        },
        resourceType: 'action_items',
        resourceId: actionItemId,
      });
      await tx.execute(sql`
        INSERT INTO action_item_moves (
          action_item_id, moved_by_user_id, from_section, to_section, audit_idx
        )
        VALUES (${actionItemId}, ${auth.userId}, NULL, 'recommendation', ${aiChain.idx})
      `);

      // Bridge row — link_kind='tracks' in 1.9; 'replaces' is a forward
      // seam per ADR-0008 §3.5 (UI lands in Release 2). UNIQUE
      // (action_item_id) is the structural T-R13 backstop.
      await tx.execute(sql`
        INSERT INTO recommendation_action_item_links (
          recommendation_id, action_item_id, link_kind
        )
        VALUES (${idParsed.data}, ${actionItemId}, 'tracks')
      `);

      // Flip recommendation status to 'submitted' + stamp submitted_at.
      await tx.execute(sql`
        UPDATE recommendations
        SET status = 'submitted', submitted_at = now()
        WHERE id = ${idParsed.data}
      `);

      // recommendation.submitted chain anchor. PI-clean: ids + counts +
      // enum values only.
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'recommendation.submitted',
          recommendationId: idParsed.data,
          recommendationNumber: row.recommendation_number,
          jurisdiction: jurisdictionTyped,
          citationCount: citations.length,
          linkedActionItemId: actionItemId,
        },
        resourceType: 'recommendations',
        resourceId: idParsed.data,
      });

      // Pull submitted_at + compute deadline for the response.
      const finalRows = (await tx.execute(sql`
        SELECT submitted_at::text AS submitted_at FROM recommendations WHERE id = ${idParsed.data}
      `)) as unknown as Array<{ submitted_at: string }>;
      const submittedAt = finalRows[0]!.submitted_at;
      const deadline = computeRecommendationDeadline(new Date(submittedAt), jurisdictionTyped);

      return {
        id: idParsed.data,
        status: 'submitted' as RecommendationStatus,
        submittedAt,
        deadline: deadline ? deadline.toISOString() : null,
        linkedActionItemId: actionItemId,
      };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RecommendationWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/:id/responses — append-only response capture
// ---------------------------------------------------------------------------

recommendationsRoute.post('/:id/responses', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = responseBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const body = parsed.data;
  const db = getDb();
  const responseId = crypto.randomUUID();

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status FROM recommendations WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string }>;
      if (locked.length === 0) {
        throw new RecommendationWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const status = locked[0]!.status as RecommendationStatus;
      if (status !== 'submitted' && status !== 'response_received') {
        throw new RecommendationWriteAborted({
          status: 422,
          body: { error: 'cannot_capture_response_in_state', status },
        });
      }

      const position = await allocateResponsePosition(tx, idParsed.data);
      // T-R42 cap. The schema CHECK is the structural backstop; the
      // route's 422 surfaces a clean error before the INSERT.
      if (position > 50) {
        throw new RecommendationWriteAborted({
          status: 422,
          body: { error: 'response_cap_exceeded', cap: 50 },
        });
      }

      const authorRoleSealed = sealRecommendationField(body.authorRole);
      const bodySealed = sealRecommendationField(body.body);

      const chainRow = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'recommendation.response_captured',
          recommendationId: idParsed.data,
          responseId,
          position,
        },
        resourceType: 'recommendation_responses',
        resourceId: responseId,
      });

      const inserted = (await tx.execute(sql`
        INSERT INTO recommendation_responses (
          id, recommendation_id, position, received_by_user_id,
          author_role_ct, author_role_dek_ct,
          body_ct, body_dek_ct, audit_idx
        )
        VALUES (
          ${responseId}, ${idParsed.data}, ${position}, ${auth.userId},
          ${Buffer.from(authorRoleSealed.ct) as unknown as Uint8Array},
          ${Buffer.from(authorRoleSealed.dekCt) as unknown as Uint8Array},
          ${Buffer.from(bodySealed.ct) as unknown as Uint8Array},
          ${Buffer.from(bodySealed.dekCt) as unknown as Uint8Array},
          ${chainRow.idx}
        )
        RETURNING received_at::text AS received_at
      `)) as unknown as Array<{ received_at: string }>;

      // Status flip submitted -> response_received only on first
      // response per ADR-0008 §3.4. Subsequent appends leave the
      // status pinned (a recommendation does not return to 'submitted'
      // because management amended).
      if (status === 'submitted') {
        await tx.execute(sql`
          UPDATE recommendations SET status = 'response_received' WHERE id = ${idParsed.data}
        `);
      }

      return {
        id: responseId,
        position,
        receivedAt: inserted[0]!.received_at,
      };
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof RecommendationWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/:id/resolve — close out
// ---------------------------------------------------------------------------

recommendationsRoute.post('/:id/resolve', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = resolveBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status FROM recommendations WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string }>;
      if (locked.length === 0) {
        throw new RecommendationWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const status = locked[0]!.status as RecommendationStatus;
      // The decision is intentional (ADR-0008 §3.1): a recommendation
      // cannot be resolved without a response captured — the response
      // is the evidentiary anchor for resolution.
      if (status !== 'response_received') {
        throw new RecommendationWriteAborted({
          status: 422,
          body: { error: 'requires_response', status },
        });
      }

      const linkRows = (await tx.execute(sql`
        SELECT action_item_id FROM recommendation_action_item_links
        WHERE recommendation_id = ${idParsed.data} AND link_kind = 'tracks'
        LIMIT 1
      `)) as unknown as Array<{ action_item_id: string }>;
      const linkedActionItemId = linkRows[0]?.action_item_id;
      if (!linkedActionItemId) {
        // A response_received recommendation MUST have a linked
        // action_item (the link is created in the submit transaction
        // and the FK is RESTRICT — orphan rows are not reachable
        // through any documented path). Defensive 500 if reached.
        throw new RecommendationWriteAborted({
          status: 500,
          body: { error: 'linked_action_item_missing' },
        });
      }

      // Move the linked action_item to completed_this_period + Closed.
      // We bypass the standard /api/action-items/:id/moves route because
      // we're already inside a transaction and need atomicity with the
      // recommendation status flip. The action_item.moved chain anchor
      // is documented inline as a deliberate omission here: the
      // recommendation.resolved anchor carries the linked action_item
      // id and is the canonical record of the move (ADR-0008 §3.5
      // describes two chain rows in one transaction; the 1.9 contract
      // sticks to one for resolve to keep the chain kind count at
      // exactly the nine S1 added).
      await tx.execute(sql`
        UPDATE action_items
        SET section = 'completed_this_period',
            status = 'Closed',
            closed_date = now()
        WHERE id = ${linkedActionItemId}
      `);

      await tx.execute(sql`
        UPDATE recommendations
        SET status = 'resolved', resolved_at = now()
        WHERE id = ${idParsed.data}
      `);

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'recommendation.resolved',
          recommendationId: idParsed.data,
          linkedActionItemId,
        },
        resourceType: 'recommendations',
        resourceId: idParsed.data,
      });

      const finalRows = (await tx.execute(sql`
        SELECT resolved_at::text AS resolved_at FROM recommendations WHERE id = ${idParsed.data}
      `)) as unknown as Array<{ resolved_at: string }>;
      return {
        id: idParsed.data,
        status: 'resolved' as RecommendationStatus,
        resolvedAt: finalRows[0]!.resolved_at,
        linkedActionItemId,
      };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RecommendationWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422 | 500);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/recommendations/:id/withdraw — side state from any non-resolved
// ---------------------------------------------------------------------------

recommendationsRoute.post('/:id/withdraw', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = withdrawBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const reason: WithdrawReason = parsed.data.reason;
  const db = getDb();

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status FROM recommendations WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string }>;
      if (locked.length === 0) {
        throw new RecommendationWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const status = locked[0]!.status as RecommendationStatus;
      if (status !== 'draft' && status !== 'submitted' && status !== 'response_received') {
        throw new RecommendationWriteAborted({
          status: 422,
          body: { error: 'cannot_withdraw_in_state', status },
        });
      }

      const linkRows = (await tx.execute(sql`
        SELECT action_item_id FROM recommendation_action_item_links
        WHERE recommendation_id = ${idParsed.data} AND link_kind = 'tracks'
        LIMIT 1
      `)) as unknown as Array<{ action_item_id: string }>;
      const linkedActionItemId = linkRows[0]?.action_item_id ?? null;

      // If the recommendation reached submit, a linked action_item
      // exists; archive it. Draft-state withdraws have no linked
      // action_item (the bridge is created only at submit per ADR-0008
      // §3.5 / T-R12 close-out).
      if (linkedActionItemId) {
        await tx.execute(sql`
          UPDATE action_items
          SET section = 'archived', status = 'Cancelled', closed_date = now()
          WHERE id = ${linkedActionItemId}
        `);
      }

      await tx.execute(sql`
        UPDATE recommendations
        SET status = 'withdrawn',
            withdrawn_at = now(),
            withdrawn_reason = ${reason}
        WHERE id = ${idParsed.data}
      `);

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'recommendation.withdrawn',
          recommendationId: idParsed.data,
          linkedActionItemId,
        },
        resourceType: 'recommendations',
        resourceId: idParsed.data,
      });

      const finalRows = (await tx.execute(sql`
        SELECT withdrawn_at::text AS withdrawn_at FROM recommendations WHERE id = ${idParsed.data}
      `)) as unknown as Array<{ withdrawn_at: string }>;
      return {
        id: idParsed.data,
        status: 'withdrawn' as RecommendationStatus,
        withdrawnAt: finalRows[0]!.withdrawn_at,
        withdrawnReason: reason,
        linkedActionItemId,
      };
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RecommendationWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422 | 500);
    }
    throw err;
  }
});
