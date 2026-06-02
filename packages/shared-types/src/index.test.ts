import { describe, expect, it } from 'vitest';
import {
  computeNextBackoff,
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
  isClientId,
  ok,
  recommendationDeadlineState,
  recommendationExportKind,
  recommendationJurisdiction,
  recommendationLinkKind,
  recommendationStatus,
  SYNC_BACKOFF_SCHEDULE,
  SYNC_DEAD_LETTER_AFTER_ATTEMPTS,
  syncConflictResolution,
  syncEntityKind,
  syncOperationKind,
  syncOperationState,
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

describe('sync enums (Milestone 1.10, ADR-0009)', () => {
  it('syncOperationKind exports the four wire-level mutation kinds in order', () => {
    expect([...syncOperationKind]).toEqual(['create', 'update', 'delete', 'transition']);
  });

  it('syncOperationState exports the five queue-row lifecycle states in order', () => {
    expect([...syncOperationState]).toEqual([
      'queued',
      'in_flight',
      'succeeded',
      'conflicting',
      'failed_dead_letter',
    ]);
  });

  it('syncEntityKind exports every queueable entity from ADR-0009 §3.6', () => {
    expect([...syncEntityKind]).toEqual([
      'hazard',
      'action_item',
      'action_item_move',
      'inspection',
      'inspection_finding',
      'inspection_signature',
      'inspection_finding_promotion',
      'recommendation',
      'recommendation_response',
      'recommendation_resolution',
      'recommendation_withdrawal',
      'evidence_finalize',
    ]);
  });

  it('syncConflictResolution exports the four three-way merge options', () => {
    expect([...syncConflictResolution]).toEqual([
      'keep_local',
      'keep_remote',
      'keep_both_chain_anchored',
      'manual_merge',
    ]);
  });

  it('SYNC_BACKOFF_SCHEDULE is the documented [1s, 5s, 30s, 5m, 30m, 2h, 12h, 24h] curve', () => {
    expect([...SYNC_BACKOFF_SCHEDULE]).toEqual([1, 5, 30, 300, 1800, 7200, 43200, 86400]);
  });

  it('SYNC_DEAD_LETTER_AFTER_ATTEMPTS equals the schedule length', () => {
    expect(SYNC_DEAD_LETTER_AFTER_ATTEMPTS).toBe(8);
    expect(SYNC_DEAD_LETTER_AFTER_ATTEMPTS).toBe(SYNC_BACKOFF_SCHEDULE.length);
  });
});

describe('computeNextBackoff — pure curve for the queue worker', () => {
  it('maps attemptCount 0..7 to the schedule values', () => {
    expect(computeNextBackoff(0)).toBe(1);
    expect(computeNextBackoff(1)).toBe(5);
    expect(computeNextBackoff(2)).toBe(30);
    expect(computeNextBackoff(3)).toBe(300);
    expect(computeNextBackoff(4)).toBe(1800);
    expect(computeNextBackoff(5)).toBe(7200);
    expect(computeNextBackoff(6)).toBe(43200);
    expect(computeNextBackoff(7)).toBe(86400);
  });

  it('returns null at the dead-letter boundary (attemptCount == 8)', () => {
    expect(computeNextBackoff(8)).toBeNull();
  });

  it('returns null past the dead-letter boundary', () => {
    expect(computeNextBackoff(9)).toBeNull();
    expect(computeNextBackoff(100)).toBeNull();
  });

  it('throws on negative input', () => {
    expect(() => computeNextBackoff(-1)).toThrow(/attemptCount must be >= 0/);
  });

  it('throws on non-integer input', () => {
    expect(() => computeNextBackoff(1.5)).toThrow(/attemptCount must be an integer/);
    expect(() => computeNextBackoff(Number.NaN)).toThrow(/attemptCount must be an integer/);
    expect(() => computeNextBackoff(Number.POSITIVE_INFINITY)).toThrow(
      /attemptCount must be an integer/,
    );
  });
});

describe('isClientId — RFC 4122 v4 runtime guard', () => {
  it('accepts canonical lowercase v4 UUIDs', () => {
    expect(isClientId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isClientId('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isClientId('00000000-0000-4000-9000-000000000000')).toBe(true);
    expect(isClientId('00000000-0000-4000-a000-000000000000')).toBe(true);
    expect(isClientId('00000000-0000-4000-b000-000000000000')).toBe(true);
  });

  it('rejects v1 / v3 / v5 / v7 UUIDs (wrong version nibble)', () => {
    // v1 — time-based; the version slot is 1, not 4.
    expect(isClientId('00000000-0000-1000-8000-000000000000')).toBe(false);
    // v3 — name-based MD5.
    expect(isClientId('00000000-0000-3000-8000-000000000000')).toBe(false);
    // v5 — name-based SHA-1.
    expect(isClientId('00000000-0000-5000-8000-000000000000')).toBe(false);
    // v7 — UUIDv7 (Unix-time-ordered); explicitly rejected per T-S12 so
    // a deliberately-tampered client RNG can't slip a sortable id past
    // the offline-sync envelope.
    expect(isClientId('00000000-0000-7000-8000-000000000000')).toBe(false);
  });

  it('rejects v4 with a wrong variant nibble (must be one of 8/9/a/b)', () => {
    expect(isClientId('00000000-0000-4000-0000-000000000000')).toBe(false);
    expect(isClientId('00000000-0000-4000-c000-000000000000')).toBe(false);
    expect(isClientId('00000000-0000-4000-f000-000000000000')).toBe(false);
  });

  it('rejects uppercase hex (canonical lowercase only)', () => {
    expect(isClientId('123E4567-E89B-42D3-A456-426614174000')).toBe(false);
  });

  it('rejects non-UUID strings', () => {
    expect(isClientId('')).toBe(false);
    expect(isClientId('not-a-uuid')).toBe(false);
    expect(isClientId('123e4567-e89b-42d3-a456-42661417400')).toBe(false); // too short
    expect(isClientId('123e4567-e89b-42d3-a456-4266141740000')).toBe(false); // too long
    expect(isClientId('123e4567e89b42d3a456426614174000')).toBe(false); // missing dashes
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
