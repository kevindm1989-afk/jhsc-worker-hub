// Access-token JWT (EdDSA over Ed25519) per SECURITY.md §3 + ADR-0002.
//
// The access token rides in `__Host-access` (HttpOnly, Secure,
// SameSite=Strict, Path=/). 30-minute TTL. Carries `sub` (user id),
// `sid` (session row id), and `step_up_until` (epoch seconds, null
// when no step-up is active).
//
// Multi-kid registry (security-reviewer F6, closed in 1.3):
// - Issuance reads the keypair for env.AUTH_JWT_ACTIVE_KID.
// - Verification reads the JWT header's `kid` and looks up the
//   matching public key. Unknown kids return null (treated as
//   invalid token).
// - Legacy 1.2 tokens (signed with the bare-form key, kid="legacy"
//   on the header) verify against the legacy public key during the
//   rotation grace window.

import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload, type KeyLike } from 'jose';
import { decodeProtectedHeader } from 'jose';
import { env, loadJwtKeyPairs, requireAuthEnv } from '../env';

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

interface ImportedKey {
  readonly priv: KeyLike;
  readonly pub: KeyLike;
}

// Map<kid, ImportedKey>. Built once at first use, cached for the
// process lifetime. Hot-reload on rotation requires a restart — Fly
// Machine restarts on secrets change.
let cache: Map<string, ImportedKey> | null = null;

async function loadRegistry(): Promise<Map<string, ImportedKey>> {
  if (cache) return cache;
  requireAuthEnv();
  const pairs = loadJwtKeyPairs();
  const map = new Map<string, ImportedKey>();
  for (const p of pairs) {
    const privPem = b64DerToPem(p.privateKeyB64, 'PRIVATE KEY');
    const pubPem = b64DerToPem(p.publicKeyB64, 'PUBLIC KEY');
    const priv = await importPKCS8(privPem, 'EdDSA');
    const pub = await importSPKI(pubPem, 'EdDSA');
    map.set(p.kid, { priv, pub });
  }
  cache = map;
  return cache;
}

function b64DerToPem(b64: string, label: string): string {
  const wrapped = b64.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

export interface SignAccessInput {
  readonly sub: string;
  readonly sid: string;
  readonly stepUpUntil: number | null;
}

export async function signAccessToken(input: SignAccessInput): Promise<string> {
  const registry = await loadRegistry();
  const activeKid = env.AUTH_JWT_ACTIVE_KID;
  // Fall back to "legacy" if the configured active kid does not exist
  // AND only the bare-form key is set — common during the 1.2 → 1.3
  // window where the operator hasn't run the rotation yet.
  const issuerKid = registry.has(activeKid) ? activeKid : 'legacy';
  const key = registry.get(issuerKid);
  if (!key) {
    throw new Error(
      `signAccessToken: AUTH_JWT_ACTIVE_KID="${activeKid}" has no keypair and no legacy fallback`,
    );
  }
  const payload: JWTPayload & { sid: string; step_up_until: number | null } = {
    sub: input.sub,
    sid: input.sid,
    step_up_until: input.stepUpUntil,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: issuerKid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(key.priv);
}

export async function verifyAccessToken(jwt: string): Promise<AccessClaims | null> {
  try {
    const registry = await loadRegistry();
    // Read the kid from the header. A missing kid maps to "legacy".
    const header = decodeProtectedHeader(jwt);
    const kid = typeof header.kid === 'string' ? header.kid : 'legacy';
    const key = registry.get(kid);
    if (!key) return null;
    const { payload } = await jwtVerify(jwt, key.pub, {
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
  cache = null;
}

export const _internals = { ACCESS_TTL_SECONDS, ISSUER, AUDIENCE };
