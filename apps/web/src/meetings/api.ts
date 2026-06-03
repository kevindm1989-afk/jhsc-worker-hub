// Typed client for /api/meetings/* — Milestone 2.1 S3.
//
// Mirrors apps/web/src/recommendations/api.ts:
//   - credentials: 'same-origin' so the auth cookie travels.
//   - X-Requested-With: jhsc-web carried on every call (CSRF guard).
//   - 401 step_up_required: dispatches the global step-up modal via
//     stepUpEmitter so the rep can re-step-up before retrying.
//
// DTO shapes mirror the S2 route handlers in apps/api/src/routes/meetings/
// EXACTLY. The S2 GET /:id projection returns full ciphertext for the
// sealed columns (display_name_ct, notes_envelope_ct, etc.) so the
// browser can render presence + provenance without holding the
// workplace private key — names are revealed only at PDF generation
// time (per ADR §3.9 + non-negotiable #1 / #4).
//
// `If-Match` + `Idempotency-Key` are added at the wire layer by the
// sync queue dispatcher (apps/web/src/sync/typed-client.ts liveFetch).
// This client is the direct-call surface for require-online flows
// (create / adjourn / finalize / signatures) that bypass the queue.

import type {
  MeetingAttendanceParty,
  MeetingAttendanceRole,
  MeetingPresentStatus,
  MeetingReviewOutcome,
  MeetingSectionType,
  MeetingSectionVisibility,
  MeetingSignedMethod,
  MeetingSignerRole,
  MeetingStatus,
} from '@jhsc/shared-types';
import { stepUpEmitter } from '@/auth/api';

const BASE = '/api/meetings';

export class MeetingApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`meetings api ${status}`);
    this.name = 'MeetingApiError';
    this.status = status;
    this.body = body;
  }
}

interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly json?: unknown;
  readonly ifMatch?: number;
  readonly idempotencyKey?: string;
}

