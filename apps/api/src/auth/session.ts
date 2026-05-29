// Session lifecycle (ADR-0001).
//
// A session is one row in `sessions`. It owns:
// - The opaque refresh token (stored as BLAKE2b hash; plaintext lives
//   in the browser's __Host-refresh cookie).
// - The expiry timestamps (access JWT is short-lived; refresh is
//   long-lived but rotates on every use).
// - The step-up window (`step_up_until`) — when set, the next access
//   JWT carries it as a claim until the timestamp passes.
//
// Refresh rotation is the safety net: re-presenting a refresh token
// that's already been consumed kills the entire session. That's the
// classic "absolute session security" signal — any future request
// using that session fails.

import { encodeBase64urlNoPadding } from '@oslojs/encoding';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sessions } from '../db/schema';
import { blake2bUnkeyed, initCrypto, randomBytes } from './crypto-stub';
import { signAccessToken, verifyAccessToken } from './jwt';

const SESSION_ID_BYTES = 25; // ~ 33 base64url chars; matches Lucia v3 conventions.
const REFRESH_BYTES = 32;
const REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface IssuedTokens {
  /** Short-lived EdDSA JWT for the __Host-access cookie. */
  readonly accessJwt: string;
  /** Opaque base64url string for the __Secure-refresh cookie. */
  readonly refreshToken: string;
  /** Mirrors sessions.refresh_expires_at — Set-Cookie Max-Age source. */
  readonly refreshExpiresAt: Date;
  /** The newly-created (or rotated) session id. Useful for logging. */
  readonly sessionId: string;
  /** Owner of the session — emitted into auth_events.actor_id. */
  readonly userId: string;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly stepUpUntil?: Date | null;
}

export async function createSession(input: CreateSessionInput): Promise<IssuedTokens> {
  await initCrypto();
  const db = getDb();
  const sessionId = encodeBase64urlNoPadding(randomBytes(SESSION_ID_BYTES));
  const refresh = randomBytes(REFRESH_BYTES);
  const refreshToken = encodeBase64urlNoPadding(refresh);
  const refreshHash = blake2bUnkeyed(refresh);
  const now = new Date();
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000);
  // Lucia v3's session row needs `expires_at` to be the session-lifetime
  // ceiling. We align it with the refresh-token expiry: when refresh
  // expires, the session is effectively dead, so the row may be GC'd.
  const expiresAt = refreshExpiresAt;
  await db.insert(sessions).values({
    id: sessionId,
    userId: input.userId,
    expiresAt,
    refreshTokenHash: refreshHash,
    refreshExpiresAt,
    stepUpUntil: input.stepUpUntil ?? null,
    ipAtCreate: input.ip ?? null,
    uaAtCreate: input.userAgent ?? null,
  });
  const accessJwt = await signAccessToken({
    sub: input.userId,
    sid: sessionId,
    stepUpUntil: toEpochSecondsOrNull(input.stepUpUntil ?? null),
  });
  return { accessJwt, refreshToken, refreshExpiresAt, sessionId, userId: input.userId };
}

function toEpochSecondsOrNull(d: Date | null): number | null {
  if (!d) return null;
  return Math.floor(d.getTime() / 1000);
}

export type RefreshOutcome =
  | { readonly ok: true; readonly tokens: IssuedTokens }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'compromised' };

/**
 * Consume a refresh token, rotate it, return new tokens.
 *
 * Behavior:
 * - Token not found → `unknown`.
 * - Token found but `refresh_expires_at < now` → `expired`, delete row.
 * - Token found and valid → rotate (update hash + expiry, mint new
 *   access JWT preserving the existing `step_up_until` claim).
 *
 * Reuse detection: a refresh token plaintext maps to a single row via
 * its hash. Once we rotate, the old hash is gone — a second presentation
 * of the same plaintext will hit the `unknown` branch. Routes treat
 * `unknown` paired with a recently-issued cookie as "treat as
 * compromised" and kill any sibling session for the same user. That
 * higher-level policy lives in the route, not here.
 */
