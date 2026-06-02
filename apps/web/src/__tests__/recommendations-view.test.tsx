import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RecommendationsView } from '../views/recommendations-view';

// Verifies the recommendations list surface:
//   - empty state with the rights-protective copy + statutory anchor;
//   - card rendering with badges + counts;
//   - filter chips toggling the URL query + re-querying the API;
//   - deadline countdown rendering for ON vs CA-FED.

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

const REC_DRAFT_ON = {
  id: '11111111-1111-1111-1111-111111111111',
  recommendationNumber: 42,
  jurisdiction: 'ON' as const,
  status: 'draft' as const,
  draftedAt: '2026-06-01T10:00:00Z',
  submittedAt: null,
  deadline: null,
  citationCount: 2,
  hasResponse: false,
};

const REC_SUBMITTED_ON = {
  id: '22222222-2222-2222-2222-222222222222',
  recommendationNumber: 7,
  jurisdiction: 'ON' as const,
  status: 'submitted' as const,
  draftedAt: '2026-05-15T10:00:00Z',
  submittedAt: '2026-05-20T10:00:00Z',
  // 21 days after 2026-05-20 is 2026-06-10 — in the future relative to
  // today's date (2026-06-02) so the rendered state will be "on_time".
  deadline: '2026-06-10T10:00:00Z',
  citationCount: 1,
  hasResponse: false,
};

const REC_SUBMITTED_CA_FED = {
  id: '33333333-3333-3333-3333-333333333333',
  recommendationNumber: 3,
  jurisdiction: 'CA-FED' as const,
  status: 'submitted' as const,
  draftedAt: '2026-05-01T10:00:00Z',
  submittedAt: '2026-05-05T10:00:00Z',
  // CA-FED: deadline is null per recommendationDeadlineState().
  deadline: null,
  citationCount: 0,
  hasResponse: false,
};

const REC_OVERDUE_ON = {
  id: '44444444-4444-4444-4444-444444444444',
  recommendationNumber: 1,
  jurisdiction: 'ON' as const,
  status: 'submitted' as const,
  draftedAt: '2026-04-01T10:00:00Z',
  submittedAt: '2026-04-05T10:00:00Z',
  // 2026-04-26 is well in the past relative to today's date (2026-06-02).
  deadline: '2026-04-26T10:00:00Z',
  citationCount: 1,
  hasResponse: false,
};

describe('RecommendationsView — empty state', () => {
  it('renders the rights-protective empty-state copy when the list is empty', async () => {
    mockFetch((url) => {
      if (url.includes('/api/recommendations')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations']}>
        <RecommendationsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No recommendations yet/);
    // Statutory anchor copy is present.
    expect(
      screen.getByText(/Notice of Recommendation under OHSA s.9\(20\) or CLC s.135\(5\)/),
    ).toBeInTheDocument();
    // Draft CTA links to /recommendations/new.
    const cta = await screen.findByRole('link', { name: /Draft recommendation/ });
    expect(cta).toHaveAttribute('href', '/recommendations/new');
  });

  it('changes the empty-state copy when filters are applied', async () => {
    mockFetch((url) => {
      if (url.includes('/api/recommendations')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations?status=draft']}>
        <RecommendationsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No recommendations match the current filters/);
  });
});

describe('RecommendationsView — list rendering', () => {
  it('renders one card per recommendation with number, jurisdiction badge, and status badge', async () => {
    mockFetch((url) => {
      if (url.includes('/api/recommendations')) {
        return jsonResponse({ items: [REC_DRAFT_ON, REC_SUBMITTED_ON] });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations']}>
        <RecommendationsView />
      </MemoryRouter>,
    );
    await screen.findByText(/Recommendation #42/);
    expect(screen.getByText(/Recommendation #7/)).toBeInTheDocument();
    // Both ON jurisdiction badges render.
    const onBadges = screen.getAllByLabelText('Jurisdiction: ON');
    expect(onBadges.length).toBeGreaterThanOrEqual(2);
    // The submitted row carries a deadline badge mentioning OHSA s.9(21).
    expect(screen.getByText(/OHSA s\.9\(21\)/)).toBeInTheDocument();
  });

  it('renders the CA-FED no-fixed-clock badge for CA-FED submitted rows', async () => {
    mockFetch((url) => {
      if (url.includes('/api/recommendations')) {
        return jsonResponse({ items: [REC_SUBMITTED_CA_FED] });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations']}>
        <RecommendationsView />
      </MemoryRouter>,
    );
    await screen.findByText(/Recommendation #3/);
    // CA-FED informational copy on the deadline badge.
    expect(screen.getByText(/No fixed clock/)).toBeInTheDocument();
    expect(screen.getByText(/CLC s\.135\(6\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Jurisdiction: CA-FED')).toBeInTheDocument();
  });

  it('marks overdue rows with the red border + overdue badge', async () => {
    mockFetch((url) => {
      if (url.includes('/api/recommendations')) {
        return jsonResponse({ items: [REC_OVERDUE_ON] });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations']}>
        <RecommendationsView />
      </MemoryRouter>,
    );
    await screen.findByText(/Recommendation #1/);
    expect(screen.getByRole('alert')).toHaveTextContent(/Overdue/);
  });
});

describe('RecommendationsView — filter chips', () => {
  it('toggles a status filter into the URL and re-queries the API', async () => {
    const requests = mockFetch((url) => {
      if (url.includes('/api/recommendations')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations']}>
        <RecommendationsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No recommendations yet/);
    const draftChip = screen.getByRole('button', { name: 'Draft' });
    expect(draftChip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(draftChip);
    await waitFor(() => expect(draftChip).toHaveAttribute('aria-pressed', 'true'));
    const recent = requests.filter((r) => r.url.includes('/api/recommendations'));
    expect(recent.some((r) => r.url.includes('status=draft'))).toBe(true);
  });

  it('toggles a jurisdiction filter into the URL and re-queries the API', async () => {
    const requests = mockFetch((url) => {
      if (url.includes('/api/recommendations')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations']}>
        <RecommendationsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No recommendations yet/);
    const caChip = screen.getByRole('button', { name: 'CA-FED' });
    await userEvent.click(caChip);
    await waitFor(() => expect(caChip).toHaveAttribute('aria-pressed', 'true'));
    const recent = requests.filter((r) => r.url.includes('/api/recommendations'));
    expect(recent.some((r) => r.url.includes('jurisdiction=CA-FED'))).toBe(true);
  });
});
