import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WEB_PORT ?? 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Milestone 1.12 Slice 3 — mobile device coverage.
//
// The chromium project keeps the existing desktop specs (smoke,
// auth-setup, offline-sync, print-stylesheet). The two mobile
// projects (iPhone 15 Pro + Pixel 9) run only the specs tagged
// `@mobile` — see `tests/e2e/mobile-*.spec.ts`. The grep filter on
// each mobile project keeps the desktop specs from re-running on
// mobile viewports per ADR-0011 §3.8.
//
// Mobile projects are GATED behind `E2E_INCLUDE_MOBILE=1`. The specs
// were authored in S3 (M1.12) but the first CI run surfaced systemic
// issues — WebKit/iPhone vs. dev-server interaction problems, and
// many specs depend on dev-fixture seeding + production-build SW
// registration that the current dev-server-only CI job cannot provide.
// They are checked in as verification artifacts. A follow-up milestone
// will set up the mobile-CI infrastructure (production-shape preview
// server + Dexie fixture seeder + WebKit baseline) and remove this
// gate. Documented in docs/release-1-mobile-test-gaps.md.
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

const INCLUDE_MOBILE = process.env.E2E_INCLUDE_MOBILE === '1';

const MOBILE_PROJECTS = [
  {
    name: 'mobile-iphone-15-pro',
    use: { ...devices['iPhone 15 Pro'] },
    grep: /@mobile/,
  },
  {
    name: 'mobile-pixel-9',
    use: PIXEL_9_DEVICE,
    grep: /@mobile/,
  },
];

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
    ...(INCLUDE_MOBILE ? MOBILE_PROJECTS : []),
  ],
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
