// Local-only sync metrics (Milestone 1.10 S4, ADR-0009 §3.11).
//
// The CLAUDE.md non-negotiable #3 forbids third-party data flows without
// explicit opt-in. "Monitoring" in the S4 brief therefore lands as a
// LOCAL-ONLY computation: every metric is derived from Dexie on the
// device. Nothing is fetched, posted, or beaconed off-host. The rep is
// the data custodian.
//
// The metrics here back the "Health" subsection of `sync-panel.tsx` (the
// numbers above the existing Status / Pending / Conflicts / Dead-letter
// subsections from S3). They surface drain-pressure and storage-pressure
// signals that the existing subsections don't already show:
//
//   - opsByState              — distribution across queue lifecycle.
//                               Mirrors what the chip already counts but
//                               with the per-state breakdown for triage.
//   - medianAttemptCount      — rough "is the queue spinning?" number.
//                               High median attempts → server-side error
//                               or persistent network flap; a rep can
//                               eyeball this and decide to open the dead-
//                               letter UI or wait it out (T-S10 mitigation
//                               surface).
//   - oldestQueuedAgeSeconds  — drain lag. Should be < 30s on a healthy
//                               worker; >5min means the worker is stalled
//                               or the rep is offline.
//   - unresolvedConflicts     — duplicates the chip's count, surfaced
//                               here for at-a-glance Health.
//   - deadLetterCount         — same.
//   - pendingPayloadBytes     — sum of envelope-encrypted payload bytes
//                               across `state IN ('queued', 'in_flight',
//                               'paused')` queue rows. If this grows
//                               past ~2 MB the panel warns; the IndexedDB
//                               quota on most phones is generous but not
//                               unbounded (T-S1: stolen-phone exposure
//                               surface area scales with cache size; T-S4
//                               replay surface area scales with payload
//                               retention).
//   - hasBlockedByParent      — true if any queued op is `state='paused'`
//                               with `pauseReason` mentioning a parent
//                               conflict / dead-letter. FK-dependency
//                               visibility for the rep, who otherwise
//                               wouldn't see why a child op isn't
//                               draining.
//
// All values are derived in one pass over `sync_queue` + one pass over
// `sync_conflicts`. The queries are scoped to indexed columns
// (`state`, `resolved`) so they remain cheap on a backlog of a few
// hundred rows. No network. No analytics. The rep sees their own data,
// or nothing.

import type { SyncOperationState } from '@jhsc/shared-types';
import { syncOperationState } from '@jhsc/shared-types';
import { db, type JhscOfflineDb, type SyncQueueRow } from './db';

/**
 * The shape the sync-panel "Health" subsection renders.
 *
 * Designed to be JSON-serializable so it can be snapshot-tested cheaply
 * (no Date / Map / RegExp). Numbers, booleans, and one Record only.
 */
export interface SyncMetrics {
  /** Total queue operations, grouped by state. Includes 'paused' even
   * though it's not in the `SyncOperationState` enum (the queue row's
   * `state` column is a wider union per db.ts). The Record is keyed by
   * the full set of states; states with zero rows are still present
   * with value 0 so the panel can render a fixed grid. */
  readonly opsByState: Readonly<Record<SyncOperationState | 'paused', number>>;
  /** Median attempt count across queued operations (rough drain-pressure
   * indicator). Computed across rows where `state IN ('queued',
   * 'in_flight')` — the in-flight workload. Returns 0 when the queue is
   * empty. */
  readonly medianAttemptCount: number;
  /** Oldest queued op's age in seconds (drain-lag indicator). Computed
   * across rows where `state IN ('queued', 'in_flight')`. Null when the
   * queue is empty (nothing to be late). */
  readonly oldestQueuedAgeSeconds: number | null;
  /** Total unresolved conflicts. */
  readonly unresolvedConflicts: number;
  /** Total dead-letter operations. */
  readonly deadLetterCount: number;
  /** Sum of envelope-encrypted payload bytes across pending ops
   * (storage-pressure indicator). Computed across rows where `state IN
   * ('queued', 'in_flight', 'paused')` — every row that still carries
   * a payload the rep can't drop. */
  readonly pendingPayloadBytes: number;
  /** Boolean: any op blocked on parent conflict / dead-letter (FK
   * dependency surface). True iff a queue row exists with
   * `pauseReason IN ('parent_conflict', 'parent_dead_letter')`. */
  readonly hasBlockedByParent: boolean;
}

/** The warning threshold for `pendingPayloadBytes`. The panel renders
 * the value in a warning color when this is exceeded. ~2 MB is well
 * under the typical IndexedDB quota (50 MB+ on modern browsers) but
 * large enough that we'd want the rep to know they have a substantial
 * pending workload. */
export const PENDING_PAYLOAD_WARN_BYTES = 2 * 1024 * 1024;

/** Options for `computeSyncMetrics`. Tests inject an override database;
 * production callers pass nothing and get the singleton. */
export interface ComputeMetricsOptions {
  readonly database?: JhscOfflineDb;
  readonly now?: () => number;
}

/**
 * Compute the full metrics shape from Dexie.
 *
 * Single async function so the panel can `await` it once per open + once
 * per drain. Two Dexie reads (queue + conflicts), both indexed; the
 * cost is bounded by `O(queue rows)` and a constant 1 for the conflict
 * count. The function is pure w.r.t. Dexie state — it issues no writes.
 *
 * Pure function note: while the function reads Dexie (an external
 * dependency), it has no side effects of its own and returns the same
 * shape for the same database state. Tests inject a seeded Dexie
 * instance via `options.database` to drive it deterministically.
 */
