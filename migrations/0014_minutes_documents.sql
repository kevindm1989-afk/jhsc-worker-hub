-- Milestone 2.3 (ADR-0014): Minutes Document Generation — S1.
--
-- Two new tables land here:
--
--   1. minutes_documents — append-only per-generation record. Each row
--      represents one rendered PDF. Re-generation produces a NEW row
--      (with `prior_document_id` linking back) + a NEW chain anchor;
--      the prior row + its Tigris object stay in place per ADR §3.5
--      append-only discipline.
--
--      TM-fold-1 (T-MD2 / T-MD29) — SERIALIZABLE + two-pass generation
--      lives at the route layer; the schema's contribution is the
--      UNIQUE (meeting_id, document_hash, render_audience) which makes
--      byte-identical re-generation idempotent.
--
--      TM-fold-2 (T-MD7..T-MD10) — render_audience enum:
--        - 'jhsc_internal'         (full closure reasons + signer narratives)
--        - 'external_distribution' (redacted to hashes + role IDs)
--
--      TM-fold-4 (T-MD24 / T-MD25 / T-MD28) — tigris_storage_key CHECK
--      regex encodes the canonical key shape
--      `minutes/<meetingId>/<utc14>/<documentHash>.pdf`; malformed
--      keys cannot insert.
--
--      TM-fold-5 (T-MD26 / T-MD27) — retention_corpus_entry_hashes
--      JSONB persists the SHA-256 hashes of the OHSA s.9(28) /
--      CLC s.135.2 corpus entries pinned to this document; a future
--      corpus re-seed cannot retroactively change what THIS PDF cited.
--
--      TM-fold-6 (T-MD27) — hold_state enum + envelope-encrypted
--      hold_reason. A document under hold cannot be deleted at the
--      2-year retention boundary; the GC job (forward seam) consults
--      this column. Hold lifecycle is route-level (POST /api/...//hold +
--      /hold-release); the column shape carries placed_at + released_at
--      + the (envelope_ct, envelope_dek_ct) pair-NULL discipline.
--
--      Defense-in-depth (parity with M2.1 meeting_signatures + M2.2
--      action_item_closures): each row carries a 64-byte Ed25519
--      attestation_signed_ct over the canonical row JSON, signed under
--      the active workplace signing key. A hand-crafted UPDATE that
--      bypasses the route still produces a row whose attestation no
--      longer verifies.
--
--   2. minutes_distributions — append-only per-distribution record.
--      One row per recipient per send event (per ADR §3.3.3). No
--      uniqueness constraint on (document_id, recipient_hash) — the
--      same recipient can legitimately receive the same document
--      multiple times (initial distribution + later re-send to the
--      same MLITSD inspector for a follow-up).
--
--      TM-fold-3 (T-MD18 / T-MD23 / T-MD37) — recipient_hash is
--      SHA-256 of canonical `{role, displayName, method}` JSON
--      (computed via apps/api/src/lib/compute-recipient-hash.ts);
--      the chain payload carries ONLY this hash + the role enum +
--      sent_method, NEVER the recipient's plaintext display name.
--      The encrypted display name lives on the row in
--      recipient_display_name_envelope_ct.
--
-- Triggers (reuse the existing version-increment + updated_at trigger
-- functions from 0009 / 0011):
--   - minutes_documents: version-bump + updated_at on UPDATE (UPDATEs
--     are restricted at the route layer to hold_state lifecycle +
--     hold_reason envelope mutations only; the rest of the row is
--     append-only by route discipline).
--   - minutes_distributions: NO updated_at column (distributions are
--     evidentiary records of a discrete send event; editing a prior
--     send is conceptually wrong — a correction is a new row with a
--     correction note. The version trigger fires on theoretical
--     UPDATE but UPDATEs do not happen on this table from any route).
--
-- Append-only — does not edit any prior migration.

-- ---------------------------------------------------------------------------
-- minutes_documents — append-only per-generation record
-- ---------------------------------------------------------------------------

