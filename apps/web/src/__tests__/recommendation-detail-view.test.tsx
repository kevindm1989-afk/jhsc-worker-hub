import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RecommendationDetailView } from '../views/recommendation-detail-view';
import { stepUpEmitter } from '@/auth/api';

// Verifies the recommendation detail surface:
//   - Per-state lifecycle controls render the right buttons.
//   - Reveal dispatches stepUpEmitter on 401 step_up_required.
//   - Resolve dialog wires correctly (button opens, confirm POSTs).

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

const REC_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const REC_DRAFT = {
  id: REC_ID,
  recommendationNumber: 12,
  jurisdiction: 'ON' as const,
  status: 'draft' as const,
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
};

const REC_SUBMITTED = {
  ...REC_DRAFT,
  status: 'submitted' as const,
  submittedAt: '2026-06-02T10:00:00Z',
  // 21 days after submission — falls in the future.
  deadline: '2026-06-23T10:00:00Z',
  linkedActionItemId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

const REC_RESPONSE_RECEIVED = {
  ...REC_SUBMITTED,
  status: 'response_received' as const,
  responses: [
    {
      id: 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr',
      position: 1,
      receivedAt: '2026-06-04T10:00:00Z',
      receivedByUserId: 'user-1',
      hasAuthorRole: true,
      hasBody: true,
    },
  ],
};

const REC_RESOLVED = {
  ...REC_RESPONSE_RECEIVED,
  status: 'resolved' as const,
  resolvedAt: '2026-06-10T10:00:00Z',
};

function renderAt(path = `/recommendations/${REC_ID}`): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/recommendations/:id" element={<RecommendationDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecommendationDetailView — per-state lifecycle controls', () => {
  it('draft renders Edit + Submit + Withdraw', async () => {
    mockFetch((url) => {
      if (url === `/api/recommendations/${REC_ID}`) return jsonResponse(REC_DRAFT);
      return undefined;
    });
    renderAt();
    await screen.findByText(/Recommendation #12/);
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Submit$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Withdraw$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Capture response/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Resolve/ })).toBeNull();
  });

  it('submitted renders Capture response + Withdraw (no Submit / Edit)', async () => {
    mockFetch((url) => {
      if (url === `/api/recommendations/${REC_ID}`) return jsonResponse(REC_SUBMITTED);
      return undefined;
    });
    renderAt();
    await screen.findByText(/Recommendation #12/);
    expect(screen.getByRole('button', { name: /Capture response/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Withdraw$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Submit$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    // 21-day clock anchor copy is present (appears in both the deadline
    // badge and the StatutoryAnchor section — match all instances).
    expect(screen.getAllByText(/OHSA s\.9\(21\)/).length).toBeGreaterThan(0);
  });

  it('response_received renders Resolve + Capture additional response + Withdraw', async () => {
    mockFetch((url) => {
      if (url === `/api/recommendations/${REC_ID}`) {
        return jsonResponse(REC_RESPONSE_RECEIVED);
      }
      return undefined;
    });
    renderAt();
    await screen.findByText(/Recommendation #12/);
    expect(screen.getByRole('button', { name: /^Resolve$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Capture additional response/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Withdraw$/ })).toBeInTheDocument();
  });

  it('resolved is read-only', async () => {
    mockFetch((url) => {
      if (url === `/api/recommendations/${REC_ID}`) return jsonResponse(REC_RESOLVED);
      return undefined;
    });
    renderAt();
    await screen.findByText(/Recommendation #12/);
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Resolve$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Withdraw$/ })).toBeNull();
  });
});

describe('RecommendationDetailView — reveal step-up dispatch', () => {
  it('dispatches stepUpEmitter when the reveal endpoint returns 401 step_up_required', async () => {
    mockFetch((url, init) => {
      if (url === `/api/recommendations/${REC_ID}` && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(REC_DRAFT);
      }
      if (url === `/api/recommendations/${REC_ID}/reveal` && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ error: 'step_up_required', action: 'recommendation.read' }, 401);
      }
      return undefined;
    });

    const events: string[] = [];
    const unsubscribe = stepUpEmitter.subscribe((action) => {
      events.push(action);
    });

    renderAt();
    await screen.findByText(/Recommendation #12/);
    const revealButton = screen.getByRole('button', { name: /^Reveal$/ });
    fireEvent.click(revealButton);

    await waitFor(() => {
      expect(events).toContain('recommendation.read');
    });
    // The needs-step-up surface renders the re-tap CTA copy.
    await waitFor(() =>
      expect(screen.getByText(/Step-up authentication required/i)).toBeInTheDocument(),
    );
    unsubscribe();
  });
});

describe('RecommendationDetailView — resolve dialog wiring', () => {
  it('opens the resolve dialog and POSTs /resolve on confirm', async () => {
    const requests = mockFetch((url, init) => {
      if (url === `/api/recommendations/${REC_ID}` && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(REC_RESPONSE_RECEIVED);
      }
      if (url === `/api/recommendations/${REC_ID}/resolve` && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse({
          id: REC_ID,
          status: 'resolved',
          resolvedAt: '2026-06-10T10:00:00Z',
          linkedActionItemId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        });
      }
      return undefined;
    });
    renderAt();
    await screen.findByText(/Recommendation #12/);
    // Click the Resolve lifecycle button.
    await userEvent.click(screen.getByRole('button', { name: /^Resolve$/ }));
    // The dialog opens with the consequence copy.
    await screen.findByText(/moves the linked Action Item/i);
    // Confirm.
    const confirmButton = screen.getAllByRole('button', { name: /^Resolve$/ }).pop();
    expect(confirmButton).toBeDefined();
    await userEvent.click(confirmButton!);
    await waitFor(() => {
      const post = requests.find(
        (r) => r.method === 'POST' && r.url === `/api/recommendations/${REC_ID}/resolve`,
      );
      expect(post).toBeDefined();
    });
  });
});
