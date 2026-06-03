-- Milestone 2.2 S5 fix bundle — CRITICAL F-L1 / F-S4.
--
-- The full UNIQUE on action_item_closures(action_item_id) added in 0012
-- structurally blocks the reopen + re-close cycle that ADR-0013 §3.1
-- + SECURITY §2.14 T-IM32 specify: re-opening clears the FK on
-- action_items, but the CHECK `(status='Closed') == (closure_verification_id
-- IS NOT NULL)` requires a new closure row to satisfy a later re-close,
-- and the full UNIQUE rejects every INSERT after the first. The
-- reviewer-trio surfaced this as a release-blocker (linkage CRITICAL
-- F-L1; security MEDIUM F-S4 — same defect).
--
-- The T-IM32 mitigation text already prescribed the correct shape:
-- `superseded_at TIMESTAMPTZ NULL` + partial UNIQUE `WHERE
-- superseded_at IS NULL`. This migration lands the column + replaces
-- the UNIQUE accordingly.
--
-- Append-only; no edits to 0012.
--
-- Migration steps:
--   1. ADD COLUMN superseded_at (nullable) — historical rows are
--      ACTIVE by default (superseded_at IS NULL), so the partial
--      UNIQUE behaves identically to the prior full UNIQUE for the
--      already-closed-once population. Backfill is a no-op.
--   2. DROP the strict UNIQUE.
--   3. CREATE the partial UNIQUE on action_item_id WHERE
--      superseded_at IS NULL (one ACTIVE closure per item; superseded
--      rows stack).
--   4. CHECK: a closure can only be SUPERSEDED after it was
--      counter-signed (sanity bound; the route stamps superseded_at
--      via now() during reopen which is always > counter_signed_at).

-- ---------------------------------------------------------------------------
-- 1. Add the superseded_at column (NULL = active; NOT NULL = superseded
--    by a later reopen + re-close cycle). The reopen route stamps this
--    column on the prior closure row inside its transaction.
-- ---------------------------------------------------------------------------

ALTER TABLE "action_item_closures"
	ADD COLUMN "superseded_at" timestamp with time zone;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Drop the strict UNIQUE that blocks re-closes.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "action_item_closures_action_item_unique";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Partial UNIQUE — only ONE active (not-superseded) closure per
--    action_item at any time. Re-opening stamps the prior row's
--    superseded_at; a later re-close INSERT then succeeds because the
--    partial UNIQUE no longer counts the superseded row.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "action_item_closures_active_uq"
	ON "action_item_closures" USING btree ("action_item_id")
	WHERE "superseded_at" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Sanity CHECK: superseded_at must be after counter_signed_at when
--    set. Defense-in-depth — the route always stamps now() at reopen
--    time which is by construction > counter_signed_at, but a
--    hand-crafted UPDATE that backdates the supersession would trip
--    the CHECK and be rejected.
-- ---------------------------------------------------------------------------

ALTER TABLE "action_item_closures"
	ADD CONSTRAINT "action_item_closures_superseded_at_check"
	CHECK ("superseded_at" IS NULL OR "superseded_at" > "counter_signed_at");
--> statement-breakpoint
