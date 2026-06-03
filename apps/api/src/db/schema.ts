// Drizzle schema root.
//
// Milestone 1.2 (this file) lands the auth surface per ADR-0001:
// users, user_profiles, credential tables (password / passkey / TOTP /
// recovery), sessions, login_attempts, setup_state, auth_events,
// webauthn_challenges.
//
// Hazards/action items/etc. land starting in Milestone 1.5.
//
// Hand-rolled migration in `migrations/0001_auth.sql` mirrors this file.
// When `drizzle-kit generate` is wired up to a live DB, it should produce
// an identical (or empty) diff.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Drizzle 0.45 does not export a `bytea` helper from pg-core; declare
// our own once and reuse. `Uint8Array` is the runtime shape.
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const loginAttemptOutcome = pgEnum('login_attempt_outcome', ['success', 'failure']);

export const authEventKind = pgEnum('auth_event_kind', [
  'signup',
  'login.passkey',
  'login.password',
  'login.totp',
  'login.recovery',
  'login.failed',
  'logout',
  'session.refreshed',
  'session.revoked',
  'step_up.granted',
  'step_up.denied',
  'lockout.applied',
  'lockout.cleared',
  'passkey.registered',
  'passkey.removed',
  'totp.enrolled',
  'totp.reset',
  'recovery_codes.generated',
  'recovery_codes.consumed',
  'first_run.completed',
]);

export const webauthnPurpose = pgEnum('webauthn_purpose', ['register', 'authenticate', 'step_up']);

// ---------------------------------------------------------------------------
// users + profile
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

