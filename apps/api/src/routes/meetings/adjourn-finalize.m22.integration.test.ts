// M2.2 S2 extensions to the adjournment + finalize routes (ADR-0013
// TM-fold-4 + TM-fold-5). Coverage:
//
//   - meeting.adjourned payload metrics dict now carries
//     closureVerifications {total, selfAttestation, peerVerified}.
//   - meeting.finalized payload now carries closureVerificationCount
//     (additive — pre-2.2 rows are absent / treated as 0 by the
//     verifier).
//   - The route does NOT regress on the existing M2.1 finalize gate
//     (4-of-4 signatures still required).
//
// Skips when DATABASE_URL is unset.

import { sql } from 'drizzle-orm';
import { decodeBase32IgnorePadding } from '@oslojs/encoding';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const REASON_CT_B64 = Buffer.from('reason_ct').toString('base64');
const REASON_DEK_B64 = Buffer.from('reason_dek').toString('base64');
const ENC_B64 = Buffer.from('envelope_demo').toString('base64');
const DEK_B64 = Buffer.from('dek_demo').toString('base64');

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
  await getDb().execute(sql`
    INSERT INTO meeting_templates (template_code, version_number, name, jurisdiction, sections_json)
    VALUES ('jhsc_standard', 1, 'JHSC Standard Agenda', 'ON', ${sectionsJson}::jsonb)
    ON CONFLICT (template_code, version_number) DO NOTHING
  `);
});

function cookieKv(setCookie: string): string {
  return setCookie.split(';')[0]!.trim();
}

async function loginWithStepUp(): Promise<{ cookie: string; userId: string }> {
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
  const db = getDb();
  await db.execute(sql`
    UPDATE sessions SET step_up_until = now() + interval '5 minutes'
    WHERE user_id = ${sessionBody.userId}
  `);
  return { cookie, userId: sessionBody.userId };
}

async function createAndStartMeeting(cookie: string): Promise<string> {
  const res = await app.request('/api/meetings', {
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
  const m = (await res.json()) as { id: string };
  await app.request(`/api/meetings/${m.id}/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'jhsc-web',
      'if-match': '"1"',
      cookie,
    },
    body: '{}',
  });
  return m.id;
}

describe.skipIf(SKIP)(
  'POST /api/meetings/:id/adjourn — closureVerifications metrics dict (M2.2 TM-fold-5)',
  () => {
    it('emits meeting.adjourned with closureVerifications {total, selfAttestation, peerVerified}', async () => {
      const { cookie, userId } = await loginWithStepUp();
      const meetingId = await createAndStartMeeting(cookie);

      // Create + close an item linked to the meeting so the
      // adjournment metrics dict carries non-zero closure counts.
      const createRes = await app.request('/api/action-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          type: 'INSIGHT',
          description: 'For metrics closureVerifications test',
          status: 'In Progress',
          risk: 'Low',
          section: 'new_business',
          startDate: '2026-06-10',
          firstRaisedMeetingId: meetingId,
          meetingId,
        }),
      });
      const item = (await createRes.json()) as { id: string };
      await app.request(`/api/action-items/${item.id}/close-verification`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          counterSignerActorId: userId,
          selfAttestation: true,
          meetingId,
          closureReason: { ciphertextB64: REASON_CT_B64, dekCiphertextB64: REASON_DEK_B64 },
        }),
      });

      const adjournRes = await app.request(`/api/meetings/${meetingId}/adjourn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: '{}',
      });
      expect(adjournRes.status).toBe(200);
      const body = (await adjournRes.json()) as {
        metrics: {
          closureVerifications: { total: number; selfAttestation: number; peerVerified: number };
        };
      };
      expect(body.metrics.closureVerifications.total).toBe(1);
      expect(body.metrics.closureVerifications.selfAttestation).toBe(1);
      expect(body.metrics.closureVerifications.peerVerified).toBe(0);

      const db = getDb();
      const chain = (await db.execute(sql`
        SELECT payload FROM audit_log WHERE kind = 'meeting.adjourned' ORDER BY idx DESC LIMIT 1
      `)) as unknown as Array<{
        payload: {
          metrics: {
            closureVerifications: { total: number; selfAttestation: number; peerVerified: number };
          };
        };
      }>;
      expect(chain[0]!.payload.metrics.closureVerifications.total).toBe(1);
    });
  },
);

describe.skipIf(SKIP)(
  'POST /api/meetings/:id/finalize — closureVerificationCount in payload (M2.2 TM-fold-5)',
  () => {
    it('emits meeting.finalized with closureVerificationCount matching the chain', async () => {
      const { cookie, userId } = await loginWithStepUp();
      const meetingId = await createAndStartMeeting(cookie);

      // Close one item linked to the meeting.
      const createRes = await app.request('/api/action-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          type: 'INSIGHT',
          description: 'For closure verification count test',
          status: 'In Progress',
          risk: 'Low',
          section: 'new_business',
          startDate: '2026-06-10',
          firstRaisedMeetingId: meetingId,
          meetingId,
        }),
      });
      const item = (await createRes.json()) as { id: string };
      await app.request(`/api/action-items/${item.id}/close-verification`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          counterSignerActorId: userId,
          selfAttestation: true,
          meetingId,
          closureReason: { ciphertextB64: REASON_CT_B64, dekCiphertextB64: REASON_DEK_B64 },
        }),
      });

      // Adjourn + sign all 4 roles + finalize.
      await app.request(`/api/meetings/${meetingId}/adjourn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: '{}',
      });
      async function sign(role: string, method: string): Promise<void> {
        const sigBody: Record<string, unknown> = {
          signerRole: role,
          signedMethod: method,
          signerDisplayNameCt: ENC_B64,
          signerDisplayNameDekCt: DEK_B64,
        };
        if (method !== 'in_app_passkey') {
          sigBody.evidenceEnvelopeCt = ENC_B64;
          sigBody.evidenceEnvelopeDekCt = DEK_B64;
          sigBody.evidenceStorageKey = `evidence/${crypto.randomUUID()}/blob`;
        }
        const r = await app.request(`/api/meetings/${meetingId}/signatures`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
          body: JSON.stringify(sigBody),
        });
        expect(r.status).toBe(201);
      }
      await sign('worker_co_chair', 'in_app_passkey');
      await sign('mgmt_co_chair', 'paper_attestation');
      await sign('mgmt_external_1', 'paper_attestation');
      await sign('mgmt_external_2', 'paper_attestation');

      const finalRes = await app.request(`/api/meetings/${meetingId}/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: '{}',
      });
      expect(finalRes.status).toBe(200);

      const db = getDb();
      const finalizedRows = (await db.execute(sql`
        SELECT payload FROM audit_log WHERE kind = 'meeting.finalized' ORDER BY idx DESC LIMIT 1
      `)) as unknown as Array<{ payload: { closureVerificationCount?: number } }>;
      expect(finalizedRows[0]!.payload.closureVerificationCount).toBe(1);
    });
  },
);
