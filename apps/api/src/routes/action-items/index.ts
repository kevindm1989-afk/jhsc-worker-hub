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

import { sql, type SQL } from 'drizzle-orm';
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
import { idempotencyKey } from '../../middleware/idempotency';
import { readIfMatchOr428, versionConflictBody } from '../../middleware/if-match';
import { rateLimit } from '../../middleware/rate-limit';
import { computeChainEntryHash, writeLiveActionItemSnapshot } from '../meetings';
import { actionItemClosureRoute } from './close-verification';

export const actionItemsRoute = new Hono();

// M2.2 S2: mount the closure-verification + reopen routes BEFORE the
// generic action-items route handlers below. The sub-router carries
// its own auth + idempotency + rate-limit stack so the close-
// verification route's step-up + Tigris HEAD verification chain is
// fully wrapped.
actionItemsRoute.route('/', actionItemClosureRoute);

actionItemsRoute.use('*', authMiddleware());
// 1.10 (ADR-0009 §3.4): idempotencyKey AFTER auth, BEFORE rate-limit.
actionItemsRoute.use('*', idempotencyKey());
// sec-review F4 1.6: rateLimit runs BEFORE bodyLimit so an authenticated
// rep spamming >64KB POSTs still drains the bucket. bodyLimit returns
// onError without calling next(), so putting it first would let an
// attacker pin bandwidth at near-zero CPU cost without ever burning a
// token. The 413 still fires after the bucket check.
actionItemsRoute.use('*', rateLimit({ name: 'action-items', capacity: 60, refillPerSecond: 10 }));
actionItemsRoute.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const createBody = z
  .object({
    // 1.10 (ADR-0009 §3.3): optional client-generated UUID v4.
    clientId: z.string().uuid().optional(),
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
    // 2.1 (ADR-0012 §3.2): meeting provenance. firstRaisedMeetingId is
    // immutable (set-on-create only); meetingId is mutable operational
    // context that drives `live` snapshot writes on PATCH.
    firstRaisedMeetingId: z.string().uuid().optional(),
    meetingId: z.string().uuid().optional(),
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
  )
  .refine(
    (b) =>
      // sec-review F7 / priv-AI-F3 1.6 + 1.8 sec-F2 + T-R14 1.9
      // close-out: SECURITY.md T-AI8 promises route-level FK validation
      // for hazard / recommendation / inspection / incident. Only
      // hazard (1.5) is allowed via this generic route. Inspection-
      // derived action items must go through the dedicated
      // `POST /api/inspections/findings/:id/promote` handler (sec-F2
      // / T-I36 close-out): that handler is the single source of truth
      // for the #15 X/G fail-closed gate AND the T-I16 one-shot
      // promote invariant. Recommendation-derived action items must
      // go through the dedicated
      // `POST /api/recommendations/:id/submit` handler (T-R14 1.9
      // close-out): that handler is the single source of truth for
      // the citation Zod gate + the T-R13 one-shot submit invariant
      // (UNIQUE action_item_id on recommendation_action_item_links).
      // Accepting `sourceType='inspection'` OR
      // `sourceType='recommendation'` here would let a hand-crafted
      // POST bypass those gates. Incident remains rejected at the
      // route until its owning milestone.
      !b.sourceType ||
      b.sourceType === 'manual' ||
      b.sourceType === 'hazard' ||
      b.sourceType === 'excel_import',
    (b) => ({
      // sec-F2 + T-R14 close-out: give a hand-crafted caller a clear
      // redirect to the dedicated route instead of the generic 'not
      // yet supported' line. Other unsupported source_types (incident)
      // still get the generic message.
      message:
        b.sourceType === 'inspection'
          ? 'inspection_source_requires_promote_route'
          : b.sourceType === 'recommendation'
            ? 'recommendation_source_requires_submit_route'
            : 'sourceType not yet supported -- incident lands in its owning milestone',
      path: ['sourceType'],
    }),
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
    // 2.1 (ADR-0012 §3.2 Layer 2): mutable meetingId. When set and the
    // meeting is in_progress, PATCH triggers a `live`
    // meeting_action_item_state snapshot row alongside the column write.
    // firstRaisedMeetingId is intentionally NOT here — provenance is
    // immutable post-create.
    meetingId: z.string().uuid().nullable().optional(),
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

  // 1.10 (ADR-0009 §3.3): ratchet-level idempotency. Action items
  // don't have a `reported_by`-equivalent column (the rep is on the
  // bootstrap action_item_moves row's `moved_by_user_id`). Use that
  // to scope the "same actor" check: a rep replaying their own
  // clientId returns the existing row at 200; a different actor
  // returns 409 client_id_conflict.
  if (body.clientId) {
    const existing = (await db.execute(sql`
      SELECT ai.id, ai.sequence_number, ai.status, ai.section,
             ai.start_date::text AS start_date,
             ai.version,
             m.moved_by_user_id AS created_by_user_id
      FROM action_items ai
      LEFT JOIN action_item_moves m
        ON m.action_item_id = ai.id AND m.from_section IS NULL
      WHERE ai.id = ${body.clientId}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      sequence_number: number;
      status: string;
      section: string;
      start_date: string;
      version: number;
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
          sequenceNumber: row.sequence_number,
          status: row.status as ActionItemStatus,
          section: row.section as ActionItemSection,
          startDate: row.start_date,
          // sec-F7 close-out (T-S55): version on the clientId-reuse
          // path so the typed-client's _server_version is correct
          // for the next PATCH's If-Match.
          version: row.version,
        },
        200,
      );
    }
  }

  const descSealed = sealField(body.description);
  const recommendedSealed = sealOptionalField(body.recommendedAction);
  const raisedBySealed = sealOptionalField(body.raisedBy);
  const followUpSealed = sealOptionalField(body.followUpOwner);

  const created = await db.transaction(async (tx) => {
    const sequenceNumber = await allocateSequenceNumber(tx, body.section);

    const inserted = body.clientId
      ? ((await tx.execute(sql`
          INSERT INTO action_items (
            id, sequence_number, type, type_subtype,
            description_ct, description_dek_ct,
            recommended_action_ct, recommended_action_dek_ct,
            raised_by_ct, raised_by_dek_ct, raised_by_user_id,
            follow_up_owner_ct, follow_up_owner_dek_ct, follow_up_owner_user_id,
            department, status, risk, section,
            start_date, target_date,
            source_type, source_id, tags,
            first_raised_meeting_id, meeting_id
          )
          VALUES (
            ${body.clientId}, ${sequenceNumber}, ${body.type}, ${body.typeSubtype ?? null},
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
            ${body.tags ?? []}::text[],
            ${body.firstRaisedMeetingId ?? null}, ${body.meetingId ?? null}
          )
          RETURNING id, sequence_number, status, section, start_date::text AS start_date, created_at
        `)) as unknown as Array<{
          id: string;
          sequence_number: number;
          status: string;
          section: string;
          start_date: string;
          created_at: Date;
        }>)
      : ((await tx.execute(sql`
          INSERT INTO action_items (
            sequence_number, type, type_subtype,
            description_ct, description_dek_ct,
            recommended_action_ct, recommended_action_dek_ct,
            raised_by_ct, raised_by_dek_ct, raised_by_user_id,
            follow_up_owner_ct, follow_up_owner_dek_ct, follow_up_owner_user_id,
            department, status, risk, section,
            start_date, target_date,
            source_type, source_id, tags,
            first_raised_meeting_id, meeting_id
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
            ${body.tags ?? []}::text[],
            ${body.firstRaisedMeetingId ?? null}, ${body.meetingId ?? null}
          )
          RETURNING id, sequence_number, status, section, start_date::text AS start_date, created_at
        `)) as unknown as Array<{
          id: string;
          sequence_number: number;
          status: string;
          section: string;
          start_date: string;
          created_at: Date;
        }>);
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

    // 2.1 (ADR-0012 §3.2 Layer 3): when this action item is being created
    // in the context of an in-progress meeting, drop a `live` snapshot
    // row. The follow_up_owner ciphertext doubles as the assignee
    // ciphertext for the snapshot (CLAUDE.md taxonomy maps the two).
    if (body.meetingId) {
      await writeLiveActionItemSnapshot(tx, {
        actorId: auth.userId,
        meetingId: body.meetingId,
        actionItemId: row.id,
        status: row.status,
        section: row.section,
        assigneeCt: followUpSealed?.ct ?? null,
        assigneeDekCt: followUpSealed?.dekCt ?? null,
      });
    }

    // M2.2 S2 (ADR-0013 §3.3): when the action item is first raised
    // INSIDE an in_progress meeting, emit the
    // `meeting.action_item_added` cross-chain anchor. Same TM-fold-3
    // pattern as `meeting.recommendation_drafted` — payload carries
    // the upstream `action_item.created` event's thisHash so the
    // verifier can compose the two chains.
    if (body.firstRaisedMeetingId) {
      const meetingRows = (await tx.execute(sql`
        SELECT status FROM meetings WHERE id = ${body.firstRaisedMeetingId} LIMIT 1
      `)) as unknown as Array<{ status: string }>;
      if (meetingRows.length > 0 && meetingRows[0]!.status === 'in_progress') {
        const createdHashHex = Buffer.from(chainRow.thisHash).toString('hex');
        await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'meeting.action_item_added',
            meetingId: body.firstRaisedMeetingId,
            actionItemId: row.id,
            section: row.section as ActionItemSection,
            addedAt: new Date().toISOString(),
            actionItemCreatedEventHash: createdHashHex,
          },
          resourceType: 'meetings',
          resourceId: body.firstRaisedMeetingId,
        });
      }
    }
    // computeChainEntryHash is exported by the meetings route for
    // cross-chain hash computation; referenced here so the import
    // stays load-bearing across the file.
    void computeChainEntryHash;

    return row;
  });

  return c.json({
    id: created.id,
    sequenceNumber: created.sequence_number,
    status: created.status as ActionItemStatus,
    section: created.section as ActionItemSection,
    startDate: created.start_date,
    // sec-F7 close-out (T-S55): version=1 for freshly-INSERTed row.
    version: 1,
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
  // q is applied post-decrypt by JS .includes(), so LIKE metachars don't
  // need escaping here (sec-review F5 1.6 -- cleaned up the vestigial
  // escapedQ from the 1.5 hazards lineage that was never used by the
  // post-decrypt filter).
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
  if (q) {
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
           created_at, updated_at, version
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
    version: number;
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
    // 1.10 S2 (ADR-0009 §3.7): optimistic-concurrency etag for the
    // client's PATCH wrapper.
    version: r.version,
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
// GET /api/action-items/:id/meeting-history — Milestone 2.2 S5 F-L3
// ---------------------------------------------------------------------------
//
// ADR-0013 §3.7 cross-meeting visibility surface. Returns the per-
// meeting touch history for an action item: every meeting the item
// touched via a section move, a status snapshot, or a closure
// verification. The S3 web client's MeetingHistoryTimeline was
// previously "faked" from moves alone — items raised in A,
// status-changed twice in B without a section move, then closed in C
// would surface only A and C. This endpoint joins the canonical
// tables so the timeline reflects the true touch history.
//
// Read-only; no step-up; same auth gate as GET /api/action-items/:id.
// Per ADR §3.3 + §3.10: read-anchoring posture is selective; this
// route is NOT chain-anchored (the canonical anchors are the
// per-meeting events already in the chain).

actionItemsRoute.get('/:id/meeting-history', async (c) => {
  const parsed = uuidParam.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'invalid_id' }, 400);
  const db = getDb();

  const existsRows = (await db.execute(sql`
    SELECT id, first_raised_meeting_id, meeting_id
    FROM action_items WHERE id = ${parsed.data} LIMIT 1
  `)) as unknown as Array<{
    id: string;
    first_raised_meeting_id: string | null;
    meeting_id: string | null;
  }>;
  if (existsRows.length === 0) return c.json({ error: 'not_found' }, 404);
  const ai = existsRows[0]!;

  const moves = (await db.execute(sql`
    SELECT id, from_section, to_section, moved_by_user_id,
           moved_at::text AS moved_at, meeting_id
    FROM action_item_moves
    WHERE action_item_id = ${parsed.data}
      AND meeting_id IS NOT NULL
    ORDER BY moved_at ASC
  `)) as unknown as Array<{
    id: string;
    from_section: string | null;
    to_section: string;
    moved_by_user_id: string;
    moved_at: string;
    meeting_id: string;
  }>;

  const snapshots = (await db.execute(sql`
    SELECT id, meeting_id, snapshot_kind, snapshot_status, snapshot_section,
           snapshot_at::text AS snapshot_at
    FROM meeting_action_item_state
    WHERE action_item_id = ${parsed.data}
    ORDER BY snapshot_at ASC
  `)) as unknown as Array<{
    id: string;
    meeting_id: string;
    snapshot_kind: string;
    snapshot_status: string;
    snapshot_section: string;
    snapshot_at: string;
  }>;

  const closures = (await db.execute(sql`
    SELECT id, meeting_id, closed_by_actor_id, counter_signed_by_actor_id,
           closed_at::text AS closed_at,
           counter_signed_at::text AS counter_signed_at,
           self_attestation, superseded_at::text AS superseded_at
    FROM action_item_closures
    WHERE action_item_id = ${parsed.data}
      AND meeting_id IS NOT NULL
    ORDER BY closed_at ASC
  `)) as unknown as Array<{
    id: string;
    meeting_id: string;
    closed_by_actor_id: string;
    counter_signed_by_actor_id: string;
    closed_at: string;
    counter_signed_at: string;
    self_attestation: boolean;
    superseded_at: string | null;
  }>;

  // Union of all distinct meeting_ids touched by this action item.
  const touchedMeetingIds = new Set<string>();
  if (ai.first_raised_meeting_id) touchedMeetingIds.add(ai.first_raised_meeting_id);
  if (ai.meeting_id) touchedMeetingIds.add(ai.meeting_id);
  for (const m of moves) touchedMeetingIds.add(m.meeting_id);
  for (const s of snapshots) touchedMeetingIds.add(s.meeting_id);
  for (const c2 of closures) touchedMeetingIds.add(c2.meeting_id);

  if (touchedMeetingIds.size === 0) {
    return c.json({
      actionItemId: parsed.data,
      firstRaisedMeetingId: ai.first_raised_meeting_id,
      items: [],
      asOf: new Date().toISOString(),
    });
  }

  const meetingIdList = Array.from(touchedMeetingIds);
  // Use ANY to avoid building a dynamic IN list.
  const meetings = (await db.execute(sql`
    SELECT id, status, scheduled_at::text AS scheduled_at,
           actual_start_at::text AS actual_start_at,
           location
    FROM meetings
    WHERE id = ANY(${meetingIdList}::uuid[])
  `)) as unknown as Array<{
    id: string;
    status: string;
    scheduled_at: string | null;
    actual_start_at: string | null;
    location: string | null;
  }>;
  const meetingById = new Map(meetings.map((m) => [m.id, m]));

  const items = meetingIdList
    .map((meetingId) => {
      const meeting = meetingById.get(meetingId) ?? null;
      const itemSnapshots = snapshots.filter((s) => s.meeting_id === meetingId);
      const itemMoves = moves.filter((m) => m.meeting_id === meetingId);
      // Closures that occurred in this meeting (may include
      // superseded rows from prior reopen + re-close cycles).
      const itemClosures = closures.filter((c2) => c2.meeting_id === meetingId);
      const meetingDate = meeting?.actual_start_at ?? meeting?.scheduled_at ?? null;
      return {
        meetingId,
        meetingDate,
        meetingStatus: meeting?.status ?? null,
        meetingLocation: meeting?.location ?? null,
        snapshotsThisMeeting: itemSnapshots.map((s) => ({
          snapshotKind: s.snapshot_kind as 'live' | 'finalized',
          snapshotAt: s.snapshot_at,
          status: s.snapshot_status,
          section: s.snapshot_section,
        })),
        movesThisMeeting: itemMoves.map((m) => ({
          id: m.id,
          fromSection: m.from_section,
          toSection: m.to_section,
          movedAt: m.moved_at,
          movedByActorId: m.moved_by_user_id,
        })),
        closuresThisMeeting: itemClosures.map((c2) => ({
          id: c2.id,
          closedAt: c2.closed_at,
          counterSignedAt: c2.counter_signed_at,
          closedByActorId: c2.closed_by_actor_id,
          counterSignerActorId: c2.counter_signed_by_actor_id,
          selfAttestation: c2.self_attestation,
          superseded: c2.superseded_at !== null,
        })),
      };
    })
    .sort((a, b) => {
      // Chronological: prefer meetingDate; nulls last.
      if (a.meetingDate === null && b.meetingDate === null) return 0;
      if (a.meetingDate === null) return 1;
      if (b.meetingDate === null) return -1;
      return a.meetingDate < b.meetingDate ? -1 : 1;
    });

  return c.json({
    actionItemId: parsed.data,
    firstRaisedMeetingId: ai.first_raised_meeting_id,
    items,
    asOf: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/action-items/:id — non-section update
// ---------------------------------------------------------------------------

actionItemsRoute.patch('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  // 1.10 S2 (ADR-0009 §3.7): If-Match etag is required on every PATCH so
  // the offline queue's optimistic-concurrency invariant holds end-to-end
  // (queue worker captures version at type-time + ships it on drain).
  const ifMatch = readIfMatchOr428(c);
  if (typeof ifMatch !== 'number') return ifMatch.precondition_required;
  const bodyParsed = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!bodyParsed.success) {
    return c.json({ error: 'invalid_body', issues: bodyParsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const body = bodyParsed.data;
  const db = getDb();

  // M2.2 S2 (ADR-0013 §3.2 + T-IM3 + T-IM4):
  //   * status='Closed' MUST go through POST /:id/close-verification —
  //     the verified-close path is the only one that produces the
  //     evidentiary attestation row + Ed25519 signature.
  //   * status='In Progress' coming FROM 'Closed' MUST go through
  //     POST /:id/reopen — re-opening is high-stakes; step-up + chain
  //     anchor with enum reason is the canonical path.
  // Routing these via clear 422 errors keeps the chain consistent
  // (T-IM3) and surfaces the right endpoint to the client.
  if (body.status === 'Closed') {
    return c.json(
      {
        error: 'CLOSE_VIA_VERIFICATION',
        message:
          'Use POST /api/action-items/:id/close-verification to close an item. The verified-close path produces the JHSC counter-sign attestation.',
        endpoint: `/api/action-items/${idParsed.data}/close-verification`,
      },
      422,
    );
  }

  if (body.status !== undefined) {
    const current = (await db.execute(sql`
      SELECT status FROM action_items WHERE id = ${idParsed.data} LIMIT 1
    `)) as unknown as Array<{ status: string }>;
    if (current.length > 0 && current[0]!.status === 'Closed') {
      return c.json(
        {
          error: 'REOPEN_VIA_REOPEN',
          message:
            'Closed items must be re-opened via POST /api/action-items/:id/reopen, which captures an enum reason in the chain.',
          endpoint: `/api/action-items/${idParsed.data}/reopen`,
        },
        422,
      );
    }
  }

  // T-IM36 mitigation: a PATCH that targets an action_item linked to
  // a meeting that has already been adjourned (pending_finalization
  // or finalized) must be rejected at the route layer. Once the
  // meeting is frozen, late PATCHes would write a `live` snapshot
  // that contradicts the canonical `finalized` snapshots — breaking
  // the chain's per-meeting state machine.
  if (body.meetingId !== undefined && body.meetingId !== null) {
    const meetingRows = (await db.execute(sql`
      SELECT status FROM meetings WHERE id = ${body.meetingId} LIMIT 1
    `)) as unknown as Array<{ status: string }>;
    if (
      meetingRows.length > 0 &&
      (meetingRows[0]!.status === 'pending_finalization' ||
        meetingRows[0]!.status === 'finalized' ||
        meetingRows[0]!.status === 'archived')
    ) {
      return c.json(
        {
          error: 'MEETING_FROZEN',
          message:
            'The linked meeting has been adjourned. Late mutations against an adjourned meeting are blocked to preserve the finalized chain.',
          meetingStatus: meetingRows[0]!.status,
        },
        422,
      );
    }
  }

  // Sec-review F1 + F3 1.6: every patchable column lives in ONE table that
  // produces both the SET fragments AND the audit-chain changedFields. A
  // future contributor who adds a column has to extend the table or the
  // typechecker fires; the audit chain cannot silently miss a write. The
  // earlier shape kept the SET-assembly and the changedFields map in
  // separate code blocks -- closedDate slipped through the audit chain
  // because the SET path was wired without an entry in the map.
  type PatchEntry = {
    /** Whether the body actually carries this field (key is set, value any). */
    readonly touched: boolean;
    /** Allow-listed column name surfaced in the audit chain payload. */
    readonly field: ActionItemUpdateField;
    /** Zero or more SET fragments to add when the column is written. */
    readonly setParts: ReadonlyArray<SQL>;
  };

  function bufferOrNull(v: { ct: Uint8Array; dekCt: Uint8Array } | null): {
    ct: Uint8Array;
    dekCt: Uint8Array;
  } | null {
    return v
      ? {
          ct: Buffer.from(v.ct) as unknown as Uint8Array,
          dekCt: Buffer.from(v.dekCt) as unknown as Uint8Array,
        }
      : null;
  }
  const descSealed =
    body.description !== undefined ? bufferOrNull(sealField(body.description)) : null;
  const recommendedSealed =
    body.recommendedAction !== undefined
      ? body.recommendedAction === null
        ? null
        : bufferOrNull(sealField(body.recommendedAction))
      : undefined;
  const followUpSealed =
    body.followUpOwner !== undefined
      ? body.followUpOwner === null
        ? null
        : bufferOrNull(sealField(body.followUpOwner))
      : undefined;

  const PATCH_TABLE: ReadonlyArray<PatchEntry> = [
    {
      touched: body.status !== undefined,
      field: 'status',
      setParts: [sql`status = ${body.status}`],
    },
    {
      touched: body.risk !== undefined,
      field: 'risk',
      setParts: [sql`risk = ${body.risk}`],
    },
    {
      touched: body.description !== undefined,
      field: 'description',
      setParts: descSealed
        ? [sql`description_ct = ${descSealed.ct}`, sql`description_dek_ct = ${descSealed.dekCt}`]
        : [],
    },
    {
      touched: body.recommendedAction !== undefined,
      field: 'recommended_action',
      setParts:
        recommendedSealed === null
          ? [sql`recommended_action_ct = NULL`, sql`recommended_action_dek_ct = NULL`]
          : recommendedSealed
            ? [
                sql`recommended_action_ct = ${recommendedSealed.ct}`,
                sql`recommended_action_dek_ct = ${recommendedSealed.dekCt}`,
              ]
            : [],
    },
    {
      touched: body.targetDate !== undefined,
      field: 'target_date',
      setParts: [sql`target_date = ${body.targetDate}`],
    },
    {
      // sec-review F1 + priv-AI-F2 1.6: closed_date is in the allow-list
      // AND in this table. Writes to closed_date now emit a chain row.
      touched: body.closedDate !== undefined,
      field: 'closed_date',
      setParts: [sql`closed_date = ${body.closedDate}`],
    },
    {
      touched: body.tags !== undefined,
      field: 'tags',
      setParts: [sql`tags = ${body.tags}::text[]`],
    },
    {
      touched: body.department !== undefined,
      field: 'department',
      setParts: [sql`department = ${body.department}`],
    },
    {
      touched: body.typeSubtype !== undefined,
      field: 'type_subtype',
      setParts: [sql`type_subtype = ${body.typeSubtype}`],
    },
    {
      touched: body.followUpOwner !== undefined,
      field: 'follow_up_owner',
      setParts:
        followUpSealed === null
          ? [sql`follow_up_owner_ct = NULL`, sql`follow_up_owner_dek_ct = NULL`]
          : followUpSealed
            ? [
                sql`follow_up_owner_ct = ${followUpSealed.ct}`,
                sql`follow_up_owner_dek_ct = ${followUpSealed.dekCt}`,
              ]
            : [],
    },
    {
      touched: body.followUpOwnerUserId !== undefined,
      field: 'follow_up_owner',
      setParts: [sql`follow_up_owner_user_id = ${body.followUpOwnerUserId}`],
    },
  ];

  // 2.1 (ADR-0012 §3.2 Layer 2): mutable meetingId is handled OUTSIDE
  // the audit allow-list because it's pure operational context (the
  // `meeting.action_item_snapshot` chain anchor is the audit-of-record
  // — see writeLiveActionItemSnapshot below). The column WRITE happens
  // post-tx-start; the snapshot chain row carries the structural
  // semantics. This keeps `action_item.updated` payloads PI-free
  // without churning the ActionItemUpdateField allow-list.
  const meetingIdSetParts: SQL[] =
    body.meetingId !== undefined ? [sql`meeting_id = ${body.meetingId}`] : [];

  const changedFields: ActionItemUpdateField[] = [];
  const setParts: SQL[] = [];
  for (const entry of PATCH_TABLE) {
    if (!entry.touched) continue;
    if (!changedFields.includes(entry.field)) changedFields.push(entry.field);
    for (const p of entry.setParts) setParts.push(p);
  }
  // The meetingId tail counts as a mutation (writes meeting_id +
  // triggers the snapshot path) but does NOT appear in changedFields
  // because it is not in the audit allow-list. Track it as a separate
  // flag so the "no_changes" gate honors both kinds of mutation.
  const hasMutation = changedFields.length > 0 || meetingIdSetParts.length > 0;
  if (!hasMutation) {
    return c.json({ error: 'no_changes' }, 400);
  }
  // Defence-in-depth: the field names in PATCH_TABLE are typed against
  // ActionItemUpdateField at compile time, but this runtime check covers
  // the case where a contributor `as`-casts a string into the union.
  for (const f of changedFields) {
    if (!actionItemUpdateField.includes(f)) {
      return c.json({ error: 'invalid_change_field', field: f }, 400);
    }
  }

  const allSetParts: SQL[] = [...setParts, ...meetingIdSetParts];

  let newVersion = 0;
  try {
    await db.transaction(async (tx) => {
      const peek = (await tx.execute(sql`
      SELECT id, version, status, section, follow_up_owner_ct, follow_up_owner_dek_ct,
             meeting_id
      FROM action_items WHERE id = ${idParsed.data} FOR UPDATE
    `)) as unknown as Array<{
        id: string;
        version: number;
        status: string;
        section: string;
        follow_up_owner_ct: Uint8Array | null;
        follow_up_owner_dek_ct: Uint8Array | null;
        meeting_id: string | null;
      }>;
      if (peek.length === 0) {
        throw new ActionItemWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      // 1.10 S2 (ADR-0009 §3.7): version check inside the FOR UPDATE lock.
      if (peek[0]!.version !== ifMatch) {
        // Fetch the canonical serverState for the conflict body. We
        // intentionally project a shallow shape — the conflict UI
        // re-reads the full detail via GET /:id after resolving.
        const fresh = (await tx.execute(sql`
          SELECT id, sequence_number, status, section, risk, version FROM action_items WHERE id = ${idParsed.data} LIMIT 1
        `)) as unknown as Array<{
          id: string;
          sequence_number: number;
          status: string;
          section: string;
          risk: string;
          version: number;
        }>;
        throw new ActionItemWriteAborted({
          status: 409,
          body: versionConflictBody(peek[0]!.version, fresh[0] ?? null) as unknown as Record<
            string,
            unknown
          >,
        });
      }
      newVersion = peek[0]!.version + 1;
      await tx.execute(sql`
        UPDATE action_items SET ${sql.join(allSetParts, sql`, `)}, version = ${newVersion} WHERE id = ${idParsed.data}
      `);

      if (changedFields.length > 0) {
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
      }

      // M2.2 S2 (ADR-0013 §3.3 + T-IM7): on every status change emit
      // the per-item `action_item.status_changed` anchor. The earlier
      // `action_item.updated` anchor is the broad change-of-record;
      // status_changed is the targeted status-machine event that the
      // verifier's --check-action-items gate walks. PI-clean — enum
      // values + IDs + timestamp only.
      const effectiveMeetingIdForStatusChange =
        body.meetingId !== undefined ? body.meetingId : peek[0]!.meeting_id;
      let statusChangedHash: string | null = null;
      if (body.status !== undefined && body.status !== peek[0]!.status) {
        const statusChangedRow = await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'action_item.status_changed',
            actionItemId: idParsed.data,
            fromStatus: peek[0]!.status as
              | 'Not Started'
              | 'In Progress'
              | 'Blocked'
              | 'Pending Review'
              | 'Closed'
              | 'Cancelled',
            toStatus: body.status,
            changedAt: new Date().toISOString(),
            changedByActorId: auth.userId,
            meetingId: effectiveMeetingIdForStatusChange,
          },
          resourceType: 'action_items',
          resourceId: idParsed.data,
        });
        statusChangedHash = Buffer.from(statusChangedRow.thisHash).toString('hex');
      }

      // Cross-chain anchor when the status change happens INSIDE an
      // in_progress meeting (TM-fold-3 pattern). The cross-anchor
      // wraps the per-item status_changed event with the meeting-
      // context envelope so the verifier composes the two chains.
      if (
        body.status !== undefined &&
        body.status !== peek[0]!.status &&
        effectiveMeetingIdForStatusChange &&
        statusChangedHash
      ) {
        const meetingRows = (await tx.execute(sql`
          SELECT status FROM meetings WHERE id = ${effectiveMeetingIdForStatusChange} LIMIT 1
        `)) as unknown as Array<{ status: string }>;
        if (meetingRows.length > 0 && meetingRows[0]!.status === 'in_progress') {
          await append(tx, {
            actorId: auth.userId,
            payload: {
              kind: 'meeting.action_item_status_changed',
              meetingId: effectiveMeetingIdForStatusChange,
              actionItemId: idParsed.data,
              fromStatus: peek[0]!.status as
                | 'Not Started'
                | 'In Progress'
                | 'Blocked'
                | 'Pending Review'
                | 'Closed'
                | 'Cancelled',
              toStatus: body.status,
              changedAt: new Date().toISOString(),
              statusChangedEventHash: statusChangedHash,
            },
            resourceType: 'meetings',
            resourceId: effectiveMeetingIdForStatusChange,
          });
        }
      }

      // 2.1 (ADR-0012 §3.2 Layer 3): if the row (after the PATCH) has a
      // meeting_id pointing at an in_progress meeting, drop a `live`
      // snapshot capturing the post-PATCH state. The check is read-after-
      // write so a PATCH that just set meeting_id snapshots immediately;
      // a PATCH that only changed status on an already-meeting-bound row
      // also snapshots.
      const effectiveMeetingId =
        body.meetingId !== undefined ? body.meetingId : peek[0]!.meeting_id;
      const effectiveStatus = body.status ?? peek[0]!.status;
      // Section is not patchable through this handler (lives in
      // /moves), so always read from the row.
      const effectiveSection = peek[0]!.section;
      // Recompute the assignee envelope: if the PATCH touched
      // followUpOwner, use the new sealed value; otherwise reuse the
      // existing row's ciphertext.
      const assigneeCt =
        body.followUpOwner !== undefined
          ? (followUpSealed?.ct ?? null)
          : peek[0]!.follow_up_owner_ct
            ? Uint8Array.from(peek[0]!.follow_up_owner_ct)
            : null;
      const assigneeDekCt =
        body.followUpOwner !== undefined
          ? (followUpSealed?.dekCt ?? null)
          : peek[0]!.follow_up_owner_dek_ct
            ? Uint8Array.from(peek[0]!.follow_up_owner_dek_ct)
            : null;
      if (effectiveMeetingId) {
        await writeLiveActionItemSnapshot(tx, {
          actorId: auth.userId,
          meetingId: effectiveMeetingId,
          actionItemId: idParsed.data,
          status: effectiveStatus,
          section: effectiveSection,
          assigneeCt,
          assigneeDekCt,
        });
      }
    });
  } catch (err) {
    if (err instanceof ActionItemWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 400 | 404 | 409);
    }
    throw err;
  }

  return c.json({ id: idParsed.data, changedFields, version: newVersion });
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
      // M2.2 S2 (ADR-0013 §3.3): cross-chain anchor when the move
      // happens INSIDE an in_progress meeting (TM-fold-3 pattern).
      // Wraps the per-item action_item.moved event with the meeting-
      // context envelope so the verifier composes the two chains.
      if (bodyParsed.data.meetingId) {
        const meetingRows = (await tx.execute(sql`
          SELECT status FROM meetings WHERE id = ${bodyParsed.data.meetingId} LIMIT 1
        `)) as unknown as Array<{ status: string }>;
        if (meetingRows.length > 0 && meetingRows[0]!.status === 'in_progress') {
          const movedHashHex = Buffer.from(chainRow.thisHash).toString('hex');
          await append(tx, {
            actorId: auth.userId,
            payload: {
              kind: 'meeting.action_item_moved',
              meetingId: bodyParsed.data.meetingId,
              actionItemId: idParsed.data,
              fromSection: from,
              toSection: to,
              movedAt: new Date().toISOString(),
              actionItemMovedEventHash: movedHashHex,
            },
            resourceType: 'meetings',
            resourceId: bodyParsed.data.meetingId,
          });
        }
      }
      // sec-review F2: the item's sequence_number is per-section. Moving
      // sections must re-allocate the "#" in the destination section,
      // otherwise the (section, sequence_number) UNIQUE index throws when
      // the incoming number collides with an item already there. Same
      // advisory lock + MAX+1 pattern as create. The item gets a fresh #
      // in its new section, matching the Excel workflow (a row moved to a
      // new sheet gets that sheet's next row number).
      const newSeq = await allocateSequenceNumber(tx, to);
      await tx.execute(
        sql`UPDATE action_items SET section = ${to}, sequence_number = ${newSeq} WHERE id = ${idParsed.data}`,
      );
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
      // sec-review F2 1.6: same allocator on undo as on move.
      const newSeq = await allocateSequenceNumber(tx, revertTo);
      await tx.execute(sql`
        UPDATE action_items SET section = ${revertTo}, sequence_number = ${newSeq} WHERE id = ${idParsed.data}
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

// Per-section sequence-number allocator. Runs inside the caller's
// transaction. Uses pg_advisory_xact_lock keyed on the section name so
// concurrent inserts into the same section serialize but different
// sections do not contend (T-AI5). Reused on every path that places an
// action_item INTO a section: create, move, undo, and (1.8) the
// inspections-finding promote handler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function allocateSequenceNumber(tx: any, section: string): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('action_items.seq.' || ${section}))`);
  const seq = (await tx.execute(sql`
    SELECT COALESCE(MAX(sequence_number), 0) + 1 AS n
    FROM action_items
    WHERE section = ${section}
  `)) as unknown as Array<{ n: number | string }>;
  return Number(seq[0]!.n);
}
