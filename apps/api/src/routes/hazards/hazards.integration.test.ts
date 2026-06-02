// Integration tests for /api/hazards/* (Milestone 1.5).
// Skips when DATABASE_URL is unset.

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

const SKIP = !hasDb();
const EMAIL = 'cochair@workplace.invalid';
const PASSWORD = 'SafeP@ssword!12345';
const DISPLAY_NAME = 'Worker Co-Chair';

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  _resetRateLimitForTests();
  await cleanAuthTables();
});

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

describe.skipIf(SKIP)('POST /api/hazards', () => {
  it('creates a hazard with hazard_code H-001 and emits hazard.created into the chain', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/hazards', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        cookie,
      },
      body: JSON.stringify({
        title: 'Slip hazard — cooler floor',
        description:
          'Floor near the cooler door is wet from condensation; multiple slips reported.',
        severity: 'high',
        jurisdiction: 'ON',
        locationZone: 'zone_3',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hazardCode: string; status: string; id: string };
    expect(body.hazardCode).toBe('H-001');
    expect(body.status).toBe('open');

    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT kind, payload FROM audit_log WHERE kind = 'hazard.created'
    `)) as unknown as Array<{ kind: string; payload: { hazardCode: string; severity: string } }>;
    expect(chain).toHaveLength(1);
    expect(chain[0]!.payload.hazardCode).toBe('H-001');
    expect(chain[0]!.payload.severity).toBe('high');
    // No PI in the payload.
    expect(JSON.stringify(chain[0]!.payload)).not.toContain('cooler');

    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('rejects a title longer than 120 chars with 400', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/hazards', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'jhsc-web',
        cookie,
      },
      body: JSON.stringify({
        title: 'x'.repeat(121),
        description: 'd',
        severity: 'high',
        jurisdiction: 'ON',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('requires authMiddleware -- no cookie returns 401', async () => {
    const res = await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web' },
      body: JSON.stringify({
        title: 't',
        description: 'd',
        severity: 'low',
        jurisdiction: 'ON',
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(SKIP)('GET /api/hazards (list)', () => {
  it('returns the safe summary and never the reporter_identity', async () => {
    const { cookie } = await loginAsRep();
    await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'WBV exposure — dock cycle',
        description:
          'Long-form description that exceeds eighty characters so the safeSummary trim path runs and the list cannot leak the full body.',
        severity: 'critical',
        jurisdiction: 'ON',
        reporterIdentity: 'Worker named Pat Singh',
      }),
    });
    const res = await app.request('/api/hazards', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        hazardCode: string;
        title: string;
        summary: string;
        severity: string;
        status: string;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.hazardCode).toBe('H-001');
    expect(body.items[0]!.summary.length).toBeLessThanOrEqual(81); // <=80 + ellipsis
    expect(body.items[0]!.summary).toContain('Long-form');
    expect(JSON.stringify(body)).not.toContain('Pat Singh'); // T-H4: reporter never in list
  });
});

describe.skipIf(SKIP)('GET /api/hazards/:id (detail)', () => {
  it('returns the full decrypted description + status history but not reporter identity', async () => {
    const { cookie } = await loginAsRep();
    const createRes = await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'MSD — pick line repetition',
        description: 'Repetitive picking motion at line 3.',
        severity: 'medium',
        jurisdiction: 'ON',
        reporterIdentity: 'Worker named Pat Singh',
      }),
    });
    const { id } = (await createRes.json()) as { id: string };
    const res = await app.request(`/api/hazards/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      description: string;
      history: Array<{ fromStatus: string | null; toStatus: string }>;
      allowedTransitions: string[];
    };
    expect(body.description).toBe('Repetitive picking motion at line 3.');
    expect(body.history).toHaveLength(1);
    expect(body.history[0]!.fromStatus).toBeNull();
    expect(body.history[0]!.toStatus).toBe('open');
    expect(body.allowedTransitions).toEqual(['assessing', 'withdrawn']);
    expect(JSON.stringify(body)).not.toContain('Pat Singh');
  });
});

