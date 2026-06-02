// Integration-style unit tests for the Idempotency-Key middleware
// (Milestone 1.10, ADR-0009 §3.4).
//
// Six tests cover the documented cache contract:
//   1. First call: no replay, handler runs, response cached.
//   2. Second call with same key: replay header set, cached body
//      returned, handler does NOT run.
//   3. Third call with same key but different payload_hash: cache
//      miss, handler runs again.
//   4. Fourth call after expires_at: cache miss, handler runs again.
//   5. 500 response: NOT cached (retry-safe semantics).
//   6. 409 response: cached (deterministic conflict).
//
// Skips when DATABASE_URL is unset so the laptop unit-test path stays
// green — mirror of the rest of the integration test fleet.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { bootAuthTestEnv } from '../auth/test-setup';
import { cleanAuthTables, hasDb } from '../auth/test-db';
import { idempotencyKey, IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAY_HEADER } from './idempotency';

const SKIP = !hasDb();

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

let testUserId: string;

beforeEach(async () => {
  if (SKIP) return;
  await cleanAuthTables();
  // Seed a single user so the actor_user_id FK has a real target.
  // Bypass the auth lifecycle (first-run / passkey enrollment) — we
  // only need the row to exist; the test middleware stub injects the
  // userId into c.set('auth', ...) directly.
  const db = getDb();
  const rows = (await db.execute(sql`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `)) as unknown as Array<{ id: string }>;
  testUserId = rows[0]!.id;
});

interface HandlerSpy {
  callCount: number;
  reset(): void;
}

interface TestApp {
  app: Hono;
  spy: HandlerSpy;
}

/** Build a tiny Hono app with the idempotency middleware wired in
 * after a stub authMiddleware that injects c.set('auth', { userId }).
 * The handler returns a 200 with the parsed body's `result` field and
 * increments the spy's call count so tests can assert handler runs vs
 * replays. */
function makeApp(opts?: { status?: number; responseBody?: unknown }): TestApp {
  const status = opts?.status ?? 200;
  const responseBody = opts?.responseBody;
  const spy: HandlerSpy = {
    callCount: 0,
    reset() {
      this.callCount = 0;
    },
  };
  const app = new Hono();
  // Stub authMiddleware — populate c.set('auth') with the seeded
  // testUserId so the idempotency middleware can use it as the cache
  // key's actor scope.
  app.use('*', async (c, next) => {
    c.set('auth', {
      userId: testUserId,
      sessionId: 'test-session',
      stepUpUntil: null,
    });
    await next();
  });
  app.use('*', idempotencyKey());
  app.post('/test/:id', async (c) => {
    spy.callCount += 1;
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    if (responseBody !== undefined) {
      return c.json(responseBody, status as 200);
    }
    return c.json({ result: body.value ?? 'default', id: c.req.param('id') }, status as 200);
  });
  return { app, spy };
}

