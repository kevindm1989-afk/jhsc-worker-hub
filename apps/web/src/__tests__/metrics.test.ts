// Unit tests for computeSyncMetrics (Milestone 1.10 S4).
//
// Seeds a fresh Dexie DB with known queue/conflict rows and asserts
// every output field. The pure-helper exports (countByState,
// computeMedian, computeOldestAgeSeconds, sumPayloadBytes) get focused
// tests too — driving each metric in isolation makes the panel's
// rendering deterministic.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JhscOfflineDb, type SyncQueueRow } from '@/sync/db';
import {
  PENDING_PAYLOAD_WARN_BYTES,
  _internal,
  computeSyncMetrics,
  formatAgeSeconds,
  formatBytes,
  formatMedianAttempts,
} from '@/sync/metrics';

let db: JhscOfflineDb;

beforeEach(async () => {
  db = new JhscOfflineDb('jhsc-metrics-' + Math.random().toString(36).slice(2));
  await db.open();
});

afterEach(async () => {
  await db.delete();
});

// Helper: build a queue row with sensible defaults; tests override per case.
function makeQueueRow(overrides: Partial<SyncQueueRow>): Omit<SyncQueueRow, 'id'> {
  return {
    kind: 'create',
    entityKind: 'hazard',
    entityLocalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    payload: JSON.stringify({ title: 'Test' }),
    httpMethod: 'POST',
    endpoint: '/api/hazards',
    ifMatchEtag: null,
    idempotencyKey: 'idem-' + Math.random().toString(36).slice(2),
    attemptCount: 0,
    nextAttemptAt: new Date().toISOString(),
    state: 'queued',
    lastError: null,
    createdAt: new Date().toISOString(),
    dependsOnQueueId: null,
    pauseReason: null,
    ...overrides,
  };
}

