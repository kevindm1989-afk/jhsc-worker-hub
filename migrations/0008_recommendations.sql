-- Milestone 1.9 (ADR-0008): recommendations + recommendation_citations +
-- recommendation_responses + recommendation_action_item_links +
-- workplace_signing_keys, plus the export_records + inspection_findings
-- column extensions and the trigger ratchets that extend
-- evidence_files_linked_fk_guard + action_items_source_fk_guard with a
-- 'recommendation' branch.
--
-- Five new tables anchor the recommendation surface:
--   - recommendations: envelope-encrypted title + body; per-jurisdiction
--     recommendation_number allocated via the 1.6 advisory-lock helper
--     (scope `recommendation.number.<jurisdiction>`); state-machine
--     lifecycle enforced by a single CHECK that asserts status +
--     submitted_at + resolved_at + withdrawn_at consistency.
--   - recommendation_citations: position-ordered resolved triples
--     (statute_code, clause_id, version_date). NO FK to legal_clauses;
--     the corpus is append-only-versioned and the Zod check at submit
--     is the gate (documented residual T-R7).
--   - recommendation_responses: append-only by position; UNIQUE
--     (recommendation_id, position); CHECK position <= 50 (T-R42 cap);
--     envelope-encrypted body + author_role.
--   - recommendation_action_item_links: link_kind 'tracks' (used in 1.9)
--     + 'replaces' (forward seam); UNIQUE (action_item_id) enforces
--     at-most-one-rec-per-action-item (T-R13).
--   - workplace_signing_keys: Ed25519 32-byte public key + envelope-
--     encrypted private; partial UNIQUE on (active) WHERE active = true
--     mirrors workplace_keys (1.7); retirement-pair CHECK; rotation
--     forward-seam to 1.12.
--
-- export_records extension (ADR-0008 §3.11):
--   - Drop + recreate the kind CHECK to include 'recommendation_single'.
--   - ADD signing_key_id + signature_sha256 nullable columns.
--   - ADD a consistency CHECK enforcing kind/signing-column alignment.
--   - The four-nullable-columns + 1-CHECK shape is the documented
--     tradeoff vs a sibling recommendation_exports table. T-R31
--     migration-test posture: existing 1.8-era rows ('single','batch')
--     satisfy the new alignment because signing_key_id / signature_sha256
--     stay NULL.
--
-- inspection_findings extension (ADR-0008 §3.12, 1.8 priv-F8 close-out):
--   - ADD responsible_party_kind (NULL / 'user_ref' / 'name_text').
--   - ADD responsible_party_user_id FK to users.
--   - ADD consistency CHECK on kind/_user_id/_ct alignment.
--   - Non-destructive (T-R40): every pre-1.9 row has NULL kind and
--     either NULL _ct or the existing encrypted-name path, both of
--     which satisfy the CHECK.
--
-- Trigger ratchets (T-R14 + T-R38):
--   - action_items_source_fk_guard gains a 'recommendation' branch.
--     Preserves manual/excel_import/NULL skip + hazard + inspection
--     branches + fail-closed ELSE rail verbatim (1.6 priv-AI-F3 /
--     1.7 sec-F4 / 1.8 T-I38 close-out shape).
--   - evidence_files_linked_fk_guard gains a 'recommendation' branch.
--     Preserves hazard / action_item / inspection_finding branches +
--     ELSE rail verbatim (1.7 sec-F4 / 1.8 T-I14 close-out shape).
--   The route-layer allow-list ratchet (route-side `acceptedLinkedTypes`
--   for evidence and `sourceType` for action items) lands in S2 paired
--   with these trigger branches per ADR-0008 §3.13.

CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Per-jurisdiction-period sequence; allocated by the 1.6 advisory-lock
	-- helper with scope `recommendation.number.<jurisdiction>` (S2 wires
	-- the route). Globally non-monotonic by design — ON-2026-014 and
	-- CA-FED-2026-003 are both well-formed simultaneously.
	"recommendation_number" integer NOT NULL,
	-- Envelope-encrypted title (maximally sensitive — supervisor names,
	-- accommodation context, reprisal narratives). Pair-NOT-NULL is
	-- implicit since both are NOT NULL; the length CHECK rejects empty
	-- ciphertext payloads (defensive — empty bytea would mean a
	-- malformed seal).
	"title_ct" "bytea" NOT NULL,
	"title_dek_ct" "bytea" NOT NULL,
	-- Envelope-encrypted long-form prose (200-2000 words typical).
	"body_ct" "bytea" NOT NULL,
	"body_dek_ct" "bytea" NOT NULL,
	"jurisdiction" text NOT NULL,
	"status" text NOT NULL DEFAULT 'draft',
	"drafted_by_user_id" uuid NOT NULL,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- NULL until submit; gating column for the 21-day clock.
	"submitted_at" timestamp with time zone,
	-- NULL until resolved.
	"resolved_at" timestamp with time zone,
	-- NULL unless withdrawn.
	"withdrawn_at" timestamp with time zone,
	-- The ONE plaintext field on a withdrawn rec: template-supplied,
	-- PI-clean enum-like values (e.g. "no_longer_relevant",
	-- "superseded_by_new_recommendation", "issue_resolved_without_formal_response").
	-- Bounded to 200 chars at SQL layer; the route layer's Zod enum is
	-- the tighter gate. The rep's *free-text* reason for withdrawal lives
	-- nowhere — withdrawal reason is template-only by design (the
	-- audit-payload variant carries no reason field; ADR-0008 §3.1).
	"withdrawn_reason" text,
	"audit_idx" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_recommendation_number_positive_check"
		CHECK ("recommendation_number" > 0),
	CONSTRAINT "recommendations_title_ct_length_check"
		CHECK (octet_length("title_ct") > 0 AND octet_length("title_dek_ct") > 0),
	CONSTRAINT "recommendations_body_ct_length_check"
		CHECK (octet_length("body_ct") > 0 AND octet_length("body_dek_ct") > 0),
	CONSTRAINT "recommendations_jurisdiction_check"
		CHECK ("jurisdiction" IN ('ON','CA-FED')),
	CONSTRAINT "recommendations_status_check"
		CHECK ("status" IN ('draft','submitted','response_received','resolved','withdrawn')),
	CONSTRAINT "recommendations_withdrawn_reason_length_check"
		CHECK ("withdrawn_reason" IS NULL OR char_length("withdrawn_reason") <= 200),
	-- Single composite lifecycle invariant: each status pins exactly the
	-- set of timestamp columns that must be NULL vs NOT NULL. Mirrors
	-- the partial-NULL CHECK shape used in 0007 inspection_findings.
	-- This is the structural backstop for T-R1 (hand-crafted PATCH from
	-- draft→resolved) — even a bypassed route can't land an inconsistent
	-- row.
	CONSTRAINT "recommendations_lifecycle_check" CHECK (
		(
			"status" = 'draft'
			AND "submitted_at" IS NULL
			AND "resolved_at" IS NULL
			AND "withdrawn_at" IS NULL
		)
		OR (
			"status" = 'submitted'
			AND "submitted_at" IS NOT NULL
			AND "resolved_at" IS NULL
			AND "withdrawn_at" IS NULL
		)
		OR (
			"status" = 'response_received'
			AND "submitted_at" IS NOT NULL
			AND "resolved_at" IS NULL
			AND "withdrawn_at" IS NULL
		)
		OR (
			"status" = 'resolved'
			AND "submitted_at" IS NOT NULL
			AND "resolved_at" IS NOT NULL
			AND "withdrawn_at" IS NULL
		)
		OR (
			"status" = 'withdrawn'
			AND "withdrawn_at" IS NOT NULL
			AND "resolved_at" IS NULL
		)
	),
	-- Per-jurisdiction-period numbering. The advisory-lock helper
	-- (scope `recommendation.number.<jurisdiction>`) serializes the
	-- SELECT-MAX→INSERT critical section; UNIQUE is the structural
	-- backstop for T-R5 sequence collisions.
	CONSTRAINT "recommendations_jurisdiction_number_unique"
		UNIQUE ("jurisdiction", "recommendation_number"),
	CONSTRAINT "recommendations_drafted_by_fk"
		FOREIGN KEY ("drafted_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "recommendations_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_audit_idx_unique"
	ON "recommendations" USING btree ("audit_idx");--> statement-breakpoint
CREATE INDEX "recommendations_status_idx" ON "recommendations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recommendations_jurisdiction_idx" ON "recommendations" USING btree ("jurisdiction");--> statement-breakpoint
CREATE INDEX "recommendations_drafted_by_idx" ON "recommendations" USING btree ("drafted_by_user_id");--> statement-breakpoint
CREATE INDEX "recommendations_submitted_at_idx" ON "recommendations" USING btree ("submitted_at");
--> statement-breakpoint
CREATE TABLE "recommendation_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"statute_code" text NOT NULL,
	-- clause_id is the legal-corpus row identifier. Stored as text (not
	-- uuid FK) because the corpus is append-only-versioned and a hard
	-- FK to legal_clauses would block a corpus rotation that retires a
	-- clause referenced by an old recommendation. The Zod check at
	-- submit time is the gate (documented residual T-R7); direct SQL
	-- INSERT is the bypass surface and is itself documented.
	"clause_id" text NOT NULL,
	"version_date" date NOT NULL,
	-- 1-indexed; matches the [[cite:N]] markers in the encrypted body.
	-- Dense (1..K with no gaps) is asserted by the route's Zod
	-- refinement at submit, not by SQL.
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_citations_position_positive_check"
		CHECK ("position" >= 1),
	CONSTRAINT "recommendation_citations_recommendation_position_unique"
		UNIQUE ("recommendation_id", "position"),
	CONSTRAINT "recommendation_citations_recommendation_fk"
		FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "recommendation_citations_recommendation_idx"
	ON "recommendation_citations" USING btree ("recommendation_id");
--> statement-breakpoint
CREATE TABLE "recommendation_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	-- 1-indexed; append-only. T-R10 close-out: the route's SELECT-MAX
	-- + advisory-lock serializes concurrent appenders; UNIQUE is the
	-- structural backstop.
	"position" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by_user_id" uuid NOT NULL,
	-- Encrypted role string ("VP Operations", "Plant Manager"). External
	-- counterparty role; combined with the workplace name (config/) it
	-- identifies a specific human, hence envelope-encrypted (ADR-0008
	-- §3.4).
	"author_role_ct" "bytea" NOT NULL,
	"author_role_dek_ct" "bytea" NOT NULL,
	-- Encrypted response body.
	"body_ct" "bytea" NOT NULL,
	"body_dek_ct" "bytea" NOT NULL,
	"audit_idx" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_responses_position_positive_check"
		CHECK ("position" >= 1),
	-- T-R42 cap: the soft-50 ceiling is enforced at the route layer with
	-- 422 `response_cap_exceeded`. The SQL cap is the structural backstop
	-- to bound the response-appendix render in the PDF (S4) even if the
	-- route layer is bypassed.
	CONSTRAINT "recommendation_responses_position_cap_check"
		CHECK ("position" <= 50),
	CONSTRAINT "recommendation_responses_author_role_length_check"
		CHECK (octet_length("author_role_ct") > 0 AND octet_length("author_role_dek_ct") > 0),
	CONSTRAINT "recommendation_responses_body_length_check"
		CHECK (octet_length("body_ct") > 0 AND octet_length("body_dek_ct") > 0),
	CONSTRAINT "recommendation_responses_recommendation_position_unique"
		UNIQUE ("recommendation_id", "position"),
	CONSTRAINT "recommendation_responses_recommendation_fk"
		FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "recommendation_responses_received_by_fk"
		FOREIGN KEY ("received_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "recommendation_responses_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_responses_audit_idx_unique"
	ON "recommendation_responses" USING btree ("audit_idx");--> statement-breakpoint
CREATE INDEX "recommendation_responses_recommendation_idx"
	ON "recommendation_responses" USING btree ("recommendation_id");
--> statement-breakpoint
CREATE TABLE "recommendation_action_item_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"action_item_id" uuid NOT NULL,
	-- 'tracks' is the standard case in 1.9; 'replaces' is a forward
	-- seam for the rec-supersedes-an-earlier-hazard pattern (ADR-0008
	-- §3.5; UI deferred to Release 2). The DB CHECK accepts both;
	-- the 1.9 route only writes 'tracks'.
	"link_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_action_item_links_link_kind_check"
		CHECK ("link_kind" IN ('tracks','replaces')),
	CONSTRAINT "recommendation_action_item_links_recommendation_action_unique"
		UNIQUE ("recommendation_id", "action_item_id"),
	-- T-R13: at most ONE recommendation links to any given action_item
	-- in 1.9. The 'replaces' link kind opens a future where a rec
	-- *replaces* a prior rec's action item, but that flow lives in
	-- Release 2 and would relax this UNIQUE then.
	CONSTRAINT "recommendation_action_item_links_action_item_unique"
		UNIQUE ("action_item_id"),
	CONSTRAINT "recommendation_action_item_links_recommendation_fk"
		FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "recommendation_action_item_links_action_item_fk"
		FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "recommendation_action_item_links_recommendation_idx"
	ON "recommendation_action_item_links" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "recommendation_action_item_links_action_item_idx"
	ON "recommendation_action_item_links" USING btree ("action_item_id");
--> statement-breakpoint
CREATE TABLE "workplace_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- algorithm CHECK is currently single-valued; the column exists for
	-- the forward-seam to a future rotation (Ed448, post-quantum) per
	-- ADR-0008 §3.7. Adding a new value lands in a future migration as
	-- a CHECK relax.
	"algorithm" text NOT NULL DEFAULT 'ed25519',
	"active" boolean NOT NULL DEFAULT true,
	-- Ed25519 public key is exactly 32 bytes. Strict length CHECK so a
	-- corrupted seed insert is rejected at the DB layer.
	"public_key" "bytea" NOT NULL,
	-- Envelope-encrypted Ed25519 private key sealed under the workplace
	-- KEK (MASTER_KEY in Fly Secrets). Same shape as workplace_keys
	-- 1.7's private_key_ct.
	"private_key_ct" "bytea" NOT NULL,
	"private_key_dek_ct" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "workplace_signing_keys_algorithm_check"
		CHECK ("algorithm" IN ('ed25519')),
	CONSTRAINT "workplace_signing_keys_public_key_length_check"
		CHECK (octet_length("public_key") = 32),
	-- Retirement pair: an active key has no retired_at; a retired key
	-- keeps active=false. Mirrors workplace_keys (1.7) discipline. T-R19
	-- structural backstop pairs with the partial UNIQUE INDEX below.
	CONSTRAINT "workplace_signing_keys_retirement_check" CHECK (
		("active" = true AND "retired_at" IS NULL)
		OR ("active" = false AND "retired_at" IS NOT NULL)
	)
);
--> statement-breakpoint
-- T-R19 close-out: at most one active row enforced at the DB layer.
-- A second active=true INSERT fails with 23505. Mirrors the
-- workplace_keys_only_one_active partial UNIQUE from 0006.
CREATE UNIQUE INDEX "workplace_signing_keys_only_one_active"
	ON "workplace_signing_keys" USING btree ("active") WHERE "active" = true;--> statement-breakpoint
CREATE INDEX "workplace_signing_keys_active_idx"
	ON "workplace_signing_keys" USING btree ("active");
--> statement-breakpoint
-- export_records extension (ADR-0008 §3.11). T-R31 migration-safety:
-- existing 1.8-era rows ('single' / 'batch') satisfy the new CHECK
-- because the four added columns are nullable and start NULL on
-- pre-1.9 rows; the new alignment CHECK accepts that shape.
ALTER TABLE "export_records"
	DROP CONSTRAINT "export_records_kind_check";--> statement-breakpoint
ALTER TABLE "export_records"
	ADD CONSTRAINT "export_records_kind_check"
	CHECK ("kind" IN ('single','batch','recommendation_single'));--> statement-breakpoint
-- signing_key_id is the durable pointer to the workplace_signing_keys
-- row that produced the signature. Nullable: inspection exports never
-- have one. Verification of past exports consults this id forever (a
-- retired key stays queryable per ADR-0008 §3.7).
ALTER TABLE "export_records"
	ADD COLUMN "signing_key_id" uuid REFERENCES "workplace_signing_keys"("id")
	ON UPDATE RESTRICT ON DELETE RESTRICT;--> statement-breakpoint
-- signature_sha256 is the hex SHA-256 of the 64-byte Ed25519 detached
-- signature (over the PDF bytes, per ADR-0008 §3.9). The signature
-- itself is 64 bytes; its SHA-256 is the 32-byte chain-payload anchor.
-- Nullable: inspection exports never have one. Length CHECK is
-- conditional on non-NULL so existing 1.8 rows validate untouched.
ALTER TABLE "export_records"
	ADD COLUMN "signature_sha256" "bytea";--> statement-breakpoint
ALTER TABLE "export_records"
	ADD CONSTRAINT "export_records_signature_sha256_length_check"
	CHECK ("signature_sha256" IS NULL OR octet_length("signature_sha256") = 32);--> statement-breakpoint
-- Consistency CHECK enforces the kind/signing-column alignment:
-- inspection exports MUST have NULL signing fields; recommendation
-- exports MUST have non-NULL signing fields. Fail-closed (T-R31).
ALTER TABLE "export_records"
	ADD CONSTRAINT "export_records_kind_signing_alignment_check" CHECK (
		(
			"kind" IN ('single','batch')
			AND "signing_key_id" IS NULL
			AND "signature_sha256" IS NULL
		)
		OR (
			"kind" = 'recommendation_single'
			AND "signing_key_id" IS NOT NULL
			AND "signature_sha256" IS NOT NULL
		)
	);
--> statement-breakpoint
-- inspection_findings extension (ADR-0008 §3.12, 1.8 priv-F8 close-out).
-- Non-destructive (T-R40): existing rows have NULL responsible_party_kind
-- + either NULL responsible_party_ct (open finding) or the existing
-- encrypted-name path with NULL responsible_party_user_id — both
-- satisfy the consistency CHECK below.
ALTER TABLE "inspection_findings"
	ADD COLUMN "responsible_party_kind" text;--> statement-breakpoint
ALTER TABLE "inspection_findings"
	ADD CONSTRAINT "inspection_findings_responsible_party_kind_check" CHECK (
		"responsible_party_kind" IS NULL
		OR "responsible_party_kind" IN ('user_ref','name_text')
	);--> statement-breakpoint
ALTER TABLE "inspection_findings"
	ADD COLUMN "responsible_party_user_id" uuid REFERENCES "users"("id")
	ON UPDATE RESTRICT ON DELETE RESTRICT;--> statement-breakpoint
-- Consistency CHECK: when kind = 'user_ref', the FK column is set and
-- the encrypted-name pair is NULL; when kind = 'name_text', the FK is
-- NULL and the encrypted-name pair is set; when kind IS NULL, both
-- refs are NULL. Existing pre-1.9 rows with the encrypted-name path
-- read as `kind IS NULL + ct IS NOT NULL` until a write opts them
-- into 'name_text'; the route layer (S2) handles the soft migration
-- on first edit.
ALTER TABLE "inspection_findings"
	ADD CONSTRAINT "inspection_findings_responsible_party_alignment_check" CHECK (
		(
			"responsible_party_kind" IS NULL
			AND "responsible_party_user_id" IS NULL
		)
		OR (
			"responsible_party_kind" = 'user_ref'
			AND "responsible_party_user_id" IS NOT NULL
			AND "responsible_party_ct" IS NULL
			AND "responsible_party_dek_ct" IS NULL
		)
		OR (
			"responsible_party_kind" = 'name_text'
			AND "responsible_party_user_id" IS NULL
			AND "responsible_party_ct" IS NOT NULL
			AND "responsible_party_dek_ct" IS NOT NULL
		)
	);
--> statement-breakpoint
-- updated_at trigger for recommendations — same shape as 0007.
CREATE OR REPLACE FUNCTION recommendations_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recommendations_touch_updated_at_trigger
BEFORE UPDATE ON recommendations
FOR EACH ROW EXECUTE FUNCTION recommendations_touch_updated_at();
--> statement-breakpoint
-- T-R14 close-out: extend action_items_source_fk_guard with a
-- 'recommendation' branch alongside this slice's table creation.
-- CREATE OR REPLACE re-emits the existing skip rail (manual /
-- excel_import / NULL), 'hazard' branch, 'inspection' branch, and the
-- fail-closed ELSE rail verbatim from 0007 plus the new branch.
-- Preserving every prior branch is load-bearing: a half-rewritten
-- function would silently accept what 0007 already rejected.
CREATE OR REPLACE FUNCTION action_items_source_fk_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Skip referential validation for the documented bypass cases. NULL
  -- source_type is the legacy default from migrations 0005; 'manual' and
  -- 'excel_import' have no backing table by design (priv-AI-F3 1.6
  -- documented residual).
  IF NEW.source_type IS NULL OR NEW.source_type IN ('manual','excel_import') THEN
    RETURN NEW;
  END IF;

  IF NEW.source_type = 'hazard' THEN
    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM hazards WHERE id = NEW.source_id) THEN
      RAISE EXCEPTION
        'action_items_source_fk_guard: hazard % does not exist', NEW.source_id;
    END IF;
  ELSIF NEW.source_type = 'inspection' THEN
    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM inspection_findings WHERE id = NEW.source_id) THEN
      RAISE EXCEPTION
        'action_items_source_fk_guard: inspection_finding % does not exist', NEW.source_id;
    END IF;
  ELSIF NEW.source_type = 'recommendation' THEN
    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM recommendations WHERE id = NEW.source_id) THEN
      RAISE EXCEPTION
        'action_items_source_fk_guard: recommendation % does not exist', NEW.source_id;
    END IF;
  ELSE
    -- Fail-closed rail for any source_type the trigger does not yet
    -- recognize (incident, future kinds). The route's Zod refinement
    -- is the upstream gate; this is the DB-layer backstop against a
    -- hand-crafted INSERT.
    RAISE EXCEPTION
      'action_items_source_fk_guard: source_type % not yet supported at trigger layer',
      NEW.source_type;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- T-R38 close-out: extend evidence_files_linked_fk_guard with a
