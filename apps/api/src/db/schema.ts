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
    meetingId: uuid('meeting_id'),
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
  loginAttemptOutcome,
  authEventKind,
  webauthnPurpose,
} as const;

export type Schema = typeof schema;
export type DbUser = typeof users.$inferSelect;
export type DbSession = typeof sessions.$inferSelect;
export type DbPasskeyCredential = typeof passkeyCredentials.$inferSelect;
export type DbAuthEvent = typeof authEvents.$inferSelect;
