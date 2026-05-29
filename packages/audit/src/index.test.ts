import { describe, expect, it } from 'vitest';
import type { AuditPayload } from '@jhsc/shared-types';
import { computeThisHash, GENESIS_PREV_HASH, HASH_BYTES } from './index';

describe('computeThisHash', () => {
  it('produces a 32-byte digest', () => {
    const h = computeThisHash(
      GENESIS_PREV_HASH,
      {
        idx: 0,
        tsMs: 1700000000000,
        actorId: null,
        kind: 'system.genesis',
        resourceType: null,
        resourceId: null,
      },
      { kind: 'system.genesis', schemaVersion: '1.3.0' } as AuditPayload,
    );
    expect(h.length).toBe(HASH_BYTES);
  });

  it('is deterministic across calls with identical inputs', () => {
    const payload: AuditPayload = { kind: 'login.passkey' };
    const a = computeThisHash(
      GENESIS_PREV_HASH,
      {
        idx: 1,
        tsMs: 100,
        actorId: 'u-1',
        kind: 'login.passkey',
        resourceType: null,
        resourceId: null,
      },
      payload,
    );
    const b = computeThisHash(
      GENESIS_PREV_HASH,
      {
        idx: 1,
        tsMs: 100,
        actorId: 'u-1',
        kind: 'login.passkey',
        resourceType: null,
        resourceId: null,
      },
      payload,
    );
    expect(a).toEqual(b);
  });

  it('flips on any header change', () => {
    const payload: AuditPayload = { kind: 'login.passkey' };
    const base = computeThisHash(
      GENESIS_PREV_HASH,
      {
        idx: 1,
        tsMs: 100,
        actorId: 'u-1',
        kind: 'login.passkey',
        resourceType: null,
        resourceId: null,
      },
      payload,
    );
    const tsBumped = computeThisHash(
      GENESIS_PREV_HASH,
      {
        idx: 1,
        tsMs: 101,
        actorId: 'u-1',
        kind: 'login.passkey',
        resourceType: null,
        resourceId: null,
      },
      payload,
    );
    const actorChanged = computeThisHash(
      GENESIS_PREV_HASH,
      {
        idx: 1,
        tsMs: 100,
        actorId: 'u-2',
        kind: 'login.passkey',
        resourceType: null,
        resourceId: null,
      },
      payload,
    );
    expect(base).not.toEqual(tsBumped);
    expect(base).not.toEqual(actorChanged);
  });

  it('flips on any payload field change', () => {
    const headers = {
      idx: 1,
      tsMs: 100,
      actorId: null,
      kind: 'login.recovery' as const,
      resourceType: null,
      resourceId: null,
    };
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
      {
        idx: 0,
        tsMs: 100,
        actorId: null,
        kind: 'system.genesis',
        resourceType: null,
        resourceId: null,
      },
      { kind: 'system.genesis', schemaVersion: '1.3.0' },
    );
    const row1Hash = computeThisHash(
      row0Hash,
      {
        idx: 1,
        tsMs: 200,
        actorId: 'u-1',
        kind: 'first_run.completed',
        resourceType: null,
        resourceId: null,
      },
      { kind: 'first_run.completed' },
    );
    // Compute row 1 with the same prev hash to verify chain locality.
    const row1Recomputed = computeThisHash(
      row0Hash,
      {
        idx: 1,
        tsMs: 200,
        actorId: 'u-1',
        kind: 'first_run.completed',
        resourceType: null,
        resourceId: null,
      },
      { kind: 'first_run.completed' },
    );
    expect(row1Hash).toEqual(row1Recomputed);
    expect(row1Hash).not.toEqual(row0Hash);
  });

  it('rejects a wrong-length prev_hash', () => {
    expect(() =>
      computeThisHash(
        new Uint8Array(16),
        {
          idx: 0,
          tsMs: 0,
          actorId: null,
          kind: 'system.genesis',
          resourceType: null,
          resourceId: null,
        },
        { kind: 'system.genesis', schemaVersion: '1.3.0' },
      ),
    ).toThrow(/prev_hash/);
  });
});
