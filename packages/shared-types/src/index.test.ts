import { describe, expect, it } from 'vitest';
import { err, ok } from './index';
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
