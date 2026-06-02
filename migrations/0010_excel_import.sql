-- Milestone 1.11 (ADR-0010): Excel-import lifecycle tables.
--
-- Two new tables land here:
--
--   1. excel_imports — the batch-level record. One row per uploaded
--      workbook. Status enum walks pending → preview → committed /
--      cancelled; a committed import can later flip to reversed via
--      the 30-day reverse path (ADR §3.11). The state-consistency
--      CHECK enforces the (status, *_at) tuples are coherent so a
--      drifted route handler cannot land a row in a contradictory
--      shape (T-X35 / T-X38 backstop).
--
--      Three encrypted column pairs carry PI: source_filename_ct
--      (T-X19 — filenames frequently leak workplace identity per
--      non-negotiable #1); inspection_review_snapshot_ct (T-X13 —
--      the inspection-review notes often carry supervisor / witness
--      names); each pair has a pair-NULL CHECK so the dek_ct cannot
--      go missing.
--
--      source_sha256 is PLAINTEXT — it's a content hash, not the
--      content (T-X43). It's the file-level integrity anchor for the
--      chain; the excel_import.uploaded + excel_import.committed
--      payloads echo it. Re-importing the same bytes yields the same
--      hash → reconciliation classifies every row as skipped (the
--      idempotent re-import path per ADR §3.6).
--
--      audit_idx FK to audit_log.idx is the chain-anchor link
--      (UNIQUE — 1-to-1 with the excel_import.uploaded chain row).
--      Same shape as 1.6 action_items, 1.7 evidence_files, 1.8
--      inspections, 1.9 recommendations.
--
--   2. excel_import_items — per-row provenance join. One row per
--      parsed action_item from the workbook. UNIQUE (import_id,
--      content_hash) collapses same-hash duplicates within one
--      import. before_state_json captures the pre-import snapshot
--      that the 30-day reverse path restores from (ADR §3.11).
--
--      action_item_id is NULL during pending/preview (the commit
--      transaction populates it) and stays bound after; FK is ON
--      DELETE SET NULL so a reverse that DELETEs the action_item
--      leaves the provenance row intact (the join goes NULL but the
--      row itself remains as evidentiary record per ADR §3.11).
--
--      audit_idx is NULLABLE — skipped rows do not anchor — with a
--      partial UNIQUE so only the non-NULL idxs are constrained.
--
-- Trigger ratchet: action_items_source_fk_guard
--
--   The 0008 rewrite of the trigger left 'excel_import' in the
--   NO-OP skip set ("manual + excel_import + NULL → return NEW;").
--   1.11 finally has a real excel_imports table, so the
--   'excel_import' branch is promoted to fail-closed: an action_item
--   with source_type='excel_import' must point its source_id at an
--   existing excel_imports.id.
--
--   The rewrite preserves every prior branch verbatim — losing one
--   would silently re-open a referential-integrity gap that 0007 /
--   0008 already closed.
--
--   Per ADR §3.9: source_id binds to excel_imports.id (the batch),
--   not excel_import_items.id (the per-row join). The per-row link
--   lives on excel_import_items.action_item_id as a separate FK.

-- ---------------------------------------------------------------------------
-- excel_imports — batch-level row
-- ---------------------------------------------------------------------------

