// Unit tests for the sync panel (Milestone 1.10 S3).
//
// Drives the panel with a fake-indexeddb-backed Dexie + a stubbed
// SyncQueueWorker singleton. Each test seeds rows into the local DB,
// renders the panel, and asserts the row counts + the manual-drain
// trigger + the dead-letter Retry / Discard flow.

import 'fake-indexeddb/auto';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncQueueWorker } from '../sync/queue-worker';
import { setWorkerForTests } from '../sync/worker-singleton';
import { SyncPanel } from '../sync/components/sync-panel';
import { db } from '../sync/db';

// The panel + worker singletons read the module-level `db` singleton.
// We share that DB across tests but clear all tables in beforeEach so
// each test starts from a clean snapshot. fake-indexeddb (loaded via
// setup.ts) backs the singleton; the test runner is otherwise the same
// shape any production drain would take.

let worker: SyncQueueWorker;

const ALL_TABLES = [
  'sync_queue',
  'sync_conflicts',
  '_base_state',
  'hazards',
  'action_items',
  'recommendations',
  'evidence_files',
] as const;

async function clearAllTables(): Promise<void> {
  for (const t of ALL_TABLES) {
    await (db as unknown as Record<string, { clear: () => Promise<void> }>)[t]?.clear?.();
  }
}

beforeEach(async () => {
  await db.open();
  await clearAllTables();
  worker = new SyncQueueWorker({
    database: db,
    // Default to transient_failure so any seeded queue rows that the
    // drainNow() spinner reaches don't blow up applyResult with an
    // undefined return shape.
    dispatcher: vi.fn().mockResolvedValue({ kind: 'transient_failure', error: 'test' }),
  });
  setWorkerForTests(worker);
});

afterEach(async () => {
  worker.stop();
  setWorkerForTests(null);
  // Let any in-flight drainNow microtasks resolve against the still-open
  // DB before we move on.
  await new Promise((r) => setTimeout(r, 0));
  await clearAllTables();
});

async function seedPending(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.sync_queue.add({
      kind: 'update',
      entityKind: 'hazard',
      entityLocalId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`,
      payload: '{}',
      httpMethod: 'PATCH',
      endpoint: '/api/hazards/x',
      ifMatchEtag: 0,
      idempotencyKey: `idem-${i}`,
      attemptCount: 0,
      nextAttemptAt: new Date(Date.now() + 5_000).toISOString(),
      state: 'queued',
      lastError: null,
      createdAt: new Date().toISOString(),
      dependsOnQueueId: null,
      pauseReason: null,
    });
  }
}

async function seedConflict(): Promise<void> {
  await db.sync_conflicts.add({
    entityKind: 'recommendation',
    entityLocalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    localStateJson: JSON.stringify({ status: 'draft', version: 1 }),
    serverStateJson: JSON.stringify({ status: 'submitted', version: 2 }),
    baseStateJson: JSON.stringify({ status: 'draft', version: 1 }),
    serverVersion: 2,
    detectedAt: new Date().toISOString(),
    resolved: 0,
  });
}

async function seedDeadLetter(): Promise<void> {
  await db.sync_queue.add({
    kind: 'create',
    entityKind: 'hazard',
    entityLocalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    payload: '{}',
    httpMethod: 'POST',
    endpoint: '/api/hazards',
    ifMatchEtag: null,
    idempotencyKey: 'idem-dl',
    attemptCount: 8,
    nextAttemptAt: new Date().toISOString(),
    state: 'failed_dead_letter',
    lastError: '500 server_error',
    createdAt: new Date().toISOString(),
    dependsOnQueueId: null,
    pauseReason: null,
  });
}

describe('SyncPanel', () => {
  it('renders empty states for all three subsections by default', async () => {
    render(<SyncPanel open onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Nothing pending\. All changes are synced\./)).toBeInTheDocument();
      expect(screen.getByText(/No conflicts\./)).toBeInTheDocument();
      expect(screen.getByText(/No operations stuck\. You're all caught up\./)).toBeInTheDocument();
    });
  });

  it('renders pending operations with counts', async () => {
    await seedPending(2);
    render(<SyncPanel open onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('(2)')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Hazard').length).toBeGreaterThan(0);
  });

  it('renders a conflict row + opens the resolution dialog on click', async () => {
    await seedConflict();
    const user = userEvent.setup();
    render(<SyncPanel open onOpenChange={vi.fn()} />);
    const resolveBtn = await screen.findByRole('button', { name: /Resolve conflict/i });
    await user.click(resolveBtn);
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Sync conflict/i })).toBeInTheDocument();
    });
  });

  it('renders dead letter and requires confirmation before Discard', async () => {
    await seedDeadLetter();
    const user = userEvent.setup();
    render(<SyncPanel open onOpenChange={vi.fn()} />);
    const discardBtn = await screen.findByRole('button', { name: /^Discard$/i });
    await user.click(discardBtn);
    // First click only surfaces the confirm; the row is NOT yet gone.
    expect(await db.sync_queue.count()).toBe(1);
    // Confirmation panel asks for a second tap.
    const confirmBtn = await screen.findByRole('button', { name: /^Discard$/i });
    await user.click(confirmBtn);
    await waitFor(async () => {
      expect(await db.sync_queue.count()).toBe(0);
    });
  });

  it('Sync now calls worker.drainNow()', async () => {
    const drainNow = vi.spyOn(worker, 'drainNow').mockResolvedValue();
    const user = userEvent.setup();
    render(<SyncPanel open onOpenChange={vi.fn()} />);
    const sync = await screen.findByRole('button', { name: /Sync now/i });
    await user.click(sync);
    await waitFor(() => {
      expect(drainNow).toHaveBeenCalled();
    });
  });

  it('Retry on a dead-letter row re-queues it', async () => {
    await seedDeadLetter();
    // Stub drainNow to a no-op so the fire-and-forget kick the Retry
    // handler issues doesn't leak a rejected promise into the next
    // test (the dispatcher's `transient_failure` would attempt to write
    // back to a row whose state we're racing).
    const drainNow = vi.spyOn(worker, 'drainNow').mockResolvedValue();
    const user = userEvent.setup();
    render(<SyncPanel open onOpenChange={vi.fn()} />);
    const retry = await screen.findByRole('button', { name: /^Retry$/ });
    await act(async () => {
      await user.click(retry);
    });
    await waitFor(async () => {
      const rows = await db.sync_queue.toArray();
      expect(rows[0]?.state).toBe('queued');
      expect(rows[0]?.attemptCount).toBe(0);
    });
    expect(drainNow).toHaveBeenCalled();
    void within; // satisfy import lint
  });
});
