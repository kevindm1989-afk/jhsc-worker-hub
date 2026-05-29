// Login flows (ADR-0001).
//
// Password + TOTP:
//   POST /api/auth/password/login          { email, password }
//        → 200 { stage: 'totp_required', pending } | 401
//   POST /api/auth/password/totp           { pending, totpCode }
//        → 201 + cookies | 401
//   POST /api/auth/password/recovery       { pending, recoveryCode }
//        → 201 + cookies | 401
//
// Passkey (discoverable-credential first; allowCredentials when known):
//   POST /api/auth/passkey/auth-options    { email? }
//        → 200 PublicKeyCredentialRequestOptionsJSON (challenge persisted)
//   POST /api/auth/passkey/auth-verify     AuthenticationResponseJSON
//        → 201 + cookies | 401
//
// The "pending" blob is the same sealed-blob pattern as first-run
// provisioning. 60-second TTL. The blob carries the userId only — no
// secret material rides in it.

import { eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  CryptoOpenError,
  initCrypto,
  open as openSealed,
  openString,
  seal,
} from '../../auth/crypto-stub';
import { setAuthCookies } from '../../auth/cookies';
import { emitAuthEvent } from '../../auth/events';
import {
  lockoutIdentifierForEmail,
  lookupHashForEmail,
  normalizeEmail,
} from '../../auth/identifier';
import { checkLockout, recordAttempt } from '../../auth/lockout';
import { verifyPassword, verifyAgainstCanary, hashPassword } from '../../auth/password';
import { hashRecoveryCode, matchRecoveryCode } from '../../auth/recovery-codes';
import { clientIp, userAgent } from '../../auth/request';
import { createSession } from '../../auth/session';
import { verifyTotp } from '../../auth/totp';
import { finishAuthentication, startAuthentication } from '../../auth/webauthn';
import { getDb } from '../../db/client';
import {
  passkeyCredentials,
  passwordCredentials,
  recoveryCodes,
  totpCredentials,
  userProfiles,
} from '../../db/schema';

export const loginRoute = new Hono();

const PENDING_TAG = 'login-pending:v1';
const PENDING_TTL_MS = 60 * 1000;

interface PendingPayload {
  readonly tag: typeof PENDING_TAG;
  readonly userId: string;
  readonly expiresAt: number;
}

