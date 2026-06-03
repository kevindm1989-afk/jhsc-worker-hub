// Type-level + runtime test for the eleven new meeting audit-payload
// kinds (Milestone 2.1, ADR-0012 §3.10).
//
// Goals:
//   - Each new kind compiles into the AuditPayload discriminated union.
//   - The compiler rejects PI fields the typechecker should reject —
//     `name`, `signerDisplayName`, `notesPlaintext`, `assigneeName`,
//     `descriptionPlaintext` are typed-out at the union member.
//   - The narrow inference works (TS narrows on `kind` discriminator).

import { describe, expect, it } from 'vitest';
import type { AuditPayload } from './index';

function accept(p: AuditPayload): AuditPayload {
  return p;
}

describe('meeting audit payloads — type + runtime contract', () => {
  it('meeting.created accepts a PI-clean payload', () => {
    const p: AuditPayload = {
      kind: 'meeting.created',
      meetingId: '11111111-1111-4111-8111-111111111111',
      agendaTemplateVersion: 1,
      scheduledStartAt: '2026-06-10T13:00:00.000Z',
      jurisdiction: 'ON',
    };
    expect(accept(p).kind).toBe('meeting.created');
  });

  it('meeting.section.added accepts a PI-clean payload', () => {
    const p: AuditPayload = {
      kind: 'meeting.section.added',
      meetingId: 'm',
      sectionId: 's',
      sectionType: 'call_to_order',
      orderIdx: 0,
      visibility: 'standard',
    };
    if (p.kind === 'meeting.section.added') {
      expect(p.sectionType).toBe('call_to_order');
    }
  });

  it('meeting.section.notes_appended carries only a hash, never the notes', () => {
    const p: AuditPayload = {
      kind: 'meeting.section.notes_appended',
      meetingId: 'm',
      sectionId: 's',
      notesHash: 'a'.repeat(64),
    };
    if (p.kind === 'meeting.section.notes_appended') {
      expect(p.notesHash).toHaveLength(64);
      // @ts-expect-error notesPlaintext is not a member of this payload kind
      const _bad = p.notesPlaintext;
      void _bad;
    }
  });

  it('meeting.attendance.recorded carries only a name hash, never the plaintext name', () => {
    const p: AuditPayload = {
      kind: 'meeting.attendance.recorded',
      meetingId: 'm',
      attendanceId: 'a',
      role: 'worker_rep',
      party: 'union',
      presentStatus: 'present',
      nameHash: 'b'.repeat(64),
    };
    if (p.kind === 'meeting.attendance.recorded') {
      // @ts-expect-error displayName is intentionally absent
      const _bad = p.displayName;
      void _bad;
      expect(p.nameHash).toHaveLength(64);
    }
  });

  it('meeting.adjourned carries the structured metrics blob', () => {
    const p: AuditPayload = {
      kind: 'meeting.adjourned',
      meetingId: 'm',
      adjournedAt: '2026-06-10T14:30:00.000Z',
      metrics: {
        durationSeconds: 5400,
        itemsRaised: 3,
        itemsClosed: 5,
        recommendationsDrafted: 1,
        inspectionsReviewed: 2,
        quorumCompliance: {
          metAtCallToOrder: true,
          ruleCitation: 'OHSA s.9(8)',
        },
      },
    };
    if (p.kind === 'meeting.adjourned') {
      expect(p.metrics.durationSeconds).toBe(5400);
      expect(p.metrics.quorumCompliance.ruleCitation).toBe('OHSA s.9(8)');
    }
  });

  it('meeting.signed carries evidenceHash + attestationSigHash but never the signer name', () => {
    const p: AuditPayload = {
      kind: 'meeting.signed',
      meetingId: 'm',
      signatureId: 's',
      signerRole: 'mgmt_external_1',
      signedMethod: 'paper_attestation',
      evidenceHash: 'c'.repeat(64),
      attestationSigHash: 'd'.repeat(64),
    };
    if (p.kind === 'meeting.signed') {
      // @ts-expect-error signerDisplayName must not appear in the payload
      const _bad = p.signerDisplayName;
      void _bad;
      expect(p.signerRole).toBe('mgmt_external_1');
    }
  });

  it('meeting.finalized carries the four signature ids', () => {
    const p: AuditPayload = {
      kind: 'meeting.finalized',
      meetingId: 'm',
      finalizedAt: '2026-06-10T16:00:00.000Z',
      signatureIds: ['s1', 's2', 's3', 's4'],
    };
    if (p.kind === 'meeting.finalized') {
      expect(p.signatureIds).toHaveLength(4);
    }
  });

  it('meeting.action_item_snapshot carries only ids + enum-ish status', () => {
    const p: AuditPayload = {
      kind: 'meeting.action_item_snapshot',
      meetingId: 'm',
      actionItemId: 'a',
      snapshotKind: 'finalized',
      snapshotAt: '2026-06-10T14:30:00.000Z',
      status: 'Closed',
      section: 'completed_this_period',
      assigneeNameHash: null,
    };
    if (p.kind === 'meeting.action_item_snapshot') {
      // @ts-expect-error assigneeName must not appear
      const _bad = p.assigneeName;
      void _bad;
      expect(p.assigneeNameHash).toBeNull();
    }
  });

  it('meeting.recommendation_drafted carries the TM-fold-3 cross-chain anchor', () => {
    const p: AuditPayload = {
      kind: 'meeting.recommendation_drafted',
      meetingId: 'm',
      recommendationId: 'r',
      sectionId: 's',
      recommendationCreatedEventHash: 'e'.repeat(64),
    };
    if (p.kind === 'meeting.recommendation_drafted') {
      expect(p.recommendationCreatedEventHash).toHaveLength(64);
    }
  });

  it('meeting.section.started / ended round-trip the timestamp + duration', () => {
    const started: AuditPayload = {
      kind: 'meeting.section.started',
      meetingId: 'm',
      sectionId: 's',
      startedAt: '2026-06-10T13:05:00.000Z',
    };
    const ended: AuditPayload = {
      kind: 'meeting.section.ended',
      meetingId: 'm',
      sectionId: 's',
      endedAt: '2026-06-10T13:25:00.000Z',
      durationSeconds: 1200,
    };
    expect(started.kind).toBe('meeting.section.started');
    if (ended.kind === 'meeting.section.ended') {
      expect(ended.durationSeconds).toBe(1200);
    }
  });
});
