// Dexie schema for offline-first sync (Milestone 1.10 S2, ADR-0009 §3.1).
//
// One Dexie database, thirteen tables. Every mutable entity row carries
// six synthetic `_sync_` columns so the queue worker (queue-worker.ts)
// and the conflict resolution UI (S3) can reason uniformly about local
// vs server state. The schema-version constant is exported for tests;
// future migrations append a `.version(N).upgrade()` block (Dexie idiom
// — append-only forward migrations matching the server-side migrations
// posture from CLAUDE.md "migrations are append-only").
//
// On-disk encryption posture (per ADR §3.1, SECURITY.md §2.10 T-S1..T-S3,
// priv-F1 close-out — S5 fix bundle, deferred to 1.12 per user
// authorization).
//
// IndexedDB is NOT encrypted at rest on the device. The rep's phone may
// be lost, stolen, or seized; the bytes on disk are recoverable by
// anyone with physical access and a forensic tool. The Dexie store
// CURRENTLY carries:
//
//   - Plaintext rep-typed PI for offline-draft / pending-sync rows
//     (description, body, observation, corrective_action, responsible_
//     party, signature_note, reporter_identity, recommendation title /
//     body). The original 1.10 plan was to envelope-encrypt these
//     fields under the workplace public key at write time on the
//     client, mirroring the server-side ciphertext shape; that plan
//     would have required refactoring every prior milestone's wire
//     format to accept ciphertext (massive blast radius across 1.5
//     through 1.9). The S5 reviewer's priv-F1 critical finding
//     documented the gap honestly: see SECURITY.md §2.10 T-S1 + T-S2
//     mitigation text + docs/runbooks/offline-sync.md §"1.12
//     hardening backlog" for the deferral.
//   - Plaintext for non-PI metadata (status enums, timestamps, ids,
//     section keys, jurisdiction codes, zone ids, citation markers,
//     recommendation numbers, action-item types). These were never
//     encrypted in Postgres either; the local cache mirrors the
//     server's projection shape.
//   - NEVER plaintext decrypt results from reveal endpoints. Reveal
//     responses are always live-fetched from the server (require-
//     online, see service-worker.ts REQUIRE_ONLINE_PATTERNS) and the
//     plaintext lives in JS heap memory for the lifetime of the view
//     component only. The sec-F1 close-out (T-S51) closed the
//     service-worker cache hole that previously let a once-revealed
//     plaintext live in the workbox cache.
//   - NEVER step-up grants. The auth cookie is `SameSite=Strict` +
//     `HttpOnly` and never visible to JS, let alone persisted to
//     Dexie. Step-up freshness state lives only in the session
//     cookie's claims; it cannot be cached offline.
//   - `evidence_pending_uploads._local_ciphertext_b64` IS envelope-
//     encrypted under the workplace public key at capture time (1.7
//     sealed-box pattern). It is dropped from the row after the
//     three-step upload finalizes (§3.8). Evidence captures are
//     therefore SAFER on the device than rep-typed hazard / finding /
//     recommendation drafts (which are plaintext per the priv-F1
//     gap above).
//
// LOST-DEVICE INCIDENT RESPONSE (priv-F1 close-out): the rep's draft
// rows + sync_queue payloads leak plaintext on a lost / stolen /
// seized phone. Revoke-the-session is the immediate mitigation
// (docs/runbooks/offline-sync.md §11 "Lost or stolen device" covers
// the procedure). The 1.12 hardening backlog includes the structural
// fix: WebAuthn PRF or session-derived Dexie at-rest encryption that
// transparently wraps the entire database without changing wire
// formats. Until then the rep treats the device as carrying
// sensitive data.
//
// Schema-version bumps follow the Dexie idiom:
//
//   db.version(2).stores({
//     // ...new shape...
//   }).upgrade(async (tx) => {
//     // copy/transform rows from v1 -> v2
//   });
//
// The `.version(N)` chain MUST stay strictly increasing; never edit a
// prior `.version(N)` block (Dexie writes the version into the database
// file and refuses to open older shapes).
//
// REMOVED IN S5 FIX BUNDLE (per priv-F1 close-out + the unmerged
// branch posture — no production device has ever opened a v1 with
// these tables): the workplace_keys_cache and
// workplace_signing_keys_cache tables were declared in the original
// S2 schema but never populated by any code path. They were reserved
// for the at-rest envelope-encrypted Dexie cache that priv-F1
// describes as deferred to 1.12. Keeping empty tables in the schema
// was misleading dead code that the next reviewer would have to
// re-litigate; the next bump (when the 1.12 hardening lands) will
// re-introduce them with the actual population path.

