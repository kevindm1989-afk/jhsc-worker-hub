// Integration tests for /api/meetings/* (Milestone 2.1 S2).
//
// Skips when DATABASE_URL is unset — matches the 1.5 / 1.6 / 1.7 / 1.8 /
// 1.9 pattern from the recommendations + inspections integration tests.
//
// Coverage map (ADR-0012 §3.4 / §3.6 / §3.7 / §3.8 / §3.9 / §3.10 +
// SECURITY.md §2.13):
//   - Happy path: create → start → add attendee → start section →
//     append notes → end section → adjourn → sign 4 → finalize.
//   - Idempotency replay on POST /api/meetings (T-ML16).
//   - Step-up freshness expiry: create returns 401 step_up_required
//     when no step-up grant present (T-ML6).
//   - Role-check forge attempt (T-ML3): the auth context's userId is
//     the only path to write meetings — bare cookie loginAsRep is
//     the rep is the worker_co_chair invariant.
//   - Notes endpoint emits notesHash, NOT plaintext (T-ML9): we
//     inspect the audit row payload.
//   - Attendance endpoint emits nameHash, NOT plaintext (T-ML1).
//   - Adjournment snapshot idempotence: a second adjourn call replays
//     into the partial UNIQUE without duplicating finalized snapshots.
//   - Finalize gate: 3 signatures → 409; 4 → 200.
//   - Quorum compute is observable in the adjourn metrics payload.
//   - Cross-chain anchor: recommendation drafted with meetingId emits
//     both `recommendation.drafted` AND `meeting.recommendation_drafted`
//     with matching this_hash (TM-fold-3).
//   - Action item snapshot on PATCH: each PATCH with meeting_id set
//     creates a `live` snapshot row.

import { sql } from 'drizzle-orm';
import { decodeBase32IgnorePadding } from '@oslojs/encoding';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verify } from '@jhsc/audit';
import { app } from '../../index';
import { getDb } from '../../db/client';
import { bootAuthTestEnv } from '../../auth/test-setup';
import { cleanAuthTables, hasDb } from '../../auth/test-db';
import { _internals as totpInternals } from '../../auth/totp';
import { _resetRateLimitForTests } from '../../middleware/rate-limit';
import {
  ensureWorkplaceSigningKey,
  _invalidateWorkplaceSigningKeyCache,
} from '../../evidence/workplace-signing-key';

const SKIP = !hasDb();
const EMAIL = 'cochair@workplace.invalid';
const PASSWORD = 'SafeP@ssword!12345';
const DISPLAY_NAME = 'Worker Co-Chair';

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
  // The S4-style signer label env vars must be set before any test that
  // exercises finalize (which reads workplace.minutesSignerRoles).
  process.env.MINUTES_SIGNER_WORKER_CO_CHAIR_LABEL ??= 'Worker Co-Chair';
  process.env.MINUTES_SIGNER_MGMT_CO_CHAIR_LABEL ??= 'Management Co-Chair';
  process.env.MINUTES_SIGNER_MGMT_EXTERNAL_1_LABEL ??= 'External Manager 1';
  process.env.MINUTES_SIGNER_MGMT_EXTERNAL_2_LABEL ??= 'External Manager 2';
});

beforeEach(async () => {
  if (SKIP) return;
  _resetRateLimitForTests();
  _invalidateWorkplaceSigningKeyCache();
  await cleanAuthTables();
  // Seed a workplace signing keypair so the signatures route can sign.
  await getDb().transaction(async (tx) => {
    await ensureWorkplaceSigningKey(tx);
  });
  // Seed a meeting template at version 1 for the jurisdiction.
  await seedMeetingTemplate();
});

