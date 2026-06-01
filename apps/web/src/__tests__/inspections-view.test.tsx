import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { InspectionsView } from '../views/inspections-view';

// Per-test fetch override — global setup.ts default returns 404 for
// /api/inspections/*, so each test installs a richer mock.

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

const INSP_ZM = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  templateCode: 'zone_monthly',
  templateVersionId: 't1',
  zoneId: 'zone_3',
  state: 'in_progress',
  scheduledFor: '2026-05-29T10:00:00Z',
  startedAt: '2026-05-29T10:00:00Z',
  completedAt: null,
  conductedByUserId: 'user-1',
  createdAt: '2026-05-29T09:55:00Z',
};

const INSP_RACK = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  templateCode: 'rack_inspection',
  templateVersionId: 't2',
  zoneId: 'zone_5',
  state: 'complete',
  scheduledFor: '2026-05-28T10:00:00Z',
  startedAt: '2026-05-28T10:00:00Z',
  completedAt: '2026-05-28T11:30:00Z',
  conductedByUserId: 'user-2',
  createdAt: '2026-05-28T09:55:00Z',
};

describe('InspectionsView — empty state', () => {
  it('renders the empty-state CTA when the list is empty', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/inspections')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/inspections']}>
        <InspectionsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No inspections yet/);
    // CTA tells the user what to do — empty states do work (CLAUDE.md).
    const newCta = await screen.findByRole('link', { name: /New inspection/i });
    expect(newCta).toHaveAttribute('href', '/inspections/new');
    expect(screen.getByRole('link', { name: /Browse templates/i })).toHaveAttribute(
      'href',
      '/inspection-templates',
    );
  });

  it('changes the empty-state copy when a filter is applied', async () => {
    mockFetch((url) => {
      if (url.includes('/api/inspections')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/inspections?state=scheduled']}>
        <InspectionsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No inspections match the current filters/);
  });
});

describe('InspectionsView — list rendering', () => {
  it('renders one card per inspection with template + zone + state', async () => {
    mockFetch((url) => {
      if (url.includes('/api/inspections')) {
        return jsonResponse({ items: [INSP_ZM, INSP_RACK] });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/inspections']}>
        <InspectionsView />
      </MemoryRouter>,
    );
    await screen.findByText(/Zone Monthly · Zone 3/);
    expect(screen.getByText(/Rack Inspection · Zone 5/)).toBeInTheDocument();
    // State badges colour-coded; their aria-labels exercise the badge
    // accessibility surface from inspections/components.tsx.
    expect(screen.getByLabelText('State: In progress')).toBeInTheDocument();
    expect(screen.getByLabelText('State: Complete')).toBeInTheDocument();
  });
});

describe('InspectionsView — filter chips', () => {
  it('toggles a state filter into the URL and re-queries the API', async () => {
    const requests = mockFetch((url) => {
      if (url.includes('/api/inspections')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/inspections']}>
        <InspectionsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No inspections yet/);
    const scheduledChip = screen.getByRole('button', { name: 'Scheduled' });
    expect(scheduledChip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(scheduledChip);
    await waitFor(() => expect(scheduledChip).toHaveAttribute('aria-pressed', 'true'));
    const recent = requests.filter((r) => r.url.includes('/api/inspections'));
    expect(recent.some((r) => r.url.includes('state=scheduled'))).toBe(true);
  });
});
