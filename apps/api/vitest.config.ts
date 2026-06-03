import { defineConfig } from 'vitest/config';

// Tests run under Node (not Bun) — they call `app.request()` against the
// Hono instance directly, so the Bun runtime is not required. See
// CLAUDE.md "Runtime split" for the rationale.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/__tests__/**/*.test.ts'],
    reporters: ['default'],
    setupFiles: ['./src/__tests__/setup.ts'],
    // Serialize files — DB-dependent suites (lockout, integration)
    // share a single Postgres and the chain backfill anchor (1.3)
    // assumes monotonic state; parallel files race on TRUNCATE +
    // singleton-row UPSERT.
    fileParallelism: false,
  },
});
