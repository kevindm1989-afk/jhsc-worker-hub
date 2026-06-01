// Typed client for /api/inspections/* and /api/inspection-templates/*.
//
// Mirrors the evidence + hazards + action-items API clients:
//   - Always rides credentials so the auth cookie travels.
//   - Mutating calls (and every call here) carry X-Requested-With:
//     jhsc-web for the supplementary CSRF guard the API enforces
//     (matches the 1.7 sec-F2 close-out posture).
//   - 401 responses with `error: 'step_up_required'` dispatch the
//     stepUpEmitter so the global modal opens; the wrapper returns a
//     sentinel { stepUpRequired: true } for the read paths that need
//     to render a "Reveal" affordance (mirror of the EvidenceList
//     onReveal flow).
//
// All DTOs are read-only — clients should never mutate the structures
// they receive. The shared-types enums are the source of truth for the
// status / state / role / vocab discriminators.
//
// NO LOCAL FALLBACKS for the API response shape: a server that returns
// an unexpected body crashes the typed cast at the call site so the
// test harness catches it. Treat the API contract as authoritative.

import type {
  ActionItemRisk,
  InspectionConductState,
  InspectionSignatureRole,
  InspectionStatusVocabKind,
  InspectionTemplateCode,
} from '@jhsc/shared-types';
import { stepUpEmitter } from '@/auth/api';

const INSPECTIONS_BASE = '/api/inspections';
const TEMPLATES_BASE = '/api/inspection-templates';

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

export class InspectionApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`inspections api ${status}`);
    this.name = 'InspectionApiError';
    this.status = status;
    this.body = body;
  }
}

// Sentinel returned by `getFinding()` when the API responds 401
// step_up_required. The caller renders the Reveal affordance and waits
// for the global step-up modal to close before retrying. Mirror of the
// EvidenceList onReveal pattern.
export interface StepUpRequiredSentinel {
  readonly stepUpRequired: true;
  readonly action: string;
}

function isStepUpRequired<T>(v: T | StepUpRequiredSentinel): v is StepUpRequiredSentinel {
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
   * `StepUpRequiredSentinel` instead of throwing. Used by the reveal-on-
   * tap paths (getFinding) where the UI wants to render a re-tap CTA
   * after the global modal closes. Defaults to false — most mutating
   * routes prefer the throw path so they can surface a generic "saving
   * failed" toast.
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
      const action = errBody.action ?? 'inspection.finding.read';
      stepUpEmitter.dispatch(action);
      if (opts.stepUpAsSentinel) {
        return { stepUpRequired: true, action } satisfies StepUpRequiredSentinel;
      }
    }
    throw new InspectionApiError(res.status, parsed);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    throw new InspectionApiError(res.status, parsed);
  }
  return (await res.json()) as T;
}