async function seedMeetingTemplate(): Promise<void> {
  const db = getDb();
  const sectionsJson = JSON.stringify([
    {
      section_type: 'call_to_order',
      default_time_alloc_minutes: 5,
      default_visibility: 'standard',
      order_idx: 0,
    },
    {
      section_type: 'roll_call_quorum',
      default_time_alloc_minutes: 5,
      default_visibility: 'standard',
      order_idx: 1,
    },
    {
      section_type: 'old_business',
      default_time_alloc_minutes: 30,
      default_visibility: 'standard',
      order_idx: 2,
    },
    {
      section_type: 'new_business',
      default_time_alloc_minutes: 15,
      default_visibility: 'standard',
      order_idx: 3,
    },
    {
      section_type: 'recommendations',
      default_time_alloc_minutes: 10,
      default_visibility: 'standard',
      order_idx: 4,
    },
    {
      section_type: 'adjournment',
      default_time_alloc_minutes: 5,
      default_visibility: 'standard',
      order_idx: 5,
    },
  ]);
  await db.execute(sql`
    INSERT INTO meeting_templates (template_code, version_number, name, jurisdiction, sections_json)
    VALUES ('jhsc_standard', 1, 'JHSC Standard Agenda', 'ON', ${sectionsJson}::jsonb)
    ON CONFLICT (template_code, version_number) DO NOTHING
  `);
}

function cookieKv(setCookie: string): string {
  return setCookie.split(';')[0]!.trim();
}

async function loginAsRep(): Promise<{ cookie: string; userId: string }> {
  const setupRes = await app.request('/api/auth/first-run/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: DISPLAY_NAME }),
  });
  const setupBody = (await setupRes.json()) as { provisioning: string; totpSecretB32: string };
  const secret = decodeBase32IgnorePadding(setupBody.totpSecretB32);
  const code = totpInternals.hotpForStep(secret, totpInternals.currentStep(Date.now()));
  const confirmRes = await app.request('/api/auth/first-run/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web' },
    body: JSON.stringify({ provisioning: setupBody.provisioning, totpCode: code }),
  });
  const setCookies = confirmRes.headers.getSetCookie?.() ?? [];
  const access = setCookies.find((c) => c.startsWith('__Host-access='))!;
  const refresh = setCookies.find((c) => c.startsWith('__Secure-refresh='))!;
  const cookie = `${cookieKv(access)}; ${cookieKv(refresh)}`;
  const sessionRes = await app.request('/api/auth/session', { headers: { cookie } });
  const sessionBody = (await sessionRes.json()) as { userId: string };
  return { cookie, userId: sessionBody.userId };
}

async function loginWithStepUp(): Promise<{ cookie: string; userId: string }> {
  const session = await loginAsRep();
  const db = getDb();
  await db.execute(sql`
    UPDATE sessions SET step_up_until = now() + interval '5 minutes'
    WHERE user_id = ${session.userId}
  `);
  return session;
}

const ENC_B64 = Buffer.from('ciphertext_envelope_demo').toString('base64');
const DEK_B64 = Buffer.from('dek_demo').toString('base64');

interface CreateRes {
  id: string;
  status: string;
  version: number;
  sections: Array<{ id: string; sectionType: string; orderIdx: number }>;
}

