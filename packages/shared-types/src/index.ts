// @jhsc/shared-types — type definitions consumed across the workspace.
//
// Rules (CLAUDE.md):
// - No magic strings. Every enum lives here.
// - Discriminated unions for fallible operations and for audit payloads
//   so the typechecker rejects PI fields at every call site.

// ---------------------------------------------------------------------------
// Result<T, E> — fallible operations
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Branded IDs — nominal typing for opaque strings
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;

/**
 * Client-generated UUID v4 used as the canonical id end-to-end (ADR-0009
 * §3.3). The browser allocates `_local_id` at create time; every create
 * POST carries `clientId` in the body and the server INSERTs the row
 * with `id = clientId`. Keeps the URL stable from typing to chain anchor
 * and removes the two-id rewrite phase that option (a) would impose.
 */
export type ClientId = Brand<string, 'ClientId'>;

// RFC 4122 v4 UUID — `4` in the version slot, one of `89ab` in the
// variant slot, lowercase hex elsewhere. The server's Zod validator uses
// the looser `.uuid()` shape (accepts any v1–v8); this is the tighter
// runtime check so a buggy or tampered client RNG can't slip a v1/v7
// UUID through the offline-sync envelope (T-S12 in SECURITY.md §2.10).
const CLIENT_ID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isClientId(s: string): s is ClientId {
  return typeof s === 'string' && CLIENT_ID_V4_RE.test(s);
}

// ---------------------------------------------------------------------------
// Auth-surface enums (mirror the pgEnums in apps/api/src/db/schema.ts)
// ---------------------------------------------------------------------------

export type AuthEventKind =
  | 'signup'
  | 'login.passkey'
  | 'login.password'
  | 'login.totp'
  | 'login.recovery'
  | 'login.failed'
  | 'logout'
  | 'session.refreshed'
  | 'session.revoked'
  | 'step_up.granted'
  | 'step_up.denied'
  | 'lockout.applied'
  | 'lockout.cleared'
  | 'passkey.registered'
  | 'passkey.removed'
  | 'totp.enrolled'
  | 'totp.reset'
  | 'recovery_codes.generated'
  | 'recovery_codes.consumed'
  | 'first_run.completed';

export type WebauthnPurpose = 'register' | 'authenticate' | 'step_up';
export type LoginAttemptOutcome = 'success' | 'failure';

// ---------------------------------------------------------------------------
// Audit chain — kinds + per-kind payload unions (ADR-0002 §"Audit chain")
// ---------------------------------------------------------------------------

// `system.*` and `audit.*` kinds are used by packages/audit's own
// boilerplate (genesis, backfill anchors, key-rotation markers).
// `auth.*` kinds mirror AuthEventKind so the chain absorbs 1.2's
// flat auth_events stream when the backfill anchor lands.
// Later milestones grow this union (`hazard.*`, `export.*`, etc.).
export type AuditEventKind =
  | 'system.genesis'
  | 'audit.backfill.1_2_auth_events'
  | 'audit.crypto.rewrap'
  | 'audit.kek.rotation'
  | 'audit.corpus.seeded'
  | 'audit.corpus.amended'
  | 'hazard.created'
  | 'hazard.status_changed'
  | 'action_item.created'
  | 'action_item.updated'
  | 'action_item.moved'
  | 'action_item.move_undone'
  | 'evidence.uploaded'
  | 'evidence.read'
  | 'evidence.list_accessed'
  | 'inspection.created'
  | 'inspection_finding.created'
  | 'inspection_finding.promoted'
  | 'inspection_finding.read'
  | 'inspection.signed'
  | 'inspection.exported'
  | 'inspection.export.downloaded'
  | 'audit.inspection_template.seeded'
  | 'recommendation.drafted'
  | 'recommendation.draft_patched'
  | 'recommendation.submitted'
  | 'recommendation.response_captured'
  | 'recommendation.resolved'
  | 'recommendation.withdrawn'
  | 'recommendation.exported'
  | 'recommendation.export.downloaded'
  | 'audit.workplace_signing_key.seeded'
  | 'excel_import.uploaded'
  | 'excel_import.committed'
  | 'excel_import.reversed'
  | AuthEventKind;

// ---------------------------------------------------------------------------
// Hazards (Milestone 1.5, ADR-0004)
// ---------------------------------------------------------------------------

export const hazardSeverity = ['critical', 'high', 'medium', 'low'] as const;
export type HazardSeverity = (typeof hazardSeverity)[number];

export const hazardStatus = [
  'open',
  'assessing',
  'assigned',
  'resolved',
  'archived',
  'withdrawn',
] as const;
export type HazardStatus = (typeof hazardStatus)[number];

