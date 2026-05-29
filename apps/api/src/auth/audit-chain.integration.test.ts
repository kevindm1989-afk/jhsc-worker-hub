// DB-backed integration tests for @jhsc/audit's append() + verify().
//
// Closes security-reviewer F3: the slice-2 unit tests cover
// computeThisHash only; this suite walks real rows through Drizzle
// and exercises every divergence reason verify() can report.
//
// Skips when DATABASE_URL is unset so the laptop unit-test path stays
// green.

import { sql } from 'drizzle-orm';
import { append, verify } from '@jhsc/audit';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { bootAuthTestEnv } from './test-setup';
import { cleanAuthTables, hasDb } from './test-db';

const SKIP = !hasDb();

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  // cleanAuthTables() seeds genesis (idx=0) + backfill anchor (idx=1)
  // automatically — see test-db.ts.
  await cleanAuthTables();
});

describe.skipIf(SKIP)('audit chain — append + verify', () => {
  it('PASS on the freshly-seeded chain (genesis + anchor only)', async () => {
    const db = getDb();
    const result = await verify(db);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checked).toBe(2);
      expect(result.lastIdx).toBe(1);
    }
  });

  it('PASS after appending N rows', async () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) {
      await append(db, {
        actorId: null,
        payload: { kind: 'login.passkey' },
      });
    }
    const result = await verify(db);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checked).toBe(7); // 2 seed + 5 appended
      expect(result.lastIdx).toBe(6);
    }
  });

  it('FAIL with hash_mismatch when a row body is mutated (T-AC1)', async () => {
    const db = getDb();
    await append(db, {
      actorId: null,
      payload: { kind: 'login.passkey' },
    });
    // Mutate the kind on idx=2 — recomputed this_hash will not match
    // the stored this_hash.
    await db.execute(sql`UPDATE audit_log SET kind = 'login.password' WHERE idx = 2`);
    const result = await verify(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstDivergence).toBe(2);
      expect(result.reason).toBe('hash_mismatch');
    }
  });

  it('FAIL with hash_mismatch when ip is mutated (1.3 ip+ua binding)', async () => {
    const db = getDb();
    await append(db, {
      actorId: null,
      payload: { kind: 'login.passkey' },
      ip: '10.0.0.1',
    });
    await db.execute(sql`UPDATE audit_log SET ip = '10.0.0.2'::inet WHERE idx = 2`);
    const result = await verify(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstDivergence).toBe(2);
      expect(result.reason).toBe('hash_mismatch');
    }
  });

  it('FAIL with idx_gap when an interior row is deleted (T-AC3)', async () => {
    const db = getDb();
    await append(db, { actorId: null, payload: { kind: 'login.passkey' } });
    await append(db, { actorId: null, payload: { kind: 'login.password' } });
    await append(db, { actorId: null, payload: { kind: 'logout', sessionId: 's-1' as never } });
    await db.execute(sql`DELETE FROM audit_log WHERE idx = 3`);
    const result = await verify(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstDivergence).toBe(4);
      expect(result.reason).toBe('idx_gap');
    }
  });

  it('FAIL with genesis_prev_hash when the genesis row prev_hash is mutated (T-AC5)', async () => {
    const db = getDb();
    await db.execute(
      sql`UPDATE audit_log SET prev_hash = '\\xff00000000000000000000000000000000000000000000000000000000000000'::bytea WHERE idx = 0`,
    );
    const result = await verify(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstDivergence).toBe(0);
      expect(result.reason).toBe('genesis_prev_hash');
    }
  });

  it('FAIL with prev_hash_mismatch when a non-genesis row prev_hash is mutated (T-AC2)', async () => {
    const db = getDb();
    await append(db, { actorId: null, payload: { kind: 'login.passkey' } });
    await db.execute(
      sql`UPDATE audit_log SET prev_hash = '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'::bytea WHERE idx = 2`,
    );
    const result = await verify(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.firstDivergence).toBe(2);
      expect(result.reason).toBe('prev_hash_mismatch');
    }
  });

  it('serializes concurrent appends — unique sequential idx (T-AC4)', async () => {
    const db = getDb();
    // Kick off three appends in parallel; the FOR UPDATE on the latest
    // row inside the transaction must serialize them.
    await Promise.all([
      append(db, { actorId: null, payload: { kind: 'login.passkey' } }),
      append(db, { actorId: null, payload: { kind: 'login.password' } }),
      append(db, { actorId: null, payload: { kind: 'logout', sessionId: 's-2' as never } }),
    ]);
    const rows = (await db.execute(
      sql`SELECT idx FROM audit_log ORDER BY idx ASC`,
    )) as unknown as Array<{ idx: number }>;
    const idxs = rows.map((r) => Number(r.idx));
    expect(idxs).toEqual([0, 1, 2, 3, 4]);
    // Verify the chain is still intact after the concurrent appends.
    const result = await verify(db);
    expect(result.ok).toBe(true);
  });
});
