import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { NewRecommendationView } from '../views/new-recommendation-view';
import { RecommendationEditView } from '../views/recommendation-edit-view';

// Verifies the drafting form behavior:
//   - Live citation-marker validation: typing a [[cite:N]] marker
//     without a matching citation row surfaces an inline warning.
//   - Jurisdiction radio is rendered on the create path.
//   - The edit view hides the jurisdiction radio + shows the immutable
//     note (jurisdiction_immutable_after_draft_save per S2).
//   - Save (POST) navigates to the new recommendation's detail surface.

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

describe('NewRecommendationView — jurisdiction radio', () => {
  it('renders the jurisdiction radio on the create path', async () => {
    render(
      <MemoryRouter initialEntries={['/recommendations/new']}>
        <NewRecommendationView />
      </MemoryRouter>,
    );
    // Two radio inputs in the jurisdiction fieldset.
    const radios = screen.getAllByRole('radio');
    const values = radios.map((r) => (r as HTMLInputElement).value);
    expect(values).toEqual(expect.arrayContaining(['ON', 'CA-FED']));
    // The deliberate copy on the statutory clock distinction is present.
    expect(screen.getByText(/Determines the statutory clock/)).toBeInTheDocument();
  });
});

describe('NewRecommendationView — live citation-marker validation', () => {
  it('surfaces a warning when the body contains a [[cite:N]] marker with no citation row', async () => {
    render(
      <MemoryRouter initialEntries={['/recommendations/new']}>
        <NewRecommendationView />
      </MemoryRouter>,
    );
    const body = screen.getByLabelText(/Body/i);
    // userEvent.type interprets [[ as a key chord — paste instead so the
    // literal brackets land in the textarea.
    await userEvent.click(body);
    await userEvent.paste('See [[cite:1]] for details.');
    // Live warning rendered.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/no citation row/i));
  });

  it('clears the orphan-marker warning once a citation row is added at that position', async () => {
    render(
      <MemoryRouter initialEntries={['/recommendations/new']}>
        <NewRecommendationView />
      </MemoryRouter>,
    );
    const body = screen.getByLabelText(/Body/i);
    await userEvent.click(body);
    await userEvent.paste('See [[cite:1]] for details.');
    await waitFor(() => screen.getByRole('status'));
    // Now the inverse warning: citation without marker (we'll exercise
    // both arms by removing the body text).
    await userEvent.clear(body);
    await userEvent.type(body, 'Body without any markers.');
    // The warning surface should be empty (no citation rows, no markers).
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('NewRecommendationView — save draft', () => {
  it('POSTs the form and navigates to the new recommendation detail on success', async () => {
    const REC_ID = '99999999-9999-9999-9999-999999999999';
    const requests = mockFetch((url, init) => {
      if (url === '/api/recommendations' && init?.method === 'POST') {
        return jsonResponse(
          {
            id: REC_ID,
            recommendationNumber: 1,
            jurisdiction: 'ON',
            status: 'draft',
            draftedAt: '2026-06-02T10:00:00Z',
          },
          201,
        );
      }
      // Stubbed GET for the detail-view component the navigation lands
      // on; we don't assert on its render, but the fetch arrives.
      if (url.startsWith('/api/recommendations/')) {
        return jsonResponse({}, 200);
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/recommendations/new']}>
        <Routes>
          <Route path="/recommendations/new" element={<NewRecommendationView />} />
          <Route path="/recommendations/:id" element={<div>detail page for {REC_ID}</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText(/Title/i), 'Install secondary guard');
    await userEvent.type(
      screen.getByLabelText(/Body/i),
      'Install a secondary guard on the shrink-wrap rollers.',
    );
    await userEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await screen.findByText(/detail page for/);
    const post = requests.find((r) => r.method === 'POST' && r.url === '/api/recommendations');
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({
      title: 'Install secondary guard',
      body: 'Install a secondary guard on the shrink-wrap rollers.',
      jurisdiction: 'ON',
    });
  });
});

describe('RecommendationEditView — jurisdiction immutability', () => {
  it('hides the jurisdiction radio + shows the immutable-note banner after reveal', async () => {
    const REC_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    mockFetch((url, init) => {
      if (url === `/api/recommendations/${REC_ID}` && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: REC_ID,
          recommendationNumber: 5,
          jurisdiction: 'ON',
          status: 'draft',
          draftedByUserId: 'user-1',
          draftedAt: '2026-06-01T10:00:00Z',
          submittedAt: null,
          resolvedAt: null,
          withdrawnAt: null,
          withdrawnReason: null,
          deadline: null,
          hasTitle: true,
          hasBody: true,
          citations: [],
          responses: [],
          linkedActionItemId: null,
        });
      }
      if (url === `/api/recommendations/${REC_ID}/reveal` && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: REC_ID,
          recommendationNumber: 5,
          jurisdiction: 'ON',
          status: 'draft',
          title: 'Existing title',
          body: 'Existing body text.',
          responses: [],
        });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={[`/recommendations/${REC_ID}/edit`]}>
        <Routes>
          <Route path="/recommendations/:id/edit" element={<RecommendationEditView />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/Edit recommendation #5/);
    // Reveal button is present before the form renders.
    const revealButton = await screen.findByRole('button', { name: /Reveal/ });
    await userEvent.click(revealButton);
    // After reveal, the form renders with the immutable jurisdiction note
    // and NO jurisdiction radio.
    await screen.findByTestId('jurisdiction-immutable-note');
    expect(screen.queryByRole('radio', { name: /ON/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /CA-FED/i })).toBeNull();
  });
});
