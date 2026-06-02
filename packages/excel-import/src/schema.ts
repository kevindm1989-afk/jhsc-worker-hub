// Excel-import schema detector + per-sheet parser shapes (types only in S1).
//
// S1 lands the TypeScript shapes that the S2 parsers + reconciler +
// commit-builder will consume. The actual detector body, per-sheet
// parsers, and the SheetJS configuration land in S2 — see ADR-0010
// §3.3 (detector), §3.4 (per-sheet parsers), and §3.13 (slice plan).
//
// The discriminated-union design (DetectionResult = recognized |
// unrecognized) is load-bearing per SECURITY T-X8: there is no
// "partial recognized" variant. If any required sheet or required
// column is missing, the detector returns `unrecognized` with a
// specific reason string. The typechecker rejects code that tries
// to construct a partial-recognized object.

import type { ActionItemRisk, ActionItemSection, ActionItemStatus } from '@jhsc/shared-types';

/**
 * Supported Excel-import schema versions. Currently only the
 * Meeting Minutes v1 schema ships in 1.11; a future workbook
 * shape lands as a separate detector module (`meeting_minutes_v2`,
 * `inspection_log_v1`, etc.) per ADR §3.3 schema-versioning.
 *
 * Mirrored in `@jhsc/shared-types` as `excelImportSchemaVersion`.
 */
export type ExcelImportSchemaVersion = 'meeting_minutes_v1';

/**
 * Parsed meeting metadata from the workbook's `Minutes` sheet.
 *
 * `attendance` is a single newline-or-comma-separated string blob in
 * 1.11; per-attendee row encryption is deferred to 1.12 (ADR §"Out of
 * scope" + SECURITY T-X14). The whole string is envelope-encrypted at
 * commit time on `excel_imports.inspection_review_snapshot_ct` (the
 * inspection-review snapshot column doubles as the meeting-metadata
 * sealed-blob column in 1.11 — S2 may split these).
 */
export interface ParsedMeetingMetadata {
  readonly meetingDate: string; // YYYY-MM-DD
  readonly quorum: boolean | null;
  readonly attendance: string | null;
  readonly workbookVersionString: string | null;
}

/**
 * Parsed action_item candidate from one of the four section sheets
 * (`NEW BUSINESS` / `OLD BUSINESS` / `NOTICE OF RECOMMENDATION` /
 * `COMPLETED`) or the `Closed Items History` sheet.
 *
 * `section` is set from the sheet name verbatim per ADR §3.4 — sheet
 * → section mapping is part of the schema contract:
 *   NEW BUSINESS              → new_business
 *   OLD BUSINESS              → old_business
 *   NOTICE OF RECOMMENDATION  → recommendation
 *   COMPLETED                 → completed_this_period
 *   Closed Items History      → archived
 *
 * `contentHash` is the sha256(canonical(description)||'|'||canonical(start_date))
 * computed via `computeContentHash` in canonical.ts. The hex form is
 * carried for the chain anchor payload + the preview's per-row id; the
 * raw 32-byte form is what lands in `excel_import_items.content_hash`.
 *
 * Encrypted-field text values are plaintext in this shape — the worker
 * parses to plaintext, the main thread runs the PII scanner + the
 * reconciler over the plaintext, then `commit()` envelope-seals them
 * before the API call.
 */
export interface ParsedActionItem {
  readonly sourceSheet: string; // raw sheet name, e.g. 'NEW BUSINESS'
  readonly sourceRowIndex: number; // 0-based within the sheet
  readonly section: ActionItemSection;
  /** Action item type taxonomy (1.6 enum). Unknown legacy values
   *  fall back to 'OTHER' at parse time and the legacy string lands
   *  in `typeSubtype`. */
  readonly type: string;
  readonly typeSubtype: string | null;
  readonly description: string;
  readonly recommendedAction: string | null;
  readonly raisedBy: string | null;
  readonly followUpOwner: string | null;
  readonly department: string | null;
  readonly status: ActionItemStatus;
  readonly risk: ActionItemRisk;
  readonly startDate: string; // YYYY-MM-DD
  readonly targetDate: string | null;
  readonly closedDate: string | null;
  readonly tags: ReadonlyArray<string>;
  /** Hex SHA-256 (64 chars) of canonical(description) + '|' + canonical(startDate). */
  readonly contentHashHex: string;
  /** Raw 32 bytes of the same hash, suitable for `excel_import_items.content_hash`. */
  readonly contentHash: Uint8Array;
  /** Legacy values that didn't map cleanly (status, type, etc.). */
  readonly importWarnings: Readonly<Record<string, string>>;
}

