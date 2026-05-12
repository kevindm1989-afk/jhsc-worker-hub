import { defineConfig } from 'vitest/config';

// Root-level Vitest covers only files that live outside any workspace
// package — currently `config/` and `scripts/`. Each app and each package
// owns its own vitest config so they can run in isolation in CI.
export default defineConfig({
  test: {
    include: ['config/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
