import { describe, expect, it } from 'vitest';
import type { AuditPayload } from '@jhsc/shared-types';
import { computeThisHash, GENESIS_PREV_HASH, HASH_BYTES } from './index';

const HEADERS = (overrides: {
  idx?: number;
  tsMs?: number;
  actorId?: string | null;
  kind?: 'system.genesis' | 'login.passkey' | 'login.recovery' | 'first_run.completed';
  ip?: string | null;
  userAgent?: string | null;
}) => ({
  idx: 0,
  tsMs: 1700000000000,
  actorId: null,
  kind: 'system.genesis' as const,
  resourceType: null,
  resourceId: null,
  ip: null,
  userAgent: null,
  ...overrides,
});

describe('computeThisHash', () => {
  it('produces a 32-byte digest', () => {
    const h = computeThisHash(GENESIS_PREV_HASH, HEADERS({}), {
      kind: 'system.genesis',
      schemaVersion: '1.3.0',
    } as AuditPayload);
    expect(h.length).toBe(HASH_BYTES);
  });

  it('is deterministic across calls with identical inputs', () => {
    const payload: AuditPayload = { kind: 'login.passkey' };
    const a = computeThisHash(
      GENESIS_PREV_HASH,
      HEADERS({ idx: 1, tsMs: 100, actorId: 'u-1', kind: 'login.passkey' }),
      payload,
    );
    const b = computeThisHash(
      GENESIS_PREV_HASH,
      HEADERS({ idx: 1, tsMs: 100, actorId: 'u-1', kind: 'login.passkey' }),
      payload,
    );
    expect(a).toEqual(b);
  });

  it('flips on any header change', () => {
    const payload: AuditPayload = { kind: 'login.passkey' };
    const base = computeThisHash(
      GENESIS_PREV_HASH,
      HEADERS({ idx: 1, tsMs: 100, actorId: 'u-1', kind: 'login.passkey' }),
      payload,
    );
    const tsBumped = computeThisHash(
      GENESIS_PREV_HASH,
      HEADERS({ idx: 1, tsMs: 101, actorId: 'u-1', kind: 'login.passkey' }),
      payload,
    );
    const actorChanged = computeThisHash(
      GENESIS_PREV_HASH,
      HEADERS({ idx: 1, tsMs: 100, actorId: 'u-2', kind: 'login.passkey' }),
      payload,
    );
    const ipChanged = computeThisHash(
      GENESIS_PREV_HASH,
      HEADERS({ idx: 1, tsMs: 100, actorId: 'u-1', kind: 'login.passkey', ip: '1.2.3.4' }),
      payload,
    );
    expect(base).not.toEqual(tsBumped);
    expect(base).not.toEqual(actorChanged);
    expect(base).not.toEqual(ipChanged);
  });

  it('flips on any payload field change', () => {
    const headers = HEADERS({ idx: 1, tsMs: 100, kind: 'login.recovery' });
    const a = computeThisHash(GENESIS_PREV_HASH, headers, {
      kind: 'login.recovery',
      codeId: 'code-a',
    });
    const b = computeThisHash(GENESIS_PREV_HASH, headers, {
      kind: 'login.recovery',
      codeId: 'code-b',
    });
    expect(a).not.toEqual(b);
  });

  it('chains correctly — using row N output as row N+1 prev', () => {
    const row0Hash = computeThisHash(
      GENESIS_PREV_HASH,
      HEADERS({ idx: 0, tsMs: 100, kind: 'system.genesis' }),
      { kind: 'system.genesis', schemaVersion: '1.3.0' },
    );
    const row1Hash = computeThisHash(
      row0Hash,
      HEADERS({ idx: 1, tsMs: 200, actorId: 'u-1', kind: 'first_run.completed' }),
      { kind: 'first_run.completed' },
    );
    const row1Recomputed = computeThisHash(
      row0Hash,
      HEADERS({ idx: 1, tsMs: 200, actorId: 'u-1', kind: 'first_run.completed' }),
      { kind: 'first_run.completed' },
    );
    expect(row1Hash).toEqual(row1Recomputed);
    expect(row1Hash).not.toEqual(row0Hash);
  });

  it('rejects a wrong-length prev_hash', () => {
    expect(() =>
      computeThisHash(new Uint8Array(16), HEADERS({}), {
        kind: 'system.genesis',
        schemaVersion: '1.3.0',
      }),
    ).toThrow(/prev_hash/);
  });
});