import Dexie, { type Table } from 'dexie';
import type { SyncEntityKind, SyncOperationKind, SyncOperationState } from '@jhsc/shared-types';

/** Bump-incrementing version constant; consumed by db.test.ts to assert
 * the schema opens cleanly at the expected version.
 *
 * Version 2 (Milestone 2.1, ADR-0012 §3.11 S3) — adds seven meeting-
 * lifecycle tables (meetings, meeting_sections, meeting_attendance,
 * meeting_inspection_review, meeting_action_item_state,
 * meeting_signatures, meeting_templates). The upgrade transformer
 * from v1 → v2 is a no-op (no prior data; the seven tables are
 * created empty). */
export const DEXIE_SCHEMA_VERSION = 2 as const;

/** Singleton Dexie database name. The same string lives in the service
 * worker (service-worker.ts) so it can postMessage the foreground when a
 * queued operation needs to land. */
export const DEXIE_DB_NAME = 'jhsc-offline-sync';

// ---------------------------------------------------------------------------
// Shared _sync_ column shape
// ---------------------------------------------------------------------------

/**
 * Every mutable-entity row carries this shape under its `_sync_*` keys.
 * The fields are runtime-typed strings (Dexie stores values as-is); the
 * compile-time types are the shared-types enums so call sites don't have
 * to repeat the union.
 */
export interface SyncRowMetadata {
  /** Local lifecycle marker. `clean` = matches server; `dirty_*` = pending
   * op in `sync_queue`; `conflicting` = a 409 from the server is awaiting
   * rep resolution in `sync_conflicts`. */
  readonly _sync_state: 'clean' | 'dirty_create' | 'dirty_update' | 'dirty_delete' | 'conflicting';
  /** UUID v4 generated client-side at create time (ClientId). Used as the
   * primary key in Dexie AND as the URL slug. On successful sync the
   * server confirms the id is canonical (per ADR §3.3) — the value never
   * changes. */
  readonly _local_id: string;
  /** Server-side `version` integer at last successful sync (the S1
   * migration-0009 column). Sent as the `If-Match: "<integer>"` header on
   * every PATCH; mismatch returns 409 conflict (§3.7). 0 until the first
   * server response confirms the row. */
  readonly _server_version: number;
  /** Canonical-JSON snapshot of the server's last-known full row. Used by
   * the three-way merge UI in conflict resolution (§3.7). Empty string
   * until first successful sync. */
  readonly _base_state_json: string;
  /** ISO timestamp of the last local mutation. The rep's device clock —
   * NOT canonical; the chain anchor uses server `now()` at drain time
   * (ADR §"Negative" — chain-anchor latency disclosure). */
  readonly _updated_at_client: string;
  /** ISO timestamp of the last successful sync. null until first server
   * ack. */
  readonly _synced_at: string | null;
}

// ---------------------------------------------------------------------------
// Entity row shapes
// ---------------------------------------------------------------------------
//
// These shapes are deliberately small — every domain-specific field
// projection lives in the per-domain typed-client (api.ts files). Dexie
// stores the rows as JSON-ish records; the typed-client wrapper
// (syncify) hydrates them on read and applies optimistic mutations on
// write.
//
// `id: string` mirrors the server's primary key. After the S1 clientId
// ratchet, id === _local_id end-to-end (the URL slug never swaps).

/** Base shape every mutable entity table extends. */
export interface BaseEntityRow extends SyncRowMetadata {
  readonly id: string;
}

/** Hazards (1.5) — mirrors the server's list projection shape, plus the
 * envelope-encrypted body fields (kept opaque in Dexie). */
export interface HazardRow extends BaseEntityRow {
  readonly hazardCode: string | null;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly jurisdiction: string;
  readonly locationZone: string | null;
  readonly reportedAt: string;
  /** Sealed-box ciphertext of the description (base64) for offline create
   * queueing. Null on read-only mirrors of server rows (server never
   * sends ciphertext back; the read projection returns
   * `summary` instead). */
  readonly description_ct_b64: string | null;
  readonly description_dek_ct_b64: string | null;
}

