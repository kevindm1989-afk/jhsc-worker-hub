import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LegalView } from '../views/legal-view';
import { CitationRef } from '../legal/citation-ref';

// ---------------------------------------------------------------------------
// Per-test fetch override — the global setup.ts default returns 404 for
// /api/legal/*, which is what we want unless a test installs a richer mock.
// ---------------------------------------------------------------------------

function mockLegalFetch(handler: (url: string) => Response | undefined): void {
  const real = globalThis.fetch as typeof fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = handler(url);
    if (response) return Promise.resolve(response);
    return (real as typeof fetch)(input, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OHSA_STATUTE = {
  id: '11111111-1111-1111-1111-111111111111',
  code: 'OHSA',
  jurisdiction: 'ON',
  title: 'Occupational Health and Safety Act',
  licence: 'crown_copyright_open',
  sourceUrl: 'https://www.ontario.ca/laws/statute/90o01',
};

const OHSA_CLAUSE_920 = {
  id: '22222222-2222-2222-2222-222222222222',
  statute: { code: 'OHSA', title: 'OHSA', licence: 'crown_copyright_open' },
  citation: 's.9(20)',
  hierarchyPath: ['Part II', 's.9', '(20)'],
  heading: 'Recommendations',
  body: 'A committee shall make recommendations.',
  bodySummary: null,
  bodyKind: 'full_text',
  bodyHash: 'a'.repeat(64),
  versionDate: '2020-07-01',
  sourceUrl: 'https://www.ontario.ca/laws/statute/90o01#BK14',
  supersededBy: null,
};

describe('LegalView — browse mode', () => {
  it('renders the statute index from /api/legal/statutes', async () => {
    mockLegalFetch((url) => {
      if (url.endsWith('/api/legal/statutes')) {
        return jsonResponse({ activeVersion: 'v-test', items: [OHSA_STATUTE] });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/legal']}>
        <LegalView />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: /OHSA/i });
    expect(link).toHaveAttribute('href', '/legal?statute=OHSA');
  });
});

describe('LegalView — clause deep link', () => {
  it('renders the clause body for ?statute=OHSA&citation=s.9(20)', async () => {
    mockLegalFetch((url) => {
      if (url.includes('/api/legal/clauses?')) {
        return jsonResponse({ items: [OHSA_CLAUSE_920] });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/legal?statute=OHSA&citation=s.9(20)']}>
        <LegalView />
      </MemoryRouter>,
    );
    await screen.findByText(/A committee shall make recommendations/);
  });

  it('renders MissingCitation when the clause is not in the active corpus', async () => {
    mockLegalFetch((url) => {
      if (url.includes('/api/legal/clauses?')) {
        return jsonResponse({ items: [] });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/legal?statute=OHSA&citation=s.9(999)']}>
        <LegalView />
      </MemoryRouter>,
    );
    await screen.findByText(/No clause matches/);
  });
});

describe('LegalView — search', () => {
  it('renders FTS hits with mark snippets from /api/legal/search', async () => {
    mockLegalFetch((url) => {
      if (url.includes('/api/legal/search?')) {
        return jsonResponse({
          query: 'recommendations',
          activeVersion: 'v-test',
          items: [
            {
              id: OHSA_CLAUSE_920.id,
              statuteCode: 'OHSA',
              citation: 's.9(20)',
              heading: 'Recommendations',
              bodyKind: 'full_text',
              versionDate: '2020-07-01',
              rank: 0.5,
              snippet: 'A committee shall make <mark>recommendations</mark>.',
            },
          ],
        });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/legal?q=recommendations']}>
        <LegalView />
      </MemoryRouter>,
    );
    await screen.findByText(/1 match/);
    const mark = await waitFor(() => {
      const el = document.querySelector('mark');
      if (!el) throw new Error('no <mark>');
      return el;
    });
    expect(mark.textContent).toBe('recommendations');
  });
});

describe('CitationRef', () => {
  it('lazy-loads the clause on first open and renders the body', async () => {
    mockLegalFetch((url) => {
      if (url.includes('/api/legal/clauses?')) {
        return jsonResponse({ items: [OHSA_CLAUSE_920] });
      }
      return undefined;
    });
    render(
      <MemoryRouter>
        <CitationRef statute="OHSA" citation="s.9(20)" />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole('button', { name: /Citation: OHSA s.9\(20\)/i });
    await userEvent.click(trigger);
    await screen.findByText(/A committee shall make recommendations/);
    // Has the "Open in Legal Reference" deep link.
    const link = screen.getByRole('link', { name: /Open in Legal Reference/i });
    expect(link).toHaveAttribute('href', '/legal?statute=OHSA&citation=s.9(20)');
  });

  it('shows MissingCitation when the active corpus returns no row', async () => {
    mockLegalFetch((url) => {
      if (url.includes('/api/legal/clauses?')) {
        return jsonResponse({ items: [] });
      }
      return undefined;
    });
    render(
      <MemoryRouter>
        <CitationRef statute="OHSA" citation="s.9(999)" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Citation: OHSA s.9\(999\)/i }));
    await screen.findByText(/No clause matches/);
  });
});