describe.skipIf(SKIP)('idempotencyKey() middleware (ADR-0009 §3.4)', () => {
  it('first call: no replay header, handler runs, response cached', async () => {
    const { app, spy } = makeApp();
    const res = await app.request('/test/abc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [IDEMPOTENCY_KEY_HEADER]: 'key-001',
      },
      body: JSON.stringify({ clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', value: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull();
    expect(spy.callCount).toBe(1);
    const body = (await res.json()) as { result: string };
    expect(body.result).toBe('hello');

    // Cache row should exist with the correct status_code.
    const db = getDb();
    const cached = (await db.execute(sql`
      SELECT response_status_code FROM sync_idempotency
      WHERE actor_user_id = ${testUserId} AND action_kind = 'POST /test/:id'
    `)) as unknown as Array<{ response_status_code: number }>;
    expect(cached).toHaveLength(1);
    expect(cached[0]!.response_status_code).toBe(200);
  });

  it('second call with same key + body: replay header, handler does NOT run, cached body returned', async () => {
    const { app, spy } = makeApp();
    const payload = JSON.stringify({
      clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      value: 'world',
    });
    await app.request('/test/abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-002' },
      body: payload,
    });
    expect(spy.callCount).toBe(1);

    const res2 = await app.request('/test/abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-002' },
      body: payload,
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe('true');
    expect(spy.callCount).toBe(1); // unchanged — handler did NOT run on replay
    const body2 = (await res2.json()) as { result: string };
    expect(body2.result).toBe('world');
  });

  it('third call with same key but DIFFERENT body: cache miss, handler runs again (payload_hash defense)', async () => {
    const { app, spy } = makeApp();
    // First call: clientId X, value=alpha
    await app.request('/test/xyz', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-003' },
      body: JSON.stringify({
        clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        value: 'alpha',
      }),
    });
    expect(spy.callCount).toBe(1);

    // Second call: clientId Y, value=beta — different payload_hash AND
    // different entity_local_id; this is structurally a new operation,
    // not a replay. Cache MISS by design.
    const res = await app.request('/test/xyz', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-003' },
      body: JSON.stringify({ clientId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', value: 'beta' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull();
    expect(spy.callCount).toBe(2);
  });

  it('call after expires_at: cache miss, handler runs again (TTL refresh)', async () => {
    const { app, spy } = makeApp();
    const payload = JSON.stringify({
      clientId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      value: 'expired',
    });
    await app.request('/test/ttl', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-004' },
      body: payload,
    });
    expect(spy.callCount).toBe(1);

    // Force-expire the cache row.
    const db = getDb();
    await db.execute(sql`
      UPDATE sync_idempotency SET expires_at = now() - INTERVAL '1 hour'
      WHERE actor_user_id = ${testUserId}
    `);

    const res = await app.request('/test/ttl', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-004' },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull();
    expect(spy.callCount).toBe(2);
  });

  it('500 response is NOT cached (retry-safe semantics)', async () => {
    const { app, spy } = makeApp({ status: 500, responseBody: { error: 'internal' } });
    const payload = JSON.stringify({
      clientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      value: 'boom',
    });
    const res = await app.request('/test/err', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-005' },
      body: payload,
    });
    expect(res.status).toBe(500);
    expect(spy.callCount).toBe(1);

    // Verify no cache row was written.
    const db = getDb();
    const cached = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM sync_idempotency
      WHERE actor_user_id = ${testUserId} AND action_kind = 'POST /test/:id'
    `)) as unknown as Array<{ n: number }>;
    expect(cached[0]!.n).toBe(0);

    // Retry produces a fresh handler invocation (the 500 path can
    // succeed on the second try after the server self-heals).
    const res2 = await app.request('/test/err', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-005' },
      body: payload,
    });
    expect(res2.status).toBe(500);
    expect(res2.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull();
    expect(spy.callCount).toBe(2);
  });

  it('409 response IS cached (deterministic conflict — If-Match etag mismatch will recur)', async () => {
    const { app, spy } = makeApp({ status: 409, responseBody: { error: 'version_conflict' } });
    const payload = JSON.stringify({
      clientId: '11111111-1111-4111-8111-111111111111',
      value: 'conflict',
    });
    const res = await app.request('/test/conf', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-006' },
      body: payload,
    });
    expect(res.status).toBe(409);
    expect(spy.callCount).toBe(1);

    // Replay: cached 409 returned without re-running the handler.
    const res2 = await app.request('/test/conf', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'key-006' },
      body: payload,
    });
    expect(res2.status).toBe(409);
    expect(res2.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe('true');
    expect(spy.callCount).toBe(1);
    const body = (await res2.json()) as { error: string };
    expect(body.error).toBe('version_conflict');
  });

  it('no Idempotency-Key header: pass-through, no cache row', async () => {
    const { app, spy } = makeApp();
    const res = await app.request('/test/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'passthrough' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull();
    expect(spy.callCount).toBe(1);
    const db = getDb();
    const cached = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM sync_idempotency`,
    )) as unknown as Array<{
      n: number;
    }>;
    expect(cached[0]!.n).toBe(0);
  });

  it('GET request: pass-through even with Idempotency-Key header', async () => {
    const app = new Hono();
    let calls = 0;
    app.use('*', async (c, next) => {
      c.set('auth', { userId: testUserId, sessionId: 'test', stepUpUntil: null });
      await next();
    });
    app.use('*', idempotencyKey());
    app.get('/test/read', (c) => {
      calls += 1;
      return c.json({ ok: true });
    });
    const res = await app.request('/test/read', {
      method: 'GET',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'should-not-cache' },
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    const db = getDb();
    const cached = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM sync_idempotency`,
    )) as unknown as Array<{
      n: number;
    }>;
    expect(cached[0]!.n).toBe(0);
  });
});