/** Variant that never returns the sentinel — for the throwing call sites. */
async function callOrThrow<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const r = await call<T>(path, opts);
  if (isStepUpRequired(r)) {
    // Shouldn't happen — callers that hit this path don't set
    // stepUpAsSentinel — but defend in depth so the type narrows.
    throw new InspectionApiError(401, { error: 'step_up_required', action: r.action });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Template DTOs
// ---------------------------------------------------------------------------

export type InspectionCadence = 'monthly' | 'quarterly' | 'annual' | 'ad_hoc';

export interface TemplateSummary {
  readonly id: string;
  readonly templateCode: InspectionTemplateCode;
  readonly versionNumber: number;
  readonly displayName: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly requiresThreeSignatures: boolean;
  readonly cadence: InspectionCadence;
}

export interface TemplateItem {
  readonly key: string;
  readonly label: string;
  readonly helpText?: string;
}

export interface TemplateSection {
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<TemplateItem>;
}

export interface TemplateDetail extends TemplateSummary {
  readonly sections: ReadonlyArray<TemplateSection>;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

export interface CustomTemplateBody {
  readonly templateCode: 'custom';
  readonly displayName: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly cadence: InspectionCadence;
  readonly requiresThreeSignatures: boolean;
  readonly sections: ReadonlyArray<TemplateSection>;
}

export interface CustomTemplateCreateResponse {
  readonly id: string;
  readonly templateCode: 'custom';
  readonly versionNumber: number;
}

// ---------------------------------------------------------------------------
// Inspection DTOs
// ---------------------------------------------------------------------------

export interface InspectionSummary {
  readonly id: string;
  readonly templateCode: InspectionTemplateCode;
  readonly templateVersionId: string;
  readonly zoneId: string;
  readonly state: InspectionConductState;
  readonly scheduledFor: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly conductedByUserId: string;
  readonly createdAt: string;
}

export interface InspectionFindingSummary {
  readonly id: string;
  readonly sectionKey: string;
  readonly sectionLabel: string;
  readonly itemKey: string;
  readonly itemLabel: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly statusValue: string;
  readonly hasObservation: boolean;
  readonly hasCorrectiveAction: boolean;
  readonly hasResponsibleParty: boolean;
  readonly promotedActionItemId: string | null;
  readonly createdAt: string;
}

export interface InspectionSignatureSummary {
  readonly id: string;
  readonly role: InspectionSignatureRole;
  readonly signedByUserId: string;
  readonly signedAt: string;
  readonly hasNote: boolean;
}

export interface InspectionDetail {
  readonly id: string;
  readonly templateCode: InspectionTemplateCode;
  readonly templateVersionId: string;
  readonly templateDisplayName: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly cadence: InspectionCadence;
  readonly requiresThreeSignatures: boolean;
  readonly sections: ReadonlyArray<TemplateSection>;
  readonly zoneId: string;
  readonly state: InspectionConductState;
  readonly conductedByUserId: string;
  readonly scheduledFor: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly findings: ReadonlyArray<InspectionFindingSummary>;
  readonly signatures: ReadonlyArray<InspectionSignatureSummary>;
}

export interface FindingDetail {
  readonly id: string;
  readonly inspectionId: string;
  readonly sectionKey: string;
  readonly sectionLabel: string;
  readonly itemKey: string;
  readonly itemLabel: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly statusValue: string;
  readonly observation: string | null;
  readonly correctiveAction: string | null;
  readonly responsibleParty: string | null;
  readonly promotedActionItemId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InspectionListFilters {
  readonly state?: InspectionConductState;
  readonly zoneId?: string;
  readonly templateCode?: InspectionTemplateCode;
}

export interface CreateInspectionBody {
  readonly templateVersionId: string;
  readonly zoneId: string;
  readonly scheduledFor?: string;
}

export interface CreateInspectionResponse {
  readonly id: string;
  readonly templateCode: InspectionTemplateCode;
  readonly templateVersionId: string;
  readonly zoneId: string;
  readonly state: InspectionConductState;
  readonly scheduledFor: string | null;
}

export interface CreateFindingBody {
  readonly sectionKey: string;
  readonly itemKey: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly statusValue: string;
  readonly observation?: string;
  readonly correctiveAction?: string;
  readonly responsibleParty?: string;
}

export interface PatchFindingBody {
  readonly statusValue?: string;
  readonly observation?: string | null;
  readonly correctiveAction?: string | null;
  readonly responsibleParty?: string | null;
}

export interface PromoteFindingBody {
  readonly risk: ActionItemRisk;
}

export interface PromoteFindingResponse {
  readonly findingId: string;
  readonly actionItemId: string;
  readonly risk: ActionItemRisk;
}

export interface SignInspectionBody {
  readonly role: InspectionSignatureRole;
  readonly note?: string;
}

export interface SignInspectionResponse {
  readonly signatureId: string;
  readonly inspectionState: InspectionConductState;
}

export interface PatchInspectionBody {
  readonly state: InspectionConductState;
}

export interface PatchInspectionResponse {
  readonly id: string;
  readonly state: InspectionConductState;
}

// ---------------------------------------------------------------------------
// Export DTOs (Milestone 1.8 S4)
// ---------------------------------------------------------------------------

export type InspectionExportKindT = 'single' | 'batch';

export interface CreateExportBody {
  readonly kind: InspectionExportKindT;
  readonly inspectionIds: ReadonlyArray<string>;
}

export interface CreateExportResponse {
  readonly exportId: string;
  readonly kind: InspectionExportKindT;
  readonly outputSha256: string;
  readonly byteSize: number;
  readonly expiresAt: string;
  readonly chainIdx: number;
}

export interface ExportSummary {
  readonly id: string;
  readonly kind: InspectionExportKindT;
  readonly inspectionCount: number;
  readonly inspectionIds: ReadonlyArray<string>;
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  readonly outputSha256: string;
  readonly byteSize: number;
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

export const inspectionsApi = {
  // Templates ------------------------------------------------------------
  listTemplates: (): Promise<{ items: ReadonlyArray<TemplateSummary> }> =>
    callOrThrow(`${TEMPLATES_BASE}`),
  getTemplate: (id: string): Promise<TemplateDetail> =>
    callOrThrow(`${TEMPLATES_BASE}/${encodeURIComponent(id)}`),
  createCustomTemplate: (body: CustomTemplateBody): Promise<CustomTemplateCreateResponse> =>
    callOrThrow(`${TEMPLATES_BASE}`, { method: 'POST', json: body }),

  // Inspections ----------------------------------------------------------
  listInspections: (
    filters: InspectionListFilters = {},
  ): Promise<{ items: ReadonlyArray<InspectionSummary> }> => {
    const params = new URLSearchParams();
    if (filters.state) params.set('state', filters.state);
    if (filters.zoneId) params.set('zoneId', filters.zoneId);
    if (filters.templateCode) params.set('templateCode', filters.templateCode);
    const query = params.toString();
    return callOrThrow(`${INSPECTIONS_BASE}${query ? `?${query}` : ''}`);
  },
  createInspection: (body: CreateInspectionBody): Promise<CreateInspectionResponse> =>
    callOrThrow(`${INSPECTIONS_BASE}`, { method: 'POST', json: body }),
  getInspection: (id: string): Promise<InspectionDetail> =>
    callOrThrow(`${INSPECTIONS_BASE}/${encodeURIComponent(id)}`),
  patchInspection: (id: string, body: PatchInspectionBody): Promise<PatchInspectionResponse> =>
    callOrThrow(`${INSPECTIONS_BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: body,
    }),

  // Findings -------------------------------------------------------------
  /**
   * Decrypted finding read. Step-up gated by the API (60s freshness
   * window). On 401 step_up_required, the wrapper:
   *   1) Dispatches the stepUpEmitter so the global modal opens.
   *   2) Returns a `StepUpRequiredSentinel` so the caller can render
   *      a "Reveal" CTA instead of crashing — mirror of the
   *      EvidenceList onReveal pattern.
   * The caller is expected to retry after the modal closes.
   */
  getFinding: (id: string): Promise<FindingDetail | StepUpRequiredSentinel> =>
    call<FindingDetail>(`${INSPECTIONS_BASE}/findings/${encodeURIComponent(id)}`, {
      stepUpAsSentinel: true,
    }),
  createFinding: (
    inspectionId: string,
    body: CreateFindingBody,
  ): Promise<InspectionFindingSummary> =>
    callOrThrow(`${INSPECTIONS_BASE}/${encodeURIComponent(inspectionId)}/findings`, {
      method: 'POST',
      json: body,
    }),
  patchFinding: (id: string, body: PatchFindingBody): Promise<{ id: string }> =>
    callOrThrow(`${INSPECTIONS_BASE}/findings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: body,
    }),
  promoteFinding: (id: string, body: PromoteFindingBody): Promise<PromoteFindingResponse> =>
    callOrThrow(`${INSPECTIONS_BASE}/findings/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
      json: body,
    }),

  // Signatures -----------------------------------------------------------
  signInspection: (
    inspectionId: string,
    body: SignInspectionBody,
  ): Promise<SignInspectionResponse> =>
    callOrThrow(`${INSPECTIONS_BASE}/${encodeURIComponent(inspectionId)}/signatures`, {
      method: 'POST',
      json: body,
    }),

  // Exports (S4) ---------------------------------------------------------
  //
  // create: POST /api/inspections/exports → render + store + anchor.
  //   step-up required (60s freshness); on 401 dispatches the
  //   stepUpEmitter for the global modal.
  //
  // download: GET /api/inspections/exports/:id/download → returns a Blob
  //   of the PDF. The server already sets Content-Disposition: attachment
  //   + a strict CSP sandbox; we mirror the 1.7 evidence reveal flow
  //   (open the blob URL, revoke after 5s, sec-F10 close-out).
  //
  // list: GET /api/inspections/exports → metadata.
  exports: {
    create: (body: CreateExportBody): Promise<CreateExportResponse> =>
      callOrThrow(`${INSPECTIONS_BASE}/exports`, {
        method: 'POST',
        json: body,
      }),
    /** Returns the raw PDF Blob; caller is responsible for the open/revoke dance. */
    download: async (id: string): Promise<Blob> => {
      const res = await fetch(`${INSPECTIONS_BASE}/exports/${encodeURIComponent(id)}/download`, {
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
          const action = errBody.action ?? 'inspection.export.download';
          stepUpEmitter.dispatch(action);
        }
        throw new InspectionApiError(401, parsed);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // leave as text
        }
        throw new InspectionApiError(res.status, parsed);
      }
      return res.blob();
    },
    list: (): Promise<{ items: ReadonlyArray<ExportSummary> }> =>
      callOrThrow(`${INSPECTIONS_BASE}/exports`),
  },
};

// Re-export the sentinel narrowing helper so views can use it without
// re-importing the implementation surface.
export { isStepUpRequired };