/** Action items (1.6). */
export interface ActionItemRow extends BaseEntityRow {
  readonly sequenceNumber: number | null;
  readonly type: string;
  readonly status: string;
  readonly risk: string;
  readonly section: string;
  readonly meetingId: string | null;
  readonly sourceType: string | null;
  readonly startDate: string;
  readonly targetDate: string | null;
  readonly closedDate: string | null;
}

/** Action-item moves (append-only history; no version column / no
 * conflict path). */
export interface ActionItemMoveRow extends BaseEntityRow {
  readonly actionItemId: string;
  readonly fromSection: string | null;
  readonly toSection: string;
  readonly movedAt: string;
}

/** Inspections (1.8). */
export interface InspectionRow extends BaseEntityRow {
  readonly templateVersionId: string;
  readonly templateCode: string;
  readonly zoneId: string;
  readonly state: string;
  readonly scheduledFor: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly conductedByUserId: string;
  readonly createdAt: string;
}

/** Inspection templates — read-only cache (§3.1; no `_sync_state`).
 *
 * Note: read-only caches do NOT carry the `_sync_` metadata; they mirror
 * the server's canonical id and refresh on each successful sync. We type
 * them as a separate shape so the typed-client wrapper doesn't try to
 * generate optimistic mutations against them. */
export interface InspectionTemplateRow {
  readonly id: string;
  readonly templateCode: string;
  readonly versionNumber: number;
  readonly displayName: string;
  readonly statusVocab: string;
  readonly cadence: string;
  readonly requiresThreeSignatures: boolean;
  readonly sections: ReadonlyArray<unknown>;
  readonly cachedAt: string;
}

/** Inspection findings (append-only by `(inspection_id, item_number)` —
 * but the substantive fields are PATCHable in the `in_progress` state, so
 * the row carries `_sync_` metadata). */
export interface InspectionFindingRow extends BaseEntityRow {
  readonly inspectionId: string;
  readonly sectionKey: string;
  readonly itemKey: string;
  readonly statusVocab: string;
  readonly statusValue: string;
  readonly hasObservation: boolean;
  readonly hasCorrectiveAction: boolean;
  readonly hasResponsibleParty: boolean;
  readonly promotedActionItemId: string | null;
  readonly createdAt: string;
}

/** Inspection signatures (append-only via `(inspection_id, role)`
 * UNIQUE). Append-only entities still need a `_sync_state` because the
 * create-side may queue. */
export interface InspectionSignatureRow extends BaseEntityRow {
  readonly inspectionId: string;
  readonly role: string;
  readonly signedByUserId: string;
  readonly signedAt: string;
}

/** Recommendations (1.9). */
export interface RecommendationRow extends BaseEntityRow {
  readonly recommendationNumber: number | null;
  readonly jurisdiction: string;
  readonly status: string;
  readonly draftedByUserId: string;
  readonly draftedAt: string;
  readonly submittedAt: string | null;
  readonly deadline: string | null;
  readonly hasTitle: boolean;
  readonly hasBody: boolean;
  readonly citationCount: number;
}

/** Recommendation citations (append-only by composite key; no own
 * conflict path). */
export interface RecommendationCitationRow extends BaseEntityRow {
  readonly recommendationId: string;
  readonly statuteCode: string;
  readonly clauseId: string;
  readonly versionDate: string;
  readonly position: number;
}

/** Recommendation responses (append-only by position). */
export interface RecommendationResponseRow extends BaseEntityRow {
  readonly recommendationId: string;
  readonly position: number;
  readonly receivedAt: string;
  readonly receivedByUserId: string;
  readonly hasAuthorRole: boolean;
  readonly hasBody: boolean;
}

/** Recommendation ↔ action-item link rows. */
export interface RecommendationActionItemLinkRow extends BaseEntityRow {
  readonly recommendationId: string;
  readonly actionItemId: string;
  readonly linkKind: string;
}

/** Evidence file metadata (the sealed ciphertext + sealed DEK live on
 * Tigris; only the metadata is in Dexie). */
export interface EvidenceFileRow extends BaseEntityRow {
  readonly linkedType: string;
  readonly linkedId: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly plaintextSha256: string;
  readonly uploadedAt: string;
  readonly uploadedByUserId: string;
}

/** Evidence pending-upload state (the three-step upload from ADR §3.8;
 * separate table so the metadata in `evidence_files` stays small and the
 * pending-upload state can be cleared after step (c) without rewriting
 * the metadata row). */
