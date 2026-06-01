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
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --check-backfill
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --check-evidence
//
// Exit codes
//   0   chain verified (and any requested anchor checks pass)
//   1   tamper detected (firstDivergence reported, or backfill mismatch,
//       or evidence forward-defense check fails)
//   2   operational error (could not reach DB, etc.)

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalJsonStringify, verify } from '@jhsc/audit';
import { authEvents } from '../src/db/schema';
import { getDb } from '../src/db/client';

interface AuthEventRow {
  id: string;
  ts: Date;
  actor_id: string | null;
  kind: string;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

interface BackfillAnchorPayload {
  kind: 'audit.backfill.1_2_auth_events';
  rowCount: number;
  rowsSha256: string;
  oldestTs: string | null;
  newestTs: string | null;
}

async function checkBackfillAnchor(
  db: ReturnType<typeof getDb>,
): Promise<
  { ok: true; rowCount: number } | { ok: false; reason: string; expected?: string; actual?: string }
> {
  // Read the anchor (idx=1, kind='audit.backfill.1_2_auth_events').
  const anchorRows = (await db.execute(sql`
    SELECT payload FROM audit_log
    WHERE idx = 1 AND kind = 'audit.backfill.1_2_auth_events'
  `)) as unknown as Array<{ payload: BackfillAnchorPayload }>;
  if (anchorRows.length === 0) {
    return { ok: false, reason: 'anchor_missing' };
  }
  const stored = anchorRows[0]!.payload;
  // Recompute rowsSha256 from live auth_events.
  const rows = (await db.execute(sql`
    SELECT id, ts, actor_id, kind, ip, user_agent, metadata
    FROM ${authEvents}
    ORDER BY ts ASC, id ASC
  `)) as unknown as AuthEventRow[];
  const canonical = canonicalJsonStringify(
    rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      actor_id: r.actor_id,
      kind: r.kind,
      ip: r.ip,
      user_agent: r.user_agent,
      metadata: r.metadata,
    })),
  );
  const liveHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  if (liveHash !== stored.rowsSha256) {
    return {
      ok: false,
      reason: 'rowsSha256_mismatch',
      expected: stored.rowsSha256,
      actual: liveHash,
    };
  }
  if (rows.length !== stored.rowCount) {
    return {
      ok: false,
      reason: 'rowCount_mismatch',
      expected: String(stored.rowCount),
      actual: String(rows.length),
    };
  }
  return { ok: true, rowCount: rows.length };
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * sec-F1 forward defense: reject any chain row whose payload carries
 * the all-zero placeholder UUID. The pre-fix evidence finalize handler
 * (Milestone 1.7) emitted `evidence.uploaded` rows with a literal
 * '00000000-0000-0000-0000-000000000000' in the `evidenceId` slot — the
 * fix is to pre-allocate the UUID, but a regression here would silently
 * break the chain-only export contract. Scan all rows for the marker.
 */
async function checkEvidenceForwardDefense(
  db: ReturnType<typeof getDb>,
): Promise<{ ok: true; checked: number } | { ok: false; offendingIdx: number; kind: string }> {
  const rows = (await db.execute(sql`
    SELECT idx, kind, payload
    FROM audit_log
    WHERE kind IN ('evidence.uploaded', 'evidence.read')
    ORDER BY idx ASC
  `)) as unknown as Array<{ idx: number; kind: string; payload: { evidenceId?: string } }>;
  for (const row of rows) {
    if (row.payload.evidenceId === ZERO_UUID) {
      return { ok: false, offendingIdx: row.idx, kind: row.kind };
    }
  }
  return { ok: true, checked: rows.length };
}

async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet');
  const checkBackfill = process.argv.includes('--check-backfill');
  const checkEvidence = process.argv.includes('--check-evidence');
  const db = getDb();
  const result = await verify(db);
  if (!result.ok) {
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

  if (checkEvidence) {
    const evidence = await checkEvidenceForwardDefense(db);
    if (!evidence.ok) {
      if (quiet) {
        process.stdout.write(
          `audit-log-verify EVIDENCE_PLACEHOLDER_UUID idx=${evidence.offendingIdx} kind=${evidence.kind}\n`,
        );
      } else {
        process.stderr.write(
          `audit-log-verify FAIL (evidence forward defense)\n  offending idx: ${evidence.offendingIdx}\n  kind:          ${evidence.kind}\n  reason:        evidenceId is the all-zero placeholder UUID\n`,
        );
        process.stderr.write(
          '\nA evidence audit payload carries the sec-F1 placeholder UUID — the finalize handler regressed. Inspect the offending row and re-run the fix.\n',
        );
      }
      process.exit(1);
    }
    if (!quiet) {
      process.stdout.write(
        `audit-log-verify evidence forward defense: ${evidence.checked} chain row(s) checked, no placeholder UUIDs found.\n`,
      );
    }
  }

  if (checkBackfill) {
    const backfill = await checkBackfillAnchor(db);
    if (!backfill.ok) {
      if (quiet) {
        process.stdout.write(
          `audit-log-verify BACKFILL_TAMPER reason=${backfill.reason}${backfill.expected ? ` expected=${backfill.expected}` : ''}${backfill.actual ? ` actual=${backfill.actual}` : ''}\n`,
        );
      } else {
        process.stderr.write(
          `audit-log-verify FAIL (backfill anchor)\n  reason: ${backfill.reason}\n${backfill.expected ? `  expected rowsSha256: ${backfill.expected}\n  actual rowsSha256:   ${backfill.actual}\n` : ''}`,
        );
        process.stderr.write(
          '\nLive auth_events no longer matches the idx=1 backfill anchor — chain integrity for the 1.2 window is BROKEN. Runbook §7.\n',
        );
      }
      process.exit(1);
    }
    if (quiet) {
      process.stdout.write(
        `audit-log-verify OK rows=${result.checked} lastIdx=${result.lastIdx} backfillRows=${backfill.rowCount}\n`,
      );
    } else {
      process.stdout.write(
        `audit-log-verify PASS\n  rows checked:    ${result.checked}\n  last idx:        ${result.lastIdx}\n  backfill anchor: ${backfill.rowCount} row(s), rowsSha256 matches live auth_events\n`,
      );
    }
    process.exit(0);
  }

  if (quiet) {
    process.stdout.write(`audit-log-verify OK rows=${result.checked} lastIdx=${result.lastIdx}\n`);
  } else {
    process.stdout.write(
      `audit-log-verify PASS\n  rows checked: ${result.checked}\n  last idx:     ${result.lastIdx}\n`,
    );
  }
  process.exit(0);
}

main().catch((e: unknown) => {
  process.stderr.write(
    `audit-log-verify operational error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(2);
});
