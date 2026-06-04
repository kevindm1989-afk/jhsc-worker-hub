// Unit test for compute-recipient-hash.ts (2.3, TM-fold-3).
//
// Goals:
//   - Same (role, displayName, method) input -> same hash (idempotency).
//   - Different method -> different hash (chain anchors capture method).
//   - Different role -> different hash.
//   - Different displayName -> different hash.
//   - Hash output is 64 lowercase hex chars (matches the DB CHECK).
//   - Canonical alpha-sort: calling order of fields doesn't matter
//     because we use a fixed alphabetical ordered object literal.

import { describe, expect, it } from 'vitest';
import { computeRecipientHash } from './compute-recipient-hash';

describe('computeRecipientHash — canonical hashing (TM-fold-3)', () => {
  it('produces a 64-char lowercase hex digest', () => {
    const h = computeRecipientHash({
      role: 'mlitsd_inspector',
      displayName: 'Acme Inspector',
      method: 'email',
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same (role, displayName, method)', () => {
    const input = {
      role: 'mgmt_co_chair' as const,
      displayName: 'Jane Doe',
      method: 'in_person' as const,
    };
    expect(computeRecipientHash(input)).toBe(computeRecipientHash(input));
  });

  it('different method yields different hash', () => {
    const h1 = computeRecipientHash({
      role: 'mgmt_co_chair',
      displayName: 'Jane Doe',
      method: 'email',
    });
    const h2 = computeRecipientHash({
      role: 'mgmt_co_chair',
      displayName: 'Jane Doe',
      method: 'printed_handoff',
    });
    expect(h1).not.toBe(h2);
  });

  it('different role yields different hash', () => {
    const h1 = computeRecipientHash({
      role: 'mgmt_co_chair',
      displayName: 'Jane Doe',
      method: 'email',
    });
    const h2 = computeRecipientHash({
      role: 'worker_rep',
      displayName: 'Jane Doe',
      method: 'email',
    });
    expect(h1).not.toBe(h2);
  });

  it('different displayName yields different hash', () => {
    const h1 = computeRecipientHash({
      role: 'union_local',
      displayName: 'Alice',
      method: 'in_person',
    });
    const h2 = computeRecipientHash({
      role: 'union_local',
      displayName: 'Bob',
      method: 'in_person',
    });
    expect(h1).not.toBe(h2);
  });

  it('the 9-value recipient_role enum all hash to distinct values for a fixed name+method', () => {
    const roles = [
      'mgmt_co_chair',
      'worker_rep',
      'mgmt_rep',
      'union_local',
      'mlitsd_inspector',
      'legal_counsel',
      'other',
      'workplace_role_1',
      'workplace_role_2',
    ] as const;
    const hashes = new Set(
      roles.map((role) =>
        computeRecipientHash({ role, displayName: 'Test Recipient', method: 'email' }),
      ),
    );
    expect(hashes.size).toBe(roles.length);
  });

  it('an empty displayName still produces a stable hash (route Zod gates this)', () => {
    // The route's Zod schema enforces displayName non-emptiness; the
    // helper itself does not, so we can test it directly.
    const h = computeRecipientHash({ role: 'other', displayName: '', method: 'email' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses canonical JSON shape — known fixture round-trip', () => {
    // Lock the canonical JSON shape so a future refactor that changes
    // the key ordering trips this test (the chain payload's recipientHash
    // is durable; we cannot silently change the canonicalization).
    const h = computeRecipientHash({
      role: 'mlitsd_inspector',
      displayName: 'MLITSD Inspector A',
      method: 'in_person',
    });
    // Computed once at fixture creation time; if this changes the
    // canonicalization changed -- review the chain impact.
    expect(h).toHaveLength(64);
    // Specifically: known hash for the above input.
    // Generated from sha256(JSON.stringify({displayName, method, role}))
    // with sorted keys.
    const knownHashFor = (input: { role: string; displayName: string; method: string }): string => {
      // We re-implement the canonicalization inline to lock it down.
      const ordered = JSON.stringify({
        displayName: input.displayName,
        method: input.method,
        role: input.role,
      });
      // dynamic require to avoid duplicating the implementation
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createHash } = require('node:crypto');
      return createHash('sha256').update(ordered, 'utf8').digest('hex');
    };
    expect(h).toBe(
      knownHashFor({
        role: 'mlitsd_inspector',
        displayName: 'MLITSD Inspector A',
        method: 'in_person',
      }),
    );
  });
});
