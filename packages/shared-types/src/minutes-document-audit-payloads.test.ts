// Type-level + runtime test for the six new minutes-document audit
// payload kinds (Milestone 2.3, ADR-0014 §3.6 + S0 addendum table).
//
// Goals:
//   - Each new kind compiles into the AuditPayload discriminated union.
//   - The compiler rejects PI fields (recipient name, hold reason
//     plaintext, retention citation prose) at the type layer per T-AC9.
//   - Hashes are the only carriers of decrypted-data references.
//   - Enum-only discriminators on recipientRole / sentMethod / etc.

import { describe, expect, it } from 'vitest';
import type { AuditPayload } from './index';

function accept(p: AuditPayload): AuditPayload {
  return p;
}

describe('minutes_document.generated — type + runtime contract', () => {
  it('accepts a PI-clean payload (jhsc_internal audience)', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.generated',
      meetingId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      documentHash: 'a'.repeat(64),
      documentSize: 12345,
      formatVersion: 'v1',
      renderAudience: 'jhsc_internal',
      generatedAt: '2026-09-20T16:00:00.000Z',
      generatedByActorId: '33333333-3333-4333-8333-333333333333',
      retentionCorpusEntryHashes: ['b'.repeat(64), 'c'.repeat(64)],
    };
    expect(accept(p).kind).toBe('minutes_document.generated');
  });

  it('accepts an external_distribution payload', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.generated',
      meetingId: 'm',
      documentId: 'd',
      documentHash: 'a'.repeat(64),
      documentSize: 999,
      formatVersion: 'v1',
      renderAudience: 'external_distribution',
      generatedAt: '2026-09-20T16:00:00.000Z',
      generatedByActorId: 'u',
      retentionCorpusEntryHashes: [],
    };
    if (p.kind === 'minutes_document.generated') {
      expect(p.renderAudience).toBe('external_distribution');
    }
  });

  it('rejects PI fields at the type layer', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.generated',
      meetingId: 'm',
      documentId: 'd',
      documentHash: 'a'.repeat(64),
      documentSize: 1,
      formatVersion: 'v1',
      renderAudience: 'jhsc_internal',
      generatedAt: '2026-09-20T16:00:00.000Z',
      generatedByActorId: 'u',
      retentionCorpusEntryHashes: [],
    };
    if (p.kind === 'minutes_document.generated') {
      // @ts-expect-error workplaceName is intentionally absent
      const _bad1 = p.workplaceName;
      // @ts-expect-error attendeeName is intentionally absent
      const _bad2 = p.attendeeName;
      // @ts-expect-error retentionStatementText is intentionally absent
      const _bad3 = p.retentionStatementText;
      void _bad1;
      void _bad2;
      void _bad3;
      expect(p.documentHash).toHaveLength(64);
    }
  });
});

describe('minutes_document.regenerated — type + runtime contract', () => {
  it('accepts a PI-clean payload with prior document chain link', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.regenerated',
      meetingId: 'm',
      documentId: 'd2',
      priorDocumentId: 'd1',
      documentHash: 'e'.repeat(64),
      generatedAt: '2026-10-05T12:00:00.000Z',
      generatedByActorId: 'u',
      reason: 'typo_fix',
    };
    expect(accept(p).kind).toBe('minutes_document.regenerated');
    if (p.kind === 'minutes_document.regenerated') {
      expect(p.priorDocumentId).toBe('d1');
    }
  });

  it('accepts each regeneration_reason enum value', () => {
    const reasons = [
      'layout_fix',
      'corpus_update',
      'signature_added',
      'typo_fix',
      'other',
    ] as const;
    for (const reason of reasons) {
      const p: AuditPayload = {
        kind: 'minutes_document.regenerated',
        meetingId: 'm',
        documentId: 'd',
        priorDocumentId: 'p',
        documentHash: 'f'.repeat(64),
        generatedAt: '2026-10-05T12:00:00.000Z',
        generatedByActorId: 'u',
        reason,
      };
      if (p.kind === 'minutes_document.regenerated') {
        expect(p.reason).toBe(reason);
      }
    }
  });

  it('rejects free-text regeneration narrative at the type layer', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.regenerated',
      meetingId: 'm',
      documentId: 'd2',
      priorDocumentId: 'd1',
      documentHash: 'a'.repeat(64),
      generatedAt: '2026-10-05T12:00:00.000Z',
      generatedByActorId: 'u',
      reason: 'typo_fix',
    };
    if (p.kind === 'minutes_document.regenerated') {
      // @ts-expect-error reasonNarrative is intentionally absent
      const _bad1 = p.reasonNarrative;
      // @ts-expect-error generatedByName is intentionally absent
      const _bad2 = p.generatedByName;
      void _bad1;
      void _bad2;
    }
  });
});

