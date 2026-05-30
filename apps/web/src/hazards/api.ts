// Typed client for /api/hazards/*.
//
// Always rides credentials so the auth cookie travels, and sets
// X-Requested-With on mutating calls (CSRF defence-in-depth). On a 401
// the caller surfaces the result to the AuthRouter; on 422 illegal
// transition the caller surfaces the allowed-set to the UI so the
// transition buttons can re-render.

import type { HazardJurisdiction, HazardSeverity, HazardStatus } from '@jhsc/shared-types';

const BASE = '/api/hazards';

export class HazardsApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`hazards api ${status}`);
    this.name = 'HazardsApiError';
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
    throw new HazardsApiError(res.status, parsed);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface HazardListItem {
  readonly id: string;
  readonly hazardCode: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: HazardSeverity;
  readonly status: HazardStatus;
  readonly locationZone: string | null;
  readonly jurisdiction: HazardJurisdiction;
  readonly reportedAt: string;
}

export interface HazardStatusHistoryEntry {
  readonly id: string;
  readonly fromStatus: HazardStatus | null;
  readonly toStatus: HazardStatus;
  readonly occurredAt: string;
  readonly reason: string | null;
  readonly auditIdx: number;
}

export interface HazardDetail {
  readonly id: string;
  readonly hazardCode: string;
  readonly title: string;
  readonly description: string;
  readonly severity: HazardSeverity;
  readonly status: HazardStatus;
  readonly locationZone: string | null;
  readonly locationDetail: string | null;
  readonly jurisdiction: HazardJurisdiction;
  readonly reportedAt: string;
  readonly allowedTransitions: ReadonlyArray<HazardStatus>;
  readonly history: ReadonlyArray<HazardStatusHistoryEntry>;
}

export interface HazardCreateBody {
  readonly title: string;
  readonly description: string;
  readonly severity: HazardSeverity;
  readonly jurisdiction: HazardJurisdiction;
  readonly locationZone?: string;
  readonly locationDetail?: string;
  readonly reporterIdentity?: string;
}

export interface HazardCreateResponse {
  readonly id: string;
  readonly hazardCode: string;
  readonly status: HazardStatus;
  readonly reportedAt: string;
}

export interface HazardListFilters {
  readonly status?: ReadonlyArray<HazardStatus>;
  readonly severity?: ReadonlyArray<HazardSeverity>;
  readonly q?: string;
}

export const hazardsApi = {
  list: (filters: HazardListFilters = {}): Promise<{ items: ReadonlyArray<HazardListItem> }> => {
    const params = new URLSearchParams();
    for (const s of filters.status ?? []) params.append('status', s);
    for (const s of filters.severity ?? []) params.append('severity', s);
    if (filters.q) params.set('q', filters.q);
    const query = params.toString();
    return call(`${query ? `?${query}` : ''}`);
  },
  get: (id: string): Promise<HazardDetail> => call(`/${encodeURIComponent(id)}`),
  create: (body: HazardCreateBody): Promise<HazardCreateResponse> =>
    call('', { method: 'POST', json: body }),
  patchStatus: (
    id: string,
    body: { toStatus: HazardStatus; reason?: string },
  ): Promise<{
    id: string;
    status: HazardStatus;
    allowedTransitions: ReadonlyArray<HazardStatus>;
  }> => call(`/${encodeURIComponent(id)}/status`, { method: 'PATCH', json: body }),
};
