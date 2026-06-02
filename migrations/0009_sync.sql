-- Milestone 1.10 (ADR-0009): offline sync infrastructure — server-side
-- replay deduplication ledger + per-entity optimistic-concurrency
-- version column + version-bump trigger.
--
-- Two new structures land here:
--
--   1. sync_idempotency — the replay-dedup ledger that backs the
--      Idempotency-Key middleware (apps/api/src/middleware/idempotency.ts).
--      The middleware caches a (actor, action_kind, entity_local_id,
--      payload_hash) tuple's response so a queue retry that drained but
--      lost the response leg returns the cached body without re-running
--      the handler — preserving the once-per-logical-operation chain-
--      anchor invariant (CLAUDE.md #2 + SECURITY.md §2.10 T-S4).
--
--      Cached response bodies are envelope-encrypted at rest because
--      they can carry server-allocated ids (recommendation_number,
--      action_item.id, hazardCode, etc.) and the cache is operational
--      infrastructure, not chain-anchored evidence — treating it as
--      "below the chain" but "above plaintext at rest" matches the
--      crypto posture of the rest of the app (CLAUDE.md "Encryption
--      Rules", 1.7 sec-F5).
--
--      NO chain anchor on idempotency lookups (T-S5 documents the gap).
--      The chain is the canonical evidentiary surface; the cache is
--      recovery plumbing.
--
--      TTL sweep: a pg-boss job runs hourly to
--        DELETE FROM sync_idempotency WHERE expires_at < now() - INTERVAL '1 day'
--      (1-day grace beyond expiry). NOT wired in this slice — that's
--      a 1.12 hardening item per ADR-0009 "Follow-ups". The table grows
--      monotonically through 1.10 (T-S6 documented residual).
--
--   2. Per-entity `version` integer column on the five MUTABLE entity
--      tables (hazards, action_items, inspections, inspection_findings,
--      recommendations). The `If-Match: <etag>` PATCH ratchet (S2 will
--      wire) compares client-supplied version against server version
--      under FOR UPDATE; mismatch returns 409 with the conflict body
--      so the client's queue worker writes a sync_conflicts row and
--      flips _sync_state='conflicting' (ADR-0009 §3.7, SECURITY.md
--      T-S7).
--
--      Append-only entities (action_item_moves, inspection_signatures,
--      recommendation_citations, recommendation_responses,
--      evidence_files, recommendation_action_item_links, audit_log,
--      sync_idempotency, workplace_keys, workplace_signing_keys,
--      inspection_templates, legal_clauses, export_records) do NOT get
--      the version column — they cannot be UPDATEd, so optimistic
--      concurrency has no surface. Inline-comment the rationale below
--      next to the ALTER TABLE block.
--
--   bump_version_on_update() is a single trigger function attached
--   BEFORE UPDATE on each of the five mutable tables. The conditional
--   `IF NEW.version = OLD.version` allows the route layer to set
--   `version = OLD.version + 1` explicitly in the UPDATE SET clause
--   (the optimistic-concurrency ratchet — S2 will wire this on every
--   PATCH handler) without double-bumping. Tests + manual SQL that
--   forget to set version explicitly still get the auto-bump.

CREATE TABLE "sync_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- The actor whose session signed the original request. The cache
	-- key is scoped to (actor, action_kind, entity, payload_hash) so a
	-- different rep replaying the same key against the same route is a
	-- different cache miss (T-S5 cross-actor probe defense).
	"actor_user_id" uuid NOT NULL,
	-- REST verb + path template, e.g. 'POST /api/recommendations'. Single
	-- text column to keep the middleware lookup fast — no per-action
	-- enum table. The route layer generates this from `c.req.method` +
	-- `c.req.routePath` so the value is stable across deploy hashes.
	"action_kind" text NOT NULL,
	-- The client-generated UUID v4 (ClientId) the body carried, when
	-- present. Nullable because not every route accepts clientId yet
	-- (transition / promote / resolve / withdraw routes don't create
	-- new top-level rows per ADR-0009 §3.3). The partial UNIQUE indexes
	-- below handle the NULL case correctly.
	"entity_local_id" uuid,
	-- SHA-256 of canonical-JSON of the request body. 32 bytes.
	"payload_hash" "bytea" NOT NULL,
	-- HTTP status code of the cached response. Constrained to the
	-- standard 100..599 range; the middleware refuses to cache 5xx
	-- (retry-safe semantics) but the CHECK accepts them so a future
	-- test fixture can write a 500 row without violating the CHECK.
	"response_status_code" integer NOT NULL,
	-- Cached response body (sealed JSON). Envelope-encrypted under the
	-- workplace KEK at write time; opened by the middleware on cache
	-- hit. The dek_ct pair mirrors the rest of the codebase's
	-- (*_ct, *_dek_ct) shape (1.5 hazards, 1.7 evidence, 1.8
	-- inspections, 1.9 recommendations).
	"response_body_ct" "bytea" NOT NULL,
	"response_body_dek_ct" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- 7-day TTL per ADR-0009 §3.4. The dead-letter ceiling is 48h
	-- (T-S10) so no operation drains via the queue worker past the TTL
	-- in practice; a rep who manually retries a dead-letter row after
	-- >7 days hits the runbook's documented "re-emit chain anchor"
	-- path (T-S6 residual).
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_idempotency_response_status_check"
		CHECK ("response_status_code" >= 100 AND "response_status_code" <= 599),
	CONSTRAINT "sync_idempotency_payload_hash_length_check"
		CHECK (octet_length("payload_hash") = 32),
	CONSTRAINT "sync_idempotency_response_body_length_check"
		CHECK (octet_length("response_body_ct") > 0 AND octet_length("response_body_dek_ct") > 0),
	CONSTRAINT "sync_idempotency_actor_fk"
		FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
-- The four-way idempotency key is (actor_user_id, action_kind,
-- entity_local_id, payload_hash). PostgreSQL UNIQUE treats NULLs as
-- distinct, so a single UNIQUE over the four-tuple would let two
-- different routes with NULL entity_local_id but the same actor +
-- action_kind + payload_hash both insert successfully. We therefore
-- split into two partial UNIQUE indexes that DO cover the NULL case
-- correctly:
--   (1) WHERE entity_local_id IS NOT NULL — the common path; clientId
--       was supplied and is part of the four-tuple key.
--   (2) WHERE entity_local_id IS NULL — the rare path; idempotency is
--       still scoped to (actor, action_kind, payload_hash).
-- A future route that opts in to idempotency without a clientId (e.g.
-- a step-up-issue endpoint) lands in path (2) automatically.
CREATE UNIQUE INDEX "sync_idempotency_key_with_entity_unique"
	ON "sync_idempotency" ("actor_user_id", "action_kind", "entity_local_id", "payload_hash")
	WHERE "entity_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "sync_idempotency_key_without_entity_unique"
	ON "sync_idempotency" ("actor_user_id", "action_kind", "payload_hash")
	WHERE "entity_local_id" IS NULL;
--> statement-breakpoint
-- expires_at index for the TTL sweep (1.12 pg-boss job). Partial
-- WHERE clause keeps the index small for the hot path; the sweep does
-- `WHERE expires_at < now() - INTERVAL '1 day'` so it walks the
-- already-expired tail only.
CREATE INDEX "sync_idempotency_expires_at_idx" ON "sync_idempotency" ("expires_at");
--> statement-breakpoint
-- created_at index for monitoring (1.12 Prometheus per-rep queue depth
-- metric — see ADR-0009 "Follow-ups").
CREATE INDEX "sync_idempotency_created_at_idx" ON "sync_idempotency" ("created_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Per-entity version column for optimistic-concurrency etag (§3.7)
-- ---------------------------------------------------------------------------
--
-- The FIVE mutable tables — hazards, action_items, inspections,
-- inspection_findings, recommendations — gain an `integer NOT NULL
-- DEFAULT 1` version column. Existing rows pick up version=1 on the
-- ALTER TABLE; subsequent UPDATEs increment via the bump_version_on_
-- update() trigger below.
--
-- Append-only tables (action_item_moves, inspection_signatures,
-- recommendation_citations, recommendation_responses, evidence_files,
-- recommendation_action_item_links, audit_log, sync_idempotency,
-- workplace_keys, workplace_signing_keys, inspection_templates,
-- legal_clauses, export_records, hazard_status_history) are NOT given
-- a version column — they cannot be UPDATEd, so optimistic concurrency
-- has no surface. Each row in those tables is its own atomic event;
-- the chain anchor on the parent entity carries the conflict semantics
-- (action_item_moves resolves by moved_at DESC per ADR-0009 §3.7,
-- inspection_signatures by UNIQUE(inspection_id, role)).

ALTER TABLE "hazards" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "action_items" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Version bump trigger (BEFORE UPDATE, FOR EACH ROW)
-- ---------------------------------------------------------------------------
--
-- The conditional `IF NEW.version = OLD.version` allows the route
-- layer (S2 will wire) to set `version = OLD.version + 1` explicitly
-- in the UPDATE SET clause — the canonical optimistic-concurrency
-- pattern — without double-bumping. When the route's UPDATE writes
-- `version = NEW.version` (the value the client If-Match'd against),
-- the trigger sees NEW.version == OLD.version and bumps once; when the
-- route writes `version = OLD.version + 1` explicitly, the trigger
-- sees a different value and respects it. Tests + ad-hoc SQL that
-- omit the version write still get the auto-bump.
--
-- The function is shared across the five mutable tables. Each table
-- gets its own BEFORE UPDATE trigger definition pointing at this one
-- function. Drizzle's UPDATE path doesn't need to know about the
-- trigger — it just emits `UPDATE table SET ... WHERE id = $1` and
-- the trigger handles the version arithmetic.

CREATE OR REPLACE FUNCTION bump_version_on_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hazards_bump_version_trigger
BEFORE UPDATE ON hazards
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER action_items_bump_version_trigger
BEFORE UPDATE ON action_items
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER inspections_bump_version_trigger
BEFORE UPDATE ON inspections
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER inspection_findings_bump_version_trigger
BEFORE UPDATE ON inspection_findings
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
--> statement-breakpoint
CREATE TRIGGER recommendations_bump_version_trigger
BEFORE UPDATE ON recommendations
FOR EACH ROW EXECUTE FUNCTION bump_version_on_update();
