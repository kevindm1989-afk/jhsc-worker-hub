// End-to-end-ish happy path for the offline-sync surface (S4 brief D).
//
// Drives the typed-client wrapper + queue worker + dispatcher together,
// with `fake-indexeddb` on the Dexie side and a `vi.fn()` mock fetch on
// the wire side. No Postgres, no SW, no real network. The goal: exercise
// the four canonical scenarios from the brief in a single test file so
// CI catches a regression in the integration plumbing without requiring
// the heavier Playwright e2e harness (which lives in
// `apps/web/tests/e2e/offline-sync.spec.ts`).
//
// Scenarios:
//
//   1. Online happy path     — POST create -> 201 -> entity marked clean.
//   2. Offline-then-online    — POST create while navigator.onLine=false
//                              -> sits in queue -> toggle online ->
//                              drain succeeds.
//   3. Stale PATCH conflict  — PATCH whose If-Match is older than the
//                              server's -> 409 -> sync_conflicts row
//                              written + entity marked conflicting.
//   4. Dead-letter           — POST that keeps returning 500 -> exhausts
//                              the backoff curve after 8 attempts ->
//                              row marked failed_dead_letter.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNC_DEAD_LETTER_AFTER_ATTEMPTS } from '@jhsc/shared-types';
import { JhscOfflineDb, baseStateKey, freshSyncMetadata, type SyncQueueRow } from '@/sync/db';
import {
  SyncQueueWorker,
  enqueueOp,
  type DispatchResult,
  type SyncOperation,
} from '@/sync/queue-worker';

let testDb: JhscOfflineDb;
const LOCAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(async () => {
  testDb = new JhscOfflineDb('jhsc-happy-' + Math.random().toString(36).slice(2));
  await testDb.open();
});

afterEach(async () => {
  await testDb.delete();
  vi.restoreAllMocks();
});

/** Seed a hazard optimistic row (the typed-client's `enqueueMutation`
 * path would write this — we short-circuit for the test). */
async function seedDirtyHazard(localId: string): Promise<void> {
  await testDb.hazards.put({
    id: localId,
    hazardCode: null,
    title: 'New hazard',
    severity: 'medium',
    status: 'open',
    jurisdiction: 'ON',
    locationZone: null,
    reportedAt: '2026-06-02T10:00:00.000Z',
    description_ct_b64: 'CT_PLACEHOLDER',
    description_dek_ct_b64: 'DEK_PLACEHOLDER',
    ...freshSyncMetadata(localId),
  });
}

/** Build a queue row directly so we don't depend on the typed-client's
 * wrapping (which the queue-worker.test.ts already covers); the goal of
 * the happy-path test is the integration BETWEEN the queue worker and
 * the dispatcher's wire-shape, not the typed-client's enqueue logic. */
