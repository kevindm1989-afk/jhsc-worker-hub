// Session-level endpoints: refresh, logout, current.
//
//   POST /api/auth/refresh   — rotates refresh, mints new access JWT.
//                              No body; uses __Host-refresh cookie.
//   POST /api/auth/logout    — revokes the session, clears cookies.
//   GET  /api/auth/session   — returns the current user's id +
//                              step-up status. The display name lives
//                              in user_profiles (encrypted); decrypt is
//                              optional — for now we return id only.

import type { SessionId } from '@jhsc/shared-types';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { authMiddleware, REFRESH_COOKIE } from '../../auth/step-up';
import { clearAuthCookies, setAuthCookies } from '../../auth/cookies';
import { emitAuthEvent } from '../../auth/events';
import { clientIp, userAgent } from '../../auth/request';
import { refreshSession, revokeAllUserSessions, revokeSession } from '../../auth/session';
import { initCrypto, openString } from '../../auth/crypto-stub';
import { getDb } from '../../db/client';
import { getActiveWorkplacePublicKey } from '../../evidence/workplace-key';
import { userProfiles } from '../../db/schema';
import { eq } from 'drizzle-orm';

export const sessionRoute = new Hono();

sessionRoute.post('/refresh', async (c) => {
  const refresh = getCookie(c, REFRESH_COOKIE);
  if (!refresh) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await initCrypto();
  const ip = clientIp(c);
  const ua = userAgent(c);
  const outcome = await refreshSession(refresh, { ip, userAgent: ua });
  if (!outcome.ok) {
    clearAuthCookies(c);
    if (outcome.reason === 'unknown') {
      // Reuse-as-compromise policy: a refresh value that doesn't match
      // any current row may be a replay of a token that's already been
      // rotated. We can't tell which user it belonged to (the row is
      // gone), so we just deny the call. If a future iteration adds a
      // short-lived "recently rotated" log we can kill the sibling.
      return c.json({ error: 'session_revoked' }, 401);
    }
    return c.json({ error: 'session_expired' }, 401);
  }
  setAuthCookies(c, outcome.tokens);
  await emitAuthEvent({
    actorId: outcome.tokens.userId,
    payload: {
      kind: 'session.refreshed',
      sessionId: outcome.tokens.sessionId as unknown as SessionId,
    },
    ip,
    userAgent: ua,
  });
  return c.json({ sessionId: outcome.tokens.sessionId });
});

sessionRoute.post('/logout', authMiddleware(), async (c) => {
  const auth = c.get('auth');
  await revokeSession(auth.sessionId);
  clearAuthCookies(c);
  await emitAuthEvent({
    actorId: auth.userId,
    payload: { kind: 'logout', sessionId: auth.sessionId as unknown as SessionId },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  return c.json({ ok: true });
});

sessionRoute.post('/logout-all', authMiddleware(), async (c) => {
  const auth = c.get('auth');
  await revokeAllUserSessions(auth.userId);
  clearAuthCookies(c);
  await emitAuthEvent({
    actorId: auth.userId,
    payload: { kind: 'session.revoked', scope: 'all' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  return c.json({ ok: true });
});

sessionRoute.get('/session', authMiddleware(), async (c) => {
  await initCrypto();
  const auth = c.get('auth');
  const db = getDb();
  const profiles = await db
    .select({ name: userProfiles.displayNameCiphertext })
    .from(userProfiles)
    .where(eq(userProfiles.userId, auth.userId))
    .limit(1);
  const displayName = profiles[0]?.name !== undefined ? openString(profiles[0].name) : null;
  // Workplace public key ships with every session response so the
  // browser can sealed-box-encrypt evidence file DEKs (ADR-0006). The
  // public key is safe to ship -- it's the recipient half of a sealed
  // box, useless for decryption.
  const workplaceKey = await getActiveWorkplacePublicKey(db);
  return c.json({
    userId: auth.userId,
    displayName,
    sessionId: auth.sessionId,
    stepUp: auth.stepUpUntil
      ? { active: true, until: auth.stepUpUntil.toISOString() }
      : { active: false, until: null },
    workplaceKey: workplaceKey
      ? {
          id: workplaceKey.id,
          publicKeyB64: Buffer.from(workplaceKey.publicKey).toString('base64'),
        }
      : null,
  });
});
