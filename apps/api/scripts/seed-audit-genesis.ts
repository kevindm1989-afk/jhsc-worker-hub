#!/usr/bin/env bun
// One-shot generator: emit the SQL that seeds the audit_log genesis
// row (idx=0) and the 1.2 auth_events backfill anchor (idx=1) using
// canonical-JSON + SHA-256 as packages/audit's computeThisHash does.
//
// Run once when preparing the 1.3 migration. The output gets appended
// to migrations/0001_audit_chain.sql. The script intentionally lives
// in apps/api/scripts so it can use the auth_events query path and
// share the canonical-JSON serializer.
//
// Usage:
//   DATABASE_URL=... bun run apps/api/scripts/seed-audit-genesis.ts \
//     --emit-sql > /tmp/genesis.sql
//
// The output is idempotent SQL: it skips the inserts if idx=0 already
// exists.

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalJsonStringify, computeThisHash, GENESIS_PREV_HASH } from '@jhsc/audit';
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

function toHexBytea(b: Uint8Array): string {
  return `'\\x${Buffer.from(b).toString('hex')}'::bytea`;
}

async function main(): Promise<void> {
  const emit = process.argv.includes('--emit-sql');
  if (!emit) {
    process.stderr.write('pass --emit-sql to print the seed SQL on stdout\n');
    process.exit(2);
  }

  // Genesis row.
  const genesisTsMs = Date.UTC(2026, 4, 29, 0, 0, 0);
  const genesisPayload = { kind: 'system.genesis' as const, schemaVersion: '1.3.0' };
  const genesisHash = computeThisHash(
    GENESIS_PREV_HASH,
    {
      idx: 0,
      tsMs: genesisTsMs,
      actorId: null,
      kind: 'system.genesis',
      resourceType: null,
      resourceId: null,
    },
    genesisPayload,
  );

  // Backfill anchor over the current auth_events table.
  const db = getDb();
  const eventRows = (await db.execute(sql`
    SELECT id, ts, actor_id, kind, ip, user_agent, metadata
    FROM ${authEvents}
    ORDER BY ts ASC, id ASC
  `)) as unknown as { rows: AuthEventRow[] };
  const rows = eventRows.rows ?? [];
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
  const rowsSha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');

  const anchorTsMs = genesisTsMs + 1;
  const anchorPayload = {
    kind: 'audit.backfill.1_2_auth_events' as const,
    rowCount: rows.length,
    rowsSha256,
    oldestTs: rows[0]?.ts.toISOString() ?? null,
    newestTs: rows[rows.length - 1]?.ts.toISOString() ?? null,
  };
  const anchorHash = computeThisHash(
    genesisHash,
    {
      idx: 1,
      tsMs: anchorTsMs,
      actorId: null,
      kind: 'audit.backfill.1_2_auth_events',
      resourceType: 'auth_events',
      resourceId: null,
    },
    anchorPayload,
  );

  const out: string[] = [];
  out.push('-- Seed the audit chain: genesis (idx=0) + 1.2 auth_events backfill anchor (idx=1).');
  out.push('-- Idempotent: skipped if idx=0 already exists.');
  out.push('DO $$');
  out.push('BEGIN');
  out.push('  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE idx = 0) THEN');
  out.push(
    '    INSERT INTO audit_log (idx, ts, actor_id, kind, resource_type, resource_id, prev_hash, this_hash, payload) VALUES',
  );
  out.push(
    `      (0, to_timestamp(${genesisTsMs} / 1000.0), NULL, 'system.genesis', NULL, NULL, ${toHexBytea(GENESIS_PREV_HASH)}, ${toHexBytea(genesisHash)}, '${JSON.stringify(genesisPayload).replace(/'/g, "''")}'::jsonb),`,
  );
  out.push(
    `      (1, to_timestamp(${anchorTsMs} / 1000.0), NULL, 'audit.backfill.1_2_auth_events', 'auth_events', NULL, ${toHexBytea(genesisHash)}, ${toHexBytea(anchorHash)}, '${JSON.stringify(anchorPayload).replace(/'/g, "''")}'::jsonb);`,
  );
  out.push('  END IF;');
  out.push('END $$;');

  process.stdout.write(out.join('\n') + '\n');
}

main().catch((e: unknown) => {
  process.stderr.write(
    `seed-audit-genesis failed: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
