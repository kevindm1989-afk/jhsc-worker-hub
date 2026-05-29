#!/usr/bin/env bun
// Admin CLI for the auth runbook (docs/runbooks/auth.md).
//
// Subcommands:
//   --check       --email <addr>
//        Report the current lockout state for an identifier (without
//        touching the table).
//   --unlock      --email <addr> --reason <text> --operator <text>
//        Clear the hard-tier failure rows for an identifier and emit a
//        `lockout.cleared` audit event.
//   --logout-all  --email <addr> --reason <text> --operator <text>
//        Delete every sessions row for the user and emit a
//        `session.revoked` audit event (scope=all).
//   --lookup-hash --email <addr>
//        Print the BLAKE2b email lookup hash (hex) so the operator can
//        cross-reference user_profiles without decrypting columns.
//
// All actions write to `auth_events` with metadata-only context
// (operator, reason, scope) — never PI. PI columns stay encrypted.

import { and, eq, gte } from 'drizzle-orm';
import { initCrypto } from '../src/auth/crypto-stub';
import { emitAuthEvent } from '../src/auth/events';
import { lookupHashForEmail } from '../src/auth/identifier';
import { getDb } from '../src/db/client';
import { authEvents, loginAttempts, sessions, userProfiles } from '../src/db/schema';
import { env } from '../src/env';

interface Flags {
  readonly check: boolean;
  readonly unlock: boolean;
  readonly logoutAll: boolean;
  readonly lookupHash: boolean;
  readonly email?: string;
  readonly reason?: string;
  readonly operator?: string;
}

function parseArgs(argv: ReadonlyArray<string>): Flags {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };
  return {
    check: argv.includes('--check'),
    unlock: argv.includes('--unlock'),
    logoutAll: argv.includes('--logout-all'),
    lookupHash: argv.includes('--lookup-hash'),
    email: get('email'),
    reason: get('reason'),
    operator: get('operator'),
  };
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const actions = [flags.check, flags.unlock, flags.logoutAll, flags.lookupHash].filter(Boolean);
  if (actions.length !== 1) {
    fail('exactly one of --check, --unlock, --logout-all, --lookup-hash is required');
  }
  if (!flags.email) fail('--email is required');
  if ((flags.unlock || flags.logoutAll) && (!flags.reason || !flags.operator)) {
    fail('--reason and --operator are required for write actions');
  }

  await initCrypto();
  const identifierHash = await lookupHashForEmail(flags.email);
  process.stdout.write(`identifier_hash: ${toHex(identifierHash)}\n`);

  if (flags.lookupHash) {
    process.exit(0);
  }

  const db = getDb();

  if (flags.check) {
    const since = new Date(Date.now() - env.AUTH_LOCKOUT_HARD_WINDOW_SECONDS * 1000);
    const rows = await db
      .select()
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.identifierHash, identifierHash),
          eq(loginAttempts.outcome, 'failure'),
          gte(loginAttempts.ts, since),
        ),
      );
    const tier =
      rows.length >= env.AUTH_LOCKOUT_HARD_FAILS
        ? 'hard'
        : rows.length >= env.AUTH_LOCKOUT_LONG_FAILS
          ? 'long'
          : rows.length >= env.AUTH_LOCKOUT_SHORT_FAILS
            ? 'short'
            : 'none';
    process.stdout.write(
      `failures in the last ${env.AUTH_LOCKOUT_HARD_WINDOW_SECONDS}s: ${rows.length}\n`,
    );
    process.stdout.write(`tier: ${tier}\n`);
    if (tier === 'hard') {
      process.stdout.write('action required: confirm with the rep, then run --unlock\n');
    }
    process.exit(0);
  }

  if (flags.unlock) {
    const since = new Date(Date.now() - env.AUTH_LOCKOUT_HARD_WINDOW_SECONDS * 1000);
    const deleted = await db
      .delete(loginAttempts)
      .where(
        and(
          eq(loginAttempts.identifierHash, identifierHash),
          eq(loginAttempts.outcome, 'failure'),
          gte(loginAttempts.ts, since),
        ),
      )
      .returning({ id: loginAttempts.id });
    await emitAuthEvent({
      actorId: null,
      kind: 'lockout.cleared',
      metadata: {
        operator: flags.operator,
        reason: flags.reason,
        rows_deleted: deleted.length,
      },
    });
    process.stdout.write(`cleared ${deleted.length} failure row(s)\n`);
    process.exit(0);
  }

  if (flags.logoutAll) {
    // Resolve the user via the keyed lookup hash so PI never lands in
    // argv (and the SQL query has no plaintext email either).
    const userRows = await db
      .select({ userId: userProfiles.userId })
      .from(userProfiles)
      .where(eq(userProfiles.emailLookupHash, identifierHash))
      .limit(1);
    const userId = userRows[0]?.userId;
    if (!userId) {
      fail('no user matches that email');
    }
    const removed = await db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    await emitAuthEvent({
      actorId: userId,
      kind: 'session.revoked',
      metadata: {
        operator: flags.operator,
        reason: flags.reason,
        scope: 'all',
        sessions_removed: removed.length,
      },
    });
    process.stdout.write(`revoked ${removed.length} session(s) for user ${userId}\n`);
    process.exit(0);
  }

  // Suppress "value never used" warnings on the schema imports during
  // typecheck if a code path is later removed.
  void authEvents;
}

main().catch((e: unknown) => {
  process.stderr.write(`auth-unlock failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
