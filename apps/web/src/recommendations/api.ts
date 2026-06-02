// Typed client for /api/recommendations/* — Milestone 1.9 S3.
//
// Mirrors the inspections API client (see apps/web/src/inspections/api.ts):
//   - Always rides credentials so the auth cookie travels.
//   - Every call carries X-Requested-With: jhsc-web for the
//     supplementary CSRF guard.
//   - 401 responses with `error: 'step_up_required'` dispatch the
//     stepUpEmitter so the global modal opens; reveal() returns a
//     sentinel { stepUpRequired: true } so the detail view can render
//     a Reveal CTA after the modal closes — mirror of the 1.8
//     inspectionsApi.getFinding flow.
//
// DTO shapes mirror the S2 route handlers exactly. The S2 GET /:id
// projection returns presence flags (hasTitle / hasBody / hasAuthorRole /
// hasBody-per-response); the list projection adds the computed deadline +
// citation_count + hasResponse. The reveal endpoint is the only path that
// returns decrypted text.

import type { RecommendationJurisdiction, RecommendationStatus } from '@jhsc/shared-types';
import { stepUpEmitter } from '@/auth/api';

const BASE = '/api/recommendations';

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

export class RecommendationApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`recommendations api ${status}`);
    this.name = 'RecommendationApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Sentinel returned by `reveal()` when the API responds 401
 * step_up_required. The caller renders the Reveal affordance and waits
 * for the global step-up modal to close before retrying.
 */
export interface StepUpRequiredSentinel {
  readonly stepUpRequired: true;
  readonly action: string;
}

export function isStepUpRequired<T>(v: T | StepUpRequiredSentinel): v is StepUpRequiredSentinel {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { stepUpRequired?: unknown }).stepUpRequired === true
  );
}

// ---------------------------------------------------------------------------
// fetch wrapper
// ---------------------------------------------------------------------------

interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly json?: unknown;
  /**
   * When true, a 401 with `error: 'step_up_required'` resolves to a
   * `StepUpRequiredSentinel` instead of throwing. Used by reveal() so
   * the detail view can render a re-tap CTA after the step-up modal
   * closes.
   */
  readonly stepUpAsSentinel?: boolean;
}

async function call<T>(path: string, opts: CallOptions = {}): Promise<T | StepUpRequiredSentinel> {
  const headers: Record<string, string> = { 'X-Requested-With': 'jhsc-web' };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body,
  });
  if (res.status === 401) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    const errBody = parsed as { error?: string; action?: string } | undefined;
    if (errBody?.error === 'step_up_required') {
      const action = errBody.action ?? 'recommendation.read';
      stepUpEmitter.dispatch(action);
      if (opts.stepUpAsSentinel) {
        return { stepUpRequired: true, action } satisfies StepUpRequiredSentinel;
      }
    }
    throw new RecommendationApiError(res.status, parsed);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    throw new RecommendationApiError(res.status, parsed);
  }
  return (await res.json()) as T;
}

/** Variant that never returns the sentinel — for the throwing call sites. */
async function callOrThrow<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const r = await call<T>(path, opts);
  if (isStepUpRequired(r)) {
    // Shouldn't happen — callers that hit this path don't set
    // stepUpAsSentinel — but defend in depth so the type narrows.
    throw new RecommendationApiError(401, {
      error: 'step_up_required',
      action: r.action,
    });
  }
  return r;
}

// ---------------------------------------------------------------------------
// DTOs — mirror the S2 route handler shapes exactly
// ---------------------------------------------------------------------------

export interface RecommendationCitation {
  readonly statuteCode: string;
  readonly clauseId: string;
  readonly versionDate: string;
  readonly position: number;
}

export interface RecommendationListItem {
  readonly id: string;
  readonly recommendationNumber: number;
  readonly jurisdiction: RecommendationJurisdiction;
  readonly status: RecommendationStatus;
  readonly draftedAt: string;
  readonly submittedAt: string | null;
  readonly deadline: string | null;
  readonly citationCount: number;
  readonly hasResponse: boolean;
}

export interface RecommendationResponseSummary {
  readonly id: string;
  readonly position: number;
  readonly receivedAt: string;
  readonly receivedByUserId: string;
  readonly hasAuthorRole: boolean;
  readonly hasBody: boolean;
}

