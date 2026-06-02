// Unit tests for the sync queue worker (Milestone 1.10 S2).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_BACKOFF_SCHEDULE,
  SYNC_DEAD_LETTER_AFTER_ATTEMPTS,
  computeNextBackoff,
} from '@jhsc/shared-types';
import { JhscOfflineDb, freshSyncMetadata } from './db';
import {
  SyncQueueWorker,
  enqueueOp,
  type DispatchResult,
  type SyncOperation,
} from './queue-worker';

let testDb: JhscOfflineDb;

const LOCAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCAL_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOCAL_ID_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(async () => {
  testDb = new JhscOfflineDb('jhsc-test-qw-' + Math.random().toString(36).slice(2));
  await testDb.open();
});

afterEach(async () => {
  await testDb.delete();
});

async function seedHazard(localId: string): Promise<void> {
  await testDb.hazards.put({
    id: localId,
    hazardCode: null,
    title: 'Test',
    severity: 'high',
    status: 'open',
    jurisdiction: 'ON',
    locationZone: null,
    reportedAt: '2026-06-02T10:00:00.000Z',
    description_ct_b64: null,
    description_dek_ct_b64: null,
    ...freshSyncMetadata(localId),
  });
}

describe('computeNextBackoff (shared-types pure fn, used by the worker)', () => {
  it('matches the published SYNC_BACKOFF_SCHEDULE', () => {
    for (let i = 0; i < SYNC_BACKOFF_SCHEDULE.length; i++) {
      expect(computeNextBackoff(i)).toBe(SYNC_BACKOFF_SCHEDULE[i]);
    }
  });

  it('returns null at the dead-letter ceiling', () => {
    expect(computeNextBackoff(SYNC_DEAD_LETTER_AFTER_ATTEMPTS)).toBeNull();
    expect(computeNextBackoff(99)).toBeNull();
  });
});