export const hazardJurisdiction = ['ON', 'CA'] as const;
export type HazardJurisdiction = (typeof hazardJurisdiction)[number];

// ---------------------------------------------------------------------------
// Action items (Milestone 1.6, ADR-0005)
// ---------------------------------------------------------------------------

export const actionItemType = [
  'INSP',
  'INSIGHT',
  'FLI',
  'INC',
  'REC',
  'TRAIN',
  'PROC',
  'OTHER',
] as const;
export type ActionItemType = (typeof actionItemType)[number];

export const actionItemStatus = [
  'Not Started',
  'In Progress',
  'Blocked',
  'Pending Review',
  'Closed',
  'Cancelled',
] as const;
export type ActionItemStatus = (typeof actionItemStatus)[number];

export const actionItemSection = [
  'new_business',
  'old_business',
  'recommendation',
  'completed_this_period',
  'archived',
] as const;
export type ActionItemSection = (typeof actionItemSection)[number];

export const actionItemRisk = ['Low', 'Medium', 'High', 'Critical'] as const;
export type ActionItemRisk = (typeof actionItemRisk)[number];

export const actionItemSourceType = [
  'manual',
  'hazard',
  'recommendation',
  'inspection',
  'incident',
  'excel_import',
] as const;
export type ActionItemSourceType = (typeof actionItemSourceType)[number];

/** Allow-list of update field names that can appear in the action_item.updated payload. */
export const actionItemUpdateField = [
  'status',
  'risk',
  'description',
  'recommended_action',
  'target_date',
  'closed_date',
  'tags',
  'follow_up_owner',
  'department',
  'type_subtype',
] as const;
export type ActionItemUpdateField = (typeof actionItemUpdateField)[number];

// ---------------------------------------------------------------------------
// Inspections (Milestone 1.8, ADR-0007)
// ---------------------------------------------------------------------------

/** Stable template_code namespace. 'custom' is the prefix-bearing slot for
 * workplace-authored templates (ADR-0007 §3.5). */
export const inspectionTemplateCode = ['zone_monthly', 'rack_inspection', 'custom'] as const;
export type InspectionTemplateCode = (typeof inspectionTemplateCode)[number];

/** Two status vocabularies ship in 1.8 — ABC+X (Zone Monthly) and GAR
 * (Rack / CSA A344). ADR-0007 §3.2 deliberately keeps them distinct
 * rather than flattening to a common axis. */
export const inspectionStatusVocabKind = ['ABC_X', 'GAR'] as const;
export type InspectionStatusVocabKind = (typeof inspectionStatusVocabKind)[number];

/** ABC+X codes. 'X' is the not-promotable marker (no issue / N/A). */
export const inspectionFindingStatusAbcx = ['A', 'B', 'C', 'X'] as const;
export type InspectionFindingStatusAbcx = (typeof inspectionFindingStatusAbcx)[number];

/** GAR codes. 'G' is the not-promotable marker (green / no issue). Note
 * 'A' overloads with ABC+X — the row carries both status_vocab and
 * status_value so the API can disambiguate. */
export const inspectionFindingStatusGar = ['G', 'A', 'R'] as const;
export type InspectionFindingStatusGar = (typeof inspectionFindingStatusGar)[number];

/** Conduct lifecycle states. The DB CHECK accepts these values; the
 * transition graph (scheduled → in_progress → awaiting_signatures →
 * complete → archived) is enforced at the route layer. */
export const inspectionConductState = [
  'scheduled',
  'in_progress',
  'awaiting_signatures',
  'complete',
  'archived',
] as const;
export type InspectionConductState = (typeof inspectionConductState)[number];

/** Signature roles. Rack requires all three; Zone Monthly only inspector
 * (ADR-0007 §3.8). */
export const inspectionSignatureRole = ['inspector', 'supervisor', 'jhsc_worker_co_chair'] as const;
export type InspectionSignatureRole = (typeof inspectionSignatureRole)[number];

/** Export kind discriminator on export_records.kind. */
export const inspectionExportKind = ['single', 'batch'] as const;
export type InspectionExportKind = (typeof inspectionExportKind)[number];

/**
 * Dual-shape responsible_party on inspection_findings (ADR-0008 §3.12,
 * 1.8 priv-F8 close-out). 'user_ref' = internal owner referenced by
 * responsible_party_user_id; 'name_text' = external named party stored
 * in responsible_party_ct/dek_ct. NULL kind means neither column is
 * populated (pre-1.9 rows or open findings).
 */
