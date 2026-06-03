// Integration tests for POST /api/action-items/:id/close-verification
// + POST /api/action-items/:id/reopen + the PATCH gates that redirect
// the verified-close path (Milestone 2.2 S2, ADR-0013 §3.5 + §3.10 +
// SECURITY §2.14 T-IM1 / T-IM2 / T-IM3 / T-IM4 / T-IM10 / T-IM33).
//
// Skips when DATABASE_URL is unset — same pattern as the M2.1 meetings
// integration tests.

import { sql } from 'drizzle-orm';
import { decodeBase32IgnorePadding } from '@oslojs/encoding';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
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

const REASON_CT_B64 = Buffer.from('closure_reason_ciphertext_demo').toString('base64');
const REASON_DEK_B64 = Buffer.from('closure_reason_dek_demo').toString('base64');
const EVIDENCE_CT_B64 = Buffer.from('evidence_ciphertext_demo').toString('base64');
const EVIDENCE_DEK_B64 = Buffer.from('evidence_dek_demo').toString('base64');

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
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
  await getDb().transaction(async (tx) => {
    await ensureWorkplaceSigningKey(tx);
  });
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
      section_type: 'adjournment',
      default_time_alloc_minutes: 5,
      default_visibility: 'standard',
      order_idx: 1,
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

async function createItem(cookie: string): Promise<{ id: string; version: number }> {
  const res = await app.request('/api/action-items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
    body: JSON.stringify({
      type: 'INSIGHT',
      description: 'Forklift PA inaudibility in cooler',
      status: 'In Progress',
      risk: 'Medium',
      section: 'new_business',
      startDate: '2026-06-10',
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; version: number };
}

interface CloseBody {
  counterSignerActorId: string;
  selfAttestation: boolean;
  meetingId?: string;
  closureReason?: { ciphertextB64: string; dekCiphertextB64: string };
  evidence?: { storageKey: string; envelopeCtB64: string; envelopeDekCtB64: string };
}

async function closeVerify(cookie: string, itemId: string, body: CloseBody): Promise<Response> {
  return app.request(`/api/action-items/${itemId}/close-verification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
    body: JSON.stringify({
      counterSignerActorId: body.counterSignerActorId,
      selfAttestation: body.selfAttestation,
      meetingId: body.meetingId,
      closureReason: body.closureReason ?? {
        ciphertextB64: REASON_CT_B64,
        dekCiphertextB64: REASON_DEK_B64,
      },
      evidence: body.evidence,
    }),
  });
}

describe.skipIf(SKIP)('POST /api/action-items/:id/close-verification — happy path', () => {
  it('records closure + emits PI-clean chain anchor + sets the FK + flips status', async () => {
    const { cookie, userId } = await loginWithStepUp();
    const { id } = await createItem(cookie);

    const res = await closeVerify(cookie, id, {
      counterSignerActorId: userId,
      selfAttestation: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      actionItemId: string;
      selfAttestation: boolean;
      signingKeyId: string;
      evidenceHash: string | null;
      attestationSigHash: string;
    };
    expect(body.actionItemId).toBe(id);
    expect(body.selfAttestation).toBe(true);
    expect(body.evidenceHash).toBeNull();
    expect(typeof body.attestationSigHash).toBe('string');

    const db = getDb();
    // FK + status atomic via TM-fold-1 CHECK
    const itemRows = (await db.execute(sql`
      SELECT status, closure_verification_id FROM action_items WHERE id = ${id}
    `)) as unknown as Array<{ status: string; closure_verification_id: string | null }>;
    expect(itemRows[0]!.status).toBe('Closed');
    expect(itemRows[0]!.closure_verification_id).toBe(body.id);

    // Closure row exists with the Ed25519 sig
    const closureRows = (await db.execute(sql`
      SELECT attestation_signed_ct, signing_key_id FROM action_item_closures WHERE id = ${body.id}
    `)) as unknown as Array<{ attestation_signed_ct: Uint8Array; signing_key_id: string }>;
    expect(closureRows[0]!.attestation_signed_ct.length).toBe(64);
    expect(closureRows[0]!.signing_key_id).toBe(body.signingKeyId);

    // Chain anchor emitted PI-free
    const chainRows = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'action_item.closure_verified'
    `)) as unknown as Array<{
      payload: { actionItemId: string; closerActorId: string; selfAttestation: boolean };
    }>;
    expect(chainRows).toHaveLength(1);
    expect(chainRows[0]!.payload.actionItemId).toBe(id);
    expect(chainRows[0]!.payload.selfAttestation).toBe(true);
    // PI-free: payload JSON does not include closure reason plaintext
    expect(JSON.stringify(chainRows[0]!.payload)).not.toContain('closure_reason_ciphertext_demo');

    const v = await verify(db);
    expect(v.ok).toBe(true);
  });
});