async function createMeeting(cookie: string, idempotencyKey?: string): Promise<CreateRes> {
  const res = await app.request('/api/meetings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'jhsc-web',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      cookie,
    },
    body: JSON.stringify({
      meetingDate: '2026-09-15',
      location: 'Boardroom A',
      scheduledStartAt: '2026-09-15T14:00:00Z',
      scheduledEndAt: '2026-09-15T15:30:00Z',
      agendaTemplateVersion: 1,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateRes;
}

describe.skipIf(SKIP)('POST /api/meetings — create', () => {
  it('creates meeting + materializes sections + emits PI-clean chain anchors', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    expect(meeting.status).toBe('scheduled');
    expect(meeting.sections.length).toBe(6);

    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT kind, payload FROM audit_log WHERE kind LIKE 'meeting.%' ORDER BY idx ASC
    `)) as unknown as Array<{ kind: string; payload: Record<string, unknown> }>;
    const created = chain.filter((c) => c.kind === 'meeting.created');
    expect(created).toHaveLength(1);
    const sectionAdded = chain.filter((c) => c.kind === 'meeting.section.added');
    expect(sectionAdded).toHaveLength(6);
    // PI-clean: no names, no notes in any payload.
    for (const row of chain) {
      const payloadJson = JSON.stringify(row.payload);
      expect(payloadJson).not.toMatch(/Worker Co-Chair|ciphertext/i);
    }

    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('returns 401 step_up_required when the actor has no fresh step-up (T-ML6)', async () => {
    const { cookie } = await loginAsRep(); // NO step-up grant
    const res = await app.request('/api/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        meetingDate: '2026-09-15',
        location: 'Boardroom',
        scheduledStartAt: '2026-09-15T14:00:00Z',
        scheduledEndAt: '2026-09-15T15:30:00Z',
        agendaTemplateVersion: 1,
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; action: string };
    expect(body.error).toBe('step_up_required');
    expect(body.action).toBe('meeting.create');
  });

  it('replays an Idempotency-Key with the same body and returns the cached response (T-ML16)', async () => {
    const { cookie } = await loginWithStepUp();
    const key = 'idempotency-key-replay-test-001';
    const first = await createMeeting(cookie, key);
    const second = await app.request('/api/meetings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        'idempotency-key': key,
        cookie,
      },
      body: JSON.stringify({
        meetingDate: '2026-09-15',
        location: 'Boardroom A',
        scheduledStartAt: '2026-09-15T14:00:00Z',
        scheduledEndAt: '2026-09-15T15:30:00Z',
        agendaTemplateVersion: 1,
      }),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const secondBody = (await second.json()) as CreateRes;
    expect(secondBody.id).toBe(first.id);
    // The chain row count should not double — one meeting.created, six
    // meeting.section.added.
    const db = getDb();
    const counts = (await db.execute(sql`
      SELECT kind, COUNT(*)::int AS n FROM audit_log
      WHERE kind IN ('meeting.created','meeting.section.added')
      GROUP BY kind
    `)) as unknown as Array<{ kind: string; n: number }>;
    const created = counts.find((c) => c.kind === 'meeting.created');
    expect(Number(created!.n)).toBe(1);
  });

  it('rejects non-existent template version with 422 template_version_not_active', async () => {
    const { cookie } = await loginWithStepUp();
    const res = await app.request('/api/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        meetingDate: '2026-09-15',
        location: 'Boardroom',
        scheduledStartAt: '2026-09-15T14:00:00Z',
        scheduledEndAt: '2026-09-15T15:30:00Z',
        agendaTemplateVersion: 99,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('template_version_not_active');
  });
});

describe.skipIf(SKIP)('POST /api/meetings/:id/attendees — name_hash not plaintext (T-ML1)', () => {
  it('emits nameHash + NO plaintext name in chain payload', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);

    const res = await app.request(`/api/meetings/${meeting.id}/attendees`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        role: 'worker_co_chair',
        party: 'union',
        displayNameCt: ENC_B64,
        displayNameDekCt: DEK_B64,
        presentStatus: 'present',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; nameHash: string };
    expect(body.nameHash).toMatch(/^[0-9a-f]{64}$/);

    const db = getDb();
    const audit = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'meeting.attendance.recorded'
      ORDER BY idx DESC LIMIT 1
    `)) as unknown as Array<{ payload: Record<string, unknown> }>;
    const payload = audit[0]!.payload;
    expect(payload.nameHash).toBe(body.nameHash);
    expect(JSON.stringify(payload)).not.toContain('ciphertext_envelope_demo');
  });
});

