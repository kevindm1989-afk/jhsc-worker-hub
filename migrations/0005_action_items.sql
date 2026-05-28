-- Milestone 1.6 (ADR-0005): action_items + action_item_moves.
--
-- Action items are the central operational entity per CLAUDE.md
-- non-negotiable #12. Four encrypted column pairs carry the PI-bearing
-- surfaces (description, recommended_action, raised_by external,
-- follow_up_owner external); plus the optional encrypted move reason.
-- All transitions land via the route layer because Postgres CHECK
-- can't enforce two-row-state moves.

CREATE TABLE "action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_number" integer NOT NULL,
	"type" text NOT NULL,
	"type_subtype" text,
	"description_ct" "bytea" NOT NULL,
	"description_dek_ct" "bytea" NOT NULL,
	"recommended_action_ct" "bytea",
	"recommended_action_dek_ct" "bytea",
	"raised_by_ct" "bytea",
	"raised_by_dek_ct" "bytea",
	"raised_by_user_id" uuid,
	"follow_up_owner_ct" "bytea",
	"follow_up_owner_dek_ct" "bytea",
	"follow_up_owner_user_id" uuid,
	"department" text,
	"status" text NOT NULL,
	"risk" text NOT NULL,
	"section" text NOT NULL,
	"start_date" date NOT NULL,
	"target_date" date,
	"closed_date" date,
	"verified_by_jhsc_id" uuid,
	"meeting_id" uuid,
	"source_type" text,
	"source_id" uuid,
	"source_excel_hash" "bytea",
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_items_type_check" CHECK ("type" IN
		('INSP','INSIGHT','FLI','INC','REC','TRAIN','PROC','OTHER')),
	CONSTRAINT "action_items_status_check" CHECK ("status" IN
		('Not Started','In Progress','Blocked','Pending Review','Closed','Cancelled')),
	CONSTRAINT "action_items_risk_check" CHECK ("risk" IN ('Low','Medium','High','Critical')),
	CONSTRAINT "action_items_section_check" CHECK ("section" IN
		('new_business','old_business','recommendation','completed_this_period','archived')),
	CONSTRAINT "action_items_source_type_check" CHECK ("source_type" IS NULL OR "source_type" IN
		('manual','hazard','recommendation','inspection','incident','excel_import')),
	CONSTRAINT "action_items_recommended_action_pair_check" CHECK (
		("recommended_action_ct" IS NULL AND "recommended_action_dek_ct" IS NULL)
		OR ("recommended_action_ct" IS NOT NULL AND "recommended_action_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "action_items_raised_by_pair_check" CHECK (
		("raised_by_ct" IS NULL AND "raised_by_dek_ct" IS NULL)
		OR ("raised_by_ct" IS NOT NULL AND "raised_by_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "action_items_follow_up_owner_pair_check" CHECK (
		("follow_up_owner_ct" IS NULL AND "follow_up_owner_dek_ct" IS NULL)
		OR ("follow_up_owner_ct" IS NOT NULL AND "follow_up_owner_dek_ct" IS NOT NULL)
	),
	-- At least one identity carrier must be present per role:
	-- raised_by is either an internal rep (user_id) OR an external person
	-- (encrypted name). Same for follow_up_owner. The "neither" case is
	-- allowed (rep didn't record who raised it / no owner assigned yet).
	-- The "both" case is allowed (rep wrote a name AND linked a user).
	CONSTRAINT "action_items_sequence_number_positive_check"
		CHECK ("sequence_number" >= 1),
	CONSTRAINT "action_items_raised_by_user_fk"
		FOREIGN KEY ("raised_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "action_items_follow_up_owner_user_fk"
		FOREIGN KEY ("follow_up_owner_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "action_items_verified_by_jhsc_fk"
		FOREIGN KEY ("verified_by_jhsc_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "action_items_section_idx" ON "action_items" USING btree ("section");--> statement-breakpoint
CREATE INDEX "action_items_status_idx" ON "action_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "action_items_risk_idx" ON "action_items" USING btree ("risk");--> statement-breakpoint
CREATE INDEX "action_items_type_idx" ON "action_items" USING btree ("type");--> statement-breakpoint
CREATE INDEX "action_items_section_seq_idx" ON "action_items" USING btree ("section","sequence_number");--> statement-breakpoint
CREATE INDEX "action_items_source_idx" ON "action_items" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "action_items_meeting_idx" ON "action_items" USING btree ("meeting_id");
--> statement-breakpoint
-- Per-section uniqueness on the visible "#" column. The route layer
-- allocates sequence_number = MAX + 1 within a section under FOR UPDATE.
CREATE UNIQUE INDEX "action_items_section_seq_unique"
	ON "action_items" USING btree ("section","sequence_number");
--> statement-breakpoint
CREATE TABLE "action_item_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_item_id" uuid NOT NULL,
	"moved_by_user_id" uuid NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_section" text,
	"to_section" text NOT NULL,
	"reason_ct" "bytea",
	"reason_dek_ct" "bytea",
	"meeting_id" uuid,
	"audit_idx" bigint NOT NULL,
	"undone" boolean DEFAULT false NOT NULL,
	CONSTRAINT "action_item_moves_from_check" CHECK ("from_section" IS NULL OR "from_section" IN
		('new_business','old_business','recommendation','completed_this_period','archived')),
	CONSTRAINT "action_item_moves_to_check" CHECK ("to_section" IN
		('new_business','old_business','recommendation','completed_this_period','archived')),
	CONSTRAINT "action_item_moves_reason_pair_check" CHECK (
		("reason_ct" IS NULL AND "reason_dek_ct" IS NULL)
		OR ("reason_ct" IS NOT NULL AND "reason_dek_ct" IS NOT NULL)
	),
	CONSTRAINT "action_item_moves_action_item_fk"
		FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "action_item_moves_actor_fk"
		FOREIGN KEY ("moved_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "action_item_moves_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "action_item_moves_item_idx" ON "action_item_moves" USING btree ("action_item_id","moved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "action_item_moves_audit_idx_unique" ON "action_item_moves" USING btree ("audit_idx");
--> statement-breakpoint
-- Polymorphic source-FK backstop for 'hazard'. As recommendation /
-- inspection / incident tables ship, add per-source CHECK triggers
-- here (or migration 0006+). 'manual' and 'excel_import' carry no
-- referential integrity by design.
CREATE OR REPLACE FUNCTION action_items_source_fk_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type = 'hazard' AND NEW.source_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM hazards WHERE id = NEW.source_id) THEN
      RAISE EXCEPTION
        'action_items_source_fk_guard: hazard % does not exist', NEW.source_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER action_items_source_fk_guard_trigger
BEFORE INSERT OR UPDATE ON action_items
FOR EACH ROW EXECUTE FUNCTION action_items_source_fk_guard();
--> statement-breakpoint
-- updated_at trigger -- same shape as hazards 0004.
CREATE OR REPLACE FUNCTION action_items_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER action_items_touch_updated_at_trigger
BEFORE UPDATE ON action_items
FOR EACH ROW EXECUTE FUNCTION action_items_touch_updated_at();
