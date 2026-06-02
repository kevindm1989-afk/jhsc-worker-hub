// Integration tests for /api/action-items/* (Milestone 1.6).
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

async function createItem(
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; sequenceNumber: number; section: string }> {
  const res = await app.request('/api/action-items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
    body: JSON.stringify({
      type: 'INSIGHT',
      description: 'Workers report difficulty hearing PA announcements over forklift noise.',
      status: 'Not Started',
      risk: 'Medium',
      section: 'new_business',
      startDate: new Date().toISOString().slice(0, 10),
      ...overrides,
    }),
  });
  return (await res.json()) as { id: string; sequenceNumber: number; section: string };
}

describe.skipIf(SKIP)('POST /api/action-items', () => {
  it('creates with sequence_number=1 and emits action_item.created', async () => {
    const { cookie } = await loginAsRep();
    const r = await createItem(cookie);
    expect(r.sequenceNumber).toBe(1);
    expect(r.section).toBe('new_business');
    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'action_item.created'
    `)) as unknown as Array<{ payload: { itemType: string; section: string; risk: string } }>;
    expect(chain).toHaveLength(1);
    expect(chain[0]!.payload.itemType).toBe('INSIGHT');
    expect(chain[0]!.payload.section).toBe('new_business');
    expect(JSON.stringify(chain[0]!.payload)).not.toContain('Workers report');
    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('allocates per-section sequence numbers independently', async () => {
    const { cookie } = await loginAsRep();
    const a = await createItem(cookie, { section: 'new_business' });
    const b = await createItem(cookie, { section: 'old_business' });
    const c = await createItem(cookie, { section: 'new_business' });
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(1);
    expect(c.sequenceNumber).toBe(2);
  });

  it('requires typeSubtype when type=OTHER', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        type: 'OTHER',
        description: 'd',
        status: 'Not Started',
        risk: 'Low',
        section: 'new_business',
        startDate: '2026-05-29',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('priv-AI-F3 / sec-F7 1.6: rejects sourceType=recommendation until 1.9 trigger lands', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({
        type: 'INSIGHT',
        description: 'd',
        status: 'Not Started',
        risk: 'Low',
        section: 'new_business',
        startDate: '2026-05-29',
        sourceType: 'recommendation',
        sourceId: '00000000-0000-0000-0000-000000000000',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web' },
      body: JSON.stringify({
        type: 'INSIGHT',
        description: 'd',
        status: 'Not Started',
        risk: 'Low',
        section: 'new_business',
        startDate: '2026-05-29',
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(SKIP)('GET /api/action-items', () => {
  it('returns safe summary, Action Flag, and never leaks raised_by', async () => {
    const { cookie } = await loginAsRep();
    await createItem(cookie, {
      raisedBy: 'A specific worker name',
      description: 'PA system inaudible in cooler over forklift noise.',
    });
    const res = await app.request('/api/action-items', { headers: { cookie } });
    const body = (await res.json()) as {
      items: Array<{
        summary: string;
        flag: { kind: string } | null;
        section: string;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.summary).toContain('PA');
    expect(body.items[0]!.flag?.kind).toBe('aging_under_21');
    expect(JSON.stringify(body)).not.toContain('A specific worker name');
  });

  it('filters by section[]', async () => {
    const { cookie } = await loginAsRep();
    await createItem(cookie, { section: 'new_business' });
    await createItem(cookie, { section: 'old_business' });
    const res = await app.request('/api/action-items?section=old_business', {
      headers: { cookie },
    });
    const body = (await res.json()) as { items: Array<{ section: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.section).toBe('old_business');
  });
});

describe.skipIf(SKIP)('GET /api/action-items/:id', () => {
  it('returns full decrypted detail + history + Action Flag + allowedTransitions', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie, {
      description: 'detail decrypted body',
      recommendedAction: 'install signage',
    });
    const res = await app.request(`/api/action-items/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      description: string;
      recommendedAction: string | null;
      allowedTransitions: string[];
      history: Array<{ fromSection: string | null; toSection: string }>;
      flag: { kind: string } | null;
    };
    expect(body.description).toBe('detail decrypted body');
    expect(body.recommendedAction).toBe('install signage');
    expect(body.allowedTransitions).toContain('old_business');
    expect(body.history).toHaveLength(1);
    expect(body.history[0]!.fromSection).toBeNull();
    expect(body.history[0]!.toSection).toBe('new_business');
    expect(body.flag?.kind).toBe('aging_under_21');
  });
});

