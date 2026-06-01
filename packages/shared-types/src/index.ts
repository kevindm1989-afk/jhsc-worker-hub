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
  | 'inspection.signed'
  | 'inspection.exported'
  | 'audit.inspection_template.seeded'
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
      readonly kind: 'audit.inspection_template.seeded';
      readonly templateCode: InspectionTemplateCode;
      readonly templateVersionId: string;
      readonly version: number;
      readonly statusVocab: InspectionStatusVocabKind;
      readonly sectionCount: number;
      readonly structureSha256: string;
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
