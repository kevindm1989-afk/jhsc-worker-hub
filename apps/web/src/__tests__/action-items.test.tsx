import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ActionItemsView } from '../views/action-items-view';
import { ActionItemNewView } from '../views/action-item-new-view';
import { ActionItemDetailView } from '../views/action-item-detail-view';

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

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const listItem = {
  id: ITEM_ID,
  sequenceNumber: 1,
  type: 'INSIGHT',
  typeSubtype: null,
  summary: 'PA system inaudible in cooler over forklift noise.',
  status: 'In Progress',
  risk: 'Medium',
  section: 'new_business',
  startDate: '2026-05-29',
  targetDate: null,
  closedDate: null,
  sourceType: 'manual',
  sourceId: null,
  meetingId: null,
  tags: [],
  flag: { kind: 'aging_under_21', label: '🟠 <21 days', severity: 'pending' },
};

const detail = {
  ...listItem,
  description: 'Full decrypted description body for the detail view.',
  recommendedAction: 'Install signage at cooler entry.',
  raisedBy: null,
  raisedByUserId: null,
  followUpOwner: null,
  followUpOwnerUserId: null,
  department: null,
  verifiedByJhscId: null,
  allowedTransitions: ['old_business', 'recommendation', 'completed_this_period', 'archived'],
  history: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      fromSection: null,
      toSection: 'new_business',
      movedByUserId: 'user-1',
      movedAt: '2026-05-29T10:00:00Z',
      reason: null,
      meetingId: null,
      auditIdx: 5,
      undone: false,
    },
  ],
};

describe('ActionItemsView', () => {
  it('renders the empty-state CTA when the list is empty', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/action-items')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/action-items']}>
        <ActionItemsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No action items yet/);
    const cta = await screen.findByRole('link', { name: /Raise an action item/i });
    expect(cta).toHaveAttribute('href', '/action-items/new');
  });

  it('renders one card per item with sequence number, status, section, and the Action Flag', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/action-items')) return jsonResponse({ items: [listItem] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/action-items']}>
        <ActionItemsView />
      </MemoryRouter>,
    );
    await screen.findByText(listItem.summary);
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText(/<21 days/)).toBeInTheDocument();
  });

  it('toggles a section filter chip into the URL and re-fetches', async () => {
    const requests = mockFetch((url) => {
      if (url.startsWith('/api/action-items')) return jsonResponse({ items: [] });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/action-items']}>
        <ActionItemsView />
      </MemoryRouter>,
    );
    await screen.findByText(/No action items yet/);
    await userEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() => {
      const sectionReq = requests.find((r) => r.url.includes('section=new_business'));
      expect(sectionReq).toBeDefined();
    });
  });
});

