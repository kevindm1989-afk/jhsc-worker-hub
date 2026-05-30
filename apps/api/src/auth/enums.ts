// Auth-domain types that downstream modules import.
//
// Per CLAUDE.md "No magic strings — enums and constants in shared-types".
// The shared-types package is planned for Milestone 1.3+. Until then these
// live here. The literal-union shapes are identical to the pgEnum entries
// in src/db/schema.ts; the pg-side strings are the source of truth.

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
// Result<T, E> — discriminated union per CLAUDE.md
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
// Typed auth errors — exhaustive list. Routes map kinds to HTTP status +
// user-facing copy. NEVER reflect raw error.message into a response.
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
  | { kind: 'internal' };
