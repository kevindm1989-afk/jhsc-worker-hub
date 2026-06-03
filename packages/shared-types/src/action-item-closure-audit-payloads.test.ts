// Type-level + runtime test for the four new in-meeting action item
// audit payload kinds (Milestone 2.2, ADR-0013 §3.3).
//
// Goals:
//   - Each new kind compiles into the AuditPayload discriminated union.
//   - The compiler rejects PI fields (closure reason plaintext, signer
//     display name, reopen narrative) at the type layer per T-AC9.
//   - The meeting.finalized payload's optional closureVerificationCount
//     extension is backward-compatible (existing finalized events
//     continue to parse).

import { describe, expect, it } from 'vitest';
import type { AuditPayload } from './index';

function accept(p: AuditPayload): AuditPayload {
  return p;
}

describe('action_item.closure_verified — type + runtime contract', () => {
  it('accepts a PI-clean payload with peer counter-sign', () => {
    const p: AuditPayload = {
      kind: 'action_item.closure_verified',
      actionItemId: '11111111-1111-4111-8111-111111111111',
      closureId: '22222222-2222-4222-8222-222222222222',
      meetingId: '33333333-3333-4333-8333-333333333333',
      closerActorId: '44444444-4444-4444-8444-444444444444',
      counterSignerActorId: '55555555-5555-4555-8555-555555555555',
      selfAttestation: false,
      signingKeyId: '66666666-6666-4666-8666-666666666666',
      evidenceHash: 'a'.repeat(64),
      attestationSigHash: 'b'.repeat(64),
    };
    expect(accept(p).kind).toBe('action_item.closure_verified');
  });

  it('accepts null meetingId for out-of-meeting closures', () => {
    const p: AuditPayload = {
      kind: 'action_item.closure_verified',
      actionItemId: 'a',
      closureId: 'c',
      meetingId: null,
      closerActorId: 'x',
      counterSignerActorId: 'y',
      selfAttestation: false,
      signingKeyId: 'k',
      evidenceHash: null,
      attestationSigHash: 'z'.repeat(64),
    };
    if (p.kind === 'action_item.closure_verified') {
      expect(p.meetingId).toBeNull();
    }
  });

  it('rejects PI fields at the type layer', () => {
    const p: AuditPayload = {
      kind: 'action_item.closure_verified',
      actionItemId: 'a',
      closureId: 'c',
      meetingId: null,
      closerActorId: 'x',
      counterSignerActorId: 'y',
      selfAttestation: true,
      signingKeyId: 'k',
      evidenceHash: null,
      attestationSigHash: 'z'.repeat(64),
    };
    if (p.kind === 'action_item.closure_verified') {
      // @ts-expect-error closureReasonPlaintext is intentionally absent
      const _bad1 = p.closureReasonPlaintext;
      // @ts-expect-error closerName is intentionally absent
      const _bad2 = p.closerName;
      // @ts-expect-error counterSignerName is intentionally absent
      const _bad3 = p.counterSignerName;
      void _bad1;
      void _bad2;
      void _bad3;
      expect(p.selfAttestation).toBe(true);
    }
  });
});

describe('action_item.reopened — type + runtime contract', () => {
  it('accepts a PI-clean payload with enum reason (rep_decision)', () => {
    const p: AuditPayload = {
      kind: 'action_item.reopened',
      actionItemId: '11111111-1111-4111-8111-111111111111',
      previousClosureId: '22222222-2222-4222-8222-222222222222',
      reopenedAt: '2026-06-15T10:00:00.000Z',
      reopenedByActorId: '33333333-3333-4333-8333-333333333333',
      reason: 'rep_decision',
    };
    expect(accept(p).kind).toBe('action_item.reopened');
  });

  it('accepts all three reopen reason enum values', () => {
    const reasons = ['rep_decision', 'jhsc_review', 'mgmt_appeal'] as const;
    for (const reason of reasons) {
      const p: AuditPayload = {
        kind: 'action_item.reopened',
        actionItemId: 'a',
        previousClosureId: 'c',
        reopenedAt: '2026-06-15T10:00:00.000Z',
        reopenedByActorId: 'u',
        reason,
      };
      if (p.kind === 'action_item.reopened') {
        expect(p.reason).toBe(reason);
      }
    }
  });

  it('rejects free-text narrative at the type layer', () => {
    const p: AuditPayload = {
      kind: 'action_item.reopened',
      actionItemId: 'a',
      previousClosureId: 'c',
      reopenedAt: '2026-06-15T10:00:00.000Z',
      reopenedByActorId: 'u',
      reason: 'rep_decision',
    };
    if (p.kind === 'action_item.reopened') {
      // @ts-expect-error reasonNarrative is intentionally absent
      const _bad1 = p.reasonNarrative;
      // @ts-expect-error reopenedByName is intentionally absent
      const _bad2 = p.reopenedByName;
      void _bad1;
      void _bad2;
    }
  });
});

