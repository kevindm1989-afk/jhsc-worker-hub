// /api/action-items/* — six routes per ADR-0005.
//
//   POST   /                       — create. Emits action_item.created.
//   GET    /                       — list with filters + safe summaries.
//   GET    /:id                    — full detail + decrypted fields + history.
//   PATCH  /:id                    — update non-section fields. Emits
//                                    action_item.updated with a
//                                    changedFields allow-list (no PI).
//   POST   /:id/moves              — section move. Emits action_item.moved.
//                                    Step-up gated for →archived and
//                                    the two re-open paths.
//   POST   /:id/moves/:moveId/undo — undo a prior move. Step-up gated.
//                                    Sets the original row's undone=true
//                                    and writes a reverting move row.
//
// Encryption boundary in apps/api/src/action-items/crypto.ts. Section
// graph + step-up matrix in @jhsc/shared-types/action-item-transitions.
// Action Flag computed server-side in @jhsc/shared-types/action-item-flag
// and projected into list + detail.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { append } from '@jhsc/audit';
import {
  actionItemRisk,
  actionItemSection,
  actionItemSourceType,
  actionItemStatus,
  actionItemType,
  actionItemUpdateField,
  type ActionItemRisk,
  type ActionItemSection,
  type ActionItemStatus,
  type ActionItemType,
  type ActionItemUpdateField,
} from '@jhsc/shared-types';
import {
  ACTION_ITEM_ALLOWED_TRANSITIONS,
  actionItemTransitionRequiresStepUp,
  isAllowedActionItemTransition,
} from '@jhsc/shared-types/action-item-transitions';
import { computeActionFlag, type ActionFlag } from '@jhsc/shared-types/action-item-flag';
import { getDb } from '../../db/client';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import {
  openField,
  openOptionalField,
  safeSummary,
  sealField,
  sealOptionalField,
} from '../../action-items/crypto';
import { rateLimit } from '../../middleware/rate-limit';

export const actionItemsRoute = new Hono();

actionItemsRoute.use('*', authMiddleware());
actionItemsRoute.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);
actionItemsRoute.use('*', rateLimit({ name: 'action-items', capacity: 60, refillPerSecond: 10 }));

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const createBody = z
  .object({
    type: z.enum(actionItemType),
    typeSubtype: z.string().min(1).max(64).optional(),
    description: z.string().min(1).max(8000),
    recommendedAction: z.string().max(8000).optional(),
    raisedBy: z.string().max(200).optional(),
    raisedByUserId: z.string().uuid().optional(),
    followUpOwner: z.string().max(200).optional(),
    followUpOwnerUserId: z.string().uuid().optional(),
    department: z.string().max(120).optional(),
    status: z.enum(actionItemStatus),
    risk: z.enum(actionItemRisk),
    section: z.enum(actionItemSection),
    startDate: isoDate,
    targetDate: isoDate.optional(),
    sourceType: z.enum(actionItemSourceType).optional(),
    sourceId: z.string().uuid().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  })
  .strict()
  .refine((b) => b.type !== 'OTHER' || !!b.typeSubtype, {
    message: "type='OTHER' requires typeSubtype",
    path: ['typeSubtype'],
  })
  .refine(
    (b) =>
      // sourceId must be set iff sourceType is one of the FK-validated kinds.
      !b.sourceType || b.sourceType === 'manual' || b.sourceType === 'excel_import' || !!b.sourceId,
    { message: 'sourceId required for this sourceType', path: ['sourceId'] },
  );

