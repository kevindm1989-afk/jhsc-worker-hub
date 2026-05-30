// Passkey enrollment + management (authenticated).
//
//   POST   /api/auth/passkey/register-options
//                                — start a registration for the current user.
//   POST   /api/auth/passkey/register-verify
//                                — finish; persists passkey_credentials row.
//   GET    /api/auth/passkey      — list the current user's passkeys.
//   DELETE /api/auth/passkey/:id  — remove one. Requires step-up.
//   PATCH  /api/auth/passkey/:id  — rename. (no step-up — purely cosmetic.)
//
// The login-side /api/auth/passkey/auth-* endpoints live in routes/auth/login.ts.

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, requireStepUp } from '../../auth/step-up';
import { emitAuthEvent } from '../../auth/events';
import { initCrypto, openString } from '../../auth/crypto-stub';
import { clientIp, userAgent } from '../../auth/request';
import { finishRegistration, startRegistration } from '../../auth/webauthn';
import { getDb } from '../../db/client';
import { passkeyCredentials, userProfiles } from '../../db/schema';

export const passkeyRoute = new Hono();

passkeyRoute.use('*', authMiddleware());

passkeyRoute.post('/register-options', async (c) => {
  await initCrypto();
  const auth = c.get('auth');
  const db = getDb();
  const rows = await db
    .select({
      displayName: userProfiles.displayNameCiphertext,
      email: userProfiles.emailCiphertext,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, auth.userId))
    .limit(1);
  const profile = rows[0];
  const userDisplayName = profile?.displayName ? openString(profile.displayName) : 'JHSC user';
  const userName = profile?.email ? openString(profile.email) : auth.userId;
  const options = await startRegistration({
    userId: auth.userId,
    userDisplayName,
    userName,
  });
  return c.json(options);
});

passkeyRoute.post('/register-verify', async (c) => {
  await initCrypto();
  const auth = c.get('auth');
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_input' }, 400);

  const outcome = await finishRegistration({
    userId: auth.userId,
    response: body as Parameters<typeof finishRegistration>[0]['response'],
  });
  if (!outcome.ok) {
    return c.json({ error: 'verification_failed', reason: outcome.reason }, 400);
  }
  const db = getDb();
  await db.insert(passkeyCredentials).values({
    id: outcome.credential.credentialId,
    userId: auth.userId,
    publicKey: outcome.credential.publicKey,
    counter: outcome.credential.counter,
    transports: outcome.credential.transports as string[],
  });
  await emitAuthEvent({
    actorId: auth.userId,
    payload: { kind: 'passkey.registered' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  return c.json({ credentialId: bytesToB64u(outcome.credential.credentialId) }, 201);
});

passkeyRoute.get('/', async (c) => {
  const auth = c.get('auth');
  const db = getDb();
  const rows = await db
    .select({
      id: passkeyCredentials.id,
      nickname: passkeyCredentials.nickname,
      transports: passkeyCredentials.transports,
      createdAt: passkeyCredentials.createdAt,
      lastUsedAt: passkeyCredentials.lastUsedAt,
    })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, auth.userId));
  return c.json({
    passkeys: rows.map((r) => ({
      id: bytesToB64u(r.id),
      nickname: r.nickname,
      transports: r.transports as string[],
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    })),
  });
});

const renameBody = z.object({ nickname: z.string().trim().min(1).max(64) });

passkeyRoute.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const parsed = renameBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const id = b64uToBytes(c.req.param('id'));
  const db = getDb();
  await db
    .update(passkeyCredentials)
    .set({ nickname: parsed.data.nickname })
    .where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, auth.userId)));
  return c.json({ ok: true });
});

passkeyRoute.delete('/:id', requireStepUp({ action: 'passkey.remove' }), async (c) => {
  const auth = c.get('auth');
  const id = b64uToBytes(c.req.param('id'));
  const db = getDb();
  await db
    .delete(passkeyCredentials)
    .where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, auth.userId)));
  await emitAuthEvent({
    actorId: auth.userId,
    payload: { kind: 'passkey.removed' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  return c.json({ ok: true });
});

function bytesToB64u(b: Uint8Array): string {
  return Buffer.from(b)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function b64uToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}
