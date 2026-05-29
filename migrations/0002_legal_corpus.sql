-- Milestone 1.4 (ADR-0003): legal corpus schema.
--
-- Three tables (corpus_versions, statutes, clauses) + FTS column + copyright
-- trigger backstop. Seeder lives in apps/api/scripts/seed-legal-corpus.ts;
-- this migration only creates the structures.

CREATE TABLE "corpus_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"fixture_sha256" "bytea" NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "statutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"title" text NOT NULL,
	"licence" text NOT NULL,
	"source_url" text NOT NULL,
	"corpus_version" text NOT NULL,
	CONSTRAINT "statutes_licence_check" CHECK ("licence" IN ('crown_copyright_open','third_party_restricted')),
	CONSTRAINT "statutes_corpus_version_fk" FOREIGN KEY ("corpus_version") REFERENCES "corpus_versions"("version") ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "statutes_code_unique" ON "statutes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "statutes_jurisdiction_idx" ON "statutes" USING btree ("jurisdiction");
--> statement-breakpoint
CREATE TABLE "clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statute_id" uuid NOT NULL,
	"citation" text NOT NULL,
	"hierarchy_path" text[] NOT NULL,
	"heading" text,
	"body" text NOT NULL,
	"body_summary" text,
	"body_kind" text NOT NULL,
	"body_hash" "bytea" NOT NULL,
	"version_date" date NOT NULL,
	"verified_by" text NOT NULL,
	"source_url" text NOT NULL,
	"corpus_version" text NOT NULL,
	"superseded_by" uuid,
	"correction_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" tsvector GENERATED ALWAYS AS (
		setweight(to_tsvector('english', coalesce("heading", '')), 'A') ||
		setweight(to_tsvector('english', coalesce("citation", '')), 'B') ||
		setweight(to_tsvector('english', coalesce("body", '')), 'C')
	) STORED,
	CONSTRAINT "clauses_body_kind_check" CHECK ("body_kind" IN ('full_text','summary')),
	CONSTRAINT "clauses_statute_fk" FOREIGN KEY ("statute_id") REFERENCES "statutes"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "clauses_corpus_version_fk" FOREIGN KEY ("corpus_version") REFERENCES "corpus_versions"("version") ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "clauses_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "clauses"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "clauses_correction_of_fk" FOREIGN KEY ("correction_of") REFERENCES "clauses"("id") ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clauses_statute_citation_version_unique" ON "clauses" USING btree ("statute_id","citation","version_date");--> statement-breakpoint
CREATE INDEX "clauses_statute_idx" ON "clauses" USING btree ("statute_id");--> statement-breakpoint
CREATE INDEX "clauses_version_date_idx" ON "clauses" USING btree ("version_date");--> statement-breakpoint
CREATE INDEX "clauses_search_tsv_idx" ON "clauses" USING gin ("search_tsv");
--> statement-breakpoint
-- T-LC4 backstop: refuse body_kind='full_text' under a restricted-licence
-- statute. The primary check lives in @jhsc/legal-corpus checkCopyrightGuard()
-- and fires before the seeder opens a transaction; this trigger backs it up
-- against any future write path (admin override, manual SQL, etc.).
CREATE OR REPLACE FUNCTION clauses_copyright_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  statute_licence text;
BEGIN
  IF NEW.body_kind = 'full_text' THEN
    SELECT s.licence INTO statute_licence FROM statutes s WHERE s.id = NEW.statute_id;
    IF statute_licence IS DISTINCT FROM 'crown_copyright_open' THEN
      RAISE EXCEPTION
        'clauses_copyright_guard: body_kind=full_text not allowed for statute % (licence=%)',
        NEW.statute_id, statute_licence;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clauses_copyright_guard_trigger
BEFORE INSERT OR UPDATE ON clauses
FOR EACH ROW EXECUTE FUNCTION clauses_copyright_guard();
