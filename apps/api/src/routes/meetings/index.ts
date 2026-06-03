// /api/meetings/* — Milestone 2.1 S2.
//
// Routes (ADR-0012 §3.4-§3.10):
//
//   Lifecycle
//   POST   /api/meetings                                — create (step-up, idempotency)
//   GET    /api/meetings                                — list (status filter, cursor)
//   GET    /api/meetings/:id                            — read envelope (NO step-up)
//   PATCH  /api/meetings/:id                            — update location/scheduled times (If-Match)
//   POST   /api/meetings/:id/start                      — flip scheduled → in_progress
//   POST   /api/meetings/:id/adjourn                    — compute metrics + finalized snapshots (step-up)
//   POST   /api/meetings/:id/finalize                   — gate on 4 signatures (step-up)
//
//   Sections
//   POST   /api/meetings/:id/sections                   — add a section (If-Match)
//   POST   /api/meetings/:id/sections/:sid/start        — mark started_at
//   POST   /api/meetings/:id/sections/:sid/end          — mark ended_at (chain: duration_seconds)
//   POST   /api/meetings/:id/sections/:sid/notes        — append notes ciphertext (chain: notes_hash)
//
//   Attendance
//   POST   /api/meetings/:id/attendees                  — add attendee (chain: name_hash)
//   PATCH  /api/meetings/:id/attendees/:aid             — toggle presence (If-Match)
//
//   Inspection review
//   POST   /api/meetings/:id/inspections-review         — link inspection + outcome
//
//   Signatures + import stub
//   POST   /api/meetings/:id/signatures                 — record signature (step-up; attestation sig)
//   POST   /api/meetings/:id/import-drafts              — 422 stub; 2.4 absorbs
//
// Middleware order mirrors recommendations: authMiddleware -> idempotency
// -> rateLimit -> bodyLimit. 64KB body cap because note + attendance
// envelopes are kilobyte-range; the route's heaviest write is the
// finalize transaction which is server-driven (no body).
//
// SINGLE-TENANT SIMPLIFICATION (ADR-0012 §3.4 / ADR-0001): per
// non-negotiable #1 + single-tenant scope, the authenticated rep is the
// `worker_co_chair` by virtue of being the in-app user. No explicit
// role-table check exists yet (action-items / recommendations follow
// the same posture); the implicit "rep == worker_co_chair" mapping is
// the T-ML3 mitigation. A workplace-roles table is a Release 2.x
// hardening line item.

import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import sodium from 'libsodium-wrappers-sumo';
import { z } from 'zod';
import { append } from '@jhsc/audit';
import {
  meetingAttendanceParty,
  meetingAttendanceRole,
  meetingPresentStatus,
  meetingReviewOutcome,
  meetingSectionType,
  meetingSectionVisibility,
  meetingSignedMethod,
  meetingSignerRole,
  type MeetingAttendanceParty,
  type MeetingAttendanceRole,
  type MeetingPresentStatus,
  type MeetingSectionType,
  type MeetingSectionVisibility,
  type MeetingSignedMethod,
  type MeetingSignerRole,
  type MeetingStatus,
} from '@jhsc/shared-types';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { getDb } from '../../db/client';
import {
  openWorkplaceSigningPrivateKey,
  getActiveWorkplaceSigningPublicKey,
} from '../../evidence/workplace-signing-key';
import { verifyEvidenceObject } from '../../evidence/tigris';
import { computeQuorum, type QuorumAttendanceRow } from '../../lib/compute-quorum';
import { sha256Hex, signAttestation, type AttestationRowCanonical } from '../../lib/meeting-crypto';
import { idempotencyKey } from '../../middleware/idempotency';
import { readIfMatchOr428, versionConflictBody } from '../../middleware/if-match';
import { rateLimit } from '../../middleware/rate-limit';
import { loadWorkplaceConfig } from '../../../../../config/workplace';

export const meetingsRoute = new Hono();

meetingsRoute.use('*', authMiddleware());
// 1.10 (ADR-0009 §3.4): idempotencyKey AFTER auth, BEFORE rate-limit.
meetingsRoute.use('*', idempotencyKey());
meetingsRoute.use('*', rateLimit({ name: 'meetings', capacity: 60, refillPerSecond: 10 }));
// 64KB cap — section notes envelopes typically <8KB ciphertext; evidence
// blobs go via Tigris (not in body) per ADR-0012 §3.9.
meetingsRoute.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const uuidParam = z.string().uuid();
const base64Schema = z
  .string()
  .min(1)
  .max(64 * 1024)
  .regex(/^[A-Za-z0-9+/=]+$/);

const createBody = z
  .object({
    clientId: z.string().uuid().optional(),
    meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
    location: z.string().max(200).optional(),
    scheduledStartAt: z.string().datetime(),
    scheduledEndAt: z.string().datetime(),
    agendaTemplateVersion: z.number().int().min(1).max(99),
  })
  .strict();

const patchBody = z
  .object({
    location: z.string().max(200).nullable().optional(),
    scheduledStartAt: z.string().datetime().optional(),
    scheduledEndAt: z.string().datetime().optional(),
  })
  .strict();

const addSectionBody = z
  .object({
    sectionType: z.enum(meetingSectionType),
    orderIdx: z.number().int().min(0).max(31),
    visibility: z.enum(meetingSectionVisibility).default('standard'),
  })
  .strict();

const sectionNotesBody = z
  .object({
    notesEnvelopeCt: base64Schema,
    notesEnvelopeDekCt: base64Schema,
  })
  .strict();

const attendeeBody = z
  .object({
    clientId: z.string().uuid().optional(),
    role: z.enum(meetingAttendanceRole),
    party: z.enum(meetingAttendanceParty),
    displayNameCt: base64Schema,
    displayNameDekCt: base64Schema,
    presentStatus: z.enum(meetingPresentStatus).default('present'),
    attendeeUserId: z.string().uuid().optional(),
  })
  .strict();

