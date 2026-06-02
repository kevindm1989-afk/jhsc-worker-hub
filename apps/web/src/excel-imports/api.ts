// Typed client for /api/excel-imports/* — Milestone 1.11 S3.
//
// Mirrors the 1.7 / 1.8 / 1.9 / 1.10 typed-client pattern. Per ADR-0010
// §3.9 / §3.10 / §3.11:
//
//   - Reads + writes carry `X-Requested-With: jhsc-web` (supplementary
//     CSRF guard alongside SameSite=Strict cookies).
//   - `credentials: 'same-origin'` so the __Host-access cookie rides on
//     every call.
//   - Commit + reverse are step-up-gated AND require-online. A 401 with
//     `error: 'step_up_required'` dispatches the stepUpEmitter so the
//     global modal opens; a 503 `network_required` or
//     `navigator.onLine === false` throws `NetworkRequiredError` (1.10
//     pattern) so the view can render the existing NetworkRequiredBanner.
//   - The other endpoints (create, list, get, getItems, addItems,
//     transitionToPreview, cancel) are queueable in principle but the S3
//     UI shells fire them online — the save-preview path can land in the
//     sync queue (1.10) in a future refactor; for S3 they throw on
//     offline and the view surfaces NetworkRequiredBanner.
//
// DTOs mirror the S2 route handler shapes exactly (apps/api/src/routes/
// excel-imports/index.ts). The list projection includes the per-status
// counts rollup (created / updated / skipped / conflict_pending); the
// detail projection adds the decrypted source filename.

import type { ExcelImportSchemaVersion, ExcelImportStatus } from '@jhsc/shared-types';
import { stepUpEmitter } from '@/auth/api';
import { NetworkRequiredError } from '@/sync/typed-client';

const BASE = '/api/excel-imports';

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

export class ExcelImportApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`excel-imports api ${status}`);
    this.name = 'ExcelImportApiError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// fetch wrapper
// ---------------------------------------------------------------------------

interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly json?: unknown;
  /**
   * When set, this is the step-up action label dispatched on a 401
   * step_up_required response. The commit + reverse paths set this so
   * the global modal binds the action label to the prompt copy.
   */
  readonly stepUpAction?: string;
  /**
   * When true, treat offline / 503 network_required as a
   * NetworkRequiredError throw. The commit + reverse paths set this so
   * the UI can render the existing NetworkRequiredBanner without a
   * second error class.
   */
  readonly requireOnline?: boolean;
}

