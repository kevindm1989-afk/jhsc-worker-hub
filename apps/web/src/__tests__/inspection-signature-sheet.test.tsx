// Unit tests for the OfflineSignatureTimestampNotice (priv-F3
// close-out, T-S54). The notice mirrors the recommendation
// OfflineSubmitClockNotice but for the signature flow — signatures
// are MORE evidentially weighty than recommendation submits, so the
// rep needs an informed-consent moment about the chain-timestamp
// divergence at sign time.

import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InspectionSignatureSheet } from '../components/inspection-signature-sheet';
import { db } from '../sync/db';

const INSPECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(async () => {
  await db.open();
  await db.sync_queue.clear();
});

afterEach(async () => {
  await db.sync_queue.clear();
});

function renderSheet(): void {
  render(
    <InspectionSignatureSheet
      inspectionId={INSPECTION_ID}
      state="awaiting_signatures"
      requiresThreeSignatures={false}
      templateDisplayName="Zone Monthly"
      templateVersionNote="v1"
      signatures={[]}
      onSigned={() => undefined}
    />,
  );
}

describe('OfflineSignatureTimestampNotice (priv-F3 close-out, T-S54)', () => {
  it('does NOT render when no inspection_signature op is queued for this inspection', async () => {
    renderSheet();
    // No pending sig — no notice.
    await waitFor(() => {
      expect(screen.queryByTestId('offline-signature-timestamp-notice')).not.toBeInTheDocument();
    });
  });

  it('renders when sync_queue has a pending inspection_signature op for the current inspection', async () => {
    // Seed a queued inspection_signature op for THIS inspection.
    await db.sync_queue.add({
      kind: 'create',
      entityKind: 'inspection_signature',
      entityLocalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      payload: JSON.stringify({ role: 'inspector' }),
      httpMethod: 'POST',
      endpoint: `/api/inspections/${INSPECTION_ID}/signatures`,
      ifMatchEtag: null,
      idempotencyKey: 'idem-1',
      attemptCount: 0,
      nextAttemptAt: '2026-06-02T10:00:00.000Z',
      state: 'queued',
      lastError: null,
      createdAt: '2026-06-02T10:00:00.000Z',
      dependsOnQueueId: null,
      pauseReason: null,
    });

    renderSheet();

    await waitFor(() => {
      expect(screen.getByTestId('offline-signature-timestamp-notice')).toBeInTheDocument();
    });

    // The rights-protective copy is present verbatim.
    expect(screen.getByText(/Signature queued — chain timestamp at server/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /The chain of custody timestamp will be the SERVER's receive time, NOT the moment you signed\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/For arbitration purposes, your device's clock-time is your record/),
    ).toBeInTheDocument();
  });

  it('does NOT render when a queued signature op targets a DIFFERENT inspection', async () => {
    const OTHER_INSPECTION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await db.sync_queue.add({
      kind: 'create',
      entityKind: 'inspection_signature',
      entityLocalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      payload: JSON.stringify({ role: 'inspector' }),
      httpMethod: 'POST',
      endpoint: `/api/inspections/${OTHER_INSPECTION_ID}/signatures`,
      ifMatchEtag: null,
      idempotencyKey: 'idem-2',
      attemptCount: 0,
      nextAttemptAt: '2026-06-02T10:00:00.000Z',
      state: 'queued',
      lastError: null,
      createdAt: '2026-06-02T10:00:00.000Z',
      dependsOnQueueId: null,
      pauseReason: null,
    });

    renderSheet();

    await waitFor(() => {
      // Defer slightly to let the effect run.
      expect(screen.queryByTestId('offline-signature-timestamp-notice')).not.toBeInTheDocument();
    });
  });

  it('does NOT render for queue rows in other states (e.g. failed_dead_letter)', async () => {
    await db.sync_queue.add({
      kind: 'create',
      entityKind: 'inspection_signature',
      entityLocalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      payload: JSON.stringify({ role: 'inspector' }),
      httpMethod: 'POST',
      endpoint: `/api/inspections/${INSPECTION_ID}/signatures`,
      ifMatchEtag: null,
      idempotencyKey: 'idem-3',
      attemptCount: 8,
      nextAttemptAt: '2026-06-02T10:00:00.000Z',
      state: 'failed_dead_letter',
      lastError: 'something',
      createdAt: '2026-06-02T10:00:00.000Z',
      dependsOnQueueId: null,
      pauseReason: null,
    });

    renderSheet();

    await waitFor(() => {
      // Notice only fires for queued / in_flight states.
      expect(screen.queryByTestId('offline-signature-timestamp-notice')).not.toBeInTheDocument();
    });
  });
});
