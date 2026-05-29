-- Milestone 1.5 (ADR-0004): hazards + hazard_status_history.
--
-- Two tables. Encrypted columns (`*_ct` + `*_dek_ct`) carry the envelope
-- ciphertext + sealed per-row DEK. Postgres sees ciphertext only; the
-- KEK lives in Fly Secrets. Status workflow check is a column-level
-- CHECK; the legality of *transitions* is enforced at the route layer
-- by the pure helper in @jhsc/shared-types/hazard-transitions (the
-- graph cannot live in a CHECK because it spans two row versions).

CREATE TABLE "hazards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hazard_code" text NOT NULL,
	"title" text NOT NULL,
	"description_ct" "bytea" NOT NULL,
	"description_dek_ct" "bytea" NOT NULL,
	"reporter_identity_ct" "bytea",
	"reporter_identity_dek_ct" "bytea",
	"reported_by" uuid NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"location_zone" text,
	"location_detail_ct" "bytea",
	"location_detail_dek_ct" "bytea",
	"jurisdiction" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assessed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hazards_severity_check" CHECK ("severity" IN ('critical','high','medium','low')),
	CONSTRAINT "hazards_status_check" CHECK ("status" IN ('open','assessing','assigned','resolved','archived','withdrawn')),
	CONSTRAINT "hazards_jurisdiction_check" CHECK ("jurisdiction" IN ('ON','CA')),
	CONSTRAINT "hazards_title_length_check" CHECK (char_length("title") <= 120),
	-- A reporter_identity pair is both-NULL (anonymous) or both-NOT-NULL.
	CONSTRAINT "hazards_reporter_identity_pair_check" CHECK (
		("reporter_identity_ct" IS NULL AND "reporter_identity_dek_ct" IS NULL)
		OR ("reporter_identity_ct" IS NOT NULL AND "reporter_identity_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "hazards_location_detail_pair_check" CHECK (
		("location_detail_ct" IS NULL AND "location_detail_dek_ct" IS NULL)
		OR ("location_detail_ct" IS NOT NULL AND "location_detail_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "hazards_reported_by_fk" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hazards_code_unique" ON "hazards" USING btree ("hazard_code");--> statement-breakpoint
CREATE INDEX "hazards_status_idx" ON "hazards" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hazards_severity_idx" ON "hazards" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "hazards_reported_at_idx" ON "hazards" USING btree ("reported_at");--> statement-breakpoint
CREATE INDEX "hazards_reported_by_idx" ON "hazards" USING btree ("reported_by");
--> statement-breakpoint
-- hazard_code monotonic per-workplace counter. Implemented via a sequence
-- so the API doesn't have to take a row lock on hazards for every insert.
CREATE SEQUENCE "hazards_code_seq" START 1;
--> statement-breakpoint
CREATE TABLE "hazard_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hazard_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason_ct" "bytea",
	"reason_dek_ct" "bytea",
	"audit_idx" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hazard_status_history_from_check" CHECK (
		"from_status" IS NULL
		OR "from_status" IN ('open','assessing','assigned','resolved','archived','withdrawn')
	),
	CONSTRAINT "hazard_status_history_to_check" CHECK (
		"to_status" IN ('open','assessing','assigned','resolved','archived','withdrawn')
	),
	CONSTRAINT "hazard_status_history_reason_pair_check" CHECK (
		("reason_ct" IS NULL AND "reason_dek_ct" IS NULL)
		OR ("reason_ct" IS NOT NULL AND "reason_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "hazard_status_history_hazard_fk" FOREIGN KEY ("hazard_id") REFERENCES "hazards"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "hazard_status_history_actor_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "hazard_status_history_audit_idx_fk" FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx") ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "hazard_status_history_hazard_idx" ON "hazard_status_history" USING btree ("hazard_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hazard_status_history_audit_idx_unique" ON "hazard_status_history" USING btree ("audit_idx");
--> statement-breakpoint
-- Keep updated_at in sync without trusting the application to remember.
CREATE OR REPLACE FUNCTION hazards_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hazards_touch_updated_at_trigger
BEFORE UPDATE ON hazards
FOR EACH ROW EXECUTE FUNCTION hazards_touch_updated_at();
