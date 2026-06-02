// Unit tests for the conflict resolution dialog (Milestone 1.10 S3).
//
// Covers:
//   - Three-way columns render (Yours / Theirs / Base)
//   - Encrypted-field "Reveal" triggers stepUpEmitter
//   - Chain-anchored variant exposes the ADR §3.7 verbatim copy
//   - Apply submits the resolution (writes sync_conflicts.resolved=1 +
//     enqueues a follow-up op)

import 'fake-indexeddb/auto';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictResolutionDialog } from '../sync/components/conflict-resolution-dialog';
import { db, type SyncConflictRow } from '../sync/db';
import { stepUpEmitter } from '../auth/api';

beforeEach(async () => {
  await db.open();
  await db.sync_conflicts.clear();
  await db.sync_queue.clear();
  await db._base_state.clear();
  await db.recommendations.clear();
  await db.hazards.clear();
});

afterEach(async () => {
  await db.sync_conflicts.clear();
  await db.sync_queue.clear();
  await db._base_state.clear();
  await db.recommendations.clear();
  await db.hazards.clear();
});

function makeConflict(overrides: Partial<SyncConflictRow> = {}): SyncConflictRow {
  return {
    id: 1,
    entityKind: 'recommendation',
    entityLocalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    localStateJson: JSON.stringify({
      status: 'draft',
      title: 'local-ct-b64-blob',
      body: 'local-ct-b64-blob',
      jurisdiction: 'ON',
    }),
    serverStateJson: JSON.stringify({
      status: 'submitted',
      title: 'server-ct-b64-blob',
      body: 'server-ct-b64-blob',
      jurisdiction: 'ON',
    }),
    baseStateJson: JSON.stringify({
      status: 'draft',
      title: 'base-ct-b64-blob',
      body: 'base-ct-b64-blob',
      jurisdiction: 'ON',
    }),
    serverVersion: 2,
    detectedAt: new Date().toISOString(),
    resolved: 0,
    ...overrides,
  };
}

async function seedConflict(c: SyncConflictRow): Promise<void> {
  await db.sync_conflicts.put(c);
}

describe('ConflictResolutionDialog', () => {
  it('renders the three columns on desktop (Yours / Theirs / Base)', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    render(
      <ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    // Tab buttons are also "Yours" / "Theirs" / "Base"; use sections.
    const yoursSection = screen.getByRole('region', { name: 'Yours' });
    const theirsSection = screen.getByRole('region', { name: 'Theirs' });
    const baseSection = screen.getByRole('region', { name: 'Base' });
    expect(yoursSection).toBeInTheDocument();
    expect(theirsSection).toBeInTheDocument();
    expect(baseSection).toBeInTheDocument();
  });

  it('renders encrypted-field Reveal buttons and fires stepUpEmitter on click', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    const stepUpSpy = vi.spyOn(stepUpEmitter, 'dispatch');
    render(
      <ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    // The "title" field is encrypted; expect at least one Reveal button.
    const revealBtns = screen.getAllByRole('button', { name: /Reveal .* to compare/ });
    expect(revealBtns.length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(revealBtns[0]!);
    expect(stepUpSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^conflict\.reveal\.recommendation$/),
    );
  });

  it('shows the chain-anchored option with verbatim ADR §3.7 copy for recommendation', async () => {
    const conflict = makeConflict({ entityKind: 'recommendation' });
    await seedConflict(conflict);
    render(
      <ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    // The chain-anchored copy includes the explicit "10:14am" + "11:02am"
    // verbatim framing.
    expect(screen.getByText(/You submitted #3 offline at 10:14am/)).toBeInTheDocument();
    expect(
      screen.getByText(/the server received another submit for #3 at 11:02am/),
    ).toBeInTheDocument();
  });

  it('hides chain-anchored option for non-chain-anchored kinds (hazard)', async () => {
    const conflict = makeConflict({ entityKind: 'hazard' });
    await seedConflict(conflict);
    render(
      <ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    expect(screen.queryByText(/Anchor both/i)).not.toBeInTheDocument();
  });

  it('Apply with keep_local enqueues a follow-up update op + marks conflict resolved', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    const onResolved = vi.fn();
    const user = userEvent.setup();
    render(
      <ConflictResolutionDialog
        open
        conflict={conflict}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
    );
    // Default resolution is keep_local; click the matching Apply button.
    const apply = screen.getByRole('button', { name: /^Keep yours$/ });
    await act(async () => {
      await user.click(apply);
    });
    // The conflict is now resolved.
    const fresh = await db.sync_conflicts.get(conflict.id!);
    expect(fresh?.resolved).toBe(1);
    // A follow-up queue row has been added.
    const queueRows = await db.sync_queue.toArray();
    expect(queueRows.length).toBe(1);
    expect(queueRows[0]?.kind).toBe('update');
    expect(queueRows[0]?.ifMatchEtag).toBe(2);
    expect(onResolved).toHaveBeenCalled();
  });

  it('Apply label varies per resolution (Accept server / Anchor both / Apply merge)', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    const user = userEvent.setup();
    render(
      <ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    // keep_remote
    await user.click(screen.getByRole('radio', { name: /Accept server/i }));
    expect(screen.getByRole('button', { name: /^Accept server$/ })).toBeInTheDocument();
    // keep_both_chain_anchored
    await user.click(screen.getByRole('radio', { name: /Anchor both/i }));
    expect(screen.getByRole('button', { name: /^Anchor both$/ })).toBeInTheDocument();
    // manual_merge
    await user.click(screen.getByRole('radio', { name: /Manual merge/i }));
    expect(screen.getByRole('button', { name: /^Apply merge$/ })).toBeInTheDocument();
  });
});
