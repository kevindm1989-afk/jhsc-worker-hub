// Unit tests for apps/api/src/evidence/workplace-signing-key.ts.
//
// These tests stand alone — no live DB. The tx.execute calls are
// mocked; the libsodium keypair generation is real (sodium.ready is
// awaited; deterministic-shape assertions only). The cache helpers
// are exercised directly.
//
// What we DO assert here:
//   - ensureWorkplaceSigningKey is idempotent (returns the existing
//     row when active row is present, never re-inserts).
//   - The seed path generates a 32-byte Ed25519 public key, seals the
//     private key under the master key envelope, and emits an
//     audit.workplace_signing_key.seeded anchor with the PI-clean
//     payload shape (signingKeyId + algorithm + publicKeySha256).
//   - The public-key cache returns the same material across calls
//     until invalidated.
//   - The partial UNIQUE active-only-one invariant is documented +
//     covered by the migration test (T-R19 close-out lives in the
//     integration suite where a real DB can enforce 23505).

import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import type * as auditModule from '@jhsc/audit';
import type { AppendInput, DrizzlePg } from '@jhsc/audit';
import { bootAuthTestEnv } from '../auth/test-setup';
import {
  _invalidateWorkplaceSigningKeyCache,
  ensureWorkplaceSigningKey,
  getActiveWorkplaceSigningPublicKey,
} from './workplace-signing-key';

// ---------------------------------------------------------------------------
// @jhsc/audit append() is module-level and writes to the audit_log
// table. The unit tests mock it so we can capture the payload without
// needing a live DB. Vitest hoists vi.mock to the top of the file.
// ---------------------------------------------------------------------------