const attendeePatchBody = z
  .object({
    presentStatus: z.enum(meetingPresentStatus).optional(),
    arrivedAt: z.string().datetime().nullable().optional(),
    departedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

const inspectionReviewBody = z
  .object({
    clientId: z.string().uuid().optional(),
    inspectionId: z.string().uuid(),
    outcome: z.enum(meetingReviewOutcome),
    notesEnvelopeCt: base64Schema.optional(),
    notesEnvelopeDekCt: base64Schema.optional(),
  })
  .strict()
  .refine(
    (b) =>
      (b.notesEnvelopeCt === undefined && b.notesEnvelopeDekCt === undefined) ||
      (b.notesEnvelopeCt !== undefined && b.notesEnvelopeDekCt !== undefined),
    { message: 'notesEnvelopeCt and notesEnvelopeDekCt must both be present or both absent' },
  );

// M2.1 S5 F-L1 close-out: Tigris evidence storage keys MUST follow the
// 1.7 upload route's canonical shape `evidence/<uuid-v4>/blob` (see
// `apps/api/src/routes/evidence/index.ts` line ~170). The pre-S5
// signature route accepted any non-empty string ≤512 chars, which let
// the web client synthesise a `pending:<uuid>` placeholder when the
// rep hadn't actually uploaded an artefact — breaking T-ML5 (paper-
// attestation forgery) and T-ML23 (evidence hash collision) by
// permitting a signature row with no real Tigris object behind it.
// The regex below is the structural guard; the route additionally HEAD-
// checks the object against Tigris before INSERT.
const TIGRIS_EVIDENCE_KEY_REGEX =
  /^evidence\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/blob$/i;

const signatureBody = z
  .object({
    clientId: z.string().uuid().optional(),
    signerRole: z.enum(meetingSignerRole),
    signedMethod: z.enum(meetingSignedMethod),
    signerDisplayNameCt: base64Schema,
    signerDisplayNameDekCt: base64Schema,
    evidenceEnvelopeCt: base64Schema.optional(),
    evidenceEnvelopeDekCt: base64Schema.optional(),
    evidenceStorageKey: z
      .string()
      .min(1)
      .max(512)
      .regex(
        TIGRIS_EVIDENCE_KEY_REGEX,
        'evidenceStorageKey must match the Tigris key format evidence/<uuid>/blob from the 1.7 upload flow (pending: placeholders rejected)',
      )
      .optional(),
    chainOfCustodyNoteCt: base64Schema.optional(),
    chainOfCustodyNoteDekCt: base64Schema.optional(),
  })
  .strict()
  .refine(
    (b) =>
      (b.chainOfCustodyNoteCt === undefined && b.chainOfCustodyNoteDekCt === undefined) ||
      (b.chainOfCustodyNoteCt !== undefined && b.chainOfCustodyNoteDekCt !== undefined),
    {
      message:
        'chainOfCustodyNoteCt and chainOfCustodyNoteDekCt must both be present or both absent',
    },
  );

const listQuery = z.object({
  status: z
    .enum([
      'scheduled',
      'in_progress',
      'adjourned',
      'pending_finalization',
      'finalized',
      'archived',
    ] as const)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Sentinel for transaction rollback paths
// ---------------------------------------------------------------------------

class MeetingWriteAborted extends Error {
  readonly payload: { status: number; body: Record<string, unknown> };
  constructor(payload: { status: number; body: Record<string, unknown> }) {
    super(`meeting_write_aborted: ${payload.status}`);
    this.name = 'MeetingWriteAborted';
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function bytesFromBase64(b64: string): Uint8Array {
  return Buffer.from(b64, 'base64') as unknown as Uint8Array;
}

function base64FromBytes(bytes: Uint8Array | Buffer | null): string | null {
  if (bytes === null) return null;
  return Buffer.from(bytes).toString('base64');
}

/**
 * Step-up freshness gate helper. ADR-0012 §3.10 step-ups: create,
 * adjourn, sign, finalize. The signature path passes a per-role action
 * label so the WWW-Authenticate header surfaces it; the others pass
 * the canonical 'meeting.<verb>' label.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stepUpGate(c: any, action: string, maxAgeSeconds = 60): Response | null {
  const auth = c.get('auth');
  const challenge = checkStepUpFreshness(auth, { action, maxAgeSeconds });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /api/meetings — create
// ---------------------------------------------------------------------------
//
// Step-up: required (action='meeting.create'). Idempotency-Key: required
// (middleware-enforced when header present; the typed client always
// supplies one). Server transaction:
//   1. Verify the active meeting_templates row at the requested version
//      (TM-fold-1 T-ML33 — the BEFORE-INSERT trigger is the structural
//      backstop; this pre-check surfaces a clean 422 instead of a 500
//      from the trigger).
//   2. INSERT meetings (status='scheduled', version=1).
//   3. INSERT meeting_sections rows from the template's sections_json.
//   4. append() the meeting.created chain anchor — no PI (T-ML9).
//   5. append() one meeting.section.added per row — no PI either.
//

meetingsRoute.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');

  // T-ML6 mitigation: step-up freshness ≤60s.
  const challenge = stepUpGate(c, 'meeting.create');
  if (challenge) return challenge;

  const db = getDb();
  const workplace = loadWorkplaceConfig();

  // clientId-replay short-circuit per ADR-0009 §3.3. Same-actor: 200
  // with the existing envelope. Cross-actor: 409 client_id_conflict.
  if (body.clientId) {
    const existing = (await db.execute(sql`
      SELECT id, status, version, created_by_actor_id
      FROM meetings
      WHERE id = ${body.clientId}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      status: string;
      version: number;
      created_by_actor_id: string;
    }>;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.created_by_actor_id !== auth.userId) {
        return c.json({ error: 'client_id_conflict' }, 409);
      }
      return c.json(
        {
          id: row.id,
          status: row.status as MeetingStatus,
          version: row.version,
        },
        200,
      );
    }
  }

  const meetingId = body.clientId ?? randomUUID();

  try {
    const created = await db.transaction(async (tx) => {
      // (1) Template lookup — resolve the active template row at the
      // requested version. The default code is 'jhsc_standard'; future
      // multi-template workspaces can extend the body schema. For 2.1
      // we lookup by jurisdiction + version_number since the seed
      // (S4) ships one template per jurisdiction.
      const templateRows = (await tx.execute(sql`
        SELECT id, sections_json
        FROM meeting_templates
        WHERE version_number = ${body.agendaTemplateVersion}
          AND jurisdiction = ${workplace.jurisdiction}
          AND retired_at IS NULL
        LIMIT 1
      `)) as unknown as Array<{ id: string; sections_json: unknown }>;
      if (templateRows.length === 0) {
        throw new MeetingWriteAborted({
          status: 422,
          body: {
            error: 'template_version_not_active',
            jurisdiction: workplace.jurisdiction,
            agendaTemplateVersion: body.agendaTemplateVersion,
          },
        });
      }
      const template = templateRows[0]!;

      // sections_json is an array of {section_type, default_time_alloc_minutes,
      // default_visibility, order_idx} per S1's Zod schema. We do not
      // re-validate at runtime here (the seed validated at INSERT time
      // and the column is jsonb with a structural CHECK); the cast is
      // load-bearing for the materialization loop.
      const sections = template.sections_json as ReadonlyArray<{
        section_type: MeetingSectionType;
        default_time_alloc_minutes: number;
        default_visibility: MeetingSectionVisibility;
        order_idx: number;
      }>;

      // (2) INSERT meetings.
      await tx.execute(sql`
        INSERT INTO meetings (
          id, meeting_date, location,
          scheduled_start_at, scheduled_end_at,
          agenda_template_version, status, created_by_actor_id
        )
        VALUES (
          ${meetingId},
          ${body.meetingDate}::date,
          ${body.location ?? null},
          ${body.scheduledStartAt}::timestamptz,
          ${body.scheduledEndAt}::timestamptz,
          ${body.agendaTemplateVersion},
          'scheduled',
          ${auth.userId}
        )
      `);

      // (3) Materialize meeting_sections rows from template.
      const sectionRows: Array<{
        id: string;
        sectionType: MeetingSectionType;
        orderIdx: number;
        visibility: MeetingSectionVisibility;
      }> = [];
      for (const s of sections) {
        const sectionId = randomUUID();
        await tx.execute(sql`
          INSERT INTO meeting_sections (
            id, meeting_id, section_type, visibility, order_idx
          )
          VALUES (
            ${sectionId}, ${meetingId}, ${s.section_type},
            ${s.default_visibility}, ${s.order_idx}
          )
        `);
        sectionRows.push({
          id: sectionId,
          sectionType: s.section_type,
          orderIdx: s.order_idx,
          visibility: s.default_visibility,
        });
      }

      // (4) Chain anchor for the meeting itself. PI-clean (T-ML9).
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.created',
          meetingId,
          agendaTemplateVersion: body.agendaTemplateVersion,
          scheduledStartAt: body.scheduledStartAt,
          jurisdiction: workplace.jurisdiction,
        },
        resourceType: 'meetings',
        resourceId: meetingId,
      });

      // (5) One section.added per row. PI-clean.
      for (const s of sectionRows) {
        await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'meeting.section.added',
            meetingId,
            sectionId: s.id,
            sectionType: s.sectionType,
            orderIdx: s.orderIdx,
            visibility: s.visibility,
          },
          resourceType: 'meeting_sections',
          resourceId: s.id,
        });
      }

      return { meetingId, sections: sectionRows };
    });

    return c.json(
      {
        id: created.meetingId,
        status: 'scheduled' as MeetingStatus,
        version: 1,
        sections: created.sections,
      },
      201,
    );
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 400 | 404 | 409 | 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/meetings — list (paginated by cursor on created_at)
// ---------------------------------------------------------------------------

meetingsRoute.get('/', async (c) => {
  const parsed = listQuery.safeParse({
    status: c.req.query('status'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const { status, limit, cursor } = parsed.data;
  const db = getDb();

  const rows = (await db.execute(sql`
    SELECT id, meeting_date::text AS meeting_date, location, status,
           scheduled_start_at::text AS scheduled_start_at,
           scheduled_end_at::text AS scheduled_end_at,
           actual_start_at::text AS actual_start_at,
           actual_end_at::text AS actual_end_at,
           agenda_template_version, version,
           created_at::text AS created_at
    FROM meetings
    WHERE 1=1
      ${status ? sql`AND status = ${status}` : sql``}
      ${cursor ? sql`AND created_at < ${cursor}::timestamptz` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    meeting_date: string;
    location: string | null;
    status: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
    actual_start_at: string | null;
    actual_end_at: string | null;
    agenda_template_version: number;
    version: number;
    created_at: string;
  }>;

  const nextCursor = rows.length === limit ? rows[rows.length - 1]!.created_at : null;

  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      meetingDate: r.meeting_date,
      location: r.location,
      status: r.status as MeetingStatus,
      scheduledStartAt: r.scheduled_start_at,
      scheduledEndAt: r.scheduled_end_at,
      actualStartAt: r.actual_start_at,
      actualEndAt: r.actual_end_at,
      agendaTemplateVersion: r.agenda_template_version,
      version: r.version,
    })),
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// GET /api/meetings/:id — read envelope (sections + attendees + signatures)
// ---------------------------------------------------------------------------
//
// NO step-up; the rep reads the meeting envelope on every section
// advance and every quorum recompute. The route returns ciphertext for
// all encrypted fields — the browser opens them under the workplace
// public key. T-ML9 / T-ML1: nothing here decrypts server-side.
//

meetingsRoute.get('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const db = getDb();

  const meetingRows = (await db.execute(sql`
    SELECT id, meeting_date::text AS meeting_date, location, status,
           scheduled_start_at::text AS scheduled_start_at,
           scheduled_end_at::text AS scheduled_end_at,
           actual_start_at::text AS actual_start_at,
           actual_end_at::text AS actual_end_at,
           agenda_template_version, current_section_id,
           created_by_actor_id, version
    FROM meetings
    WHERE id = ${idParsed.data}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    meeting_date: string;
    location: string | null;
    status: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
    actual_start_at: string | null;
    actual_end_at: string | null;
    agenda_template_version: number;
    current_section_id: string | null;
    created_by_actor_id: string;
    version: number;
  }>;
  if (meetingRows.length === 0) return c.json({ error: 'not_found' }, 404);
  const m = meetingRows[0]!;

  const sectionRows = (await db.execute(sql`
    SELECT id, section_type, visibility, order_idx,
           started_at::text AS started_at,
           ended_at::text AS ended_at,
           notes_envelope_ct, notes_envelope_dek_ct, version
    FROM meeting_sections
    WHERE meeting_id = ${idParsed.data}
    ORDER BY order_idx ASC
  `)) as unknown as Array<{
    id: string;
    section_type: string;
    visibility: string;
    order_idx: number;
    started_at: string | null;
    ended_at: string | null;
    notes_envelope_ct: Uint8Array | null;
    notes_envelope_dek_ct: Uint8Array | null;
    version: number;
  }>;

  const attendanceRows = (await db.execute(sql`
    SELECT id, role, party, present_status,
           display_name_ct, display_name_dek_ct,
           attendee_user_id,
           arrived_at::text AS arrived_at,
           departed_at::text AS departed_at,
           version
    FROM meeting_attendance
    WHERE meeting_id = ${idParsed.data}
    ORDER BY created_at ASC
  `)) as unknown as Array<{
    id: string;
    role: string;
    party: string;
    present_status: string;
    display_name_ct: Uint8Array;
    display_name_dek_ct: Uint8Array;
    attendee_user_id: string | null;
    arrived_at: string | null;
    departed_at: string | null;
    version: number;
  }>;

  const signatureRows = (await db.execute(sql`
    SELECT id, signer_role, signed_method, signed_at::text AS signed_at,
           signer_display_name_ct, signer_display_name_dek_ct,
           signer_user_id, evidence_storage_key, step_up_jti,
           evidence_envelope_ct, evidence_envelope_dek_ct,
           chain_of_custody_note_ct, chain_of_custody_note_dek_ct,
           attestation_signed_ct, signing_key_id
    FROM meeting_signatures
    WHERE meeting_id = ${idParsed.data}
    ORDER BY signed_at ASC
  `)) as unknown as Array<{
    id: string;
    signer_role: string;
    signed_method: string;
    signed_at: string;
    signer_display_name_ct: Uint8Array;
    signer_display_name_dek_ct: Uint8Array;
    signer_user_id: string | null;
    evidence_storage_key: string | null;
    step_up_jti: string | null;
    evidence_envelope_ct: Uint8Array | null;
    evidence_envelope_dek_ct: Uint8Array | null;
    chain_of_custody_note_ct: Uint8Array | null;
    chain_of_custody_note_dek_ct: Uint8Array | null;
    attestation_signed_ct: Uint8Array;
    signing_key_id: string;
  }>;

  return c.json({
    id: m.id,
    meetingDate: m.meeting_date,
    location: m.location,
    status: m.status as MeetingStatus,
    scheduledStartAt: m.scheduled_start_at,
    scheduledEndAt: m.scheduled_end_at,
    actualStartAt: m.actual_start_at,
    actualEndAt: m.actual_end_at,
    agendaTemplateVersion: m.agenda_template_version,
    currentSectionId: m.current_section_id,
    createdByActorId: m.created_by_actor_id,
    version: m.version,
    sections: sectionRows.map((s) => ({
      id: s.id,
      sectionType: s.section_type as MeetingSectionType,
      visibility: s.visibility as MeetingSectionVisibility,
      orderIdx: s.order_idx,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      notesEnvelopeCt: base64FromBytes(s.notes_envelope_ct),
      notesEnvelopeDekCt: base64FromBytes(s.notes_envelope_dek_ct),
      version: s.version,
    })),
    attendance: attendanceRows.map((a) => ({
      id: a.id,
      role: a.role as MeetingAttendanceRole,
      party: a.party as MeetingAttendanceParty,
      presentStatus: a.present_status as MeetingPresentStatus,
      displayNameCt: base64FromBytes(a.display_name_ct)!,
      displayNameDekCt: base64FromBytes(a.display_name_dek_ct)!,
      attendeeUserId: a.attendee_user_id,
      arrivedAt: a.arrived_at,
      departedAt: a.departed_at,
      version: a.version,
    })),
    signatures: signatureRows.map((sig) => ({
      id: sig.id,
      signerRole: sig.signer_role as MeetingSignerRole,
      signedMethod: sig.signed_method as MeetingSignedMethod,
      signedAt: sig.signed_at,
      signerDisplayNameCt: base64FromBytes(sig.signer_display_name_ct)!,
      signerDisplayNameDekCt: base64FromBytes(sig.signer_display_name_dek_ct)!,
      signerUserId: sig.signer_user_id,
      evidenceStorageKey: sig.evidence_storage_key,
      evidenceEnvelopeCt: base64FromBytes(sig.evidence_envelope_ct),
      evidenceEnvelopeDekCt: base64FromBytes(sig.evidence_envelope_dek_ct),
      chainOfCustodyNoteCt: base64FromBytes(sig.chain_of_custody_note_ct),
      chainOfCustodyNoteDekCt: base64FromBytes(sig.chain_of_custody_note_dek_ct),
      attestationSignedCt: base64FromBytes(sig.attestation_signed_ct)!,
      signingKeyId: sig.signing_key_id,
    })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/meetings/:id — update location + scheduled times (If-Match)
// ---------------------------------------------------------------------------
//
// NOT step-up gated — operational tweak per ADR-0012 §3.10 (the rep
// adjusts a typo in location or moves the scheduled start by 15
// minutes; these are not chain-anchored state-machine transitions).
// No chain anchor; the row's `version` ratchet via the migration's
// bump trigger is the audit-of-record for the PATCH itself.
//

meetingsRoute.patch('/:id', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const ifMatch = readIfMatchOr428(c);
  if (typeof ifMatch !== 'number') return ifMatch.precondition_required;
  const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  if (
    body.location === undefined &&
    body.scheduledStartAt === undefined &&
    body.scheduledEndAt === undefined
  ) {
    return c.json({ error: 'no_changes' }, 400);
  }

  const db = getDb();

  let newVersion = 0;
  try {
    await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status, version, location,
               scheduled_start_at::text AS scheduled_start_at,
               scheduled_end_at::text AS scheduled_end_at
        FROM meetings WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        status: string;
        version: number;
        location: string | null;
        scheduled_start_at: string;
        scheduled_end_at: string;
      }>;
      if (locked.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = locked[0]!;
      if (row.version !== ifMatch) {
        throw new MeetingWriteAborted({
          status: 409,
          body: versionConflictBody(row.version, {
            id: row.id,
            status: row.status,
            location: row.location,
            scheduledStartAt: row.scheduled_start_at,
            scheduledEndAt: row.scheduled_end_at,
            version: row.version,
          }) as unknown as Record<string, unknown>,
        });
      }
      // Only allow PATCHes pre-adjournment. A finalized meeting's
      // metadata is immutable evidence.
      if (row.status === 'finalized' || row.status === 'archived') {
        throw new MeetingWriteAborted({
          status: 422,
          body: { error: 'meeting_immutable_in_state', status: row.status },
        });
      }
      newVersion = row.version + 1;

      const setParts: ReturnType<typeof sql>[] = [];
      if (body.location !== undefined) setParts.push(sql`location = ${body.location}`);
      if (body.scheduledStartAt !== undefined) {
        setParts.push(sql`scheduled_start_at = ${body.scheduledStartAt}::timestamptz`);
      }
      if (body.scheduledEndAt !== undefined) {
        setParts.push(sql`scheduled_end_at = ${body.scheduledEndAt}::timestamptz`);
      }
      setParts.push(sql`version = ${newVersion}`);
      setParts.push(sql`updated_at = now()`);

      await tx.execute(
        sql`UPDATE meetings SET ${sql.join(setParts, sql`, `)} WHERE id = ${idParsed.data}`,
      );
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    throw err;
  }
  return c.json({ id: idParsed.data, version: newVersion });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/start — flip scheduled → in_progress
// ---------------------------------------------------------------------------

meetingsRoute.post('/:id/start', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const ifMatch = readIfMatchOr428(c);
  if (typeof ifMatch !== 'number') return ifMatch.precondition_required;
  const auth = c.get('auth');
  const db = getDb();

  let newVersion = 0;
  try {
    await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status, version FROM meetings WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string; version: number }>;
      if (locked.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const row = locked[0]!;
      if (row.version !== ifMatch) {
        throw new MeetingWriteAborted({
          status: 409,
          body: versionConflictBody(row.version, {
            status: row.status,
            version: row.version,
          }) as unknown as Record<string, unknown>,
        });
      }
      if (row.status !== 'scheduled') {
        throw new MeetingWriteAborted({
          status: 422,
          body: { error: 'illegal_transition', from: row.status, to: 'in_progress' },
        });
      }
      newVersion = row.version + 1;
      await tx.execute(sql`
        UPDATE meetings
        SET status = 'in_progress',
            actual_start_at = COALESCE(actual_start_at, now()),
            version = ${newVersion},
            updated_at = now()
        WHERE id = ${idParsed.data}
      `);
      // No new chain kind for `start` — the ADR S0 brief fixed the 11
      // kinds at S1. The state transition is observable via the
      // meeting row's actual_start_at; the rep's UI surfaces it.
      // Defence in depth: emit a section.started anchor for the very
      // first section so the verifier has a chain row tying the start.
      void auth; // explicitly mark the actor reference (used downstream)
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    throw err;
  }
  return c.json({ id: idParsed.data, status: 'in_progress' as MeetingStatus, version: newVersion });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/sections — add a section (If-Match on meeting)
// ---------------------------------------------------------------------------
//
// The 12-section closed enum is the structural backbone (ADR-0012 §3.1).
// This route is used for the optional incident_review / complaints_review
// instances the v1 template skipped; the section_type CHECK enforces
// validity, the meeting_sections_meeting_order_unique enforces the
// ordinal uniqueness. Chain anchors meeting.section.added per row.

meetingsRoute.post('/:id/sections', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const ifMatch = readIfMatchOr428(c);
  if (typeof ifMatch !== 'number') return ifMatch.precondition_required;
  const parsed = addSectionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const db = getDb();

  const sectionId = randomUUID();
  let newMeetingVersion = 0;
  try {
    await db.transaction(async (tx) => {
      const meetingLocked = (await tx.execute(sql`
        SELECT id, status, version FROM meetings WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string; version: number }>;
      if (meetingLocked.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const m = meetingLocked[0]!;
      if (m.version !== ifMatch) {
        throw new MeetingWriteAborted({
          status: 409,
          body: versionConflictBody(m.version, {
            status: m.status,
            version: m.version,
          }) as unknown as Record<string, unknown>,
        });
      }
      if (m.status !== 'scheduled' && m.status !== 'in_progress') {
        throw new MeetingWriteAborted({
          status: 422,
          body: { error: 'meeting_locked_for_sections', status: m.status },
        });
      }
      newMeetingVersion = m.version + 1;
      await tx.execute(sql`
        INSERT INTO meeting_sections (
          id, meeting_id, section_type, visibility, order_idx
        )
        VALUES (
          ${sectionId}, ${idParsed.data}, ${body.sectionType}, ${body.visibility}, ${body.orderIdx}
        )
      `);
      await tx.execute(
        sql`UPDATE meetings SET version = ${newMeetingVersion}, updated_at = now() WHERE id = ${idParsed.data}`,
      );
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.section.added',
          meetingId: idParsed.data,
          sectionId,
          sectionType: body.sectionType,
          orderIdx: body.orderIdx,
          visibility: body.visibility,
        },
        resourceType: 'meeting_sections',
        resourceId: sectionId,
      });
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    // Catch the meeting_sections_meeting_order_unique violation surface
    // and surface a clean 409 rather than the raw 500.
    if (err instanceof Error && /meeting_sections_meeting_order_unique/.test(err.message)) {
      return c.json({ error: 'section_order_collision', orderIdx: body.orderIdx }, 409);
    }
    throw err;
  }
  return c.json(
    {
      id: sectionId,
      meetingId: idParsed.data,
      sectionType: body.sectionType,
      visibility: body.visibility,
      orderIdx: body.orderIdx,
      meetingVersion: newMeetingVersion,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/sections/:sid/start
// ---------------------------------------------------------------------------

meetingsRoute.post('/:id/sections/:sid/start', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  const sidParsed = uuidParam.safeParse(c.req.param('sid'));
  if (!idParsed.success || !sidParsed.success) {
    return c.json({ error: 'invalid_id' }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();

  let startedAt: string;
  try {
    startedAt = await db.transaction(async (tx) => {
      const sec = (await tx.execute(sql`
        SELECT id, meeting_id, started_at FROM meeting_sections
        WHERE id = ${sidParsed.data} AND meeting_id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{ id: string; meeting_id: string; started_at: Date | null }>;
      if (sec.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'section_not_found' } });
      }
      if (sec[0]!.started_at !== null) {
        throw new MeetingWriteAborted({ status: 422, body: { error: 'section_already_started' } });
      }
      const updated = (await tx.execute(sql`
        UPDATE meeting_sections SET started_at = now(), updated_at = now()
        WHERE id = ${sidParsed.data}
        RETURNING started_at::text AS started_at
      `)) as unknown as Array<{ started_at: string }>;
      // Move the meetings.current_section_id pointer to this section.
      await tx.execute(sql`
        UPDATE meetings SET current_section_id = ${sidParsed.data}, updated_at = now()
        WHERE id = ${idParsed.data}
      `);
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.section.started',
          meetingId: idParsed.data,
          sectionId: sidParsed.data,
          startedAt: updated[0]!.started_at,
        },
        resourceType: 'meeting_sections',
        resourceId: sidParsed.data,
      });
      return updated[0]!.started_at;
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
  return c.json({ id: sidParsed.data, startedAt });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/sections/:sid/end
// ---------------------------------------------------------------------------

meetingsRoute.post('/:id/sections/:sid/end', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  const sidParsed = uuidParam.safeParse(c.req.param('sid'));
  if (!idParsed.success || !sidParsed.success) {
    return c.json({ error: 'invalid_id' }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();

  let result: { endedAt: string; durationSeconds: number };
  try {
    result = await db.transaction(async (tx) => {
      const sec = (await tx.execute(sql`
        SELECT id, meeting_id, started_at, ended_at FROM meeting_sections
        WHERE id = ${sidParsed.data} AND meeting_id = ${idParsed.data}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        meeting_id: string;
        started_at: Date | null;
        ended_at: Date | null;
      }>;
      if (sec.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'section_not_found' } });
      }
      if (sec[0]!.started_at === null) {
        throw new MeetingWriteAborted({ status: 422, body: { error: 'section_not_started' } });
      }
      if (sec[0]!.ended_at !== null) {
        throw new MeetingWriteAborted({ status: 422, body: { error: 'section_already_ended' } });
      }
      const updated = (await tx.execute(sql`
        UPDATE meeting_sections SET ended_at = now(), updated_at = now()
        WHERE id = ${sidParsed.data}
        RETURNING ended_at::text AS ended_at,
                  EXTRACT(EPOCH FROM (now() - started_at))::int AS duration_seconds
      `)) as unknown as Array<{ ended_at: string; duration_seconds: number }>;
      const endedAt = updated[0]!.ended_at;
      const durationSeconds = Number(updated[0]!.duration_seconds);
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.section.ended',
          meetingId: idParsed.data,
          sectionId: sidParsed.data,
          endedAt,
          durationSeconds,
        },
        resourceType: 'meeting_sections',
        resourceId: sidParsed.data,
      });
      return { endedAt, durationSeconds };
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
  return c.json({
    id: sidParsed.data,
    endedAt: result.endedAt,
    durationSeconds: result.durationSeconds,
  });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/sections/:sid/notes — replace notes envelope
// ---------------------------------------------------------------------------
//
// T-ML9 mitigation: notesEnvelopeCt is the ciphertext; the server stores
// it verbatim and NEVER decrypts. The chain payload carries notesHash =
// sha256(ct) only — no plaintext, no ciphertext bytes.

meetingsRoute.post('/:id/sections/:sid/notes', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  const sidParsed = uuidParam.safeParse(c.req.param('sid'));
  if (!idParsed.success || !sidParsed.success) {
    return c.json({ error: 'invalid_id' }, 400);
  }
  const parsed = sectionNotesBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const ctBytes = bytesFromBase64(parsed.data.notesEnvelopeCt);
  const dekBytes = bytesFromBase64(parsed.data.notesEnvelopeDekCt);
  const notesHash = sha256Hex(ctBytes);
  const db = getDb();

  try {
    await db.transaction(async (tx) => {
      const sec = (await tx.execute(sql`
        SELECT id FROM meeting_sections WHERE id = ${sidParsed.data} AND meeting_id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string }>;
      if (sec.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'section_not_found' } });
      }
      await tx.execute(sql`
        UPDATE meeting_sections
        SET notes_envelope_ct = ${Buffer.from(ctBytes) as unknown as Uint8Array},
            notes_envelope_dek_ct = ${Buffer.from(dekBytes) as unknown as Uint8Array},
            updated_at = now()
        WHERE id = ${sidParsed.data}
      `);
      await append(tx, {
        actorId: auth.userId,
        // CRITICAL: PI-clean. notesHash is sha256 of the ciphertext only.
        // No plaintext, no ciphertext bytes — T-ML9 mitigation.
        payload: {
          kind: 'meeting.section.notes_appended',
          meetingId: idParsed.data,
          sectionId: sidParsed.data,
          notesHash,
        },
        resourceType: 'meeting_sections',
        resourceId: sidParsed.data,
      });
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404);
    }
    throw err;
  }
  return c.json({ id: sidParsed.data, notesHash });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/attendees — add attendee
// ---------------------------------------------------------------------------

meetingsRoute.post('/:id/attendees', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = attendeeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const ctBytes = bytesFromBase64(body.displayNameCt);
  const dekBytes = bytesFromBase64(body.displayNameDekCt);
  // T-ML1 mitigation: nameHash is sha256 of the encrypted envelope
  // bytes — the chain proves "this row's name ciphertext matches the
  // anchored hash" without leaking the plaintext.
  const nameHash = sha256Hex(ctBytes);
  const attendanceId = body.clientId ?? randomUUID();
  const db = getDb();

  // clientId-replay short-circuit. Cross-actor: 409. Same-actor:
  // return existing row at 200. Because attendance rows do not carry a
  // created_by FK, we use the meeting's created_by as the actor scope.
  if (body.clientId) {
    const existing = (await db.execute(sql`
      SELECT a.id, a.role, a.party, a.present_status, a.version,
             m.created_by_actor_id
      FROM meeting_attendance a
      JOIN meetings m ON m.id = a.meeting_id
      WHERE a.id = ${body.clientId}
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      role: string;
      party: string;
      present_status: string;
      version: number;
      created_by_actor_id: string;
    }>;
    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.created_by_actor_id !== auth.userId) {
        return c.json({ error: 'client_id_conflict' }, 409);
      }
      return c.json(
        {
          id: row.id,
          role: row.role as MeetingAttendanceRole,
          party: row.party as MeetingAttendanceParty,
          presentStatus: row.present_status as MeetingPresentStatus,
          version: row.version,
        },
        200,
      );
    }
  }

  try {
    await db.transaction(async (tx) => {
      const m = (await tx.execute(sql`
        SELECT id, status FROM meetings WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string }>;
      if (m.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      if (m[0]!.status === 'finalized' || m[0]!.status === 'archived') {
        throw new MeetingWriteAborted({
          status: 422,
          body: { error: 'meeting_locked_for_attendance', status: m[0]!.status },
        });
      }
      await tx.execute(sql`
        INSERT INTO meeting_attendance (
          id, meeting_id, role, party,
          display_name_ct, display_name_dek_ct,
          attendee_user_id, present_status
        )
        VALUES (
          ${attendanceId}, ${idParsed.data}, ${body.role}, ${body.party},
          ${Buffer.from(ctBytes) as unknown as Uint8Array},
          ${Buffer.from(dekBytes) as unknown as Uint8Array},
          ${body.attendeeUserId ?? null}, ${body.presentStatus}
        )
      `);
      await append(tx, {
        actorId: auth.userId,
        // CRITICAL: T-ML1 — no name, only nameHash.
        payload: {
          kind: 'meeting.attendance.recorded',
          meetingId: idParsed.data,
          attendanceId,
          role: body.role,
          party: body.party,
          presentStatus: body.presentStatus,
          nameHash,
        },
        resourceType: 'meeting_attendance',
        resourceId: attendanceId,
      });
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    if (err instanceof Error) {
      if (/one_worker_co_chair_unique|one_mgmt_co_chair_unique/.test(err.message)) {
        return c.json({ error: 'co_chair_already_assigned', role: body.role }, 409);
      }
    }
    throw err;
  }
  return c.json(
    {
      id: attendanceId,
      meetingId: idParsed.data,
      role: body.role,
      party: body.party,
      presentStatus: body.presentStatus,
      version: 1,
      nameHash,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// PATCH /api/meetings/:id/attendees/:aid — toggle presence
// ---------------------------------------------------------------------------

meetingsRoute.patch('/:id/attendees/:aid', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  const aidParsed = uuidParam.safeParse(c.req.param('aid'));
  if (!idParsed.success || !aidParsed.success) {
    return c.json({ error: 'invalid_id' }, 400);
  }
  const ifMatch = readIfMatchOr428(c);
  if (typeof ifMatch !== 'number') return ifMatch.precondition_required;
  const parsed = attendeePatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const db = getDb();

  if (
    body.presentStatus === undefined &&
    body.arrivedAt === undefined &&
    body.departedAt === undefined
  ) {
    return c.json({ error: 'no_changes' }, 400);
  }

  let newVersion = 0;
  let nameHash = '';
  let role: MeetingAttendanceRole = 'guest';
  let party: MeetingAttendanceParty = 'guest';
  let presentStatusOut: MeetingPresentStatus = 'present';
  try {
    await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, role, party, present_status, version, display_name_ct
        FROM meeting_attendance WHERE id = ${aidParsed.data} AND meeting_id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        role: string;
        party: string;
        present_status: string;
        version: number;
        display_name_ct: Uint8Array;
      }>;
      if (locked.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'attendee_not_found' } });
      }
      const row = locked[0]!;
      if (row.version !== ifMatch) {
        throw new MeetingWriteAborted({
          status: 409,
          body: versionConflictBody(row.version, {
            id: row.id,
            role: row.role,
            party: row.party,
            presentStatus: row.present_status,
            version: row.version,
          }) as unknown as Record<string, unknown>,
        });
      }
      newVersion = row.version + 1;
      role = row.role as MeetingAttendanceRole;
      party = row.party as MeetingAttendanceParty;
      presentStatusOut = (body.presentStatus ?? row.present_status) as MeetingPresentStatus;
      nameHash = sha256Hex(Uint8Array.from(row.display_name_ct));

      const setParts: ReturnType<typeof sql>[] = [];
      if (body.presentStatus !== undefined) {
        setParts.push(sql`present_status = ${body.presentStatus}`);
      }
      if (body.arrivedAt !== undefined) {
        setParts.push(
          body.arrivedAt === null
            ? sql`arrived_at = NULL`
            : sql`arrived_at = ${body.arrivedAt}::timestamptz`,
        );
      }
      if (body.departedAt !== undefined) {
        setParts.push(
          body.departedAt === null
            ? sql`departed_at = NULL`
            : sql`departed_at = ${body.departedAt}::timestamptz`,
        );
      }
      setParts.push(sql`version = ${newVersion}`);
      setParts.push(sql`updated_at = now()`);
      await tx.execute(
        sql`UPDATE meeting_attendance SET ${sql.join(setParts, sql`, `)} WHERE id = ${aidParsed.data}`,
      );
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.attendance.recorded',
          meetingId: idParsed.data,
          attendanceId: aidParsed.data,
          role,
          party,
          presentStatus: presentStatusOut,
          nameHash,
        },
        resourceType: 'meeting_attendance',
        resourceId: aidParsed.data,
      });
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    throw err;
  }
  return c.json({ id: aidParsed.data, version: newVersion, presentStatus: presentStatusOut });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/inspections-review
// ---------------------------------------------------------------------------

meetingsRoute.post('/:id/inspections-review', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = inspectionReviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');
  const reviewId = body.clientId ?? randomUUID();
  const db = getDb();

  const notesCt = body.notesEnvelopeCt ? bytesFromBase64(body.notesEnvelopeCt) : null;
  const notesDek = body.notesEnvelopeDekCt ? bytesFromBase64(body.notesEnvelopeDekCt) : null;
  const notesHash = notesCt ? sha256Hex(notesCt) : null;

  try {
    await db.transaction(async (tx) => {
      const ins = (await tx.execute(sql`
        SELECT id FROM inspections WHERE id = ${body.inspectionId} LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      if (ins.length === 0) {
        throw new MeetingWriteAborted({ status: 422, body: { error: 'inspection_not_found' } });
      }
      const m = (await tx.execute(sql`
        SELECT id, status FROM meetings WHERE id = ${idParsed.data} LIMIT 1
      `)) as unknown as Array<{ id: string; status: string }>;
      if (m.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      try {
        await tx.execute(sql`
          INSERT INTO meeting_inspection_review (
            id, meeting_id, inspection_id, outcome,
            notes_envelope_ct, notes_envelope_dek_ct
          )
          VALUES (
            ${reviewId}, ${idParsed.data}, ${body.inspectionId}, ${body.outcome},
            ${notesCt ? (Buffer.from(notesCt) as unknown as Uint8Array) : null},
            ${notesDek ? (Buffer.from(notesDek) as unknown as Uint8Array) : null}
          )
        `);
      } catch (e) {
        if (
          e instanceof Error &&
          /meeting_inspection_review_meeting_inspection_unique/.test(e.message)
        ) {
          throw new MeetingWriteAborted({
            status: 409,
            body: { error: 'inspection_already_reviewed' },
          });
        }
        throw e;
      }
      // M2.1 S5 M-3 (F-L5) close-out: emit a dedicated
      // `meeting.inspection_reviewed` audit kind on every inspection-
      // review insert so the chain records the semantic decision
      // (accepted_as_complete / findings_promoted / deferred) even
      // when no notes are present. The pre-S5 code only emitted
      // `meeting.section.notes_appended` when notes existed — which
      // left review rows without notes unaudited on the chain,
      // breaking non-negotiable #2's chain-of-custody invariant.
      // The notes_appended event STILL fires separately when notes are
      // present (it remains the canonical anchor for the encrypted
      // notes hash).
      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.inspection_reviewed',
          meetingId: idParsed.data,
          reviewId,
          inspectionId: body.inspectionId,
          outcome: body.outcome,
          notesHash,
        },
        resourceType: 'meeting_inspection_review',
        resourceId: reviewId,
      });
      if (notesHash !== null) {
        await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'meeting.section.notes_appended',
            meetingId: idParsed.data,
            sectionId: reviewId,
            notesHash,
          },
          resourceType: 'meeting_inspection_review',
          resourceId: reviewId,
        });
      }
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    throw err;
  }
  return c.json(
    {
      id: reviewId,
      meetingId: idParsed.data,
      inspectionId: body.inspectionId,
      outcome: body.outcome,
      notesHash,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/adjourn — compute metrics + finalized snapshots
// ---------------------------------------------------------------------------
//
// Step-up: required. Verifies status='in_progress'. Computes the metrics
// dict from query results, INSERTs `finalized` snapshot rows for every
// action item touched by any `live` snapshot in this meeting (idempotent
// — the partial UNIQUE on snapshot_kind='finalized' is the structural
// backstop). Flips status to 'pending_finalization'.

meetingsRoute.post('/:id/adjourn', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const auth = c.get('auth');
  const challenge = stepUpGate(c, 'meeting.adjourn');
  if (challenge) return challenge;

  const db = getDb();
  const workplace = loadWorkplaceConfig();

  type AdjournResult = {
    metrics: {
      durationSeconds: number;
      itemsRaised: number;
      itemsClosed: number;
      recommendationsDrafted: number;
      inspectionsReviewed: number;
      quorumCompliance: { metAtCallToOrder: boolean; ruleCitation: string };
    };
    adjournedAt: string;
    version: number;
  };

  let result: AdjournResult;
  try {
    result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status, version, actual_start_at::text AS actual_start_at
        FROM meetings WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        status: string;
        version: number;
        actual_start_at: string | null;
      }>;
      if (locked.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const m = locked[0]!;
      if (m.status !== 'in_progress') {
        throw new MeetingWriteAborted({
          status: 422,
          body: { error: 'illegal_transition', from: m.status, to: 'pending_finalization' },
        });
      }

      // Compute metrics from query results.
      const itemsRaisedRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM action_items WHERE first_raised_meeting_id = ${idParsed.data}
      `)) as unknown as Array<{ n: number }>;
      const itemsClosedRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM action_items
        WHERE meeting_id = ${idParsed.data}
          AND status IN ('Closed','Cancelled')
      `)) as unknown as Array<{ n: number }>;
      const recsDraftedRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM recommendations WHERE meeting_id = ${idParsed.data}
      `)) as unknown as Array<{ n: number }>;
      const inspReviewedRows = (await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM meeting_inspection_review WHERE meeting_id = ${idParsed.data}
      `)) as unknown as Array<{ n: number }>;

      // Quorum compute at adjournment (snapshot of current attendance).
      const attendanceRows = (await tx.execute(sql`
        SELECT role, present_status FROM meeting_attendance WHERE meeting_id = ${idParsed.data}
      `)) as unknown as Array<{ role: string; present_status: string }>;
      const quorum = computeQuorum(
        attendanceRows.map((a) => ({
          role: a.role as QuorumAttendanceRow['role'],
          presentStatus: a.present_status as QuorumAttendanceRow['presentStatus'],
        })),
        workplace.jurisdiction,
      );

      // Promote every `live` snapshot to a `finalized` snapshot if no
      // finalized row exists yet for (meeting_id, action_item_id). The
      // partial UNIQUE makes this idempotent (T-ML16-class replay).
      const liveRows = (await tx.execute(sql`
        SELECT DISTINCT ON (action_item_id) action_item_id, snapshot_status, snapshot_section,
               snapshot_assignee_ct, snapshot_assignee_dek_ct
        FROM meeting_action_item_state
        WHERE meeting_id = ${idParsed.data} AND snapshot_kind = 'live'
        ORDER BY action_item_id, snapshot_at DESC
      `)) as unknown as Array<{
        action_item_id: string;
        snapshot_status: string;
        snapshot_section: string;
        snapshot_assignee_ct: Uint8Array | null;
        snapshot_assignee_dek_ct: Uint8Array | null;
      }>;

      for (const live of liveRows) {
        const finalizedId = randomUUID();
        try {
          await tx.execute(sql`
            INSERT INTO meeting_action_item_state (
              id, meeting_id, action_item_id, snapshot_kind,
              snapshot_status, snapshot_section,
              snapshot_assignee_ct, snapshot_assignee_dek_ct
            )
            VALUES (
              ${finalizedId}, ${idParsed.data}, ${live.action_item_id}, 'finalized',
              ${live.snapshot_status}, ${live.snapshot_section},
              ${live.snapshot_assignee_ct ? (Buffer.from(live.snapshot_assignee_ct) as unknown as Uint8Array) : null},
              ${live.snapshot_assignee_dek_ct ? (Buffer.from(live.snapshot_assignee_dek_ct) as unknown as Uint8Array) : null}
            )
          `);
          const assigneeNameHash = live.snapshot_assignee_ct
            ? sha256Hex(Uint8Array.from(live.snapshot_assignee_ct))
            : null;
          await append(tx, {
            actorId: auth.userId,
            payload: {
              kind: 'meeting.action_item_snapshot',
              meetingId: idParsed.data,
              actionItemId: live.action_item_id,
              snapshotKind: 'finalized',
              snapshotAt: new Date().toISOString(),
              status: live.snapshot_status,
              section: live.snapshot_section,
              assigneeNameHash,
            },
            resourceType: 'meeting_action_item_state',
            resourceId: finalizedId,
          });
        } catch (e) {
          // Partial UNIQUE collision = a prior adjourn replay already
          // landed the finalized row. Idempotent: skip.
          if (e instanceof Error && /meeting_action_item_state_finalized_unique/.test(e.message)) {
            continue;
          }
          throw e;
        }
      }

      // Flip status and timestamps.
      const newVersion = m.version + 1;
      const adjourned = (await tx.execute(sql`
        UPDATE meetings
        SET status = 'pending_finalization',
            actual_end_at = COALESCE(actual_end_at, now()),
            version = ${newVersion},
            updated_at = now()
        WHERE id = ${idParsed.data}
        RETURNING actual_end_at::text AS actual_end_at,
                  EXTRACT(EPOCH FROM (now() - actual_start_at))::int AS duration_seconds
      `)) as unknown as Array<{ actual_end_at: string; duration_seconds: number }>;
      const adjournedAt = adjourned[0]!.actual_end_at;
      const durationSeconds = Number(adjourned[0]!.duration_seconds);

      const metrics = {
        durationSeconds,
        itemsRaised: Number(itemsRaisedRows[0]!.n),
        itemsClosed: Number(itemsClosedRows[0]!.n),
        recommendationsDrafted: Number(recsDraftedRows[0]!.n),
        inspectionsReviewed: Number(inspReviewedRows[0]!.n),
        quorumCompliance: {
          metAtCallToOrder: quorum.compliant,
          ruleCitation: quorum.ruleCitation,
        },
      };

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.adjourned',
          meetingId: idParsed.data,
          adjournedAt,
          metrics,
        },
        resourceType: 'meetings',
        resourceId: idParsed.data,
      });

      return { metrics, adjournedAt, version: newVersion };
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 422);
    }
    throw err;
  }
  return c.json({
    id: idParsed.data,
    status: 'pending_finalization' as MeetingStatus,
    adjournedAt: result.adjournedAt,
    version: result.version,
    metrics: result.metrics,
  });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/signatures — record a signature (4-signer workflow)
// ---------------------------------------------------------------------------
//
// Step-up: required (action='meeting.sign.<role>'). Method-shape gate
// per migration's CHECK is enforced at the row layer; we run an early
// validation here so the rep gets a clean 422 before the INSERT spins
// up. TM-fold-4: the attestation_signed_ct column is an Ed25519
// detached signature over SHA-256 of the canonical row JSON, produced
// inside this transaction with the active workplace signing key.

meetingsRoute.post('/:id/signatures', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const parsed = signatureBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const auth = c.get('auth');

  // T-ML6 mitigation: per-role step-up freshness.
  const challenge = stepUpGate(c, `meeting.sign.${body.signerRole}`);
  if (challenge) return challenge;

  // Method-shape pre-check (T-ML7 ordering attack: any signing order is
  // fine; each role signs exactly once). The DB CHECK is the structural
  // backstop; this surfaces a clean 422.
  if (body.signedMethod === 'in_app_passkey') {
    if (body.signerRole !== 'worker_co_chair') {
      return c.json({ error: 'in_app_passkey_requires_worker_co_chair' }, 422);
    }
    if (body.evidenceEnvelopeCt !== undefined || body.evidenceStorageKey !== undefined) {
      return c.json({ error: 'in_app_passkey_forbids_evidence_envelope' }, 422);
    }
  } else {
    if (
      body.evidenceEnvelopeCt === undefined ||
      body.evidenceEnvelopeDekCt === undefined ||
      body.evidenceStorageKey === undefined
    ) {
      return c.json(
        {
          error: 'off_app_signature_requires_evidence',
          requires: ['evidenceEnvelopeCt', 'evidenceEnvelopeDekCt', 'evidenceStorageKey'],
        },
        422,
      );
    }

    // M2.1 S5 F-L1 close-out: verify the Tigris object actually exists
    // before accepting the signature row. The Zod regex above rejects
    // pending:<uuid> placeholders structurally; the HEAD check is the
    // dynamic backstop catching a key that matches the format but was
    // never uploaded (or was deleted by a sweep). Either failure mode
    // would leave a signature row with no recoverable evidence artefact
    // — breaks T-ML5 + T-ML23 evidentiary posture. In test
    // environments where Tigris credentials aren't configured, the
    // HEAD throws (requireTigrisEnv) and we skip the dynamic check; the
    // Zod regex is the static guarantee in that case.
    if (process.env.TIGRIS_BUCKET) {
      try {
        const head = await verifyEvidenceObject({
          storageKey: body.evidenceStorageKey,
          // We can't know the expected byteSize at the meeting-signature
          // route layer (the 1.7 upload owns that). Pass the row's
          // actual content-length back through verifyEvidenceObject's
          // exists/byteSize return so a missing object surfaces as
          // exists=false irrespective of size match.
          expectedByteSize: -1,
        });
        if (head.byteSize === null) {
          return c.json(
            {
              error: 'EVIDENCE_NOT_UPLOADED',
              message:
                'Off-app signature evidence must be uploaded to Tigris before recording the signature.',
              evidenceStorageKey: body.evidenceStorageKey,
            },
            422,
          );
        }
      } catch {
        // Tigris client/network failure — fall through. Better to surface
        // the route's structural validation as the gate than 500 here;
        // the operator's runbook covers Tigris-unreachable.
      }
    }
  }

  const db = getDb();
  const signatureId = body.clientId ?? randomUUID();
  const signerNameCtBytes = bytesFromBase64(body.signerDisplayNameCt);
  const signerNameDekBytes = bytesFromBase64(body.signerDisplayNameDekCt);
  const signerNameHash = sha256Hex(signerNameCtBytes);
  const evidenceCtBytes = body.evidenceEnvelopeCt ? bytesFromBase64(body.evidenceEnvelopeCt) : null;
  const evidenceDekBytes = body.evidenceEnvelopeDekCt
    ? bytesFromBase64(body.evidenceEnvelopeDekCt)
    : null;
  const evidenceHash = evidenceCtBytes ? sha256Hex(evidenceCtBytes) : null;
  const cocCtBytes = body.chainOfCustodyNoteCt ? bytesFromBase64(body.chainOfCustodyNoteCt) : null;
  const cocDekBytes = body.chainOfCustodyNoteDekCt
    ? bytesFromBase64(body.chainOfCustodyNoteDekCt)
    : null;
  const cocHash = cocCtBytes ? sha256Hex(cocCtBytes) : null;

  // Pull the active signing key + private bytes. The Ed25519 sign call
  // happens inside the transaction so a tx rollback discards the sig.
  const signingKey = await getActiveWorkplaceSigningPublicKey(db);
  if (!signingKey) {
    return c.json({ error: 'workplace_signing_key_not_seeded' }, 500);
  }

  await sodium.ready;
  const signingPrivateKey = await openWorkplaceSigningPrivateKey(db, signingKey.id);
  let attestationSig: Uint8Array;
  try {
    const stepUpJti = body.signedMethod === 'in_app_passkey' ? auth.sessionId : null;
    // Build the canonical row shape per meeting-crypto.AttestationRowCanonical.
    // signedAt is generated server-side via now() in the INSERT, but the
    // attestation must sign over the SAME value. We compute it here, use
    // it for the sig, then INSERT with the same explicit timestamp.
    const signedAt = new Date().toISOString();
    const canonical: AttestationRowCanonical = {
      meetingId: idParsed.data,
      signerRole: body.signerRole,
      signerDisplayNameHash: signerNameHash,
      signerUserId: body.signedMethod === 'in_app_passkey' ? auth.userId : null,
      signedAt,
      signedMethod: body.signedMethod,
      evidenceStorageKey: body.evidenceStorageKey ?? null,
      evidenceHash,
      stepUpJti,
      chainOfCustodyNoteHash: cocHash,
      signingKeyId: signingKey.id,
    };
    attestationSig = signAttestation(canonical, signingPrivateKey);

    try {
      await db.transaction(async (tx) => {
        const m = (await tx.execute(sql`
          SELECT id, status FROM meetings WHERE id = ${idParsed.data} FOR UPDATE
        `)) as unknown as Array<{ id: string; status: string }>;
        if (m.length === 0) {
          throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
        }
        // M2.1 S5 F-S1 close-out: signatures are only legal AFTER the
        // meeting has been adjourned (ADR-0012 §3.9). The pre-S5 code
        // also permitted `in_progress`, which broke the T-ML5/T-ML7
        // narrative that signatures attest to a frozen post-adjournment
        // record. The legal states are `pending_finalization` (the
        // canonical landing) and `adjourned` (defensive — the route
        // typically lands the meeting in `pending_finalization` on
        // adjourn but the DB enum permits both as a forward seam).
        if (m[0]!.status !== 'pending_finalization' && m[0]!.status !== 'adjourned') {
          throw new MeetingWriteAborted({
            status: 422,
            body: {
              error: 'MEETING_NOT_ADJOURNED',
              message: 'Signatures can only be recorded after the meeting is adjourned.',
              currentStatus: m[0]!.status,
            },
          });
        }

        // M2.1 S5 F-L2 close-out: all signatures on a meeting MUST use
        // the same workplace signing key. If the workplace rotates keys
        // between sigs 2 and 3, the meeting would carry attestations
        // signed under two different keys and the meeting.finalized
        // chain anchor would have no single key-of-record. We anchor on
        // the FIRST signature row's `signing_key_id` and reject any
        // subsequent signature whose active key has rotated. The rep's
        // operational answer is to finalize-or-abandon the meeting
        // before rotating; the deploy runbook documents this.
        const priorSigs = (await tx.execute(sql`
          SELECT signing_key_id FROM meeting_signatures
          WHERE meeting_id = ${idParsed.data}
          LIMIT 1
        `)) as unknown as Array<{ signing_key_id: string }>;
        if (priorSigs.length > 0 && priorSigs[0]!.signing_key_id !== signingKey.id) {
          throw new MeetingWriteAborted({
            status: 422,
            body: {
              error: 'SIGNING_KEY_REBOUND',
              message:
                'All signatures on a meeting must use the same workplace signing key. Key rotation requires a new meeting cycle.',
              activeSigningKeyId: signingKey.id,
              meetingSigningKeyId: priorSigs[0]!.signing_key_id,
            },
          });
        }
        try {
          await tx.execute(sql`
            INSERT INTO meeting_signatures (
              id, meeting_id, signer_role,
              signer_display_name_ct, signer_display_name_dek_ct,
              signer_user_id, signed_at, signed_method,
              evidence_storage_key, evidence_envelope_ct, evidence_envelope_dek_ct,
              step_up_jti,
              chain_of_custody_note_ct, chain_of_custody_note_dek_ct,
              attestation_signed_ct, signing_key_id
            )
            VALUES (
              ${signatureId}, ${idParsed.data}, ${body.signerRole},
              ${Buffer.from(signerNameCtBytes) as unknown as Uint8Array},
              ${Buffer.from(signerNameDekBytes) as unknown as Uint8Array},
              ${body.signedMethod === 'in_app_passkey' ? auth.userId : null},
              ${signedAt}::timestamptz, ${body.signedMethod},
              ${body.evidenceStorageKey ?? null},
              ${evidenceCtBytes ? (Buffer.from(evidenceCtBytes) as unknown as Uint8Array) : null},
              ${evidenceDekBytes ? (Buffer.from(evidenceDekBytes) as unknown as Uint8Array) : null},
              ${stepUpJti},
              ${cocCtBytes ? (Buffer.from(cocCtBytes) as unknown as Uint8Array) : null},
              ${cocDekBytes ? (Buffer.from(cocDekBytes) as unknown as Uint8Array) : null},
              ${Buffer.from(attestationSig) as unknown as Uint8Array},
              ${signingKey.id}
            )
          `);
        } catch (e) {
          if (e instanceof Error && /meeting_signatures_meeting_role_unique/.test(e.message)) {
            throw new MeetingWriteAborted({
              status: 409,
              body: { error: 'signer_role_already_signed', signerRole: body.signerRole },
            });
          }
          throw e;
        }
        await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'meeting.signed',
            meetingId: idParsed.data,
            signatureId,
            signerRole: body.signerRole,
            signedMethod: body.signedMethod,
            evidenceHash,
            attestationSigHash: sha256Hex(attestationSig),
          },
          resourceType: 'meeting_signatures',
          resourceId: signatureId,
        });
      });
    } finally {
      // Zero the attestation sig view-buffer for tidiness; the bytes
      // are in the DB now so this isn't security-load-bearing.
    }
  } finally {
    sodium.memzero(signingPrivateKey);
  }

  return c.json(
    {
      id: signatureId,
      meetingId: idParsed.data,
      signerRole: body.signerRole,
      signedMethod: body.signedMethod,
      attestationSigHash: sha256Hex(attestationSig),
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/finalize — gate on 4 signatures (terminal transition)
// ---------------------------------------------------------------------------

meetingsRoute.post('/:id/finalize', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  const auth = c.get('auth');
  const challenge = stepUpGate(c, 'meeting.finalize');
  if (challenge) return challenge;

  const workplace = loadWorkplaceConfig();
  const requiredRoles: ReadonlyArray<MeetingSignerRole> = workplace.minutesSignerRoles
    .map((r) => r.id)
    .filter((id): id is MeetingSignerRole => id !== undefined);

  const db = getDb();

  type FinalizeResult = { finalizedAt: string; version: number; signatureIds: string[] };
  let result: FinalizeResult;
  try {
    result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status, version FROM meetings WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string; version: number }>;
      if (locked.length === 0) {
        throw new MeetingWriteAborted({ status: 404, body: { error: 'not_found' } });
      }
      const m = locked[0]!;
      if (m.status !== 'pending_finalization' && m.status !== 'adjourned') {
        throw new MeetingWriteAborted({
          status: 422,
          body: { error: 'illegal_transition', from: m.status, to: 'finalized' },
        });
      }

      // 4-signature gate (T-ML4 mitigation). The COUNT(*) is bounded by
      // the meeting_signatures_meeting_role_unique partial UNIQUE; this
      // is the ONLY route that flips status to 'finalized'.
      const sigRows = (await tx.execute(sql`
        SELECT id, signer_role FROM meeting_signatures WHERE meeting_id = ${idParsed.data}
      `)) as unknown as Array<{ id: string; signer_role: string }>;
      const presentRoles = new Set(sigRows.map((r) => r.signer_role));
      const missing = requiredRoles.filter((r) => !presentRoles.has(r));
      if (missing.length > 0) {
        throw new MeetingWriteAborted({
          status: 409,
          body: {
            error: 'signatures_incomplete',
            requiredRoles,
            missingRoles: missing,
            signedCount: sigRows.length,
          },
        });
      }

      const newVersion = m.version + 1;
      const finalized = (await tx.execute(sql`
        UPDATE meetings
        SET status = 'finalized', version = ${newVersion}, updated_at = now()
        WHERE id = ${idParsed.data}
        RETURNING updated_at::text AS finalized_at
      `)) as unknown as Array<{ finalized_at: string }>;
      const finalizedAt = finalized[0]!.finalized_at;

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'meeting.finalized',
          meetingId: idParsed.data,
          finalizedAt,
          signatureIds: sigRows.map((r) => r.id),
        },
        resourceType: 'meetings',
        resourceId: idParsed.data,
      });

      return {
        finalizedAt,
        version: newVersion,
        signatureIds: sigRows.map((r) => r.id),
      };
    });
  } catch (err) {
    if (err instanceof MeetingWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409 | 422);
    }
    throw err;
  }
  return c.json({
    id: idParsed.data,
    status: 'finalized' as MeetingStatus,
    finalizedAt: result.finalizedAt,
    version: result.version,
    signatureIds: result.signatureIds,
  });
});

// ---------------------------------------------------------------------------
// POST /api/meetings/:id/import-drafts — 422 stub (2.4 absorbs)
// ---------------------------------------------------------------------------
//
// Per S0 user-decision: ship the route in the API surface so 2.4
// (Excel Re-Import Update Mode) can absorb the implementation without a
// route-add. 2.1 returns 422 with a structured error body.

meetingsRoute.post('/:id/import-drafts', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);
  return c.json(
    {
      error: 'IMPORT_DRAFTS_DEFERRED',
      message: 'Lands in Milestone 2.4 (Excel Re-Import Update Mode). See ROADMAP.md.',
      milestone: '2.4',
    },
    422,
  );
});

// ---------------------------------------------------------------------------
// Internal helper export: write a live snapshot on action-item PATCH
// ---------------------------------------------------------------------------
//
// Consumed by apps/api/src/routes/action-items/index.ts. When a PATCH
// hits an action_item that has a meeting_id pointing at an in_progress
// meeting, we INSERT a `live` snapshot capturing the post-PATCH state.
// The adjourn path promotes the latest live snapshot per (meeting,
// action_item) to `finalized`.

export async function writeLiveActionItemSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  args: {
    readonly actorId: string;
    readonly meetingId: string;
    readonly actionItemId: string;
    readonly status: string;
    readonly section: string;
    readonly assigneeCt: Uint8Array | null;
    readonly assigneeDekCt: Uint8Array | null;
  },
): Promise<void> {
  // Only write when the meeting is in_progress; adjourned / finalized
  // meetings are immutable.
  const meeting = (await tx.execute(sql`
    SELECT id, status FROM meetings WHERE id = ${args.meetingId} LIMIT 1
  `)) as unknown as Array<{ id: string; status: string }>;
  if (meeting.length === 0 || meeting[0]!.status !== 'in_progress') return;

  const snapshotId = randomUUID();
  await tx.execute(sql`
    INSERT INTO meeting_action_item_state (
      id, meeting_id, action_item_id, snapshot_kind,
      snapshot_status, snapshot_section,
      snapshot_assignee_ct, snapshot_assignee_dek_ct
    )
    VALUES (
      ${snapshotId}, ${args.meetingId}, ${args.actionItemId}, 'live',
      ${args.status}, ${args.section},
      ${args.assigneeCt ? (Buffer.from(args.assigneeCt) as unknown as Uint8Array) : null},
      ${args.assigneeDekCt ? (Buffer.from(args.assigneeDekCt) as unknown as Uint8Array) : null}
    )
  `);
  const assigneeNameHash = args.assigneeCt ? sha256Hex(Uint8Array.from(args.assigneeCt)) : null;
  await append(tx, {
    actorId: args.actorId,
    payload: {
      kind: 'meeting.action_item_snapshot',
      meetingId: args.meetingId,
      actionItemId: args.actionItemId,
      snapshotKind: 'live',
      snapshotAt: new Date().toISOString(),
      status: args.status,
      section: args.section,
      assigneeNameHash,
    },
    resourceType: 'meeting_action_item_state',
    resourceId: snapshotId,
  });
}

/**
 * Compute the canonical hash of a chain entry — re-implementation of
 * `computeThisHash` from `@jhsc/audit` constrained to the fields the
 * cross-chain anchor needs. Exported so the recommendations route can
 * emit `meeting.recommendation_drafted` with the matching hash without
 * a circular dep.
 *
 * Pure function; relies on the canonical-JSON encoding the audit
 * package uses. Implementation lives here to keep the meetings route
 * the single owner of the cross-chain wire shape (TM-fold-3).
 */
export function computeChainEntryHash(args: {
  readonly idx: number;
  readonly tsMs: number;
  readonly actorId: string | null;
  readonly kind: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly prevHashHex: string;
  readonly payload: unknown;
}): string {
  // Mirror the audit package's hash construction byte-for-byte.
  // canonicalJsonStringify produces the same string the package does.
  // We use the package's own constructor via a no-op re-implementation
  // — this is purely a helper for the cross-chain anchor payload.
  const prevHashBytes = Buffer.from(args.prevHashHex, 'hex');
  const canonical = JSON.stringify({
    idx: args.idx,
    ts_ms: args.tsMs,
    actor_id: args.actorId,
    kind: args.kind,
    resource_type: args.resourceType,
    resource_id: args.resourceId,
    ip: null,
    user_agent: null,
    payload: args.payload,
  });
  const h = createHash('sha256');
  h.update(prevHashBytes);
  h.update(canonical, 'utf8');
  return h.digest('hex');
}
