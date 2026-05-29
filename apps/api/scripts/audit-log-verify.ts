#!/usr/bin/env bun
// Audit-log chain verifier (ADR-0002, runbook §7).
//
// Walks audit_log idx ASC, recomputes this_hash for every row, and
// exits 0 on PASS or non-zero with the diverging idx on FAIL. Run
// nightly via cron / pg-boss (SECURITY.md §3 — Audit & Logging).
//
// Usage:
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --quiet
//
// Exit codes
//   0   chain verified
//   1   tamper detected (firstDivergence reported)
//   2   operational error (could not reach DB, etc.)

import { verify } from '@jhsc/audit';
import { getDb } from '../src/db/client';

async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet');
  const db = getDb();
  const result = await verify(db);
  if (result.ok) {
    if (quiet) {
      process.stdout.write(
        `audit-log-verify OK rows=${result.checked} lastIdx=${result.lastIdx}\n`,
      );
    } else {
      process.stdout.write(
        `audit-log-verify PASS\n  rows checked: ${result.checked}\n  last idx:     ${result.lastIdx}\n`,
      );
    }
    process.exit(0);
  }
  if (quiet) {
    process.stdout.write(
      `audit-log-verify TAMPER firstDivergence=${result.firstDivergence} reason=${result.reason}\n`,
    );
  } else {
    process.stderr.write(
      `audit-log-verify FAIL\n  first divergence at idx: ${result.firstDivergence}\n  reason:                  ${result.reason}\n`,
    );
    process.stderr.write('\nRun docs/runbooks/auth.md §7 (tamper response) immediately.\n');
  }
  process.exit(1);
}

main().catch((e: unknown) => {
  process.stderr.write(
    `audit-log-verify operational error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(2);
});