export interface RecommendationDetail {
  readonly id: string;
  readonly recommendationNumber: number;
  readonly jurisdiction: RecommendationJurisdiction;
  readonly status: RecommendationStatus;
  readonly draftedByUserId: string;
  readonly draftedAt: string;
  readonly submittedAt: string | null;
  readonly resolvedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly withdrawnReason: string | null;
  readonly deadline: string | null;
  readonly hasTitle: boolean;
  readonly hasBody: boolean;
  readonly citations: ReadonlyArray<RecommendationCitation>;
  readonly responses: ReadonlyArray<RecommendationResponseSummary>;
  readonly linkedActionItemId: string | null;
}

export interface RecommendationResponseRevealed {
  readonly id: string;
  readonly position: number;
  readonly receivedAt: string;
  readonly receivedByUserId: string;
  readonly authorRole: string;
  readonly body: string;
}

export interface RecommendationReveal {
  readonly id: string;
  readonly recommendationNumber: number;
  readonly jurisdiction: RecommendationJurisdiction;
  readonly status: RecommendationStatus;
  readonly title: string;
  readonly body: string;
  readonly responses: ReadonlyArray<RecommendationResponseRevealed>;
}

export interface RecommendationListFilters {
  readonly status?: RecommendationStatus;
  readonly jurisdiction?: RecommendationJurisdiction;
  readonly from?: string;
  readonly to?: string;
}

export interface CreateRecommendationBody {
  readonly title: string;
  readonly body: string;
  readonly jurisdiction: RecommendationJurisdiction;
  readonly citations?: ReadonlyArray<RecommendationCitation>;
}

export interface CreateRecommendationResponse {
  readonly id: string;
  readonly recommendationNumber: number;
  readonly jurisdiction: RecommendationJurisdiction;
  readonly status: RecommendationStatus;
  readonly draftedAt: string;
}

export interface PatchRecommendationBody {
  readonly title?: string;
  readonly body?: string;
  readonly citations?: ReadonlyArray<RecommendationCitation>;
}

export interface SubmitRecommendationResponse {
  readonly id: string;
  readonly status: 'submitted';
  readonly submittedAt: string;
  readonly deadline: string | null;
  readonly linkedActionItemId: string;
}

export interface AddResponseBody {
  readonly authorRole: string;
  readonly body: string;
}

export interface AddResponseResult {
  readonly id: string;
  readonly position: number;
  readonly receivedAt: string;
}

export interface ResolveRecommendationResponse {
  readonly id: string;
  readonly status: 'resolved';
  readonly resolvedAt: string;
  readonly linkedActionItemId: string;
}

/**
 * Withdrawal reason enum — mirrors the S2 route's PI-clean enum exactly
 * (ADR-0008 §3.1 / T-R35).
 */
export const withdrawReason = ['rescinded', 'superseded', 'addressed_pre_submission'] as const;
export type WithdrawReason = (typeof withdrawReason)[number];

export interface WithdrawRecommendationBody {
  readonly reason: WithdrawReason;
}

export interface WithdrawRecommendationResponse {
  readonly id: string;
  readonly status: 'withdrawn';
  readonly withdrawnAt: string;
  readonly withdrawnReason: WithdrawReason;
  readonly linkedActionItemId: string | null;
}

// ---------------------------------------------------------------------------
// S4 DTOs — signed bundle export
// ---------------------------------------------------------------------------

export interface CreateRecommendationExportResponse {
  readonly exportId: string;
  readonly recommendationId: string;
  readonly outputSha256: string;
  readonly signatureSha256: string;
  readonly signingKeyId: string;
  readonly citationsHash: string;
  readonly byteSize: number;
  readonly expiresAt: string;
  readonly chainIdx: number;
}