export interface EvidencePendingUploadRow {
  readonly id: string;
  /** Envelope-encrypted ciphertext of the file bytes, base64. Sealed
   * under the workplace public key at capture time (1.7 sealed-box). Kept
   * in Dexie until the three-step upload finalizes; then deleted. */
  readonly _local_ciphertext_b64: string;
  /** Three-step upload state: 0 = need presign, 1 = need PUT, 2 = need
   * finalize. */
  readonly step: 0 | 1 | 2;
  /** Server-issued presigned PUT URL (step 1+). Expires in 5 minutes
   * (Tigris contract); the queue worker re-requests on expiry. */
  readonly presignUrl: string | null;
  readonly storageKey: string | null;
  readonly sealedDekB64: string | null;
  readonly ciphertextSha256: string;
  readonly plaintextSha256: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly capturedAt: string | null;
  readonly gpsLatitude: number | null;
  readonly gpsLongitude: number | null;
  readonly gpsAccuracyM: number | null;
  readonly linkedType: string;
  readonly linkedId: string;
  readonly createdAt: string;
}

/** Legal clauses (read-only cache, §3.1; no `_sync_state`).
 * 10s of clauses for OHSA + CLC Part II, ~50–100KB compressed — small
 * enough to ship in IndexedDB so offline citation insertion works. */
export interface LegalClauseRow {
  readonly id: string;
  readonly statuteCode: string;
  readonly clauseId: string;
  readonly versionDate: string;
  readonly citation: string;
  readonly summary: string;
  readonly jurisdiction: string;
  readonly cachedAt: string;
}

// REMOVED in S5 fix bundle (priv-F1 close-out, T-S1 update):
// WorkplaceKeyCacheRow + WorkplaceSigningKeyCacheRow were declared
// here but never populated. They were reserved for the 1.12 at-rest
// Dexie envelope-encryption design. Removing the dead types prevents
// the next reviewer from reading them as evidence that client-side
// sealing is wired (it isn't — see the file header).

// ---------------------------------------------------------------------------
// Meeting-lifecycle row shapes (Milestone 2.1, ADR-0012 §3.11 S3)
// ---------------------------------------------------------------------------
//
// Seven new tables mirror the server-side 0011 migration. The mutable
// rows carry `_sync_` metadata so the queue worker reasons about them
// uniformly with hazards / action items / etc. The encrypted columns
// (notesEnvelopeCt, displayNameCt, signerDisplayNameCt, evidence
// envelope, chain-of-custody note, attestation signature) are kept
// opaque — the row stores base64 strings that the rep's browser
// produced by sealing under the workplace public key. The on-disk
// plaintext exposure note in the file header applies: per priv-F1
// close-out, browser drafts that contain sensitive PI (the rep's
// pre-sync attendance / signer name typed into the form) are
// plaintext UNTIL the seal completes; the optimistic Dexie write
// stores the SEALED b64 — the typed input string never lands in
// Dexie.

/** Meetings (2.1). */
export interface MeetingRow extends BaseEntityRow {
  readonly meetingDate: string;
  readonly location: string | null;
  readonly status: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly actualStartAt: string | null;
  readonly actualEndAt: string | null;
  readonly agendaTemplateVersion: number;
  readonly currentSectionId: string | null;
  readonly createdByActorId: string;
}

/** Meeting sections (2.1) — one row per template-instantiated section. */
export interface MeetingSectionRow extends BaseEntityRow {
  readonly meetingId: string;
  readonly sectionType: string;
  readonly visibility: string;
  readonly orderIdx: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Base64 sealed envelope (workplace public key). null when no notes
   * have been captured yet. */
  readonly notesEnvelopeCt: string | null;
  readonly notesEnvelopeDekCt: string | null;
}

/** Meeting attendance (2.1) — one row per attendee per meeting. */
export interface MeetingAttendanceRow extends BaseEntityRow {
  readonly meetingId: string;
  readonly role: string;
  readonly party: string;
  readonly presentStatus: string;
  /** Base64 sealed envelope — mandatory (every attendee is named). */
  readonly displayNameCt: string;
  readonly displayNameDekCt: string;
  readonly attendeeUserId: string | null;
  readonly arrivedAt: string | null;
  readonly departedAt: string | null;
}

/** Meeting inspection review (2.1) — link rows between a meeting and an
 * inspection it considered. */