const listQuery = z.object({
  section: z.enum(actionItemSection).array().optional(),
  status: z.enum(actionItemStatus).array().optional(),
  risk: z.enum(actionItemRisk).array().optional(),
  type: z.enum(actionItemType).array().optional(),
  q: z.string().max(120).optional(),
  meetingId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const patchBody = z
  .object({
    description: z.string().min(1).max(8000).optional(),
    recommendedAction: z.string().max(8000).nullable().optional(),
    status: z.enum(actionItemStatus).optional(),
    risk: z.enum(actionItemRisk).optional(),
    targetDate: isoDate.nullable().optional(),
    closedDate: isoDate.nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    department: z.string().max(120).nullable().optional(),
    typeSubtype: z.string().max(64).nullable().optional(),
    followUpOwner: z.string().max(200).nullable().optional(),
    followUpOwnerUserId: z.string().uuid().nullable().optional(),
  })
  .strict();

const moveBody = z
  .object({
    toSection: z.enum(actionItemSection),
    reason: z.string().max(2000).optional(),
    meetingId: z.string().uuid().optional(),
  })
  .strict();

const uuidParam = z.string().uuid();

// ---------------------------------------------------------------------------
// POST /api/action-items — create
// ---------------------------------------------------------------------------

actionItemsRoute.post('/', async (c) => {
  const auth = c.get('auth');
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const db = getDb();

  const descSealed = sealField(body.description);
  const recommendedSealed = sealOptionalField(body.recommendedAction);
  const raisedBySealed = sealOptionalField(body.raisedBy);
  const followUpSealed = sealOptionalField(body.followUpOwner);

  const created = await db.transaction(async (tx) => {
    // T-AI5: allocate per-section sequence_number under a section lock.
    // pg_advisory_xact_lock keyed on a hash of the section text — cheap
    // and bounded to the section, so different sections don't contend.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('action_items.seq.' || ${body.section}))`,
    );
    const seq = (await tx.execute(sql`
      SELECT COALESCE(MAX(sequence_number), 0) + 1 AS n
      FROM action_items
      WHERE section = ${body.section}
    `)) as unknown as Array<{ n: number | string }>;
    const sequenceNumber = Number(seq[0]!.n);

    const inserted = (await tx.execute(sql`
      INSERT INTO action_items (
        sequence_number, type, type_subtype,
        description_ct, description_dek_ct,
        recommended_action_ct, recommended_action_dek_ct,
        raised_by_ct, raised_by_dek_ct, raised_by_user_id,
        follow_up_owner_ct, follow_up_owner_dek_ct, follow_up_owner_user_id,
        department, status, risk, section,
        start_date, target_date,
        source_type, source_id, tags
      )
      VALUES (
        ${sequenceNumber}, ${body.type}, ${body.typeSubtype ?? null},
        ${Buffer.from(descSealed.ct) as unknown as Uint8Array},
        ${Buffer.from(descSealed.dekCt) as unknown as Uint8Array},
        ${recommendedSealed ? (Buffer.from(recommendedSealed.ct) as unknown as Uint8Array) : null},
        ${recommendedSealed ? (Buffer.from(recommendedSealed.dekCt) as unknown as Uint8Array) : null},
        ${raisedBySealed ? (Buffer.from(raisedBySealed.ct) as unknown as Uint8Array) : null},
        ${raisedBySealed ? (Buffer.from(raisedBySealed.dekCt) as unknown as Uint8Array) : null},
        ${body.raisedByUserId ?? null},
        ${followUpSealed ? (Buffer.from(followUpSealed.ct) as unknown as Uint8Array) : null},
        ${followUpSealed ? (Buffer.from(followUpSealed.dekCt) as unknown as Uint8Array) : null},
        ${body.followUpOwnerUserId ?? null},
        ${body.department ?? null}, ${body.status}, ${body.risk}, ${body.section},
        ${body.startDate}, ${body.targetDate ?? null},
        ${body.sourceType ?? 'manual'}, ${body.sourceId ?? null},
        ${body.tags ?? []}::text[]
      )
      RETURNING id, sequence_number, status, section, start_date::text AS start_date, created_at
    `)) as unknown as Array<{
      id: string;
      sequence_number: number;
      status: string;
      section: string;
      start_date: string;
      created_at: Date;
    }>;
    const row = inserted[0]!;

    const chainRow = await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'action_item.created',
        itemId: row.id,
        itemType: body.type,
        section: body.section,
        risk: body.risk,
      },
      resourceType: 'action_items',
      resourceId: row.id,
    });

    await tx.execute(sql`
      INSERT INTO action_item_moves (
        action_item_id, moved_by_user_id, from_section, to_section, audit_idx
      )
      VALUES (${row.id}, ${auth.userId}, NULL, ${body.section}, ${chainRow.idx})
    `);

    return row;
  });

  return c.json({
    id: created.id,
    sequenceNumber: created.sequence_number,
    status: created.status as ActionItemStatus,
    section: created.section as ActionItemSection,
    startDate: created.start_date,
  });
});

