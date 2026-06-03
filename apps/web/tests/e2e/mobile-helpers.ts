// Shared helpers for the M1.12 S3 mobile Playwright specs.
//
// These specs run on `mobile-iphone-15-pro` + `mobile-pixel-9` only
// (see playwright.config.ts). The helpers are deliberately small —
// they stub the auth + first-run + session endpoints so the spec
// exercises the chrome rather than the auth gate, and provide a
// 44pt-touch-target measurement primitive that both devices share.

import { expect, type Page, type Locator } from '@playwright/test';

/** CSS pixels for the 44pt mobile touch-target minimum (WCAG 2.5.5 +
 *  CLAUDE.md mobile-primary). 44pt @ 1x DPR = 44 CSS pixels. */
export const TOUCH_TARGET_MIN_PX = 44;

/** Install the standard "you are authenticated" + "first-run done"
 *  network mocks. Same shape the existing smoke + print specs use,
 *  duplicated here so the mobile specs are self-contained. */
export async function installAuthMocks(page: Page): Promise<void> {
  await page.route('**/api/auth/first-run/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ completed: true }),
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'mobile-e2e-user',
        displayName: 'Mobile E2E',
        sessionId: 'mobile-e2e-session',
        stepUp: { active: false, until: null },
      }),
    }),
  );
}

/** Assert a locator's bounding box has width and height at least the
 *  44pt mobile touch-target minimum. Skips silently if the element
 *  is detached (boundingBox returns null). */
export async function expectTouchTargetSize(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  expect(box.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
  expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
}

/** The five primary tabs locked at 1.11 close-out (TABS in
 *  apps/web/src/lib/tabs.ts). The bootstrap brief named a different
 *  five-set (Hazards / Action Items / Capture FAB / Inspections /
 *  More); the shipped 1.11 inventory locked Minutes / Hazards /
 *  Inspections / Recommendations / More. We test the shipped lock
 *  and document the brief-divergence in
 *  `docs/release-1-mobile-test-gaps.md`. */
export const EXPECTED_TAB_LABELS = [
  'Minutes',
  'Hazards',
  'Inspections',
  'Recommendations',
  'More',
] as const;