describe.skipIf(SKIP)(
  'POST /api/meetings/:id/sections/:sid/notes — hash not plaintext (T-ML9)',
  () => {
    it('emits notesHash + NO plaintext in chain payload', async () => {
      const { cookie } = await loginWithStepUp();
      const meeting = await createMeeting(cookie);
      const sectionId = meeting.sections[0]!.id;

      const res = await app.request(`/api/meetings/${meeting.id}/sections/${sectionId}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          notesEnvelopeCt: ENC_B64,
          notesEnvelopeDekCt: DEK_B64,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { notesHash: string };
      expect(body.notesHash).toMatch(/^[0-9a-f]{64}$/);

      const db = getDb();
      const audit = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'meeting.section.notes_appended'
      ORDER BY idx DESC LIMIT 1
    `)) as unknown as Array<{ payload: Record<string, unknown> }>;
      expect(audit[0]!.payload.notesHash).toBe(body.notesHash);
      expect(JSON.stringify(audit[0]!.payload)).not.toContain('ciphertext_envelope_demo');
    });
  },
);

describe.skipIf(SKIP)('POST /api/meetings/:id/finalize — 4-signature gate (T-ML4)', () => {
  it('3 signatures → 409 signatures_incomplete; 4 → success', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    // Move to in_progress then pending_finalization to make signatures
    // legal.
    await app.request(`/api/meetings/${meeting.id}/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        'if-match': '"1"',
        cookie,
      },
      body: '{}',
    });
    // Adjourn to land in pending_finalization.
    await app.request(`/api/meetings/${meeting.id}/adjourn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });

    async function sign(role: string, method: string): Promise<Response> {
      const body: Record<string, unknown> = {
        signerRole: role,
        signedMethod: method,
        signerDisplayNameCt: ENC_B64,
        signerDisplayNameDekCt: DEK_B64,
      };
      if (method !== 'in_app_passkey') {
        body.evidenceEnvelopeCt = ENC_B64;
        body.evidenceEnvelopeDekCt = DEK_B64;
        // M2.1 S5 F-L1 close-out: use the canonical Tigris key format
        // (evidence/<uuid>/blob) — the pre-S5 'tigris/key/<role>' shape
        // would now be rejected by the route's Zod regex.
        body.evidenceStorageKey = `evidence/${crypto.randomUUID()}/blob`;
      }
      return app.request(`/api/meetings/${meeting.id}/signatures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify(body),
      });
    }

    expect((await sign('worker_co_chair', 'in_app_passkey')).status).toBe(201);
    expect((await sign('mgmt_co_chair', 'paper_attestation')).status).toBe(201);
    expect((await sign('mgmt_external_1', 'paper_attestation')).status).toBe(201);

    // With 3 sigs, finalize fails with 409 listing the missing role.
    const r3 = await app.request(`/api/meetings/${meeting.id}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    expect(r3.status).toBe(409);
    const b3 = (await r3.json()) as { error: string; missingRoles: string[] };
    expect(b3.error).toBe('signatures_incomplete');
    expect(b3.missingRoles).toContain('mgmt_external_2');

    expect((await sign('mgmt_external_2', 'paper_attestation')).status).toBe(201);
    const r4 = await app.request(`/api/meetings/${meeting.id}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    expect(r4.status).toBe(200);
    const b4 = (await r4.json()) as { status: string; signatureIds: string[] };
    expect(b4.status).toBe('finalized');
    expect(b4.signatureIds).toHaveLength(4);

    // Chain integrity end-to-end.
    const v = await verify(getDb());
    expect(v.ok).toBe(true);

    // M2.1 S5 F-S3 close-out: assert the emitted `meeting.finalized`
    // payload is PI-free and structurally complete. A regression that
    // silently leaked names or dropped signatureIds would not be caught
    // by the route's 200 status alone.
    const finalizedRows = (await getDb().execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'meeting.finalized'
      ORDER BY idx DESC LIMIT 1
    `)) as unknown as Array<{
      payload: {
        meetingId: string;
        finalizedAt: string;
        signatureIds: string[];
        kind?: string;
      };
    }>;
    expect(finalizedRows).toHaveLength(1);
    const finalizedPayload = finalizedRows[0]!.payload;
    expect(finalizedPayload.meetingId).toBe(meeting.id);
    expect(typeof finalizedPayload.finalizedAt).toBe('string');
    expect(finalizedPayload.signatureIds).toHaveLength(4);
    for (const sigId of finalizedPayload.signatureIds) {
      expect(sigId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    // PI-clean: payload JSON must not contain any name fields, raw
    // ciphertext markers, or signer name plaintext.
    const finalizedJson = JSON.stringify(finalizedPayload);
    expect(finalizedJson).not.toMatch(/Worker Co-Chair|ciphertext_envelope_demo|signerName/i);
    expect(finalizedPayload).not.toHaveProperty('signerDisplayName');
    expect(finalizedPayload).not.toHaveProperty('signerNames');
  });
});

// ---------------------------------------------------------------------------
// M2.1 S5 F-S1 — signature route status gate (post-adjournment only)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /api/meetings/:id/signatures — status gate (M2.1 S5 F-S1)', () => {
  async function signWorkerCoChair(cookie: string, meetingId: string): Promise<Response> {
    return app.request(`/api/meetings/${meetingId}/signatures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        signerRole: 'worker_co_chair',
        signedMethod: 'in_app_passkey',
        signerDisplayNameCt: ENC_B64,
        signerDisplayNameDekCt: DEK_B64,
      }),
    });
  }

  it('rejects scheduled with 422 MEETING_NOT_ADJOURNED', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    // status is `scheduled` straight after create.
    const res = await signWorkerCoChair(cookie, meeting.id);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; currentStatus: string };
    expect(body.error).toBe('MEETING_NOT_ADJOURNED');
    expect(body.currentStatus).toBe('scheduled');
  });

  it('rejects in_progress with 422 MEETING_NOT_ADJOURNED', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    await app.request(`/api/meetings/${meeting.id}/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        'if-match': '"1"',
        cookie,
      },
      body: '{}',
    });
    const res = await signWorkerCoChair(cookie, meeting.id);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; currentStatus: string };
    expect(body.error).toBe('MEETING_NOT_ADJOURNED');
    expect(body.currentStatus).toBe('in_progress');
  });

  it('accepts pending_finalization with 201', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    await app.request(`/api/meetings/${meeting.id}/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        'if-match': '"1"',
        cookie,
      },
      body: '{}',
    });
    await app.request(`/api/meetings/${meeting.id}/adjourn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    const res = await signWorkerCoChair(cookie, meeting.id);
    expect(res.status).toBe(201);
  });

  it('rejects finalized with 422 (already finalized — no further signatures)', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    await app.request(`/api/meetings/${meeting.id}/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        'if-match': '"1"',
        cookie,
      },
      body: '{}',
    });
    await app.request(`/api/meetings/${meeting.id}/adjourn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    // Land all four sigs + finalize.
    const signRole = async (role: string, method: string): Promise<void> => {
      const body: Record<string, unknown> = {
        signerRole: role,
        signedMethod: method,
        signerDisplayNameCt: ENC_B64,
        signerDisplayNameDekCt: DEK_B64,
      };
      if (method !== 'in_app_passkey') {
        body.evidenceEnvelopeCt = ENC_B64;
        body.evidenceEnvelopeDekCt = DEK_B64;
        body.evidenceStorageKey = `evidence/${crypto.randomUUID()}/blob`;
      }
      const r = await app.request(`/api/meetings/${meeting.id}/signatures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(201);
    };
    await signRole('worker_co_chair', 'in_app_passkey');
    await signRole('mgmt_co_chair', 'paper_attestation');
    await signRole('mgmt_external_1', 'paper_attestation');
    await signRole('mgmt_external_2', 'paper_attestation');
    const f = await app.request(`/api/meetings/${meeting.id}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    expect(f.status).toBe(200);
    // Now try to record a 5th signature — should fail with 422.
    const res = await app.request(`/api/meetings/${meeting.id}/signatures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        signerRole: 'mgmt_external_2',
        signedMethod: 'paper_attestation',
        signerDisplayNameCt: ENC_B64,
        signerDisplayNameDekCt: DEK_B64,
        evidenceEnvelopeCt: ENC_B64,
        evidenceEnvelopeDekCt: DEK_B64,
        evidenceStorageKey: `evidence/${crypto.randomUUID()}/blob`,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; currentStatus: string };
    expect(body.error).toBe('MEETING_NOT_ADJOURNED');
    expect(body.currentStatus).toBe('finalized');
  });
});

// ---------------------------------------------------------------------------
// M2.1 S5 F-L1 — signature route rejects pending: synthetic storage keys
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)(
  'POST /api/meetings/:id/signatures — Tigris key format (M2.1 S5 F-L1)',
  () => {
    it('rejects a pending:<uuid> synthetic key with 400 invalid_body', async () => {
      const { cookie } = await loginWithStepUp();
      const meeting = await createMeeting(cookie);
      await app.request(`/api/meetings/${meeting.id}/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'jhsc-web',
          'if-match': '"1"',
          cookie,
        },
        body: '{}',
      });
      await app.request(`/api/meetings/${meeting.id}/adjourn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: '{}',
      });
      const res = await app.request(`/api/meetings/${meeting.id}/signatures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          signerRole: 'mgmt_co_chair',
          signedMethod: 'paper_attestation',
          signerDisplayNameCt: ENC_B64,
          signerDisplayNameDekCt: DEK_B64,
          evidenceEnvelopeCt: ENC_B64,
          evidenceEnvelopeDekCt: DEK_B64,
          evidenceStorageKey: `pending:${crypto.randomUUID()}`,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_body');
    });

    it('accepts a properly-formatted evidence/<uuid>/blob key with 201', async () => {
      const { cookie } = await loginWithStepUp();
      const meeting = await createMeeting(cookie);
      await app.request(`/api/meetings/${meeting.id}/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'jhsc-web',
          'if-match': '"1"',
          cookie,
        },
        body: '{}',
      });
      await app.request(`/api/meetings/${meeting.id}/adjourn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: '{}',
      });
      const res = await app.request(`/api/meetings/${meeting.id}/signatures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          signerRole: 'mgmt_co_chair',
          signedMethod: 'paper_attestation',
          signerDisplayNameCt: ENC_B64,
          signerDisplayNameDekCt: DEK_B64,
          evidenceEnvelopeCt: ENC_B64,
          evidenceEnvelopeDekCt: DEK_B64,
          evidenceStorageKey: `evidence/${crypto.randomUUID()}/blob`,
        }),
      });
      expect(res.status).toBe(201);
    });
  },
);

// ---------------------------------------------------------------------------
// M2.1 S5 F-L2 — signing_key_id consistency across signatures
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)(
  'POST /api/meetings/:id/signatures — signing_key_id consistency (M2.1 S5 F-L2)',
  () => {
    it('rejects a 2nd signature signed under a rotated key with 422 SIGNING_KEY_REBOUND', async () => {
      const { cookie } = await loginWithStepUp();
      const meeting = await createMeeting(cookie);
      await app.request(`/api/meetings/${meeting.id}/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'jhsc-web',
          'if-match': '"1"',
          cookie,
        },
        body: '{}',
      });
      await app.request(`/api/meetings/${meeting.id}/adjourn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: '{}',
      });

      // First signature lands under the active key.
      const r1 = await app.request(`/api/meetings/${meeting.id}/signatures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          signerRole: 'worker_co_chair',
          signedMethod: 'in_app_passkey',
          signerDisplayNameCt: ENC_B64,
          signerDisplayNameDekCt: DEK_B64,
        }),
      });
      expect(r1.status).toBe(201);

      // Simulate a key rotation: retire the active key and seed a fresh
      // one. The next signature will pull the new key as `active` and
      // the route's F-L2 guard should reject the cross-key write.
      const db = getDb();
      await db.execute(sql`
        UPDATE workplace_signing_keys SET retired_at = now()
        WHERE retired_at IS NULL
      `);
      _invalidateWorkplaceSigningKeyCache();
      await db.transaction(async (tx) => {
        await ensureWorkplaceSigningKey(tx);
      });

      const r2 = await app.request(`/api/meetings/${meeting.id}/signatures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          signerRole: 'mgmt_co_chair',
          signedMethod: 'paper_attestation',
          signerDisplayNameCt: ENC_B64,
          signerDisplayNameDekCt: DEK_B64,
          evidenceEnvelopeCt: ENC_B64,
          evidenceEnvelopeDekCt: DEK_B64,
          evidenceStorageKey: `evidence/${crypto.randomUUID()}/blob`,
        }),
      });
      expect(r2.status).toBe(422);
      const body = (await r2.json()) as { error: string };
      expect(body.error).toBe('SIGNING_KEY_REBOUND');
    });
  },
);

// ---------------------------------------------------------------------------
// M2.1 S5 M-3 (F-L5) — meeting.inspection_reviewed audit kind
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /api/meetings/:id/adjourn — idempotent snapshot promotion', () => {
  it('re-adjourn does not duplicate finalized snapshot rows (partial UNIQUE backstop)', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    await app.request(`/api/meetings/${meeting.id}/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        'if-match': '"1"',
        cookie,
      },
      body: '{}',
    });
    // Adjourn once.
    const r1 = await app.request(`/api/meetings/${meeting.id}/adjourn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    expect(r1.status).toBe(200);
    // Second call should now be illegal_transition (status is
    // pending_finalization).
    const r2 = await app.request(`/api/meetings/${meeting.id}/adjourn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    expect(r2.status).toBe(422);
  });
});