/**
 * Parsed read-only snapshot of the workbook's Inspection Review sheet.
 *
 * 1.11 stores this as an opaque JSONB-shaped 2D array; the snapshot is
 * NOT promoted to native inspection records (per ROADMAP scope + ADR
 * §3.4 — the 1.8 inspection schema is the going-forward path; this is
 * historical provenance only). Envelope-encrypted at rest because the
 * cells may contain supervisor / witness names.
 */
export interface ParsedInspectionReview {
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * The full parsed workbook (all six recognized sheets — five action-
 * item sources + the optional inspection-review snapshot).
 */
export interface ParsedSheets {
  readonly metadata: ParsedMeetingMetadata;
  readonly newBusiness: ReadonlyArray<ParsedActionItem>;
  readonly oldBusiness: ReadonlyArray<ParsedActionItem>;
  readonly recommendations: ReadonlyArray<ParsedActionItem>;
  readonly completed: ReadonlyArray<ParsedActionItem>;
  readonly closedHistory: ReadonlyArray<ParsedActionItem>;
  readonly inspectionReview: ParsedInspectionReview | null;
  /** Hex SHA-256 of the raw file bytes — the chain anchor's integrity anchor. */
  readonly sourceSha256Hex: string;
  /** Total row count across all five action-item sheets (T-X6 bound). */
  readonly rowCount: number;
}

/**
 * Detector result. Discriminated union — `recognized` carries the
 * parsed shape; `unrecognized` carries the human-readable rejection
 * reason that surfaces in the preview UI's error copy.
 *
 * Per SECURITY T-X8 there is NO partial-recognized variant — a
 * workbook missing one required sheet returns `unrecognized` so the
 * detector is fail-closed by construction.
 */
export type DetectionResult =
  | {
      readonly kind: 'recognized';
      readonly schema: ExcelImportSchemaVersion;
      readonly sheets: ParsedSheets;
    }
  | {
      readonly kind: 'unrecognized';
      readonly reason: string;
    };

/**
 * Reconciliation decision per parsed row. The reconciler produces one
 * of these for every parsed action_item against a projection of the
 * existing action_items.
 *
 * `create`           — no existing row matches the hash; new row at commit.
 * `update`           — existing row matches; ≥1 mutable field differs.
 * `skip`             — existing row matches; no field differs (idempotent).
 * `conflict_pending` — match + the existing row was edited since the
 *                      last import (rep must resolve in preview UI).
 */
export type ReconcileDecisionKind = 'create' | 'update' | 'skip' | 'conflict_pending';

export interface ReconcileDecision {
  readonly parsed: ParsedActionItem;
  readonly decisionKind: ReconcileDecisionKind;
  /** Set when an existing row was matched by content_hash. */
  readonly existingActionItemId: string | null;
  /** Field-level diff for the preview UI (S2 fleshes out the shape). */
  readonly diff: ReadonlyArray<{ field: string; current: string; incoming: string }>;
}

/**
 * Output of `reconcile()` — every parsed row classified into a decision
 * plus a count summary the preview UI uses for the section badges.
 */
export interface ReconciliationPlan {
  readonly importId: string;
  readonly decisions: ReadonlyArray<ReconcileDecision>;
  readonly summary: {
    readonly createCount: number;
    readonly updateCount: number;
    readonly skipCount: number;
    readonly conflictCount: number;
  };
}

/**
 * Output of `commit()` — the encrypted, ordered list of operations the
 * web layer POSTs to `/api/excel-imports/:id/commit`. S2 lands the
 * actual encryption + the exact wire shape; S1 carries the type so
 * route handlers + tests can already import against it.
 */
export interface CommitOperations {
  readonly importId: string;
  readonly operations: ReadonlyArray<CommitOperation>;
}

export type CommitOperation =
  | {
      readonly kind: 'create';
      readonly clientId: string;
      readonly section: ActionItemSection;
      /** Base64-encoded sealed ciphertext + sealed DEK. */
      readonly descriptionCt: string;
      readonly descriptionDekCt: string;
      readonly importItemId: string;
      readonly sourceExcelHashHex: string;
    }
  | {
      readonly kind: 'update';
      readonly actionItemId: string;
      readonly ifMatchVersion: number;
      readonly importItemId: string;
    }
  | {
      readonly kind: 'skip';
      readonly importItemId: string;
      readonly existingActionItemId: string;
    };

/**
 * Existing action_items projection — non-sensitive metadata only —
 * that the caller passes into `reconcile()`. The reconciler is pure;
 * the caller fetches this view through the typed API client.
 */
export interface ExistingActionItemView {
  readonly id: string;
  readonly contentHashHex: string;
  readonly section: ActionItemSection;
  readonly status: ActionItemStatus;
  readonly risk: ActionItemRisk;
  readonly startDate: string;
  readonly targetDate: string | null;
  readonly closedDate: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly version: number;
  /** True if `version > 1` AND the most recent edit was actor-driven (not import-driven). */
  readonly editedSinceLastImport: boolean;
}