describe('computeSyncMetrics', () => {
  it('returns the zero shape for an empty database', async () => {
    const m = await computeSyncMetrics({ database: db });
    expect(m.opsByState).toEqual({
      queued: 0,
      in_flight: 0,
      succeeded: 0,
      conflicting: 0,
      failed_dead_letter: 0,
      paused: 0,
    });
    expect(m.medianAttemptCount).toBe(0);
    expect(m.oldestQueuedAgeSeconds).toBeNull();
    expect(m.unresolvedConflicts).toBe(0);
    expect(m.deadLetterCount).toBe(0);
    expect(m.pendingPayloadBytes).toBe(0);
    expect(m.hasBlockedByParent).toBe(false);
  });

  it('counts queue rows grouped by state', async () => {
    await db.sync_queue.bulkAdd([
      makeQueueRow({ state: 'queued' }) as SyncQueueRow,
      makeQueueRow({ state: 'queued' }) as SyncQueueRow,
      makeQueueRow({ state: 'in_flight' }) as SyncQueueRow,
      makeQueueRow({ state: 'conflicting' }) as SyncQueueRow,
      makeQueueRow({ state: 'failed_dead_letter' }) as SyncQueueRow,
      makeQueueRow({ state: 'paused', pauseReason: 'parent_conflict' }) as SyncQueueRow,
    ]);

    const m = await computeSyncMetrics({ database: db });
    expect(m.opsByState.queued).toBe(2);
    expect(m.opsByState.in_flight).toBe(1);
    expect(m.opsByState.conflicting).toBe(1);
    expect(m.opsByState.failed_dead_letter).toBe(1);
    expect(m.opsByState.paused).toBe(1);
    expect(m.opsByState.succeeded).toBe(0);
    expect(m.deadLetterCount).toBe(1);
    expect(m.hasBlockedByParent).toBe(true);
  });

  it('computes median attemptCount only across queued + in_flight rows', async () => {
    await db.sync_queue.bulkAdd([
      // Active rows — should be in median calc.
      makeQueueRow({ state: 'queued', attemptCount: 0 }) as SyncQueueRow,
      makeQueueRow({ state: 'queued', attemptCount: 2 }) as SyncQueueRow,
      makeQueueRow({ state: 'in_flight', attemptCount: 4 }) as SyncQueueRow,
      // Dead-letter — should NOT count toward median (terminal state).
      makeQueueRow({ state: 'failed_dead_letter', attemptCount: 100 }) as SyncQueueRow,
    ]);
    const m = await computeSyncMetrics({ database: db });
    // [0, 2, 4] -> median 2.
    expect(m.medianAttemptCount).toBe(2);
  });

  it('returns oldestQueuedAgeSeconds based on the rep clock', async () => {
    const oldIso = new Date(2026, 0, 1, 12, 0, 0).toISOString();
    const newIso = new Date(2026, 0, 1, 12, 5, 0).toISOString();
    await db.sync_queue.bulkAdd([
      makeQueueRow({ state: 'queued', createdAt: oldIso }) as SyncQueueRow,
      makeQueueRow({ state: 'queued', createdAt: newIso }) as SyncQueueRow,
      // Dead-letter rows excluded.
      makeQueueRow({
        state: 'failed_dead_letter',
        createdAt: new Date(2026, 0, 1, 11, 0, 0).toISOString(),
      }) as SyncQueueRow,
    ]);
    const fixedNow = new Date(2026, 0, 1, 12, 10, 0).getTime();
    const m = await computeSyncMetrics({ database: db, now: () => fixedNow });
    // 12:10 - 12:00 = 600s
    expect(m.oldestQueuedAgeSeconds).toBe(600);
  });

  it('sums pendingPayloadBytes across queued + in_flight + paused rows only', async () => {
    const small = JSON.stringify({ x: 'a' });
    const medium = JSON.stringify({ x: 'a'.repeat(200) });
    const large = JSON.stringify({ x: 'a'.repeat(1000) });
    await db.sync_queue.bulkAdd([
      makeQueueRow({ state: 'queued', payload: small }) as SyncQueueRow,
      makeQueueRow({ state: 'in_flight', payload: medium }) as SyncQueueRow,
      makeQueueRow({
        state: 'paused',
        pauseReason: 'parent_conflict',
        payload: large,
      }) as SyncQueueRow,
      // Excluded — terminal state.
      makeQueueRow({
        state: 'failed_dead_letter',
        payload: JSON.stringify({ y: 'b'.repeat(10000) }),
      }) as SyncQueueRow,
    ]);
    const m = await computeSyncMetrics({ database: db });
    expect(m.pendingPayloadBytes).toBe(small.length + medium.length + large.length);
  });

  it('counts unresolved conflicts only', async () => {
    await db.sync_conflicts.bulkAdd([
      {
        entityKind: 'hazard',
        entityLocalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        localStateJson: '{}',
        serverStateJson: '{}',
        baseStateJson: '{}',
        serverVersion: 1,
        detectedAt: new Date().toISOString(),
        resolved: 0,
      },
      {
        entityKind: 'hazard',
        entityLocalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        localStateJson: '{}',
        serverStateJson: '{}',
        baseStateJson: '{}',
        serverVersion: 1,
        detectedAt: new Date().toISOString(),
        resolved: 0,
      },
      {
        entityKind: 'hazard',
        entityLocalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        localStateJson: '{}',
        serverStateJson: '{}',
        baseStateJson: '{}',
        serverVersion: 1,
        detectedAt: new Date().toISOString(),
        resolved: 1,
      },
    ]);
    const m = await computeSyncMetrics({ database: db });
    expect(m.unresolvedConflicts).toBe(2);
  });

  it('detects hasBlockedByParent from pauseReason', async () => {
    await db.sync_queue.bulkAdd([
      makeQueueRow({ state: 'paused', pauseReason: 'parent_dead_letter' }) as SyncQueueRow,
    ]);
    const m = await computeSyncMetrics({ database: db });
    expect(m.hasBlockedByParent).toBe(true);
  });

  it('reports hasBlockedByParent=false when no parent dependency exists', async () => {
    await db.sync_queue.bulkAdd([
      makeQueueRow({ state: 'paused', pauseReason: 'manual_pause' }) as SyncQueueRow,
      makeQueueRow({ state: 'queued' }) as SyncQueueRow,
    ]);
    const m = await computeSyncMetrics({ database: db });
    expect(m.hasBlockedByParent).toBe(false);
  });
});