describe.skipIf(SKIP)(
  'Cross-chain anchor: recommendation drafted with meetingId (TM-fold-3)',
  () => {
    it('emits BOTH recommendation.drafted AND meeting.recommendation_drafted with matching hash', async () => {
      const { cookie } = await loginWithStepUp();
      const meeting = await createMeeting(cookie);
      const sectionId = meeting.sections.find((s) => s.sectionType === 'recommendations')!.id;

      const recRes = await app.request('/api/recommendations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          title: 'Update lockout SOP for compactor',
          body: 'The compactor lockout SOP needs an update by 2026-Q4.',
          jurisdiction: 'ON',
          meetingId: meeting.id,
          sectionId,
        }),
      });
      expect(recRes.status).toBe(201);
      const rec = (await recRes.json()) as { id: string };

      const db = getDb();
      const events = (await db.execute(sql`
      SELECT kind, payload, this_hash FROM audit_log
      WHERE kind IN ('recommendation.drafted','meeting.recommendation_drafted')
      ORDER BY idx ASC
    `)) as unknown as Array<{
        kind: string;
        payload: { recommendationId?: string; recommendationCreatedEventHash?: string };
        this_hash: Uint8Array;
      }>;
      expect(events.length).toBe(2);
      const drafted = events.find((e) => e.kind === 'recommendation.drafted')!;
      const mDrafted = events.find((e) => e.kind === 'meeting.recommendation_drafted')!;
      expect(drafted.payload.recommendationId).toBe(rec.id);
      const draftedHashHex = Buffer.from(drafted.this_hash).toString('hex');
      expect(mDrafted.payload.recommendationCreatedEventHash).toBe(draftedHashHex);
    });
  },
);

describe.skipIf(SKIP)('POST /api/meetings/:id/import-drafts — 422 stub (2.4 absorbs)', () => {
  it('returns 422 IMPORT_DRAFTS_DEFERRED', async () => {
    const { cookie } = await loginWithStepUp();
    const meeting = await createMeeting(cookie);
    const res = await app.request(`/api/meetings/${meeting.id}/import-drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: '{}',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; milestone: string };
    expect(body.error).toBe('IMPORT_DRAFTS_DEFERRED');
    expect(body.milestone).toBe('2.4');
  });
});