function toB64u(b: Uint8Array): string {
  return Buffer.from(b)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function fromB64u(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function makePending(userId: string): string {
  const payload: PendingPayload = {
    tag: PENDING_TAG,
    userId,
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
  return toB64u(seal(new TextEncoder().encode(JSON.stringify(payload))));
}

function openPending(pending: string): PendingPayload | null {
  try {
    const bytes = openSealed(fromB64u(pending));
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (o.tag !== PENDING_TAG || typeof o.userId !== 'string' || typeof o.expiresAt !== 'number') {
      return null;
    }
    if ((o.expiresAt as number) < Date.now()) return null;
    return { tag: PENDING_TAG, userId: o.userId, expiresAt: o.expiresAt };
  } catch (e) {
    if (e instanceof CryptoOpenError || e instanceof SyntaxError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Password — stage 1
// ---------------------------------------------------------------------------

const passwordLoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

loginRoute.post('/password/login', async (c) => {
  const parsed = passwordLoginBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_input' }, 400);
  }
  await initCrypto();
  const normalized = normalizeEmail(parsed.data.email);
  const identifierHash = await lockoutIdentifierForEmail(normalized);
  const ip = clientIp(c);
  const ua = userAgent(c);

  const lockout = await checkLockout({ identifierHash, ip });
  if (lockout.locked) {
    return lockoutResponse(c, lockout.tier!, lockout.retryAfterSeconds);
  }

  const db = getDb();
  const emailLookup = await lookupHashForEmail(normalized);
  const profileRows = await db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.emailLookupHash, emailLookup))
    .limit(1);
  const profile = profileRows[0];

  if (!profile) {
    // No such user — burn equivalent time on the canary so the response
    // latency does not betray non-existence.
    await verifyAgainstCanary(parsed.data.password);
    await recordAttempt({ identifierHash, ip, outcome: 'failure' });
    await emitAuthEvent({ actorId: null, kind: 'login.failed', ip, userAgent: ua });
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const pwRows = await db
    .select({ hash: passwordCredentials.hash })
    .from(passwordCredentials)
    .where(eq(passwordCredentials.userId, profile.userId))
    .limit(1);
  const pwRow = pwRows[0];
  if (!pwRow) {
    // User exists but no password set — fall through canary.
    await verifyAgainstCanary(parsed.data.password);
    await recordAttempt({ identifierHash, ip, outcome: 'failure' });
    await emitAuthEvent({ actorId: profile.userId, kind: 'login.failed', ip, userAgent: ua });
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const verify = await verifyPassword(parsed.data.password, pwRow.hash);
  if (!verify.ok) {
    await recordAttempt({ identifierHash, ip, outcome: 'failure' });
    await emitAuthEvent({ actorId: profile.userId, kind: 'login.failed', ip, userAgent: ua });
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // Password OK — silently rehash if params drifted.
  if (verify.needsRehash) {
    const fresh = await hashPassword(parsed.data.password);
    await db
      .update(passwordCredentials)
      .set({ hash: fresh.hash, updatedAt: new Date() })
      .where(eq(passwordCredentials.userId, profile.userId));
  }
  // DO NOT record success yet — TOTP must still verify.
  return c.json({ stage: 'totp_required', pending: makePending(profile.userId) });
});

// ---------------------------------------------------------------------------
// Password — stage 2 (TOTP)
// ---------------------------------------------------------------------------

const totpStepBody = z.object({
  pending: z.string().min(1),
  totpCode: z.string().regex(/^[0-9]{6}$/),
});

loginRoute.post('/password/totp', async (c) => {
  const parsed = totpStepBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  await initCrypto();
  const pending = openPending(parsed.data.pending);
  if (!pending) return c.json({ error: 'totp_invalid' }, 401);

  const db = getDb();
  const rows = await db
    .select({
      secretCiphertext: totpCredentials.secretCiphertext,
      lastUsedStep: totpCredentials.lastUsedStep,
    })
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, pending.userId))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: 'totp_invalid' }, 401);

  const secret = openSealed(row.secretCiphertext);
  const r = verifyTotp(parsed.data.totpCode, secret, row.lastUsedStep);
  if (!r.ok) {
    const idHash = await identifierHashForUser(pending.userId);
    await recordAttempt({ identifierHash: idHash, ip: clientIp(c), outcome: 'failure' });
    await emitAuthEvent({
      actorId: pending.userId,
      kind: 'login.failed',
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    return c.json({ error: 'totp_invalid' }, 401);
  }

  await db
    .update(totpCredentials)
    .set({ lastUsedStep: r.step })
    .where(eq(totpCredentials.userId, pending.userId));

  return await completeLogin(c, pending.userId, 'login.password');
});

// ---------------------------------------------------------------------------
// Password — stage 2 alternate (recovery code)
// ---------------------------------------------------------------------------

const recoveryStepBody = z.object({
  pending: z.string().min(1),
  recoveryCode: z.string().min(8).max(32),
});

loginRoute.post('/password/recovery', async (c) => {
  const parsed = recoveryStepBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  await initCrypto();
  const pending = openPending(parsed.data.pending);
  if (!pending) return c.json({ error: 'recovery_code_invalid' }, 401);

  const db = getDb();
  const candidates = await db
    .select({ id: recoveryCodes.id, hash: recoveryCodes.codeHash })
    .from(recoveryCodes)
    .where(
      sql`${recoveryCodes.userId} = ${pending.userId} AND ${recoveryCodes.consumedAt} IS NULL`,
    );
  const inputHash = hashRecoveryCode(parsed.data.recoveryCode);
  void inputHash;
  const matched = matchRecoveryCode(parsed.data.recoveryCode, candidates);
  if (!matched) {
    const idHash = await identifierHashForUser(pending.userId);
    await recordAttempt({ identifierHash: idHash, ip: clientIp(c), outcome: 'failure' });
    await emitAuthEvent({
      actorId: pending.userId,
      kind: 'login.failed',
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    return c.json({ error: 'recovery_code_invalid' }, 401);
  }
  await db
    .update(recoveryCodes)
    .set({ consumedAt: new Date() })
    .where(eq(recoveryCodes.id, matched.id));
  await emitAuthEvent({
    actorId: pending.userId,
    kind: 'recovery_codes.consumed',
    ip: clientIp(c),
    userAgent: userAgent(c),
    metadata: { codeId: matched.id },
  });

  return await completeLogin(c, pending.userId, 'login.recovery');
});

// ---------------------------------------------------------------------------
// Passkey — auth options + verify
// ---------------------------------------------------------------------------

const passkeyOptionsBody = z.object({ email: z.string().email().max(254).optional() });

loginRoute.post('/passkey/auth-options', async (c) => {
  await initCrypto();
  const parsed = passkeyOptionsBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  let userId: string | null = null;
  if (parsed.data.email) {
    const lookup = await lookupHashForEmail(parsed.data.email);
    const db = getDb();
    const rows = await db
      .select({ userId: userProfiles.userId })
      .from(userProfiles)
      .where(eq(userProfiles.emailLookupHash, lookup))
      .limit(1);
    userId = rows[0]?.userId ?? null;
  }
  const options = await startAuthentication({
    userId,
    purpose: 'authenticate',
  });
  return c.json(options);
});

loginRoute.post('/passkey/auth-verify', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_input' }, 400);

  await initCrypto();
  // Trust the @simplewebauthn lib's parser for the AuthenticationResponseJSON shape.
  const outcome = await finishAuthentication({
    response: body as Parameters<typeof finishAuthentication>[0]['response'],
    purpose: 'authenticate',
  });
  if (!outcome.ok) {
    await emitAuthEvent({
      actorId: null,
      kind: 'login.failed',
      ip: clientIp(c),
      userAgent: userAgent(c),
      metadata: { reason: outcome.reason },
    });
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  void passkeyCredentials; // schema reference for grep findability
  return await completeLogin(c, outcome.auth.userId, 'login.passkey');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function identifierHashForUser(userId: string): Promise<Uint8Array> {
  // Pull the email lookup hash directly — it's the same shape we use
  // for lockout counters in the pre-auth flow.
  const db = getDb();
  const rows = await db
    .select({ h: userProfiles.emailLookupHash })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return new Uint8Array(32);
  return row.h;
}

async function completeLogin(
  c: Context,
  userId: string,
  kind: 'login.password' | 'login.passkey' | 'login.recovery',
) {
  const ip = clientIp(c);
  const ua = userAgent(c);
  const identifierHash = await identifierHashForUser(userId);
  await recordAttempt({ identifierHash, ip, outcome: 'success' });
  const tokens = await createSession({ userId, ip, userAgent: ua });
  setAuthCookies(c, tokens);
  await emitAuthEvent({ actorId: userId, kind, ip, userAgent: ua });
  return c.json({ userId, sessionId: tokens.sessionId }, 201);
}

function lockoutResponse(
  c: Context,
  tier: 'short' | 'long' | 'hard',
  retryAfterSeconds: number | undefined,
) {
  if (tier === 'hard') {
    return c.json({ error: 'lockout_hard' }, 423);
  }
  const headers: Record<string, string> = {};
  if (retryAfterSeconds) headers['Retry-After'] = String(retryAfterSeconds);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json(
    { error: tier === 'short' ? 'lockout_short' : 'lockout_long', retryAfterSeconds },
    429,
  );
}

// Eagerly-evaluated reference so unused-import warnings stay quiet for
// modules we keep for future endpoints in this router.
void openString;
