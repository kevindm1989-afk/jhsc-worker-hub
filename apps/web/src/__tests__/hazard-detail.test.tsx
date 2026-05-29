import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HazardDetailView } from '../views/hazard-detail-view';

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

const HAZARD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const baseHazard = {
  id: HAZARD_ID,
  hazardCode: 'H-001',
  title: 'Slip hazard — cooler floor',
  description: 'Floor near the cooler door is wet from condensation.',
  severity: 'high',
  status: 'open',
  locationZone: 'zone_3',
  locationDetail: null,
  jurisdiction: 'ON',
  reportedAt: '2026-05-29T10:00:00Z',
  allowedTransitions: ['assessing', 'withdrawn'],
  history: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      fromStatus: null,
      toStatus: 'open',
      occurredAt: '2026-05-29T10:00:00Z',
      reason: null,
      auditIdx: 2,
    },
  ],
};

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={[`/hazards/${HAZARD_ID}`]}>
      <Routes>
        <Route path="/hazards/:id" element={<HazardDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HazardDetailView', () => {
  it('renders the decrypted description, status badge, and allowed transitions', async () => {
    mockFetch((url) => {
      if (url === `/api/hazards/${HAZARD_ID}`) return jsonResponse(baseHazard);
      return undefined;
    });
    renderAt();
    await screen.findByText(baseHazard.description);
    expect(screen.getByText('H-001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to Assessing/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to Withdrawn/i })).toBeInTheDocument();
  });

  it('shows the 404 fallback when the API returns not_found', async () => {
    mockFetch((url) => {
      if (url === `/api/hazards/${HAZARD_ID}`) return jsonResponse({ error: 'not_found' }, 404);
      return undefined;
    });
    renderAt();
    await screen.findByText(/does not exist or was withdrawn/);
  });

  it('PATCHes the new status after the user picks a transition and confirms', async () => {
    let getCalls = 0;
    const requests = mockFetch((url, init) => {
      if (url === `/api/hazards/${HAZARD_ID}` && (init?.method ?? 'GET') === 'GET') {
        getCalls += 1;
        if (getCalls === 1) return jsonResponse(baseHazard);
        return jsonResponse({
          ...baseHazard,
          status: 'assessing',
          allowedTransitions: ['open', 'assigned', 'withdrawn'],
          history: [
            ...baseHazard.history,
            {
              id: '22222222-2222-2222-2222-222222222222',
              fromStatus: 'open',
              toStatus: 'assessing',
              occurredAt: '2026-05-29T11:00:00Z',
              reason: null,
              auditIdx: 3,
            },
          ],
        });
      }
      if (url === `/api/hazards/${HAZARD_ID}/status` && init?.method === 'PATCH') {
        return jsonResponse({
          id: HAZARD_ID,
          status: 'assessing',
          allowedTransitions: ['open', 'assigned', 'withdrawn'],
        });
      }
      return undefined;
    });
    renderAt();
    await screen.findByText(baseHazard.description);
    await userEvent.click(screen.getByRole('button', { name: /Move to Assessing/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm Assessing/i }));
    await waitFor(() => {
      const patch = requests.find((r) => r.method === 'PATCH');
      expect(patch).toBeDefined();
      expect(patch!.body).toEqual({ toStatus: 'assessing' });
    });
  });

  it('dispatches a step-up event when the PATCH returns 401 step_up_required', async () => {
    const { stepUpEmitter } = await import('../auth/api');
    const seen: string[] = [];
    const unsubscribe = stepUpEmitter.subscribe((a) => seen.push(a));
    try {
      mockFetch((url, init) => {
        if (url === `/api/hazards/${HAZARD_ID}` && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse(baseHazard);
        }
        if (url === `/api/hazards/${HAZARD_ID}/status` && init?.method === 'PATCH') {
          return jsonResponse(
            { error: 'step_up_required', action: 'hazard.status_change.withdrawn' },
            401,
          );
        }
        return undefined;
      });
      renderAt();
      await screen.findByText(baseHazard.description);
      await userEvent.click(screen.getByRole('button', { name: /Move to Withdrawn/i }));
      // Provide the required reason so the Confirm button enables.
      await userEvent.type(screen.getByLabelText(/Reason/), 'duplicate of H-002');
      await userEvent.click(screen.getByRole('button', { name: /Confirm Withdrawn/i }));
      await waitFor(() => expect(seen).toContain('hazard.status_change.withdrawn'));
    } finally {
      unsubscribe();
    }
  });
});