CREATE TABLE "minutes_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"meeting_id" uuid NOT NULL,
	"format_version" text NOT NULL,
	-- TM-fold-2 (T-MD7..T-MD10) — render_audience dual-render enum.
	"render_audience" text NOT NULL,
	-- SHA-256 hex of the rendered PDF bytes. 64 lowercase hex chars.
	"document_hash" text NOT NULL,
	"document_size_bytes" integer NOT NULL,
	-- TM-fold-4 (T-MD24 / T-MD25 / T-MD28) — canonical Tigris key shape.
	"tigris_storage_key" text NOT NULL,
	-- Chain of regenerations (NULL on the initial generation; FK to
	-- the prior row on each re-generation per ADR §3.5).
	"prior_document_id" uuid,
	-- Optional free-text label for WHY a regeneration was performed.
	-- Enum-constrained at the Zod layer (layout_fix / corpus_update /
	-- signature_added / typo_fix / other); the SQL layer just stores
	-- the text without semantic check.
	"regeneration_reason" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_actor_id" uuid NOT NULL,
	-- TM-fold-6 (T-MD27) — hold lifecycle. 'none' is the default;
	-- the route layer transitions via POST /hold + /hold-release.
	-- Envelope-encrypted hold_reason is paired-NULL with hold_state.
	"hold_state" text NOT NULL DEFAULT 'none',
	"hold_reason_envelope_ct" "bytea",
	"hold_reason_envelope_dek_ct" "bytea",
	"hold_placed_at" timestamp with time zone,
	"hold_released_at" timestamp with time zone,
	-- Workplace signing key the attestation_signed_ct was produced
	-- under. FK so key rotations are queryable (parity with M2.1
	-- meeting_signatures + M2.2 action_item_closures).
	"signing_key_id" uuid NOT NULL,
	-- Defense-in-depth: 64-byte Ed25519 detached signature over the
	-- canonical row JSON. Signed inside the same transaction that
	-- INSERTs the row.
	"attestation_signed_ct" "bytea" NOT NULL,
	-- TM-fold-5 (T-MD26 / T-MD27) — array of SHA-256 hex hashes of
	-- legal-corpus entries (OHSA s.9(28) for ON; CLC s.135.2 for
	-- CA-FED) pinned to this document. A future corpus re-seed cannot
	-- retroactively change what THIS PDF cited.
	"retention_corpus_entry_hashes" jsonb NOT NULL,
	-- audit_log.idx of the minutes_document.generated chain row.
	-- FK + UNIQUE invariant (mirrors M2.1 / M2.2 audit_idx pattern).
	"audit_idx" bigint NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "minutes_documents_format_version_check"
		CHECK ("format_version" IN ('v1')),
	CONSTRAINT "minutes_documents_render_audience_check"
		CHECK ("render_audience" IN ('jhsc_internal','external_distribution')),
	CONSTRAINT "minutes_documents_document_hash_length_check"
		CHECK ("document_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "minutes_documents_document_size_check"
		CHECK ("document_size_bytes" > 0),
	-- TM-fold-4: canonical Tigris key regex.
	CONSTRAINT "minutes_documents_tigris_storage_key_shape_check"
		CHECK ("tigris_storage_key" ~ '^minutes/[0-9a-f-]{36}/[0-9]{14}/[0-9a-f]{64}\.pdf$'),
	CONSTRAINT "minutes_documents_hold_state_check"
		CHECK ("hold_state" IN ('none','subpoena_hold','mlitsd_hold','litigation_hold')),
	-- Hold envelope pair-NULL: ct + dek_ct + placed_at are all NULL
	-- iff hold_state = 'none'. The route layer enforces the inverse
	-- (transition out of 'none' requires the envelope + placed_at).
	CONSTRAINT "minutes_documents_hold_envelope_pair_check" CHECK (
		("hold_state" = 'none'
			AND "hold_reason_envelope_ct" IS NULL
			AND "hold_reason_envelope_dek_ct" IS NULL
			AND "hold_placed_at" IS NULL)
		OR ("hold_state" != 'none'
			AND "hold_reason_envelope_ct" IS NOT NULL
			AND "hold_reason_envelope_dek_ct" IS NOT NULL
			AND "hold_placed_at" IS NOT NULL)
	),
	-- Hold release timestamp ordering sanity (defense-in-depth: a
	-- hand-crafted UPDATE that backdates a release would trip).
	CONSTRAINT "minutes_documents_hold_released_after_placed_check" CHECK (
		"hold_released_at" IS NULL
		OR ("hold_placed_at" IS NOT NULL AND "hold_released_at" > "hold_placed_at")
	),
	-- 64-byte Ed25519 detached signature length CHECK.
	CONSTRAINT "minutes_documents_attestation_sig_length_check"
		CHECK (octet_length("attestation_signed_ct") = 64),
	-- retention_corpus_entry_hashes must be a JSONB array (TM-fold-5).
	CONSTRAINT "minutes_documents_retention_hashes_is_array_check"
		CHECK (jsonb_typeof("retention_corpus_entry_hashes") = 'array'),
	CONSTRAINT "minutes_documents_meeting_fk"
		FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "minutes_documents_prior_document_fk"
		FOREIGN KEY ("prior_document_id") REFERENCES "minutes_documents"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "minutes_documents_generated_by_actor_fk"
		FOREIGN KEY ("generated_by_actor_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "minutes_documents_signing_key_fk"
		FOREIGN KEY ("signing_key_id") REFERENCES "workplace_signing_keys"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "minutes_documents_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
-- TM-fold-1 idempotency: byte-identical regeneration for the same
-- meeting + audience returns the existing row (route's pre-INSERT
-- check) rather than failing on UNIQUE violation; the UNIQUE here
-- is the structural backstop.
CREATE UNIQUE INDEX "minutes_documents_meeting_hash_audience_unique"
	ON "minutes_documents"
	USING btree ("meeting_id","document_hash","render_audience");
--> statement-breakpoint
CREATE UNIQUE INDEX "minutes_documents_audit_idx_unique"
	ON "minutes_documents" USING btree ("audit_idx");
--> statement-breakpoint
CREATE UNIQUE INDEX "minutes_documents_tigris_storage_key_unique"
	ON "minutes_documents" USING btree ("tigris_storage_key");
--> statement-breakpoint
CREATE INDEX "minutes_documents_meeting_idx"
	ON "minutes_documents" USING btree ("meeting_id");
--> statement-breakpoint
CREATE INDEX "minutes_documents_generated_at_idx"
	ON "minutes_documents" USING btree ("generated_at" DESC);
--> statement-breakpoint
-- Partial index: only documents under hold (TM-fold-6 GC consultation).
CREATE INDEX "minutes_documents_hold_state_idx"
	ON "minutes_documents" USING btree ("hold_state")
	WHERE "hold_state" != 'none';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- minutes_distributions — append-only per-distribution record
-- ---------------------------------------------------------------------------

CREATE TABLE "minutes_distributions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	-- Recipient role enum — 7 generic ids + 2 workplace_role_X slots
	-- per non-negotiable #1. Display labels for workplace_role_1 +
	-- workplace_role_2 come from env vars at runtime
	-- (MINUTES_RECIPIENT_ROLE_WORKPLACE_1_LABEL /
	--  MINUTES_RECIPIENT_ROLE_WORKPLACE_2_LABEL); the SOURCE has zero
	-- workplace-specific role labels (S0 Q4 split source-vs-env rule).
	"recipient_role" text NOT NULL,
	-- TM-fold-3 (T-MD18 / T-MD23 / T-MD37): encrypted display name.
	-- NO plaintext name column anywhere — the only carriers are the
	-- envelope (decryptable under the workplace KEK) and the
	-- recipient_hash (SHA-256 of canonical {role, displayName, method}).
	"recipient_display_name_envelope_ct" "bytea" NOT NULL,
	"recipient_display_name_envelope_dek_ct" "bytea" NOT NULL,
	-- TM-fold-3: chain-payload-safe identifier. 64 lowercase hex chars.
	"recipient_hash" text NOT NULL,
	-- Out-of-band send method enum.
	"sent_method" text NOT NULL,
	-- The rep's recorded send time (may be back-dated per ADR §3.3.2).
	"sent_at" timestamp with time zone NOT NULL,
	"sent_by_actor_id" uuid NOT NULL,
	-- audit_log.idx of the minutes_document.distributed chain row.
	"audit_idx" bigint NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "minutes_distributions_recipient_role_check"
		CHECK ("recipient_role" IN (
			'mgmt_co_chair','worker_rep','mgmt_rep','union_local',
			'mlitsd_inspector','legal_counsel','other',
			'workplace_role_1','workplace_role_2'
		)),
	CONSTRAINT "minutes_distributions_recipient_hash_length_check"
		CHECK ("recipient_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "minutes_distributions_sent_method_check"
		CHECK ("sent_method" IN ('email','printed_handoff','portal_upload','in_person')),
	CONSTRAINT "minutes_distributions_document_fk"
		FOREIGN KEY ("document_id") REFERENCES "minutes_documents"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "minutes_distributions_sent_by_actor_fk"
		FOREIGN KEY ("sent_by_actor_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "minutes_distributions_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
-- Per ADR §3.1.2: NO UNIQUE on (document_id, recipient_hash). Same
-- recipient receiving the same document multiple times is a
-- legitimate evidentiary case (initial distribution + later re-send).
CREATE UNIQUE INDEX "minutes_distributions_audit_idx_unique"
	ON "minutes_distributions" USING btree ("audit_idx");
--> statement-breakpoint
CREATE INDEX "minutes_distributions_document_idx"
	ON "minutes_distributions" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "minutes_distributions_recipient_hash_idx"
	ON "minutes_distributions" USING btree ("recipient_hash");
--> statement-breakpoint
CREATE INDEX "minutes_distributions_sent_at_idx"
	ON "minutes_distributions" USING btree ("sent_at" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
--
-- Reuse the existing bump_version_on_update() function from 0009.
-- minutes_documents carries updated_at + version (UPDATEs are scoped
-- to hold_state lifecycle; the rest of the row is route-level
-- append-only by discipline). minutes_distributions is evidentiary
-- record-of-a-discrete-event and is never UPDATEd from any route;
-- the version-bump trigger is omitted (and updated_at column is
-- omitted) so a misbehaving UPDATE leaves no version-bump trail
-- masking the misbehavior.

CREATE OR REPLACE FUNCTION minutes_documents_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER minutes_documents_touch_updated_at_trigger
BEFORE UPDATE ON minutes_documents
FOR EACH ROW EXECUTE FUNCTION minutes_documents_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER minutes_documents_bump_version_trigger
BEFORE UPDATE ON minutes_documents
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