describe.skipIf(SKIP)('PATCH /api/action-items/:id', () => {
  it('updates status + risk and emits action_item.updated with changedFields', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie);
    const res = await app.request(`/api/action-items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ status: 'In Progress', risk: 'High' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changedFields: string[] };
    expect(body.changedFields).toEqual(expect.arrayContaining(['status', 'risk']));
    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'action_item.updated'
    `)) as unknown as Array<{ payload: { changedFields: string[] } }>;
    expect(chain[0]!.payload.changedFields).toContain('status');
    expect(chain[0]!.payload.changedFields).toContain('risk');
    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('sec-review F1 / priv-AI-F2 1.6: closedDate PATCH emits closed_date in changedFields', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie);
    const res = await app.request(`/api/action-items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ status: 'Closed', closedDate: '2026-05-29' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changedFields: string[] };
    expect(body.changedFields).toEqual(expect.arrayContaining(['status', 'closed_date']));
    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'action_item.updated' ORDER BY idx DESC LIMIT 1
    `)) as unknown as Array<{ payload: { changedFields: string[] } }>;
    expect(chain[0]!.payload.changedFields).toContain('closed_date');
  });

  it('returns 400 no_changes when the body is empty', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie);
    const res = await app.request(`/api/action-items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(SKIP)('POST /api/action-items/:id/moves', () => {
  it('transitions new_business -> old_business and emits action_item.moved', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie);
    const res = await app.request(`/api/action-items/${id}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toSection: 'old_business' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { section: string; allowedTransitions: string[] };
    expect(body.section).toBe('old_business');
    expect(body.allowedTransitions).toEqual([
      'completed_this_period',
      'archived',
      'recommendation',
    ]);
    const db = getDb();
    const chain = (await db.execute(sql`
      SELECT payload FROM audit_log WHERE kind = 'action_item.moved'
    `)) as unknown as Array<{ payload: { fromSection: string; toSection: string } }>;
    expect(chain[0]!.payload.fromSection).toBe('new_business');
    expect(chain[0]!.payload.toSection).toBe('old_business');
  });

  it('rejects illegal moves with 422', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie, { section: 'archived' });
    const res = await app.request(`/api/action-items/${id}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toSection: 'completed_this_period' }),
    });
    expect(res.status).toBe(422);
  });

  it('requires step-up for ->archived', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie);
    const res = await app.request(`/api/action-items/${id}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toSection: 'archived' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/max_age="60"/);
  });

  it('sec-review F2 1.6: move re-allocates sequence_number in the destination section', async () => {
    const { cookie } = await loginAsRep();
    // A and B both get seq=1 in their own sections.
    const a = await createItem(cookie, { section: 'new_business' });
    const b = await createItem(cookie, { section: 'old_business' });
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(1);
    // Move A to old_business. Pre-fix this UPDATE collided with B at
    // (old_business, 1) and 500'd. Post-fix A gets seq=2 in old_business.
    const res = await app.request(`/api/action-items/${a.id}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ toSection: 'old_business' }),
    });
    expect(res.status).toBe(200);
    // Fetch A's detail and confirm the new sequence_number.
    const detail = (await (
      await app.request(`/api/action-items/${a.id}`, { headers: { cookie } })
    ).json()) as { section: string; sequenceNumber: number };
    expect(detail.section).toBe('old_business');
    expect(detail.sequenceNumber).toBe(2);
  });
});

describe.skipIf(SKIP)('POST /api/action-items/:id/moves/:moveId/undo', () => {
  it('requires step-up auth (always destructive)', async () => {
    const { cookie } = await loginAsRep();
    const { id } = await createItem(cookie);
    const detail = (await (
      await app.request(`/api/action-items/${id}`, { headers: { cookie } })
    ).json()) as { history: Array<{ id: string }> };
    const moveId = detail.history[0]!.id;
    const res = await app.request(`/api/action-items/${id}/moves/${moveId}/undo`, {
      method: 'POST',
      headers: { 'x-requested-with': 'jhsc-web', cookie },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/StepUp/);
  });
});

// ---------------------------------------------------------------------------
// 1.10 (ADR-0009 §3.3): clientId ratchet for POST /api/action-items.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /api/action-items — clientId idempotency (1.10 S1)', () => {
  const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
  const basePayload = {
    type: 'INSIGHT' as const,
    description: 'Action item description for the clientId ratchet test.',
    status: 'Not Started' as const,
    risk: 'Medium' as const,
    section: 'new_business' as const,
    startDate: '2026-05-29',
  };

  it('first POST with clientId returns the row using clientId as the id', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ ...basePayload, clientId: CLIENT_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; sequenceNumber: number };
    expect(body.id).toBe(CLIENT_ID);
    expect(body.sequenceNumber).toBe(1);
  });

  it('second POST with same clientId returns the existing row at 200 without bumping sequence', async () => {
    const { cookie } = await loginAsRep();
    await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ ...basePayload, clientId: CLIENT_ID }),
    });
    const res = await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify({ ...basePayload, clientId: CLIENT_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; sequenceNumber: number };
    expect(body.id).toBe(CLIENT_ID);
    expect(body.sequenceNumber).toBe(1);
  });

  it('absent clientId falls back to gen_random_uuid()', async () => {
    const { cookie } = await loginAsRep();
    const res = await app.request('/api/action-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'jhsc-web', cookie },
      body: JSON.stringify(basePayload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.id).not.toBe(CLIENT_ID);
  });
});
