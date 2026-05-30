#!/usr/bin/env bun
// Admin CLI for the auth runbook (docs/runbooks/auth.md).
//
// Identity selection — pass ONE of:
//   --email-from-stdin            Reads the email on stdin (prompt
//                                 silently with `read`, never lands in
//                                 argv / ps / shell history).
//   --identifier-hash <hex>       Skips identity collection entirely;
//                                 use this when the operator computed
//                                 the keyed BLAKE2b hash on a separate
//                                 workstation via --lookup-hash.
//
// Subcommands (exactly one):
//   --check
//        Report current lockout state (no DB write).
//   --unlock      --reason <text> --operator <text>
//        Clear hard-tier failure rows for the identifier and emit
//        `lockout.cleared` into auth_events (metadata only).
//   --logout-all  --reason <text> --operator <text>
//        Resolve the user via the lookup hash, delete every sessions
//        row, emit `session.revoked` (scope=all).
//   --lookup-hash
//        Print the BLAKE2b email lookup hash (hex). Use this on a
//        workstation OUTSIDE production to avoid landing the
//        plaintext email anywhere indexable.
//
// Security note (privacy-reviewer F1, security-reviewer F8):
// `--email <addr>` is intentionally NOT accepted. Process argv is
// observable to other UIDs via `ps`, captured by Fly Machine start
// logs, and lands in shell history. Read stdin or pass the hash.

import { and, eq, gte } from 'drizzle-orm';
import { createInterface } from 'node:readline';
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
  readonly emailFromStdin: boolean;
  readonly identifierHashHex?: string;
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
    emailFromStdin: argv.includes('--email-from-stdin'),
    identifierHashHex: get('identifier-hash'),
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

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    fail('--identifier-hash must be an even-length hex string');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function readLineSilent(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // stderr-side prompt so a future `| tee` capture of stdout does not
    // catch the prompt string.
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveIdentifierHash(flags: Flags): Promise<Uint8Array> {
  if (flags.identifierHashHex) {
    return fromHex(flags.identifierHashHex);
  }
  if (!flags.emailFromStdin) {
    fail('one of --email-from-stdin or --identifier-hash is required');
  }
  const email = await readLineSilent('rep email (will not echo to history): ');
  if (email.length === 0) fail('email is empty');
  await initCrypto();
  return lookupHashForEmail(email);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const actions = [flags.check, flags.unlock, flags.logoutAll, flags.lookupHash].filter(Boolean);
  if (actions.length !== 1) {
    fail('exactly one of --check, --unlock, --logout-all, --lookup-hash is required');
  }
  if ((flags.unlock || flags.logoutAll) && (!flags.reason || !flags.operator)) {
    fail('--reason and --operator are required for write actions');
  }

  await initCrypto();
  const identifierHash = await resolveIdentifierHash(flags);
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
      payload: {
        kind: 'lockout.cleared',
        operator: flags.operator!,
        reason: flags.reason!,
        rowsDeleted: deleted.length,
      },
    });
    process.stdout.write(`cleared ${deleted.length} failure row(s)\n`);
    process.exit(0);
  }

  if (flags.logoutAll) {
    const userRows = await db
      .select({ userId: userProfiles.userId })
      .from(userProfiles)
      .where(eq(userProfiles.emailLookupHash, identifierHash))
      .limit(1);
    const userId = userRows[0]?.userId;
    if (!userId) {
      fail('no user matches that identifier');
    }
    const removed = await db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    await emitAuthEvent({
      actorId: userId,
      payload: {
        kind: 'session.revoked',
        scope: 'all',
        sessionsRemoved: removed.length,
        operator: flags.operator!,
        reason: flags.reason!,
      },
    });
    process.stdout.write(`revoked ${removed.length} session(s) for user ${userId}\n`);
    process.exit(0);
  }

  void authEvents;
}

main().catch((e: unknown) => {
  process.stderr.write(`auth-unlock failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