export interface RecommendationExportSummary {
  readonly id: string;
  readonly recommendationId: string;
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  readonly outputSha256: string;
  readonly signatureSha256: string;
  readonly signingKeyId: string;
  readonly byteSize: number;
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

export const recommendationsApi = {
  list: (
    filters: RecommendationListFilters = {},
  ): Promise<{ items: ReadonlyArray<RecommendationListItem> }> => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.jurisdiction) params.set('jurisdiction', filters.jurisdiction);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const query = params.toString();
    return callOrThrow(`${BASE}${query ? `?${query}` : ''}`);
  },

  get: (id: string): Promise<RecommendationDetail> =>
    callOrThrow(`${BASE}/${encodeURIComponent(id)}`),

  create: (body: CreateRecommendationBody): Promise<CreateRecommendationResponse> =>
    callOrThrow(BASE, { method: 'POST', json: body }),

  /**
   * Decrypted reveal — step-up gated by the API (60s freshness window).
   * On 401 step_up_required:
   *   1) Dispatches stepUpEmitter('recommendation.read') so the global
   *      modal opens.
   *   2) Returns a StepUpRequiredSentinel so the caller can render a
   *      "Reveal" CTA instead of crashing — mirror of the 1.8
   *      inspectionsApi.getFinding flow.
   */
  reveal: (id: string): Promise<RecommendationReveal | StepUpRequiredSentinel> =>
    call<RecommendationReveal>(`${BASE}/${encodeURIComponent(id)}/reveal`, {
      stepUpAsSentinel: true,
    }),

  patch: (id: string, body: PatchRecommendationBody): Promise<{ id: string }> =>
    callOrThrow(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: body,
    }),

  submit: (id: string): Promise<SubmitRecommendationResponse> =>
    callOrThrow(`${BASE}/${encodeURIComponent(id)}/submit`, {
      method: 'POST',
      json: {},
    }),

  addResponse: (id: string, body: AddResponseBody): Promise<AddResponseResult> =>
    callOrThrow(`${BASE}/${encodeURIComponent(id)}/responses`, {
      method: 'POST',
      json: body,
    }),

  resolve: (id: string): Promise<ResolveRecommendationResponse> =>
    callOrThrow(`${BASE}/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      json: {},
    }),

  withdraw: (
    id: string,
    body: WithdrawRecommendationBody,
  ): Promise<WithdrawRecommendationResponse> =>
    callOrThrow(`${BASE}/${encodeURIComponent(id)}/withdraw`, {
      method: 'POST',
      json: body,
    }),

  // Exports (S4) ---------------------------------------------------------
  //
  // create: POST /api/recommendations/:id/exports → render + sign + store
  //   + chain anchor. Step-up required (60s freshness; action binds to
  //   the recommendation id per T-R29). On 401 the API wrapper dispatches
  //   stepUpEmitter('recommendation.export.<id>') so the global modal
  //   opens; the caller retries after the modal closes.
  //
  // download: GET /api/recommendations/exports/:id/download → returns a
  //   Blob of the signed ZIP. The server sets Content-Disposition:
  //   attachment + Content-Type: application/zip; the caller opens the
  //   blob in a new tab with the 5s revoke + noopener,noreferrer
  //   pattern (mirror of 1.7 evidence reveal sec-F10 + 1.8 inspections
  //   download).
  //
  // list: GET /api/recommendations/exports → recent recommendation
  //   exports (metadata only).
  exports: {
    create: (recommendationId: string): Promise<CreateRecommendationExportResponse> =>
      callOrThrow(`${BASE}/${encodeURIComponent(recommendationId)}/exports`, {
        method: 'POST',
        json: {},
      }),
    /** Returns the raw ZIP Blob; caller is responsible for the open/revoke dance. */
    download: async (id: string): Promise<Blob> => {
      const res = await fetch(`${BASE}/exports/${encodeURIComponent(id)}/download`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'jhsc-web' },
      });
      if (res.status === 401) {
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // leave as text
        }
        const errBody = parsed as { error?: string; action?: string } | undefined;
        if (errBody?.error === 'step_up_required') {
          const action = errBody.action ?? 'recommendation.export.download';
          stepUpEmitter.dispatch(action);
        }
        throw new RecommendationApiError(401, parsed);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // leave as text
        }
        throw new RecommendationApiError(res.status, parsed);
      }
      return res.blob();
    },
    list: (): Promise<{ items: ReadonlyArray<RecommendationExportSummary> }> =>
      callOrThrow(`${BASE}/exports`),
  },
};
