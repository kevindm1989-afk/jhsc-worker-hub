// Sync queue worker (Milestone 1.10 S2, ADR-0009 §3.2).
//
// Drains rows from Dexie's `sync_queue` table in batch-of-10 passes,
// dispatches each row through the corresponding typed-client wrapper (so
// every mutation rides the existing X-Requested-With + Idempotency-Key
// + If-Match plumbing), and reacts per-status:
//
//   - 200 / 201 / 204:           success path; entity → clean; queue row
//                                deleted; _base_state cache refreshed.
//   - 202 (SW intercept):        the service worker queued the request
//                                because the network was unreachable.
//                                Leave the queue row in place and bump
//                                nextAttemptAt to the next backoff slot.
//   - 409 version_conflict:      write a sync_conflicts row with local +
//                                server + base for the three-way merge
//                                UI (S3 owns); entity → conflicting;
//                                queue row → conflicting (stops further
//                                attempts on this op).
//   - 503 network_required:      offline; extend the backoff to the
//                                "offline floor" (no point retrying
//                                every second when there's no network).
//   - 4xx / 5xx / network error: bump attemptCount + nextAttemptAt
//                                per computeNextBackoff. If the backoff
//                                schedule is exhausted, mark
//                                failed_dead_letter.
//
// Tab-leader election (ADR §3.2 single-thread-per-tab): the worker uses
// `navigator.locks.request('jhsc-sync-leader', {mode: 'exclusive'}, ...)`
// when available (Chrome 69+, Safari 15.4+, FF 96+). On older browsers
// we fall back to a heartbeat row in the `_base_state` table — a tab
// that hasn't written its heartbeat in >30s loses leadership.
//
// Visibility-aware: the worker pauses drains while the document is
// hidden (battery saver per ADR §3.2). Online detection: navigator.onLine
// is a hint; the real check is the first 200/202 from the server (and
// any network error / 503 is treated as "presumed offline").

import {
  SYNC_BACKOFF_SCHEDULE,
  SYNC_DEAD_LETTER_AFTER_ATTEMPTS,
  computeNextBackoff,
  type SyncEntityKind,
  type SyncOperationKind,
  type SyncOperationState,
} from '@jhsc/shared-types';
import {
  db,
  baseStateKey,
  cleanSyncMetadata,
  nowIso,
  type JhscOfflineDb,
  type SyncQueueRow,
} from './db';

/** The shared-typed view of a queue row, exposed to S3 surface code. */
export interface SyncOperation {
  readonly id: number;
  readonly kind: SyncOperationKind;
  readonly entityKind: SyncEntityKind;
  readonly entityLocalId: string;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly state: SyncOperationState | 'paused';
  readonly lastError: string | null;
  readonly createdAt: string;
}

/** Status surface for the sync chip (S3) + the queue-status view. */
export type SyncStatus =
  | { readonly kind: 'synced' }
  | { readonly kind: 'syncing'; readonly inFlight: number; readonly queued: number }
  | { readonly kind: 'offline'; readonly queued: number }
  | { readonly kind: 'paused'; readonly reason: string; readonly queued: number };

/** Public listener signature. */
export type SyncStatusListener = (status: SyncStatus) => void;

/** The dispatcher contract — the queue worker calls this exactly once
 * per drain attempt, passing the deserialized queue row. The
 * implementation lives in `typed-client.ts` (the `syncify` wrapper
 * registers itself via `setQueueDispatcher` at module-init time). */
export interface QueueDispatcher {
  (op: SyncOperation): Promise<DispatchResult>;
}

/** The dispatcher returns one of these shapes — the queue worker reacts
 * accordingly. We model the response as a discriminated union so the
 * worker doesn't have to inspect raw Response objects. */