// ---------------------------------------------------------------------------
// GET /api/action-items — list
// ---------------------------------------------------------------------------

actionItemsRoute.get('/', async (c) => {
  const parsed = listQuery.safeParse({
    section: c.req.queries('section'),
    status: c.req.queries('status'),
    risk: c.req.queries('risk'),
    type: c.req.queries('type'),
    q: c.req.query('q'),
    meetingId: c.req.query('meetingId'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const { section, status, risk, type, q, meetingId, limit, offset } = parsed.data;
  // sec-F6 (1.5) shape: escape LIKE metachars.
  const escapedQ = q ? q.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`) : null;
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await db.execute(sql`
    SELECT id, sequence_number, type, type_subtype,
           description_ct, description_dek_ct,
           status, risk, section,
           start_date::text AS start_date,
           target_date::text AS target_date,
           closed_date::text AS closed_date,
           source_type, source_id, meeting_id, tags
    FROM action_items
    WHERE 1=1
      ${section && section.length > 0 ? sql`AND section = ANY(${section}::text[])` : sql``}
      ${status && status.length > 0 ? sql`AND status = ANY(${status}::text[])` : sql``}
      ${risk && risk.length > 0 ? sql`AND risk = ANY(${risk}::text[])` : sql``}
      ${type && type.length > 0 ? sql`AND type = ANY(${type}::text[])` : sql``}
      ${meetingId ? sql`AND meeting_id = ${meetingId}` : sql``}
    ORDER BY section, sequence_number DESC
    LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as Array<{
    id: string;
    sequence_number: number;
    type: string;
    type_subtype: string | null;
    description_ct: Uint8Array;
    description_dek_ct: Uint8Array;
    status: string;
    risk: string;
    section: string;
    start_date: string;
    target_date: string | null;
    closed_date: string | null;
    source_type: string | null;
    source_id: string | null;
    meeting_id: string | null;
    tags: string[];
  }>;

  // Decrypt + safeSummary per-row with try/catch fallback (sec-F5 1.5
  // pattern). Build the Action Flag server-side so the client never
  // re-computes day boundaries.
  let items = rows.map((r) => {
    let summary: string;
    try {
      summary = safeSummary(openField({ ct: r.description_ct, dekCt: r.description_dek_ct }));
    } catch {
      summary = '[unreadable — open the detail view for diagnostics]';
    }
    const flag: ActionFlag | null = computeActionFlag({
      section: r.section as ActionItemSection,
      status: r.status as ActionItemStatus,
      startDate: r.start_date,
      closedDate: r.closed_date,
      today,
    });
    return {
      id: r.id,
      sequenceNumber: r.sequence_number,
      type: r.type as ActionItemType,
      typeSubtype: r.type_subtype,
      summary,
      status: r.status as ActionItemStatus,
      risk: r.risk as ActionItemRisk,
      section: r.section as ActionItemSection,
      startDate: r.start_date,
      targetDate: r.target_date,
      closedDate: r.closed_date,
      sourceType: r.source_type,
      sourceId: r.source_id,
      meetingId: r.meeting_id,
      tags: r.tags,
      flag,
    };
  });
  // q is applied after decrypt because description is encrypted at rest
  // (FTS would index ciphertext otherwise). This is fine for the
  // single-tenant scope; the rate-limit + body-limit + page-size cap
  // bound the worst case.
  if (escapedQ) {
    const needle = q!.toLowerCase();
    items = items.filter((i) => i.summary.toLowerCase().includes(needle));
  }
  return c.json({ items });
});

// ---------------------------------------------------------------------------
// GET /api/action-items/:id — detail
// ---------------------------------------------------------------------------

actionItemsRoute.get('/:id', async (c) => {
  const parsed = uuidParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_id' }, 400);
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, sequence_number, type, type_subtype,
           description_ct, description_dek_ct,
           recommended_action_ct, recommended_action_dek_ct,
           raised_by_ct, raised_by_dek_ct, raised_by_user_id,
           follow_up_owner_ct, follow_up_owner_dek_ct, follow_up_owner_user_id,
           department, status, risk, section,
           start_date::text AS start_date,
           target_date::text AS target_date,
           closed_date::text AS closed_date,
           verified_by_jhsc_id, meeting_id, source_type, source_id, tags,
           created_at, updated_at
    FROM action_items WHERE id = ${parsed.data} LIMIT 1
  `)) as unknown as Array<{
    id: string;
    sequence_number: number;
    type: string;
    type_subtype: string | null;
    description_ct: Uint8Array;
    description_dek_ct: Uint8Array;
    recommended_action_ct: Uint8Array | null;
    recommended_action_dek_ct: Uint8Array | null;
    raised_by_ct: Uint8Array | null;
    raised_by_dek_ct: Uint8Array | null;
    raised_by_user_id: string | null;
    follow_up_owner_ct: Uint8Array | null;
    follow_up_owner_dek_ct: Uint8Array | null;
    follow_up_owner_user_id: string | null;
    department: string | null;
    status: string;
    risk: string;
    section: string;
    start_date: string;
    target_date: string | null;
    closed_date: string | null;
    verified_by_jhsc_id: string | null;
    meeting_id: string | null;
    source_type: string | null;
    source_id: string | null;
    tags: string[];
    created_at: Date;
    updated_at: Date;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = rows[0]!;

  const history = (await db.execute(sql`
    SELECT id, from_section, to_section, moved_by_user_id,
           moved_at::text AS moved_at,
           reason_ct, reason_dek_ct, meeting_id, audit_idx, undone
    FROM action_item_moves
    WHERE action_item_id = ${parsed.data}
    ORDER BY moved_at ASC
  `)) as unknown as Array<{
    id: string;
    from_section: string | null;
    to_section: string;
    moved_by_user_id: string;
    moved_at: string;
    reason_ct: Uint8Array | null;
    reason_dek_ct: Uint8Array | null;
    meeting_id: string | null;
    audit_idx: string | number;
    undone: boolean;
  }>;

  const today = new Date().toISOString().slice(0, 10);
  const flag = computeActionFlag({
    section: r.section as ActionItemSection,
    status: r.status as ActionItemStatus,
    startDate: r.start_date,
    closedDate: r.closed_date,
    today,
  });

  return c.json({
    id: r.id,
    sequenceNumber: r.sequence_number,
    type: r.type as ActionItemType,
    typeSubtype: r.type_subtype,
    description: openField({ ct: r.description_ct, dekCt: r.description_dek_ct }),
    recommendedAction: openOptionalField({
      ct: r.recommended_action_ct,
      dekCt: r.recommended_action_dek_ct,
    }),
    raisedBy: openOptionalField({ ct: r.raised_by_ct, dekCt: r.raised_by_dek_ct }),
    raisedByUserId: r.raised_by_user_id,
    followUpOwner: openOptionalField({
      ct: r.follow_up_owner_ct,
      dekCt: r.follow_up_owner_dek_ct,
    }),
    followUpOwnerUserId: r.follow_up_owner_user_id,
    department: r.department,
    status: r.status as ActionItemStatus,
    risk: r.risk as ActionItemRisk,
    section: r.section as ActionItemSection,
    startDate: r.start_date,
    targetDate: r.target_date,
    closedDate: r.closed_date,
    verifiedByJhscId: r.verified_by_jhsc_id,
    meetingId: r.meeting_id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    tags: r.tags,
    flag,
    allowedTransitions: ACTION_ITEM_ALLOWED_TRANSITIONS[r.section as ActionItemSection],
    history: history.map((h) => ({
      id: h.id,
      fromSection: h.from_section as ActionItemSection | null,
      toSection: h.to_section as ActionItemSection,
      movedByUserId: h.moved_by_user_id,
      movedAt: h.moved_at,
      reason: openOptionalField({ ct: h.reason_ct, dekCt: h.reason_dek_ct }),
      meetingId: h.meeting_id,
      auditIdx: Number(h.audit_idx),
      undone: h.undone,
    })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/action-items/:id — non-section update
// ---------------------------------------------------------------------------

actionItemsRoute.patch('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const body = bodyParsed.data;
  const db = getDb();

  // Build the changed-fields allow-list for the audit payload (T-AI6:
  // names only, never values).
  const changedFields: ActionItemUpdateField[] = [];
  const map: Array<[keyof typeof body, ActionItemUpdateField]> = [
    ['status', 'status'],
    ['risk', 'risk'],
    ['description', 'description'],
    ['recommendedAction', 'recommended_action'],
    ['targetDate', 'target_date'],
    ['tags', 'tags'],
    ['followUpOwner', 'follow_up_owner'],
    ['followUpOwnerUserId', 'follow_up_owner'],
    ['department', 'department'],
    ['typeSubtype', 'type_subtype'],
  ];
  for (const [k, f] of map) {
    if (body[k] !== undefined && !changedFields.includes(f)) changedFields.push(f);
  }
  if (changedFields.length === 0) {
    return c.json({ error: 'no_changes' }, 400);
  }
  // Each field name in changedFields must be in the allow-list.
  for (const f of changedFields) {
    if (!actionItemUpdateField.includes(f)) {
      return c.json({ error: 'invalid_change_field', field: f }, 400);
    }
  }

  const descSealed = body.description !== undefined ? sealField(body.description) : null;
  const recommendedSealed =
    body.recommendedAction !== undefined
      ? body.recommendedAction === null
        ? null
        : sealField(body.recommendedAction)
      : undefined;
  const followUpSealed =
    body.followUpOwner !== undefined
      ? body.followUpOwner === null
        ? null
        : sealField(body.followUpOwner)
      : undefined;

  await db
    .transaction(async (tx) => {
      const peek = (await tx.execute(sql`
      SELECT id FROM action_items WHERE id = ${idParsed.data} FOR UPDATE
    `)) as unknown as Array<{ id: string }>;
      if (peek.length === 0) {
        throw new ActionItemWriteAborted({ status: 404, body: { error: 'not_found' } });
      }

      // Build the UPDATE in pieces so we only touch the columns the rep
      // actually changed. sql.join keeps each SET pair parameter-bound.
      const setParts = [];
      if (body.status !== undefined) setParts.push(sql`status = ${body.status}`);
      if (body.risk !== undefined) setParts.push(sql`risk = ${body.risk}`);
      if (descSealed) {
        setParts.push(sql`description_ct = ${Buffer.from(descSealed.ct) as unknown as Uint8Array}`);
        setParts.push(
          sql`description_dek_ct = ${Buffer.from(descSealed.dekCt) as unknown as Uint8Array}`,
        );
      }
      if (recommendedSealed === null) {
        setParts.push(sql`recommended_action_ct = NULL`);
        setParts.push(sql`recommended_action_dek_ct = NULL`);
      } else if (recommendedSealed) {
        setParts.push(
          sql`recommended_action_ct = ${Buffer.from(recommendedSealed.ct) as unknown as Uint8Array}`,
        );
        setParts.push(
          sql`recommended_action_dek_ct = ${Buffer.from(recommendedSealed.dekCt) as unknown as Uint8Array}`,
        );
      }
      if (body.targetDate !== undefined) {
        setParts.push(sql`target_date = ${body.targetDate}`);
      }
      if (body.closedDate !== undefined) {
        setParts.push(sql`closed_date = ${body.closedDate}`);
      }
      if (body.tags !== undefined) {
        setParts.push(sql`tags = ${body.tags}::text[]`);
      }
      if (body.department !== undefined) {
        setParts.push(sql`department = ${body.department}`);
      }
      if (body.typeSubtype !== undefined) {
        setParts.push(sql`type_subtype = ${body.typeSubtype}`);
      }
      if (followUpSealed === null) {
        setParts.push(sql`follow_up_owner_ct = NULL`);
        setParts.push(sql`follow_up_owner_dek_ct = NULL`);
      } else if (followUpSealed) {
        setParts.push(
          sql`follow_up_owner_ct = ${Buffer.from(followUpSealed.ct) as unknown as Uint8Array}`,
        );
        setParts.push(
          sql`follow_up_owner_dek_ct = ${Buffer.from(followUpSealed.dekCt) as unknown as Uint8Array}`,
        );
      }
      if (body.followUpOwnerUserId !== undefined) {
        setParts.push(sql`follow_up_owner_user_id = ${body.followUpOwnerUserId}`);
      }
      await tx.execute(sql`
      UPDATE action_items SET ${sql.join(setParts, sql`, `)} WHERE id = ${idParsed.data}
    `);

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'action_item.updated',
          itemId: idParsed.data,
          changedFields,
        },
        resourceType: 'action_items',
        resourceId: idParsed.data,
      });
    })
    .catch((err: unknown) => {
      if (err instanceof ActionItemWriteAborted) throw err;
      throw err;
    });

  return c.json({ id: idParsed.data, changedFields });
});

// ---------------------------------------------------------------------------
// POST /api/action-items/:id/moves — section move
// ---------------------------------------------------------------------------

actionItemsRoute.post('/:id/moves', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const bodyParsed = moveBody.safeParse(await c.req.json().catch(() => null));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();

  // Pre-tx peek to surface 404 + transition + step-up checks outside
  // the FOR UPDATE block (sec-F2 1.5 shape).
  const peek = (await db.execute(sql`
    SELECT id, section FROM action_items WHERE id = ${idParsed.data} LIMIT 1
  `)) as unknown as Array<{ id: string; section: string }>;
  if (peek.length === 0) return c.json({ error: 'not_found' }, 404);
  const candidateFrom = peek[0]!.section as ActionItemSection;
  const to = bodyParsed.data.toSection;

  if (!isAllowedActionItemTransition(candidateFrom, to)) {
    return c.json(
      {
        error: 'illegal_transition',
        from: candidateFrom,
        to,
        allowed: ACTION_ITEM_ALLOWED_TRANSITIONS[candidateFrom],
      },
      422,
    );
  }

  if (actionItemTransitionRequiresStepUp(candidateFrom, to)) {
    const challenge = checkStepUpFreshness(auth, {
      action: `action_item.move.${to}`,
      maxAgeSeconds: 60,
    });
    if (challenge) {
      c.header(
        'WWW-Authenticate',
        `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
      );
      return c.json({ error: 'step_up_required', action: challenge.action }, 401);
    }
  }

  const reasonSealed = sealOptionalField(bodyParsed.data.reason);

  try {
    await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, section FROM action_items WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; section: string }>;
      if (locked.length === 0) {
        throw new ActionItemWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const from = locked[0]!.section as ActionItemSection;
      if (from !== candidateFrom && !isAllowedActionItemTransition(from, to)) {
        throw new ActionItemWriteAborted({
          status: 422,
          body: {
            error: 'illegal_transition',
            from,
            to,
            allowed: ACTION_ITEM_ALLOWED_TRANSITIONS[from],
          },
        });
      }
      const chainRow = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'action_item.moved',
          itemId: idParsed.data,
          fromSection: from,
          toSection: to,
        },
        resourceType: 'action_items',
        resourceId: idParsed.data,
      });
      await tx.execute(sql`
        INSERT INTO action_item_moves (
          action_item_id, moved_by_user_id, from_section, to_section,
          reason_ct, reason_dek_ct, meeting_id, audit_idx
        )
        VALUES (
          ${idParsed.data}, ${auth.userId}, ${from}, ${to},
          ${reasonSealed ? (Buffer.from(reasonSealed.ct) as unknown as Uint8Array) : null},
          ${reasonSealed ? (Buffer.from(reasonSealed.dekCt) as unknown as Uint8Array) : null},
          ${bodyParsed.data.meetingId ?? null},
          ${chainRow.idx}
        )
      `);
      await tx.execute(sql`UPDATE action_items SET section = ${to} WHERE id = ${idParsed.data}`);
    });
  } catch (err) {
    if (err instanceof ActionItemWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
  return c.json({
    id: idParsed.data,
    section: to,
    allowedTransitions: ACTION_ITEM_ALLOWED_TRANSITIONS[to],
  });
});

