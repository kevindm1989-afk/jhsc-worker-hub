// Step-up grant endpoints (ADR-0001).
//
//   POST /api/auth/step-up/passkey/options
//        → WebAuthn auth options (purpose=step_up). 60-second challenge.
//   POST /api/auth/step-up/passkey/verify
//        body: AuthenticationResponseJSON
//        → 200 — server sets sessions.step_up_until and reissues a
//                fresh access cookie carrying the new step_up_until
//                claim.
//   POST /api/auth/step-up/totp
//        body: { totpCode }
//        → 200 — same end state.
//
// All three require an authenticated session.

import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { initCrypto, open as openSealed } from '../../auth/crypto-stub';
import { setAuthCookies } from '../../auth/cookies';
import { emitAuthEvent } from '../../auth/events';
import { clientIp, userAgent } from '../../auth/request';
import { grantStepUp, validateAccess } from '../../auth/session';
import { authMiddleware, ACCESS_COOKIE } from '../../auth/step-up';
import { verifyTotp } from '../../auth/totp';
import { finishAuthentication, startAuthentication } from '../../auth/webauthn';
import { getDb } from '../../db/client';
import { totpCredentials } from '../../db/schema';
import { z } from 'zod';
import { setCookie } from 'hono/cookie';

export const stepUpRoute = new Hono();

stepUpRoute.use('*', authMiddleware());

stepUpRoute.post('/passkey/options', async (c) => {
  const auth = c.get('auth');
  await initCrypto();
  const options = await startAuthentication({ userId: auth.userId, purpose: 'step_up' });
  return c.json(options);
});

stepUpRoute.post('/passkey/verify', async (c) => {
  const auth = c.get('auth');
  await initCrypto();
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_input' }, 400);

  const outcome = await finishAuthentication({
    response: body as Parameters<typeof finishAuthentication>[0]['response'],
    purpose: 'step_up',
  });
  if (!outcome.ok || outcome.auth.userId !== auth.userId) {
    await emitAuthEvent({
      actorId: auth.userId,
      kind: 'step_up.denied',
      ip: clientIp(c),
      userAgent: userAgent(c),
      metadata: outcome.ok ? { reason: 'user_mismatch' } : { reason: outcome.reason },
    });
    return c.json({ error: 'step_up_denied' }, 401);
  }
  return await grantAndIssue(c, auth.sessionId);
});

const totpBody = z.object({
  totpCode: z.string().regex(/^[0-9]{6}$/),
});

stepUpRoute.post('/totp', async (c) => {
  const auth = c.get('auth');
  const parsed = totpBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  await initCrypto();
  const db = getDb();
  const rows = await db
    .select({
      secretCiphertext: totpCredentials.secretCiphertext,
      lastUsedStep: totpCredentials.lastUsedStep,
    })
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, auth.userId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    await emitAuthEvent({
      actorId: auth.userId,
      kind: 'step_up.denied',
      ip: clientIp(c),
      userAgent: userAgent(c),
      metadata: { reason: 'no_totp' },
    });
    return c.json({ error: 'step_up_denied' }, 401);
  }
  const secret = openSealed(row.secretCiphertext);
  const r = verifyTotp(parsed.data.totpCode, secret, row.lastUsedStep);
  if (!r.ok) {
    await emitAuthEvent({
      actorId: auth.userId,
      kind: 'step_up.denied',
      ip: clientIp(c),
      userAgent: userAgent(c),
      metadata: { reason: 'totp_invalid' },
    });
    return c.json({ error: 'step_up_denied' }, 401);
  }
  await db
    .update(totpCredentials)
    .set({ lastUsedStep: r.step })
    .where(eq(totpCredentials.userId, auth.userId));
  return await grantAndIssue(c, auth.sessionId);
});

async function grantAndIssue(c: Context, sessionId: string) {
  const fresh = await grantStepUp({ sessionId });
  if (!fresh) {
    return c.json({ error: 'step_up_denied' }, 401);
  }
  // grantStepUp returns the new access JWT; we also need to verify it
  // to pull the new step_up_until for the response body.
  setCookie(c, ACCESS_COOKIE, fresh, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 30 * 60,
  });
  const validated = await validateAccess(fresh);
  await emitAuthEvent({
    actorId: validated?.userId ?? null,
    kind: 'step_up.granted',
    ip: clientIp(c),
    userAgent: userAgent(c),
    metadata: validated?.stepUpUntil ? { until: validated.stepUpUntil.toISOString() } : {},
  });
  return c.json({
    stepUp: {
      active: true,
      until: validated?.stepUpUntil?.toISOString() ?? null,
    },
  });
}

// Keep the cookie setter import meaningful for linters even when the
// function is only called via grantAndIssue.
void setAuthCookies;