async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'jhsc-web' };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  // Pre-flight online check for the require-online paths — matches the
  // 1.10 typed-client requireOnline() helper. Pure UX: catches the
  // common case before we even fire the request.
  if (opts.requireOnline) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new NetworkRequiredError(opts.stepUpAction ?? 'excel_import.action');
    }
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers,
      body,
    });
  } catch (err) {
    // A raw fetch rejection on a require-online path is treated as a
    // NetworkRequiredError so the view's error branch matches the same
    // shape regardless of whether the SW intercepted or the network
    // itself failed.
    if (opts.requireOnline) {
      throw new NetworkRequiredError(opts.stepUpAction ?? 'excel_import.action');
    }
    throw err;
  }
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
      const action = errBody.action ?? opts.stepUpAction ?? 'excel_import.action';
      stepUpEmitter.dispatch(action);
    }
    throw new ExcelImportApiError(res.status, parsed);
  }
  if (res.status === 503) {
    // The 1.10 service worker returns 503 + `error: network_required`
    // for require-online routes when the SW can't reach the server.
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    const errBody = parsed as { error?: string } | undefined;
    if (opts.requireOnline && errBody?.error === 'network_required') {
      throw new NetworkRequiredError(opts.stepUpAction ?? 'excel_import.action');
    }
    throw new ExcelImportApiError(res.status, parsed);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
    throw new ExcelImportApiError(res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// DTOs — mirror the S2 route handler shapes exactly
// ---------------------------------------------------------------------------

export interface ExcelImportCounts {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly conflictPending: number;
}

export interface ExcelImportListItem {
  readonly id: string;
  readonly status: ExcelImportStatus;
  readonly sourceSha256: string;
  readonly schemaVersion: ExcelImportSchemaVersion;
  readonly rowCount: number;
  readonly createdAt: string;
  readonly previewedAt: string | null;
  readonly committedAt: string | null;
  readonly cancelledAt: string | null;
  readonly reversedAt: string | null;
  readonly counts: ExcelImportCounts;
}

export interface ExcelImportDetail {
  readonly id: string;
  readonly status: ExcelImportStatus;
  readonly sourceFilename: string;
  readonly sourceSha256: string;
  readonly schemaVersion: ExcelImportSchemaVersion;
  readonly rowCount: number;
  readonly createdAt: string;
  readonly previewedAt: string | null;
  readonly committedAt: string | null;
  readonly cancelledAt: string | null;
  readonly reversedAt: string | null;
  readonly auditIdx: number;
}

export interface ExcelImportItem {
  readonly id: string;
  readonly sourceRowIndex: number;
  readonly section: string;
  readonly contentHash: string;
  readonly status: 'created' | 'updated' | 'skipped' | 'conflict_pending';
  readonly actionItemId: string | null;
  readonly auditIdx: number | null;
  readonly createdAt: string;
}

export interface ExcelImportItemsPage {
  readonly items: ReadonlyArray<ExcelImportItem>;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface CreateExcelImportBody {
  readonly sourceFilename: string;
  readonly sourceSha256: string;
  readonly schemaVersion: ExcelImportSchemaVersion;
  readonly rowCount: number;
  /** Optional opaque JSONB snapshot of the Inspection Review sheet
   * (the worker returns `{rows: string[][]}`); the server canonical-
   * JSON-stringifies before envelope encryption. */
  readonly inspectionReviewSnapshot?: Record<string, unknown>;
}

export interface CreateExcelImportResponse {
  readonly id: string;
  readonly status: ExcelImportStatus;
  readonly createdAt: string;
  readonly auditIdx: number;
}

/**
 * Per-row wire shape for `POST /api/excel-imports/:id/items`. The
 * sensitive fields (descriptionCt, descriptionDekCt, etc.) are base64-
 * encoded ciphertext + sealed DEK produced by the browser via the same
 * sealed-box pattern as 1.7 evidence (sealEvidence). The server stores
 * the bytes as-is; only the workplace private key can later decrypt.
 *
 * The `actionItemRow` shape includes the structural metadata (type,
 * risk, dates, status, section) the server needs to allocate sequence
 * numbers + insert action_items rows during the commit transaction.
 */
export interface ExcelImportItemPayload {
  readonly sourceRowIndex: number;
  readonly section: string;
  readonly contentHash: string;
  readonly status: 'created' | 'updated' | 'skipped' | 'conflict_pending';
  /** Optional rep-side decision metadata captured in the preview UI;
   * the server passes through to the import_item's before_state_json. */
  readonly beforeState?: Record<string, unknown>;
  /** Client-allocated UUID v4 for the action_items row that will be
   * INSERTed on commit (per-row, deterministic, mirrors the 1.10 sync
   * clientId pattern). */
  readonly clientId: string;
  readonly actionItemRow: {
    readonly type: string;
    readonly typeSubtype?: string | null;
    readonly descriptionCt: string;
    readonly descriptionDekCt: string;
    readonly recommendedActionCt?: string | null;
    readonly recommendedActionDekCt?: string | null;
    readonly raisedByCt?: string | null;
    readonly raisedByDekCt?: string | null;
    readonly followUpOwnerCt?: string | null;
    readonly followUpOwnerDekCt?: string | null;
    readonly department?: string | null;
    readonly status: string;
    readonly risk: string;
    readonly startDate: string;
    readonly targetDate?: string | null;
    readonly closedDate?: string | null;
    readonly tags: ReadonlyArray<string>;
    /** Update-only — the existing action_item being patched. */
    readonly actionItemId?: string;
    readonly ifMatchVersion?: number;
  };
}

export interface AddItemsResponse {
  readonly insertedCount: number;
}

export interface TransitionToPreviewResponse {
  readonly id: string;
  readonly status: 'preview';
  readonly previewedAt: string;
}

export interface CommitResponse {
  readonly id: string;
  readonly status: 'committed';
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly skippedCount: number;
  readonly conflictResolvedCount: number;
}

export interface CancelResponse {
  readonly id: string;
  readonly status: 'cancelled';
  readonly cancelledAt: string;
}

export interface ReverseResponse {
  readonly id: string;
  readonly status: 'reversed';
  readonly deletedCount: number;
  readonly revertedCount: number;
  readonly refusedCount: number;
  readonly reversedAt: string;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

export interface ItemsListOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export const excelImportsApi = {
  /** List metadata for the actor's imports (last 200, newest first). */
  list: (): Promise<{ items: ReadonlyArray<ExcelImportListItem> }> => call(BASE),

  /** Detail (includes decrypted source filename + audit_idx). */
  get: (id: string): Promise<ExcelImportDetail> => call(`${BASE}/${encodeURIComponent(id)}`),

  /** Paginated per-row items for a single import. */
  getItems: (id: string, opts: ItemsListOptions = {}): Promise<ExcelImportItemsPage> => {
    const params = new URLSearchParams();
    if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
    if (typeof opts.offset === 'number') params.set('offset', String(opts.offset));
    const query = params.toString();
    return call(`${BASE}/${encodeURIComponent(id)}/items${query ? `?${query}` : ''}`);
  },

  /** Create a pending import. The body's source filename is envelope-
   * encrypted server-side (T-X19) — the rep's local filename is what
   * goes here, not a derived alias. */
  create: (body: CreateExcelImportBody): Promise<CreateExcelImportResponse> =>
    call(BASE, { method: 'POST', json: body }),

  /** pending → preview state transition. No body. */
  transitionToPreview: (id: string): Promise<TransitionToPreviewResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}`, { method: 'PATCH', json: {} }),

  /** Batch-insert excel_import_items in the preview state. The per-row
   * sensitive fields are pre-sealed on the client. */
  addItems: (id: string, items: ReadonlyArray<ExcelImportItemPayload>): Promise<AddItemsResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      json: { items },
    }),

  /** Commit — step-up gated, require-online. The server-side handler
   * walks every item, INSERTs created action_items, PATCHes updated
   * rows, and emits per-row + batch chain anchors. */
  commit: (id: string): Promise<CommitResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/commit`, {
      method: 'POST',
      json: {},
      stepUpAction: 'excel_import.commit',
      requireOnline: true,
    }),

  /** Cancel a pending/preview import. */
  cancel: (id: string): Promise<CancelResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      json: {},
    }),

  /** Reverse — step-up gated, require-online, 30-day window. The server
   * walks each committed item + soft-deletes created rows / reverts
   * updated rows / refuses items the rep edited since the import. */
  reverse: (id: string): Promise<ReverseResponse> =>
    call(`${BASE}/${encodeURIComponent(id)}/reverse`, {
      method: 'POST',
      json: {},
      stepUpAction: 'excel_import.reverse',
      requireOnline: true,
    }),
};
