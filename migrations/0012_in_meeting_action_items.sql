-- Milestone 2.2 (ADR-0013): In-Meeting Action Item Management — S1.
--
-- One new table + two existing-table extensions + one partial UNIQUE
-- index. Append-only; does not edit any prior migration.
--
-- New table:
--
--   1. action_item_closures — the JHSC counter-sign closure attestation
--      row. Parallel in shape to meeting_signatures (M2.1) but scoped to
--      a single action item's closure verification. Two-distinct-actors
--      invariant enforced via CHECK; selfAttestation flag is the
--      single-rep edge case per ADR §3.5 (the chain records the
--      distinction honestly, no judgment).
--
--      TM-fold-5 (T-IM33): signing_key_id FK to workplace_signing_keys
--      + attestation_signed_ct (64-byte Ed25519 sig over canonical row
--      JSON) for defense-in-depth tamper detection at the workplace-key
--      layer (parity with meeting_signatures.attestation_signed_ct).
--
--      meeting_id is NULLABLE because closure verification can happen
--      outside a meeting too per ADR §3.5 ("closure-verification can
--      happen outside a meeting context"). When set, it carries the
--      meeting in which the closure was verified.
--
--      closure_reason_envelope is the envelope-encrypted free-text
--      rationale. The plaintext never lives in the chain payload
--      (T-AC9); the payload carries only the SHA-256 hash of the
--      ciphertext bytes.
--
--      evidence_storage_key + evidence_envelope are OPTIONAL Tigris-
--      backed evidence (e.g., photo of the corrected condition); pair-
--      NULL CHECK enforces the (storage_key, envelope_ct, envelope_dek)
--      triple is consistent.
--
-- Existing-table extensions:
--
--   2. action_items.closure_verification_id — TM-fold-1 (T-IM3 / T-IM4
--      / T-IM32 / T-IM44). NULLABLE FK to action_item_closures(id) ON
--      DELETE RESTRICT. CHECK enforces the bi-directional invariant
--      `(status = 'Closed') = (closure_verification_id IS NOT NULL)`
--      — closing without counter-sign is structurally impossible at
--      the DB layer; a hand-crafted UPDATE bypassing the route still
--      trips the CHECK. Re-opening flips status away from 'Closed'
--      AND clears closure_verification_id; the prior closure row stays
--      in place (append-only) as historical evidence.
--
--   3. meeting_action_item_state partial UNIQUE — TM-fold-2 (T-IM7 /
--      T-IM11). Partial UNIQUE on (meeting_id, action_item_id,
--      snapshot_status, snapshot_section) WHERE snapshot_kind = 'live'.
--      Dedupes idempotent retries that land the same logical state.
--      Only semantically-distinct status+section combinations
--      accumulate new live snapshot rows. The M2.1 partial UNIQUE on
--      (meeting_id, action_item_id) WHERE snapshot_kind = 'finalized'
--      stays as-is (one finalized per pair).
--
-- The action_item_moves table already carries `meeting_id` since 1.6
-- (per apps/api/src/db/schema.ts:513) and the FK to meetings was added
-- in 0011. No move-table changes needed.
--
-- The workplace_signing_keys table is the M2.1 reference (per
-- meeting_signatures.signing_key_id in 0011). Same registry, same
-- rotation semantics; no new key table.
--
-- Triggers (reuse 0009 helpers): action_item_closures is APPEND-ONLY
-- — no version trigger, no updated_at column. Re-closing after re-open
-- writes a new row + updates action_items.closure_verification_id; the
-- prior row remains for chain-of-custody.

-- ---------------------------------------------------------------------------
-- action_item_closures — JHSC counter-sign closure attestation row
-- ---------------------------------------------------------------------------

CREATE TABLE "action_item_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_item_id" uuid NOT NULL,
	-- Closer = the in-app user who tapped "Close item".
	"closed_by_actor_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Counter-signer = the in-app user who tapped "Counter-sign".
	"counter_signed_by_actor_id" uuid NOT NULL,
	"counter_signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Envelope-encrypted closure rationale. Plaintext is sealed-box
	-- under the workplace public key per the M2.1 attendance-name
	-- pattern; the plaintext is NEVER in the chain payload.
	"closure_reason_envelope_ct" "bytea" NOT NULL,
	"closure_reason_envelope_dek_ct" "bytea" NOT NULL,
	-- Optional Tigris evidence blob. NULL when no evidence attached;
	-- pair-NULL CHECK enforces (storage_key, envelope_ct, envelope_dek)
	-- consistency.
	"evidence_storage_key" text,
	"evidence_envelope_ct" "bytea",
	"evidence_envelope_dek_ct" "bytea",
	-- Single-rep edge case per ADR §3.5. When TRUE, closer ==
	-- counter-signer; the chain payload's selfAttestation: true flag
	-- records the distinction. When FALSE, the two-distinct-actors
	-- invariant CHECK applies.
	"self_attestation" boolean NOT NULL DEFAULT FALSE,
	-- Meeting in which the closure was verified. NULLABLE because
	-- closure verification can happen outside a meeting context per
	-- ADR §3.5; ON DELETE SET NULL because the closure row's
	-- evidentiary value outlives the meeting record.
	"meeting_id" uuid,
	-- TM-fold-5 (T-IM33): workplace signing key the Ed25519 attestation
	-- was produced under. FK so a key rotation history is queryable
	-- (parity with meeting_signatures.signing_key_id from M2.1).
	"signing_key_id" uuid NOT NULL,
	-- TM-fold-5 (T-IM33): Ed25519 detached signature over SHA-256 of
	-- the canonical row JSON. 64 bytes; signed inside the same
	-- transaction that INSERTs the row. Defense-in-depth tamper
	-- detection — a hand-crafted UPDATE that doesn't go through the
	-- route still produces a row whose attestation signature no
	-- longer matches.
	"attestation_signed_ct" "bytea" NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Pair-NULL CHECK for the evidence triple (storage_key + envelope
	-- ct + envelope dek). Either all three are NULL (no evidence) or
	-- all three are NOT NULL (evidence attached).
	CONSTRAINT "action_item_closures_evidence_triple_check" CHECK (
		("evidence_storage_key" IS NULL
			AND "evidence_envelope_ct" IS NULL
			AND "evidence_envelope_dek_ct" IS NULL)
		OR ("evidence_storage_key" IS NOT NULL
			AND "evidence_envelope_ct" IS NOT NULL
			AND "evidence_envelope_dek_ct" IS NOT NULL)
	),
	-- TM-fold-5: 64-byte Ed25519 detached signature length CHECK.
	CONSTRAINT "action_item_closures_attestation_sig_length_check"
		CHECK (octet_length("attestation_signed_ct") = 64),
	-- ADR §3.5 + TM-fold-1: the two-distinct-actors invariant.
	-- When self_attestation = FALSE: closer != counter-signer.
	-- When self_attestation = TRUE: closer == counter-signer (the
	-- single-rep banner path; the chain records the distinction).
	-- Either branch is satisfied; the CHECK rejects mismatched flag.
	CONSTRAINT "action_item_closures_actors_shape_check" CHECK (
		("self_attestation" = FALSE
			AND "closed_by_actor_id" != "counter_signed_by_actor_id")
		OR ("self_attestation" = TRUE
			AND "closed_by_actor_id" = "counter_signed_by_actor_id")
	),
	CONSTRAINT "action_item_closures_action_item_fk"
		FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id")
		ON UPDATE RESTRICT ON DELETE CASCADE,
	CONSTRAINT "action_item_closures_closed_by_actor_fk"
		FOREIGN KEY ("closed_by_actor_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "action_item_closures_counter_signed_by_actor_fk"
		FOREIGN KEY ("counter_signed_by_actor_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "action_item_closures_meeting_fk"
		FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id")
		ON UPDATE RESTRICT ON DELETE SET NULL,
	CONSTRAINT "action_item_closures_signing_key_fk"
		FOREIGN KEY ("signing_key_id") REFERENCES "workplace_signing_keys"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
-- One closure verification per action item (any moment in time).
-- Re-opening + re-closing writes a new row + updates the FK on
-- action_items; the prior row remains for chain-of-custody.
CREATE UNIQUE INDEX "action_item_closures_action_item_unique"
	ON "action_item_closures" USING btree ("action_item_id");
--> statement-breakpoint
CREATE INDEX "action_item_closures_meeting_idx"
	ON "action_item_closures" USING btree ("meeting_id")
	WHERE "meeting_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "action_item_closures_closed_by_actor_idx"
	ON "action_item_closures" USING btree ("closed_by_actor_id");
--> statement-breakpoint
CREATE INDEX "action_item_closures_counter_signed_by_actor_idx"
	ON "action_item_closures" USING btree ("counter_signed_by_actor_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- action_items.closure_verification_id (TM-fold-1 / T-IM3 / T-IM4 / T-IM32)
-- ---------------------------------------------------------------------------
--
-- NULLABLE FK to action_item_closures(id). ON DELETE RESTRICT because a
-- closure row underpins the action item's closed status; the closure
-- row is append-only and never deleted in the normal lifecycle (re-open
-- writes a new closure later; this column's value swaps).
--
-- CHECK enforces the bi-directional invariant:
--   (status = 'Closed') = (closure_verification_id IS NOT NULL)
-- — closing without counter-sign is structurally impossible at the DB
-- layer, and a Closed row with a NULL FK is rejected. Defense in depth
-- against a hand-crafted UPDATE that bypasses the route.

ALTER TABLE "action_items"
	ADD COLUMN "closure_verification_id" uuid;
--> statement-breakpoint
ALTER TABLE "action_items"
	ADD CONSTRAINT "action_items_closure_verification_fk"
	FOREIGN KEY ("closure_verification_id") REFERENCES "action_item_closures"("id")
	ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "action_items"
	ADD CONSTRAINT "action_items_closed_requires_verification_check"
	CHECK (
		("status" = 'Closed' AND "closure_verification_id" IS NOT NULL)
		OR ("status" != 'Closed' AND "closure_verification_id" IS NULL)
	);
--> statement-breakpoint
CREATE INDEX "action_items_closure_verification_idx"
	ON "action_items" USING btree ("closure_verification_id")
	WHERE "closure_verification_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- meeting_action_item_state — TM-fold-2 (T-IM7 / T-IM11) live dedupe
-- ---------------------------------------------------------------------------
--
-- Partial UNIQUE on (meeting_id, action_item_id, snapshot_status,
-- snapshot_section) WHERE snapshot_kind = 'live'. Idempotent retries
-- that land the same logical state are deduped at the structural
-- layer; only semantically-distinct (status, section) combinations
-- accumulate new live snapshot rows for a given (meeting, action_item)
-- pair. The M2.1 finalized partial UNIQUE on (meeting_id, action_item_id)
-- WHERE snapshot_kind = 'finalized' stays as-is — finalized is at-most-
-- one per pair; live is one per distinct (status, section) combination.

CREATE UNIQUE INDEX "meeting_action_item_state_live_dedupe_unique"
	ON "meeting_action_item_state"
	USING btree ("meeting_id", "action_item_id", "snapshot_status", "snapshot_section")
	WHERE "snapshot_kind" = 'live';
--> statement-breakpoint