describe.skipIf(SKIP)(
  'POST /api/action-items/:id/close-verification — step-up freshness (T-IM2)',
  () => {
    it('returns 401 step_up_required when the rep has no fresh step-up grant', async () => {
      const { cookie, userId } = await loginAsRep();
      const { id } = await createItem(cookie);
      // Note: did NOT bump step_up_until — the close-verification route
      // gates on 60s freshness per T-IM2.
      const res = await closeVerify(cookie, id, {
        counterSignerActorId: userId,
        selfAttestation: true,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; action: string };
      expect(body.error).toBe('step_up_required');
      expect(body.action).toBe('action_item.close_verification');
    });
  },
);

describe.skipIf(SKIP)(
  'POST /api/action-items/:id/close-verification — selfAttestation flag',
  () => {
    it('rejects selfAttestation=false when closer == counter-signer with 422 INVALID_SELF_ATTESTATION_FLAG', async () => {
      const { cookie, userId } = await loginWithStepUp();
      const { id } = await createItem(cookie);
      const res = await closeVerify(cookie, id, {
        counterSignerActorId: userId, // same as closer
        selfAttestation: false,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('INVALID_SELF_ATTESTATION_FLAG');
    });
  },
);

describe.skipIf(SKIP)(
  'POST /api/action-items/:id/close-verification — role check (S0 user-decision Q1)',
  () => {
    it('rejects a counter-signer that is not the in-app worker_co_chair with 422', async () => {
      const { cookie } = await loginWithStepUp();
      const { id } = await createItem(cookie);
      const res = await closeVerify(cookie, id, {
        counterSignerActorId: '11111111-2222-3333-4444-555555555555',
        selfAttestation: false,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('COUNTER_SIGNER_ROLE_INVALID');
    });
  },
);

describe.skipIf(SKIP)(
  'POST /api/action-items/:id/close-verification — cross-chain anchor (T-IM33)',
  () => {
    it('emits both action_item.closure_verified AND meeting.action_item_status_changed when meeting in_progress', async () => {
      const { cookie, userId } = await loginWithStepUp();
      // Create a meeting + start it.
      const meetingRes = await app.request('/api/meetings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          meetingDate: '2026-06-10',
          location: 'Boardroom',
          scheduledStartAt: '2026-06-10T13:00:00Z',
          scheduledEndAt: '2026-06-10T14:30:00Z',
          agendaTemplateVersion: 1,
        }),
      });
      const meeting = (await meetingRes.json()) as { id: string };
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

      const { id } = await createItem(cookie);
      const res = await closeVerify(cookie, id, {
        counterSignerActorId: userId,
        selfAttestation: true,
        meetingId: meeting.id,
      });
      expect(res.status).toBe(201);

      const db = getDb();
      const chain = (await db.execute(sql`
        SELECT kind, payload, this_hash FROM audit_log
        WHERE kind IN ('action_item.closure_verified','meeting.action_item_status_changed')
        ORDER BY idx ASC
      `)) as unknown as Array<{
        kind: string;
        payload: { meetingId?: string; statusChangedEventHash?: string };
        this_hash: Uint8Array;
      }>;
      const closure = chain.find((c) => c.kind === 'action_item.closure_verified')!;
      const cross = chain.find((c) => c.kind === 'meeting.action_item_status_changed')!;
      expect(closure).toBeDefined();
      expect(cross).toBeDefined();
      expect(cross.payload.meetingId).toBe(meeting.id);
      const closureHashHex = Buffer.from(closure.this_hash).toString('hex');
      expect(cross.payload.statusChangedEventHash).toBe(closureHashHex);
    });
  },
);

describe.skipIf(SKIP)('POST /api/action-items/:id/close-verification — concurrent (T-IM10)', () => {
  it('returns 409 ALREADY_CLOSED when the item is closed twice', async () => {
    const { cookie, userId } = await loginWithStepUp();
    const { id } = await createItem(cookie);

    const r1 = await closeVerify(cookie, id, {
      counterSignerActorId: userId,
      selfAttestation: true,
    });
    expect(r1.status).toBe(201);

    const r2 = await closeVerify(cookie, id, {
      counterSignerActorId: userId,
      selfAttestation: true,
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe('ALREADY_CLOSED');
  });
});

describe.skipIf(SKIP)(
  'PATCH /api/action-items/:id — close + reopen redirects (T-IM3 + T-IM4)',
  () => {
    it('returns 422 CLOSE_VIA_VERIFICATION when PATCH attempts status=Closed', async () => {
      const { cookie } = await loginWithStepUp();
      const { id, version } = await createItem(cookie);
      const res = await app.request(`/api/action-items/${id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'jhsc-web',
          'if-match': `"${version}"`,
          cookie,
        },
        body: JSON.stringify({ status: 'Closed' }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; endpoint: string };
      expect(body.error).toBe('CLOSE_VIA_VERIFICATION');
      expect(body.endpoint).toContain('/close-verification');
    });

    it('returns 422 REOPEN_VIA_REOPEN when PATCH attempts to flip a Closed item', async () => {
      const { cookie, userId } = await loginWithStepUp();
      const { id } = await createItem(cookie);
      // First close.
      const closeRes = await closeVerify(cookie, id, {
        counterSignerActorId: userId,
        selfAttestation: true,
      });
      expect(closeRes.status).toBe(201);
      // Now try to PATCH the Closed item back to In Progress.
      const detailRes = await app.request(`/api/action-items/${id}`, {
        headers: { cookie },
      });
      const detail = (await detailRes.json()) as { version: number };
      const res = await app.request(`/api/action-items/${id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'jhsc-web',
          'if-match': `"${detail.version}"`,
          cookie,
        },
        body: JSON.stringify({ status: 'In Progress' }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; endpoint: string };
      expect(body.error).toBe('REOPEN_VIA_REOPEN');
      expect(body.endpoint).toContain('/reopen');
    });
  },
);

describe.skipIf(SKIP)('POST /api/action-items/:id/reopen — happy path (T-IM4)', () => {
  it('flips Closed → In Progress, clears FK, emits reopened anchor, preserves prior closure row', async () => {
    const { cookie, userId } = await loginWithStepUp();
    const { id } = await createItem(cookie);
    const closeRes = await closeVerify(cookie, id, {
      counterSignerActorId: userId,
      selfAttestation: true,
    });
    expect(closeRes.status).toBe(201);
    const closeBody = (await closeRes.json()) as { id: string };

    const reopen = await app.request(`/api/action-items/${id}/reopen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ reason: 'rep_decision' }),
    });
    expect(reopen.status).toBe(200);
    const reopenBody = (await reopen.json()) as {
      status: string;
      previousClosureId: string;
      reason: string;
    };
    expect(reopenBody.status).toBe('In Progress');
    expect(reopenBody.previousClosureId).toBe(closeBody.id);
    expect(reopenBody.reason).toBe('rep_decision');

    const db = getDb();
    const itemRows = (await db.execute(sql`
      SELECT status, closure_verification_id FROM action_items WHERE id = ${id}
    `)) as unknown as Array<{ status: string; closure_verification_id: string | null }>;
    expect(itemRows[0]!.status).toBe('In Progress');
    expect(itemRows[0]!.closure_verification_id).toBeNull();

    // Append-only: the closure row STAYS as historical evidence.
    const closureRows = (await db.execute(sql`
      SELECT id FROM action_item_closures WHERE id = ${closeBody.id}
    `)) as unknown as Array<{ id: string }>;
    expect(closureRows).toHaveLength(1);

    const reopenedChain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'action_item.reopened'
    `)) as unknown as Array<{
      payload: { actionItemId: string; previousClosureId: string; reason: string };
    }>;
    expect(reopenedChain).toHaveLength(1);
    expect(reopenedChain[0]!.payload.previousClosureId).toBe(closeBody.id);
    expect(reopenedChain[0]!.payload.reason).toBe('rep_decision');
  });

  it('returns 409 NOT_CLOSED for an item that was never closed', async () => {
    const { cookie } = await loginWithStepUp();
    const { id } = await createItem(cookie);
    const reopen = await app.request(`/api/action-items/${id}/reopen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ reason: 'rep_decision' }),
    });
    expect(reopen.status).toBe(409);
    const body = (await reopen.json()) as { error: string };
    expect(body.error).toBe('NOT_CLOSED');
  });
});

// Workplace signing key referenced as a sanity check
void sodium;
void EVIDENCE_CT_B64;
void EVIDENCE_DEK_B64;
