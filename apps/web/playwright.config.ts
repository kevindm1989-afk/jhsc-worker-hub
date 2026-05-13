import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WEB_PORT ?? 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Single Chromium project at Milestone 1.1. Mobile and WebKit projects
// land in Milestone 1.12 (Release 1 hardening) when device coverage
// matters for shipping.

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
