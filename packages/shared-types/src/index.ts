// @jhsc/shared-types — type definitions consumed across the workspace.
//
// Rules (CLAUDE.md):
// - No magic strings. Every enum lives here.
// - Discriminated unions for fallible operations and for audit payloads
//   so the typechecker rejects PI fields at every call site.

// ---------------------------------------------------------------------------
// Result<T, E> — fallible operations
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Branded IDs — nominal typing for opaque strings
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;

// ---------------------------------------------------------------------------
// Auth-surface enums (mirror the pgEnums in apps/api/src/db/schema.ts)
// ---------------------------------------------------------------------------

export type AuthEventKind =
  | 'signup'
  | 'login.passkey'
  | 'login.password'
  | 'login.totp'
  | 'login.recovery'
  | 'login.failed'
  | 'logout'
  | 'session.refreshed'
  | 'session.revoked'
  | 'step_up.granted'
  | 'step_up.denied'
  | 'lockout.applied'
  | 'lockout.cleared'
  | 'passkey.registered'
  | 'passkey.removed'
  | 'totp.enrolled'
  | 'totp.reset'
  | 'recovery_codes.generated'
  | 'recovery_codes.consumed'
  | 'first_run.completed';

export type WebauthnPurpose = 'register' | 'authenticate' | 'step_up';
export type LoginAttemptOutcome = 'success' | 'failure';

// ---------------------------------------------------------------------------
// Audit chain — kinds + per-kind payload unions (ADR-0002 §"Audit chain")
// ---------------------------------------------------------------------------

// `system.*` and `audit.*` kinds are used by packages/audit's own
// boilerplate (genesis, backfill anchors, key-rotation markers).
// `auth.*` kinds mirror AuthEventKind so the chain absorbs 1.2's
// flat auth_events stream when the backfill anchor lands.
// Later milestones grow this union (`hazard.*`, `export.*`, etc.).
export type AuditEventKind =
  | 'system.genesis'
  | 'audit.backfill.1_2_auth_events'
  | 'audit.crypto.rewrap'
  | 'audit.kek.rotation'
  | AuthEventKind;

/**
 * Per-kind payload shapes. Every kind that ever lands an audit row
 * must declare its payload here. Fields are typed enums + IDs +
 * counts only — never PI. The typechecker rejects unrecognized
 * fields at every `append()` call site (T-AC9 mitigation).
 */
export type AuditPayload =
  | { readonly kind: 'system.genesis'; readonly schemaVersion: string }
  | {
      readonly kind: 'audit.backfill.1_2_auth_events';
      readonly rowCount: number;
      readonly rowsSha256: string;
      readonly oldestTs: string | null;
      readonly newestTs: string | null;
    }
  | { readonly kind: 'audit.crypto.rewrap'; readonly resource: string }
  | { readonly kind: 'audit.kek.rotation'; readonly fromKid: string; readonly toKid: string }
  | { readonly kind: 'signup'; readonly via: 'first_run' | 'invite' }
  | { readonly kind: 'login.passkey' }
  | { readonly kind: 'login.password' }
  | { readonly kind: 'login.totp' }
  | { readonly kind: 'login.recovery'; readonly codeId: string }
  | { readonly kind: 'login.failed'; readonly reason?: string }
  | { readonly kind: 'logout'; readonly sessionId: SessionId }
  | { readonly kind: 'session.refreshed'; readonly sessionId: SessionId }
  | {
      readonly kind: 'session.revoked';
      readonly scope: 'single' | 'all';
      readonly sessionsRemoved?: number;
    }
  | { readonly kind: 'step_up.granted'; readonly until: string | null }
  | { readonly kind: 'step_up.denied'; readonly reason: string }
  | {
      readonly kind: 'lockout.applied';
      readonly tier: 'short' | 'long' | 'hard';
      readonly retryAfterSeconds: number | null;
    }
  | {
      readonly kind: 'lockout.cleared';
      readonly operator: string;
      readonly reason: string;
      readonly rowsDeleted: number;
    }
  | { readonly kind: 'passkey.registered' }
  | { readonly kind: 'passkey.removed' }
  | { readonly kind: 'totp.enrolled' }
  | { readonly kind: 'totp.reset' }
  | { readonly kind: 'recovery_codes.generated'; readonly count: number }
  | { readonly kind: 'recovery_codes.consumed'; readonly codeId: string }
  | { readonly kind: 'first_run.completed' };

// ---------------------------------------------------------------------------
// Typed auth errors — exhaustive (consumed by apps/api routes + apps/web copy)
// ---------------------------------------------------------------------------

export type AuthError =
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'invalid_credentials' }
  | { kind: 'totp_required' }
  | { kind: 'totp_invalid' }
  | { kind: 'recovery_code_invalid' }
  | { kind: 'passkey_challenge_expired' }
  | { kind: 'passkey_verification_failed' }
  | { kind: 'passkey_unknown_credential' }
  | { kind: 'passkey_counter_rollback' }
  | { kind: 'lockout_short'; retryAfterSeconds: number }
  | { kind: 'lockout_long'; retryAfterSeconds: number }
  | { kind: 'lockout_hard' }
  | { kind: 'first_run_already_completed' }
  | { kind: 'first_run_not_completed' }
  | { kind: 'session_expired' }
  | { kind: 'session_revoked' }
  | { kind: 'step_up_required'; action: string }
  | { kind: 'csrf_blocked' }
  | { kind: 'internal' };
