// Typed client for /api/action-items/*.

import type {
  ActionItemRisk,
  ActionItemSection,
  ActionItemSourceType,
  ActionItemStatus,
  ActionItemType,
  ActionItemUpdateField,
} from '@jhsc/shared-types';
import type { ActionFlag } from '@jhsc/shared-types/action-item-flag';

const BASE = '/api/action-items';

export class ActionItemsApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`action-items api ${status}`);
    this.name = 'ActionItemsApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'jhsc-web' };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    throw new ActionItemsApiError(res.status, parsed);
  }
  return (await res.json()) as T;
}

export interface ActionItemListItem {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly type: ActionItemType;
  readonly typeSubtype: string | null;
  readonly summary: string;
  readonly status: ActionItemStatus;
  readonly risk: ActionItemRisk;
  readonly section: ActionItemSection;
  readonly startDate: string;
  readonly targetDate: string | null;
  readonly closedDate: string | null;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly meetingId: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly flag: ActionFlag | null;
}

export interface ActionItemHistoryEntry {
  readonly id: string;
  readonly fromSection: ActionItemSection | null;
  readonly toSection: ActionItemSection;
  readonly movedByUserId: string;
  readonly movedAt: string;
  readonly reason: string | null;
  readonly meetingId: string | null;
  readonly auditIdx: number;
  readonly undone: boolean;
}

export interface ActionItemDetail extends Omit<ActionItemListItem, 'summary' | 'flag'> {
  readonly description: string;
  readonly recommendedAction: string | null;
  readonly raisedBy: string | null;
  readonly raisedByUserId: string | null;
  readonly followUpOwner: string | null;
  readonly followUpOwnerUserId: string | null;
  readonly department: string | null;
  readonly verifiedByJhscId: string | null;
  readonly flag: ActionFlag | null;
  readonly allowedTransitions: ReadonlyArray<ActionItemSection>;
  readonly history: ReadonlyArray<ActionItemHistoryEntry>;
}

export interface ActionItemCreateBody {
  readonly type: ActionItemType;
  readonly typeSubtype?: string;
  readonly description: string;
  readonly recommendedAction?: string;
  readonly raisedBy?: string;
  readonly raisedByUserId?: string;
  readonly followUpOwner?: string;
  readonly followUpOwnerUserId?: string;
  readonly department?: string;
  readonly status: ActionItemStatus;
  readonly risk: ActionItemRisk;
  readonly section: ActionItemSection;
  readonly startDate: string;
  readonly targetDate?: string;
  readonly sourceType?: ActionItemSourceType;
  readonly sourceId?: string;
  readonly tags?: ReadonlyArray<string>;
}

export interface ActionItemCreateResponse {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly status: ActionItemStatus;
  readonly section: ActionItemSection;
  readonly startDate: string;
}

export interface ActionItemPatchBody {
  readonly description?: string;
  readonly recommendedAction?: string | null;
  readonly status?: ActionItemStatus;
  readonly risk?: ActionItemRisk;
  readonly targetDate?: string | null;
  readonly closedDate?: string | null;
  readonly tags?: ReadonlyArray<string>;
  readonly department?: string | null;
  readonly typeSubtype?: string | null;
  readonly followUpOwner?: string | null;
  readonly followUpOwnerUserId?: string | null;
}

export interface ActionItemListFilters {
  readonly section?: ReadonlyArray<ActionItemSection>;
  readonly status?: ReadonlyArray<ActionItemStatus>;
  readonly risk?: ReadonlyArray<ActionItemRisk>;
  readonly type?: ReadonlyArray<ActionItemType>;
  readonly q?: string;
  readonly meetingId?: string;
}

export const actionItemsApi = {
  list: (
    filters: ActionItemListFilters = {},
  ): Promise<{ items: ReadonlyArray<ActionItemListItem> }> => {
    const params = new URLSearchParams();
    for (const s of filters.section ?? []) params.append('section', s);
    for (const s of filters.status ?? []) params.append('status', s);
    for (const s of filters.risk ?? []) params.append('risk', s);
    for (const s of filters.type ?? []) params.append('type', s);
    if (filters.q) params.set('q', filters.q);
    if (filters.meetingId) params.set('meetingId', filters.meetingId);
    const query = params.toString();
    return call(`${query ? `?${query}` : ''}`);
  },
  get: (id: string): Promise<ActionItemDetail> => call(`/${encodeURIComponent(id)}`),
  create: (body: ActionItemCreateBody): Promise<ActionItemCreateResponse> =>
    call('', { method: 'POST', json: body }),
  patch: (
    id: string,
    body: ActionItemPatchBody,
  ): Promise<{ id: string; changedFields: ReadonlyArray<ActionItemUpdateField> }> =>
    call(`/${encodeURIComponent(id)}`, { method: 'PATCH', json: body }),
  move: (
    id: string,
    body: { toSection: ActionItemSection; reason?: string; meetingId?: string },
  ): Promise<{
    id: string;
    section: ActionItemSection;
    allowedTransitions: ReadonlyArray<ActionItemSection>;
  }> => call(`/${encodeURIComponent(id)}/moves`, { method: 'POST', json: body }),
  undoMove: (
    id: string,
    moveId: string,
  ): Promise<{ id: string; section: ActionItemSection; revertMoveId: string }> =>
    call(`/${encodeURIComponent(id)}/moves/${encodeURIComponent(moveId)}/undo`, {
      method: 'POST',
    }),
};
