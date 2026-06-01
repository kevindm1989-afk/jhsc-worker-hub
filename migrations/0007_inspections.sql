-- Milestone 1.8 (ADR-0007): inspection_templates + inspections +
-- inspection_findings + inspection_signatures + export_records.
--
-- Five tables anchor the inspection surface:
--   - inspection_templates: append-only versioned rows; (template_code,
--     version_number) is the natural key; at most one active version per
--     code (partial UNIQUE WHERE retired_at IS NULL).
--   - inspections: pins template_version_id (non-negotiable #13); zone_id
--     is the stable zone_N literal (non-negotiable #14).
--   - inspection_findings: section + item snapshotted from the template
--     at create time. Three encrypted column pairs (observation,
--     corrective_action, responsible_party). At-most-one bidirectional
--     link to action_items via promoted_action_item_id UNIQUE.
--   - inspection_signatures: separate row per role + UNIQUE (inspection,
--     role); each carries its own audit_idx anchor.
--   - export_records: stored-PDF receipt + 32-byte SHA-256 + step-up grant
--     id + 30-day TTL hint + 100-batch ceiling (T-I32 SQL-layer bound).
--
-- Polymorphic FK trigger ratchets (T-I14, T-I17 close-out forward seams):
--   - evidence_files_linked_fk_guard gains an 'inspection_finding' branch.
--   - action_items_source_fk_guard gains an 'inspection' branch.
--
-- Per ADR-0007 §3.4 the seed payloads (Zone Monthly v1 / Rack v1) ship in
-- scripts/seed-inspection-templates.ts so the Zod-validated shape is
-- checked at build time; this migration is structural only.

CREATE TABLE "inspection_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_code" text NOT NULL,
	"version_number" integer NOT NULL,
	"status_vocab" text NOT NULL,
	"display_name" text NOT NULL,
	"cadence" text NOT NULL,
	"sections" jsonb NOT NULL,
	"requires_three_signatures" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by_user_id" uuid,
	CONSTRAINT "inspection_templates_template_code_check" CHECK ("template_code" IN
		('zone_monthly','rack_inspection','custom')),
	CONSTRAINT "inspection_templates_version_number_check" CHECK ("version_number" > 0),
	CONSTRAINT "inspection_templates_status_vocab_check" CHECK ("status_vocab" IN ('ABC_X','GAR')),
	CONSTRAINT "inspection_templates_cadence_check" CHECK ("cadence" IN
		('monthly','quarterly','annual','ad_hoc')),
	-- The route layer's Zod schema is the structural gate for `sections`
	-- (ADR-0007 §3.5). SQL only asserts non-empty array shape.
	CONSTRAINT "inspection_templates_sections_shape_check" CHECK (
		jsonb_typeof("sections") = 'array' AND jsonb_array_length("sections") > 0
	),
	CONSTRAINT "inspection_templates_code_version_unique" UNIQUE ("template_code", "version_number"),
	CONSTRAINT "inspection_templates_created_by_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "inspection_templates_code_idx" ON "inspection_templates" USING btree ("template_code");--> statement-breakpoint
-- At most one active version per template_code (T-I1 / ADR-0007 §3.1).
CREATE UNIQUE INDEX "inspection_templates_active_version"
	ON "inspection_templates" USING btree ("template_code")
	WHERE "retired_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- non-negotiable #13: FK pins the specific versioned row, never the code.
	"template_version_id" uuid NOT NULL,
	-- non-negotiable #14: stable zone_N literal; config/workplace.ts renders
	-- the display name at view time. Hardcoded enum here (the CHECK), not
	-- a TS-side import, because SQL is the runtime authoritative gate.
	"zone_id" text NOT NULL,
	"conducted_by_user_id" uuid NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"audit_idx" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspections_zone_id_check" CHECK ("zone_id" IN
		('zone_1','zone_2','zone_3','zone_4','zone_5','zone_6','zone_7','zone_8','zone_9','zone_10')),
	CONSTRAINT "inspections_state_check" CHECK ("state" IN
		('scheduled','in_progress','awaiting_signatures','complete','archived')),
	CONSTRAINT "inspections_template_version_fk"
		FOREIGN KEY ("template_version_id") REFERENCES "inspection_templates"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "inspections_conducted_by_fk"
		FOREIGN KEY ("conducted_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "inspections_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_audit_idx_unique" ON "inspections" USING btree ("audit_idx");--> statement-breakpoint
CREATE INDEX "inspections_state_idx" ON "inspections" USING btree ("state");--> statement-breakpoint
CREATE INDEX "inspections_zone_idx" ON "inspections" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "inspections_template_version_idx" ON "inspections" USING btree ("template_version_id");--> statement-breakpoint
CREATE INDEX "inspections_conducted_by_idx" ON "inspections" USING btree ("conducted_by_user_id");--> statement-breakpoint
CREATE INDEX "inspections_scheduled_for_idx" ON "inspections" USING btree ("scheduled_for");
--> statement-breakpoint
CREATE TABLE "inspection_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	-- Snapshotted from the pinned template_version at finding creation;
	-- immune to later template edits (ADR-0007 §3.6).
	"section_key" text NOT NULL,
	"section_label" text NOT NULL,
	"item_key" text NOT NULL,
	"item_label" text NOT NULL,
	"status_vocab" text NOT NULL,
	"status_value" text NOT NULL,
	"observation_ct" "bytea",
	"observation_dek_ct" "bytea",
	"corrective_action_ct" "bytea",
	"corrective_action_dek_ct" "bytea",
	"responsible_party_ct" "bytea",
	"responsible_party_dek_ct" "bytea",
	"promoted_action_item_id" uuid,
	"audit_idx" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_findings_status_vocab_check" CHECK ("status_vocab" IN ('ABC_X','GAR')),
	-- ABC_X carries A|B|C|X; GAR carries G|A|R. The two vocabs overlap on
	-- 'A' which is why the row carries both columns (ADR-0007 §3.2).
	CONSTRAINT "inspection_findings_status_value_check" CHECK (
		("status_vocab" = 'ABC_X' AND "status_value" IN ('A','B','C','X'))
		OR ("status_vocab" = 'GAR' AND "status_value" IN ('G','A','R'))
	),
	CONSTRAINT "inspection_findings_observation_pair_check" CHECK (
		("observation_ct" IS NULL AND "observation_dek_ct" IS NULL)
		OR ("observation_ct" IS NOT NULL AND "observation_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "inspection_findings_corrective_action_pair_check" CHECK (
		("corrective_action_ct" IS NULL AND "corrective_action_dek_ct" IS NULL)
		OR ("corrective_action_ct" IS NOT NULL AND "corrective_action_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "inspection_findings_responsible_party_pair_check" CHECK (
		("responsible_party_ct" IS NULL AND "responsible_party_dek_ct" IS NULL)
		OR ("responsible_party_ct" IS NOT NULL AND "responsible_party_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "inspection_findings_inspection_fk"
		FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "inspection_findings_promoted_action_item_fk"
		FOREIGN KEY ("promoted_action_item_id") REFERENCES "action_items"("id")
		ON UPDATE RESTRICT ON DELETE SET NULL,
	CONSTRAINT "inspection_findings_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_findings_audit_idx_unique" ON "inspection_findings" USING btree ("audit_idx");--> statement-breakpoint
-- T-I16 close-out: a finding promotes at most once. UNIQUE on the FK
-- column (NULLs are allowed and ignored by UNIQUE).
CREATE UNIQUE INDEX "inspection_findings_promoted_action_item_unique"
	ON "inspection_findings" USING btree ("promoted_action_item_id")
	WHERE "promoted_action_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "inspection_findings_inspection_idx" ON "inspection_findings" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "inspection_findings_status_value_idx" ON "inspection_findings" USING btree ("status_value");--> statement-breakpoint
CREATE INDEX "inspection_findings_promoted_idx" ON "inspection_findings" USING btree ("promoted_action_item_id")
	WHERE "promoted_action_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "inspection_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"signed_by_user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note_ct" "bytea",
	"note_dek_ct" "bytea",
	"audit_idx" bigint NOT NULL,
	CONSTRAINT "inspection_signatures_role_check" CHECK ("role" IN
		('inspector','supervisor','jhsc_worker_co_chair')),
	CONSTRAINT "inspection_signatures_note_pair_check" CHECK (
		("note_ct" IS NULL AND "note_dek_ct" IS NULL)
		OR ("note_ct" IS NOT NULL AND "note_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "inspection_signatures_inspection_role_unique" UNIQUE ("inspection_id", "role"),
	CONSTRAINT "inspection_signatures_inspection_fk"
		FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "inspection_signatures_signed_by_fk"
		FOREIGN KEY ("signed_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "inspection_signatures_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_signatures_audit_idx_unique" ON "inspection_signatures" USING btree ("audit_idx");--> statement-breakpoint
CREATE INDEX "inspection_signatures_inspection_idx" ON "inspection_signatures" USING btree ("inspection_id");
--> statement-breakpoint
CREATE TABLE "export_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"inspection_ids" uuid[] NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"output_sha256" "bytea" NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"step_up_jti" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"audit_idx" bigint NOT NULL,
	CONSTRAINT "export_records_kind_check" CHECK ("kind" IN ('single','batch')),
	-- T-I32 SQL-layer enforcement of the 100-inspection batch ceiling.
	CONSTRAINT "export_records_inspection_ids_cardinality_check" CHECK (
		cardinality("inspection_ids") > 0 AND cardinality("inspection_ids") <= 100
	),
	CONSTRAINT "export_records_output_sha256_length_check"
		CHECK (octet_length("output_sha256") = 32),
	-- 500 MiB ceiling per ADR-0007 §3.9.
	CONSTRAINT "export_records_byte_size_check"
		CHECK ("byte_size" > 0 AND "byte_size" <= 524288000),
	CONSTRAINT "export_records_storage_key_unique" UNIQUE ("storage_key"),
	CONSTRAINT "export_records_requested_by_fk"
		FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "export_records_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "export_records_audit_idx_unique" ON "export_records" USING btree ("audit_idx");--> statement-breakpoint
CREATE INDEX "export_records_requested_by_idx" ON "export_records" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "export_records_requested_at_idx" ON "export_records" USING btree ("requested_at" DESC);--> statement-breakpoint
CREATE INDEX "export_records_expires_at_idx" ON "export_records" USING btree ("expires_at")
	WHERE "expires_at" > now();
--> statement-breakpoint
-- updated_at triggers — same shape as 0004_hazards / 0005_action_items.
CREATE OR REPLACE FUNCTION inspections_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspections_touch_updated_at_trigger
BEFORE UPDATE ON inspections
FOR EACH ROW EXECUTE FUNCTION inspections_touch_updated_at();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inspection_findings_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_findings_touch_updated_at_trigger
BEFORE UPDATE ON inspection_findings
FOR EACH ROW EXECUTE FUNCTION inspection_findings_touch_updated_at();
--> statement-breakpoint
-- T-I14 close-out: extend evidence_files_linked_fk_guard with the
-- 'inspection_finding' branch alongside this slice's table creation.
-- CREATE OR REPLACE re-emits the existing 'hazard' and 'action_item'
-- branches verbatim from 0006 plus the new branch; the ELSE rail stays
-- fail-closed (priv-AI-F3 pattern).
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
  ELSE
    RAISE EXCEPTION
      'evidence_files_linked_fk_guard: linked_type % not yet supported at trigger layer',
      NEW.linked_type;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- T-I17 close-out: extend action_items_source_fk_guard with an
-- 'inspection' branch validating source_id against inspection_findings.
-- 0005 only carried the 'hazard' branch; the function is rewritten with
-- both branches. Source types 'manual' and 'excel_import' remain
-- referential-integrity-free by design.
CREATE OR REPLACE FUNCTION action_items_source_fk_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type = 'hazard' AND NEW.source_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM hazards WHERE id = NEW.source_id) THEN
      RAISE EXCEPTION
        'action_items_source_fk_guard: hazard % does not exist', NEW.source_id;
    END IF;
  ELSIF NEW.source_type = 'inspection' AND NEW.source_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM inspection_findings WHERE id = NEW.source_id) THEN
      RAISE EXCEPTION
        'action_items_source_fk_guard: inspection_finding % does not exist', NEW.source_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