export const inspectionFindingResponsiblePartyKind = ['user_ref', 'name_text'] as const;
export type InspectionFindingResponsiblePartyKind =
  (typeof inspectionFindingResponsiblePartyKind)[number];

/**
 * Promotability gate for inspection findings (CLAUDE.md #15).
 * Returns false for 'X' (ABC+X) and 'G' (GAR) — both the not-promotable
 * markers — and true for every other in-vocab value. The route layer
 * and the UI both consume this helper; it is the single source of
 * truth for the X/G fail-closed gate.
 */
export function inspectionPromotability(
  statusVocab: InspectionStatusVocabKind,
  statusValue: string,
): boolean {
  if (statusVocab === 'ABC_X') {
    return statusValue === 'A' || statusValue === 'B' || statusValue === 'C';
  }
  if (statusVocab === 'GAR') {
    return statusValue === 'A' || statusValue === 'R';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recommendations (Milestone 1.9, ADR-0008)
// ---------------------------------------------------------------------------

/** Recommendation lifecycle state-machine. The DB CHECK accepts every
 * value here; the transition graph (draft → submitted → response_received
 * → resolved; * → withdrawn) is enforced at the route layer per
 * ADR-0008 §3.1. */
export const recommendationStatus = [
  'draft',
  'submitted',
  'response_received',
  'resolved',
  'withdrawn',
] as const;
export type RecommendationStatus = (typeof recommendationStatus)[number];

/** Recommendation jurisdiction. Drives the 21-day s.9(21) clock (ON,
 * hard deadline) vs CLC s.135(6) "as soon as possible" (CA-FED,
 * informational). The legal-corpus picker scopes by this value. Mirrors
 * the `statutes.jurisdiction` namespace, not `hazardJurisdiction` (which
 * uses the short 'CA' tag — recommendations use the explicit 'CA-FED'
 * form per ADR-0008 §3.2). */
export const recommendationJurisdiction = ['ON', 'CA-FED'] as const;
export type RecommendationJurisdiction = (typeof recommendationJurisdiction)[number];

/** Link kind on recommendation_action_item_links. 'tracks' is the
 * standard case used by 1.9 routes (the auto-created action item
 * tracks management's response). 'replaces' is a forward seam per
 * ADR-0008 §3.5 — the rec-supersedes-a-hazard-item pattern lands its
 * UI in Release 2; 1.9 SQL accepts the value but the route never
 * writes it. */
export const recommendationLinkKind = ['tracks', 'replaces'] as const;
export type RecommendationLinkKind = (typeof recommendationLinkKind)[number];

/** New export_records.kind value introduced in 1.9. The existing
 * 'single' / 'batch' values remain valid for inspection exports per
 * ADR-0008 §3.11; only 'recommendation_single' is added here. The
 * shared-types enum lists only the new value so callers writing
 * recommendation exports use this constant; the union with the
 * inspection-export values lives in the schema CHECK + the route
 * Zod refinement, not as a single TS enum (matches the kind-vs-family
 * separation in §3.11). */
export const recommendationExportKind = ['recommendation_single'] as const;
export type RecommendationExportKind = (typeof recommendationExportKind)[number];

/** Workplace signing-key primitive. Ed25519 is the only algorithm
 * supported in 1.9 per ADR-0008 §3.7; the enum is forward-seam shape
 * for a future rotation (Ed448, post-quantum) without churning the
 * column type. */
export const workplaceSigningKeyAlgorithm = ['ed25519'] as const;
export type WorkplaceSigningKeyAlgorithm = (typeof workplaceSigningKeyAlgorithm)[number];

/**
 * Compute the s.9(21) deadline for a submitted recommendation.
 * ON: submitted_at + 21 days (hard statutory clock).
 * CA-FED: null — CLC s.135(6) is "as soon as possible", no fixed clock
 * per ADR-0008 §3.6 (we do NOT invent a default deadline; non-negotiable
 * #5 forbids invention).
 *
 * Pure function; the route's projection calls this server-side so the
 * client never re-computes day boundaries (matches the 1.6 action-flag
 * posture).
 */
export function computeRecommendationDeadline(
  submittedAt: Date,
  jurisdiction: RecommendationJurisdiction,
): Date | null {
  if (jurisdiction === 'ON') {
    const deadline = new Date(submittedAt.getTime());
    deadline.setUTCDate(deadline.getUTCDate() + 21);
    return deadline;
  }
  // CA-FED: informational only.
  return null;
}

/** Deadline state surfaced on the badge per ADR-0008 §3.6.
 * - 'no_deadline' — CA-FED or any caller passing a null deadline.
 * - 'on_time' — now is at or before the deadline.
 * - 'overdue' — now is past the deadline.
 *
 * Boundary is inclusive on `on_time` (the deadline second itself is
 * still on-time; only strictly-after counts as overdue). Pure function.
 */
export type RecommendationDeadlineState = 'no_deadline' | 'on_time' | 'overdue';

export function recommendationDeadlineState(
  now: Date,
  deadline: Date | null,
): RecommendationDeadlineState {
  if (deadline === null) return 'no_deadline';
  if (now.getTime() <= deadline.getTime()) return 'on_time';
  return 'overdue';
}

// ---------------------------------------------------------------------------
// Evidence (Milestone 1.7, ADR-0006)
// ---------------------------------------------------------------------------

/**
 * Polymorphic linked_type for evidence_files. The schema CHECK accepts
 * the full list now; the API route layer only accepts 'hazard' and
 * 'action_item' in 1.7 and rejects the rest until their owning
 * migrations ship per-type FK triggers (same fail-closed pattern as
 * action items priv-AI-F3).
 */
export const evidenceLinkedType = [
  'hazard',
  'action_item',
  'inspection_finding',
  'recommendation',
  'incident',
] as const;
export type EvidenceLinkedType = (typeof evidenceLinkedType)[number];

/** Mime allow-list. No PDF execution surface, no raw text, no exotic formats. */
export const evidenceMimeType = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'audio/webm',
  'audio/ogg',
  'application/pdf',
] as const;
export type EvidenceMimeType = (typeof evidenceMimeType)[number];

/**
 * Per-kind payload shapes. Every kind that ever lands an audit row
 * must declare its payload here. Fields are typed enums + IDs +
 * counts only — never PI. The typechecker rejects unrecognized
 * fields at every `append()` call site (T-AC9 mitigation).
 */
export type AuditPayload =
  | { readonly kind: 'system.genesis'; readonly schemaVersion: string }
  | {
      readonly kind: 'audit.backfill.1_2_auth_events';
      readonly rowCount: number;
      readonly rowsSha256: string;
      readonly oldestTs: string | null;
      readonly newestTs: string | null;
    }
  | { readonly kind: 'audit.crypto.rewrap'; readonly resource: string }
  | { readonly kind: 'audit.kek.rotation'; readonly fromKid: string; readonly toKid: string }
  | {
      readonly kind: 'audit.corpus.seeded';
      readonly version: string;
      readonly statutes: ReadonlyArray<string>;
      readonly clauseCount: number;
      readonly fixtureSha256: string;
    }
  | {
      readonly kind: 'audit.corpus.amended';
      readonly version: string;
      readonly statuteCode: string;
      readonly citation: string;
      readonly priorVersionDate: string;
      readonly newVersionDate: string;
    }
  | {
      readonly kind: 'hazard.created';
      readonly hazardId: string;
      readonly hazardCode: string;
      readonly severity: HazardSeverity;
      readonly jurisdiction: HazardJurisdiction;
    }
  | {
      readonly kind: 'hazard.status_changed';
      readonly hazardId: string;
      readonly hazardCode: string;
      readonly fromStatus: HazardStatus;
      readonly toStatus: HazardStatus;
    }
  | {
      // S1 NOTE (1.11): ADR-0010 §3.9 introduces an optional
      // `createdByImportId` field on this payload for the
      // excel-import-created branch. The retrofit is DEFERRED to S2
      // when the actual commit transaction lands and the route layer
      // proves out the wiring. S1's three new excel_import.* kinds
      // (uploaded / committed / reversed) suffice for the package's
      // test coverage; the per-row link can be reconstructed at
      // verifier time by joining excel_import_items.action_item_id
      // until the additive field arrives in S2.
      readonly kind: 'action_item.created';
      readonly itemId: string;
      readonly itemType: ActionItemType;
      readonly section: ActionItemSection;
      readonly risk: ActionItemRisk;
    }
  | {
      readonly kind: 'action_item.updated';
      readonly itemId: string;
      readonly changedFields: ReadonlyArray<ActionItemUpdateField>;
    }
  | {
      readonly kind: 'action_item.moved';
      readonly itemId: string;
      readonly fromSection: ActionItemSection | null;
      readonly toSection: ActionItemSection;
      readonly undone?: boolean;
    }
  | {
      readonly kind: 'action_item.move_undone';
      readonly itemId: string;
      readonly movedItemId: string;
      readonly revertedFromSection: ActionItemSection;
      readonly revertedToSection: ActionItemSection;
    }
  | {
      readonly kind: 'evidence.uploaded';
      readonly evidenceId: string;
      readonly linkedType: EvidenceLinkedType;
      readonly linkedId: string;
      readonly mimeType: EvidenceMimeType;
      readonly byteSize: number;
      /** Hex-encoded SHA-256 of the plaintext file. Non-reversible. */
      readonly plaintextSha256: string;
    }
  | {
      readonly kind: 'evidence.read';
      readonly evidenceId: string;
      readonly linkedType: EvidenceLinkedType;
      readonly linkedId: string;
    }
  | {
      // priv-F5 close-out: the list endpoint emits one anchor per call
      // so a session-token theft that can't pass step-up still leaves a
      // trail when bulk-walking GPS/timestamp metadata. Payload is
      // PI-clean: linkedType + linkedId + row count, no per-row ids.
      readonly kind: 'evidence.list_accessed';
      readonly linkedType: EvidenceLinkedType;
      readonly linkedId: string;
      readonly rowCount: number;
    }
  | {
      readonly kind: 'inspection.created';
      readonly inspectionId: string;
      readonly templateCode: InspectionTemplateCode;
      readonly templateVersionId: string;
      readonly conductedByUserId: string;
      readonly zoneId: string;
      readonly scheduledFor: string | null;
    }
  | {
      readonly kind: 'inspection_finding.created';
      readonly inspectionId: string;
      readonly findingId: string;
      readonly sectionKey: string;
      readonly statusVocab: InspectionStatusVocabKind;
      readonly statusValue: string;
      readonly hasObservation: boolean;
      readonly hasCorrectiveAction: boolean;
    }
  | {
      readonly kind: 'inspection_finding.promoted';
      readonly findingId: string;
      readonly actionItemId: string;
      readonly risk: ActionItemRisk;
    }
  | {
      readonly kind: 'inspection.signed';
      readonly inspectionId: string;
      readonly signatureId: string;
      readonly role: InspectionSignatureRole;
    }
  | {
      readonly kind: 'inspection.exported';
      readonly exportId: string;
      readonly kindOfExport: InspectionExportKind;
      readonly inspectionIds: ReadonlyArray<string>;
      readonly outputSha256: string;
      readonly byteSize: number;
    }
  | {
      // 1.9 close-out of 1.8 priv-F3 — every step-up-gated finding
      // detail read emits a per-read anchor (ADR-0008 §3.12). PI-clean:
      // ids only, no decrypted observation/corrective-action text.
      readonly kind: 'inspection_finding.read';
      readonly findingId: string;
      readonly inspectionId: string;
    }
  | {
      // 1.9 close-out of 1.8 priv-F5 — every export-download fires a
      // per-download anchor (ADR-0008 §3.12). The actor's user id is
      // already in the chain row's actor_id slot; the payload echo lets
      // offline chain verifiers cross-reference without joining.
      readonly kind: 'inspection.export.downloaded';
      readonly exportId: string;
      readonly downloadedByUserId: string;
    }
  | {
      readonly kind: 'audit.inspection_template.seeded';
      readonly templateCode: InspectionTemplateCode;
      readonly templateVersionId: string;
      readonly version: number;
      readonly statusVocab: InspectionStatusVocabKind;
      readonly sectionCount: number;
      readonly structureSha256: string;
    }
  | {
      // Recommendation lifecycle anchors (ADR-0008 §3.1 / §3.2).
      // PI-clean: ids + jurisdiction enum + number only — NEVER title,
      // body, citation prose, or response text.
      readonly kind: 'recommendation.drafted';
      readonly recommendationId: string;
      readonly recommendationNumber: number;
      readonly jurisdiction: RecommendationJurisdiction;
    }
  | {
      // S5 sec-F4 close-out (T-R44): chain anchor on every successful
      // PATCH of a draft recommendation. priorCitationsHash +
      // newCitationsHash capture citation churn between edits;
      // bodyChanged is a boolean (NOT the body text — that stays
      // encrypted on the row). Emitted inside the PATCH transaction;
      // failed PATCHes do not anchor. The 1.9 contract opens this kind
      // explicitly so draft-state mutations leave a tamper-evident
      // trail without exposing PI in the payload.
      readonly kind: 'recommendation.draft_patched';
      readonly recommendationId: string;
      readonly recommendationNumber: number;
      readonly priorCitationsHash: string;
      readonly newCitationsHash: string;
      readonly bodyChanged: boolean;
    }
  | {
      readonly kind: 'recommendation.submitted';
      readonly recommendationId: string;
      readonly recommendationNumber: number;
      readonly jurisdiction: RecommendationJurisdiction;
      readonly citationCount: number;
      readonly linkedActionItemId: string;
    }
  | {
      readonly kind: 'recommendation.response_captured';
      readonly recommendationId: string;
      readonly responseId: string;
      readonly position: number;
    }
  | {
      readonly kind: 'recommendation.resolved';
      readonly recommendationId: string;
      readonly linkedActionItemId: string;
    }
  | {
      // linkedActionItemId is null when withdrawal happens from `draft`
      // (no action item was ever created — that only happens at submit
      // per ADR-0008 §3.5). The withdrawal reason text is NEVER in the
      // chain payload — it lives encrypted on the row (T-AC9 / risk
      // documented in ADR-0008 Risks).
      readonly kind: 'recommendation.withdrawn';
      readonly recommendationId: string;
      readonly linkedActionItemId: string | null;
    }
  | {
      // Signed export anchor. The signing_key_id is the durable
      // pointer to the historical workplace_signing_keys row that
      // produced the signature; verification of past exports
      // consults this id forever (ADR-0008 §3.7 rotation semantics).
      readonly kind: 'recommendation.exported';
      readonly exportId: string;
      readonly recommendationId: string;
      readonly outputSha256: string;
      readonly signatureSha256: string;
      readonly signingKeyId: string;
      readonly citationsHash: string;
      readonly byteSize: number;
    }
  | {
      // S5 sec-F2 close-out (T-R43): per-download chain anchor on the
      // recommendation export ZIP. Mirrors the 1.8 retrofit of
      // inspection.export.downloaded. Emitted AFTER step-up clears,
      // Tigris fetch succeeds, and the TOCTOU verify (PDF SHA + the
      // signature SHA cross-check from sec-F3) all pass. Failed paths
      // (401, 404, 410, SHA mismatch, signature mismatch, wrong_kind)
      // do NOT anchor. PI-clean: ids + downloader user id only.
      readonly kind: 'recommendation.export.downloaded';
      readonly exportId: string;
      readonly recommendationId: string;
      readonly downloadedByUserId: string;
    }
  | {
      // Seed-time anchor for the workplace signing keypair (ADR-0008
      // §3.7). publicKeySha256 is the hex SHA-256 of the 32-byte
      // Ed25519 public key — the "fingerprint" surfaced in the
      // verification UI and ZIP manifest.
      readonly kind: 'audit.workplace_signing_key.seeded';
      readonly signingKeyId: string;
      readonly algorithm: WorkplaceSigningKeyAlgorithm;
      readonly publicKeySha256: string;
    }
  | {
      // Excel-import lifecycle anchor — emitted on upload-record (the
      // excel_imports row is created at status='preview'). PI-clean:
      // hash + counts + schema enum only. The source filename is on
      // the row encrypted; it never enters the chain payload.
      readonly kind: 'excel_import.uploaded';
      readonly importId: string;
      /** Hex SHA-256 of the raw file bytes. Integrity anchor. */
      readonly sourceSha256: string;
      readonly rowCount: number;
      readonly schemaVersion: ExcelImportSchemaVersion;
    }
  | {
      // Emitted at the commit-transaction end, after all per-row
      // anchors fired. PI-clean: counts only — no row content, no
      // action_item ids (the per-row anchors carry those).
      readonly kind: 'excel_import.committed';
      readonly importId: string;
      readonly createdCount: number;
      readonly updatedCount: number;
      readonly skippedCount: number;
      readonly conflictResolvedCount: number;
    }
  | {
      // Emitted at the reverse-transaction end (within 30 days; after
      // 30 days the operator-script path adds the optional
      // viaOperatorScript + operatorUserId fields — S2 lands those).
      // PI-clean: server timestamp + count of rows touched.
      readonly kind: 'excel_import.reversed';
      readonly importId: string;
      readonly reversedAt: string;
    }
  | { readonly kind: 'signup'; readonly via: 'first_run' | 'invite' }
  | { readonly kind: 'login.passkey' }
  | { readonly kind: 'login.password' }
  | { readonly kind: 'login.totp' }
  | { readonly kind: 'login.recovery'; readonly codeId: string }
  | { readonly kind: 'login.failed'; readonly reason?: string }
  | { readonly kind: 'logout'; readonly sessionId: SessionId }
  | { readonly kind: 'session.refreshed'; readonly sessionId: SessionId }
  | {
      readonly kind: 'session.revoked';
      readonly scope: 'single' | 'all';
      readonly sessionsRemoved?: number;
      /** Operator OS username when revocation came from the admin CLI (auth-unlock --logout-all). */
      readonly operator?: string;
      /** Free-text reason from the admin CLI. Runbook §2 / §4 limit this to event-class strings — never PI. */
      readonly reason?: string;
    }
  | { readonly kind: 'step_up.granted'; readonly until: string | null }
  | { readonly kind: 'step_up.denied'; readonly reason: string }
  | {
      readonly kind: 'lockout.applied';
      readonly tier: 'short' | 'long' | 'hard';
      readonly retryAfterSeconds: number | null;
    }
  | {
      readonly kind: 'lockout.cleared';
      readonly operator: string;
      readonly reason: string;
      readonly rowsDeleted: number;
    }
  | { readonly kind: 'passkey.registered' }
  | { readonly kind: 'passkey.removed' }
  | { readonly kind: 'totp.enrolled' }
  | { readonly kind: 'totp.reset' }
  | { readonly kind: 'recovery_codes.generated'; readonly count: number }
  | { readonly kind: 'recovery_codes.consumed'; readonly codeId: string }
  | { readonly kind: 'first_run.completed' };

// ---------------------------------------------------------------------------
// Offline sync (Milestone 1.10, ADR-0009)
// ---------------------------------------------------------------------------

/** Sync operation discriminator. Mirrors the wire-level mutation kind a
 * queued operation represents. `transition` covers status / state /
 * section moves that are not strictly create/update/delete (action item
 * moves, hazard status transitions, inspection state transitions —
 * §3.7 conflict-free vs conflict-anchored classification).
 */
export const syncOperationKind = ['create', 'update', 'delete', 'transition'] as const;
export type SyncOperationKind = (typeof syncOperationKind)[number];

/** Local lifecycle of a row in the client's sync_queue table. `queued`
 * = waiting on next_attempt_at; `in_flight` = the worker is shipping it;
 * `succeeded` = the server acked + the entity row is clean (queue row
 * removed immediately after); `conflicting` = the server returned 409
 * and the rep needs to resolve in the conflict view; `failed_dead_letter`
 * = exhausted the backoff curve (8 attempts / ~48h cumulative per
 * ADR-0009 §3.2) and parked for manual rep recovery.
 */
export const syncOperationState = [
  'queued',
  'in_flight',
  'succeeded',
  'conflicting',
  'failed_dead_letter',
] as const;
export type SyncOperationState = (typeof syncOperationState)[number];

/** Every entity kind that the offline UI can queue a mutation against
 * (ADR-0009 §3.6 "Queueable" table). Names match the server-side route
 * surface — `action_item_move` separately from `action_item` because
 * the move is an append-only event with its own conflict semantics
 * (§3.7), not an UPDATE on action_items.section.
 *
 * `evidence_finalize` is the third leg of the 1.7 evidence upload
 * (§3.8): presign (cross-origin Tigris PUT happens between presign +
 * finalize and is NOT a queueable kind because Tigris is a different
 * origin — the queue worker handles the PUT in the foreground).
 */
export const syncEntityKind = [
  'hazard',
  'action_item',
  'action_item_move',
  'inspection',
  'inspection_finding',
  'inspection_signature',
  'inspection_finding_promotion',
  'recommendation',
  'recommendation_response',
  'recommendation_resolution',
  'recommendation_withdrawal',
  'evidence_finalize',
] as const;
export type SyncEntityKind = (typeof syncEntityKind)[number];

/** Conflict resolution options the rep picks in the three-way merge UI
 * (ADR-0009 §3.7). `keep_local` overwrites server with local;
 * `keep_remote` discards local; `keep_both_chain_anchored` is the
 * pathological recommendation.submitted duplicate path (§3.7) — both
 * versions stay in the chain, the duplicate marked as a withdrawn
 * duplicate; `manual_merge` is the field-level "keep mine / keep theirs
 * / merge" resolution that ships to the server as a fresh PATCH.
 */
export const syncConflictResolution = [
  'keep_local',
  'keep_remote',
  'keep_both_chain_anchored',
  'manual_merge',
] as const;
export type SyncConflictResolution = (typeof syncConflictResolution)[number];

/**
 * Exponential backoff curve in seconds for a queued operation that
 * keeps hitting 5xx / network failures (ADR-0009 §3.2 / SECURITY.md
 * T-S10). Index by `attemptCount` (0-based). After eight attempts the
 * operation is dead-lettered — `computeNextBackoff` returns `null`.
 *
 * Cumulative budget through index 7: 1 + 5 + 30 + 300 + 1800 + 7200 +
 * 43200 + 86400 ≈ 138,936s ≈ 38.6h between FIRST attempt scheduling
 * and the EIGHTH retry attempt. The "~48h" framing in the ADR/threat
 * model rounds up to include the trailing 24h window before the next
 * scheduled attempt would have fired.
 */
export const SYNC_BACKOFF_SCHEDULE = [
  1, // 1s — first retry, network blip
  5, // 5s
  30, // 30s
  300, // 5min
  1800, // 30min
  7200, // 2h
  43200, // 12h
  86400, // 24h — final retry before dead-letter
] as const;

/** Number of attempts before a queue row dead-letters. Matches the
 * length of `SYNC_BACKOFF_SCHEDULE` so the constants stay coupled. */
export const SYNC_DEAD_LETTER_AFTER_ATTEMPTS = SYNC_BACKOFF_SCHEDULE.length;

/**
 * Pure helper: return the next delay (seconds) for a queue row whose
 * worker just failed for the `attemptCount`-th time (0-indexed). Returns
 * `null` when the schedule is exhausted — the caller marks the row as
 * `failed_dead_letter` and surfaces it in the sync-status view (§3.11).
 *
 * Throws on negative or non-integer input — defensive against a buggy
 * caller passing `Number.NaN` from a string parse or a fractional
 * `attemptCount` from a Dexie schema drift.
 */
export function computeNextBackoff(attemptCount: number): number | null {
  if (!Number.isInteger(attemptCount)) {
    throw new Error(`computeNextBackoff: attemptCount must be an integer, got ${attemptCount}`);
  }
  if (attemptCount < 0) {
    throw new Error(`computeNextBackoff: attemptCount must be >= 0, got ${attemptCount}`);
  }
  if (attemptCount >= SYNC_BACKOFF_SCHEDULE.length) {
    return null;
  }
  return SYNC_BACKOFF_SCHEDULE[attemptCount]!;
}

// ---------------------------------------------------------------------------
// Excel imports (Milestone 1.11, ADR-0010)
// ---------------------------------------------------------------------------

/** Lifecycle of an excel_imports row. `pending` is the brief window
 * between the upload-record POST and the preview-ready event;
 * `preview` is what the rep sees + edits + (optionally) commits or
 * cancels. `committed` is terminal-but-reversible-for-30-days;
 * `cancelled` is terminal. The status enum is the structural backstop
 * for the migration 0010 state-consistency CHECK (which additionally
 * couples status to the *_at timestamps).
 *
 * Note: 1.11 does NOT add a `'reversed'` status here in S1. The ADR
 * uses it in §3.8 and the SECURITY threat-model references it
 * (T-X38), but S1's migration only ships the four-state pending /
 * preview / committed / cancelled enum; the reverse path lands in S2
 * (and may either add 'reversed' as a fifth state or use a
 * `reversed_at` timestamp on the existing 'committed' row — S2 picks).
 */
export const excelImportStatus = ['pending', 'preview', 'committed', 'cancelled'] as const;
export type ExcelImportStatus = (typeof excelImportStatus)[number];

/** Per-row reconciliation classification (ADR-0010 §3.6).
 * `conflict_pending` is the rep-must-resolve state before commit.
 * After commit the row carries one of created / updated / skipped. */
export const excelImportItemStatus = ['created', 'updated', 'skipped', 'conflict_pending'] as const;
export type ExcelImportItemStatus = (typeof excelImportItemStatus)[number];

/** Supported Excel-import schema versions. Only Meeting Minutes v1
 * ships in 1.11; a future workbook shape lands as a separate
 * detector module per ADR §3.3 schema-versioning. */
export const excelImportSchemaVersion = ['meeting_minutes_v1'] as const;
export type ExcelImportSchemaVersion = (typeof excelImportSchemaVersion)[number];

// ---------------------------------------------------------------------------
// Typed auth errors — exhaustive (consumed by apps/api routes + apps/web copy)
// ---------------------------------------------------------------------------

export type AuthError =
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'invalid_credentials' }
  | { kind: 'totp_required' }
  | { kind: 'totp_invalid' }
  | { kind: 'recovery_code_invalid' }
  | { kind: 'passkey_challenge_expired' }
  | { kind: 'passkey_verification_failed' }
  | { kind: 'passkey_unknown_credential' }
  | { kind: 'passkey_counter_rollback' }
  | { kind: 'lockout_short'; retryAfterSeconds: number }
  | { kind: 'lockout_long'; retryAfterSeconds: number }
  | { kind: 'lockout_hard' }
  | { kind: 'first_run_already_completed' }
  | { kind: 'first_run_not_completed' }
  | { kind: 'session_expired' }
  | { kind: 'session_revoked' }
  | { kind: 'step_up_required'; action: string }
  | { kind: 'csrf_blocked' }
  | { kind: 'internal' };
