import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment is fine — Node 20+ ships `globalThis.crypto` with
    // the WebCrypto SubtleCrypto API natively, which is what the
    // canonical content_hash helper uses (crypto.subtle.digest). The
    // package itself is browser-only at runtime; the test environment
    // does not have to emulate a DOM because none of the pure helpers
    // touch one. SheetJS + Web Worker shapes that DO touch DOM globals
    // are stubbed in S2 when the worker body lands.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The fuzz harness lives at test/fuzz/ and has its own config
    // (`vitest.fuzz.config.ts`). The default unit suite excludes it so
    // `pnpm test` stays fast for everyday development; CI runs the
    // fuzz suite via the dedicated `test:fuzz` script in its own job.
    exclude: ['node_modules/**', 'test/fuzz/**'],
    reporters: ['default'],
  },
});
