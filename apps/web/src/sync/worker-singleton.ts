// Module-level SyncQueueWorker singleton for the rep-facing UI (S3).
//
// The queue-worker.ts class is the engine; this module exposes the one
// shared instance the web app uses, plus a tiny React hook
// (`useSyncStatus`) so the chip can subscribe without each call site
// re-importing the worker by name.
//
// Tests can swap the singleton via `setWorkerForTests(...)` — the chip,
// panel, and dialog all consume the worker through `getWorker()` so a
// test that wants a fake-indexeddb-backed worker can drop one in.
//
// We intentionally DO NOT auto-start the worker from this module: the
// app shell decides when to start (after auth completes). The worker's
// `start()` is idempotent, so re-calling is safe.

import { useEffect, useState } from 'react';
import { SyncQueueWorker, type SyncStatus } from './queue-worker';

let instance: SyncQueueWorker | null = null;

/** Lazily construct + return the shared SyncQueueWorker. */
export function getWorker(): SyncQueueWorker {
  if (instance === null) {
    instance = new SyncQueueWorker();
  }
  return instance;
}

/** Test hook: inject a worker (e.g. one bound to a fake-indexeddb db). */
export function setWorkerForTests(worker: SyncQueueWorker | null): void {
  instance = worker;
}

/**
 * Subscribe a React component to status changes. The hook returns the
 * latest status — the worker pushes the current status on subscribe so
 * the first render is not stuck on a default.
 */
export function useSyncStatus(): SyncStatus {
  const worker = getWorker();
  const [status, setStatus] = useState<SyncStatus>(() => worker.getStatus());
  useEffect(() => {
    const unsub = worker.subscribe(setStatus);
    return unsub;
  }, [worker]);
  return status;
}