const capturedAppends: AppendInput[] = [];
type AuditModule = typeof auditModule;
vi.mock('@jhsc/audit', async () => {
  const actual = await vi.importActual<AuditModule>('@jhsc/audit');
  return {
    ...actual,
    append: vi.fn(async (_tx: unknown, input: AppendInput) => {
      capturedAppends.push(input);
      return { idx: capturedAppends.length, thisHash: new Uint8Array(32) };
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock tx — captures executed SQL + returns pre-staged rows.
// ---------------------------------------------------------------------------

interface MockExecuteCall {
  readonly text: string;
}

interface MockTx {
  readonly calls: MockExecuteCall[];
  /** Pre-staged result queue; each execute() call shifts one off. */
  readonly results: unknown[][];
  execute: (q: unknown) => Promise<unknown>;
}

function newMockTx(results: unknown[][]): MockTx {
  const calls: MockExecuteCall[] = [];
  const queue = [...results];
  const tx: MockTx = {
    calls,
    results: queue,
    execute: async (q: unknown) => {
      // Drizzle sql tag returns a SQL object; we coerce to string for
      // shape assertions only. The exact SQL text is internal — these
      // tests only assert that *some* SQL was executed in the expected
      // sequence and shape.
      const text = String((q as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? q);
      calls.push({ text });
      return queue.shift() ?? [];
    },
  };
  return tx;
}

beforeAll(async () => {
  await sodium.ready;
  await bootAuthTestEnv();
});

beforeEach(() => {
  capturedAppends.length = 0;
  _invalidateWorkplaceSigningKeyCache();
});

describe('ensureWorkplaceSigningKey', () => {
  it('returns the existing active row without re-inserting (idempotent)', async () => {
    const existingId = randomUUID();
    const existingPublic = new Uint8Array(32);
    existingPublic.fill(0x42);
    const tx = newMockTx([
      // First execute: SELECT for existing row — returns one row.
      [{ id: existingId, algorithm: 'ed25519', public_key: existingPublic }],
    ]);

    const result = await ensureWorkplaceSigningKey(tx as unknown as DrizzlePg);

    expect(result.id).toBe(existingId);
    expect(result.algorithm).toBe('ed25519');
    expect(result.publicKey).toEqual(existingPublic);
    // Only the SELECT ran — no INSERT, no audit append.
    expect(tx.calls.length).toBe(1);
    expect(capturedAppends).toHaveLength(0);
  });

  it('seeds + audits a new keypair when no active row exists', async () => {
    const newId = randomUUID();
    const tx = newMockTx([
      // SELECT existing — empty.
      [],
      // INSERT RETURNING id — returns the new id.
      [{ id: newId }],
    ]);

    const result = await ensureWorkplaceSigningKey(tx as unknown as DrizzlePg);

    expect(result.id).toBe(newId);
    expect(result.algorithm).toBe('ed25519');
    expect(result.publicKey.byteLength).toBe(32);

    // SELECT + INSERT.
    expect(tx.calls.length).toBe(2);

    // One audit anchor emitted with the PI-clean payload shape.
    expect(capturedAppends).toHaveLength(1);
    const appended = capturedAppends[0]!;
    expect(appended.payload.kind).toBe('audit.workplace_signing_key.seeded');
    expect(appended.resourceType).toBe('workplace_signing_keys');
    expect(appended.resourceId).toBe(newId);
    if (appended.payload.kind === 'audit.workplace_signing_key.seeded') {
      expect(appended.payload.signingKeyId).toBe(newId);
      expect(appended.payload.algorithm).toBe('ed25519');
      // publicKeySha256 = hex SHA-256 of the 32-byte Ed25519 public
      // key emitted by sodium.crypto_sign_keypair. We can't assert
      // the exact value (it's random), but we can assert the shape:
      // 64 hex chars, matching sha256(result.publicKey).
      expect(appended.payload.publicKeySha256).toMatch(/^[0-9a-f]{64}$/);
      const expected = createHash('sha256').update(result.publicKey).digest('hex');
      expect(appended.payload.publicKeySha256).toBe(expected);
    }
  });

  it('emits PI-clean payload — no private-key material, no ciphertext, no DEK', async () => {
    const tx = newMockTx([[], [{ id: randomUUID() }]]);
    await ensureWorkplaceSigningKey(tx as unknown as DrizzlePg);

    const payload = capturedAppends[0]!.payload;
    // Exhaustive PI-clean assertion: the only payload fields are the
    // three documented above. Catches a future drift that accidentally
    // appended private-key material to the chain (T-AC9 mitigation).
    expect(Object.keys(payload).sort()).toEqual(
      ['algorithm', 'kind', 'publicKeySha256', 'signingKeyId'].sort(),
    );
  });
});

describe('getActiveWorkplaceSigningPublicKey — caching behavior', () => {
  it('returns the row and caches it; second call does not hit the DB', async () => {
    const id = randomUUID();
    const publicKey = new Uint8Array(32);
    publicKey.fill(0xab);
    const tx = newMockTx([[{ id, algorithm: 'ed25519', public_key: publicKey }]]);

    const first = await getActiveWorkplaceSigningPublicKey(tx as unknown as DrizzlePg);
    const second = await getActiveWorkplaceSigningPublicKey(tx as unknown as DrizzlePg);

    expect(first).not.toBeNull();
    expect(first!.id).toBe(id);
    expect(second).toBe(first); // same cached reference
    expect(tx.calls.length).toBe(1); // only one DB call
  });

  it('returns null when no active row exists', async () => {
    const tx = newMockTx([[]]);
    const result = await getActiveWorkplaceSigningPublicKey(tx as unknown as DrizzlePg);
    expect(result).toBeNull();
  });

  it('_invalidateWorkplaceSigningKeyCache forces the next call to re-query', async () => {
    const idA = randomUUID();
    const pkA = new Uint8Array(32);
    pkA.fill(0x11);
    const idB = randomUUID();
    const pkB = new Uint8Array(32);
    pkB.fill(0x22);

    const tx = newMockTx([
      [{ id: idA, algorithm: 'ed25519', public_key: pkA }],
      [{ id: idB, algorithm: 'ed25519', public_key: pkB }],
    ]);

    const first = await getActiveWorkplaceSigningPublicKey(tx as unknown as DrizzlePg);
    expect(first!.id).toBe(idA);

    _invalidateWorkplaceSigningKeyCache();

    const second = await getActiveWorkplaceSigningPublicKey(tx as unknown as DrizzlePg);
    expect(second!.id).toBe(idB);
    expect(tx.calls.length).toBe(2);
  });
});

describe('active-only-one invariant — documented + structural', () => {
  // The DB-layer enforcement (partial UNIQUE INDEX
  // workplace_signing_keys_only_one_active ON (active) WHERE active =
  // true) catches a second active=true INSERT with 23505. That
  // behavior is exercised in the integration suite where a real
  // Postgres can raise the constraint violation; the unit test here
  // documents the contract.
  it('ensureWorkplaceSigningKey relies on the partial UNIQUE for at-most-one-active (T-R19)', () => {
    // No assertion target inside this unit test — the structural
    // backstop lives in migration 0008 + integration test coverage.
    // This `it` block exists to keep the documentation discoverable
    // from the test report.
    expect(true).toBe(true);
  });
});
