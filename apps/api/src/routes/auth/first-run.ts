// First-run gate (ADR-0001).
//
// Two-step flow so password+TOTP enrollment is atomic — never a window
// where password is the only factor.
//
//   GET  /api/auth/first-run/status
//        → { completed: boolean }
//
//   POST /api/auth/first-run/setup
//        body: { email, password, displayName }
//        → 200 { provisioning, totpUri, totpSecretB32 }
//        Server does NOT persist anything yet. `provisioning` is an
//        opaque base64url blob (sealed under MASTER_KEY) that holds the
//        Argon2id hash, the encrypted email + display name + email
//        lookup hash, and the TOTP secret. 5-minute TTL.
//
//   POST /api/auth/first-run/confirm
//        body: { provisioning, totpCode }
//        → 201 + auth cookies
//        Decrypts the provisioning blob, verifies the TOTP code, then
//        inserts users + user_profiles + password_credentials +
//        totp_credentials + flips setup_state in one transaction, and
//        issues a session.
//
// Once setup_state.first_run_completed_at is set, both endpoints 404.

import { encodeBase32UpperCaseNoPadding } from '@oslojs/encoding';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  CryptoOpenError,
  initCrypto,
  open as openSealed,
  seal,
  sealString,
} from '../../auth/crypto-stub';
import { setAuthCookies } from '../../auth/cookies';
import { emitAuthEvent } from '../../auth/events';
import { lookupHashForEmail, normalizeEmail } from '../../auth/identifier';
import { hashPassword } from '../../auth/password';
import { clientIp, userAgent } from '../../auth/request';
import { createSession } from '../../auth/session';
import { generateTotpSecret, totpKeyUri, verifyTotp } from '../../auth/totp';
import { getDb } from '../../db/client';
import {
  passwordCredentials,
  setupState,
  totpCredentials,
  userProfiles,
  users,
} from '../../db/schema';
import { env } from '../../env';

export const firstRunRoute = new Hono();

class ConcurrentFirstRunError extends Error {
  constructor() {
    super('first-run/confirm: concurrent claim race-lost');
    this.name = 'ConcurrentFirstRunError';
  }
}

const PROVISIONING_TTL_MS = 5 * 60 * 1000;
const PROVISIONING_TAG = 'first-run-provisioning:v1';

interface ProvisioningPayload {
  readonly tag: typeof PROVISIONING_TAG;
  readonly expiresAt: number;
  /** Argon2id-encoded password hash (libsodium crypto_pwhash_str). */
  readonly passwordHash: string;
  /** Pre-encrypted email ciphertext (base64). */
  readonly emailCtB64: string;
  /** Pre-encrypted display name ciphertext (base64). */
  readonly nameCtB64: string;
  /** Email lookup hash (base64). */
  readonly emailLookupB64: string;
  /** Raw TOTP secret (base64). Kept inside the sealed blob — not in the response body. */
  readonly totpSecretB64: string;
}

function toB64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
function fromB64(s: string): Uint8Array {
  return Buffer.from(s, 'base64');
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

async function getSetupRow() {
  const db = getDb();
  const rows = await db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
  return rows[0];
}

firstRunRoute.get('/status', async (c) => {
  const row = await getSetupRow();
  return c.json({ completed: !!row?.firstRunCompletedAt });
});

const setupBody = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(12, 'password must be at least 12 characters')
    .max(1024)
    .refine((s) => /[a-z]/.test(s), 'password must contain a lowercase letter')
    .refine((s) => /[A-Z]/.test(s), 'password must contain an uppercase letter')
    .refine((s) => /[0-9]/.test(s), 'password must contain a digit')
    .refine((s) => /[^A-Za-z0-9]/.test(s), 'password must contain a symbol'),
  displayName: z.string().trim().min(1).max(120),
});

firstRunRoute.post('/setup', async (c) => {
  const row = await getSetupRow();
  if (row?.firstRunCompletedAt) {
    return c.json({ error: 'not_found' }, 404);
  }

  const parsed = setupBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.issues.map((i) => i.message) },
      400,
    );
  }

  await initCrypto();
  const normalizedEmail = normalizeEmail(parsed.data.email);
  const [pwResult, lookupHash, totpSecret] = await Promise.all([
    hashPassword(parsed.data.password),
    lookupHashForEmail(normalizedEmail),
    generateTotpSecret(),
  ]);
  const emailCt = sealString(normalizedEmail);
  const nameCt = sealString(parsed.data.displayName);

  const payload: ProvisioningPayload = {
    tag: PROVISIONING_TAG,
    expiresAt: Date.now() + PROVISIONING_TTL_MS,
    passwordHash: pwResult.hash,
    emailCtB64: toB64(emailCt),
    nameCtB64: toB64(nameCt),
    emailLookupB64: toB64(lookupHash),
    totpSecretB64: toB64(totpSecret),
  };
  const sealed = seal(new TextEncoder().encode(JSON.stringify(payload)));
  const provisioning = toB64u(sealed);

  // Plaintext TOTP secret leaves the server EXACTLY here, so the client
  // can render a QR. The corresponding sealed copy inside `provisioning`
  // is what the confirm step trusts; the client cannot tamper with it
  // without breaking the seal MAC.
  const totpUri = totpKeyUri(totpSecret, normalizedEmail, env.WEBAUTHN_RP_NAME);
  const totpSecretB32 = encodeBase32UpperCaseNoPadding(totpSecret);

  return c.json({ provisioning, totpUri, totpSecretB32 });
});

