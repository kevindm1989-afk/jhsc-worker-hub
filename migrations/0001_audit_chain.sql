CREATE TABLE "audit_log" (
	"idx" bigint PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"ip" "inet",
	"user_agent" text,
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
    INSERT INTO audit_log (idx, ts, actor_id, kind, resource_type, resource_id, ip, user_agent, prev_hash, this_hash, payload) VALUES
      (0, to_timestamp(1780012800000 / 1000.0), NULL, 'system.genesis', NULL, NULL, NULL, NULL, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea, '\x6699ab189d5998b266679d2e44b5c6e7a64d1b53adc36b01f4f214507f7ac7c8'::bytea, '{"kind":"system.genesis","schemaVersion":"1.3.0"}'::jsonb),
      (1, to_timestamp(1780012800001 / 1000.0), NULL, 'audit.backfill.1_2_auth_events', 'auth_events', NULL, NULL, NULL, '\x6699ab189d5998b266679d2e44b5c6e7a64d1b53adc36b01f4f214507f7ac7c8'::bytea, '\x7e55e68da35cd1f57bc891a38f66d5ebe4abadbb6d8d3926026a7d55c93998de'::bytea, '{"kind":"audit.backfill.1_2_auth_events","rowCount":0,"rowsSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","oldestTs":null,"newestTs":null}'::jsonb);
  END IF;
END $$;
