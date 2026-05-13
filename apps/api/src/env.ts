import { z } from 'zod';

// Env vars are read once at module load and validated. Fail fast on a
// misconfigured process — never silently fall back to a default URL or
// hardcoded port. DATABASE_URL is optional at this layer so test runs
// that don't touch the DB stay green; the strict check lives in
// `db/client.ts` and fires the first time a caller asks for a client.

const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  WORKPLACE_DISPLAY_NAME: z.string().trim().default(''),
  API_PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
