import { z } from 'zod';

// Minimal env surface for milestone 1.1 — just the port and runtime mode.
// AI_PROXY_SHARED_SECRET and ANTHROPIC_API_KEY land in Release 3
// Milestone 3.2 when the proxy actually proxies.

const envSchema = z.object({
  AI_PROXY_PORT: z.coerce.number().int().positive().default(3002),
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
