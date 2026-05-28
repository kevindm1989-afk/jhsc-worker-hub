// Access-token JWT (EdDSA over Ed25519) per SECURITY.md §3.
//
// The access token rides in `__Host-access` (HttpOnly, Secure,
// SameSite=Strict, Path=/). 30-minute TTL. Carries `sub` (user id),
// `sid` (session row id), and `step_up_until` (epoch seconds, null
// when no step-up is active).
//
// Signing uses `jose` with `EdDSA` (Ed25519). Keys are PKCS8/SPKI base64
// in env. The verifier accepts the active kid and (optionally) the
// previous kid during rotation grace windows.

import { jwtVerify, SignJWT, importPKCS8, importSPKI, type JWTPayload, type KeyLike } from 'jose';
import { requireAuthEnv } from '../env';

const ACCESS_TTL_SECONDS = 30 * 60;
const ISSUER = 'jhsc-worker-hub';
const AUDIENCE = 'jhsc-worker-hub:web';

export interface AccessClaims {
  /** User id. */
  readonly sub: string;
  /** Session id (sessions.id). */
  readonly sid: string;
  /** UTC epoch seconds. */
  readonly iat: number;
  /** UTC epoch seconds. */
  readonly exp: number;
  /** Step-up window expiry as UTC epoch seconds. null when not active. */
  readonly stepUpUntil: number | null;
}

let cachedPrivate: KeyLike | null = null;
let cachedPublic: KeyLike | null = null;

async function loadKeys(): Promise<{ priv: KeyLike; pub: KeyLike }> {
  if (cachedPrivate && cachedPublic) {
    return { priv: cachedPrivate, pub: cachedPublic };
  }
  const env = requireAuthEnv();
  const privPem = b64DerToPem(env.AUTH_JWT_ED25519_PRIVATE_KEY_B64, 'PRIVATE KEY');
  const pubPem = b64DerToPem(env.AUTH_JWT_ED25519_PUBLIC_KEY_B64, 'PUBLIC KEY');
  cachedPrivate = await importPKCS8(privPem, 'EdDSA');
  cachedPublic = await importSPKI(pubPem, 'EdDSA');
  return { priv: cachedPrivate, pub: cachedPublic };
}

function b64DerToPem(b64: string, label: string): string {
  // Wrap to 64-char lines per RFC 7468.
  const wrapped = b64.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

export interface SignAccessInput {
  readonly sub: string;
  readonly sid: string;
  readonly stepUpUntil: number | null;
}

export async function signAccessToken(input: SignAccessInput): Promise<string> {
  const { priv } = await loadKeys();
  const env = requireAuthEnv();
  const payload: JWTPayload & { sid: string; step_up_until: number | null } = {
    sub: input.sub,
    sid: input.sid,
    step_up_until: input.stepUpUntil,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: env.AUTH_JWT_ACTIVE_KID, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(priv);
}

export async function verifyAccessToken(jwt: string): Promise<AccessClaims | null> {
  try {
    const { pub } = await loadKeys();
    const { payload } = await jwtVerify(jwt, pub, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['EdDSA'],
    });
    const sub = payload.sub;
    const sid = payload['sid'];
    const stepUpUntilRaw = payload['step_up_until'];
    if (typeof sub !== 'string' || typeof sid !== 'string') return null;
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null;
    const stepUpUntil =
      stepUpUntilRaw === null || stepUpUntilRaw === undefined
        ? null
        : typeof stepUpUntilRaw === 'number'
          ? stepUpUntilRaw
          : null;
    return {
      sub,
      sid,
      iat: payload.iat,
      exp: payload.exp,
      stepUpUntil,
    };
  } catch {
    return null;
  }
}

export function _resetKeyCacheForTests(): void {
  cachedPrivate = null;
  cachedPublic = null;
}

export const _internals = { ACCESS_TTL_SECONDS, ISSUER, AUDIENCE };
