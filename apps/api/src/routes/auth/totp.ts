// TOTP reset (1.3 — closes runbook §4 step 3 gap).
//
// POST /api/auth/totp/reset-start
//   Authenticated + step-up required.
//   → 200 { provisioning, totpUri, totpSecretB32 }
//   Server generates a fresh TOTP secret but does NOT persist it yet.
//   The secret rides inside a sealed `provisioning` blob (same shape as
//   first-run) so the confirm step is the one that commits the swap.
//
// POST /api/auth/totp/reset-confirm
//   Authenticated.
//   body: { provisioning, totpCode }
//   → 200 — UPDATE totp_credentials.secret_ciphertext + lastUsedStep=0.
//   Emits `totp.reset` into the chain.
//
// The flow mirrors first-run: the provisioning blob carries the secret
// encrypted under MASTER_KEY, so confirm is the only place that can
// finalize. The reset endpoint requires step-up so an attacker who
// captured an access cookie still needs a fresh passkey or TOTP to
// proceed.

import { encodeBase32UpperCaseNoPadding } from '@oslojs/encoding';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { CryptoOpenError, initCrypto, open as openSealed, seal } from '../../auth/crypto-stub';
import { emitAuthEvent } from '../../auth/events';
import { clientIp, userAgent } from '../../auth/request';
import { authMiddleware, requireStepUp } from '../../auth/step-up';
import { generateTotpSecret, totpKeyUri, verifyTotp } from '../../auth/totp';
import { getDb } from '../../db/client';
import { totpCredentials } from '../../db/schema';
import { env } from '../../env';

export const totpResetRoute = new Hono();

totpResetRoute.use('*', authMiddleware());

const PROVISIONING_TAG = 'totp-reset-provisioning:v1';
const PROVISIONING_TTL_MS = 5 * 60 * 1000;

interface ProvisioningPayload {
  readonly tag: typeof PROVISIONING_TAG;
  readonly userId: string;
  readonly expiresAt: number;
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

totpResetRoute.post('/reset-start', requireStepUp({ action: 'totp.reset' }), async (c) => {
  const auth = c.get('auth');
  await initCrypto();
  const secret = await generateTotpSecret();
  const payload: ProvisioningPayload = {
    tag: PROVISIONING_TAG,
    userId: auth.userId,
    expiresAt: Date.now() + PROVISIONING_TTL_MS,
    totpSecretB64: toB64(secret),
  };
  const sealed = seal(new TextEncoder().encode(JSON.stringify(payload)));
  const provisioning = toB64u(sealed);
  // Plaintext for the QR / manual-enter UI. Server only echoes it
  // here; the sealed copy inside `provisioning` is the trusted form
  // the confirm step decrypts.
  const totpUri = totpKeyUri(secret, auth.userId, env.WEBAUTHN_RP_NAME);
  const totpSecretB32 = encodeBase32UpperCaseNoPadding(secret);
  return c.json({ provisioning, totpUri, totpSecretB32 });
});

const confirmBody = z.object({
  provisioning: z.string().min(1),
  totpCode: z.string().regex(/^[0-9]{6}$/),
});

totpResetRoute.post('/reset-confirm', async (c) => {
  const auth = c.get('auth');
  const parsed = confirmBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_input' }, 400);
  }

  await initCrypto();
  let payload: ProvisioningPayload;
  try {
    const opened = openSealed(fromB64u(parsed.data.provisioning));
    const parsedJson = JSON.parse(new TextDecoder().decode(opened)) as unknown;
    if (!isProvisioning(parsedJson)) {
      return c.json({ error: 'invalid_provisioning' }, 400);
    }
    payload = parsedJson;
  } catch (e) {
    if (e instanceof CryptoOpenError || e instanceof SyntaxError) {
      return c.json({ error: 'invalid_provisioning' }, 400);
    }
    throw e;
  }
  if (payload.userId !== auth.userId) {
    return c.json({ error: 'invalid_provisioning' }, 400);
  }
  if (payload.expiresAt < Date.now()) {
    return c.json({ error: 'provisioning_expired' }, 400);
  }

  const secret = fromB64(payload.totpSecretB64);
  const verifyResult = verifyTotp(parsed.data.totpCode, secret, 0);
  if (!verifyResult.ok) {
    return c.json({ error: 'totp_invalid' }, 400);
  }

  const db = getDb();
  await db
    .update(totpCredentials)
    .set({
      secretCiphertext: seal(secret),
      lastUsedStep: verifyResult.step,
      enrolledAt: new Date(),
    })
    .where(eq(totpCredentials.userId, auth.userId));

  await emitAuthEvent({
    actorId: auth.userId,
    kind: 'totp.reset',
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ ok: true });
});

function isProvisioning(v: unknown): v is ProvisioningPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.tag === PROVISIONING_TAG &&
    typeof o.userId === 'string' &&
    typeof o.expiresAt === 'number' &&
    typeof o.totpSecretB64 === 'string'
  );
}
