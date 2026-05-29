#!/usr/bin/env bun
// Auth-surface retention sweep (privacy-reviewer F2).
//
// What it prunes
//   webauthn_challenges — every row past expires_at + 1 hour grace.
//                         Operationally we never look at consumed
//                         challenges again; deleting them stops the
//                         table from growing unboundedly.
//   login_attempts      — rows older than 2× the hard-tier window.
//                         The lockout module only ever reads the most
//                         recent 24 h (default) of failures; everything
//                         past that has no operational use and is
//                         retention-only data.
//
// What it does NOT prune
//   auth_events         — pre-1.3 the flat audit table is the only
//                         tamper-evident substitute for the
//                         to-be-chain. ADR-0001's 1.3 backfill anchor
//                         is the only safe point to start culling.
//                         Documented in docs/runbooks/auth.md §6.
//
// Run it nightly from pg-boss (CLAUDE.md tech stack) when the
// scheduler is provisioned, or `bun run` it from a cron unit.
//
// Modes
//   (default)   Show how many rows would be deleted in each table.
//   --apply     Actually run the deletes.
//   --quiet     Suppress per-table line; print a single one-line
//               summary suitable for syslog.

import { and, eq, lt, sql } from 'drizzle-orm';
import { initCrypto } from '../src/auth/crypto-stub';
import { getDb } from '../src/db/client';
import { loginAttempts, webauthnChallenges } from '../src/db/schema';
import { env } from '../src/env';

const WEBAUTHN_GRACE_MS = 60 * 60 * 1000; // 1 hour
const LOGIN_ATTEMPTS_KEEP_FACTOR = 2;

interface Stats {
  webauthnChallenges: number;
  loginAttempts: number;
}

async function sweep(apply: boolean): Promise<Stats> {
  const db = getDb();
  const webauthnCutoff = new Date(Date.now() - WEBAUTHN_GRACE_MS);
  const loginAttemptsCutoff = new Date(
    Date.now() - LOGIN_ATTEMPTS_KEEP_FACTOR * env.AUTH_LOCKOUT_HARD_WINDOW_SECONDS * 1000,
  );

  if (apply) {
    const c = await db
      .delete(webauthnChallenges)
      .where(lt(webauthnChallenges.expiresAt, webauthnCutoff))
      .returning({ id: webauthnChallenges.id });
    const l = await db
      .delete(loginAttempts)
      .where(lt(loginAttempts.ts, loginAttemptsCutoff))
      .returning({ id: loginAttempts.id });
    return { webauthnChallenges: c.length, loginAttempts: l.length };
  }

  // Dry-run: COUNT(*) the rows that WOULD be deleted.
  const cRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webauthnChallenges)
    .where(lt(webauthnChallenges.expiresAt, webauthnCutoff));
  const lRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(lt(loginAttempts.ts, loginAttemptsCutoff));
  return {
    webauthnChallenges: cRows[0]?.n ?? 0,
    loginAttempts: lRows[0]?.n ?? 0,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const quiet = process.argv.includes('--quiet');
  await initCrypto();
  const stats = await sweep(apply);
  const verb = apply ? 'deleted' : 'would-delete';
  if (quiet) {
    process.stdout.write(
      `auth-retention ${verb} webauthn=${stats.webauthnChallenges} login_attempts=${stats.loginAttempts}\n`,
    );
  } else {
    process.stdout.write(`webauthn_challenges ${verb}: ${stats.webauthnChallenges}\n`);
    process.stdout.write(`login_attempts      ${verb}: ${stats.loginAttempts}\n`);
    if (!apply) {
      process.stdout.write('\nRun with --apply to actually delete.\n');
    }
  }
}

// Reference the unused predicates import so the typecheck does not
// complain when a future schema-only edit drops their first use site.
void and;
void eq;

main().catch((e: unknown) => {
  process.stderr.write(`auth-retention failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
