// Separate Vitest config for the fuzz harness (Milestone 1.12 S2,
// ADR-0011 §3.5).
//
// Kept distinct from the default `vitest.config.ts` so:
//   - `pnpm test` runs the existing unit suite without the fuzz
//     overhead (1000 adversarial cases ~ tens of seconds).
//   - `pnpm test:fuzz` runs the harness explicitly, both locally
//     (`FUZZ_CASES=100` for fast iteration) and in CI.
//
// The default unit config excludes the fuzz directory so a `pnpm test`
// at the workspace root does not implicitly pull in the fuzz suite.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/fuzz/**/*.test.ts'],
    reporters: ['default'],
    // The corpus run has a per-case 30s hard budget (ReDoS guard); the
    // whole-suite hookTimeout / testTimeout are sized generously so
    // slow CI runners do not produce a wrong-reason failure
    // (SECURITY §2.12 T-HD20).
    hookTimeout: 60_000,
    testTimeout: 600_000,
  },
});
