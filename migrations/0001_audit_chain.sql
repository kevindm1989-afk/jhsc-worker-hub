CREATE TABLE "audit_log" (
	"idx" bigint PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"prev_hash" "bytea" NOT NULL,
	"this_hash" "bytea" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_this_hash_unique" ON "audit_log" USING btree ("this_hash");--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_log_kind_ts_idx" ON "audit_log" USING btree ("kind","ts");--> statement-breakpoint
CREATE INDEX "audit_log_actor_ts_idx" ON "audit_log" USING btree ("actor_id","ts");-- Seed the audit chain: genesis (idx=0) + 1.2 auth_events backfill anchor (idx=1).
-- Idempotent: skipped if idx=0 already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE idx = 0) THEN
    INSERT INTO audit_log (idx, ts, actor_id, kind, resource_type, resource_id, prev_hash, this_hash, payload) VALUES
      (0, to_timestamp(1780012800000 / 1000.0), NULL, 'system.genesis', NULL, NULL, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea, '\xc4aedc698a3a087dbc5fd958e1990d8d7a8093ab99279b51cbb69d2066003133'::bytea, '{"kind":"system.genesis","schemaVersion":"1.3.0"}'::jsonb),
      (1, to_timestamp(1780012800001 / 1000.0), NULL, 'audit.backfill.1_2_auth_events', 'auth_events', NULL, '\xc4aedc698a3a087dbc5fd958e1990d8d7a8093ab99279b51cbb69d2066003133'::bytea, '\x4b3e29146afb5d04cb5a88729c1843aeeeb8b20f5669b77be447e50f2781705a'::bytea, '{"kind":"audit.backfill.1_2_auth_events","rowCount":0,"rowsSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","oldestTs":null,"newestTs":null}'::jsonb);
  END IF;
END $$;