describe('SyncQueueWorker.drainNow', () => {
  it('success path: marks entity clean + deletes queue row + refreshes base state', async () => {
    await seedHazard(LOCAL_ID);
    await enqueueOp({
      kind: 'update',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: { toStatus: 'assessing' },
      httpMethod: 'PATCH',
      endpoint: `/api/hazards/${LOCAL_ID}/status`,
      ifMatchEtag: 0,
      idempotencyKey: 'idem-1',
      database: testDb,
    });

    const dispatcher = vi.fn(
      async (_op: SyncOperation): Promise<DispatchResult> => ({
        kind: 'success',
        serverState: { id: LOCAL_ID, status: 'assessing', version: 1 },
        serverVersion: 1,
      }),
    );
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();

    expect(dispatcher).toHaveBeenCalledOnce();
    expect(await testDb.sync_queue.count()).toBe(0);
    const row = await testDb.hazards.get(LOCAL_ID);
    expect(row!._sync_state).toBe('clean');
    expect(row!._server_version).toBe(1);
    expect(row!.status).toBe('assessing');

    const base = await testDb._base_state.get(`hazard:${LOCAL_ID}`);
    expect(base).toBeDefined();
    expect(base!.version).toBe(1);
  });

  it('409 conflict path: writes sync_conflicts row + flips entity to conflicting', async () => {
    await seedHazard(LOCAL_ID);
    await enqueueOp({
      kind: 'update',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: { toStatus: 'assessing' },
      httpMethod: 'PATCH',
      endpoint: `/api/hazards/${LOCAL_ID}/status`,
      ifMatchEtag: 0,
      idempotencyKey: 'idem-conflict',
      database: testDb,
    });

    const dispatcher = vi.fn(
      async (_op: SyncOperation): Promise<DispatchResult> => ({
        kind: 'conflict',
        serverState: { id: LOCAL_ID, status: 'assigned', version: 5 },
        serverVersion: 5,
      }),
    );
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();

    const queueRow = await testDb.sync_queue.toCollection().first();
    expect(queueRow!.state).toBe('conflicting');

    const conflicts = await testDb.sync_conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.entityKind).toBe('hazard');
    expect(conflicts[0]!.entityLocalId).toBe(LOCAL_ID);
    expect(conflicts[0]!.serverVersion).toBe(5);

    const entity = await testDb.hazards.get(LOCAL_ID);
    expect(entity!._sync_state).toBe('conflicting');
  });

  it('transient_failure path: bumps attemptCount + computes next backoff', async () => {
    await seedHazard(LOCAL_ID);
    await enqueueOp({
      kind: 'update',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: { toStatus: 'assessing' },
      httpMethod: 'PATCH',
      endpoint: `/api/hazards/${LOCAL_ID}/status`,
      ifMatchEtag: 0,
      idempotencyKey: 'idem-transient',
      database: testDb,
      now: () => Date.parse('2026-06-02T10:00:00.000Z'),
    });

    const fixedNow = (): number => Date.parse('2026-06-02T10:00:00.000Z');
    const dispatcher = vi.fn(
      async (_op: SyncOperation): Promise<DispatchResult> => ({
        kind: 'transient_failure',
        error: '503',
      }),
    );
    const worker = new SyncQueueWorker({ database: testDb, dispatcher, now: fixedNow });
    await worker.drainNow();

    const queueRow = await testDb.sync_queue.toCollection().first();
    expect(queueRow!.state).toBe('queued');
    expect(queueRow!.attemptCount).toBe(1);
    // After attempt 1 the next delay is SYNC_BACKOFF_SCHEDULE[1] = 5s.
    const expectedNext = new Date(fixedNow() + SYNC_BACKOFF_SCHEDULE[1]! * 1000).toISOString();
    expect(queueRow!.nextAttemptAt).toBe(expectedNext);
  });

  it('dead-letters after SYNC_DEAD_LETTER_AFTER_ATTEMPTS attempts', async () => {
    await seedHazard(LOCAL_ID);
    await enqueueOp({
      kind: 'update',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: {},
      httpMethod: 'PATCH',
      endpoint: `/api/hazards/${LOCAL_ID}/status`,
      ifMatchEtag: 0,
      idempotencyKey: 'idem-dl',
      database: testDb,
    });
    // Inject the attemptCount at one less than the ceiling. The field is
    // typed `readonly` for module-external safety, but the modify
    // callback is operating on the in-IDB copy + we own this test.
    await testDb.sync_queue.toCollection().modify((r) => {
      (r as { attemptCount: number }).attemptCount = SYNC_DEAD_LETTER_AFTER_ATTEMPTS - 1;
    });

    const dispatcher = vi.fn(
      async (_op: SyncOperation): Promise<DispatchResult> => ({
        kind: 'transient_failure',
        error: '500',
      }),
    );
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();

    const queueRow = await testDb.sync_queue.toCollection().first();
    expect(queueRow!.state).toBe('failed_dead_letter');
    expect(queueRow!.attemptCount).toBe(SYNC_DEAD_LETTER_AFTER_ATTEMPTS);
  });

  it('network_required: extends backoff to offline floor', async () => {
    await seedHazard(LOCAL_ID);
    const fixedNow = (): number => Date.parse('2026-06-02T10:00:00.000Z');
    await enqueueOp({
      kind: 'create',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: {},
      httpMethod: 'POST',
      endpoint: '/api/hazards',
      ifMatchEtag: null,
      idempotencyKey: 'idem-net',
      database: testDb,
      now: fixedNow,
    });
    const dispatcher = vi.fn(
      async (_op: SyncOperation): Promise<DispatchResult> => ({ kind: 'network_required' }),
    );
    const worker = new SyncQueueWorker({ database: testDb, dispatcher, now: fixedNow });
    await worker.drainNow();
    const queueRow = await testDb.sync_queue.toCollection().first();
    expect(queueRow!.lastError).toBe('network_required');
    // The next attempt is offset by OFFLINE_FLOOR_MS (30s).
    const next = Date.parse(queueRow!.nextAttemptAt);
    expect(next - fixedNow()).toBe(30_000);
  });
});

