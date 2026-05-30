-- Milestone 1.4 review fixes (sec-F2, sec-F6).
--
-- Three hardening changes:
--   1. Drop + recreate `search_tsv` with a licence-aware expression so the
--      FTS index over third_party_restricted rows is built from
--      body_summary, not body. Closes sec-F6's verbatim-token oracle.
--   2. Add CHECK enforcing body_summary IS NOT NULL when body_kind='summary'.
--      The seeder's JS guard already enforces this; this is the DB backstop.
--   3. Add a trigger on `statutes` UPDATE that refuses a licence flip from
--      `crown_copyright_open` to `third_party_restricted` while existing
--      full_text clauses depend on the statute. Closes sec-F2.

-- (1) Drop and recreate the generated FTS column. ALTER COLUMN ... TYPE
-- cannot change the GENERATED expression in Postgres, so we recreate.

DROP INDEX IF EXISTS "clauses_search_tsv_idx";
--> statement-breakpoint
ALTER TABLE "clauses" DROP COLUMN IF EXISTS "search_tsv";
--> statement-breakpoint
ALTER TABLE "clauses" ADD COLUMN "search_tsv" tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("heading", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("citation", '')), 'B') ||
  setweight(to_tsvector('english',
    CASE WHEN "body_kind" = 'summary' THEN coalesce("body_summary", '')
         ELSE coalesce("body", '') END), 'C')
) STORED;
--> statement-breakpoint
CREATE INDEX "clauses_search_tsv_idx" ON "clauses" USING gin ("search_tsv");
--> statement-breakpoint

-- (2) DB-level body_summary presence check.
ALTER TABLE "clauses"
  ADD CONSTRAINT "clauses_summary_present_check"
  CHECK ("body_kind" = 'full_text' OR "body_summary" IS NOT NULL);
--> statement-breakpoint

-- (3) Statute licence-flip guard.
CREATE OR REPLACE FUNCTION statutes_copyright_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.licence IS DISTINCT FROM 'crown_copyright_open'
     AND EXISTS (
       SELECT 1 FROM clauses
       WHERE statute_id = NEW.id AND body_kind = 'full_text'
     ) THEN
    RAISE EXCEPTION
      'statutes_copyright_guard: cannot set licence to % while statute % has full_text clauses',
      NEW.licence, NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER statutes_copyright_guard_trigger
BEFORE UPDATE ON statutes
FOR EACH ROW EXECUTE FUNCTION statutes_copyright_guard();
