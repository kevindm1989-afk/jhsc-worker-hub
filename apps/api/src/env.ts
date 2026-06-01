import { z } from 'zod';

// Env vars are read once at module load and validated. Fail fast on a
// misconfigured process — never silently fall back to a default URL or
// hardcoded port. DATABASE_URL is optional at this layer so test runs
// that don't touch the DB stay green; the strict check lives in
// `db/client.ts` and fires the first time a caller asks for a client.
//
// Auth env vars follow the same shape: optional at the schema layer so
// non-auth code paths (workplace, health, tests that mock auth) don't
// have to provide them. The auth modules read them via
// `requireAuthEnv()` below, which fails loud if any required key is
// missing in the current process.

// Base64-only string (RFC 4648 §4) — used for cryptographic key material.
const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be valid base64');

const envSchema = z
  .object({
    DATABASE_URL: z.string().url().optional(),
    WORKPLACE_DISPLAY_NAME: z.string().trim().default(''),
    API_PORT: z.coerce.number().int().positive().default(3001),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Auth (ADR-0001, SECURITY.md §3). The bare AUTH_JWT_ED25519_*_B64
    // pair is the 1.2 legacy form. 1.3 adds AUTH_JWT_ED25519_*_B64_K1
    // through _K4 so the verifier accepts multiple kids during
    // rotation grace windows (ADR-0002 + docs/runbooks/auth.md §3).
    // requireAuthEnv() at first use asserts the active kid resolves to
    // a real keypair.
    MASTER_KEY: b64.optional(),
    AUTH_JWT_ED25519_PRIVATE_KEY_B64: b64.optional(),
    AUTH_JWT_ED25519_PUBLIC_KEY_B64: b64.optional(),
    AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1: b64.optional(),
    AUTH_JWT_ED25519_PUBLIC_KEY_B64_K1: b64.optional(),
    AUTH_JWT_ED25519_PRIVATE_KEY_B64_K2: b64.optional(),
    AUTH_JWT_ED25519_PUBLIC_KEY_B64_K2: b64.optional(),
    AUTH_JWT_ED25519_PRIVATE_KEY_B64_K3: b64.optional(),
    AUTH_JWT_ED25519_PUBLIC_KEY_B64_K3: b64.optional(),
    AUTH_JWT_ED25519_PRIVATE_KEY_B64_K4: b64.optional(),
    AUTH_JWT_ED25519_PUBLIC_KEY_B64_K4: b64.optional(),
    AUTH_JWT_ACTIVE_KID: z.string().trim().default('legacy'),
    WEBAUTHN_RP_ID: z.string().trim().default('localhost'),
    WEBAUTHN_RP_ORIGIN: z.string().url().default('http://localhost:5173'),
    WEBAUTHN_RP_NAME: z.string().trim().default('JHSC Worker Hub'),

    AUTH_LOCKOUT_SHORT_FAILS: z.coerce.number().int().positive().default(5),
    AUTH_LOCKOUT_SHORT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
    AUTH_LOCKOUT_LONG_FAILS: z.coerce.number().int().positive().default(10),
    AUTH_LOCKOUT_LONG_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
    AUTH_LOCKOUT_HARD_FAILS: z.coerce.number().int().positive().default(20),
    AUTH_LOCKOUT_HARD_WINDOW_SECONDS: z.coerce.number().int().positive().default(86400),

    // Tigris (S3-compatible object storage) for evidence files in
    // Milestone 1.7 (ADR-0006). Same optional-at-schema posture as
    // DATABASE_URL: the evidence route asserts at first use via
    // requireTigrisEnv(), so non-evidence code paths and unit tests
    // don't need the bucket configured.
    TIGRIS_BUCKET: z.string().trim().optional(),
    TIGRIS_ENDPOINT: z.string().url().optional(),
    TIGRIS_REGION: z.string().trim().default('auto'),
    TIGRIS_ACCESS_KEY_ID: z.string().trim().optional(),
    TIGRIS_SECRET_ACCESS_KEY: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    // Lockout ladder must be strictly ascending or the floor doesn't make
    // sense: a "hard" tier with fewer failures than the "long" tier would
    // short the long tier into uselessness.
    if (v.AUTH_LOCKOUT_LONG_FAILS <= v.AUTH_LOCKOUT_SHORT_FAILS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AUTH_LOCKOUT_LONG_FAILS must exceed AUTH_LOCKOUT_SHORT_FAILS',
        path: ['AUTH_LOCKOUT_LONG_FAILS'],
      });
    }
    if (v.AUTH_LOCKOUT_HARD_FAILS <= v.AUTH_LOCKOUT_LONG_FAILS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AUTH_LOCKOUT_HARD_FAILS must exceed AUTH_LOCKOUT_LONG_FAILS',
        path: ['AUTH_LOCKOUT_HARD_FAILS'],
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;

export interface AuthEnv {
  readonly MASTER_KEY: string;
  /** Legacy bare-form (1.2). Either this OR a *_K* pair must be set. */
  readonly AUTH_JWT_ED25519_PRIVATE_KEY_B64?: string;
  readonly AUTH_JWT_ED25519_PUBLIC_KEY_B64?: string;
  readonly AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1?: string;
  readonly AUTH_JWT_ED25519_PUBLIC_KEY_B64_K1?: string;
  readonly AUTH_JWT_ED25519_PRIVATE_KEY_B64_K2?: string;
  readonly AUTH_JWT_ED25519_PUBLIC_KEY_B64_K2?: string;
  readonly AUTH_JWT_ED25519_PRIVATE_KEY_B64_K3?: string;
  readonly AUTH_JWT_ED25519_PUBLIC_KEY_B64_K3?: string;
  readonly AUTH_JWT_ED25519_PRIVATE_KEY_B64_K4?: string;
  readonly AUTH_JWT_ED25519_PUBLIC_KEY_B64_K4?: string;
  readonly AUTH_JWT_ACTIVE_KID: string;
  readonly WEBAUTHN_RP_ID: string;
  readonly WEBAUTHN_RP_ORIGIN: string;
  readonly WEBAUTHN_RP_NAME: string;
  readonly AUTH_LOCKOUT_SHORT_FAILS: number;
  readonly AUTH_LOCKOUT_SHORT_WINDOW_SECONDS: number;
  readonly AUTH_LOCKOUT_LONG_FAILS: number;
  readonly AUTH_LOCKOUT_LONG_WINDOW_SECONDS: number;
  readonly AUTH_LOCKOUT_HARD_FAILS: number;
  readonly AUTH_LOCKOUT_HARD_WINDOW_SECONDS: number;
}

// Auth modules call this to assert the secrets are present. Any missing
// value is fatal — we do NOT want auth code silently running with
// derived defaults that mask a misconfigured deploy.
export function requireAuthEnv(): AuthEnv {
  const missing: string[] = [];
  if (!env.MASTER_KEY) missing.push('MASTER_KEY');
  const kids = collectJwtKids();
  if (kids.length === 0) {
    missing.push('AUTH_JWT_ED25519_*_B64 (legacy bare form OR _K1/_K2/_K3/_K4 suffixed)');
  }
  if (missing.length > 0) {
    throw new Error(`Auth env missing required secrets: ${missing.join(', ')}`);
  }
  // Allow falling back to legacy when the active kid isn't resolvable —
  // jwt.ts's signAccessToken degrades to "legacy" issuance in that case
  // so the 1.2 → 1.3 transition stays smooth. Only fail loud if NO kid
  // (including legacy) exists.
  if (!kids.includes(env.AUTH_JWT_ACTIVE_KID) && !kids.includes('legacy')) {
    throw new Error(
      `AUTH_JWT_ACTIVE_KID="${env.AUTH_JWT_ACTIVE_KID}" has no keypair and no legacy fallback (kids configured: [${kids.join(', ')}])`,
    );
  }
  return env as AuthEnv;
}

export interface TigrisEnv {
  readonly TIGRIS_BUCKET: string;
  readonly TIGRIS_ENDPOINT: string;
  readonly TIGRIS_REGION: string;
  readonly TIGRIS_ACCESS_KEY_ID: string;
  readonly TIGRIS_SECRET_ACCESS_KEY: string;
}

/**
 * Evidence routes call this to assert Tigris secrets are present.
 * Same optional-at-schema, required-at-use shape as requireAuthEnv()
 * so non-evidence tests don't have to mock the bucket env.
 */
export function requireTigrisEnv(): TigrisEnv {
  const missing: string[] = [];
  if (!env.TIGRIS_BUCKET) missing.push('TIGRIS_BUCKET');
  if (!env.TIGRIS_ENDPOINT) missing.push('TIGRIS_ENDPOINT');
  if (!env.TIGRIS_ACCESS_KEY_ID) missing.push('TIGRIS_ACCESS_KEY_ID');
  if (!env.TIGRIS_SECRET_ACCESS_KEY) missing.push('TIGRIS_SECRET_ACCESS_KEY');
  if (missing.length > 0) {
    throw new Error(`Tigris env missing required secrets: ${missing.join(', ')}`);
  }
  return env as TigrisEnv;
}

export interface JwtKeyPair {
  readonly kid: string;
  readonly privateKeyB64: string;
  readonly publicKeyB64: string;
}

/**
 * Walks the env for every JWT kid pair (legacy bare form maps to kid
 * "legacy"; the suffixed forms keep their kid). Returns only kids
 * with BOTH halves of the pair present. Used by jwt.ts to build the
 * verifier registry, and by requireAuthEnv() to validate the active
 * kid resolves.
 */
export function loadJwtKeyPairs(): ReadonlyArray<JwtKeyPair> {
  // Read process.env directly so tests + ops scripts that set
  // additional kids after module load see them. The snapshotted `env`
  // covers boot-time required vars; this function covers the dynamic
  // rotation surface.
  const pairs: JwtKeyPair[] = [];
  const e = process.env;
  if (e.AUTH_JWT_ED25519_PRIVATE_KEY_B64 && e.AUTH_JWT_ED25519_PUBLIC_KEY_B64) {
    pairs.push({
      kid: 'legacy',
      privateKeyB64: e.AUTH_JWT_ED25519_PRIVATE_KEY_B64,
      publicKeyB64: e.AUTH_JWT_ED25519_PUBLIC_KEY_B64,
    });
  }
  const slots: ReadonlyArray<[string, string | undefined, string | undefined]> = [
    ['k1', e.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1, e.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K1],
    ['k2', e.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K2, e.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K2],
    ['k3', e.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K3, e.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K3],
    ['k4', e.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K4, e.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K4],
  ];
  for (const [kid, priv, pub] of slots) {
    if (priv && pub) pairs.push({ kid, privateKeyB64: priv, publicKeyB64: pub });
  }
  return pairs;
}

function collectJwtKids(): string[] {
  return loadJwtKeyPairs().map((p) => p.kid);
}
