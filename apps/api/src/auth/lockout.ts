// Brute-force lockout ladder (SECURITY.md §3 / ADR-0001).
//
// State of the world lives in `login_attempts`. We do NOT keep
// in-memory counters — restarts and multi-process deploys must share
// the truth.
//
// Lockout decision is OR over per-identifier and per-IP counts. This
// blocks two attacker patterns:
// - Targeting a specific email from many IPs (caught per-identifier).
// - Spraying many emails from one IP (caught per-IP).
//
// Identifier is stored as BLAKE2b(lowercased email | userId) keyed
// with the master key. The plaintext email never lands in this table —
// the table itself would otherwise be an enumeration target.

import { and, count, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { loginAttempts } from '../db/schema';
import { env } from '../env';

export type LockoutTier = 'short' | 'long' | 'hard';

export interface LockoutState {
  readonly locked: boolean;
  readonly tier?: LockoutTier;
  /** Seconds until the soonest unlock window opens; absent for hard tier. */
  readonly retryAfterSeconds?: number;
}

export interface CheckLockoutInput {
  readonly identifierHash: Uint8Array;
  readonly ip?: string | null;
  readonly nowMs?: number;
}

interface TierSpec {
  readonly tier: LockoutTier;
  readonly fails: number;
  readonly windowSeconds: number;
}

function tiers(): ReadonlyArray<TierSpec> {
  // Order: hardest tier first. The check returns the most severe
  // current state.
  return [
    {
      tier: 'hard',
      fails: env.AUTH_LOCKOUT_HARD_FAILS,
      windowSeconds: env.AUTH_LOCKOUT_HARD_WINDOW_SECONDS,
    },
    {
      tier: 'long',
      fails: env.AUTH_LOCKOUT_LONG_FAILS,
      windowSeconds: env.AUTH_LOCKOUT_LONG_WINDOW_SECONDS,
    },
    {
      tier: 'short',
      fails: env.AUTH_LOCKOUT_SHORT_FAILS,
      windowSeconds: env.AUTH_LOCKOUT_SHORT_WINDOW_SECONDS,
    },
  ];
}

async function countFailures(
  identifierHash: Uint8Array,
  ip: string | null | undefined,
  sinceMs: number,
): Promise<number> {
  const db = getDb();
  const since = new Date(sinceMs);
  // SELECT COUNT(*) FROM login_attempts WHERE outcome='failure'
  //   AND ts >= $since
  //   AND (identifier_hash = $h OR ip = $ip)
  // We OR identifier OR ip, but Drizzle 0.45's typings make a clean OR
  // awkward when ip is null; we run two queries and add — same algorithmic
  // cost (both use indexes; the small overcount when both match the
  // same row is conservative for the user's benefit, not the attacker's).
  const byIdQuery = db
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.outcome, 'failure'),
        gte(loginAttempts.ts, since),
        eq(loginAttempts.identifierHash, identifierHash),
      ),
    );
  const byIdRows = await byIdQuery;
  const byId = (byIdRows[0]?.n ?? 0) as number;
  if (!ip) return byId;
  const byIpRows = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.outcome, 'failure'),
        gte(loginAttempts.ts, since),
        sql`${loginAttempts.ip}::text = ${ip}`,
      ),
    );
  const byIp = (byIpRows[0]?.n ?? 0) as number;
  // Overlap (same row counted in both) is conservative: it pushes the
  // user toward lockout slightly sooner than strict OR would. Acceptable
  // and documented.
  return byId + byIp;
}

export async function checkLockout(input: CheckLockoutInput): Promise<LockoutState> {
  const now = input.nowMs ?? Date.now();
  for (const t of tiers()) {
    const sinceMs = now - t.windowSeconds * 1000;
    const n = await countFailures(input.identifierHash, input.ip, sinceMs);
    if (n >= t.fails) {
      if (t.tier === 'hard') {
        return { locked: true, tier: 'hard' };
      }
      return {
        locked: true,
        tier: t.tier,
        // Earliest unlock = when the (n - threshold + 1)-th oldest
        // failure in the window expires. Without that timestamp we
        // conservatively report the full window — a slight over-report
        // is fine.
        retryAfterSeconds: t.windowSeconds,
      };
    }
  }
  return { locked: false };
}

export interface RecordAttemptInput {
  readonly identifierHash: Uint8Array;
  readonly ip?: string | null;
  readonly outcome: 'success' | 'failure';
}

export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  const db = getDb();
  await db.insert(loginAttempts).values({
    identifierHash: input.identifierHash,
    ip: input.ip ?? null,
    outcome: input.outcome,
  });
}

/**
 * Admin-side hard-tier unlock. Deletes the failure rows in the hard
 * window for the identifier. Called by the runbook CLI (docs/runbooks/
 * auth.md, follow-up). Emits a `lockout.cleared` audit event upstream.
 */
export async function clearHardLockout(identifierHash: Uint8Array): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - env.AUTH_LOCKOUT_HARD_WINDOW_SECONDS * 1000);
  const result = await db
    .delete(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifierHash, identifierHash),
        eq(loginAttempts.outcome, 'failure'),
        gte(loginAttempts.ts, since),
      ),
    );
  // postgres-js delete result: rowCount lives on the awaited object in
  // drizzle 0.45 as `.rowsAffected` (driver-specific). Return -1 when
  // unavailable rather than throw.
  const affected = (result as unknown as { rowsAffected?: number; count?: number }).rowsAffected;
  return typeof affected === 'number' ? affected : -1;
}
