// /api/hazards/* — create / list / detail / status-transition (ADR-0004).
//
// All routes require authMiddleware. The PATCH /status transition route
// runs the transition through the pure-function graph helper from
// @jhsc/shared-types so the rule set lives in one place and the API
// and UI agree. Step-up auth gates the destructive paths (withdrawn,
// reopen from resolved/archived) and the reporter-identity read path.
//
// Encryption boundary lives in apps/api/src/hazards/crypto.ts — this
// file never touches the KEK directly.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { append } from '@jhsc/audit';
import {
  hazardJurisdiction,
  hazardSeverity,
  hazardStatus,
  type HazardJurisdiction,
  type HazardSeverity,
  type HazardStatus,
} from '@jhsc/shared-types';
import {
  ALLOWED_TRANSITIONS,
  isAllowedTransition,
  requiresStepUp,
} from '@jhsc/shared-types/hazard-transitions';
import { getDb } from '../../db/client';
import { authMiddleware, requireStepUp } from '../../auth/step-up';
import {
  openField,
  openOptionalField,
  safeSummary,
  sealField,
  sealOptionalField,
} from '../../hazards/crypto';

export const hazardsRoute = new Hono();

hazardsRoute.use('*', authMiddleware());

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createBody = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(8000),
    severity: z.enum(hazardSeverity),
    jurisdiction: z.enum(hazardJurisdiction),
    locationZone: z.string().min(1).max(64).optional(),
    locationDetail: z.string().max(2000).optional(),
    reporterIdentity: z.string().max(200).optional(),
  })
  .strict();