CREATE TABLE "excel_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"imported_by_user_id" uuid NOT NULL,
	-- Envelope-encrypted source filename. T-X19: filenames frequently
	-- carry the workplace name (e.g. 'JHSC Minutes [Workplace] Q3.xlsx').
	"source_filename_ct" "bytea" NOT NULL,
	"source_filename_dek_ct" "bytea" NOT NULL,
	-- Plaintext SHA-256 of the raw file bytes. Integrity anchor only;
	-- no PI in a SHA-256. Echoed in the excel_import.uploaded /
	-- excel_import.committed chain payloads (T-X43).
	"source_sha256" "bytea" NOT NULL,
	"schema_version" text NOT NULL,
	"row_count" integer NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	-- Step-up token jti pinned on commit. NULL until the commit
	-- transaction stamps it. NOT a referential integrity column —
	-- step-up tokens are short-lived; this is for audit-log
	-- cross-referencing only.
	"step_up_jti" text,
	-- Envelope-encrypted JSONB snapshot of the Inspection Review sheet.
	-- Read-only per ROADMAP scope (NOT promoted to native inspection
	-- records — the 1.8 inspection tooling is the going-forward path).
	-- T-X13: the snapshot may carry supervisor + witness names.
	"inspection_review_snapshot_ct" "bytea",
	"inspection_review_snapshot_dek_ct" "bytea",
	-- Chain-anchor link. UNIQUE 1-to-1 with the excel_import.uploaded
	-- audit_log row.
	"audit_idx" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previewed_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	-- S2 reverse-path stamp. NULL until the 30-day reverse fires; once
	-- stamped, the status MUST also flip to 'reversed' per the
	-- state-consistency CHECK below. ADR §3.11.
	"reversed_at" timestamp with time zone,
	CONSTRAINT "excel_imports_source_sha256_length_check"
		CHECK (octet_length("source_sha256") = 32),
	CONSTRAINT "excel_imports_row_count_bounds_check"
		CHECK ("row_count" >= 0 AND "row_count" <= 50000),
	CONSTRAINT "excel_imports_schema_version_check"
		CHECK ("schema_version" IN ('meeting_minutes_v1')),
	-- 'reversed' added in S2: the 30-day reverse path flips the
	-- committed row to this state + stamps reversed_at. Append-only
	-- after that (no transition out of 'reversed').
	CONSTRAINT "excel_imports_status_check"
		CHECK ("status" IN ('pending','preview','committed','cancelled','reversed')),
	-- inspection_review snapshot pair-NULL: both columns NULL or both
	-- NOT NULL. T-X13 + the established 1.7 evidence / 1.8 finding /
	-- 1.9 recommendation encrypted-pair posture.
	CONSTRAINT "excel_imports_inspection_review_snapshot_pair_check" CHECK (
		("inspection_review_snapshot_ct" IS NULL AND "inspection_review_snapshot_dek_ct" IS NULL)
		OR ("inspection_review_snapshot_ct" IS NOT NULL AND "inspection_review_snapshot_dek_ct" IS NOT NULL)
	),
	-- State-consistency CHECK: the (status, *_at) tuple must be coherent.
	-- A drifted route handler cannot land a row claiming status='committed'
	-- with committed_at IS NULL.  S2 adds the 'reversed' shape: status
	-- transitions committed → reversed; reversed_at gets stamped at the
	-- transition; committed_at stays populated (the prior commit still
	-- happened; the reverse is an additive lifecycle event).
	CONSTRAINT "excel_imports_state_consistency_check" CHECK (
		("status" = 'pending'
			AND "committed_at" IS NULL
			AND "cancelled_at" IS NULL
			AND "reversed_at" IS NULL)
		OR ("status" = 'preview'
			AND "previewed_at" IS NOT NULL
			AND "committed_at" IS NULL
			AND "cancelled_at" IS NULL
			AND "reversed_at" IS NULL)
		OR ("status" = 'committed'
			AND "committed_at" IS NOT NULL
			AND "cancelled_at" IS NULL
			AND "reversed_at" IS NULL)
		OR ("status" = 'cancelled'
			AND "cancelled_at" IS NOT NULL
			AND "reversed_at" IS NULL)
		OR ("status" = 'reversed'
			AND "committed_at" IS NOT NULL
			AND "reversed_at" IS NOT NULL
			AND "cancelled_at" IS NULL)
	),
	CONSTRAINT "excel_imports_imported_by_user_fk"
		FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "excel_imports_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "excel_imports_audit_idx_unique" ON "excel_imports" USING btree ("audit_idx");
--> statement-breakpoint
CREATE INDEX "excel_imports_imported_by_idx" ON "excel_imports" USING btree ("imported_by_user_id");
--> statement-breakpoint
CREATE INDEX "excel_imports_status_idx" ON "excel_imports" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "excel_imports_created_at_idx" ON "excel_imports" USING btree ("created_at" DESC);
--> statement-breakpoint
-- Partial index for the 30-day reverse-window scan (ADR §3.11).
-- Only committed rows can be reversed; the partial keeps the index
-- small for the hot path.
CREATE INDEX "excel_imports_committed_at_idx" ON "excel_imports" USING btree ("committed_at")
	WHERE "status" = 'committed';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- excel_import_items — per-row provenance join
-- ---------------------------------------------------------------------------

