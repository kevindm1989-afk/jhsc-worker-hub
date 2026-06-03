// Unit tests for compute-action-item-closure-canonical
// (Milestone 2.2, ADR-0013 TM-fold-5).
//
// Coverage:
//   - Deterministic canonicalization: same row → same string, regardless
//     of input key ordering.
//   - SHA-256 digest stability (no Date.now-style instability).
//   - Field tampering produces a different digest (a hostile rewrite
//     of any signed field is detectable).
//   - null evidenceHash is preserved (no coercion to 'null' string).
//   - selfAttestation: true / false both round-trip cleanly.

import { describe, expect, it } from 'vitest';
import {
  actionItemClosureCanonicalDigest,
  canonicalizeActionItemClosure,
  type ActionItemClosureCanonical,
} from './compute-action-item-closure-canonical';

function fixture(overrides: Partial<ActionItemClosureCanonical> = {}): ActionItemClosureCanonical {
  return {
    actionItemId: '11111111-1111-4111-8111-111111111111',
    closureId: '22222222-2222-4222-8222-222222222222',
    meetingId: '33333333-3333-4333-8333-333333333333',
    closerActorId: '44444444-4444-4444-8444-444444444444',
    counterSignerActorId: '55555555-5555-4555-8555-555555555555',
    closedAt: '2026-06-10T14:00:00.000Z',
    counterSignedAt: '2026-06-10T14:05:00.000Z',
    selfAttestation: false,
    signingKeyId: '66666666-6666-4666-8666-666666666666',
    closureReasonHash: 'a'.repeat(64),
    evidenceHash: 'b'.repeat(64),
    ...overrides,
  };
}

describe('canonicalizeActionItemClosure — deterministic ordering', () => {
  it('produces the same JSON for identical inputs', () => {
    const row = fixture();
    const a = canonicalizeActionItemClosure(row);
    const b = canonicalizeActionItemClosure(row);
    expect(a).toBe(b);
  });

  it('is invariant under input key ordering (object literal property order)', () => {
    // Two constructions of the same logical row with different
    // field-declaration order. The canonical output must be byte-
    // identical so the Ed25519 signature is reproducible.
    const declOrderA: ActionItemClosureCanonical = {
      actionItemId: 'a',
      closureId: 'c',
      meetingId: 'm',
      closerActorId: 'x',
      counterSignerActorId: 'y',
      closedAt: 't1',
      counterSignedAt: 't2',
      selfAttestation: false,
      signingKeyId: 'k',
      closureReasonHash: 'h1',
      evidenceHash: 'h2',
    };
    const declOrderB: ActionItemClosureCanonical = {
      // Same data, reversed declaration order.
      evidenceHash: 'h2',
      closureReasonHash: 'h1',
      signingKeyId: 'k',
      selfAttestation: false,
      counterSignedAt: 't2',
      closedAt: 't1',
      counterSignerActorId: 'y',
      closerActorId: 'x',
      meetingId: 'm',
      closureId: 'c',
      actionItemId: 'a',
    };
    expect(canonicalizeActionItemClosure(declOrderA)).toBe(
      canonicalizeActionItemClosure(declOrderB),
    );
  });

  it('emits keys in alphabetical order', () => {
    const row = fixture();
    const json = canonicalizeActionItemClosure(row);
    // Parse and re-collect keys; assert they're sorted asc.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(sorted);
  });
});

describe('actionItemClosureCanonicalDigest — SHA-256 stability', () => {
  it('produces a 32-byte digest', () => {
    const digest = actionItemClosureCanonicalDigest(fixture());
    expect(digest.length).toBe(32);
  });

  it('is byte-identical across calls (no time-based drift)', () => {
    const row = fixture();
    const d1 = actionItemClosureCanonicalDigest(row);
    const d2 = actionItemClosureCanonicalDigest(row);
    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });

  it('changes when ANY signed field changes', () => {
    const base = fixture();
    const baseDigest = Buffer.from(actionItemClosureCanonicalDigest(base)).toString('hex');

    const mutations: Array<Partial<ActionItemClosureCanonical>> = [
      { actionItemId: 'different' },
      { closureId: 'different' },
      { meetingId: 'different' },
      { meetingId: null },
      { closerActorId: 'different' },
      { counterSignerActorId: 'different' },
      { closedAt: '2026-06-10T14:00:01.000Z' },
      { counterSignedAt: '2026-06-10T14:05:01.000Z' },
      { selfAttestation: true },
      { signingKeyId: 'different' },
      { closureReasonHash: 'c'.repeat(64) },
      { evidenceHash: 'c'.repeat(64) },
      { evidenceHash: null },
    ];

    for (const m of mutations) {
      const mutated = fixture(m);
      const mutatedDigest = Buffer.from(actionItemClosureCanonicalDigest(mutated)).toString('hex');
      expect(mutatedDigest).not.toBe(baseDigest);
    }
  });
});

describe('canonicalizeActionItemClosure — null + selfAttestation handling', () => {
  it('preserves null evidenceHash as JSON null (not the string "null")', () => {
    const row = fixture({ evidenceHash: null });
    const json = canonicalizeActionItemClosure(row);
    const parsed = JSON.parse(json) as { evidenceHash: unknown };
    expect(parsed.evidenceHash).toBeNull();
  });

  it('preserves null meetingId for out-of-meeting closures', () => {
    const row = fixture({ meetingId: null });
    const json = canonicalizeActionItemClosure(row);
    const parsed = JSON.parse(json) as { meetingId: unknown };
    expect(parsed.meetingId).toBeNull();
  });

  it('selfAttestation: true round-trips as boolean true', () => {
    const row = fixture({
      selfAttestation: true,
      closerActorId: 'same',
      counterSignerActorId: 'same',
    });
    const json = canonicalizeActionItemClosure(row);
    const parsed = JSON.parse(json) as { selfAttestation: unknown };
    expect(parsed.selfAttestation).toBe(true);
  });

  it('selfAttestation: false round-trips as boolean false', () => {
    const row = fixture({ selfAttestation: false });
    const json = canonicalizeActionItemClosure(row);
    const parsed = JSON.parse(json) as { selfAttestation: unknown };
    expect(parsed.selfAttestation).toBe(false);
  });
});