export interface MeetingInspectionReviewRow extends BaseEntityRow {
  readonly meetingId: string;
  readonly inspectionId: string;
  readonly outcome: string;
  readonly notesEnvelopeCt: string | null;
  readonly notesEnvelopeDekCt: string | null;
}

/** Meeting signatures (2.1) — append-only counter-sign rows. */
export interface MeetingSignatureRow extends BaseEntityRow {
  readonly meetingId: string;
  readonly signerRole: string;
  readonly signedMethod: string;
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

/** Meeting action item state snapshots (2.1) — read-only mirror of the
 * server table; the client does not enqueue snapshot writes (the
 * server emits them inside the action_items PATCH and meeting.adjourn
 * transactions per ADR §3.8). Kept here so the live meeting view can
 * render the "items raised this meeting" counter offline. */
export interface MeetingActionItemStateRow {
  readonly id: string;
  readonly meetingId: string;
  readonly actionItemId: string;
  readonly snapshotKind: string;
  readonly snapshotStatus: string;
  readonly snapshotSection: string;
  readonly snapshotAt: string;
  readonly cachedAt: string;
}

/** Meeting templates (2.1) — read-only cache (no `_sync_`). */
export interface MeetingTemplateRow {
  readonly id: string;
  readonly templateCode: string;
  readonly versionNumber: number;
  readonly jurisdiction: string;
  readonly defaultTotalMinutes: number;
  readonly sections: ReadonlyArray<unknown>;
  readonly cachedAt: string;
}

/** A row in the sync queue — the in-flight work the queue worker drains
 * (ADR §3.2). */
export interface SyncQueueRow {
  readonly id?: number;
  readonly kind: SyncOperationKind;
  readonly entityKind: SyncEntityKind;
  /** The entity's `_local_id` (uuid v4) — the queue's pointer back into
   * the entity table for the optimistic row. */
  readonly entityLocalId: string;
  /** Serialized JSON body the typed-client would have sent. The queue
   * worker ships this verbatim with the typed-client's headers
   * (X-Requested-With + Idempotency-Key + If-Match). */
  readonly payload: string;
  /** HTTP method + path-template — `POST /api/hazards`, `PATCH
   * /api/recommendations/:id`, etc. — for the queue worker to route. */
  readonly httpMethod: string;
  readonly endpoint: string;
  /** `If-Match` etag captured at enqueue time. Optional — POST creates
   * don't have one. */
  readonly ifMatchEtag: number | null;
  /** Per-request Idempotency-Key (a fresh UUID v4 per enqueue; the
   * server's middleware dedupes on (actor, action_kind, entity_local_id,
   * payload_hash) so the key itself is opaque). */
  readonly idempotencyKey: string;
  /** Attempts so far. Indexes into `SYNC_BACKOFF_SCHEDULE`. */
  readonly attemptCount: number;
  /** ISO timestamp — the worker pulls rows where this is in the past. */
  readonly nextAttemptAt: string;
  /** Local lifecycle. */
  readonly state: SyncOperationState | 'paused';
  /** Last error message from the server / network, for the dead-letter
   * surface (S3). */
  readonly lastError: string | null;
  /** ISO timestamp the row was enqueued. Used as the secondary sort key
   * so siblings drain in type-order. */
  readonly createdAt: string;
  /** If this op depends on another queued op, the parent's id. The FK
   * dependency helper (queue-worker.enqueueOp) sets this and pauses the
   * child until the parent's `_sync_state` is clean. */
  readonly dependsOnQueueId: number | null;
  /** Reason text when state === 'paused' (e.g. `parent_conflict`). */
  readonly pauseReason: string | null;
}

/** A row in the conflicts table — surfaced to the rep for resolution in
 * the three-way merge UI (ADR §3.7, S3 owns the UI). */
export interface SyncConflictRow {
  readonly id?: number;
  readonly entityKind: SyncEntityKind;
  readonly entityLocalId: string;
  /** Encrypted local payload (sealed for the server's eyes — the local
   * row was already ciphertext for sensitive fields). Stored as JSON
   * string for portability. */
  readonly localStateJson: string;
  /** Server's canonical row at conflict time (the body of the 409
   * response). */
  readonly serverStateJson: string;
  /** Base state — what we believed the server's row was when we started
   * editing. The three-way merge UI diffs local-vs-base and server-vs-
   * base to surface only the actually-changed fields. */
  readonly baseStateJson: string;
  /** Server-reported current version (the post-conflict server version
   * the rep's resolution PATCH must If-Match against). */
  readonly serverVersion: number;
  readonly detectedAt: string;
  readonly resolved: 0 | 1;
}

/** Last-known-server-state cache, keyed by `${entityKind}:${entityLocalId}`.
 * Separate table so the conflict path can read base state without joining
 * (and so multiple entity kinds can share one shape). */
export interface BaseStateCacheRow {
  readonly key: string;
  readonly entityKind: SyncEntityKind;
  readonly entityLocalId: string;
  readonly version: number;
  readonly stateJson: string;
  readonly cachedAt: string;
}

// ---------------------------------------------------------------------------
// Dexie class
// ---------------------------------------------------------------------------

/**
 * The Dexie database singleton. Don't import this directly from view
 * code — use the typed-client wrapper (`syncify` in typed-client.ts) so
 * the optimistic-read / optimistic-write contract is preserved.
 */
export class JhscOfflineDb extends Dexie {
  // Mutable entity tables.
  hazards!: Table<HazardRow, string>;
  action_items!: Table<ActionItemRow, string>;
  action_item_moves!: Table<ActionItemMoveRow, string>;
  inspections!: Table<InspectionRow, string>;
  inspection_findings!: Table<InspectionFindingRow, string>;
  inspection_signatures!: Table<InspectionSignatureRow, string>;
  recommendations!: Table<RecommendationRow, string>;
  recommendation_citations!: Table<RecommendationCitationRow, string>;
  recommendation_responses!: Table<RecommendationResponseRow, string>;
  recommendation_action_item_links!: Table<RecommendationActionItemLinkRow, string>;
  evidence_files!: Table<EvidenceFileRow, string>;
  // Three-step upload state.
  evidence_pending_uploads!: Table<EvidencePendingUploadRow, string>;
  // Meeting lifecycle tables (Milestone 2.1, ADR-0012 §3.11 S3).
  meetings!: Table<MeetingRow, string>;
  meeting_sections!: Table<MeetingSectionRow, string>;
  meeting_attendance!: Table<MeetingAttendanceRow, string>;
  meeting_inspection_review!: Table<MeetingInspectionReviewRow, string>;
  meeting_signatures!: Table<MeetingSignatureRow, string>;
  meeting_action_item_state!: Table<MeetingActionItemStateRow, string>;
  meeting_templates!: Table<MeetingTemplateRow, string>;
  // Read-only caches.
  inspection_templates!: Table<InspectionTemplateRow, string>;
  legal_clauses!: Table<LegalClauseRow, string>;
  // priv-F1 close-out: workplace_keys_cache + workplace_signing_keys_
  // cache removed (declared but never populated; misleading dead
  // code). Re-added in the 1.12 hardening bump when the at-rest
  // encryption design lands.
  // Plumbing.
  sync_queue!: Table<SyncQueueRow, number>;
  sync_conflicts!: Table<SyncConflictRow, number>;
  _base_state!: Table<BaseStateCacheRow, string>;