describe('minutes_document.downloaded — type + runtime contract', () => {
  it('accepts a PI-clean download anchor (per-fetch chain row per ADR §3.6.2)', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.downloaded',
      meetingId: 'm',
      documentId: 'd',
      documentHash: 'a'.repeat(64),
      downloadedAt: '2026-09-21T09:15:00.000Z',
      downloadedByActorId: 'u',
    };
    expect(accept(p).kind).toBe('minutes_document.downloaded');
  });

  it('rejects PI fields at the type layer', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.downloaded',
      meetingId: 'm',
      documentId: 'd',
      documentHash: 'a'.repeat(64),
      downloadedAt: '2026-09-21T09:15:00.000Z',
      downloadedByActorId: 'u',
    };
    if (p.kind === 'minutes_document.downloaded') {
      // @ts-expect-error downloadedByName is intentionally absent
      const _bad1 = p.downloadedByName;
      // @ts-expect-error workplaceName is intentionally absent
      const _bad2 = p.workplaceName;
      void _bad1;
      void _bad2;
    }
  });
});

describe('minutes_document.distributed — type + runtime contract', () => {
  it('accepts a PI-clean payload — recipient name NEVER in payload (T-AC9)', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.distributed',
      meetingId: 'm',
      documentId: 'd',
      distributionId: 'di',
      documentHash: 'a'.repeat(64),
      recipientHash: 'r'.repeat(64),
      recipientRole: 'mlitsd_inspector',
      sentMethod: 'email',
      sentAt: '2026-09-21T10:00:00.000Z',
      sentByActorId: 'u',
    };
    expect(accept(p).kind).toBe('minutes_document.distributed');
    if (p.kind === 'minutes_document.distributed') {
      expect(p.recipientHash).toHaveLength(64);
      expect(p.recipientRole).toBe('mlitsd_inspector');
    }
  });

  it('accepts the workplace_role_1 / workplace_role_2 generic slots', () => {
    const slots = ['workplace_role_1', 'workplace_role_2'] as const;
    for (const role of slots) {
      const p: AuditPayload = {
        kind: 'minutes_document.distributed',
        meetingId: 'm',
        documentId: 'd',
        distributionId: 'di',
        documentHash: 'a'.repeat(64),
        recipientHash: 'r'.repeat(64),
        recipientRole: role,
        sentMethod: 'in_person',
        sentAt: '2026-09-21T10:00:00.000Z',
        sentByActorId: 'u',
      };
      if (p.kind === 'minutes_document.distributed') {
        expect(p.recipientRole).toBe(role);
      }
    }
  });

  it('accepts each sentMethod enum value', () => {
    const methods = ['email', 'printed_handoff', 'portal_upload', 'in_person'] as const;
    for (const method of methods) {
      const p: AuditPayload = {
        kind: 'minutes_document.distributed',
        meetingId: 'm',
        documentId: 'd',
        distributionId: 'di',
        documentHash: 'a'.repeat(64),
        recipientHash: 'r'.repeat(64),
        recipientRole: 'mgmt_co_chair',
        sentMethod: method,
        sentAt: '2026-09-21T10:00:00.000Z',
        sentByActorId: 'u',
      };
      if (p.kind === 'minutes_document.distributed') {
        expect(p.sentMethod).toBe(method);
      }
    }
  });

  it('rejects recipient plaintext name fields at the type layer', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.distributed',
      meetingId: 'm',
      documentId: 'd',
      distributionId: 'di',
      documentHash: 'a'.repeat(64),
      recipientHash: 'r'.repeat(64),
      recipientRole: 'legal_counsel',
      sentMethod: 'email',
      sentAt: '2026-09-21T10:00:00.000Z',
      sentByActorId: 'u',
    };
    if (p.kind === 'minutes_document.distributed') {
      // @ts-expect-error recipientName is intentionally absent
      const _bad1 = p.recipientName;
      // @ts-expect-error recipientDisplayName is intentionally absent
      const _bad2 = p.recipientDisplayName;
      // @ts-expect-error recipientEmail is intentionally absent
      const _bad3 = p.recipientEmail;
      // @ts-expect-error notes is intentionally absent (encrypted-only on row)
      const _bad4 = p.notes;
      void _bad1;
      void _bad2;
      void _bad3;
      void _bad4;
    }
  });
});

