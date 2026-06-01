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
  loginAttemptOutcome,
  authEventKind,
  webauthnPurpose,
} as const;

export type Schema = typeof schema;
export type DbUser = typeof users.$inferSelect;
export type DbSession = typeof sessions.$inferSelect;
export type DbPasskeyCredential = typeof passkeyCredentials.$inferSelect;
export type DbAuthEvent = typeof authEvents.$inferSelect;
