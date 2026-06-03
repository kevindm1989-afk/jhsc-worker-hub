-- Milestone 2.1 (ADR-0012): Meeting Lifecycle — schema + migration.
--
-- Seven new tables land here:
--
--   1. meeting_templates  — versioned agenda templates (append-only per
--      non-negotiable #13; same posture as inspection_templates / 1.8).
--      The S4 seed populates v1; this migration creates the table only.
--
--   2. meetings           — the entity. Pinned to a specific template
--      version at create time (agenda_template_version INT, TM-fold-1 per
--      ADR-0012 S0 addendum). current_section_id is a pointer to the
--      meeting_sections row the co-chair is currently navigating.
--      notes envelope is co-chair-private; encrypted via the standard
--      (_ct, _dek_ct) pair shape.
--
--   3. meeting_sections   — closed 12-value section_type enum (per
--      ADR §3.1 reconciliation + the S1 brief). visibility column is
--      TM-fold-2 forward seam (T-ML9 / T-ML11 / T-ML25): 'standard' is
--      the v1 value; 'co_chair_only' is reserved for the 2.5+ in-camera
--      deliberation surface without requiring a schema migration.
--
--   4. meeting_attendance — display_name encrypted at rest per
--      non-negotiable #1 + #4 + T-ML1. attendee_user_id is the in-app
--      worker co-chair binding; NULL for every other role (non-negotiable
--      #6 — mgmt + guests have no in-app accounts).
--
--   5. meeting_inspection_review — link from a meeting to an existing
--      1.8 inspection. The inspection row itself is not modified
--      (ADR §3.7 — promotion goes through the 1.8 route per #15).
--
--   6. meeting_signatures — the 4-signer counter-sign workflow. Two
--      TM-fold-4 columns land here (T-ML5 / T-ML23):
--        - chain_of_custody_note_ct: encrypted free-text the rep
--          records describing HOW the off-app signature was obtained.
--        - attestation_signed_ct: Ed25519 sig over SHA-256 of the
--          canonical row JSON, signed with the workplace signing key.
--          Defense-in-depth tamper detection at the workplace-key
--          layer (not just chain-anchored).
--      Signer roles are GENERIC (worker_co_chair, mgmt_co_chair,
--      mgmt_external_1, mgmt_external_2) per non-negotiable #1 — the
--      display labels for "Warehouse Manager" / "Plant Manager" come
--      from config/workplace.ts at runtime; the SOURCE has zero
--      workplace-specific role labels. CHECK constraints enforce the
--      method-shape (in_app_passkey → worker_co_chair + no evidence;
--      paper / email → evidence_storage_key NOT NULL).
--
--   7. meeting_action_item_state — per-meeting snapshot of an action
--      item's state at meeting time (ADR §3.2). 'live' rows accumulate
--      during the meeting; 'finalized' is the immutable record (one per
--      action_item per meeting). Partial UNIQUE on snapshot_kind=
--      'finalized' enforces the at-most-one-finalized invariant per the
--      S0 user-decision (live rows are retained post-adjournment).
--
-- Three existing tables are extended:
--
--   - action_items.first_raised_meeting_id — immutable provenance
--     (ADR §3.2 Layer 1); nullable for pre-meeting drafts + Excel
--     imports. Also action_items.meeting_id (already declared in 0005
--     as a placeholder uuid) gets its FK to meetings(id) added here.
--
--   - recommendations.meeting_id — links a recommendation drafted IN a
--     meeting to that meeting (ADR §3.7); nullable.
--
--   - inspections.triggering_meeting_id — the meeting that requested
--     the inspection, if any; nullable.
--
-- Triggers (reuse existing functions from 0009):
--   - bump_version_on_update() — attached to all 6 mutable tables that
--     carry a version column (everything except meeting_templates,
--     which is append-only).
--   - {table}_touch_updated_at() — one per table that has updated_at.
--
-- Append-only — does not edit any prior migration.

-- ---------------------------------------------------------------------------
-- meeting_templates — versioned agenda templates
-- ---------------------------------------------------------------------------

CREATE TABLE "meeting_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_code" text NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	-- Canonical sections array. Validated by Zod in the seed; at the
	-- DB layer we only constrain it's a JSON array.
	"sections_json" jsonb NOT NULL,
	-- Workplace signing key the v1 template was authored under. NULL
	-- until the S4 seed binds it. FK is opportunistic; we allow NULL
	-- so the table is constructible before the signing key seed.
	"signing_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "meeting_templates_version_number_check"
		CHECK ("version_number" >= 1),
	CONSTRAINT "meeting_templates_jurisdiction_check"
		CHECK ("jurisdiction" IN ('ON','CA-FED')),
	CONSTRAINT "meeting_templates_sections_json_is_array_check"
		CHECK (jsonb_typeof("sections_json") = 'array'),
	CONSTRAINT "meeting_templates_signing_key_fk"
		FOREIGN KEY ("signing_key_id") REFERENCES "workplace_signing_keys"("id")
		ON UPDATE RESTRICT ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_templates_code_version_unique"
	ON "meeting_templates" USING btree ("template_code","version_number");
--> statement-breakpoint
CREATE INDEX "meeting_templates_code_idx"
	ON "meeting_templates" USING btree ("template_code");
--> statement-breakpoint
-- At most one active (non-retired) version per template_code.
CREATE UNIQUE INDEX "meeting_templates_code_active_unique"
	ON "meeting_templates" USING btree ("template_code") WHERE "retired_at" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- meetings — the entity
-- ---------------------------------------------------------------------------
--
-- agenda_template_version is TM-fold-1 (T-ML33). Stored as INT (the
-- template's version_number, not its id). A row-level constraint trigger
-- (declared after the meeting_templates rows can exist; the seed in S4
-- populates v1) validates that the (jurisdiction, version) pair exists
-- in meeting_templates and is non-retired at INSERT time. The trigger is
-- defined at the bottom of this file so meeting_templates exists first.
--
-- current_section_id is nullable (a scheduled meeting has no current
-- section until the rep starts it). FK ON DELETE SET NULL so deleting
-- a section (only legal pre-adjournment, route-layer gated) does not
-- orphan the meeting row.
--
-- workplace_singleton mirrors setup_state — single-tenant invariant per
-- non-negotiable #1. The partial UNIQUE on (workplace_singleton) WHERE
-- status IN ('in_progress','pending_finalization') enforces "at most one
-- active meeting" at the DB layer (ADR §3.4 active-meeting check).

CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workplace_singleton" smallint NOT NULL DEFAULT 1,
	"meeting_date" date NOT NULL,
	"location" text,
	"scheduled_start_at" timestamp with time zone NOT NULL,
	"scheduled_end_at" timestamp with time zone NOT NULL,
	"actual_start_at" timestamp with time zone,
	"actual_end_at" timestamp with time zone,
	-- TM-fold-1 (T-ML33) — agenda template version pinned at create
	-- time. Immutable post-creation per non-negotiable #13.
	"agenda_template_version" integer NOT NULL,
	"status" text NOT NULL DEFAULT 'scheduled',
	"current_section_id" uuid,
	-- Co-chair private notes envelope. Nullable; pair-NULL enforced.
	"encrypted_notes_envelope_ct" "bytea",
	"encrypted_notes_envelope_dek_ct" "bytea",
	"created_by_actor_id" uuid NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_workplace_singleton_check"
		CHECK ("workplace_singleton" = 1),
	CONSTRAINT "meetings_status_check"
		CHECK ("status" IN
			('scheduled','in_progress','adjourned','pending_finalization','finalized','archived')),
	CONSTRAINT "meetings_agenda_template_version_check"
		CHECK ("agenda_template_version" >= 1),
	CONSTRAINT "meetings_notes_envelope_pair_check" CHECK (
		("encrypted_notes_envelope_ct" IS NULL AND "encrypted_notes_envelope_dek_ct" IS NULL)
		OR ("encrypted_notes_envelope_ct" IS NOT NULL AND "encrypted_notes_envelope_dek_ct" IS NOT NULL)
	),
	-- Lifecycle CHECK — keep (status, actual_*) coherent so a drifted
	-- handler cannot land a finalized row with NULL actual_end_at.
	CONSTRAINT "meetings_state_consistency_check" CHECK (
		("status" = 'scheduled'
			AND "actual_start_at" IS NULL
			AND "actual_end_at" IS NULL)
		OR ("status" = 'in_progress'
			AND "actual_start_at" IS NOT NULL
			AND "actual_end_at" IS NULL)
		OR ("status" IN ('adjourned','pending_finalization','finalized','archived')
			AND "actual_start_at" IS NOT NULL
			AND "actual_end_at" IS NOT NULL)
	),
	CONSTRAINT "meetings_created_by_actor_fk"
		FOREIGN KEY ("created_by_actor_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "meetings_meeting_date_idx"
	ON "meetings" USING btree ("meeting_date" DESC);
--> statement-breakpoint
CREATE INDEX "meetings_status_idx"
	ON "meetings" USING btree ("status");
--> statement-breakpoint
-- Single-tenant active-meeting invariant (ADR §3.4): at most one row
-- with status in (in_progress, pending_finalization).
CREATE UNIQUE INDEX "meetings_one_active_unique"
	ON "meetings" USING btree ("workplace_singleton")
	WHERE "status" IN ('in_progress','pending_finalization');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- meeting_sections — sequential agenda sections
-- ---------------------------------------------------------------------------
--
-- section_type is the CLOSED 12-value enum (per ADR §3.1 reconciliation
-- + S0 user decision: stable schema, no custom sections in Release 2).
-- visibility is TM-fold-2 (T-ML9 / T-ML11 / T-ML25) — defaults to
-- 'standard'; the 'co_chair_only' value is a forward seam for 2.5+
-- in-camera deliberation surfaces. The GET projection must honor the
-- column at the route layer (S2).

CREATE TABLE "meeting_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"section_type" text NOT NULL,
	"visibility" text NOT NULL DEFAULT 'standard',
	"order_idx" integer NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"notes_envelope_ct" "bytea",
	"notes_envelope_dek_ct" "bytea",
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_sections_section_type_check"
		CHECK ("section_type" IN (
			'call_to_order','roll_call_quorum','minutes_review',
			'old_business','new_business','inspections_review',
			'incident_review','complaints_review','recommendations',
			'other_business','next_meeting','adjournment'
		)),
	CONSTRAINT "meeting_sections_visibility_check"
		CHECK ("visibility" IN ('standard','co_chair_only')),
	CONSTRAINT "meeting_sections_order_idx_check"
		CHECK ("order_idx" >= 0 AND "order_idx" <= 31),
	CONSTRAINT "meeting_sections_notes_envelope_pair_check" CHECK (
		("notes_envelope_ct" IS NULL AND "notes_envelope_dek_ct" IS NULL)
		OR ("notes_envelope_ct" IS NOT NULL AND "notes_envelope_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "meeting_sections_meeting_fk"
		FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
		ON UPDATE RESTRICT ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_sections_meeting_order_unique"
	ON "meeting_sections" USING btree ("meeting_id","order_idx");
--> statement-breakpoint
CREATE INDEX "meeting_sections_meeting_idx"
	ON "meeting_sections" USING btree ("meeting_id");
--> statement-breakpoint
-- Now that meeting_sections exists, add the FK from meetings.current_section_id.
-- ALTER TABLE (rather than inline) because of the chicken-and-egg ordering
-- between meetings and meeting_sections.
ALTER TABLE "meetings"
	ADD CONSTRAINT "meetings_current_section_fk"
	FOREIGN KEY ("current_section_id") REFERENCES "meeting_sections"("id")
	ON UPDATE RESTRICT ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- meeting_attendance — encrypted attendee display names (T-ML1)
-- ---------------------------------------------------------------------------
--
-- NO PLAINTEXT NAME COLUMN — display_name_ct (+ DEK) is the only carrier
-- of the attendee's display name. The DB layer enforces no-plaintext via
-- the schema shape itself per non-negotiable #1 + T-ML1's primary
-- mitigation. The plaintext lives in browser JS heap only.
--
-- Role-uniqueness partial UNIQUEs enforce exactly one worker_co_chair
-- and one mgmt_co_chair per meeting. worker_rep / mgmt_rep / guest are
-- unbounded.

CREATE TABLE "meeting_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"role" text NOT NULL,
	"party" text NOT NULL,
	-- T-ML1: encrypted at rest. No plaintext sibling column.
	"display_name_ct" "bytea" NOT NULL,
	"display_name_dek_ct" "bytea" NOT NULL,
	-- Populated ONLY for the worker_co_chair row when the attendee is
	-- the in-app actor. NULL for every other role (no employer SSO per
	-- non-negotiable #6).
	"attendee_user_id" uuid,
	"present_status" text NOT NULL DEFAULT 'present',
	"arrived_at" timestamp with time zone,
	"departed_at" timestamp with time zone,
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_attendance_role_check"
		CHECK ("role" IN ('worker_co_chair','mgmt_co_chair','worker_rep','mgmt_rep','guest')),
	CONSTRAINT "meeting_attendance_party_check"
		CHECK ("party" IN ('union','management','guest')),
	CONSTRAINT "meeting_attendance_present_status_check"
		CHECK ("present_status" IN
			('present','regrets','absent_unexcused','late_arrival','early_departure')),
	-- Late arrival requires arrived_at; early departure requires departed_at.
	CONSTRAINT "meeting_attendance_arrival_departure_check" CHECK (
		("present_status" = 'late_arrival' AND "arrived_at" IS NOT NULL)
		OR ("present_status" = 'early_departure' AND "departed_at" IS NOT NULL)
		OR "present_status" IN ('present','regrets','absent_unexcused')
	),
	CONSTRAINT "meeting_attendance_meeting_fk"
		FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
		ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "meeting_attendance_attendee_user_fk"
		FOREIGN KEY ("attendee_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "meeting_attendance_meeting_idx"
	ON "meeting_attendance" USING btree ("meeting_id");
--> statement-breakpoint
CREATE INDEX "meeting_attendance_meeting_role_idx"
	ON "meeting_attendance" USING btree ("meeting_id","role");
--> statement-breakpoint
-- Exactly-one-co-chair-per-meeting partial UNIQUEs.
CREATE UNIQUE INDEX "meeting_attendance_one_worker_co_chair_unique"
	ON "meeting_attendance" USING btree ("meeting_id")
	WHERE "role" = 'worker_co_chair';
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_one_mgmt_co_chair_unique"
	ON "meeting_attendance" USING btree ("meeting_id")
	WHERE "role" = 'mgmt_co_chair';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- meeting_inspection_review — link table from a meeting to a 1.8 inspection
-- ---------------------------------------------------------------------------
--
-- The inspection itself is not modified by this row — promotion of
-- findings to action items still goes through the 1.8 route per #15.
-- outcome is the meeting's verdict; it's documentary.

CREATE TABLE "meeting_inspection_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"notes_envelope_ct" "bytea",
	"notes_envelope_dek_ct" "bytea",
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_inspection_review_outcome_check"
		CHECK ("outcome" IN ('accepted_as_complete','findings_promoted','deferred')),
	CONSTRAINT "meeting_inspection_review_notes_envelope_pair_check" CHECK (
		("notes_envelope_ct" IS NULL AND "notes_envelope_dek_ct" IS NULL)
		OR ("notes_envelope_ct" IS NOT NULL AND "notes_envelope_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "meeting_inspection_review_meeting_fk"
		FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
		ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "meeting_inspection_review_inspection_fk"
		FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_inspection_review_meeting_inspection_unique"
	ON "meeting_inspection_review" USING btree ("meeting_id","inspection_id");
--> statement-breakpoint
CREATE INDEX "meeting_inspection_review_meeting_idx"
	ON "meeting_inspection_review" USING btree ("meeting_id");
--> statement-breakpoint
CREATE INDEX "meeting_inspection_review_inspection_idx"
	ON "meeting_inspection_review" USING btree ("inspection_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- meeting_signatures — 4-signer counter-sign workflow
-- ---------------------------------------------------------------------------
--
-- signer_role is GENERIC per non-negotiable #1: 'worker_co_chair',
-- 'mgmt_co_chair', 'mgmt_external_1', 'mgmt_external_2'. The display
-- labels for "Warehouse Manager" / "Plant Manager" come from
-- config/workplace.ts at runtime; the SOURCE has zero workplace
-- specific role labels.
--
-- TM-fold-4 (T-ML5 / T-ML23) — two defense-in-depth columns:
--   - chain_of_custody_note_ct (+ DEK): encrypted free-text the rep
--     records describing HOW the off-app signature was obtained
--     (e.g. "signed PDF received via email from <role> on 2026-06-10").
--   - attestation_signed_ct: Ed25519 signature over SHA-256 of the
--     canonical row JSON, signed with the active workplace signing
--     key. Makes the attestation row itself tamper-evident at the
--     workplace-key layer, not just chain-anchored.
--
-- Method-shape CHECK: in_app_passkey requires worker_co_chair +
-- step_up_jti + signer_user_id and forbids evidence_storage_key.
-- paper / email require evidence_storage_key + evidence_envelope.

CREATE TABLE "meeting_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"signer_role" text NOT NULL,
	-- Encrypted display name (#1, T-ML1-class).
	"signer_display_name_ct" "bytea" NOT NULL,
	"signer_display_name_dek_ct" "bytea" NOT NULL,
	-- Only populated for worker_co_chair (the in-app actor).
	"signer_user_id" uuid,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_method" text NOT NULL,
	-- Tigris storage key for the off-app evidence blob (paper scan,
	-- signed PDF, etc.). NULL for in_app_passkey rows.
	"evidence_storage_key" text,
	-- Encrypted envelope of the off-app evidence content. NULL for
	-- in_app_passkey; pair-NULL with evidence_envelope_dek_ct.
	"evidence_envelope_ct" "bytea",
	"evidence_envelope_dek_ct" "bytea",
	-- Step-up jti pinned for in_app_passkey rows; NULL for off-app.
	"step_up_jti" text,
	-- TM-fold-4 (T-ML5 / T-ML23) — chain-of-custody note (encrypted).
	"chain_of_custody_note_ct" "bytea",
	"chain_of_custody_note_dek_ct" "bytea",
	-- TM-fold-4 (T-ML5 / T-ML23) — Ed25519 sig over canonical row JSON.
	-- 64 bytes; NOT NULL because the route emits the sig in the same
	-- transaction that INSERTs the row.
	"attestation_signed_ct" "bytea" NOT NULL,
	-- Workplace signing key used to produce attestation_signed_ct. FK
	-- so a key rotation history is queryable per ADR-0008 §3.7.
	"signing_key_id" uuid NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_signatures_signer_role_check"
		CHECK ("signer_role" IN
			('worker_co_chair','mgmt_co_chair','mgmt_external_1','mgmt_external_2')),
	CONSTRAINT "meeting_signatures_signed_method_check"
		CHECK ("signed_method" IN ('in_app_passkey','paper_attestation','email_attestation')),
	-- Method-shape: in_app_passkey rows are worker_co_chair only, carry
	-- step_up_jti + signer_user_id, and have NO evidence_storage_key
	-- nor evidence_envelope_ct. Paper / email rows carry evidence.
	CONSTRAINT "meeting_signatures_method_shape_check" CHECK (
		("signed_method" = 'in_app_passkey'
			AND "signer_role" = 'worker_co_chair'
			AND "step_up_jti" IS NOT NULL
			AND "signer_user_id" IS NOT NULL
			AND "evidence_storage_key" IS NULL
			AND "evidence_envelope_ct" IS NULL
			AND "evidence_envelope_dek_ct" IS NULL)
		OR ("signed_method" IN ('paper_attestation','email_attestation')
			AND "evidence_storage_key" IS NOT NULL
			AND "evidence_envelope_ct" IS NOT NULL
			AND "evidence_envelope_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "meeting_signatures_chain_of_custody_pair_check" CHECK (
		("chain_of_custody_note_ct" IS NULL AND "chain_of_custody_note_dek_ct" IS NULL)
		OR ("chain_of_custody_note_ct" IS NOT NULL AND "chain_of_custody_note_dek_ct" IS NOT NULL)
	),
	-- TM-fold-4 attestation sig: 64-byte Ed25519 detached signature.
	CONSTRAINT "meeting_signatures_attestation_sig_length_check"
		CHECK (octet_length("attestation_signed_ct") = 64),
	CONSTRAINT "meeting_signatures_meeting_fk"
		FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
		ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "meeting_signatures_signer_user_fk"
		FOREIGN KEY ("signer_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "meeting_signatures_signing_key_fk"
		FOREIGN KEY ("signing_key_id") REFERENCES "workplace_signing_keys"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
-- Exactly-one-signature-per-role-per-meeting structural backstop.
CREATE UNIQUE INDEX "meeting_signatures_meeting_role_unique"
	ON "meeting_signatures" USING btree ("meeting_id","signer_role");
--> statement-breakpoint
CREATE INDEX "meeting_signatures_meeting_idx"
	ON "meeting_signatures" USING btree ("meeting_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- meeting_action_item_state — per-meeting snapshot of action_item state
-- ---------------------------------------------------------------------------
--
-- Per S0 user-decision: live rows are retained post-adjournment alongside
-- the finalized row (the full mid-meeting deliberation history stays
-- queryable). The partial UNIQUE on (meeting_id, action_item_id) WHERE
-- snapshot_kind = 'finalized' is the only structural uniqueness — live
-- rows may stack.

CREATE TABLE "meeting_action_item_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"action_item_id" uuid NOT NULL,
	"snapshot_kind" text NOT NULL DEFAULT 'live',
	"snapshot_status" text NOT NULL,
	"snapshot_section" text NOT NULL,
	-- Encrypted assignee display name (PII).
	"snapshot_assignee_ct" "bytea",
	"snapshot_assignee_dek_ct" "bytea",
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_action_item_state_snapshot_kind_check"
		CHECK ("snapshot_kind" IN ('live','finalized')),
	CONSTRAINT "meeting_action_item_state_snapshot_assignee_pair_check" CHECK (
		("snapshot_assignee_ct" IS NULL AND "snapshot_assignee_dek_ct" IS NULL)
		OR ("snapshot_assignee_ct" IS NOT NULL AND "snapshot_assignee_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "meeting_action_item_state_meeting_fk"
		FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
		ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "meeting_action_item_state_action_item_fk"
		FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
-- At most one finalized snapshot per (meeting, action_item). Live rows
-- are unbounded (per S0 user decision — full deliberation history).
CREATE UNIQUE INDEX "meeting_action_item_state_finalized_unique"
	ON "meeting_action_item_state" USING btree ("meeting_id","action_item_id")
	WHERE "snapshot_kind" = 'finalized';
--> statement-breakpoint
CREATE INDEX "meeting_action_item_state_meeting_idx"
	ON "meeting_action_item_state" USING btree ("meeting_id");
--> statement-breakpoint
CREATE INDEX "meeting_action_item_state_action_item_idx"
	ON "meeting_action_item_state" USING btree ("action_item_id");
--> statement-breakpoint
CREATE INDEX "meeting_action_item_state_meeting_kind_idx"
	ON "meeting_action_item_state" USING btree ("meeting_id","snapshot_kind");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Extensions to existing tables
-- ---------------------------------------------------------------------------
--
-- action_items already declared meeting_id in 0005 as a placeholder
-- uuid (no FK; the meetings table didn't yet exist). We retroactively
-- add the FK to meetings(id). first_raised_meeting_id is new —
-- immutable provenance for the meeting an item was first raised in.

ALTER TABLE "action_items"
	ADD COLUMN "first_raised_meeting_id" uuid;
--> statement-breakpoint
ALTER TABLE "action_items"
	ADD CONSTRAINT "action_items_first_raised_meeting_fk"
	FOREIGN KEY ("first_raised_meeting_id") REFERENCES "meetings"("id")
	ON UPDATE RESTRICT ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "action_items"
	ADD CONSTRAINT "action_items_meeting_fk"
	FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
	ON UPDATE RESTRICT ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "action_items_first_raised_meeting_idx"
	ON "action_items" USING btree ("first_raised_meeting_id")
	WHERE "first_raised_meeting_id" IS NOT NULL;
--> statement-breakpoint
-- action_item_moves.meeting_id was likewise a placeholder; promote to FK.
ALTER TABLE "action_item_moves"
	ADD CONSTRAINT "action_item_moves_meeting_fk"
	FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
	ON UPDATE RESTRICT ON DELETE SET NULL;
--> statement-breakpoint

-- recommendations.meeting_id — links a drafted recommendation to the
-- meeting it was raised in (ADR §3.7). Nullable; SET NULL on meeting
-- delete because the recommendation's own lifecycle is governed by
-- ADR-0008 and outlives the meeting record.
ALTER TABLE "recommendations"
	ADD COLUMN "meeting_id" uuid;
--> statement-breakpoint
ALTER TABLE "recommendations"
	ADD CONSTRAINT "recommendations_meeting_fk"
	FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
	ON UPDATE RESTRICT ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "recommendations_meeting_idx"
	ON "recommendations" USING btree ("meeting_id")
	WHERE "meeting_id" IS NOT NULL;
--> statement-breakpoint

-- inspections.triggering_meeting_id — the meeting that requested this
-- inspection, if any. Nullable; SET NULL on meeting delete.
ALTER TABLE "inspections"
	ADD COLUMN "triggering_meeting_id" uuid;
--> statement-breakpoint
ALTER TABLE "inspections"
	ADD CONSTRAINT "inspections_triggering_meeting_fk"
	FOREIGN KEY ("triggering_meeting_id") REFERENCES "meetings"("id")
	ON UPDATE RESTRICT ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "inspections_triggering_meeting_idx"
	ON "inspections" USING btree ("triggering_meeting_id")
	WHERE "triggering_meeting_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- TM-fold-1 (T-ML33) — agenda_template_version existence validation
-- ---------------------------------------------------------------------------
--
-- Validates that meetings.agenda_template_version refers to a real
-- non-retired template at INSERT/UPDATE time. The S4 seed populates v1
-- before any meeting can be created; tests in the DB-dependent suite
-- skip the trigger by seeding a placeholder row first.

CREATE OR REPLACE FUNCTION meetings_agenda_template_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fail-closed: the (template_code='jhsc_standard', version=NEW.agenda_template_version)
  -- row must exist and be non-retired. We DON'T pin the template_code
  -- here — that's the route's responsibility — but we DO require that
  -- SOME template row at this version_number exists and is active.
  IF NOT EXISTS (
    SELECT 1 FROM meeting_templates
    WHERE version_number = NEW.agenda_template_version
      AND retired_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'meetings_agenda_template_version_guard: no active meeting_templates row at version %',
      NEW.agenda_template_version;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meetings_agenda_template_version_guard_trigger
BEFORE INSERT OR UPDATE OF agenda_template_version ON meetings
FOR EACH ROW EXECUTE FUNCTION meetings_agenda_template_version_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at touch triggers (one per table with updated_at)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION meetings_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meetings_touch_updated_at_trigger
BEFORE UPDATE ON meetings
FOR EACH ROW EXECUTE FUNCTION meetings_touch_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION meeting_sections_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meeting_sections_touch_updated_at_trigger
BEFORE UPDATE ON meeting_sections
FOR EACH ROW EXECUTE FUNCTION meeting_sections_touch_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION meeting_attendance_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meeting_attendance_touch_updated_at_trigger
BEFORE UPDATE ON meeting_attendance
FOR EACH ROW EXECUTE FUNCTION meeting_attendance_touch_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION meeting_inspection_review_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meeting_inspection_review_touch_updated_at_trigger
BEFORE UPDATE ON meeting_inspection_review
FOR EACH ROW EXECUTE FUNCTION meeting_inspection_review_touch_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION meeting_action_item_state_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meeting_action_item_state_touch_updated_at_trigger
BEFORE UPDATE ON meeting_action_item_state
FOR EACH ROW EXECUTE FUNCTION meeting_action_item_state_touch_updated_at();
--> statement-breakpoint

-- meeting_signatures has no updated_at (append-only per ADR §3.9). All
-- other 6 mutable tables (meetings, meeting_sections, meeting_attendance,
-- meeting_inspection_review, meeting_action_item_state) carry updated_at
-- and the version-bump trigger.

-- ---------------------------------------------------------------------------
-- Version bump triggers (reuse bump_version_on_update() from 0009)
-- ---------------------------------------------------------------------------

CREATE TRIGGER meetings_bump_version_trigger
BEFORE UPDATE ON meetings
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER meeting_sections_bump_version_trigger
BEFORE UPDATE ON meeting_sections
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER meeting_attendance_bump_version_trigger
BEFORE UPDATE ON meeting_attendance
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER meeting_inspection_review_bump_version_trigger
BEFORE UPDATE ON meeting_inspection_review
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER meeting_action_item_state_bump_version_trigger
BEFORE UPDATE ON meeting_action_item_state
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
-- meeting_signatures is append-only; no version trigger.
-- meeting_templates is append-only; no version trigger.