const confirmBody = z.object({
  provisioning: z.string().min(1),
  totpCode: z.string().regex(/^[0-9]{6}$/, 'TOTP code must be 6 digits'),
});

firstRunRoute.post('/confirm', async (c) => {
  const row = await getSetupRow();
  if (row?.firstRunCompletedAt) {
    return c.json({ error: 'not_found' }, 404);
  }

  const parsed = confirmBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_input', issues: parsed.error.issues.map((i) => i.message) },
      400,
    );
  }

  await initCrypto();
  let payload: ProvisioningPayload;
  try {
    const sealed = fromB64u(parsed.data.provisioning);
    const opened = openSealed(sealed);
    const parsedJson = JSON.parse(new TextDecoder().decode(opened)) as unknown;
    if (!isProvisioning(parsedJson)) {
      return c.json({ error: 'invalid_provisioning' }, 400);
    }
    payload = parsedJson;
  } catch (e) {
    // Sealed-blob MAC failure or bad JSON — treat both the same way.
    if (e instanceof CryptoOpenError || e instanceof SyntaxError) {
      return c.json({ error: 'invalid_provisioning' }, 400);
    }
    throw e;
  }
  if (payload.expiresAt < Date.now()) {
    return c.json({ error: 'provisioning_expired' }, 400);
  }

  const totpSecret = fromB64(payload.totpSecretB64);
  const verifyResult = verifyTotp(parsed.data.totpCode, totpSecret, 0);
  if (!verifyResult.ok) {
    return c.json({ error: 'totp_invalid' }, 400);
  }

  const db = getDb();
  // Atomic claim — security-reviewer F2. Insert the user FIRST, then
  // try to flip the singleton with `WHERE first_run_completed_at IS NULL`.
  // If RETURNING comes back empty, a concurrent /confirm beat us; we
  // roll the transaction back and signal "already completed."
  let userId: string;
  try {
    userId = await db.transaction(async (tx) => {
      const inserted = await tx.insert(users).values({}).returning({ id: users.id });
      const userRow = inserted[0];
      if (!userRow) throw new Error('first-run/confirm: users insert returned no row');
      await tx.insert(userProfiles).values({
        userId: userRow.id,
        displayNameCiphertext: fromB64(payload.nameCtB64),
        emailCiphertext: fromB64(payload.emailCtB64),
        emailLookupHash: fromB64(payload.emailLookupB64),
      });
      await tx.insert(passwordCredentials).values({
        userId: userRow.id,
        hash: payload.passwordHash,
      });
      await tx.insert(totpCredentials).values({
        userId: userRow.id,
        secretCiphertext: seal(totpSecret),
        lastUsedStep: verifyResult.step,
      });
      // Atomic singleton claim. The race-loser sees an empty RETURNING
      // and rolls back below.
      const claimed = await tx
        .update(setupState)
        .set({ firstRunCompletedAt: new Date(), firstRunCompletedBy: userRow.id })
        .where(and(eq(setupState.id, 1), isNull(setupState.firstRunCompletedAt)))
        .returning({ id: setupState.id });
      if (claimed.length === 0) {
        // Throw to trigger rollback. The catch below maps it to 404
        // so the response shape matches the closed-gate path.
        throw new ConcurrentFirstRunError();
      }
      return userRow.id;
    });
  } catch (e) {
    if (e instanceof ConcurrentFirstRunError) {
      return c.json({ error: 'not_found' }, 404);
    }
    throw e;
  }

  await emitAuthEvent({
    actorId: userId,
    payload: { kind: 'signup', via: 'first_run' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  await emitAuthEvent({
    actorId: userId,
    payload: { kind: 'totp.enrolled' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  await emitAuthEvent({
    actorId: userId,
    payload: { kind: 'first_run.completed' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  const tokens = await createSession({
    userId,
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  setAuthCookies(c, tokens);
  return c.json({ userId, sessionId: tokens.sessionId }, 201);
});

function isProvisioning(v: unknown): v is ProvisioningPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.tag === PROVISIONING_TAG &&
    typeof o.expiresAt === 'number' &&
    typeof o.passwordHash === 'string' &&
    typeof o.emailCtB64 === 'string' &&
    typeof o.nameCtB64 === 'string' &&
    typeof o.emailLookupB64 === 'string' &&
    typeof o.totpSecretB64 === 'string'
  );
}
