import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { InspectionDetailView } from '../views/inspection-detail-view';

// Verifies the state-aware affordances on the conduct-flow view:
//   - in_progress: per-item "Add finding" buttons rendered;
//     "Finish capture" disabled with zero findings, enabled with ≥1.
//   - awaiting_signatures: signature sheet renders one role for
//     zone_monthly, three roles for rack_inspection.

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | undefined,
): RecordedRequest[] {
  const real = globalThis.fetch as typeof fetch;
  const log: RecordedRequest[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    log.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const r = handler(url, init);
    if (r) return Promise.resolve(r);
    return (real as typeof fetch)(input, init);
  }) as unknown as typeof fetch;
  return log;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const INSPECTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const ZONE_MONTHLY_BASE = {
  id: INSPECTION_ID,
  templateCode: 'zone_monthly',
  templateVersionId: 't-zm-v1',
  templateDisplayName: 'Zone Monthly Walk-through',
  statusVocab: 'ABC_X',
  cadence: 'monthly',
  requiresThreeSignatures: false,
  sections: [
    {
      key: 'walk_through',
      label: 'Walk-through',
      items: [
        { key: 'floor_clear', label: 'Floor clear of trip hazards' },
        { key: 'signage_visible', label: 'Signage visible and legible' },
      ],
    },
  ],
  zoneId: 'zone_3',
  state: 'in_progress',
  conductedByUserId: 'user-1',
  scheduledFor: '2026-05-29T10:00:00Z',
  startedAt: '2026-05-29T10:05:00Z',
  completedAt: null,
  createdAt: '2026-05-29T09:55:00Z',
  findings: [],
  signatures: [],
};

const RACK_AWAITING = {
  id: INSPECTION_ID,
  templateCode: 'rack_inspection',
  templateVersionId: 't-rack-v1',
  templateDisplayName: 'Rack Inspection',
  statusVocab: 'GAR',
  cadence: 'annual',
  requiresThreeSignatures: true,
  sections: [
    {
      key: 'structural',
      label: 'Structural',
      items: [{ key: 'plumb', label: 'Uprights plumb (per CSA A344.1)' }],
    },
  ],
  zoneId: 'zone_5',
  state: 'awaiting_signatures',
  conductedByUserId: 'user-1',
  scheduledFor: '2026-05-28T10:00:00Z',
  startedAt: '2026-05-28T10:05:00Z',
  completedAt: null,
  createdAt: '2026-05-28T09:55:00Z',
  findings: [
    {
      id: 'fffffff1-ffff-ffff-ffff-ffffffffffff',
      sectionKey: 'structural',
      sectionLabel: 'Structural',
      itemKey: 'plumb',
      itemLabel: 'Uprights plumb (per CSA A344.1)',
      statusVocab: 'GAR',
      statusValue: 'A',
      hasObservation: true,
      hasCorrectiveAction: true,
      hasResponsibleParty: false,
      promotedActionItemId: null,
      createdAt: '2026-05-28T10:30:00Z',
    },
  ],
  signatures: [],
};

const ZONE_MONTHLY_WITH_FINDING = {
  ...ZONE_MONTHLY_BASE,
  findings: [
    {
      id: 'fffffff2-ffff-ffff-ffff-ffffffffffff',
      sectionKey: 'walk_through',
      sectionLabel: 'Walk-through',
      itemKey: 'floor_clear',
      itemLabel: 'Floor clear of trip hazards',
      statusVocab: 'ABC_X',
      statusValue: 'B',
      hasObservation: true,
      hasCorrectiveAction: false,
      hasResponsibleParty: false,
      promotedActionItemId: null,
      createdAt: '2026-05-29T10:15:00Z',
    },
  ],
};

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={[`/inspections/${INSPECTION_ID}`]}>
      <Routes>
        <Route path="/inspections/:id" element={<InspectionDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InspectionDetailView — in_progress', () => {
  it('renders per-item Add finding buttons and disables Finish capture with zero findings', async () => {
    mockFetch((url) => {
      if (url === `/api/inspections/${INSPECTION_ID}`) {
        return jsonResponse(ZONE_MONTHLY_BASE);
      }
      return undefined;
    });
    renderAt();
    await screen.findByText('Zone Monthly Walk-through');
    // Each template item gets its own "Add finding" button — the
    // zone_monthly fixture has 2 items in one section.
    const addButtons = screen.getAllByRole('button', { name: /Add finding/i });
    expect(addButtons.length).toBeGreaterThanOrEqual(2);
    // Finish capture button is rendered but disabled (zero findings).
    const finish = screen.getByRole('button', { name: /Finish capture/i });
    expect(finish).toBeDisabled();
  });

  it('enables Finish capture once at least one finding exists', async () => {
    mockFetch((url) => {
      if (url === `/api/inspections/${INSPECTION_ID}`) {
        return jsonResponse(ZONE_MONTHLY_WITH_FINDING);
      }
      return undefined;
    });
    renderAt();
    await screen.findByText('Zone Monthly Walk-through');
    const finish = screen.getByRole('button', { name: /Finish capture/i });
    expect(finish).not.toBeDisabled();
    // The finding card is present.
    expect(screen.getByText(/1 finding recorded so far/)).toBeInTheDocument();
  });
});

describe('InspectionDetailView — awaiting_signatures signature sheet', () => {
  it('shows three sign-as affordances for a rack template (3-sig)', async () => {
    mockFetch((url) => {
      if (url === `/api/inspections/${INSPECTION_ID}`) {
        return jsonResponse(RACK_AWAITING);
      }
      return undefined;
    });
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Rack Inspection' });
    // Three roles each get a sign affordance.
    expect(screen.getByRole('button', { name: /Sign as Inspector/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign as Supervisor/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Sign as JHSC worker co-chair/i }),
    ).toBeInTheDocument();
  });

  it('shows one sign-as affordance for zone_monthly (1-sig)', async () => {
    const zoneMonthlyAwaiting = {
      ...ZONE_MONTHLY_WITH_FINDING,
      state: 'awaiting_signatures',
    };
    mockFetch((url) => {
      if (url === `/api/inspections/${INSPECTION_ID}`) {
        return jsonResponse(zoneMonthlyAwaiting);
      }
      return undefined;
    });
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'Zone Monthly Walk-through' });
    expect(screen.getByRole('button', { name: /Sign as Inspector/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign as Supervisor/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Sign as JHSC worker co-chair/i }),
    ).not.toBeInTheDocument();
  });
});
