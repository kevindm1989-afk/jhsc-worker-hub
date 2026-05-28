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

    // Auth (ADR-0001, SECURITY.md §3).
    MASTER_KEY: b64.optional(),
    AUTH_JWT_ED25519_PRIVATE_KEY_B64: b64.optional(),
    AUTH_JWT_ED25519_PUBLIC_KEY_B64: b64.optional(),
    AUTH_JWT_ACTIVE_KID: z.string().trim().default('k1'),
    WEBAUTHN_RP_ID: z.string().trim().default('localhost'),
    WEBAUTHN_RP_ORIGIN: z.string().url().default('http://localhost:5173'),
    WEBAUTHN_RP_NAME: z.string().trim().default('JHSC Worker Hub'),

    AUTH_LOCKOUT_SHORT_FAILS: z.coerce.number().int().positive().default(5),
    AUTH_LOCKOUT_SHORT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
    AUTH_LOCKOUT_LONG_FAILS: z.coerce.number().int().positive().default(10),
    AUTH_LOCKOUT_LONG_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
    AUTH_LOCKOUT_HARD_FAILS: z.coerce.number().int().positive().default(20),
    AUTH_LOCKOUT_HARD_WINDOW_SECONDS: z.coerce.number().int().positive().default(86400),
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
  readonly AUTH_JWT_ED25519_PRIVATE_KEY_B64: string;
  readonly AUTH_JWT_ED25519_PUBLIC_KEY_B64: string;
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
  if (!env.AUTH_JWT_ED25519_PRIVATE_KEY_B64) missing.push('AUTH_JWT_ED25519_PRIVATE_KEY_B64');
  if (!env.AUTH_JWT_ED25519_PUBLIC_KEY_B64) missing.push('AUTH_JWT_ED25519_PUBLIC_KEY_B64');
  if (missing.length > 0) {
    throw new Error(`Auth env missing required secrets: ${missing.join(', ')}`);
  }
  return env as AuthEnv;
}
