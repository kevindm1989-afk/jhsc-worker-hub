import { describe, expect, it } from 'vitest';
import {
  err,
  inspectionConductState,
  inspectionExportKind,
  inspectionFindingStatusAbcx,
  inspectionFindingStatusGar,
  inspectionPromotability,
  inspectionSignatureRole,
  inspectionStatusVocabKind,
  inspectionTemplateCode,
  ok,
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
