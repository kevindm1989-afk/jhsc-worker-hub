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
// the setup_state singleton to "not completed."
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
  await db.execute(
    sql`INSERT INTO "setup_state" (id, first_run_completed_at, first_run_completed_by) VALUES (1, NULL, NULL) ON CONFLICT (id) DO UPDATE SET first_run_completed_at = NULL, first_run_completed_by = NULL`,
  );
}
