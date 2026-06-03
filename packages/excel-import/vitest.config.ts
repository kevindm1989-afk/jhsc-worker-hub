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
    reporters: ['default'],
  },
});