describe('ActionItemNewView', () => {
  it('rejects submit on empty description', async () => {
    render(
      <MemoryRouter initialEntries={['/action-items/new']}>
        <ActionItemNewView />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Raise action item/ }));
    expect(screen.getAllByText('Required').length).toBeGreaterThanOrEqual(1);
  });

  it('POSTs the form and navigates to the new detail route on success', async () => {
    const requests = mockFetch((url, init) => {
      if (url === '/api/action-items' && init?.method === 'POST') {
        return jsonResponse({
          id: ITEM_ID,
          sequenceNumber: 1,
          status: 'Not Started',
          section: 'new_business',
          startDate: '2026-05-29',
        });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/action-items/new']}>
        <Routes>
          <Route path="/action-items/new" element={<ActionItemNewView />} />
          <Route path="/action-items/:id" element={<div>detail page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText(/Description/i), 'PA system inaudible at cooler.');
    await userEvent.click(screen.getByRole('button', { name: /Raise action item/ }));
    await screen.findByText('detail page');
    const post = requests.find((r) => r.method === 'POST');
    expect(post?.body).toMatchObject({
      type: 'INSIGHT',
      description: 'PA system inaudible at cooler.',
      status: 'Not Started',
      risk: 'Medium',
      section: 'new_business',
    });
  });
});

describe('ActionItemDetailView', () => {
  it('renders the decrypted description + move buttons + history', async () => {
    mockFetch((url) => {
      if (url === `/api/action-items/${ITEM_ID}`) return jsonResponse(detail);
      if (url === `/api/action-items/${ITEM_ID}/meeting-history`) {
        return jsonResponse({
          actionItemId: ITEM_ID,
          firstRaisedMeetingId: null,
          items: [],
          asOf: '2026-06-03T10:00:00Z',
        });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={[`/action-items/${ITEM_ID}`]}>
        <Routes>
          <Route path="/action-items/:id" element={<ActionItemDetailView />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(detail.description);
    expect(screen.getByText(/Install signage/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to old business/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to archived/i })).toBeInTheDocument();
    expect(screen.getByText('#5')).toBeInTheDocument(); // history audit_idx
  });

  it('POSTs the move after the user confirms', async () => {
    let getCalls = 0;
    const requests = mockFetch((url, init) => {
      if (url === `/api/action-items/${ITEM_ID}` && (init?.method ?? 'GET') === 'GET') {
        getCalls += 1;
        return jsonResponse(detail);
      }
      if (url === `/api/action-items/${ITEM_ID}/moves` && init?.method === 'POST') {
        return jsonResponse({
          id: ITEM_ID,
          section: 'old_business',
          allowedTransitions: ['completed_this_period', 'archived', 'recommendation'],
        });
      }
      if (url === `/api/action-items/${ITEM_ID}/meeting-history`) {
        return jsonResponse({
          actionItemId: ITEM_ID,
          firstRaisedMeetingId: null,
          items: [],
          asOf: '2026-06-03T10:00:00Z',
        });
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={[`/action-items/${ITEM_ID}`]}>
        <Routes>
          <Route path="/action-items/:id" element={<ActionItemDetailView />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(detail.description);
    await userEvent.click(screen.getByRole('button', { name: /Move to old business/i }));
    await userEvent.click(screen.getByRole('button', { name: /Confirm move to old business/i }));
    await waitFor(() => {
      const post = requests.find((r) => r.method === 'POST' && r.url.endsWith('/moves'));
      expect(post).toBeDefined();
      expect(post!.body).toEqual({ toSection: 'old_business' });
    });
    expect(getCalls).toBeGreaterThanOrEqual(2); // initial + re-fetch after move
  });

  it('dispatches step-up on 401 for an archive move', async () => {
    const { stepUpEmitter } = await import('../auth/api');
    const seen: string[] = [];
    const unsub = stepUpEmitter.subscribe((a) => seen.push(a));
    try {
      mockFetch((url, init) => {
        if (url === `/api/action-items/${ITEM_ID}` && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse(detail);
        }
        if (url === `/api/action-items/${ITEM_ID}/moves` && init?.method === 'POST') {
          return jsonResponse(
            { error: 'step_up_required', action: 'action_item.move.archived' },
            401,
          );
        }
        if (url === `/api/action-items/${ITEM_ID}/meeting-history`) {
          return jsonResponse({
            actionItemId: ITEM_ID,
            firstRaisedMeetingId: null,
            items: [],
            asOf: '2026-06-03T10:00:00Z',
          });
        }
        return undefined;
      });
      render(
        <MemoryRouter initialEntries={[`/action-items/${ITEM_ID}`]}>
          <Routes>
            <Route path="/action-items/:id" element={<ActionItemDetailView />} />
          </Routes>
        </MemoryRouter>,
      );
      await screen.findByText(detail.description);
      await userEvent.click(screen.getByRole('button', { name: /Move to archived/i }));
      await userEvent.click(screen.getByRole('button', { name: /Confirm move to archived/i }));
      await waitFor(() => expect(seen).toContain('action_item.move.archived'));
    } finally {
      unsub();
    }
  });
});
