import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WEB_PORT ?? 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Milestone 1.12 Slice 3 — mobile device coverage.
//
// The chromium project keeps the existing desktop specs (smoke,
// auth-setup, offline-sync, print-stylesheet). The two new mobile
// projects (iPhone 15 Pro + Pixel 9) run only the specs tagged
// `@mobile` — see `tests/e2e/mobile-*.spec.ts`. The grep filter on
// each mobile project keeps the desktop specs from re-running on
// mobile viewports (where they'd flake on layout assumptions baked
// against Desktop Chrome) per ADR-0011 §3.8.
//
// Pixel 9 is not in the Playwright devices catalogue at this
// pnpm-lock version (@playwright/test 1.49.x); we define an explicit
// viewport that matches the public spec sheet (412×915, DPR 2.625,
// Android 14 + Chrome 130 UA).

const PIXEL_9_DEVICE = {
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  defaultBrowserType: 'chromium',
} as const;

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
      // Desktop project skips the @mobile-tagged specs.
      grepInvert: /@mobile/,
    },
    {
      name: 'mobile-iphone-15-pro',
      use: { ...devices['iPhone 15 Pro'] },
      // Mobile projects only run @mobile-tagged describes.
      grep: /@mobile/,
    },
    {
      name: 'mobile-pixel-9',
      use: PIXEL_9_DEVICE,
      grep: /@mobile/,
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