describe('action_item.status_changed — type + runtime contract', () => {
  it('accepts a PI-clean payload with meeting context', () => {
    const p: AuditPayload = {
      kind: 'action_item.status_changed',
      actionItemId: '11111111-1111-4111-8111-111111111111',
      fromStatus: 'In Progress',
      toStatus: 'Pending Review',
      changedAt: '2026-06-15T10:00:00.000Z',
      changedByActorId: '22222222-2222-4222-8222-222222222222',
      meetingId: '33333333-3333-4333-8333-333333333333',
    };
    expect(accept(p).kind).toBe('action_item.status_changed');
  });

  it('accepts null meetingId for out-of-meeting status changes', () => {
    const p: AuditPayload = {
      kind: 'action_item.status_changed',
      actionItemId: 'a',
      fromStatus: 'Not Started',
      toStatus: 'In Progress',
      changedAt: '2026-06-15T10:00:00.000Z',
      changedByActorId: 'u',
      meetingId: null,
    };
    if (p.kind === 'action_item.status_changed') {
      expect(p.meetingId).toBeNull();
    }
  });

  it('rejects PI fields at the type layer', () => {
    const p: AuditPayload = {
      kind: 'action_item.status_changed',
      actionItemId: 'a',
      fromStatus: 'In Progress',
      toStatus: 'Blocked',
      changedAt: '2026-06-15T10:00:00.000Z',
      changedByActorId: 'u',
      meetingId: null,
    };
    if (p.kind === 'action_item.status_changed') {
      // @ts-expect-error descriptionPlaintext is intentionally absent
      const _bad1 = p.descriptionPlaintext;
      // @ts-expect-error changedByName is intentionally absent
      const _bad2 = p.changedByName;
      void _bad1;
      void _bad2;
    }
  });
});

describe('meeting.action_item_status_changed — type + runtime contract', () => {
  it('accepts a PI-clean cross-anchor payload', () => {
    const p: AuditPayload = {
      kind: 'meeting.action_item_status_changed',
      meetingId: '11111111-1111-4111-8111-111111111111',
      actionItemId: '22222222-2222-4222-8222-222222222222',
      fromStatus: 'In Progress',
      toStatus: 'Pending Review',
      changedAt: '2026-06-15T10:00:00.000Z',
      statusChangedEventHash: 'a'.repeat(64),
    };
    expect(accept(p).kind).toBe('meeting.action_item_status_changed');
    if (p.kind === 'meeting.action_item_status_changed') {
      expect(p.statusChangedEventHash).toHaveLength(64);
    }
  });

  it('rejects PI fields at the type layer', () => {
    const p: AuditPayload = {
      kind: 'meeting.action_item_status_changed',
      meetingId: 'm',
      actionItemId: 'a',
      fromStatus: 'In Progress',
      toStatus: 'Pending Review',
      changedAt: '2026-06-15T10:00:00.000Z',
      statusChangedEventHash: 'a'.repeat(64),
    };
    if (p.kind === 'meeting.action_item_status_changed') {
      // @ts-expect-error actorName is intentionally absent
      const _bad1 = p.actorName;
      // @ts-expect-error descriptionPlaintext is intentionally absent
      const _bad2 = p.descriptionPlaintext;
      void _bad1;
      void _bad2;
    }
  });
});

describe('meeting.finalized — backward-compatible TM-fold-5 extension', () => {
  it('accepts the existing M2.1 payload shape (no closureVerificationCount)', () => {
    const p: AuditPayload = {
      kind: 'meeting.finalized',
      meetingId: 'm',
      finalizedAt: '2026-06-10T16:00:00.000Z',
      signatureIds: ['s1', 's2', 's3', 's4'],
    };
    if (p.kind === 'meeting.finalized') {
      expect(p.signatureIds).toHaveLength(4);
      expect(p.closureVerificationCount).toBeUndefined();
    }
  });

  it('accepts the M2.2 extension with closureVerificationCount', () => {
    const p: AuditPayload = {
      kind: 'meeting.finalized',
      meetingId: 'm',
      finalizedAt: '2026-06-10T16:00:00.000Z',
      signatureIds: ['s1', 's2', 's3', 's4'],
      closureVerificationCount: 3,
    };
    if (p.kind === 'meeting.finalized') {
      expect(p.closureVerificationCount).toBe(3);
    }
  });

  it('accepts closureVerificationCount = 0', () => {
    const p: AuditPayload = {
      kind: 'meeting.finalized',
      meetingId: 'm',
      finalizedAt: '2026-06-10T16:00:00.000Z',
      signatureIds: ['s1', 's2', 's3', 's4'],
      closureVerificationCount: 0,
    };
    if (p.kind === 'meeting.finalized') {
      expect(p.closureVerificationCount).toBe(0);
    }
  });
});