export async function computeSyncMetrics(
  options: ComputeMetricsOptions = {},
): Promise<SyncMetrics> {
  const database = options.database ?? db;
  const now = options.now ?? (() => Date.now());

  // One pass over sync_queue (cheap; the table is bounded by the
  // backlog size, typically <50 rows in normal use).
  const allQueueRows: SyncQueueRow[] = await database.sync_queue.toArray();
  const opsByState = countByState(allQueueRows);
  const pendingForAttempts = allQueueRows.filter(
    (r) => r.state === 'queued' || r.state === 'in_flight',
  );
  const pendingForPayloadBytes = allQueueRows.filter(
    (r) => r.state === 'queued' || r.state === 'in_flight' || r.state === 'paused',
  );
  const medianAttemptCount = computeMedian(pendingForAttempts.map((r) => r.attemptCount));
  const oldestQueuedAgeSeconds = computeOldestAgeSeconds(pendingForAttempts, now());
  const pendingPayloadBytes = sumPayloadBytes(pendingForPayloadBytes);
  const deadLetterCount = opsByState.failed_dead_letter;
  const hasBlockedByParent = allQueueRows.some(
    (r) => r.pauseReason === 'parent_conflict' || r.pauseReason === 'parent_dead_letter',
  );

  // One indexed range read over sync_conflicts.
  const unresolvedConflicts = await database.sync_conflicts.where('resolved').equals(0).count();

  return {
    opsByState,
    medianAttemptCount,
    oldestQueuedAgeSeconds,
    unresolvedConflicts,
    deadLetterCount,
    pendingPayloadBytes,
    hasBlockedByParent,
  };
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests so the metric-by-metric assertions
// can drive each path in isolation).
// ---------------------------------------------------------------------------

/** Bucket queue rows by `state`. Always returns the full key set, with
 * zero values for missing states — so the panel's grid is fixed-shape. */
export function countByState(
  rows: ReadonlyArray<SyncQueueRow>,
): Record<SyncOperationState | 'paused', number> {
  // Initialize all keys to zero so the consumer can render a stable
  // grid without per-key checks.
  const counts: Record<SyncOperationState | 'paused', number> = {
    queued: 0,
    in_flight: 0,
    succeeded: 0,
    conflicting: 0,
    failed_dead_letter: 0,
    paused: 0,
  };
  for (const row of rows) {
    if (row.state in counts) {
      counts[row.state]++;
    }
    // Unknown states are dropped — defense-in-depth against a Dexie
    // schema drift that admitted a value outside the union.
  }
  return counts;
}

/** Median of a number list. Returns 0 for the empty list (the metric's
 * documented zero-state). Stable-sorted ascending; even-length lists
 * return the mean of the two middle values rounded to two decimals. */
export function computeMedian(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  const a = sorted[mid - 1]!;
  const b = sorted[mid]!;
  return Math.round(((a + b) / 2) * 100) / 100;
}

/** Compute the oldest queued op's age in seconds. Returns null for
 * the empty list (nothing to be late). Uses `createdAt` (ISO string)
 * — the rep's local clock at enqueue time. Per ADR §3.2 this is not
 * canonical, but the metric is a relative-age indicator, so the local
 * clock is appropriate. */
export function computeOldestAgeSeconds(
  rows: ReadonlyArray<SyncQueueRow>,
  nowMs: number,
): number | null {
  if (rows.length === 0) return null;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const ms = Date.parse(row.createdAt);
    if (Number.isFinite(ms) && ms < oldestMs) {
      oldestMs = ms;
    }
  }
  if (!Number.isFinite(oldestMs)) return null;
  const ageSec = Math.max(0, Math.round((nowMs - oldestMs) / 1000));
  return ageSec;
}

/** Sum the byte length of every row's `payload` string. The payload is
 * JSON-stringified at enqueue time (`enqueueOp` in queue-worker.ts) so
 * the string length is a faithful proxy for the bytes Dexie persists.
 * UTF-8 byte length is approximated by string length — the payloads are
 * ASCII-dominated (base64 ciphertext, ISO timestamps, enums) so the
 * over/under-count is bounded. */
export function sumPayloadBytes(rows: ReadonlyArray<SyncQueueRow>): number {
  let total = 0;
  for (const row of rows) {
    if (typeof row.payload === 'string') {
      total += row.payload.length;
    }
  }
  return total;
}

/** Format a byte count for the panel. Kept here (not in the panel) so
 * tests can lock the formatting alongside the metric. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a seconds-ago value for the panel. Returns "—" for null. */
export function formatAgeSeconds(ageSec: number | null): string {
  if (ageSec === null) return '—';
  if (ageSec < 60) return `${ageSec}s ago`;
  const min = Math.round(ageSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

/** Format the median attempt count for the panel. The attempt count
 * is 0-indexed in the queue row (a fresh enqueue has attemptCount=0,
 * meaning "0 retries so far"). The rep-facing label says "attempt N"
 * which is `attemptCount + 1` — we keep this helper so the panel and
 * tests agree on the off-by-one. */
export function formatMedianAttempts(median: number): string {
  if (median === 0) return 'none';
  // Round to one decimal for the even-length median case.
  const rounded = Math.round(median * 10) / 10;
  return `${rounded}`;
}

/** Re-export the state list so the panel can build its grid without a
 * second import. */
export const SYNC_OPERATION_STATES_FOR_METRICS: ReadonlyArray<SyncOperationState | 'paused'> = [
  ...syncOperationState,
  'paused',
];

/** Internal helpers exported for tests. */
export const _internal = {
  countByState,
  computeMedian,
  computeOldestAgeSeconds,
  sumPayloadBytes,
  formatBytes,
  formatAgeSeconds,
  formatMedianAttempts,
};