describe('countByState (pure helper)', () => {
  it('returns the full key set even when empty', () => {
    const result = _internal.countByState([]);
    expect(Object.keys(result).sort()).toEqual([
      'conflicting',
      'failed_dead_letter',
      'in_flight',
      'paused',
      'queued',
      'succeeded',
    ]);
    for (const v of Object.values(result)) expect(v).toBe(0);
  });
});

describe('computeMedian (pure helper)', () => {
  it('returns 0 for an empty list', () => {
    expect(_internal.computeMedian([])).toBe(0);
  });
  it('handles odd-length lists', () => {
    expect(_internal.computeMedian([1, 2, 3])).toBe(2);
    expect(_internal.computeMedian([3, 1, 2])).toBe(2); // sort first
  });
  it('handles even-length lists', () => {
    expect(_internal.computeMedian([1, 2, 3, 4])).toBe(2.5);
    expect(_internal.computeMedian([10, 30])).toBe(20);
  });
});

describe('computeOldestAgeSeconds (pure helper)', () => {
  it('returns null for an empty list', () => {
    expect(_internal.computeOldestAgeSeconds([], Date.now())).toBeNull();
  });
  it('returns floor(0) for a future-dated row (clock skew safety)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const rows = [{ createdAt: future } as SyncQueueRow];
    expect(_internal.computeOldestAgeSeconds(rows, Date.now())).toBe(0);
  });
  it('picks the oldest across multiple rows', () => {
    const t = Date.parse('2026-01-01T12:00:00.000Z');
    const rows = [
      { createdAt: '2026-01-01T11:00:00.000Z' } as SyncQueueRow,
      { createdAt: '2026-01-01T11:30:00.000Z' } as SyncQueueRow,
      { createdAt: '2026-01-01T11:55:00.000Z' } as SyncQueueRow,
    ];
    expect(_internal.computeOldestAgeSeconds(rows, t)).toBe(3600);
  });
});

describe('sumPayloadBytes (pure helper)', () => {
  it('sums string lengths across rows', () => {
    const rows = [{ payload: 'abc' } as SyncQueueRow, { payload: 'defgh' } as SyncQueueRow];
    expect(_internal.sumPayloadBytes(rows)).toBe(8);
  });
  it('ignores non-string payloads defensively', () => {
    const rows = [
      { payload: 'abc' } as SyncQueueRow,
      // Defensive: a queue row with a non-string payload would be schema
      // drift; we don't crash.
      { payload: null as unknown as string } as SyncQueueRow,
    ];
    expect(_internal.sumPayloadBytes(rows)).toBe(3);
  });
});

describe('format helpers', () => {
  it('formatBytes covers B / KB / MB', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('formatAgeSeconds covers null / s / min / h / d', () => {
    expect(formatAgeSeconds(null)).toBe('—');
    expect(formatAgeSeconds(30)).toBe('30s ago');
    expect(formatAgeSeconds(120)).toBe('2 min ago');
    expect(formatAgeSeconds(3 * 60 * 60)).toBe('3 h ago');
    expect(formatAgeSeconds(3 * 24 * 60 * 60)).toBe('3 d ago');
  });

  it('formatMedianAttempts handles "none" + numeric output', () => {
    expect(formatMedianAttempts(0)).toBe('none');
    expect(formatMedianAttempts(2)).toBe('2');
    expect(formatMedianAttempts(2.5)).toBe('2.5');
  });

  it('PENDING_PAYLOAD_WARN_BYTES is the 2 MB threshold', () => {
    expect(PENDING_PAYLOAD_WARN_BYTES).toBe(2 * 1024 * 1024);
  });
});