-- 'recommendation' branch. ADR-0008 §3.13 opens 'recommendation' as
-- an accepted evidence linkedType — a rec can carry evidence files
-- (photos of failed safety measures, supporting documents). CREATE OR
-- REPLACE re-emits the 'hazard', 'action_item', 'inspection_finding'
-- branches from 0007 verbatim plus the new branch and the fail-closed
-- ELSE rail. The route-layer allow-list extension lands in S2 paired
-- with this trigger branch.
CREATE OR REPLACE FUNCTION evidence_files_linked_fk_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.linked_type = 'hazard' THEN
    IF NOT EXISTS (SELECT 1 FROM hazards WHERE id = NEW.linked_id) THEN
      RAISE EXCEPTION
        'evidence_files_linked_fk_guard: hazard % does not exist', NEW.linked_id;
    END IF;
  ELSIF NEW.linked_type = 'action_item' THEN
    IF NOT EXISTS (SELECT 1 FROM action_items WHERE id = NEW.linked_id) THEN
      RAISE EXCEPTION
        'evidence_files_linked_fk_guard: action_item % does not exist', NEW.linked_id;
    END IF;
  ELSIF NEW.linked_type = 'inspection_finding' THEN
    IF NOT EXISTS (SELECT 1 FROM inspection_findings WHERE id = NEW.linked_id) THEN
      RAISE EXCEPTION
        'evidence_files_linked_fk_guard: inspection_finding % does not exist', NEW.linked_id;
    END IF;
  ELSIF NEW.linked_type = 'recommendation' THEN
    IF NOT EXISTS (SELECT 1 FROM recommendations WHERE id = NEW.linked_id) THEN
      RAISE EXCEPTION
        'evidence_files_linked_fk_guard: recommendation % does not exist', NEW.linked_id;
    END IF;
  ELSE
    RAISE EXCEPTION
      'evidence_files_linked_fk_guard: linked_type % not yet supported at trigger layer',
      NEW.linked_type;
  END IF;
  RETURN NEW;
END;
$$;