// ---------------------------------------------------------------------------
// POST /api/action-items/:id/moves/:moveId/undo — undo a move
// ---------------------------------------------------------------------------

actionItemsRoute.post('/:id/moves/:moveId/undo', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  const moveParsed = uuidParam.safeParse(c.req.param('moveId'));
  if (!idParsed.success || !moveParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const auth = c.get('auth');

  // Move undo is always destructive (it writes a reverting move and
  // marks the original undone). Always step-up gated, 60-second floor.
  const challenge = checkStepUpFreshness(auth, {
    action: 'action_item.move.undo',
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
  try {
    const result = await db.transaction(async (tx) => {
      const move = (await tx.execute(sql`
        SELECT id, action_item_id, from_section, to_section, undone
        FROM action_item_moves
        WHERE id = ${moveParsed.data} AND action_item_id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        action_item_id: string;
        from_section: string | null;
        to_section: string;
        undone: boolean;
      }>;
      if (move.length === 0) {
        throw new ActionItemWriteAborted({ status: 404, body: { error: 'move_not_found' } });
      }
      const m = move[0]!;
      if (m.undone) {
        throw new ActionItemWriteAborted({
          status: 422,
          body: { error: 'already_undone' },
        });
      }
      if (m.from_section === null) {
        // The bootstrap move on create has no from; you can't undo it
        // because there's no section to revert to.
        throw new ActionItemWriteAborted({
          status: 422,
          body: { error: 'cannot_undo_create_bootstrap' },
        });
      }
      // The undo must be a legal transition from the current section to
      // the from of the original move.
      const current = (await tx.execute(sql`
        SELECT section FROM action_items WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ section: string }>;
      const from = current[0]!.section as ActionItemSection;
      const revertTo = m.from_section as ActionItemSection;
      if (!isAllowedActionItemTransition(from, revertTo)) {
        throw new ActionItemWriteAborted({
          status: 422,
          body: {
            error: 'undo_blocked_by_graph',
            from,
            to: revertTo,
            allowed: ACTION_ITEM_ALLOWED_TRANSITIONS[from],
          },
        });
      }
      // Mark the original move undone.
      await tx.execute(sql`
        UPDATE action_item_moves SET undone = true WHERE id = ${moveParsed.data}
      `);
      // Emit the chain anchor + write the reverting move row.
      const chainRow = await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'action_item.move_undone',
          itemId: idParsed.data,
          movedItemId: m.id,
          revertedFromSection: from,
          revertedToSection: revertTo,
        },
        resourceType: 'action_items',
        resourceId: idParsed.data,
      });
      const insertedRevert = (await tx.execute(sql`
        INSERT INTO action_item_moves (
          action_item_id, moved_by_user_id, from_section, to_section, audit_idx, undone
        )
        VALUES (${idParsed.data}, ${auth.userId}, ${from}, ${revertTo}, ${chainRow.idx}, false)
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        UPDATE action_items SET section = ${revertTo} WHERE id = ${idParsed.data}
      `);
      return { revertMoveId: insertedRevert[0]!.id, newSection: revertTo };
    });
    return c.json({
      id: idParsed.data,
      section: result.newSection,
      revertMoveId: result.revertMoveId,
    });
  } catch (err) {
    if (err instanceof ActionItemWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
});

// Sentinel exception for transaction rollback paths (sec-F2 1.5 shape).
class ActionItemWriteAborted extends Error {
  readonly payload: { status: number; body: Record<string, unknown> };
  constructor(payload: { status: number; body: Record<string, unknown> }) {
    super(`action_item_write_aborted: ${payload.status}`);
    this.name = 'ActionItemWriteAborted';
    this.payload = payload;
  }
}