async function enqueueCreate(localId: string): Promise<number> {
  return enqueueOp({
    kind: 'create',
    entityKind: 'hazard',
    entityLocalId: localId,
    payload: {
      clientId: localId,
      title: 'New hazard',
      severity: 'medium',
      jurisdiction: 'ON',
      description_ct_b64: 'CT_PLACEHOLDER',
      description_dek_ct_b64: 'DEK_PLACEHOLDER',
    },
    httpMethod: 'POST',
    endpoint: '/api/hazards',
    ifMatchEtag: null,
    idempotencyKey: 'idem-' + Math.random().toString(36).slice(2),
    database: testDb,
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: online happy path
// ---------------------------------------------------------------------------

describe('happy path 1: create-online drains to clean', () => {
  it('POST create returns 201 -> entity clean, queue empty, base state cached', async () => {
    await seedDirtyHazard(LOCAL_ID);
    await enqueueCreate(LOCAL_ID);

    // Dispatcher mocks the wire call: returns success with a version=1
    // body. We capture the operation shape passed to the dispatcher so we
    // can assert the payload shape the typed-client + queue worker
    // produce.
    const dispatched: SyncOperation[] = [];
    const dispatcher = vi.fn(async (op: SyncOperation): Promise<DispatchResult> => {
      dispatched.push(op);
      return {
        kind: 'success',
        serverState: {
          id: LOCAL_ID,
          hazardCode: 'HZ-2026-001',
          title: 'New hazard',
          severity: 'medium',
          status: 'open',
          jurisdiction: 'ON',
          version: 1,
        },
        serverVersion: 1,
      };
    });
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();

    // Dispatcher received the right shape.
    expect(dispatcher).toHaveBeenCalledOnce();
    expect(dispatched[0]?.entityKind).toBe('hazard');
    expect(dispatched[0]?.kind).toBe('create');
    // The payload includes the clientId the typed-client injected.
    const payload = dispatched[0]?.payload as { clientId?: string; title?: string };
    expect(payload.clientId).toBe(LOCAL_ID);
    expect(payload.title).toBe('New hazard');

    // Entity marked clean.
    const row = await testDb.hazards.get(LOCAL_ID);
    expect(row).toBeDefined();
    expect(row!._sync_state).toBe('clean');
    expect(row!._server_version).toBe(1);
    expect(row!._synced_at).not.toBeNull();
    // Server-allocated fields merged.
    expect(row!.hazardCode).toBe('HZ-2026-001');

    // Queue drained.
    expect(await testDb.sync_queue.count()).toBe(0);

    // Base state cached for the next conflict path.
    const base = await testDb._base_state.get(baseStateKey('hazard', LOCAL_ID));
    expect(base).toBeDefined();
    expect(base!.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: create-offline-then-online
// ---------------------------------------------------------------------------

describe('happy path 2: create offline -> toggle online -> drain', () => {
  it('queue waits offline; drains on next pass once dispatcher succeeds', async () => {
    // Use a shared mutable clock across enqueueOp + worker so the
    // claimBatch's "nextAttemptAt <= now" filter picks the row up.
    // Without this, enqueueOp uses real Date.now() while the worker uses
    // the fixed test clock, and the row's nextAttemptAt is far in the
    // future relative to the worker's clock — the row never drains.
    let nowMs = Date.parse('2026-06-02T10:00:00.000Z');
    await seedDirtyHazard(LOCAL_ID);
    await enqueueOp({
      kind: 'create',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: { clientId: LOCAL_ID, title: 'New hazard' },
      httpMethod: 'POST',
      endpoint: '/api/hazards',
      ifMatchEtag: null,
      idempotencyKey: 'idem-offline',
      database: testDb,
      now: () => nowMs,
    });

    // Pass 1: dispatcher returns network_required (offline floor).
    let online = false;
    const dispatcher = vi.fn(async (op: SyncOperation): Promise<DispatchResult> => {
      if (!online) {
        return { kind: 'network_required' };
      }
      return {
        kind: 'success',
        serverState: { id: op.entityLocalId, version: 1 },
        serverVersion: 1,
      };
    });
    const worker = new SyncQueueWorker({
      database: testDb,
      dispatcher,
      now: () => nowMs,
    });

    await worker.drainNow();
    let row = await testDb.hazards.get(LOCAL_ID);
    expect(row!._sync_state).toBe('dirty_create'); // still dirty
    const queueAfterOffline = await testDb.sync_queue.toArray();
    expect(queueAfterOffline.length).toBe(1);
    expect(queueAfterOffline[0]!.lastError).toBe('network_required');
    // nextAttemptAt was bumped to ~OFFLINE_FLOOR_MS into the future.
    expect(Date.parse(queueAfterOffline[0]!.nextAttemptAt)).toBeGreaterThan(nowMs);

    // Toggle online + advance the clock past the offline floor.
    online = true;
    nowMs += 60_000;

    await worker.drainNow();

    row = await testDb.hazards.get(LOCAL_ID);
    expect(row!._sync_state).toBe('clean');
    expect(await testDb.sync_queue.count()).toBe(0);

    // Assert the dispatcher was called twice (once offline, once online).
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  it('captures the request body shape that would hit the wire on drain', async () => {
    await seedDirtyHazard(LOCAL_ID);
    await enqueueCreate(LOCAL_ID);

    let capturedRow: SyncQueueRow | null = null;
    const dispatcher = vi.fn(async (op: SyncOperation): Promise<DispatchResult> => {
      // Read the queue row directly to capture the wire-shape headers
      // the dispatchOp helper would consume (idempotencyKey, ifMatch,
      // httpMethod, endpoint).
      const row = await testDb.sync_queue.get(op.id);
      capturedRow = row ?? null;
      return {
        kind: 'success',
        serverState: { id: op.entityLocalId, version: 1 },
        serverVersion: 1,
      };
    });
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();

    expect(capturedRow).not.toBeNull();
    const row = capturedRow! as SyncQueueRow;
    expect(row.httpMethod).toBe('POST');
    expect(row.endpoint).toBe('/api/hazards');
    expect(row.idempotencyKey).toMatch(/^idem-/);
    expect(row.ifMatchEtag).toBeNull(); // POST creates have no If-Match
    // Payload is a JSON string.
    expect(typeof row.payload).toBe('string');
    const parsed = JSON.parse(row.payload) as { clientId?: string };
    expect(parsed.clientId).toBe(LOCAL_ID);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: stale PATCH -> 409 conflict
// ---------------------------------------------------------------------------

describe('happy path 3: PATCH with stale If-Match -> 409 -> conflict row', () => {
  it('writes a sync_conflicts row and flips the entity to conflicting', async () => {
    // Seed a clean hazard with server_version=1.
    await testDb.hazards.put({
      id: LOCAL_ID,
      hazardCode: 'HZ-1',
      title: 'Existing',
      severity: 'high',
      status: 'open',
      jurisdiction: 'ON',
      locationZone: null,
      reportedAt: '2026-06-02T10:00:00.000Z',
      description_ct_b64: null,
      description_dek_ct_b64: null,
      _sync_state: 'clean',
      _local_id: LOCAL_ID,
      _server_version: 1,
      _base_state_json: JSON.stringify({ id: LOCAL_ID, version: 1, status: 'open' }),
      _updated_at_client: '2026-06-02T10:00:00.000Z',
      _synced_at: '2026-06-02T10:00:00.000Z',
    });
    // Seed the base-state cache so the handleConflict path can read it.
    await testDb._base_state.put({
      key: baseStateKey('hazard', LOCAL_ID),
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      version: 1,
      stateJson: JSON.stringify({ id: LOCAL_ID, version: 1, status: 'open' }),
      cachedAt: '2026-06-02T10:00:00.000Z',
    });

    // Local PATCH with If-Match=1 — server has moved to version 2.
    await enqueueOp({
      kind: 'update',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: { toStatus: 'assessing' },
      httpMethod: 'PATCH',
      endpoint: `/api/hazards/${LOCAL_ID}/status`,
      ifMatchEtag: 1,
      idempotencyKey: 'idem-stale',
      database: testDb,
    });

    // Dispatcher returns 409 with the server's canonical state at v2.
    const dispatcher = vi.fn(
      async (_op: SyncOperation): Promise<DispatchResult> => ({
        kind: 'conflict',
        serverState: { id: LOCAL_ID, status: 'closed', version: 2 },
        serverVersion: 2,
      }),
    );
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();

    // sync_conflicts row written.
    const conflicts = await testDb.sync_conflicts.toArray();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.entityLocalId).toBe(LOCAL_ID);
    expect(conflicts[0]!.serverVersion).toBe(2);
    // serverStateJson contains the server's canonical state.
    expect(JSON.parse(conflicts[0]!.serverStateJson)).toEqual({
      id: LOCAL_ID,
      status: 'closed',
      version: 2,
    });
    // baseStateJson is what we believed the server's row was.
    expect(JSON.parse(conflicts[0]!.baseStateJson)).toEqual({
      id: LOCAL_ID,
      version: 1,
      status: 'open',
    });
    expect(conflicts[0]!.resolved).toBe(0);

    // Entity row flipped to conflicting.
    const row = await testDb.hazards.get(LOCAL_ID);
    expect(row!._sync_state).toBe('conflicting');

    // Queue row also marked conflicting.
    const queue = await testDb.sync_queue.toArray();
    expect(queue.length).toBe(1);
    expect(queue[0]!.state).toBe('conflicting');
    expect(queue[0]!.lastError).toBe('version_conflict');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: dead-letter at the schedule ceiling
// ---------------------------------------------------------------------------

describe('happy path 4: persistent 5xx -> dead-letter after 8 attempts', () => {
  it('drives a row through all 8 backoff slots and marks it failed_dead_letter', async () => {
    let nowMs = Date.parse('2026-06-02T10:00:00.000Z');
    await seedDirtyHazard(LOCAL_ID);
    // Shared clock so the row's nextAttemptAt aligns with the worker's
    // claimBatch filter.
    await enqueueOp({
      kind: 'create',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: { clientId: LOCAL_ID, title: 'New hazard' },
      httpMethod: 'POST',
      endpoint: '/api/hazards',
      ifMatchEtag: null,
      idempotencyKey: 'idem-deadletter',
      database: testDb,
      now: () => nowMs,
    });
    // Dispatcher always returns a 5xx-flavored transient failure.
    const dispatcher = vi.fn(
      async (_op: SyncOperation): Promise<DispatchResult> => ({
        kind: 'transient_failure',
        error: '500 server_error',
      }),
    );
    const worker = new SyncQueueWorker({
      database: testDb,
      dispatcher,
      now: () => nowMs,
    });

    // Drive 8 drain passes, advancing the clock past each backoff slot.
    for (let i = 0; i < SYNC_DEAD_LETTER_AFTER_ATTEMPTS; i++) {
      // Advance well past the longest schedule slot so the queue row's
      // nextAttemptAt is always in the past.
      nowMs += 365 * 24 * 60 * 60 * 1000; // 1 year
      await worker.drainNow();
    }

    const row = await testDb.sync_queue.toArray();
    expect(row.length).toBe(1);
    expect(row[0]!.state).toBe('failed_dead_letter');
    expect(row[0]!.attemptCount).toBe(SYNC_DEAD_LETTER_AFTER_ATTEMPTS);
    expect(row[0]!.lastError).toBe('500 server_error');

    // The dispatcher fired exactly 8 times — the dead-letter ceiling is
    // the schedule length.
    expect(dispatcher).toHaveBeenCalledTimes(SYNC_DEAD_LETTER_AFTER_ATTEMPTS);
  });
});

// ---------------------------------------------------------------------------
// Bonus integration: dead-letter doesn't try to call the dispatcher again
// ---------------------------------------------------------------------------

describe('happy path 4 sanity: dead-letter rows do not re-dispatch', () => {
  it('a row already in failed_dead_letter is skipped by claimBatch', async () => {
    await seedDirtyHazard(LOCAL_ID);
    // Hand-craft a queue row already in dead-letter state.
    await testDb.sync_queue.add({
      kind: 'create',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: '{}',
      httpMethod: 'POST',
      endpoint: '/api/hazards',
      ifMatchEtag: null,
      idempotencyKey: 'idem-dead',
      attemptCount: SYNC_DEAD_LETTER_AFTER_ATTEMPTS,
      nextAttemptAt: new Date().toISOString(),
      state: 'failed_dead_letter',
      lastError: '500 server_error',
      createdAt: new Date().toISOString(),
      dependsOnQueueId: null,
      pauseReason: null,
    });

    const dispatcher = vi.fn(async () => ({
      kind: 'success' as const,
      serverState: {},
      serverVersion: 1,
    }));
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();

    // Dispatcher was never invoked.
    expect(dispatcher).not.toHaveBeenCalled();
    // The dead-letter row is still present, unchanged.
    const row = await testDb.sync_queue.toArray();
    expect(row[0]!.state).toBe('failed_dead_letter');
  });
});