async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'jhsc-web' };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  if (typeof opts.ifMatch === 'number') {
    headers['If-Match'] = `"${opts.ifMatch}"`;
  }
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body,
  });
  if (res.status === 401) {
    const parsed = await safeJson(res);
    const errBody = parsed as { error?: string; action?: string } | undefined;
    if (errBody?.error === 'step_up_required') {
      const action = errBody.action ?? 'meeting.action';
      stepUpEmitter.dispatch(action);
    }
    throw new MeetingApiError(res.status, parsed);
  }
  if (!res.ok) {
    const parsed = await safeJson(res);
    throw new MeetingApiError(res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DTOs (mirror S2 route shapes exactly)
// ---------------------------------------------------------------------------

export interface MeetingListItem {
  readonly id: string;
  readonly meetingDate: string;
  readonly location: string | null;
  readonly status: MeetingStatus;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly actualStartAt: string | null;
  readonly actualEndAt: string | null;
  readonly agendaTemplateVersion: number;
  readonly version: number;
  readonly createdAt: string;
}

export interface MeetingSection {
  readonly id: string;
  readonly sectionType: MeetingSectionType;
  readonly visibility: MeetingSectionVisibility;
  readonly orderIdx: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Base64 ciphertext — sealed under the workplace public key. */
  readonly notesEnvelopeCt: string | null;
  readonly notesEnvelopeDekCt: string | null;
  readonly version: number;
}

export interface MeetingAttendee {
  readonly id: string;
  readonly role: MeetingAttendanceRole;
  readonly party: MeetingAttendanceParty;
  readonly presentStatus: MeetingPresentStatus;
  /** Base64 ciphertext. */
  readonly displayNameCt: string;
  readonly displayNameDekCt: string;
  readonly attendeeUserId: string | null;
  readonly arrivedAt: string | null;
  readonly departedAt: string | null;
  readonly version: number;
}

export interface MeetingSignature {
  readonly id: string;
  readonly signerRole: MeetingSignerRole;
  readonly signedMethod: MeetingSignedMethod;
  readonly signedAt: string;
  readonly signerDisplayNameCt: string;
  readonly signerDisplayNameDekCt: string;
  readonly signerUserId: string | null;
  readonly evidenceStorageKey: string | null;
  readonly evidenceEnvelopeCt: string | null;
  readonly evidenceEnvelopeDekCt: string | null;
  readonly chainOfCustodyNoteCt: string | null;
  readonly chainOfCustodyNoteDekCt: string | null;
  readonly attestationSignedCt: string;
  readonly signingKeyId: string;
}

export interface MeetingDetail {
  readonly id: string;
  readonly meetingDate: string;
  readonly location: string | null;
  readonly status: MeetingStatus;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly actualStartAt: string | null;
  readonly actualEndAt: string | null;
  readonly agendaTemplateVersion: number;
  readonly currentSectionId: string | null;
  readonly createdByActorId: string;
  readonly version: number;
  readonly sections: ReadonlyArray<MeetingSection>;
  readonly attendance: ReadonlyArray<MeetingAttendee>;
  readonly signatures: ReadonlyArray<MeetingSignature>;
}

export interface MeetingListFilters {
  readonly status?: MeetingStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CreateMeetingBody {
  readonly clientId?: string;
  readonly meetingDate: string;
  readonly location?: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly agendaTemplateVersion: number;
}

export interface CreateMeetingResponse {
  readonly id: string;
  readonly status: MeetingStatus;
  readonly version: number;
  readonly sections: ReadonlyArray<{
    readonly id: string;
    readonly sectionType: MeetingSectionType;
    readonly orderIdx: number;
    readonly visibility: MeetingSectionVisibility;
  }>;
}

export interface AddAttendeeBody {
  readonly clientId?: string;
  readonly role: MeetingAttendanceRole;
  readonly party: MeetingAttendanceParty;
  readonly displayNameCt: string;
  readonly displayNameDekCt: string;
  readonly presentStatus?: MeetingPresentStatus;
  readonly attendeeUserId?: string;
}

export interface AddAttendeeResponse {
  readonly id: string;
  readonly meetingId: string;
  readonly role: MeetingAttendanceRole;
  readonly party: MeetingAttendanceParty;
  readonly presentStatus: MeetingPresentStatus;
  readonly version: number;
  readonly nameHash: string;
}

export interface PatchAttendeeBody {
  readonly presentStatus?: MeetingPresentStatus;
  readonly arrivedAt?: string | null;
  readonly departedAt?: string | null;
}

export interface PatchAttendeeResponse {
  readonly id: string;
  readonly version: number;
  readonly presentStatus: MeetingPresentStatus;
}

export interface SectionNotesBody {
  readonly notesEnvelopeCt: string;
  readonly notesEnvelopeDekCt: string;
}

export interface SectionNotesResponse {
  readonly id: string;
  readonly notesHash: string;
}

export interface InspectionReviewBody {
  readonly clientId?: string;
  readonly inspectionId: string;
  readonly outcome: MeetingReviewOutcome;
  readonly notesEnvelopeCt?: string;
  readonly notesEnvelopeDekCt?: string;
}

export interface InspectionReviewResponse {
  readonly id: string;
  readonly meetingId: string;
  readonly inspectionId: string;
  readonly outcome: MeetingReviewOutcome;
  readonly notesHash: string | null;
}

export interface AdjournResponse {
  readonly id: string;
  readonly status: MeetingStatus;
  readonly adjournedAt: string;
  readonly version: number;
  readonly metrics: {
    readonly durationSeconds: number;
    readonly itemsRaised: number;
    readonly itemsClosed: number;
    readonly recommendationsDrafted: number;
    readonly inspectionsReviewed: number;
    readonly quorumCompliance: {
      readonly metAtCallToOrder: boolean;
      readonly ruleCitation: string;
    };
  };
}

export interface SignatureBody {
  readonly clientId?: string;
  readonly signerRole: MeetingSignerRole;
  readonly signedMethod: MeetingSignedMethod;
  readonly signerDisplayNameCt: string;
  readonly signerDisplayNameDekCt: string;
  readonly evidenceEnvelopeCt?: string;
  readonly evidenceEnvelopeDekCt?: string;
  readonly evidenceStorageKey?: string;
  readonly chainOfCustodyNoteCt?: string;
  readonly chainOfCustodyNoteDekCt?: string;
}

export interface SignatureResponse {
  readonly id: string;
  readonly meetingId: string;
  readonly signerRole: MeetingSignerRole;
  readonly signedMethod: MeetingSignedMethod;
  readonly attestationSigHash: string;
}

export interface FinalizeResponse {
  readonly id: string;
  readonly status: MeetingStatus;
  readonly finalizedAt: string;
  readonly version: number;
  readonly signatureIds: ReadonlyArray<string>;
}

export interface SectionStartResponse {
  readonly id: string;
  readonly startedAt: string;
}

export interface SectionEndResponse {
  readonly id: string;
  readonly endedAt: string;
  readonly durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Milestone 2.2 — live metrics + per-meeting action items (ADR-0013 §3.2)
// ---------------------------------------------------------------------------

/** Shape mirrors apps/api/src/lib/compute-meeting-live-metrics.ts
 * `MeetingLiveMetrics` + the route's added `asOf` ISO string. The
 * dashboard chip-bar consumes this verbatim. */
export interface MeetingLiveMetricsResponse {
  readonly meetingId: string;
  readonly durationSeconds: number;
  readonly itemsRaised: number;
  readonly itemsClosed: number;
  readonly recommendationsDrafted: number;
  readonly inspectionsReviewed: number;
  readonly quorumCompliance: {
    readonly metAtCallToOrder: boolean;
    readonly currentlyMet: boolean;
    readonly ruleCitation: string;
  };
  readonly closureVerifications: {
    readonly total: number;
    readonly selfAttestation: number;
    readonly peerVerified: number;
  };
  readonly asOf: string;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const meetingsApi = {
  list: (
    filters: MeetingListFilters = {},
  ): Promise<{ items: ReadonlyArray<MeetingListItem>; nextCursor: string | null }> => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));
    if (filters.cursor) params.set('cursor', filters.cursor);
    const q = params.toString();
    return call(`${BASE}${q ? `?${q}` : ''}`);
  },

  get: (id: string): Promise<MeetingDetail> => call(`${BASE}/${encodeURIComponent(id)}`),

  create: (body: CreateMeetingBody): Promise<CreateMeetingResponse> =>
    call(BASE, { method: 'POST', json: body }),

  start: (
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; status: MeetingStatus; version: number }> =>
    call(`${BASE}/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      json: {},
      ifMatch,
    }),

  startSection: (id: string, sectionId: string): Promise<SectionStartResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/sections/${encodeURIComponent(sectionId)}/start`, {
      method: 'POST',
      json: {},
    }),

  endSection: (id: string, sectionId: string): Promise<SectionEndResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/sections/${encodeURIComponent(sectionId)}/end`, {
      method: 'POST',
      json: {},
    }),

  writeSectionNotes: (
    id: string,
    sectionId: string,
    body: SectionNotesBody,
  ): Promise<SectionNotesResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/sections/${encodeURIComponent(sectionId)}/notes`, {
      method: 'POST',
      json: body,
    }),

  addAttendee: (id: string, body: AddAttendeeBody): Promise<AddAttendeeResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/attendees`, { method: 'POST', json: body }),

  patchAttendee: (
    id: string,
    attendeeId: string,
    body: PatchAttendeeBody,
    ifMatch: number,
  ): Promise<PatchAttendeeResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/attendees/${encodeURIComponent(attendeeId)}`, {
      method: 'PATCH',
      json: body,
      ifMatch,
    }),

  reviewInspection: (id: string, body: InspectionReviewBody): Promise<InspectionReviewResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/inspections-review`, { method: 'POST', json: body }),

  adjourn: (id: string): Promise<AdjournResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/adjourn`, { method: 'POST', json: {} }),

  recordSignature: (id: string, body: SignatureBody): Promise<SignatureResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/signatures`, { method: 'POST', json: body }),

  finalize: (id: string): Promise<FinalizeResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/finalize`, { method: 'POST', json: {} }),

  /** GET /api/meetings/:id/metrics — Milestone 2.2 §3.4 live dashboard. */
  metrics: (id: string): Promise<MeetingLiveMetricsResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/metrics`),
};