// PI lives here (encrypted). Split from `users` so a query against the
// users table for "did this id exist" can't accidentally leak names.
export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Crypto stub wire format: version_byte || nonce || ciphertext (ADR-0001).
  displayNameCiphertext: bytea('display_name_ciphertext').notNull(),
  emailCiphertext: bytea('email_ciphertext').notNull(),
  // BLAKE2b(lowercased email) keyed with the per-deploy MASTER_KEY — used
  // for constant-time lookup without decrypting. Pseudonymized so a
  // leaked DB does not enable rainbow attacks on email.
  emailLookupHash: bytea('email_lookup_hash').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const passwordCredentials = pgTable('password_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // libsodium crypto_pwhash_str Argon2id encoded string. Includes algo
  // and params for future rotation; the verifier ignores params it
  // doesn't recognize and forces a re-hash on next successful login.
  hash: text('hash').notNull(),
  algoParams: jsonb('algo_params')
    .notNull()
    .default(sql`'{"algo":"argon2id","mem_kib":65536,"ops":3,"version":13}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const passkeyCredentials = pgTable(
  'passkey_credentials',
  {
    // WebAuthn credential ID, raw bytes.
    id: bytea('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: bytea('public_key').notNull(),
    // signCount per WebAuthn — monotonic. Counter rollback fails auth.
    counter: integer('counter').notNull().default(0),
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    attestationType: text('attestation_type').notNull().default('none'),
    nickname: text('nickname').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('passkey_credentials_user_idx').on(t.userId),
  }),
);

export const totpCredentials = pgTable('totp_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Encrypted secret (crypto stub wire format).
  secretCiphertext: bytea('secret_ciphertext').notNull(),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  // Highest accepted timestep, to prevent replay within the skew window.
  lastUsedStep: integer('last_used_step').notNull().default(0),
});

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // BLAKE2b(code) — never store plaintext.
    codeHash: bytea('code_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('recovery_codes_user_idx').on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Sessions (Lucia + bespoke refresh)
// ---------------------------------------------------------------------------

// Lucia v3 expects a `sessions` table with at minimum (id text PK,
// user_id, expires_at). We extend it with the refresh-rotation and
// step-up fields from ADR-0001. Lucia's adapter reads only the columns
// it knows about; the extras are ours.

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshTokenHash: bytea('refresh_token_hash').notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    // Set by step-up grant; the access JWT carries the same value as a claim.
    stepUpUntil: timestamp('step_up_until', { withTimezone: true }),
    ipAtCreate: inet('ip_at_create'),
    uaAtCreate: text('ua_at_create'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    refreshIdx: uniqueIndex('sessions_refresh_idx').on(t.refreshTokenHash),
  }),
);

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // BLAKE2b(lowercased identifier OR userId) — never store the plaintext
    // identifier (email) here; it'd be an enumeration target.
    identifierHash: bytea('identifier_hash').notNull(),
    ip: inet('ip'),
    ts: timestamp('ts', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    outcome: loginAttemptOutcome('outcome').notNull(),
  },
  (t) => ({
    identifierTsIdx: index('login_attempts_identifier_ts_idx').on(t.identifierHash, t.ts),
    ipTsIdx: index('login_attempts_ip_ts_idx').on(t.ip, t.ts),
  }),
);

// ---------------------------------------------------------------------------
// First-run singleton
// ---------------------------------------------------------------------------

export const setupState = pgTable(
  'setup_state',
  {
    // Always `1`. CHECK constraint enforces singleton.
    id: smallint('id').primaryKey(),
    firstRunCompletedAt: timestamp('first_run_completed_at', { withTimezone: true }),
    firstRunCompletedBy: uuid('first_run_completed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    singletonCheck: check('setup_state_singleton', sql`${t.id} = 1`),
  }),
);

// ---------------------------------------------------------------------------
// WebAuthn challenges (short-lived)
// ---------------------------------------------------------------------------

export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Null for discoverable-credential authentication where the user is
    // not yet known.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    challenge: bytea('challenge').notNull(),
    purpose: webauthnPurpose('purpose').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    challengeIdx: uniqueIndex('webauthn_challenges_challenge_idx').on(t.challenge),
    expiresIdx: index('webauthn_challenges_expires_idx').on(t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// Auth events (flat audit; 1.3 backfills into the chain)
// ---------------------------------------------------------------------------

export const authEvents = pgTable(
  'auth_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: timestamp('ts', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: authEventKind('kind').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    // Strict: only typed event-shape metadata. PI is forbidden here.
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => ({
    tsIdx: index('auth_events_ts_idx').on(t.ts),
    actorTsIdx: index('auth_events_actor_ts_idx').on(t.actorId, t.ts),
    kindTsIdx: index('auth_events_kind_ts_idx').on(t.kind, t.ts),
  }),
);

// ---------------------------------------------------------------------------
// Audit chain (1.3+, packages/@jhsc/audit)
// ---------------------------------------------------------------------------

// Re-export so drizzle-kit picks up `audit_log` when generating
// migrations from this file. The canonical definition lives in
// `packages/audit/src/schema.ts`.
export { auditLog } from '@jhsc/audit';
import { auditLog } from '@jhsc/audit';

// ---------------------------------------------------------------------------
// Legal corpus (1.4, packages/@jhsc/legal-corpus)
// ---------------------------------------------------------------------------

export { clauses, corpusVersions, statutes } from '@jhsc/legal-corpus';
import { clauses, corpusVersions, statutes } from '@jhsc/legal-corpus';

// ---------------------------------------------------------------------------
// Hazards (1.5, ADR-0004)
// ---------------------------------------------------------------------------

// Per-row encrypted column pairs use the @jhsc/crypto envelope: a fresh
// DEK seals the field plaintext, then the KEK seals the DEK. The DB
// stores the (ct, dek_ct) pair; the route handler decrypts on read.

export const hazards = pgTable(
  'hazards',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hazardCode: text('hazard_code').notNull(),
    title: text('title').notNull(),
    descriptionCt: bytea('description_ct').notNull(),
    descriptionDekCt: bytea('description_dek_ct').notNull(),
    reporterIdentityCt: bytea('reporter_identity_ct'),
    reporterIdentityDekCt: bytea('reporter_identity_dek_ct'),
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    locationZone: text('location_zone'),
    locationDetailCt: bytea('location_detail_ct'),
    locationDetailDekCt: bytea('location_detail_dek_ct'),
    jurisdiction: text('jurisdiction').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    assessedAt: timestamp('assessed_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Optimistic-concurrency etag (1.10, ADR-0009 §3.7). Auto-bumped
    // by the bump_version_on_update trigger in migration 0009. The
    // PATCH ratchet (S2) compares client `If-Match` against this column
    // under FOR UPDATE.
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    codeUnique: uniqueIndex('hazards_code_unique').on(t.hazardCode),
    statusIdx: index('hazards_status_idx').on(t.status),
    severityIdx: index('hazards_severity_idx').on(t.severity),
    reportedAtIdx: index('hazards_reported_at_idx').on(t.reportedAt),
    reportedByIdx: index('hazards_reported_by_idx').on(t.reportedBy),
  }),
);

export const hazardStatusHistory = pgTable(
  'hazard_status_history',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hazardId: uuid('hazard_id')
      .notNull()
      .references(() => hazards.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    reasonCt: bytea('reason_ct'),
    reasonDekCt: bytea('reason_dek_ct'),
    // auditIdx pins the chain row that anchors this transition; FK
    // enforces that we cannot record a transition without a chain entry.
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    hazardIdx: index('hazard_status_history_hazard_idx').on(t.hazardId, t.occurredAt),
    auditIdxUnique: uniqueIndex('hazard_status_history_audit_idx_unique').on(t.auditIdx),
  }),
);

// ---------------------------------------------------------------------------
// Action items (1.6, ADR-0005)
// ---------------------------------------------------------------------------

export const actionItems = pgTable(
  'action_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sequenceNumber: integer('sequence_number').notNull(),
    type: text('type').notNull(),
    typeSubtype: text('type_subtype'),
    descriptionCt: bytea('description_ct').notNull(),
    descriptionDekCt: bytea('description_dek_ct').notNull(),
    recommendedActionCt: bytea('recommended_action_ct'),
    recommendedActionDekCt: bytea('recommended_action_dek_ct'),
    raisedByCt: bytea('raised_by_ct'),
    raisedByDekCt: bytea('raised_by_dek_ct'),
    raisedByUserId: uuid('raised_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    followUpOwnerCt: bytea('follow_up_owner_ct'),
    followUpOwnerDekCt: bytea('follow_up_owner_dek_ct'),
    followUpOwnerUserId: uuid('follow_up_owner_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    department: text('department'),
    status: text('status').notNull(),
    risk: text('risk').notNull(),
    section: text('section').notNull(),
    // dates surfaced as ISO YYYY-MM-DD strings in TS so the Action Flag
    // helper (pure function) can consume them without timezone surprises.
    startDate: date('start_date', { mode: 'string' }).notNull(),
    targetDate: date('target_date', { mode: 'string' }),
    closedDate: date('closed_date', { mode: 'string' }),
    verifiedByJhscId: uuid('verified_by_jhsc_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    // 2.1 (ADR-0012 §3.2 Layer 2): operational FK. The placeholder uuid
    // from 1.6 gets its FK to meetings(id) in migration 0011. Mutable;
    // tracks the meeting currently discussing this item.
    meetingId: uuid('meeting_id'),
    // 2.1 (ADR-0012 §3.2 Layer 1): immutable provenance — the meeting
    // this item was FIRST raised in. NULL for items imported from Excel
    // or raised outside a meeting. Set at create time; never changes.
    firstRaisedMeetingId: uuid('first_raised_meeting_id'),
    // 2.2 (ADR-0013 TM-fold-1 / T-IM3 / T-IM4 / T-IM32): FK to the
    // closure-verification row. NULLABLE; the DB CHECK in migration
    // 0012 enforces (status = 'Closed') = (closure_verification_id IS
    // NOT NULL). Closing without counter-sign is structurally
    // impossible — defense in depth against route bypass.
    // FK target (actionItemClosures) is declared further down; we use
    // a plain uuid column here to avoid the circular type per the same
    // pattern as meetings.currentSectionId.
    closureVerificationId: uuid('closure_verification_id'),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    sourceExcelHash: bytea('source_excel_hash'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Optimistic-concurrency etag (1.10, ADR-0009 §3.7).
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    sectionIdx: index('action_items_section_idx').on(t.section),
    statusIdx: index('action_items_status_idx').on(t.status),
    riskIdx: index('action_items_risk_idx').on(t.risk),
    typeIdx: index('action_items_type_idx').on(t.type),
    sectionSeqIdx: index('action_items_section_seq_idx').on(t.section, t.sequenceNumber),
    sourceIdx: index('action_items_source_idx').on(t.sourceType, t.sourceId),
    meetingIdx: index('action_items_meeting_idx').on(t.meetingId),
    firstRaisedMeetingIdx: index('action_items_first_raised_meeting_idx').on(
      t.firstRaisedMeetingId,
    ),
    // 2.2 (ADR-0013 TM-fold-1): the bi-directional invariant
    // `(status = 'Closed') = (closure_verification_id IS NOT NULL)`
    // is enforced by the DB CHECK constraint in migration 0012
    // (action_items_closed_requires_verification_check). Drizzle's
    // check() helper doesn't capture the bi-directional shape
    // cleanly, so the CHECK lives in raw SQL and the schema-shape
    // intent is documented here for reviewers.
  }),
);

export const actionItemMoves = pgTable(
  'action_item_moves',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actionItemId: uuid('action_item_id')
      .notNull()
      .references(() => actionItems.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    movedByUserId: uuid('moved_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    movedAt: timestamp('moved_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    fromSection: text('from_section'),
    toSection: text('to_section').notNull(),
    reasonCt: bytea('reason_ct'),
    reasonDekCt: bytea('reason_dek_ct'),
    meetingId: uuid('meeting_id'),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    undone: boolean('undone').notNull().default(false),
  },
  (t) => ({
    itemIdx: index('action_item_moves_item_idx').on(t.actionItemId, t.movedAt),
    auditIdxUnique: uniqueIndex('action_item_moves_audit_idx_unique').on(t.auditIdx),
  }),
);

// ---------------------------------------------------------------------------
// Evidence (1.7, ADR-0006)
// ---------------------------------------------------------------------------

// Workplace X25519 key pair. Public key shipped to the browser per
// session for sealed-box encryption; private key sealed under the
// workplace KEK and opened only inside the API's evidence decrypt path.

export const workplaceKeys = pgTable(
  'workplace_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    active: boolean('active').notNull().default(true),
    publicKey: bytea('public_key').notNull(),
    privateKeyCt: bytea('private_key_ct').notNull(),
    privateKeyDekCt: bytea('private_key_dek_ct').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    activeIdx: index('workplace_keys_active_idx').on(t.active),
  }),
);

// Evidence files. Polymorphic linked_type/linked_id with allow-listed
// values; route layer further constrains to 'hazard' and 'action_item'
// in 1.7 (fail-closed forward seam). GPS precision capped at
// numeric(8,4) — ~11m, intentionally too coarse to identify a worker's
// specific station inside an industrial site.

export const evidenceFiles = pgTable(
  'evidence_files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    linkedType: text('linked_type').notNull(),
    linkedId: uuid('linked_id').notNull(),
    storageKey: text('storage_key').notNull(),
    ciphertextSha256: bytea('ciphertext_sha256').notNull(),
    sealedDek: bytea('sealed_dek').notNull(),
    workplaceKeyId: uuid('workplace_key_id')
      .notNull()
      .references(() => workplaceKeys.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    plaintextSha256: bytea('plaintext_sha256').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    gpsLatitude: numeric('gps_latitude', { precision: 8, scale: 4 }),
    gpsLongitude: numeric('gps_longitude', { precision: 8, scale: 4 }),
    gpsAccuracyM: numeric('gps_accuracy_m', { precision: 8, scale: 2 }),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    storageKeyUnique: uniqueIndex('evidence_files_storage_key_unique').on(t.storageKey),
    linkedIdx: index('evidence_files_linked_idx').on(t.linkedType, t.linkedId),
    auditIdxUnique: uniqueIndex('evidence_files_audit_idx_unique').on(t.auditIdx),
    uploadedAtIdx: index('evidence_files_uploaded_at_idx').on(t.uploadedAt),
  }),
);

// ---------------------------------------------------------------------------
// Inspections (1.8, ADR-0007)
// ---------------------------------------------------------------------------

// Append-only versioned template rows. (template_code, version_number) is
// the natural key; partial UNIQUE on (template_code) WHERE retired_at IS
// NULL keeps at most one active version per code (T-I1).

export const inspectionTemplates = pgTable(
  'inspection_templates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    templateCode: text('template_code').notNull(),
    versionNumber: integer('version_number').notNull(),
    statusVocab: text('status_vocab').notNull(),
    displayName: text('display_name').notNull(),
    cadence: text('cadence').notNull(),
    sections: jsonb('sections').notNull(),
    requiresThreeSignatures: boolean('requires_three_signatures').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
  },
  (t) => ({
    codeIdx: index('inspection_templates_code_idx').on(t.templateCode),
    codeVersionUnique: uniqueIndex('inspection_templates_code_version_unique').on(
      t.templateCode,
      t.versionNumber,
    ),
  }),
);

// Inspections pin a specific template version (non-negotiable #13).
// zone_id is text + CHECK rather than FK — config/workplace.ts is the
// runtime display layer; the literal zone_N is the stable id
// (non-negotiable #14).

export const inspections = pgTable(
  'inspections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => inspectionTemplates.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    zoneId: text('zone_id').notNull(),
    conductedByUserId: uuid('conducted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    state: text('state').notNull().default('scheduled'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // 2.1 (ADR-0012 §3.7): the meeting that requested this inspection,
    // if any. NULL for inspections scheduled outside a meeting context.
    triggeringMeetingId: uuid('triggering_meeting_id'),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    // Optimistic-concurrency etag (1.10, ADR-0009 §3.7).
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    auditIdxUnique: uniqueIndex('inspections_audit_idx_unique').on(t.auditIdx),
    stateIdx: index('inspections_state_idx').on(t.state),
    zoneIdx: index('inspections_zone_idx').on(t.zoneId),
    templateVersionIdx: index('inspections_template_version_idx').on(t.templateVersionId),
    conductedByIdx: index('inspections_conducted_by_idx').on(t.conductedByUserId),
    scheduledForIdx: index('inspections_scheduled_for_idx').on(t.scheduledFor),
    triggeringMeetingIdx: index('inspections_triggering_meeting_idx').on(t.triggeringMeetingId),
  }),
);

// Finding rows snapshot section/item from the pinned template version at
// create time so a row remains self-describing even if (hypothetically)
// the template were force-deleted. Three encrypted column pairs carry
// observation / corrective_action / responsible_party PI — each pair is
// both-NULL or both-NOT-NULL (CHECK in 0007). promoted_action_item_id is
// the bidirectional link to action_items; UNIQUE so each finding can
// promote at most once (T-I16).

export const inspectionFindings = pgTable(
  'inspection_findings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    inspectionId: uuid('inspection_id')
      .notNull()
      .references(() => inspections.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    sectionKey: text('section_key').notNull(),
    sectionLabel: text('section_label').notNull(),
    itemKey: text('item_key').notNull(),
    itemLabel: text('item_label').notNull(),
    statusVocab: text('status_vocab').notNull(),
    statusValue: text('status_value').notNull(),
    observationCt: bytea('observation_ct'),
    observationDekCt: bytea('observation_dek_ct'),
    correctiveActionCt: bytea('corrective_action_ct'),
    correctiveActionDekCt: bytea('corrective_action_dek_ct'),
    responsiblePartyCt: bytea('responsible_party_ct'),
    responsiblePartyDekCt: bytea('responsible_party_dek_ct'),
    // 1.9 (ADR-0008 §3.12, priv-F8 close-out) — dual-shape responsible
    // party. 'user_ref' → responsiblePartyUserId is set, _ct columns
    // NULL. 'name_text' → _ct columns set, responsiblePartyUserId NULL.
    // NULL kind → both refs NULL (open finding or pre-1.9 row that
    // hasn't been edited since the migration).
    responsiblePartyKind: text('responsible_party_kind'),
    responsiblePartyUserId: uuid('responsible_party_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    promotedActionItemId: uuid('promoted_action_item_id').references(() => actionItems.id, {
      onDelete: 'set null',
      onUpdate: 'restrict',
    }),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    // Optimistic-concurrency etag (1.10, ADR-0009 §3.7).
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    auditIdxUnique: uniqueIndex('inspection_findings_audit_idx_unique').on(t.auditIdx),
    inspectionIdx: index('inspection_findings_inspection_idx').on(t.inspectionId),
    statusValueIdx: index('inspection_findings_status_value_idx').on(t.statusValue),
  }),
);

// One row per signature, separate-table over JSONB blob (ADR-0007 §3.8).
// UNIQUE (inspection_id, role) gives "at most one of each role per
// inspection" for free; audit_idx FK is per-signature anchoring.

export const inspectionSignatures = pgTable(
  'inspection_signatures',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    inspectionId: uuid('inspection_id')
      .notNull()
      .references(() => inspections.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    signedByUserId: uuid('signed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    role: text('role').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    noteCt: bytea('note_ct'),
    noteDekCt: bytea('note_dek_ct'),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
  },
  (t) => ({
    auditIdxUnique: uniqueIndex('inspection_signatures_audit_idx_unique').on(t.auditIdx),
    inspectionIdx: index('inspection_signatures_inspection_idx').on(t.inspectionId),
  }),
);

// PDF export receipts. The file lives in Tigris under storage_key; the
// row carries the integrity anchor (output_sha256, 32 bytes) plus the
// step-up grant jti that authorized the export. expires_at is the
// 30-day TTL hint (Tigris lifecycle is the actual enforcement).
// inspection_ids[] is bounded by the SQL CHECK to 1..100 (T-I32).
//
// 1.9 (ADR-0008 §3.11) extends this row with three nullable columns
// for recommendation exports (kind='recommendation_single'):
//   - signingKeyId — FK to workplace_signing_keys.
//   - signatureSha256 — SHA-256 of the Ed25519 detached signature.
// Inspection exports keep both NULL; a SQL alignment CHECK enforces
// the kind→signing-column relationship.

export const exportRecords = pgTable(
  'export_records',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: text('kind').notNull(),
    inspectionIds: uuid('inspection_ids').array().notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    outputSha256: bytea('output_sha256').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    stepUpJti: text('step_up_jti').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    // 1.9 additions — both nullable; populated only for
    // kind='recommendation_single'. workplaceSigningKeys is declared
    // below; the lazy callback in references() lets Drizzle resolve the
    // FK at runtime after both tables are constructed.
    signingKeyId: uuid('signing_key_id').references(() => workplaceSigningKeys.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    signatureSha256: bytea('signature_sha256'),
  },
  (t) => ({
    storageKeyUnique: uniqueIndex('export_records_storage_key_unique').on(t.storageKey),
    auditIdxUnique: uniqueIndex('export_records_audit_idx_unique').on(t.auditIdx),
    requestedByIdx: index('export_records_requested_by_idx').on(t.requestedByUserId),
    requestedAtIdx: index('export_records_requested_at_idx').on(t.requestedAt),
  }),
);

// ---------------------------------------------------------------------------
// Recommendations (1.9, ADR-0008)
// ---------------------------------------------------------------------------

// Workplace Ed25519 signing keypair (separate table from workplace_keys
// per ADR-0008 §3.7 — different primitive, different rotation semantics,
// different operational risk surface). Partial UNIQUE on (active)
// WHERE active=true enforces at-most-one-active at the DB layer (T-R19).

export const workplaceSigningKeys = pgTable(
  'workplace_signing_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    algorithm: text('algorithm').notNull().default('ed25519'),
    active: boolean('active').notNull().default(true),
    publicKey: bytea('public_key').notNull(),
    privateKeyCt: bytea('private_key_ct').notNull(),
    privateKeyDekCt: bytea('private_key_dek_ct').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    activeIdx: index('workplace_signing_keys_active_idx').on(t.active),
  }),
);

// Recommendations — envelope-encrypted title + body; per-jurisdiction
// recommendation_number; state-machine lifecycle. See migration 0008
// for the lifecycle CHECK that pins which timestamp columns must be
// NULL vs NOT NULL per status. drafted_at / submitted_at /
// resolved_at / withdrawn_at are the four lifecycle columns.

export const recommendations = pgTable(
  'recommendations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recommendationNumber: integer('recommendation_number').notNull(),
    titleCt: bytea('title_ct').notNull(),
    titleDekCt: bytea('title_dek_ct').notNull(),
    bodyCt: bytea('body_ct').notNull(),
    bodyDekCt: bytea('body_dek_ct').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    status: text('status').notNull().default('draft'),
    draftedByUserId: uuid('drafted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    draftedAt: timestamp('drafted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    // Template-supplied PI-clean enum-like reason; SQL caps at 200
    // chars. The route's Zod enum is the tighter gate.
    withdrawnReason: text('withdrawn_reason'),
    // 2.1 (ADR-0012 §3.7): the meeting this recommendation was drafted
    // in, if any. NULL for recommendations drafted outside a meeting
    // (the existing 1.9 surface). FK SET NULL on meeting delete — the
    // recommendation's own lifecycle outlives the meeting record.
    meetingId: uuid('meeting_id'),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    // Optimistic-concurrency etag (1.10, ADR-0009 §3.7).
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    auditIdxUnique: uniqueIndex('recommendations_audit_idx_unique').on(t.auditIdx),
    jurisdictionNumberUnique: uniqueIndex('recommendations_jurisdiction_number_unique').on(
      t.jurisdiction,
      t.recommendationNumber,
    ),
    statusIdx: index('recommendations_status_idx').on(t.status),
    jurisdictionIdx: index('recommendations_jurisdiction_idx').on(t.jurisdiction),
    draftedByIdx: index('recommendations_drafted_by_idx').on(t.draftedByUserId),
    submittedAtIdx: index('recommendations_submitted_at_idx').on(t.submittedAt),
    meetingIdx: index('recommendations_meeting_idx').on(t.meetingId),
  }),
);

// Position-ordered resolved citation triples (statute_code, clause_id,
// version_date). NO FK to legal_clauses — the corpus is
// append-only-versioned and the Zod check at submit is the gate
// (documented residual T-R7). UNIQUE (recommendation_id, position)
// enforces dense ordering at the structural layer.

export const recommendationCitations = pgTable(
  'recommendation_citations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    statuteCode: text('statute_code').notNull(),
    clauseId: text('clause_id').notNull(),
    versionDate: date('version_date', { mode: 'string' }).notNull(),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recommendationPositionUnique: uniqueIndex(
      'recommendation_citations_recommendation_position_unique',
    ).on(t.recommendationId, t.position),
    recommendationIdx: index('recommendation_citations_recommendation_idx').on(t.recommendationId),
  }),
);

// Append-only positional response capture. SQL caps position <= 50
// (T-R42); the route's serializing advisory-lock + UNIQUE backstop
// closes T-R10 (concurrent appenders racing on MAX).

export const recommendationResponses = pgTable(
  'recommendation_responses',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    position: integer('position').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    receivedByUserId: uuid('received_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    authorRoleCt: bytea('author_role_ct').notNull(),
    authorRoleDekCt: bytea('author_role_dek_ct').notNull(),
    bodyCt: bytea('body_ct').notNull(),
    bodyDekCt: bytea('body_dek_ct').notNull(),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    auditIdxUnique: uniqueIndex('recommendation_responses_audit_idx_unique').on(t.auditIdx),
    recommendationPositionUnique: uniqueIndex(
      'recommendation_responses_recommendation_position_unique',
    ).on(t.recommendationId, t.position),
    recommendationIdx: index('recommendation_responses_recommendation_idx').on(t.recommendationId),
  }),
);

// Link table for the recommendation→action_item bridge created at
// submit time. link_kind 'tracks' is the 1.9 default; 'replaces' is a
// forward seam (UI lands in Release 2 per ADR-0008 §3.5).
// UNIQUE (action_item_id) enforces at-most-one-rec-per-action-item
// (T-R13).

export const recommendationActionItemLinks = pgTable(
  'recommendation_action_item_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    actionItemId: uuid('action_item_id')
      .notNull()
      .references(() => actionItems.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    linkKind: text('link_kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recommendationActionUnique: uniqueIndex(
      'recommendation_action_item_links_recommendation_action_unique',
    ).on(t.recommendationId, t.actionItemId),
    actionItemUnique: uniqueIndex('recommendation_action_item_links_action_item_unique').on(
      t.actionItemId,
    ),
    recommendationIdx: index('recommendation_action_item_links_recommendation_idx').on(
      t.recommendationId,
    ),
    actionItemIdx: index('recommendation_action_item_links_action_item_idx').on(t.actionItemId),
  }),
);

// ---------------------------------------------------------------------------
// Sync infrastructure (1.10, ADR-0009)
// ---------------------------------------------------------------------------

// The Idempotency-Key middleware (apps/api/src/middleware/idempotency.ts)
// caches (actor, action_kind, entity_local_id, payload_hash) → cached
// response so a queue retry that drained but lost the response leg
// returns the cached body without re-running the handler — preserving
// the once-per-logical-operation chain-anchor invariant (CLAUDE.md #2 +
// SECURITY.md §2.10 T-S4). Mirrors migration 0009 exactly.
//
// The cached response body is envelope-encrypted at rest (response_body_ct
// + response_body_dek_ct) because it can carry server-allocated ids
// (recommendation_number, action_item.id, hazardCode) and the cache is
// operational infrastructure that should not sit as plaintext alongside
// the encrypted entity tables.
//
// The four-way UNIQUE is split into two partial indexes (one for
// entity_local_id IS NOT NULL, one for entity_local_id IS NULL) because
// PostgreSQL UNIQUE treats NULLs as distinct — a single UNIQUE over the
// four-tuple would let two different routes with NULL entity_local_id
// but the same actor/action/payload both insert successfully.

export const syncIdempotency = pgTable(
  'sync_idempotency',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    // REST verb + path template, e.g. 'POST /api/recommendations'.
    // Single text column to keep the middleware lookup fast.
    actionKind: text('action_kind').notNull(),
    // The client-generated UUID v4 (ClientId) the body carried, when
    // present. Nullable — not every route accepts clientId yet (transition
    // / promote / resolve / withdraw routes don't create top-level rows
    // per ADR-0009 §3.3).
    entityLocalId: uuid('entity_local_id'),
    // SHA-256 of canonical-JSON of the request body. 32 bytes.
    payloadHash: bytea('payload_hash').notNull(),
    responseStatusCode: integer('response_status_code').notNull(),
    // Envelope-encrypted cached response body (sealed JSON).
    responseBodyCt: bytea('response_body_ct').notNull(),
    responseBodyDekCt: bytea('response_body_dek_ct').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    // 7-day TTL per ADR-0009 §3.4.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    // The two partial UNIQUE indexes from migration 0009 — Drizzle's
    // pg-core uniqueIndex builder with `.where()` produces the same
    // CREATE UNIQUE INDEX ... WHERE statement.
    keyWithEntityUnique: uniqueIndex('sync_idempotency_key_with_entity_unique')
      .on(t.actorUserId, t.actionKind, t.entityLocalId, t.payloadHash)
      .where(sql`${t.entityLocalId} IS NOT NULL`),
    keyWithoutEntityUnique: uniqueIndex('sync_idempotency_key_without_entity_unique')
      .on(t.actorUserId, t.actionKind, t.payloadHash)
      .where(sql`${t.entityLocalId} IS NULL`),
    expiresAtIdx: index('sync_idempotency_expires_at_idx').on(t.expiresAt),
    createdAtIdx: index('sync_idempotency_created_at_idx').on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Excel imports (1.11, ADR-0010)
// ---------------------------------------------------------------------------

// Batch-level row per uploaded workbook. Status walks pending → preview →
// committed / cancelled; committed can flip to reversed via the 30-day
// reverse path (S2 lands the route; S1 lands the schema).
//
// Three envelope-encrypted column pairs carry PI: source_filename_ct
// (T-X19 — filenames frequently carry the workplace name per #1);
// inspection_review_snapshot_ct (T-X13 — supervisor + witness names);
// pair-NULL CHECKs enforced in migration 0010.
//
// source_sha256 is PLAINTEXT — a 32-byte content hash is not PI, and
// keeping it plaintext lets the chain anchor + the re-import idempotency
// path (ADR §3.6) cheaply look up by hash.

export const excelImports = pgTable(
  'excel_imports',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    importedByUserId: uuid('imported_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    // Envelope-encrypted source filename (T-X19).
    sourceFilenameCt: bytea('source_filename_ct').notNull(),
    sourceFilenameDekCt: bytea('source_filename_dek_ct').notNull(),
    // SHA-256 of raw file bytes — integrity anchor only; plaintext OK.
    sourceSha256: bytea('source_sha256').notNull(),
    schemaVersion: text('schema_version').notNull(),
    rowCount: integer('row_count').notNull(),
    status: text('status').notNull().default('pending'),
    // Step-up jti pinned on commit; NULL until committed. NOT an FK —
    // step-up tokens are short-lived; this is for audit-log cross-ref.
    stepUpJti: text('step_up_jti'),
    // Envelope-encrypted JSONB snapshot of the Inspection Review sheet
    // (read-only per ADR §3.4; not promoted to native inspection rows).
    // S5 sec-F2 / priv-F2 close-out: sealed-box-encrypted in browser
    // before upload; server stores ciphertext + sealed DEK as-is.
    inspectionReviewSnapshotCt: bytea('inspection_review_snapshot_ct'),
    inspectionReviewSnapshotDekCt: bytea('inspection_review_snapshot_dek_ct'),
    // S5 priv-F6 close-out: envelope-encrypted JSONB of the Minutes
    // sheet's meeting metadata (meeting_date, quorum, attendance,
    // workbook_version). The parser already produces the shape; the
    // route now persists it. Sealed-box-encrypted in browser; sensitive
    // because attendance lists meeting attendees by name.
    meetingMetadataCt: bytea('meeting_metadata_ct'),
    meetingMetadataDekCt: bytea('meeting_metadata_dek_ct'),
    auditIdx: bigint('audit_idx', { mode: 'number' })
      .notNull()
      .references(() => auditLog.idx, { onDelete: 'restrict', onUpdate: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    previewedAt: timestamp('previewed_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // S2 reverse-path stamp (ADR §3.11). NULL until the 30-day reverse
    // fires. The migration extends the state-consistency CHECK to enforce
    // that reversed_at is NOT NULL when status='reversed'.
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
  },
  (t) => ({
    auditIdxUnique: uniqueIndex('excel_imports_audit_idx_unique').on(t.auditIdx),
    importedByIdx: index('excel_imports_imported_by_idx').on(t.importedByUserId),
    statusIdx: index('excel_imports_status_idx').on(t.status),
    createdAtIdx: index('excel_imports_created_at_idx').on(t.createdAt),
    // Partial — the 30-day reverse-window scan walks committed rows only.
    committedAtIdx: index('excel_imports_committed_at_idx')
      .on(t.committedAt)
      .where(sql`${t.status} = 'committed'`),
  }),
);

// Per-row provenance join. One row per parsed action_item from the
// workbook. UNIQUE (import_id, content_hash) collapses same-hash
// duplicates within one import. before_state_json captures the
// pre-import snapshot the 30-day reverse restores from (ADR §3.11).
//
// action_item_id is NULL during pending/preview; populated by the
// commit transaction; ON DELETE SET NULL so a reverse that DELETEs
// the action_item leaves this row as evidentiary record (T-X38).
//
// audit_idx is NULLABLE (skipped rows do not anchor); partial UNIQUE
// in migration 0010 enforces "UNIQUE except NULL".

export const excelImportItems = pgTable(
  'excel_import_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    importId: uuid('import_id')
      .notNull()
      .references(() => excelImports.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    sourceRowIndex: integer('source_row_index').notNull(),
    section: text('section').notNull(),
    // 32-byte SHA-256 — sha256(canonical(description)||'|'||canonical(start_date)).
    contentHash: bytea('content_hash').notNull(),
    actionItemId: uuid('action_item_id').references(() => actionItems.id, {
      onDelete: 'set null',
      onUpdate: 'restrict',
    }),
    status: text('status').notNull().default('conflict_pending'),
    // Pre-import snapshot for reverse-path restoration. NULL when
    // status='created' (no prior state).
    beforeStateJson: jsonb('before_state_json'),
    auditIdx: bigint('audit_idx', { mode: 'number' }).references(() => auditLog.idx, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    importContentHashUnique: uniqueIndex('excel_import_items_import_content_hash_unique').on(
      t.importId,
      t.contentHash,
    ),
    auditIdxUnique: uniqueIndex('excel_import_items_audit_idx_unique')
      .on(t.auditIdx)
      .where(sql`${t.auditIdx} IS NOT NULL`),
    importStatusIdx: index('excel_import_items_import_status_idx').on(t.importId, t.status),
    actionItemIdx: index('excel_import_items_action_item_idx')
      .on(t.actionItemId)
      .where(sql`${t.actionItemId} IS NOT NULL`),
    contentHashIdx: index('excel_import_items_content_hash_idx').on(t.contentHash),
  }),
);

// ---------------------------------------------------------------------------
// Meeting lifecycle (2.1, ADR-0012)
// ---------------------------------------------------------------------------

// meeting_templates — versioned agenda templates (append-only per
// non-negotiable #13). Same posture as inspection_templates.

export const meetingTemplates = pgTable(
  'meeting_templates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    templateCode: text('template_code').notNull(),
    versionNumber: integer('version_number').notNull(),
    name: text('name').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    sectionsJson: jsonb('sections_json').notNull(),
    signingKeyId: uuid('signing_key_id').references(() => workplaceSigningKeys.id, {
      onDelete: 'set null',
      onUpdate: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    codeVersionUnique: uniqueIndex('meeting_templates_code_version_unique').on(
      t.templateCode,
      t.versionNumber,
    ),
    codeIdx: index('meeting_templates_code_idx').on(t.templateCode),
  }),
);

// meetings — TM-fold-1 column is `agendaTemplateVersion`. current_section_id
// FK is added to meeting_sections.id in the migration (chicken-and-egg).
// Drizzle's lazy `references()` lets us reference meetingSections defined
// further down.

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workplaceSingleton: smallint('workplace_singleton').notNull().default(1),
    meetingDate: date('meeting_date', { mode: 'string' }).notNull(),
    location: text('location'),
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }).notNull(),
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }).notNull(),
    actualStartAt: timestamp('actual_start_at', { withTimezone: true }),
    actualEndAt: timestamp('actual_end_at', { withTimezone: true }),
    // TM-fold-1 (T-ML33): immutable post-create per #13.
    agendaTemplateVersion: integer('agenda_template_version').notNull(),
    status: text('status').notNull().default('scheduled'),
    // FK to meeting_sections.id added in migration; here it's a plain
    // uuid column because the meetingSections table is declared later
    // and Drizzle's lazy reference would create a circular type.
    currentSectionId: uuid('current_section_id'),
    encryptedNotesEnvelopeCt: bytea('encrypted_notes_envelope_ct'),
    encryptedNotesEnvelopeDekCt: bytea('encrypted_notes_envelope_dek_ct'),
    createdByActorId: uuid('created_by_actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    meetingDateIdx: index('meetings_meeting_date_idx').on(t.meetingDate),
    statusIdx: index('meetings_status_idx').on(t.status),
  }),
);

// meeting_sections — closed 12-value section_type enum. visibility is
// TM-fold-2 forward seam (T-ML9 / T-ML11 / T-ML25).

export const meetingSections = pgTable(
  'meeting_sections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    sectionType: text('section_type').notNull(),
    visibility: text('visibility').notNull().default('standard'),
    orderIdx: integer('order_idx').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    notesEnvelopeCt: bytea('notes_envelope_ct'),
    notesEnvelopeDekCt: bytea('notes_envelope_dek_ct'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    meetingOrderUnique: uniqueIndex('meeting_sections_meeting_order_unique').on(
      t.meetingId,
      t.orderIdx,
    ),
    meetingIdx: index('meeting_sections_meeting_idx').on(t.meetingId),
  }),
);

// meeting_attendance — encrypted display_name (T-ML1). No plaintext
// name column on this table.

export const meetingAttendance = pgTable(
  'meeting_attendance',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    role: text('role').notNull(),
    party: text('party').notNull(),
    displayNameCt: bytea('display_name_ct').notNull(),
    displayNameDekCt: bytea('display_name_dek_ct').notNull(),
    attendeeUserId: uuid('attendee_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    presentStatus: text('present_status').notNull().default('present'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    departedAt: timestamp('departed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    meetingIdx: index('meeting_attendance_meeting_idx').on(t.meetingId),
    meetingRoleIdx: index('meeting_attendance_meeting_role_idx').on(t.meetingId, t.role),
  }),
);

// meeting_inspection_review — link from a meeting to a 1.8 inspection.

export const meetingInspectionReview = pgTable(
  'meeting_inspection_review',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    inspectionId: uuid('inspection_id')
      .notNull()
      .references(() => inspections.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    outcome: text('outcome').notNull(),
    notesEnvelopeCt: bytea('notes_envelope_ct'),
    notesEnvelopeDekCt: bytea('notes_envelope_dek_ct'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    meetingInspectionUnique: uniqueIndex('meeting_inspection_review_meeting_inspection_unique').on(
      t.meetingId,
      t.inspectionId,
    ),
    meetingIdx: index('meeting_inspection_review_meeting_idx').on(t.meetingId),
    inspectionIdx: index('meeting_inspection_review_inspection_idx').on(t.inspectionId),
  }),
);

// meeting_signatures — 4-signer counter-sign workflow. TM-fold-4
// (T-ML5 / T-ML23) columns: chain_of_custody_note_ct (encrypted free-text
// describing how the off-app signature was obtained) and
// attestation_signed_ct (64-byte Ed25519 sig over canonical row JSON).

export const meetingSignatures = pgTable(
  'meeting_signatures',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    signerRole: text('signer_role').notNull(),
    signerDisplayNameCt: bytea('signer_display_name_ct').notNull(),
    signerDisplayNameDekCt: bytea('signer_display_name_dek_ct').notNull(),
    signerUserId: uuid('signer_user_id').references(() => users.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    signedAt: timestamp('signed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    signedMethod: text('signed_method').notNull(),
    evidenceStorageKey: text('evidence_storage_key'),
    evidenceEnvelopeCt: bytea('evidence_envelope_ct'),
    evidenceEnvelopeDekCt: bytea('evidence_envelope_dek_ct'),
    stepUpJti: text('step_up_jti'),
    // TM-fold-4 (T-ML5 / T-ML23): chain-of-custody note.
    chainOfCustodyNoteCt: bytea('chain_of_custody_note_ct'),
    chainOfCustodyNoteDekCt: bytea('chain_of_custody_note_dek_ct'),
    // TM-fold-4 (T-ML5 / T-ML23): Ed25519 sig over canonical row JSON.
    attestationSignedCt: bytea('attestation_signed_ct').notNull(),
    signingKeyId: uuid('signing_key_id')
      .notNull()
      .references(() => workplaceSigningKeys.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    meetingRoleUnique: uniqueIndex('meeting_signatures_meeting_role_unique').on(
      t.meetingId,
      t.signerRole,
    ),
    meetingIdx: index('meeting_signatures_meeting_idx').on(t.meetingId),
  }),
);

// meeting_action_item_state — per-meeting snapshot rows. Per S0 user
// decision: live rows are retained alongside the finalized row; the
// partial UNIQUE on snapshot_kind='finalized' is the only structural
// uniqueness constraint.

export const meetingActionItemState = pgTable(
  'meeting_action_item_state',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    actionItemId: uuid('action_item_id')
      .notNull()
      .references(() => actionItems.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    snapshotKind: text('snapshot_kind').notNull().default('live'),
    snapshotStatus: text('snapshot_status').notNull(),
    snapshotSection: text('snapshot_section').notNull(),
    snapshotAssigneeCt: bytea('snapshot_assignee_ct'),
    snapshotAssigneeDekCt: bytea('snapshot_assignee_dek_ct'),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    finalizedUnique: uniqueIndex('meeting_action_item_state_finalized_unique')
      .on(t.meetingId, t.actionItemId)
      .where(sql`${t.snapshotKind} = 'finalized'`),
    meetingIdx: index('meeting_action_item_state_meeting_idx').on(t.meetingId),
    actionItemIdx: index('meeting_action_item_state_action_item_idx').on(t.actionItemId),
    meetingKindIdx: index('meeting_action_item_state_meeting_kind_idx').on(
      t.meetingId,
      t.snapshotKind,
    ),
    // 2.2 (ADR-0013 TM-fold-2 / T-IM7 / T-IM11): partial UNIQUE that
    // dedupes idempotent retries landing the same (status, section)
    // for a given (meeting, action_item) live snapshot. Created by
    // migration 0012 (meeting_action_item_state_live_dedupe_unique).
    // Only semantically-distinct state combinations accumulate new
    // live rows; the M2.1 finalized partial UNIQUE stays as-is.
    liveDedupeUnique: uniqueIndex('meeting_action_item_state_live_dedupe_unique')
      .on(t.meetingId, t.actionItemId, t.snapshotStatus, t.snapshotSection)
      .where(sql`${t.snapshotKind} = 'live'`),
  }),
);

// ---------------------------------------------------------------------------
// action_item_closures (2.2, ADR-0013 §3.1 + TM-folds 1 + 5)
// ---------------------------------------------------------------------------
//
// JHSC counter-sign closure attestation row. Parallel in shape to
// meeting_signatures (M2.1) but scoped to a single action item's
// closure. Append-only — re-opening writes a NEW row on the next
// closure (the prior row stays in place as historical evidence).
//
// TM-fold-5: signing_key_id + attestation_signed_ct (64-byte Ed25519
// sig over canonical row JSON) defend the row at the workplace-key
// layer in addition to chain anchoring. The CHECK constraints
// (evidence_triple + actors_shape + attestation_sig_length) all live
// in migration 0012; the Drizzle column definitions below carry the
// same shape so generate-vs-migrate diffs stay clean.

export const actionItemClosures = pgTable(
  'action_item_closures',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actionItemId: uuid('action_item_id')
      .notNull()
      .references(() => actionItems.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    closedByActorId: uuid('closed_by_actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    closedAt: timestamp('closed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    counterSignedByActorId: uuid('counter_signed_by_actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    counterSignedAt: timestamp('counter_signed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    // Envelope-encrypted closure rationale. Plaintext is NEVER in
    // the chain payload (T-AC9); the payload carries only the
    // SHA-256 hash of the ciphertext bytes.
    closureReasonEnvelopeCt: bytea('closure_reason_envelope_ct').notNull(),
    closureReasonEnvelopeDekCt: bytea('closure_reason_envelope_dek_ct').notNull(),
    // Optional Tigris evidence. pair-NULL CHECK in migration 0012.
    evidenceStorageKey: text('evidence_storage_key'),
    evidenceEnvelopeCt: bytea('evidence_envelope_ct'),
    evidenceEnvelopeDekCt: bytea('evidence_envelope_dek_ct'),
    // Single-rep edge case per ADR §3.5. When TRUE, the closer +
    // counter-signer ARE the same user; the chain payload's
    // selfAttestation flag records the distinction. CHECK in 0012
    // enforces the closer-vs-counter-signer relationship flips with
    // this flag.
    selfAttestation: boolean('self_attestation').notNull().default(false),
    // Meeting in which the closure was verified. NULLABLE per ADR §3.5
    // — closure can happen outside a meeting context.
    meetingId: uuid('meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
      onUpdate: 'restrict',
    }),
    // TM-fold-5 (T-IM33): workplace signing key the attestation was
    // produced under. FK so key rotations are queryable.
    signingKeyId: uuid('signing_key_id')
      .notNull()
      .references(() => workplaceSigningKeys.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    // TM-fold-5 (T-IM33): 64-byte Ed25519 detached signature over
    // SHA-256 of the canonical row JSON. Length CHECK in 0012.
    attestationSignedCt: bytea('attestation_signed_ct').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    actionItemUnique: uniqueIndex('action_item_closures_action_item_unique').on(t.actionItemId),
    meetingIdx: index('action_item_closures_meeting_idx')
      .on(t.meetingId)
      .where(sql`${t.meetingId} IS NOT NULL`),
    closedByActorIdx: index('action_item_closures_closed_by_actor_idx').on(t.closedByActorId),
    counterSignedByActorIdx: index('action_item_closures_counter_signed_by_actor_idx').on(
      t.counterSignedByActorId,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Re-export for Drizzle adapters
// ---------------------------------------------------------------------------

export const schema = {
  users,
  userProfiles,
  passwordCredentials,
  passkeyCredentials,
  totpCredentials,
  recoveryCodes,
  sessions,
  loginAttempts,
  setupState,
  webauthnChallenges,
  authEvents,
  auditLog,
  corpusVersions,
  statutes,
  clauses,
  hazards,
  hazardStatusHistory,
  actionItems,
  actionItemMoves,
  workplaceKeys,
  evidenceFiles,
  inspectionTemplates,
  inspections,
  inspectionFindings,
  inspectionSignatures,
  exportRecords,
  workplaceSigningKeys,
  recommendations,
  recommendationCitations,
  recommendationResponses,
  recommendationActionItemLinks,
  syncIdempotency,
  excelImports,
  excelImportItems,
  meetingTemplates,
  meetings,
  meetingSections,
  meetingAttendance,
  meetingInspectionReview,
  meetingSignatures,
  meetingActionItemState,
  actionItemClosures,
  loginAttemptOutcome,
  authEventKind,
  webauthnPurpose,
} as const;

export type Schema = typeof schema;
export type DbUser = typeof users.$inferSelect;
export type DbSession = typeof sessions.$inferSelect;
export type DbPasskeyCredential = typeof passkeyCredentials.$inferSelect;
export type DbAuthEvent = typeof authEvents.$inferSelect;
