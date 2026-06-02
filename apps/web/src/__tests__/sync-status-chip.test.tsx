// Unit tests for the sync status chip (Milestone 1.10 S3).
//
// We stub the SyncQueueWorker singleton via setWorkerForTests so the
// chip's useSyncStatus hook subscribes to a controllable fake. Each
// test pushes a status into the fake and asserts the chip's accessible
// name + label + the panel-opens-on-click contract.

import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncQueueWorker, type SyncStatus } from '../sync/queue-worker';
import { setWorkerForTests } from '../sync/worker-singleton';
import { SyncStatusChip } from '../sync/components/sync-status-chip';
import { db } from '../sync/db';

let worker: SyncQueueWorker;

beforeEach(async () => {
  await db.open();
  await db.sync_queue.clear();
  await db.sync_conflicts.clear();
  worker = new SyncQueueWorker({
    database: db,
    dispatcher: vi.fn().mockResolvedValue({ kind: 'transient_failure', error: 'test' }),
  });
  setWorkerForTests(worker);
});

afterEach(async () => {
  worker.stop();
  setWorkerForTests(null);
  await new Promise((r) => setTimeout(r, 0));
  await db.sync_queue.clear();
  await db.sync_conflicts.clear();
});

/** Drive the worker's status to a value by tickling its private setter
 * via subscribe → manual push. The cleanest test surface is to call the
 * private `setStatus` through the worker's `subscribe` -> push flow:
 * here we just monkey-patch the status + re-emit. */
function pushStatus(s: SyncStatus): void {
  // The worker pushes the current status on subscribe; we exploit the
  // listener set by writing to status + firing the listener manually
  // via a fresh subscribe-then-unsubscribe. The class exposes
  // setStatus only as a private; access via the casted unknown to set
  // it. Tests-only.
  const w = worker as unknown as { status: SyncStatus; listeners: Set<(s: SyncStatus) => void> };
  act(() => {
    w.status = s;
    for (const l of w.listeners) l(s);
  });
}

describe('SyncStatusChip', () => {
  it('renders the Synced state with green CloudCheck label', () => {
    render(<SyncStatusChip />);
    // Default worker.status is { kind: 'synced' }
    const btn = screen.getByRole('button', { name: /Sync status: Synced/ });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('data-sync-state')).toBe('synced');
  });

  it('renders the Syncing state with count', () => {
    render(<SyncStatusChip />);
    pushStatus({ kind: 'syncing', inFlight: 1, queued: 2 });
    const btn = screen.getByRole('button', { name: /Sync status: Syncing 3…/ });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('data-sync-state')).toBe('syncing');
  });

  it('renders the Offline state with neutral icon', () => {
    render(<SyncStatusChip />);
    pushStatus({ kind: 'offline', queued: 4 });
    const btn = screen.getByRole('button', { name: /Sync status: Offline/ });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('data-sync-state')).toBe('offline');
    // The tooltip mentions the queued count.
    expect(btn.getAttribute('title')).toMatch(/4 changes will sync/);
  });

  it('renders the Paused state with reason + count tooltip', () => {
    render(<SyncStatusChip />);
    pushStatus({ kind: 'paused', reason: 'conflicts', queued: 1 });
    const btn = screen.getByRole('button', { name: /Sync status: Sync paused/ });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('data-sync-state')).toBe('paused');
    expect(btn.getAttribute('title')).toMatch(/conflict needs your decision/);
  });

  it('opens the sync panel on click', async () => {
    const user = userEvent.setup();
    render(<SyncStatusChip />);
    const btn = screen.getByRole('button', { name: /Sync status:/ });
    expect(screen.queryByRole('dialog', { name: /Sync/ })).not.toBeInTheDocument();
    await user.click(btn);
    expect(screen.getByRole('dialog', { name: /Sync/ })).toBeInTheDocument();
  });

  it('exposes aria-haspopup on the chip button', () => {
    render(<SyncStatusChip />);
    const btn = screen.getByRole('button', { name: /Sync status:/ });
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
  });
});

// fireEvent is used implicitly; keep the import alive.
void fireEvent;
