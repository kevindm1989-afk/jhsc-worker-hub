// Test-only DB helpers — used by integration tests that need a clean
// slate against the local Postgres fixture.
//
// Skips at runtime if DATABASE_URL is unset, so the unit-test pass on
// machines without a DB stays green. CI sets DATABASE_URL via the
// docker-compose Postgres in apps/api's test job.

import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL;
}

const TABLES_TO_TRUNCATE = [
  'hazard_status_history',
  'hazards',
  'clauses',
  'statutes',
  'corpus_versions',
  'audit_log',
  'auth_events',
  'login_attempts',
  'webauthn_challenges',
  'sessions',
  'recovery_codes',
  'totp_credentials',
  'password_credentials',
  'passkey_credentials',
  'user_profiles',
  'users',
] as const;

// Reset every auth-surface table to a known empty state, then re-seed
// the setup_state singleton to "not completed." Production
// audit_log is bootstrapped with idx=0 system.genesis + idx=1 backfill
// anchor; tests do the same so verify() invariants tied to genesis
// stay realistic (security-reviewer F5).
//
// TRUNCATE ... CASCADE on users propagates to setup_state via the FK
// on first_run_completed_by. We follow up with an upsert so the
// singleton is always there for the next test, even after CASCADE
// removed it.
export async function cleanAuthTables(): Promise<void> {
  const db = getDb();
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    ),
  );
  // hazards_code_seq is a standalone sequence (not a column default
  // serial), so TRUNCATE ... RESTART IDENTITY doesn't reset it. Reset
  // explicitly so hazard_code values are deterministic across tests.
  await db.execute(sql`ALTER SEQUENCE hazards_code_seq RESTART WITH 1`);
  await db.execute(
    sql`INSERT INTO "setup_state" (id, first_run_completed_at, first_run_completed_by) VALUES (1, NULL, NULL) ON CONFLICT (id) DO UPDATE SET first_run_completed_at = NULL, first_run_completed_by = NULL`,
  );
  // Re-seed audit_log genesis + backfill anchor so the chain starts in
  // production-shape on every test. Hash values match what
  // migrations/0001_audit_chain.sql ships; see
  // apps/api/scripts/seed-audit-genesis.ts.
  await db.execute(
    sql`INSERT INTO audit_log (idx, ts, actor_id, kind, resource_type, resource_id, ip, user_agent, prev_hash, this_hash, payload) VALUES
      (0, to_timestamp(1780012800000 / 1000.0), NULL, 'system.genesis', NULL, NULL, NULL, NULL, '\\x0000000000000000000000000000000000000000000000000000000000000000'::bytea, '\\x6699ab189d5998b266679d2e44b5c6e7a64d1b53adc36b01f4f214507f7ac7c8'::bytea, '{"kind":"system.genesis","schemaVersion":"1.3.0"}'::jsonb),
      (1, to_timestamp(1780012800001 / 1000.0), NULL, 'audit.backfill.1_2_auth_events', 'auth_events', NULL, NULL, NULL, '\\x6699ab189d5998b266679d2e44b5c6e7a64d1b53adc36b01f4f214507f7ac7c8'::bytea, '\\x7e55e68da35cd1f57bc891a38f66d5ebe4abadbb6d8d3926026a7d55c93998de'::bytea, '{"kind":"audit.backfill.1_2_auth_events","rowCount":0,"rowsSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","oldestTs":null,"newestTs":null}'::jsonb)`,
  );
}
