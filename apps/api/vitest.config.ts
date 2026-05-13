import { defineConfig } from 'vitest/config';

// Tests run under Node (not Bun) — they call `app.request()` against the
// Hono instance directly, so the Bun runtime is not required. See
// CLAUDE.md "Runtime split" for the rationale.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
});
