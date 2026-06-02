import { describe, expect, it } from 'vitest';
import {
  computeRecommendationDeadline,
  err,
  inspectionConductState,
  inspectionExportKind,
  inspectionFindingResponsiblePartyKind,
  inspectionFindingStatusAbcx,
  inspectionFindingStatusGar,
  inspectionPromotability,
  inspectionSignatureRole,
  inspectionStatusVocabKind,
  inspectionTemplateCode,
  ok,
  recommendationDeadlineState,
  recommendationExportKind,
  recommendationJurisdiction,
  recommendationLinkKind,
  recommendationStatus,
  workplaceSigningKeyAlgorithm,
} from './index';
import type { AuditPayload, AuthError, AuthEventKind, Result } from './index';

describe('Result<T, E>', () => {
  it('ok() returns success', () => {
    const r: Result<number, string> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err() returns failure', () => {
    const r: Result<number, string> = err('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('nope');
  });
});

describe('audit payload discriminated union — type-level guards', () => {
  it('accepts a known kind with its declared fields', () => {
    const p: AuditPayload = {
      kind: 'lockout.applied',
      tier: 'short',
      retryAfterSeconds: 900,
    };
    expect(p.kind).toBe('lockout.applied');
  });

  it('narrows on the kind discriminant', () => {
    const p: AuditPayload = { kind: 'signup', via: 'first_run' };
    if (p.kind === 'signup') {
      expect(p.via).toBe('first_run');
    }
  });
});

describe('AuthError discriminated union', () => {
  it('carries kind-specific fields', () => {
    const e: AuthError = { kind: 'lockout_short', retryAfterSeconds: 900 };
    expect(e.kind).toBe('lockout_short');
    if (e.kind === 'lockout_short') {
      expect(e.retryAfterSeconds).toBe(900);
    }
  });
});

describe('inspection enums', () => {
  it('inspectionTemplateCode exports the expected codes', () => {
    expect([...inspectionTemplateCode]).toEqual(['zone_monthly', 'rack_inspection', 'custom']);
  });

  it('inspectionStatusVocabKind exports both vocabularies', () => {
    expect([...inspectionStatusVocabKind]).toEqual(['ABC_X', 'GAR']);
  });

  it('inspectionFindingStatusAbcx exports A/B/C/X', () => {
    expect([...inspectionFindingStatusAbcx]).toEqual(['A', 'B', 'C', 'X']);
  });

  it('inspectionFindingStatusGar exports G/A/R', () => {
    expect([...inspectionFindingStatusGar]).toEqual(['G', 'A', 'R']);
  });

  it('inspectionConductState exports the lifecycle states in order', () => {
    expect([...inspectionConductState]).toEqual([
      'scheduled',
      'in_progress',
      'awaiting_signatures',
      'complete',
      'archived',
    ]);
  });

  it('inspectionSignatureRole exports the three roles', () => {
    expect([...inspectionSignatureRole]).toEqual([
      'inspector',
      'supervisor',
      'jhsc_worker_co_chair',
    ]);
  });

  it('inspectionExportKind exports single/batch', () => {
    expect([...inspectionExportKind]).toEqual(['single', 'batch']);
  });
});

describe('inspectionPromotability — CLAUDE.md #15 fail-closed gate', () => {
  it('ABC_X: A/B/C promote, X does not', () => {
    expect(inspectionPromotability('ABC_X', 'A')).toBe(true);
    expect(inspectionPromotability('ABC_X', 'B')).toBe(true);
    expect(inspectionPromotability('ABC_X', 'C')).toBe(true);
    expect(inspectionPromotability('ABC_X', 'X')).toBe(false);
  });

  it('GAR: A/R promote, G does not', () => {
    expect(inspectionPromotability('GAR', 'A')).toBe(true);
    expect(inspectionPromotability('GAR', 'R')).toBe(true);
    expect(inspectionPromotability('GAR', 'G')).toBe(false);
  });

  it('out-of-vocab values fail closed', () => {
    // Defensive: a drifted vocab row that somehow reaches the helper
    // must not silently treat unknown values as promotable.
    expect(inspectionPromotability('ABC_X', 'G')).toBe(false);
    expect(inspectionPromotability('GAR', 'X')).toBe(false);
    expect(inspectionPromotability('ABC_X', '')).toBe(false);
  });
});

describe('recommendation enums', () => {
  it('recommendationStatus exports the five lifecycle states in order', () => {
    expect([...recommendationStatus]).toEqual([
      'draft',
      'submitted',
      'response_received',
      'resolved',
      'withdrawn',
    ]);
  });

  it('recommendationJurisdiction exports ON + CA-FED', () => {
    expect([...recommendationJurisdiction]).toEqual(['ON', 'CA-FED']);
  });

  it('recommendationLinkKind exports tracks + replaces', () => {
    expect([...recommendationLinkKind]).toEqual(['tracks', 'replaces']);
  });

  it('recommendationExportKind exports the new recommendation_single value', () => {
    expect([...recommendationExportKind]).toEqual(['recommendation_single']);
  });

  it('workplaceSigningKeyAlgorithm exports ed25519', () => {
    expect([...workplaceSigningKeyAlgorithm]).toEqual(['ed25519']);
  });

  it('inspectionFindingResponsiblePartyKind exports user_ref + name_text', () => {
    expect([...inspectionFindingResponsiblePartyKind]).toEqual(['user_ref', 'name_text']);
  });
});

describe('recommendation deadline helpers (ADR-0008 §3.6)', () => {
  const SUBMITTED = new Date('2026-06-01T12:00:00Z');

  it('computeRecommendationDeadline returns submittedAt + 21 days for ON', () => {
    const deadline = computeRecommendationDeadline(SUBMITTED, 'ON');
    expect(deadline).not.toBeNull();
    expect(deadline!.toISOString()).toBe('2026-06-22T12:00:00.000Z');
  });

  it('computeRecommendationDeadline returns null for CA-FED (s.135(6) "as soon as possible")', () => {
    const deadline = computeRecommendationDeadline(SUBMITTED, 'CA-FED');
    expect(deadline).toBeNull();
  });

  it('computeRecommendationDeadline does not mutate its input', () => {
    const submittedAt = new Date('2026-06-01T12:00:00Z');
    const before = submittedAt.getTime();
    computeRecommendationDeadline(submittedAt, 'ON');
    expect(submittedAt.getTime()).toBe(before);
  });

  it('recommendationDeadlineState returns no_deadline when deadline is null', () => {
    expect(recommendationDeadlineState(new Date('2026-06-02T00:00:00Z'), null)).toBe('no_deadline');
  });

  it('recommendationDeadlineState returns on_time when now is before the deadline', () => {
    const deadline = computeRecommendationDeadline(SUBMITTED, 'ON');
    expect(recommendationDeadlineState(new Date('2026-06-15T00:00:00Z'), deadline)).toBe('on_time');
  });

  it('recommendationDeadlineState is inclusive on the deadline second itself (on_time)', () => {
    const deadline = computeRecommendationDeadline(SUBMITTED, 'ON');
    expect(recommendationDeadlineState(deadline!, deadline)).toBe('on_time');
  });

  it('recommendationDeadlineState returns overdue strictly after the deadline', () => {
    const deadline = computeRecommendationDeadline(SUBMITTED, 'ON');
    const overdue = new Date(deadline!.getTime() + 1);
    expect(recommendationDeadlineState(overdue, deadline)).toBe('overdue');
  });

  it('recommendationDeadlineState ON: well past the deadline reads overdue', () => {
    const deadline = computeRecommendationDeadline(SUBMITTED, 'ON');
    expect(recommendationDeadlineState(new Date('2026-07-30T00:00:00Z'), deadline)).toBe('overdue');
  });
});

describe('AuditPayload — new 1.9 variants (type-level)', () => {
  it('recommendation.submitted carries jurisdiction + citationCount + linkedActionItemId', () => {
    const p: AuditPayload = {
      kind: 'recommendation.submitted',
      recommendationId: 'r1',
      recommendationNumber: 14,
      jurisdiction: 'ON',
      citationCount: 3,
      linkedActionItemId: 'a1',
    };
    expect(p.kind).toBe('recommendation.submitted');
  });

  it('recommendation.withdrawn allows null linkedActionItemId for draft withdrawals', () => {
    const p: AuditPayload = {
      kind: 'recommendation.withdrawn',
      recommendationId: 'r1',
      linkedActionItemId: null,
    };
    if (p.kind === 'recommendation.withdrawn') {
      expect(p.linkedActionItemId).toBeNull();
    }
  });

  it('recommendation.exported carries the hex hashes + signing-key id', () => {
    const p: AuditPayload = {
      kind: 'recommendation.exported',
      exportId: 'e1',
      recommendationId: 'r1',
      outputSha256: 'a'.repeat(64),
      signatureSha256: 'b'.repeat(64),
      signingKeyId: 'k1',
      citationsHash: 'c'.repeat(64),
      byteSize: 1024,
    };
    expect(p.kind).toBe('recommendation.exported');
  });

  it('audit.workplace_signing_key.seeded carries algorithm + publicKeySha256', () => {
    const p: AuditPayload = {
      kind: 'audit.workplace_signing_key.seeded',
      signingKeyId: 'k1',
      algorithm: 'ed25519',
      publicKeySha256: 'd'.repeat(64),
    };
    expect(p.kind).toBe('audit.workplace_signing_key.seeded');
  });

  it('inspection_finding.read and inspection.export.downloaded close the 1.8 priv-F3/F5 gaps', () => {
    const r: AuditPayload = {
      kind: 'inspection_finding.read',
      findingId: 'f1',
      inspectionId: 'i1',
    };
    const d: AuditPayload = {
      kind: 'inspection.export.downloaded',
      exportId: 'e1',
      downloadedByUserId: 'u1',
    };
    expect(r.kind).toBe('inspection_finding.read');
    expect(d.kind).toBe('inspection.export.downloaded');
  });
});

describe('AuthEventKind mirrors the pgEnum', () => {
  it('lists every kind apps/api emits', () => {
    const allKinds: AuthEventKind[] = [
      'signup',
      'login.passkey',
      'login.password',
      'login.totp',
      'login.recovery',
      'login.failed',
      'logout',
      'session.refreshed',
      'session.revoked',
      'step_up.granted',
      'step_up.denied',
      'lockout.applied',
      'lockout.cleared',
      'passkey.registered',
      'passkey.removed',
      'totp.enrolled',
      'totp.reset',
      'recovery_codes.generated',
      'recovery_codes.consumed',
      'first_run.completed',
    ];
    expect(allKinds.length).toBe(20);
  });
});