  constructor(name: string = DEXIE_DB_NAME) {
    super(name);

    // Schema version 1 (initial). Future bumps append .version(N) blocks
    // — never edit a prior one.
    //
    // Index strings:
    //   - The first token is the primary key (`localId`, `id`, `key`,
    //     or `++id` for auto-incrementing).
    //   - Subsequent tokens are secondary indexes. `&col` is a unique
    //     index; `[col1+col2]` is a compound index.
    //
    // Per-table indexes are chosen for the views' actual read patterns
    // (ADR §3.1):
    //   - `_sync_state` on every mutable table — the sync-status chip
    //     counts non-clean rows across all tables in one walk (S3).
    //   - Foreign-key columns where the views filter (inspection_id on
    //     findings, recommendation_id on citations + responses, etc.).
    //   - `nextAttemptAt` on sync_queue — the queue worker hot path
    //     (where('nextAttemptAt').belowOrEqual(now()).first()).
    // Schema version 1 (initial). Kept verbatim per the Dexie rule —
    // never edit a prior .version(N) block; append .version(N+1)
    // forward migrations.
    this.version(1).stores({
      // Hazards: PK is id (== _local_id); indexes for the list view
      // filters + the sync-status chip.
      hazards: 'id, _sync_state, status, severity, jurisdiction, reportedAt',
      // Action items: indexes for the minutes board filters (section,
      // status, meeting_id) + the source-type provenance filter.
      action_items: 'id, _sync_state, section, status, risk, meetingId, sourceType, startDate',
      // Action item moves: append-only, keyed by id; secondary index on
      // actionItemId for the history list.
      action_item_moves: 'id, _sync_state, actionItemId, movedAt',
      // Inspections: by state + zone for the list view.
      inspections: 'id, _sync_state, state, zoneId, templateCode, createdAt',
      // Read-only template cache: by code + version.
      inspection_templates: 'id, templateCode, versionNumber',
      // Findings: by inspection_id for the detail view; by status_value
      // for the promotability filter.
      inspection_findings:
        'id, _sync_state, inspectionId, sectionKey, statusVocab, statusValue, createdAt',
      // Signatures: by inspection_id + role.
      inspection_signatures: 'id, _sync_state, inspectionId, role, signedAt',
      // Recommendations: by status + jurisdiction for the list view +
      // deadline filter.
      recommendations:
        'id, _sync_state, status, jurisdiction, recommendationNumber, draftedAt, submittedAt',
      // Citations: by recommendation_id + position.
      recommendation_citations: 'id, _sync_state, recommendationId, statuteCode, position',
      // Responses: by recommendation_id + position.
      recommendation_responses: 'id, _sync_state, recommendationId, position, receivedAt',
      // Links: by recommendation_id and action_item_id (both useful for
      // the bridge UI).
      recommendation_action_item_links: 'id, _sync_state, recommendationId, actionItemId, linkKind',
      // Evidence metadata: by linked_type + linked_id (the gallery
      // filter) + uploaded_at for sort.
      evidence_files: 'id, _sync_state, linkedType, linkedId, uploadedAt, mimeType',
      // Pending uploads: by id only; the worker iterates the table
      // serially.
      evidence_pending_uploads: 'id, step, linkedType, linkedId, createdAt',
      // Read-only legal corpus cache (small enough to scan; an index on
      // statute_code + clause_id is the primary picker shape).
      legal_clauses: 'id, statuteCode, clauseId, jurisdiction',
      // priv-F1 close-out: workplace_keys_cache +
      // workplace_signing_keys_cache table declarations removed (see
      // file header). 1.12 hardening re-introduces them with an actual
      // populate path.
      // Sync queue: PK ++id; the hot-path index is nextAttemptAt for the
      // worker's "what's ready to drain?" query.
      sync_queue:
        '++id, state, nextAttemptAt, kind, entityKind, entityLocalId, createdAt, dependsOnQueueId',
      // Sync conflicts: PK ++id; lookups by entity + state for the
      // sync-status chip's amber state.
      sync_conflicts: '++id, entityKind, entityLocalId, detectedAt, resolved',
      // Last-known-server-state cache; PK is a composite `key`
      // (`${entityKind}:${entityLocalId}`).
      _base_state: 'key, entityKind, entityLocalId, cachedAt',
    });

    // Schema version 2 (Milestone 2.1, ADR-0012 §3.11 S3) — adds the
    // seven meeting-lifecycle tables. Forward-only; the upgrade
    // transformer is a no-op because v1 carried no meeting data.
    //
    // Index choices:
    //   - meetings: meetingDate desc + status for the list view's
    //     filter chips; _sync_state for the queue worker.
    //   - meeting_sections: meetingId + orderIdx for the live view's
    //     accordion render; meetingId for the bulk read.
    //   - meeting_attendance: meetingId for the live quorum compute;
    //     [meetingId+role] for the co-chair signer lookup at
    //     finalization.
    //   - meeting_inspection_review: meetingId + inspectionId for the
    //     duplicate-review surface.
    //   - meeting_signatures: meetingId + signerRole for the 4-signer
    //     gate count at finalization.
    //   - meeting_action_item_state: meetingId for the live snapshot
    //     count; [meetingId+snapshotKind] for the finalized vs live
    //     filter.
    //   - meeting_templates: read-only cache by templateCode +
    //     versionNumber (look up "latest active v1" cheaply).
    this.version(2).stores({
      meetings: 'id, _sync_state, status, meetingDate, scheduledStartAt, currentSectionId',
      meeting_sections: 'id, _sync_state, meetingId, sectionType, orderIdx, [meetingId+orderIdx]',
      meeting_attendance:
        'id, _sync_state, meetingId, role, party, presentStatus, [meetingId+role]',
      meeting_inspection_review:
        'id, _sync_state, meetingId, inspectionId, outcome, [meetingId+inspectionId]',
      meeting_signatures:
        'id, _sync_state, meetingId, signerRole, signedMethod, [meetingId+signerRole]',
      meeting_action_item_state:
        'id, meetingId, actionItemId, snapshotKind, [meetingId+snapshotKind], snapshotAt',
      meeting_templates: 'id, templateCode, versionNumber, [templateCode+versionNumber]',
    });
  }
}

/**
 * Singleton instance. The first import opens the database; subsequent
 * imports return the same instance. The queue worker, the typed-client
 * wrapper, and the service worker's foreground-bridge all use this same
 * handle.
 *
 * The instance is lazy: we don't open the DB in tests that don't need it
 * (tests that DO need it import `db` directly + use fake-indexeddb).
 */
export const db: JhscOfflineDb = new JhscOfflineDb();

// ---------------------------------------------------------------------------
// Helpers used by the typed-client wrapper + queue worker
// ---------------------------------------------------------------------------

/** ISO timestamp helper — wraps `new Date().toISOString()` so the queue
 * worker can stub time in tests. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Compute the composite key for the `_base_state` table. */
export function baseStateKey(entityKind: SyncEntityKind, entityLocalId: string): string {
  return `${entityKind}:${entityLocalId}`;
}

/** Build the default `SyncRowMetadata` for a freshly-created local row. */
export function freshSyncMetadata(localId: string): SyncRowMetadata {
  return {
    _sync_state: 'dirty_create',
    _local_id: localId,
    _server_version: 0,
    _base_state_json: '',
    _updated_at_client: nowIso(),
    _synced_at: null,
  };
}

/** Build the `SyncRowMetadata` for a row reconciled from the server (the
 * background-refresh path in the typed-client wrapper). */
export function cleanSyncMetadata(
  localId: string,
  serverVersion: number,
  baseStateJson: string,
): SyncRowMetadata {
  const t = nowIso();
  return {
    _sync_state: 'clean',
    _local_id: localId,
    _server_version: serverVersion,
    _base_state_json: baseStateJson,
    _updated_at_client: t,
    _synced_at: t,
  };
}

/**
 * sec-F9 close-out (T-S56): drop the per-session tables on logout so a
 * subsequent rep signing in on the same device doesn't inherit the
 * prior session's queue, conflicts, base-state cache, or background-
 * refreshed caches.
 *
 * Tables cleared:
 *   - sync_queue: rep's queued ops are bound to their actor identity
 *     server-side (Idempotency-Key is keyed on actor_user_id +
 *     payload_hash). A queued op shipped under a different rep's
 *     auth cookie would either 404 (different actor) or land in the
 *     other rep's chain — neither is the right shape.
 *   - sync_conflicts: conflict rows reference local-vs-server state
 *     that's only meaningful within the original session.
 *   - _base_state: cached server-state snapshots indexed by entity
 *     local id; safe to drop and re-fetch on next login.
 *   - legal_clauses: the corpus snapshot may have changed between
 *     sessions; refresh-on-next-online is the right shape (1.4
 *     T-LC3).
 *   - inspection_templates: cached template snapshots; same shape.
 *
 * Tables NOT cleared:
 *   - hazards / action_items / inspections / etc.: the entity caches
 *     can be re-reconciled from the server via background-refresh on
 *     next login. Dropping them would force a full re-download on
 *     every sign-in which is hostile on metered connections. The
 *     priv-F1 plaintext-at-rest residual is the only privacy concern
 *     here and that's handled by the lost-device runbook (revoke-
 *     the-session). For the same-rep-signs-back-in case, preserving
 *     the entity caches matches the rep's mental model ("my drafts
 *     are still here").
 *   - evidence_pending_uploads: same shape — the rep wants their
 *     pre-capture uploads to survive a session bounce.
 *
 * The queue worker singleton (worker-singleton.ts) is reset
 * separately by the auth/logout handler via setWorkerForTests(null);
 * the test seam doubles as the production reset hook because the
 * shape is the same — drop the singleton, the next getWorker() call
 * builds a fresh one.
 */
export async function clearOnLogout(): Promise<void> {
  await db.transaction(
    'rw',
    [db.sync_queue, db.sync_conflicts, db._base_state, db.legal_clauses, db.inspection_templates],
    async () => {
      await db.sync_queue.clear();
      await db.sync_conflicts.clear();
      await db._base_state.clear();
      await db.legal_clauses.clear();
      await db.inspection_templates.clear();
    },
  );
}