const listQuery = z.object({
  status: z.enum(hazardStatus).array().optional(),
  severity: z.enum(hazardSeverity).array().optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const statusBody = z
  .object({
    toStatus: z.enum(hazardStatus),
    reason: z.string().max(2000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /api/hazards
// ---------------------------------------------------------------------------

hazardsRoute.post('/', async (c) => {
  const auth = c.get('auth');
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const db = getDb();
  const descSealed = sealField(body.description);
  const reporterSealed = sealOptionalField(body.reporterIdentity);
  const locationSealed = sealOptionalField(body.locationDetail);

  const inserted = await db.transaction(async (tx) => {
    const code = (await tx.execute(
      sql`SELECT nextval('hazards_code_seq') AS n`,
    )) as unknown as Array<{
      n: string | number;
    }>;
    const hazardCode = `H-${String(code[0]!.n).padStart(3, '0')}`;
    const rows = (await tx.execute(sql`
      INSERT INTO hazards (
        hazard_code, title, description_ct, description_dek_ct,
        reporter_identity_ct, reporter_identity_dek_ct,
        reported_by, severity, status,
        location_zone, location_detail_ct, location_detail_dek_ct,
        jurisdiction
      )
      VALUES (
        ${hazardCode}, ${body.title},
        ${Buffer.from(descSealed.ct) as unknown as Uint8Array},
        ${Buffer.from(descSealed.dekCt) as unknown as Uint8Array},
        ${reporterSealed ? (Buffer.from(reporterSealed.ct) as unknown as Uint8Array) : null},
        ${reporterSealed ? (Buffer.from(reporterSealed.dekCt) as unknown as Uint8Array) : null},
        ${auth.userId}, ${body.severity}, 'open',
        ${body.locationZone ?? null},
        ${locationSealed ? (Buffer.from(locationSealed.ct) as unknown as Uint8Array) : null},
        ${locationSealed ? (Buffer.from(locationSealed.dekCt) as unknown as Uint8Array) : null},
        ${body.jurisdiction}
      )
      RETURNING id, hazard_code, status, reported_at::text AS reported_at
    `)) as unknown as Array<{
      id: string;
      hazard_code: string;
      status: string;
      reported_at: string;
    }>;
    const row = rows[0]!;

    const chainRow = await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'hazard.created',
        hazardId: row.id,
        hazardCode: row.hazard_code,
        severity: body.severity,
        jurisdiction: body.jurisdiction,
      },
      resourceType: 'hazards',
      resourceId: row.id,
    });

    await tx.execute(sql`
      INSERT INTO hazard_status_history (hazard_id, from_status, to_status, actor_id, audit_idx)
      VALUES (${row.id}, NULL, 'open', ${auth.userId}, ${chainRow.idx})
    `);

    return row;
  });

  return c.json({
    id: inserted.id,
    hazardCode: inserted.hazard_code,
    status: inserted.status,
    reportedAt: inserted.reported_at,
  });
});

// ---------------------------------------------------------------------------
// GET /api/hazards (list)
// ---------------------------------------------------------------------------

hazardsRoute.get('/', async (c) => {
  const parsed = listQuery.safeParse({
    status: c.req.queries('status'),
    severity: c.req.queries('severity'),
    q: c.req.query('q'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const { status, severity, q, limit, offset } = parsed.data;
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, hazard_code, title, severity, status, location_zone, jurisdiction,
           reported_at::text AS reported_at,
           description_ct, description_dek_ct
    FROM hazards
    WHERE 1=1
      ${status && status.length > 0 ? sql`AND status = ANY(${status}::text[])` : sql``}
      ${severity && severity.length > 0 ? sql`AND severity = ANY(${severity}::text[])` : sql``}
      ${q ? sql`AND title ILIKE ${'%' + q + '%'}` : sql``}
    ORDER BY reported_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as Array<{
    id: string;
    hazard_code: string;
    title: string;
    severity: string;
    status: string;
    location_zone: string | null;
    jurisdiction: string;
    reported_at: string;
    description_ct: Uint8Array;
    description_dek_ct: Uint8Array;
  }>;

  // T-H1/T-H4: list never returns reporter identity; description redacted
  // to a safe summary.
  const items = rows.map((r) => {
    const decrypted = openField({ ct: r.description_ct, dekCt: r.description_dek_ct });
    return {
      id: r.id,
      hazardCode: r.hazard_code,
      title: r.title,
      summary: safeSummary(decrypted),
      severity: r.severity as HazardSeverity,
      status: r.status as HazardStatus,
      locationZone: r.location_zone,
      jurisdiction: r.jurisdiction as HazardJurisdiction,
      reportedAt: r.reported_at,
    };
  });

  return c.json({ items });
});

// ---------------------------------------------------------------------------
// GET /api/hazards/:id (detail)
// ---------------------------------------------------------------------------

const uuidParam = z.string().uuid();

hazardsRoute.get('/:id', async (c) => {
  const parsed = uuidParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_id' }, 400);
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, hazard_code, title, severity, status, location_zone, jurisdiction,
           reported_at::text AS reported_at,
           description_ct, description_dek_ct,
           location_detail_ct, location_detail_dek_ct
    FROM hazards WHERE id = ${parsed.data} LIMIT 1
  `)) as unknown as Array<{
    id: string;
    hazard_code: string;
    title: string;
    severity: string;
    status: string;
    location_zone: string | null;
    jurisdiction: string;
    reported_at: string;
    description_ct: Uint8Array;
    description_dek_ct: Uint8Array;
    location_detail_ct: Uint8Array | null;
    location_detail_dek_ct: Uint8Array | null;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;

  const history = (await db.execute(sql`
    SELECT id, from_status, to_status, occurred_at::text AS occurred_at,
           reason_ct, reason_dek_ct, audit_idx
    FROM hazard_status_history
    WHERE hazard_id = ${parsed.data}
    ORDER BY occurred_at ASC
  `)) as unknown as Array<{
    id: string;
    from_status: string | null;
    to_status: string;
    occurred_at: string;
    reason_ct: Uint8Array | null;
    reason_dek_ct: Uint8Array | null;
    audit_idx: string | number;
  }>;

  // T-H4: reporter_identity NOT returned on the unauthenticated-step-up
  // detail call. Use GET /api/hazards/:id/reporter to fetch it.
  return c.json({
    id: r.id,
    hazardCode: r.hazard_code,
    title: r.title,
    description: openField({ ct: r.description_ct, dekCt: r.description_dek_ct }),
    severity: r.severity as HazardSeverity,
    status: r.status as HazardStatus,
    locationZone: r.location_zone,
    locationDetail: openOptionalField({
      ct: r.location_detail_ct,
      dekCt: r.location_detail_dek_ct,
    }),
    jurisdiction: r.jurisdiction as HazardJurisdiction,
    reportedAt: r.reported_at,
    allowedTransitions: ALLOWED_TRANSITIONS[r.status as HazardStatus],
    history: history.map((h) => ({
      id: h.id,
      fromStatus: h.from_status,
      toStatus: h.to_status,
      occurredAt: h.occurred_at,
      reason: openOptionalField({ ct: h.reason_ct, dekCt: h.reason_dek_ct }),
      auditIdx: Number(h.audit_idx),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/hazards/:id/reporter — step-up gated (T-H4)
// ---------------------------------------------------------------------------

hazardsRoute.get(
  '/:id/reporter',
  requireStepUp({ action: 'hazard.reveal_reporter' }),
  async (c) => {
    const parsed = uuidParam.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400);
    const db = getDb();
    const rows = (await db.execute(sql`
      SELECT reporter_identity_ct, reporter_identity_dek_ct, reported_by
      FROM hazards WHERE id = ${parsed.data} LIMIT 1
    `)) as unknown as Array<{
      reporter_identity_ct: Uint8Array | null;
      reporter_identity_dek_ct: Uint8Array | null;
      reported_by: string;
    }>;
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
    const r = rows[0]!;
    return c.json({
      reportedBy: r.reported_by,
      reporterIdentity: openOptionalField({
        ct: r.reporter_identity_ct,
        dekCt: r.reporter_identity_dek_ct,
      }),
    });
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/hazards/:id/status
// ---------------------------------------------------------------------------

// Step-up runs as a separate middleware that we attach conditionally
// from inside the handler — we need to know the requested toStatus to
// know whether step-up applies. The pattern: parse the body first, then
// re-run step-up via a synthetic handler if needed.
hazardsRoute.patch('/:id/status', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = statusBody.safeParse(await c.req.json().catch(() => null));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();

  // Read the current status under a row lock so a concurrent PATCH
  // can't slip an illegal transition past us (T-H8).
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id, status, hazard_code FROM hazards WHERE id = ${idParsed.data} FOR UPDATE
    `)) as unknown as Array<{ id: string; status: string; hazard_code: string }>;
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
    const current = rows[0]!;
    const from = current.status as HazardStatus;
    const to = bodyParsed.data.toStatus;

    if (!isAllowedTransition(from, to)) {
      return c.json(
        {
          error: 'illegal_transition',
          from,
          to,
          allowed: ALLOWED_TRANSITIONS[from],
        },
        422,
      );
    }

    // T-H3 / T-H4: gate destructive + reopen transitions on step-up.
    if (requiresStepUp(from, to)) {
      const now = Date.now();
      const stepUpUntilMs = auth.stepUpUntil?.getTime() ?? 0;
      if (stepUpUntilMs < now) {
        c.header('WWW-Authenticate', `StepUp realm="jhsc", action="hazard.status_change.${to}"`);
        return c.json({ error: 'step_up_required', action: `hazard.status_change.${to}` }, 401);
      }
    }

    const reasonSealed = sealOptionalField(bodyParsed.data.reason);

    // Emit chain row first so the FK on hazard_status_history.audit_idx
    // is satisfied at insert time.
    const chainRow = await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'hazard.status_changed',
        hazardId: current.id,
        hazardCode: current.hazard_code,
        fromStatus: from,
        toStatus: to,
      },
      resourceType: 'hazards',
      resourceId: current.id,
    });

    await tx.execute(sql`
      INSERT INTO hazard_status_history (hazard_id, from_status, to_status, actor_id, reason_ct, reason_dek_ct, audit_idx)
      VALUES (
        ${current.id}, ${from}, ${to}, ${auth.userId},
        ${reasonSealed ? (Buffer.from(reasonSealed.ct) as unknown as Uint8Array) : null},
        ${reasonSealed ? (Buffer.from(reasonSealed.dekCt) as unknown as Uint8Array) : null},
        ${chainRow.idx}
      )
    `);

    // Update the hazard row + lifecycle timestamp columns.
    const timestampColumn =
      to === 'assessing'
        ? 'assessed_at'
        : to === 'resolved'
          ? 'resolved_at'
          : to === 'archived'
            ? 'archived_at'
            : null;
    if (timestampColumn) {
      await tx.execute(
        sql`UPDATE hazards SET status = ${to}, ${sql.raw(timestampColumn)} = now() WHERE id = ${current.id}`,
      );
    } else {
      await tx.execute(sql`UPDATE hazards SET status = ${to} WHERE id = ${current.id}`);
    }

    return c.json({
      id: current.id,
      hazardCode: current.hazard_code,
      status: to,
      allowedTransitions: ALLOWED_TRANSITIONS[to],
    });
  });
});