export type DispatchResult =
  | {
      readonly kind: 'success';
      /** The server's canonical row payload (the JSON body). */
      readonly serverState: unknown;
      /** The server's new `version` integer (post-bump). */
      readonly serverVersion: number;
    }
  | { readonly kind: 'sw_queued' }
  | {
      readonly kind: 'conflict';
      readonly serverState: unknown;
      readonly serverVersion: number;
    }
  | { readonly kind: 'network_required' }
  | { readonly kind: 'dead_letter'; readonly error: string }
  | { readonly kind: 'transient_failure'; readonly error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum operations drained per pass. ADR §3.2 "batch-of-10 drain"
 * keeps the UI responsive while still letting a 50-op backlog clear in
 * ~5 passes. */
const BATCH_SIZE = 10;

/** Default polling interval when online + non-empty queue (ms). */
const POLL_INTERVAL_MS = 30_000;

/** Offline floor — when a 503 network_required lands, the next attempt
 * waits at least this long. ~30s (the navigator.onLine event will fire
 * sooner anyway when the network returns; this is just an upper bound on
 * wasted retries). */
const OFFLINE_FLOOR_MS = 30_000;

/** Leader-election lock name used with `navigator.locks`. */
const LEADER_LOCK_NAME = 'jhsc-sync-leader';

/** Heartbeat row id in `_base_state` table for the fallback leader path. */
const HEARTBEAT_KEY = '__heartbeat__:queue-leader';

/** Heartbeat refresh interval (ms). */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Heartbeat staleness threshold (ms) — a tab that hasn't refreshed in
 * this window loses leadership. */
const HEARTBEAT_STALE_MS = 30_000;

// ---------------------------------------------------------------------------
// Dispatcher registration (typed-client.ts injects on module-init)
// ---------------------------------------------------------------------------

let registeredDispatcher: QueueDispatcher | null = null;

/** Called by typed-client.ts during its module-init phase so the worker
 * has a target to ship to. Tests can also call this to inject a stub. */
export function setQueueDispatcher(d: QueueDispatcher | null): void {
  registeredDispatcher = d;
}

/** Read the current dispatcher (test introspection). */
export function getQueueDispatcher(): QueueDispatcher | null {
  return registeredDispatcher;
}

// ---------------------------------------------------------------------------
// SyncQueueWorker
// ---------------------------------------------------------------------------

interface WorkerOptions {
  /** Override the singleton Dexie instance — for tests. */
  readonly database?: JhscOfflineDb;
  /** Override the dispatcher — for tests. */
  readonly dispatcher?: QueueDispatcher;
  /** Override the now() clock — for tests. */
  readonly now?: () => number;
  /** Override the poll interval — for tests. */
  readonly pollIntervalMs?: number;
  /** Override the batch size — for tests. */
  readonly batchSize?: number;
}

/**
 * The drain coordinator. Created once per tab; the foreground app
 * `start()`s it after auth completes and `stop()`s it on logout.
 */
export class SyncQueueWorker {
  private readonly database: JhscOfflineDb;
  private readonly dispatcherOverride: QueueDispatcher | null;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private running = false;
  /** Leader-election state. Kept for future tab-leader telemetry (S4
   * dead-letter UX may surface "this tab is the leader"); read it via
   * `hasLeadership()`. */
  private isLeader = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = { kind: 'synced' };
  private readonly listeners = new Set<SyncStatusListener>();
  private currentDrain: Promise<void> | null = null;
  private offline = false;

  constructor(options: WorkerOptions = {}) {
    this.database = options.database ?? db;
    this.dispatcherOverride = options.dispatcher ?? null;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? BATCH_SIZE;
  }

  /** Spin the worker up; idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.acquireLeadership();
    this.attachWindowListeners();
    this.scheduleNextPoll();
  }

  /** Halt drains and release leadership; idempotent. */
  stop(): void {
    this.running = false;
    this.isLeader = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.detachWindowListeners();
  }

  /** Manually trigger a drain pass; resolves when the current pass is
   * complete. Tests + the manual "Sync now" button (S3) use this — so
   * `drainNow` works even without a preceding `start()` call (the
   * `running` guard inside `drain()` only fires after `stop()` has been
   * called). */
  async drainNow(): Promise<void> {
    if (this.currentDrain) return this.currentDrain;
    // Auto-enable running for the duration of this manual drain so tests
    // and the "Sync now" button don't have to call start() first.
    const wasRunning = this.running;
    if (!this.running) this.running = true;
    this.currentDrain = this.drain().finally(() => {
      this.currentDrain = null;
      if (!wasRunning) this.running = false;
    });
    return this.currentDrain;
  }

  /** Subscribe to status changes; returns an unsubscribe function. */
  subscribe(listener: SyncStatusListener): () => void {
    this.listeners.add(listener);
    // Push the current status on subscribe so the chip renders without a
    // first event.
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current status (test introspection). */
  getStatus(): SyncStatus {
    return this.status;
  }

  /** True if this tab holds the leader lock. */
  hasLeadership(): boolean {
    return this.isLeader;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private setStatus(next: SyncStatus): void {
    this.status = next;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch {
        // Listener errors are non-fatal.
      }
    }
  }

  private async refreshStatusFromDb(): Promise<void> {
    const queued = await this.database.sync_queue
      .where('state')
      .anyOf(['queued', 'in_flight'])
      .count();
    const conflicts = await this.database.sync_conflicts.where('resolved').equals(0).count();
    const dead = await this.database.sync_queue.where('state').equals('failed_dead_letter').count();
    if (conflicts > 0 || dead > 0) {
      this.setStatus({
        kind: 'paused',
        reason: conflicts > 0 ? 'conflicts' : 'dead_letter',
        queued,
      });
      return;
    }
    if (queued === 0) {
      this.setStatus({ kind: 'synced' });
      return;
    }
    if (this.offline) {
      this.setStatus({ kind: 'offline', queued });
      return;
    }
    const inFlight = await this.database.sync_queue.where('state').equals('in_flight').count();
    this.setStatus({ kind: 'syncing', inFlight, queued });
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollTimer = setTimeout(() => {
      void this.drainNow().finally(() => this.scheduleNextPoll());
    }, this.pollIntervalMs);
  }

  /** Acquire the per-origin leader lock so only one tab drains the
   * queue. Falls back to a heartbeat row on browsers without the Web
   * Locks API. */
  private async acquireLeadership(): Promise<void> {
    if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
      // navigator.locks.request returns a promise that resolves when the
      // callback resolves — so we just keep the callback alive while the
      // worker is running.
      void navigator.locks.request(LEADER_LOCK_NAME, { mode: 'exclusive' }, async () => {
        this.isLeader = true;
        // Trigger an immediate drain on leadership acquisition.
        void this.drainNow();
        // Hold the lock until stop() flips `running` false.
        await new Promise<void>((resolve) => {
          const tick = (): void => {
            if (!this.running) {
              resolve();
              return;
            }
            setTimeout(tick, 1000);
          };
          tick();
        });
      });
      return;
    }
    // Fallback: heartbeat row.
    this.startHeartbeatLeader();
  }

  private startHeartbeatLeader(): void {
    const writeHeartbeat = async (): Promise<void> => {
      const existing = await this.database._base_state.get(HEARTBEAT_KEY);
      const lastTs = existing ? Date.parse(existing.cachedAt) : 0;
      const now = this.now();
      if (!existing || now - lastTs > HEARTBEAT_STALE_MS) {
        // Claim leadership.
        this.isLeader = true;
        await this.database._base_state.put({
          key: HEARTBEAT_KEY,
          entityKind: 'hazard',
          entityLocalId: HEARTBEAT_KEY,
          version: 0,
          stateJson: '',
          cachedAt: new Date(now).toISOString(),
        });
      } else if (existing && now - lastTs <= HEARTBEAT_STALE_MS) {
        // Someone else is leader.
        this.isLeader = false;
      }
    };
    void writeHeartbeat();
    this.heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private windowListenersAttached = false;
  private readonly onlineHandler = (): void => {
    this.offline = false;
    void this.drainNow();
  };
  private readonly offlineHandler = (): void => {
    this.offline = true;
    void this.refreshStatusFromDb();
  };
  private readonly visibilityHandler = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void this.drainNow();
    }
  };

  private attachWindowListeners(): void {
    if (this.windowListenersAttached) return;
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    this.windowListenersAttached = true;
  }

  private detachWindowListeners(): void {
    if (!this.windowListenersAttached) return;
    if (typeof window === 'undefined') return;
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.windowListenersAttached = false;
  }

  /** Pull the dispatcher — either the override (tests) or the module-
   * level registration (typed-client.ts). */
  private resolveDispatcher(): QueueDispatcher | null {
    return this.dispatcherOverride ?? registeredDispatcher;
  }

  /** Pull the next batch of `queued` rows whose nextAttemptAt is in the
   * past, sorted by createdAt ASC. */
  private async claimBatch(): Promise<SyncQueueRow[]> {
    const nowIsoStr = new Date(this.now()).toISOString();
    // Dexie can't compound the "state==queued AND nextAttemptAt<=now"
    // into a single index; we filter in two passes which is fine for the
    // batch-of-10 size.
    const rows = await this.database.sync_queue.where('state').equals('queued').toArray();
    return rows
      .filter((r) => r.nextAttemptAt <= nowIsoStr)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.batchSize);
  }

  /** One drain pass. */
  private async drain(): Promise<void> {
    if (!this.running) return;
    // Hidden-tab pause: don't drain when the user can't see the result.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      await this.refreshStatusFromDb();
      return;
    }
    const dispatcher = this.resolveDispatcher();
    if (!dispatcher) {
      // Dispatcher hasn't loaded yet — common during cold boot before
      // typed-client.ts module-init completes. Skip this pass; the
      // poll-timer will retry.
      await this.refreshStatusFromDb();
      return;
    }

    const batch = await this.claimBatch();
    if (batch.length === 0) {
      await this.refreshStatusFromDb();
      return;
    }

    for (const row of batch) {
      if (!this.running) break;
      await this.processOne(row, dispatcher);
      // Yield to the event loop between ops so a long batch doesn't
      // freeze the UI (ADR §3.2 "yield between batches").
      await new Promise((r) => setTimeout(r, 0));
    }
    await this.refreshStatusFromDb();
  }

  /** Process a single queue row: claim → dispatch → react. */
  private async processOne(row: SyncQueueRow, dispatcher: QueueDispatcher): Promise<void> {
    if (row.id === undefined) return;
    // Atomically flip the row to in_flight so a second tab (in the
    // heartbeat-fallback path) doesn't double-ship.
    const claimed = await this.database.sync_queue
      .where('id')
      .equals(row.id)
      .modify((r) => {
        if (r.state === 'queued') {
          (r as { state: SyncOperationState | 'paused' }).state = 'in_flight';
        }
      });
    if (claimed === 0) return;

    const op: SyncOperation = {
      id: row.id,
      kind: row.kind,
      entityKind: row.entityKind,
      entityLocalId: row.entityLocalId,
      payload: safeParseJson(row.payload),
      attemptCount: row.attemptCount,
      nextAttemptAt: row.nextAttemptAt,
      state: row.state,
      lastError: row.lastError,
      createdAt: row.createdAt,
    };

    let result: DispatchResult;
    try {
      result = await dispatcher(op);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { kind: 'transient_failure', error: msg };
    }

    await this.applyResult(row, result);
    // Tickle dependent ops if the parent just succeeded — they were
    // pinned to a future nextAttemptAt by enqueueOp().
    if (result.kind === 'success') {
      await this.releaseDependents(row.id);
    }
  }

  /** Bump the dependents waiting on this parent forward so they drain on
   * the next pass. */
  private async releaseDependents(parentId: number): Promise<void> {
    const now = this.now();
    const nowStr = new Date(now).toISOString();
    await this.database.sync_queue
      .where('dependsOnQueueId')
      .equals(parentId)
      .modify((r) => {
        (r as { nextAttemptAt: string }).nextAttemptAt = nowStr;
        if (r.state === 'paused' && r.pauseReason !== 'parent_conflict') {
          (r as { state: SyncOperationState | 'paused' }).state = 'queued';
          (r as { pauseReason: string | null }).pauseReason = null;
        }
      });
  }

  /** Mutate Dexie according to the dispatcher's result. */
  private async applyResult(row: SyncQueueRow, result: DispatchResult): Promise<void> {
    if (row.id === undefined) return;
    switch (result.kind) {
      case 'success': {
        await this.handleSuccess(row, result.serverState, result.serverVersion);
        return;
      }
      case 'sw_queued': {
        // The SW accepted the request but the server hasn't seen it. We
        // re-queue the row but bump the backoff so we don't spin.
        const nextDelay = computeNextBackoff(row.attemptCount) ?? OFFLINE_FLOOR_MS / 1000;
        const next = new Date(this.now() + nextDelay * 1000).toISOString();
        await this.database.sync_queue.where('id').equals(row.id).modify({
          state: 'queued',
          nextAttemptAt: next,
          lastError: 'sw_queued: awaiting drain by next tab cycle',
        });
        this.offline = true;
        return;
      }
      case 'conflict': {
        await this.handleConflict(row, result.serverState, result.serverVersion);
        return;
      }
      case 'network_required': {
        const next = new Date(this.now() + OFFLINE_FLOOR_MS).toISOString();
        await this.database.sync_queue.where('id').equals(row.id).modify({
          state: 'queued',
          nextAttemptAt: next,
          lastError: 'network_required',
        });
        this.offline = true;
        return;
      }
      case 'dead_letter': {
        await this.database.sync_queue
          .where('id')
          .equals(row.id)
          .modify({
            state: 'failed_dead_letter',
            lastError: result.error,
            attemptCount: row.attemptCount + 1,
          });
        return;
      }
      case 'transient_failure': {
        const nextAttempt = row.attemptCount + 1;
        const delay = computeNextBackoff(nextAttempt);
        if (delay === null || nextAttempt >= SYNC_DEAD_LETTER_AFTER_ATTEMPTS) {
          await this.database.sync_queue.where('id').equals(row.id).modify({
            state: 'failed_dead_letter',
            lastError: result.error,
            attemptCount: nextAttempt,
          });
          return;
        }
        const next = new Date(this.now() + delay * 1000).toISOString();
        await this.database.sync_queue.where('id').equals(row.id).modify({
          state: 'queued',
          nextAttemptAt: next,
          lastError: result.error,
          attemptCount: nextAttempt,
        });
        return;
      }
    }
  }

  private async handleSuccess(
    row: SyncQueueRow,
    serverState: unknown,
    serverVersion: number,
  ): Promise<void> {
    if (row.id === undefined) return;
    const entityTableName = entityKindToTable(row.entityKind);
    const baseStateJson = JSON.stringify(serverState ?? null);
    const meta = cleanSyncMetadata(row.entityLocalId, serverVersion, baseStateJson);

    await this.database.transaction(
      'rw',
      [this.database.sync_queue, this.database._base_state],
      async () => {
        // Drop the queue row + refresh the base state cache.
        await this.database.sync_queue.delete(row.id!);
        await this.database._base_state.put({
          key: baseStateKey(row.entityKind, row.entityLocalId),
          entityKind: row.entityKind,
          entityLocalId: row.entityLocalId,
          version: serverVersion,
          stateJson: baseStateJson,
          cachedAt: nowIso(),
        });
      },
    );

    // Update the entity row itself in its own transaction (Dexie's
    // transaction scope can't span dynamic table names easily; the two
    // transactions are still atomic w.r.t. the queue worker's single-
    // threaded loop).
    if (entityTableName !== null) {
      const table = this.database.table(entityTableName);
      const existing = await table.get(row.entityLocalId);
      if (existing) {
        await table.put({
          ...existing,
          ...meta,
          // The server may have allocated server-side ids (sequence
          // numbers, recommendation numbers). Merge them in.
          ...(typeof serverState === 'object' && serverState !== null ? serverState : {}),
        });
      }
    }
  }

  private async handleConflict(
    row: SyncQueueRow,
    serverState: unknown,
    serverVersion: number,
  ): Promise<void> {
    if (row.id === undefined) return;
    const baseKey = baseStateKey(row.entityKind, row.entityLocalId);
    const base = await this.database._base_state.get(baseKey);
    const entityTableName = entityKindToTable(row.entityKind);
    const localRow = entityTableName
      ? await this.database.table(entityTableName).get(row.entityLocalId)
      : null;

    await this.database.transaction(
      'rw',
      [this.database.sync_queue, this.database.sync_conflicts],
      async () => {
        await this.database.sync_conflicts.add({
          entityKind: row.entityKind,
          entityLocalId: row.entityLocalId,
          localStateJson: JSON.stringify(localRow ?? null),
          serverStateJson: JSON.stringify(serverState ?? null),
          baseStateJson: base ? base.stateJson : '',
          serverVersion,
          detectedAt: nowIso(),
          resolved: 0,
        });
        await this.database.sync_queue.where('id').equals(row.id!).modify({
          state: 'conflicting',
          lastError: 'version_conflict',
        });
      },
    );

    // Mark the entity row as conflicting so the list views render the
    // amber affordance.
    if (entityTableName && localRow) {
      await this.database.table(entityTableName).put({
        ...localRow,
        _sync_state: 'conflicting',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// FK dependency helper (ADR §3.2 "parent-state lookup")
// ---------------------------------------------------------------------------

/**
 * Enqueue a new queue row, applying simple FK-dependency rules.
 *
 * The full topological-sort dependency resolver is a future hardening
 * item (per ADR §3.2 "simpler form for 1.10"). This helper just looks at
 * the optional `parentEntityLocalId` parameter and:
 *
 *   - If the parent has an outstanding queue row in `queued` /
 *     `in_flight`: the child's nextAttemptAt is bumped past the parent's
 *     expected drain time AND `dependsOnQueueId` is set so the worker
 *     can release the child when the parent succeeds.
 *   - If the parent's queue row is `succeeded` (in practice this means
 *     it was already drained — succeeded queue rows are deleted, so we
 *     look for the absence): no-op. The child drains normally.
 *   - If the parent's queue row is `conflicting` / `failed_dead_letter`:
 *     the child is paused with reason `parent_conflict` (or
 *     `parent_dead_letter`). The rep resolves the parent; the worker
 *     releases the child as part of the resolution PATCH.
 *
 * Note: the S1 clientId ratchet means clientId === serverId end-to-end,
 * so the "rewrite child's payload to use parent's serverId" step from
 * older optimistic-sync designs is a no-op for 1.10. We keep the helper
 * shape anyway because a future entity that allocates ids server-side
 * (e.g. recommendation_number) may need it.
 */
export interface EnqueueArgs {
  readonly kind: SyncOperationKind;
  readonly entityKind: SyncEntityKind;
  readonly entityLocalId: string;
  readonly payload: unknown;
  readonly httpMethod: string;
  readonly endpoint: string;
  readonly ifMatchEtag: number | null;
  readonly idempotencyKey: string;
  /** When set, the child waits for the parent's queue row to clear
   * before draining. */
  readonly parentEntityLocalId?: string;
  readonly parentEntityKind?: SyncEntityKind;
  /** Override the now clock — for tests. */
  readonly now?: () => number;
  /** Override the Dexie instance — for tests. */
  readonly database?: JhscOfflineDb;
}

export async function enqueueOp(args: EnqueueArgs): Promise<number> {
  const database = args.database ?? db;
  const now = args.now ?? (() => Date.now());

  // Default queue state + nextAttemptAt.
  let state: SyncQueueRow['state'] = 'queued';
  let nextAttemptAt = new Date(now()).toISOString();
  let dependsOnQueueId: number | null = null;
  let pauseReason: string | null = null;

  if (args.parentEntityLocalId && args.parentEntityKind) {
    const parents = await database.sync_queue
      .where('entityLocalId')
      .equals(args.parentEntityLocalId)
      .toArray();
    // Look at the parent's most recent op for this entityKind.
    const parent = parents
      .filter((p) => p.entityKind === args.parentEntityKind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (parent && parent.id !== undefined) {
      if (parent.state === 'queued' || parent.state === 'in_flight') {
        dependsOnQueueId = parent.id;
        // Defer the child past the parent's nextAttemptAt.
        nextAttemptAt = new Date(
          Math.max(now(), Date.parse(parent.nextAttemptAt) + 1),
        ).toISOString();
      } else if (parent.state === 'conflicting') {
        state = 'paused';
        pauseReason = 'parent_conflict';
        dependsOnQueueId = parent.id;
      } else if (parent.state === 'failed_dead_letter') {
        state = 'paused';
        pauseReason = 'parent_dead_letter';
        dependsOnQueueId = parent.id;
      }
      // parent.state === 'succeeded' shouldn't happen — succeeded rows
      // are deleted on drain success. If we ever see one, treat as
      // no-op (the child drains normally).
    }
  }

  // priv-F1 close-out (S5 fix bundle, T-S1 update): sync_queue.payload
  // stores the rep-typed body as PLAINTEXT JSON. For hazard / action_
  // item / inspection_finding / recommendation creates this includes
  // description, body, observation, corrective_action, responsible_
  // party, signature_note, reporter_identity, recommendation title /
  // body — fields the server seals before persisting. The original
  // 1.10 plan had the client envelope-encrypt under the workplace
  // public key before enqueue (mirroring the server's seal shape) so
  // a forensic dump of Dexie would yield only ciphertext; that plan
  // required refactoring every prior milestone's wire format to
  // accept ciphertext on the input side, which was out of scope for
  // 1.10. The 1.12 hardening backlog (docs/runbooks/offline-sync.md
  // §12) covers the structural fix via WebAuthn PRF / session-
  // derived Dexie at-rest encryption that wraps the entire DB
  // transparently without changing wire formats. Until then, the
  // rep's device carries plaintext drafts; lost-device incident
  // response is documented in the runbook §11.
  const newRow: Omit<SyncQueueRow, 'id'> = {
    kind: args.kind,
    entityKind: args.entityKind,
    entityLocalId: args.entityLocalId,
    payload: JSON.stringify(args.payload ?? null),
    httpMethod: args.httpMethod,
    endpoint: args.endpoint,
    ifMatchEtag: args.ifMatchEtag,
    idempotencyKey: args.idempotencyKey,
    attemptCount: 0,
    nextAttemptAt,
    state,
    lastError: null,
    createdAt: new Date(now()).toISOString(),
    dependsOnQueueId,
    pauseReason,
  };
  const id = await database.sync_queue.add(newRow as SyncQueueRow);
  return id as number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Map a SyncEntityKind to the Dexie table name (where applicable).
 * Returns null for kinds that don't have a per-entity row (the queue
 * row IS the entity, e.g. `evidence_finalize` which is the third leg of
 * the upload). */
function entityKindToTable(kind: SyncEntityKind): string | null {
  switch (kind) {
    case 'hazard':
      return 'hazards';
    case 'action_item':
      return 'action_items';
    case 'action_item_move':
      return 'action_item_moves';
    case 'inspection':
      return 'inspections';
    case 'inspection_finding':
      return 'inspection_findings';
    case 'inspection_signature':
      return 'inspection_signatures';
    case 'inspection_finding_promotion':
      // Promotion materializes a server-side action_item row; the
      // finding's promotedActionItemId is updated in place via the
      // success path's row.put().
      return 'inspection_findings';
    case 'recommendation':
      return 'recommendations';
    case 'recommendation_response':
      return 'recommendation_responses';
    case 'recommendation_resolution':
    case 'recommendation_withdrawal':
      return 'recommendations';
    case 'evidence_finalize':
      return 'evidence_files';
  }
}

// Export internal constants for tests.
export const _internal = {
  BATCH_SIZE,
  POLL_INTERVAL_MS,
  OFFLINE_FLOOR_MS,
  SYNC_BACKOFF_SCHEDULE,
  entityKindToTable,
};