describe.skipIf(SKIP)('PATCH /api/hazards/:id/status', () => {
  async function createHazard(cookie: string): Promise<string> {
    const res = await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        title: 'Noise — compressor room',
        description: 'Noise survey shows >85 dBA.',
        severity: 'medium',
        jurisdiction: 'ON',
      }),
    });
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it('transitions open -> assessing and emits hazard.status_changed', async () => {
    const { cookie } = await loginAsRep();
    const id = await createHazard(cookie);
    const res = await app.request(`/api/hazards/${id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toStatus: 'assessing' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; allowedTransitions: string[] };
    expect(body.status).toBe('assessing');
    expect(body.allowedTransitions).toEqual(['open', 'assigned', 'withdrawn']);

    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'hazard.status_changed'
    `)) as unknown as Array<{ payload: { fromStatus: string; toStatus: string } }>;
    expect(chain).toHaveLength(1);
    expect(chain[0]!.payload.fromStatus).toBe('open');
    expect(chain[0]!.payload.toStatus).toBe('assessing');
    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('rejects open -> archived with 422 illegal_transition', async () => {
    const { cookie } = await loginAsRep();
    const id = await createHazard(cookie);
    const res = await app.request(`/api/hazards/${id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toStatus: 'archived' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; from: string; to: string };
    expect(body.error).toBe('illegal_transition');
    expect(body.from).toBe('open');
    expect(body.to).toBe('archived');
  });

  it('requires step-up for ->withdrawn (T-H3) and emits the max_age challenge', async () => {
    const { cookie } = await loginAsRep();
    const id = await createHazard(cookie);
    const res = await app.request(`/api/hazards/${id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toStatus: 'withdrawn', reason: 'duplicate of H-002' }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate');
    expect(challenge).toMatch(/StepUp/);
    // sec-F3: the freshness-floor middleware emits max_age explicitly.
    expect(challenge).toMatch(/max_age="60"/);
    const body = (await res.json()) as { error: string; action: string };
    expect(body.error).toBe('step_up_required');
    expect(body.action).toBe('hazard.status_change.withdrawn');
  });

  it('returns 404 for an unknown hazard id', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/hazards/00000000-0000-0000-0000-000000000000/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toStatus: 'assessing' }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 1.10 (ADR-0009 §3.3): clientId ratchet — the row's id is the canonical
// _local_id from the rep's device. Same-clientId + same-actor returns 200
// with the same row (queue retry / two-device race). Same-clientId +
// different payload but same-actor returns 200 because the existing row
// still belongs to the actor (S2's If-Match etag is the source of truth
// for PATCH-level conflicts; the ratchet itself is content-blind).
// Cross-actor reuse returns 409 client_id_conflict.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /api/hazards — clientId idempotency (1.10 S1)', () => {
  const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
  const basePayload = {
    title: 'WBV exposure',
    description: 'Long-form WBV exposure description for the dock cycle.',
    severity: 'high' as const,
    jurisdiction: 'ON' as const,
  };

  it('first POST with clientId returns 200 and uses clientId as the row id', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ ...basePayload, clientId: CLIENT_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; hazardCode: string };
    expect(body.id).toBe(CLIENT_ID);
    expect(body.hazardCode).toBe('H-001');
  });

  it('second POST with same clientId + same payload returns 200 with the existing row id', async () => {
    const { cookie } = await loginAsRep();
    await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ ...basePayload, clientId: CLIENT_ID }),
    });
    const res = await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ ...basePayload, clientId: CLIENT_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; hazardCode: string };
    expect(body.id).toBe(CLIENT_ID);
    // The sequence didn't advance — only one hazard row exists.
    expect(body.hazardCode).toBe('H-001');
  });

  it('absent clientId falls back to gen_random_uuid() default', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/hazards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify(basePayload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    // UUID v4 from gen_random_uuid().
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.id).not.toBe(CLIENT_ID);
  });
});
