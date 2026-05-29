// Unit tests for the lockout module. Drives the in-DB counter math
// directly (post-security-reviewer F5 fix: OR'd predicate, no
// double-counting) without going through the HTTP layer.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/client';
import { checkLockout, recordAttempt } from './lockout';
import { bootAuthTestEnv } from './test-setup';
import { hasDb } from './test-db';
import { env } from '../env';

const SKIP = !hasDb();

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  const db = getDb();
  await db.execute(sql`DELETE FROM login_attempts`);
});

const ID_A = new Uint8Array(32).fill(0xaa);
const ID_B = new Uint8Array(32).fill(0xbb);

async function seedFailure(
  identifierHash: Uint8Array,
  ip: string | null,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await recordAttempt({ identifierHash, ip, outcome: 'failure' });
  }
}

describe.skipIf(SKIP)('lockout ladder', () => {
  it('returns unlocked when failures are below the short threshold', async () => {
    await seedFailure(ID_A, '10.0.0.1', env.AUTH_LOCKOUT_SHORT_FAILS - 1);
    const state = await checkLockout({ identifierHash: ID_A, ip: '10.0.0.1' });
    expect(state.locked).toBe(false);
  });

  it('returns short-tier locked when failures hit the short threshold', async () => {
    await seedFailure(ID_A, '10.0.0.2', env.AUTH_LOCKOUT_SHORT_FAILS);
    const state = await checkLockout({ identifierHash: ID_A, ip: '10.0.0.2' });
    expect(state.locked).toBe(true);
    expect(state.tier).toBe('short');
  });

  it('does NOT double-count same-id + same-IP rows (F5 fix)', async () => {
    // Insert exactly (short - 1) failures all from the same id AND same
    // IP. The pre-fix code summed identifier-match + ip-match counts,
    // double-counting these rows and tripping the threshold early.
    // Post-fix: distinct rows under (id OR ip) → still below threshold.
    await seedFailure(ID_A, '10.0.0.3', env.AUTH_LOCKOUT_SHORT_FAILS - 1);
    const state = await checkLockout({ identifierHash: ID_A, ip: '10.0.0.3' });
    expect(state.locked).toBe(false);
  });

  it('counts identifier-only matches when the IP differs', async () => {
    await seedFailure(ID_A, '10.0.0.4', env.AUTH_LOCKOUT_SHORT_FAILS);
    // Same identifier, different IP — the per-identifier counter trips.
    const state = await checkLockout({ identifierHash: ID_A, ip: '10.0.0.99' });
    expect(state.locked).toBe(true);
    expect(state.tier).toBe('short');
  });

  it('counts IP-only matches when the identifier differs', async () => {
    await seedFailure(ID_A, '10.0.0.5', env.AUTH_LOCKOUT_SHORT_FAILS);
    // Same IP, different identifier — the per-IP counter trips.
    const state = await checkLockout({ identifierHash: ID_B, ip: '10.0.0.5' });
    expect(state.locked).toBe(true);
    expect(state.tier).toBe('short');
  });

  it('escalates to long tier when failures exceed the long threshold', async () => {
    await seedFailure(ID_A, '10.0.0.6', env.AUTH_LOCKOUT_LONG_FAILS);
    const state = await checkLockout({ identifierHash: ID_A, ip: '10.0.0.6' });
    expect(state.locked).toBe(true);
    expect(state.tier).toBe('long');
  });

  it('escalates to hard tier when failures exceed the hard threshold', async () => {
    await seedFailure(ID_A, '10.0.0.7', env.AUTH_LOCKOUT_HARD_FAILS);
    const state = await checkLockout({ identifierHash: ID_A, ip: '10.0.0.7' });
    expect(state.locked).toBe(true);
    expect(state.tier).toBe('hard');
    expect(state.retryAfterSeconds).toBeUndefined();
  });
});
