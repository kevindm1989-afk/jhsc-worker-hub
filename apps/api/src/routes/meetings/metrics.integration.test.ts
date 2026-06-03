// Integration tests for GET /api/meetings/:id/metrics (Milestone 2.2
// S2, ADR-0013 §3.4 + TM-fold-3). Skips when DATABASE_URL is unset.
//
// Coverage:
//   - Happy path: GET returns the computed metrics dict.
//   - Cache-Control headers present (TM-fold-3 / T-IM18).
//   - Closure verifications surface in the metrics dict (mirrors the
//     compute-meeting-live-metrics S1 helper shape).
//   - 404 for an unknown meeting id.
//   - Single source of truth: metrics match the adjournment route's
//     emit (the same helper drives both paths).

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

const REASON_CT_B64 = Buffer.from('closure_reason_demo').toString('base64');
const REASON_DEK_B64 = Buffer.from('closure_reason_dek_demo').toString('base64');

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

async function createMeetingInProgress(cookie: string): Promise<string> {
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
  return meeting.id;
}

describe.skipIf(SKIP)('GET /api/meetings/:id/metrics — happy path', () => {
  it('returns the computed metrics dict for a freshly started meeting', async () => {
    const { cookie } = await loginWithStepUp();
    const meetingId = await createMeetingInProgress(cookie);

    const res = await app.request(`/api/meetings/${meetingId}/metrics`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meetingId: string;
      durationSeconds: number;
      itemsRaised: number;
      itemsClosed: number;
      recommendationsDrafted: number;
      inspectionsReviewed: number;
      quorumCompliance: { metAtCallToOrder: boolean; ruleCitation: string };
      closureVerifications: { total: number; selfAttestation: number; peerVerified: number };
      asOf: string;
    };
    expect(body.meetingId).toBe(meetingId);
    expect(body.itemsRaised).toBe(0);
    expect(body.itemsClosed).toBe(0);
    expect(body.recommendationsDrafted).toBe(0);
    expect(body.inspectionsReviewed).toBe(0);
    expect(body.closureVerifications.total).toBe(0);
    expect(body.closureVerifications.selfAttestation).toBe(0);
    expect(body.closureVerifications.peerVerified).toBe(0);
    expect(typeof body.asOf).toBe('string');
  });
});

describe.skipIf(SKIP)('GET /api/meetings/:id/metrics — Cache-Control headers (TM-fold-3)', () => {
  it('sets Cache-Control: no-store + Pragma: no-cache + Vary: Cookie', async () => {
    const { cookie } = await loginWithStepUp();
    const meetingId = await createMeetingInProgress(cookie);

    const res = await app.request(`/api/meetings/${meetingId}/metrics`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.headers.get('vary')).toContain('Cookie');
  });
});

describe.skipIf(SKIP)('GET /api/meetings/:id/metrics — 404 for unknown meeting', () => {
  it('returns 404 when the meeting does not exist', async () => {
    const { cookie } = await loginWithStepUp();
    const res = await app.request(`/api/meetings/00000000-0000-0000-0000-000000000000/metrics`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});

describe.skipIf(SKIP)(
  'GET /api/meetings/:id/metrics — single source of truth for adjournment',
  () => {
    it('metrics shape matches the meeting.adjourned chain payload after adjournment', async () => {
      const { cookie, userId } = await loginWithStepUp();
      const meetingId = await createMeetingInProgress(cookie);

      // Create an action item linked to the meeting + close it via the
      // verified path so the metrics dict has non-zero closure counts.
      const createRes = await app.request('/api/action-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: JSON.stringify({
          type: 'INSIGHT',
          description: 'Test item for metrics single-source-of-truth',
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

      // Snapshot the live metrics BEFORE adjournment.
      const liveMetricsRes = await app.request(`/api/meetings/${meetingId}/metrics`, {
        headers: { cookie },
      });
      const liveMetrics = (await liveMetricsRes.json()) as {
        itemsClosed: number;
        closureVerifications: { total: number; selfAttestation: number; peerVerified: number };
      };
      expect(liveMetrics.closureVerifications.total).toBe(1);
      expect(liveMetrics.closureVerifications.selfAttestation).toBe(1);

      // Adjourn the meeting + read back the meeting.adjourned chain
      // payload. The closureVerifications dict in the chain payload must
      // match what the metrics endpoint returned pre-adjournment.
      const adjournRes = await app.request(`/api/meetings/${meetingId}/adjourn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
        body: '{}',
      });
      expect(adjournRes.status).toBe(200);
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
      expect(chain[0]!.payload.metrics.closureVerifications.total).toBe(
        liveMetrics.closureVerifications.total,
      );
      expect(chain[0]!.payload.metrics.closureVerifications.selfAttestation).toBe(
        liveMetrics.closureVerifications.selfAttestation,
      );
    });
  },
);