CREATE TABLE "excel_import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"source_row_index" integer NOT NULL,
	"section" text NOT NULL,
	-- 32-byte SHA-256: sha256(canonical(description)||'|'||canonical(start_date)).
	-- The hex form lives in the per-row chain-anchor payload; the bytea
	-- here is the raw 32 bytes. T-X20 / T-X21 documented residuals on
	-- collision + canonicalization stability.
	"content_hash" "bytea" NOT NULL,
	-- Populated on commit (NULL during pending/preview); ON DELETE SET NULL
	-- so a 30-day reverse that DELETEs the action_item leaves this row as
	-- an evidentiary provenance record (T-X38 + ADR §3.11).
	"action_item_id" uuid,
	"status" text NOT NULL DEFAULT 'conflict_pending',
	-- Pre-import snapshot for reverse-path restoration (ADR §3.11). NULL
	-- when status='created' (no prior state existed). JSONB so the
	-- reverse handler can SELECT and restore fields by name.
	"before_state_json" jsonb,
	-- NULL for skipped rows (skip doesn't anchor). The action_item.created
	-- / action_item.updated row's audit_log.idx is what binds here.
	-- UNIQUE-where-not-null below.
	"audit_idx" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "excel_import_items_source_row_index_check"
		CHECK ("source_row_index" >= 0),
	CONSTRAINT "excel_import_items_section_check" CHECK ("section" IN
		('new_business','old_business','recommendation','completed_this_period','archived')),
	CONSTRAINT "excel_import_items_content_hash_length_check"
		CHECK (octet_length("content_hash") = 32),
	CONSTRAINT "excel_import_items_status_check" CHECK ("status" IN
		('created','updated','skipped','conflict_pending')),
	CONSTRAINT "excel_import_items_import_fk"
		FOREIGN KEY ("import_id") REFERENCES "excel_imports"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "excel_import_items_action_item_fk"
		FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id")
		ON UPDATE RESTRICT ON DELETE SET NULL,
	CONSTRAINT "excel_import_items_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
-- UNIQUE (import_id, content_hash) — same content_hash within one
-- import file dedups to one row (T-X21 second-line defense).
CREATE UNIQUE INDEX "excel_import_items_import_content_hash_unique"
	ON "excel_import_items" USING btree ("import_id","content_hash");
--> statement-breakpoint
-- Partial UNIQUE on audit_idx (NULL allowed for skipped rows). Standard
-- "UNIQUE except NULL" pattern from sync_idempotency (0009).
CREATE UNIQUE INDEX "excel_import_items_audit_idx_unique"
	ON "excel_import_items" USING btree ("audit_idx") WHERE "audit_idx" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "excel_import_items_import_status_idx"
	ON "excel_import_items" USING btree ("import_id","status");
--> statement-breakpoint
CREATE INDEX "excel_import_items_action_item_idx"
	ON "excel_import_items" USING btree ("action_item_id")
	WHERE "action_item_id" IS NOT NULL;
--> statement-breakpoint
-- Cross-import dedup lookup (ADR §3.6 idempotent re-imports).
CREATE INDEX "excel_import_items_content_hash_idx"
	ON "excel_import_items" USING btree ("content_hash");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Trigger ratchet: action_items_source_fk_guard ('excel_import' branch)
-- ---------------------------------------------------------------------------
--
-- 0008's rewrite of this function placed 'excel_import' in the no-op
-- skip set alongside 'manual' and NULL. The 1.11 close-out promotes
-- 'excel_import' to a fail-closed branch: an action_item with
-- source_type='excel_import' MUST point its source_id at an existing
-- excel_imports.id (the batch row).
--
-- The route layer's Zod refinement is the upstream gate; this trigger
-- is the DB-layer backstop against a hand-crafted INSERT.
--
-- Per ADR-0010 §3.9: source_id binds to excel_imports.id (the batch),
-- not excel_import_items.id (the per-row join). The per-row link lives
-- on excel_import_items.action_item_id as a separate FK already
-- declared above.
--
-- CREATE OR REPLACE re-emits the existing 'hazard', 'inspection',
-- 'recommendation' branches verbatim from 0008 + the new fail-closed
-- 'excel_import' branch + the fail-closed ELSE rail. Preserving every
-- prior branch is load-bearing — a half-rewritten function would
-- silently accept what 0007/0008 already rejected.

CREATE OR REPLACE FUNCTION action_items_source_fk_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Skip referential validation for the documented bypass cases. NULL
  -- source_type is the legacy default from migration 0005; 'manual' has
  -- no backing table by design (rep-typed create path; priv-AI-F3
  -- documented residual).
  IF NEW.source_type IS NULL OR NEW.source_type = 'manual' THEN
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
  ELSIF NEW.source_type = 'excel_import' THEN
    -- 1.11 ratchet: 'excel_import' was a no-op skip in 0007/0008
    -- (because the table didn't yet exist). Now that excel_imports
    -- ships, the branch validates source_id against the batch row.
    -- ADR-0010 §3.9: source_id binds to excel_imports.id (the batch),
    -- not excel_import_items.id (the per-row join). The route's Zod
    -- refinement is the upstream gate; this is the DB-layer backstop.
    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM excel_imports WHERE id = NEW.source_id) THEN
      RAISE EXCEPTION
        'action_items_source_fk_guard: excel_import % does not exist', NEW.source_id;
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