export async function refreshSession(
  refreshToken: string,
  args: { ip?: string | null; userAgent?: string | null } = {},
): Promise<RefreshOutcome> {
  await initCrypto();
  void args;
  const db = getDb();
  let refreshBytes: Uint8Array;
  try {
    refreshBytes = decodeBase64UrlStrict(refreshToken);
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  const hash = blake2bUnkeyed(refreshBytes);
  const rows = await db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  const now = new Date();
  if (row.refreshExpiresAt.getTime() < now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, row.id));
    return { ok: false, reason: 'expired' };
  }
  // Rotate.
  const newRefresh = randomBytes(REFRESH_BYTES);
  const newRefreshToken = encodeBase64urlNoPadding(newRefresh);
  const newRefreshHash = blake2bUnkeyed(newRefresh);
  const newRefreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000);
  await db
    .update(sessions)
    .set({
      refreshTokenHash: newRefreshHash,
      refreshExpiresAt: newRefreshExpiresAt,
      expiresAt: newRefreshExpiresAt,
    })
    .where(eq(sessions.id, row.id));
  const stepUpUntilSeconds =
    row.stepUpUntil && row.stepUpUntil.getTime() > now.getTime()
      ? Math.floor(row.stepUpUntil.getTime() / 1000)
      : null;
  const accessJwt = await signAccessToken({
    sub: row.userId,
    sid: row.id,
    stepUpUntil: stepUpUntilSeconds,
  });
  return {
    ok: true,
    tokens: {
      accessJwt,
      refreshToken: newRefreshToken,
      refreshExpiresAt: newRefreshExpiresAt,
      sessionId: row.id,
      userId: row.userId,
    },
  };
}

export interface ValidatedAccess {
  readonly userId: string;
  readonly sessionId: string;
  /** Date if step-up is currently active, else null. */
  readonly stepUpUntil: Date | null;
}

export async function validateAccess(jwt: string): Promise<ValidatedAccess | null> {
  const claims = await verifyAccessToken(jwt);
  if (!claims) return null;
  // Verify the session row still exists and hasn't been revoked.
  const db = getDb();
  const rows = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      stepUpUntil: sessions.stepUpUntil,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.id, claims.sid), eq(sessions.userId, claims.sub)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = new Date();
  if (row.expiresAt.getTime() < now.getTime()) return null;
  const stepUpUntil =
    row.stepUpUntil && row.stepUpUntil.getTime() > now.getTime() ? row.stepUpUntil : null;
  return { userId: row.userId, sessionId: row.id, stepUpUntil };
}

export async function revokeSession(sessionId: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export interface GrantStepUpInput {
  readonly sessionId: string;
  readonly maxAgeSeconds?: number; // default 5 min (ADR-0001)
}

export async function grantStepUp(input: GrantStepUpInput): Promise<string | null> {
  const db = getDb();
  const ttl = input.maxAgeSeconds ?? 5 * 60;
  const until = new Date(Date.now() + ttl * 1000);
  const updated = await db
    .update(sessions)
    .set({ stepUpUntil: until })
    .where(eq(sessions.id, input.sessionId))
    .returning({ userId: sessions.userId });
  const row = updated[0];
  if (!row) return null;
  return signAccessToken({
    sub: row.userId,
    sid: input.sessionId,
    stepUpUntil: Math.floor(until.getTime() / 1000),
  });
}

// ---------------------------------------------------------------------------
// base64url decode (strict — rejects padding and non-alphabet bytes)
// ---------------------------------------------------------------------------

function decodeBase64UrlStrict(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error('invalid base64url');
  }
  // Pad to multiple of 4 and convert to standard base64.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

export const _internals = { SESSION_ID_BYTES, REFRESH_BYTES, REFRESH_TTL_SECONDS };