describe('enqueueOp FK-dependency ordering', () => {
  it('with a queued parent: child gets dependsOnQueueId + nextAttemptAt past parent', async () => {
    const parentNow = Date.parse('2026-06-02T10:00:00.000Z');
    const parentId = await enqueueOp({
      kind: 'create',
      entityKind: 'inspection',
      entityLocalId: LOCAL_ID_2,
      payload: {},
      httpMethod: 'POST',
      endpoint: '/api/inspections',
      ifMatchEtag: null,
      idempotencyKey: 'idem-parent',
      database: testDb,
      now: () => parentNow,
    });

    // Pin the parent's nextAttemptAt to a known future point.
    await testDb.sync_queue.update(parentId, {
      nextAttemptAt: new Date(parentNow + 5_000).toISOString(),
    });

    const childId = await enqueueOp({
      kind: 'create',
      entityKind: 'inspection_finding',
      entityLocalId: LOCAL_ID_3,
      payload: {},
      httpMethod: 'POST',
      endpoint: `/api/inspections/${LOCAL_ID_2}/findings`,
      ifMatchEtag: null,
      idempotencyKey: 'idem-child',
      database: testDb,
      parentEntityLocalId: LOCAL_ID_2,
      parentEntityKind: 'inspection',
      now: () => parentNow,
    });
    const child = await testDb.sync_queue.get(childId);
    expect(child!.dependsOnQueueId).toBe(parentId);
    // Child's nextAttemptAt is past the parent's.
    expect(Date.parse(child!.nextAttemptAt)).toBeGreaterThan(parentNow + 5_000);
  });

  it('with a conflicting parent: child is paused with parent_conflict', async () => {
    const parentId = await enqueueOp({
      kind: 'create',
      entityKind: 'inspection',
      entityLocalId: LOCAL_ID_2,
      payload: {},
      httpMethod: 'POST',
      endpoint: '/api/inspections',
      ifMatchEtag: null,
      idempotencyKey: 'idem-parent-conflict',
      database: testDb,
    });
    await testDb.sync_queue.update(parentId, { state: 'conflicting' });

    const childId = await enqueueOp({
      kind: 'create',
      entityKind: 'inspection_finding',
      entityLocalId: LOCAL_ID_3,
      payload: {},
      httpMethod: 'POST',
      endpoint: `/api/inspections/${LOCAL_ID_2}/findings`,
      ifMatchEtag: null,
      idempotencyKey: 'idem-child-paused',
      database: testDb,
      parentEntityLocalId: LOCAL_ID_2,
      parentEntityKind: 'inspection',
    });
    const child = await testDb.sync_queue.get(childId);
    expect(child!.state).toBe('paused');
    expect(child!.pauseReason).toBe('parent_conflict');
  });

  it('with a dead-letter parent: child is paused with parent_dead_letter', async () => {
    const parentId = await enqueueOp({
      kind: 'create',
      entityKind: 'recommendation',
      entityLocalId: LOCAL_ID_2,
      payload: {},
      httpMethod: 'POST',
      endpoint: '/api/recommendations',
      ifMatchEtag: null,
      idempotencyKey: 'idem-dl-parent',
      database: testDb,
    });
    await testDb.sync_queue.update(parentId, { state: 'failed_dead_letter' });

    const childId = await enqueueOp({
      kind: 'create',
      entityKind: 'recommendation_response',
      entityLocalId: LOCAL_ID_3,
      payload: {},
      httpMethod: 'POST',
      endpoint: `/api/recommendations/${LOCAL_ID_2}/responses`,
      ifMatchEtag: null,
      idempotencyKey: 'idem-child-dl',
      database: testDb,
      parentEntityLocalId: LOCAL_ID_2,
      parentEntityKind: 'recommendation',
    });
    const child = await testDb.sync_queue.get(childId);
    expect(child!.state).toBe('paused');
    expect(child!.pauseReason).toBe('parent_dead_letter');
  });

  it('with no parent: child drains normally', async () => {
    const id = await enqueueOp({
      kind: 'create',
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      payload: {},
      httpMethod: 'POST',
      endpoint: '/api/hazards',
      ifMatchEtag: null,
      idempotencyKey: 'idem-loner',
      database: testDb,
    });
    const row = await testDb.sync_queue.get(id);
    expect(row!.state).toBe('queued');
    expect(row!.dependsOnQueueId).toBeNull();
  });
});

describe('SyncQueueWorker status surface', () => {
  it('reports synced when queue is empty + no conflicts', async () => {
    const dispatcher = vi.fn(
      async (): Promise<DispatchResult> => ({
        kind: 'success',
        serverState: {},
        serverVersion: 1,
      }),
    );
    const worker = new SyncQueueWorker({ database: testDb, dispatcher });
    await worker.drainNow();
    expect(worker.getStatus().kind).toBe('synced');
  });

  it('reports paused when there are conflicts', async () => {
    await seedHazard(LOCAL_ID);
    await testDb.sync_conflicts.add({
      entityKind: 'hazard',
      entityLocalId: LOCAL_ID,
      localStateJson: '{}',
      serverStateJson: '{}',
      baseStateJson: '',
      serverVersion: 1,
      detectedAt: '2026-06-02T10:00:00.000Z',
      resolved: 0,
    });
    const worker = new SyncQueueWorker({
      database: testDb,
      dispatcher: async () => ({ kind: 'success', serverState: {}, serverVersion: 1 }),
    });
    await worker.drainNow();
    expect(worker.getStatus().kind).toBe('paused');
  });
});