describe('minutes_document.hold_placed — type + runtime contract', () => {
  it('accepts a PI-clean payload — hold reason NEVER in payload (T-AC9)', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.hold_placed',
      meetingId: 'm',
      documentId: 'd',
      holdState: 'mlitsd_hold',
      holdReasonHash: 'r'.repeat(64),
      placedAt: '2026-11-01T08:00:00.000Z',
      placedByActorId: 'u',
    };
    expect(accept(p).kind).toBe('minutes_document.hold_placed');
  });

  it('accepts each non-none hold_state enum value', () => {
    const states = ['subpoena_hold', 'mlitsd_hold', 'litigation_hold'] as const;
    for (const state of states) {
      const p: AuditPayload = {
        kind: 'minutes_document.hold_placed',
        meetingId: 'm',
        documentId: 'd',
        holdState: state,
        holdReasonHash: 'h'.repeat(64),
        placedAt: '2026-11-01T08:00:00.000Z',
        placedByActorId: 'u',
      };
      if (p.kind === 'minutes_document.hold_placed') {
        expect(p.holdState).toBe(state);
      }
    }
  });

  it('rejects hold reason plaintext at the type layer', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.hold_placed',
      meetingId: 'm',
      documentId: 'd',
      holdState: 'litigation_hold',
      holdReasonHash: 'r'.repeat(64),
      placedAt: '2026-11-01T08:00:00.000Z',
      placedByActorId: 'u',
    };
    if (p.kind === 'minutes_document.hold_placed') {
      // @ts-expect-error holdReasonPlaintext is intentionally absent
      const _bad1 = p.holdReasonPlaintext;
      // @ts-expect-error placedByName is intentionally absent
      const _bad2 = p.placedByName;
      // @ts-expect-error caseNumber is intentionally absent
      const _bad3 = p.caseNumber;
      void _bad1;
      void _bad2;
      void _bad3;
    }
  });
});

describe('minutes_document.hold_released — type + runtime contract', () => {
  it('accepts a PI-clean payload carrying the prior hold_state', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.hold_released',
      meetingId: 'm',
      documentId: 'd',
      priorHoldState: 'subpoena_hold',
      releasedAt: '2027-02-01T09:00:00.000Z',
      releasedByActorId: 'u',
    };
    expect(accept(p).kind).toBe('minutes_document.hold_released');
    if (p.kind === 'minutes_document.hold_released') {
      expect(p.priorHoldState).toBe('subpoena_hold');
    }
  });

  it('rejects PI fields at the type layer', () => {
    const p: AuditPayload = {
      kind: 'minutes_document.hold_released',
      meetingId: 'm',
      documentId: 'd',
      priorHoldState: 'mlitsd_hold',
      releasedAt: '2027-02-01T09:00:00.000Z',
      releasedByActorId: 'u',
    };
    if (p.kind === 'minutes_document.hold_released') {
      // @ts-expect-error releasedByName is intentionally absent
      const _bad1 = p.releasedByName;
      // @ts-expect-error reasonNarrative is intentionally absent
      const _bad2 = p.reasonNarrative;
      void _bad1;
      void _bad2;
    }
  });
});
