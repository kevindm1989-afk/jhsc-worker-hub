// Unit tests for the conflict resolution dialog (Milestone 1.10 S3).
//
// S5 fix bundle (priv-F4 + sec-F3 + sec-F4 close-out, T-S53): the
// Apply pipeline is DISABLED in 1.10 and lands in 1.12. The dialog
// ships VIEW-ONLY in 1.10. These tests now assert the view-only
// shape:
//   - Three-way columns (Yours / Theirs / Base) render so the rep
//     can compare plaintext metadata fields.
//   - Encrypted-field rows render the honest placeholder (no Reveal
//     button — burning a step-up on a no-op affordance is a
//     CLAUDE.md #16 spirit violation, see priv-F4).
//   - Apply button is disabled with the "1.12" label.
//   - The operator-script notice points at the runbook §7.
//   - Closing the dialog does NOT mark the conflict resolved or
//     enqueue any follow-up op.
//
// The prior Apply-related tests (keep_local enqueues PATCH; chain-
// anchored Anchor both copy; apply-label varies by resolution) are
// REMOVED because the surface they tested no longer exists.

import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictResolutionDialog } from '../sync/components/conflict-resolution-dialog';
import { db, type SyncConflictRow } from '../sync/db';

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

describe('ConflictResolutionDialog (1.10 view-only, T-S53)', () => {
  it('renders the three comparison columns on desktop (Yours / Theirs / Base)', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    render(<ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} />);
    const yoursSection = screen.getByRole('region', { name: 'Yours' });
    const theirsSection = screen.getByRole('region', { name: 'Theirs' });
    const baseSection = screen.getByRole('region', { name: 'Base' });
    expect(yoursSection).toBeInTheDocument();
    expect(theirsSection).toBeInTheDocument();
    expect(baseSection).toBeInTheDocument();
  });

  it('encrypted-field rows render the 1.12-defer placeholder (no Reveal button)', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    render(<ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} />);
    // The 1.10 placeholder copy is the contract the rep sees in lieu
    // of a working reveal. Asserting the exact verbiage locks in the
    // honest-shape disclosure.
    const placeholders = screen.getAllByText(
      /Encrypted\. The Apply pipeline ships in 1\.12\. To compare encrypted bodies in 1\.10, contact your operator\./,
    );
    expect(placeholders.length).toBeGreaterThan(0);
    // The Reveal button is gone — no step-up dispatch occurs.
    expect(screen.queryAllByRole('button', { name: /Reveal .* to compare/ })).toHaveLength(0);
  });

  it('Apply button is disabled with the 1.12 label and operator-script notice is visible', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    render(<ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} />);
    const applyBtn = screen.getByRole('button', { name: /Apply \(unavailable until 1\.12\)/ });
    expect(applyBtn).toBeDisabled();
    // Operator-script notice points at the runbook section.
    expect(screen.getByText(/Conflict resolution lands in 1\.12/)).toBeInTheDocument();
    expect(screen.getByText(/docs\/runbooks\/offline-sync\.md/)).toBeInTheDocument();
  });

  it('closing the dialog does NOT mark the conflict resolved or enqueue any op', async () => {
    const conflict = makeConflict();
    await seedConflict(conflict);
    const onClose = vi.fn();
    render(<ConflictResolutionDialog open conflict={conflict} onClose={onClose} />);
    // The conflict row stays unresolved; no queue rows are added.
    const fresh = await db.sync_conflicts.get(conflict.id!);
    expect(fresh?.resolved).toBe(0);
    const queueRows = await db.sync_queue.toArray();
    expect(queueRows).toHaveLength(0);
  });

  it('renders the hazard variant the same way (no per-kind branching in 1.10)', async () => {
    const conflict = makeConflict({ entityKind: 'hazard' });
    await seedConflict(conflict);
    render(<ConflictResolutionDialog open conflict={conflict} onClose={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Yours' })).toBeInTheDocument();
    // The chain-anchored option used to be hazard-gated; in 1.10 the
    // entire resolution picker is gone, so no "Anchor both" text on
    // any kind.
    expect(screen.queryByText(/Anchor both/i)).not.toBeInTheDocument();
  });
});
