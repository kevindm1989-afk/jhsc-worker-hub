import { expect, test } from '@playwright/test';

// Single smoke test: boot, redirect, navigate, theme toggle.
// Chromium install is deferred to CI — locally this test will fail with
// a clear "browser not installed" error until the user opts in via
// `pnpm exec playwright install chromium`.

test('app shell smoke — boots, navigates between tabs, toggles theme', async ({ page }) => {
  // AuthRouter (Milestone 1.2) blocks rendering of the shell until it
  // has resolved first-run-status + session. Stub both at the network
  // layer so this smoke test continues to exercise the chrome and not
  // the auth gate.
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
        userId: 'smoke-user',
        displayName: 'Smoke User',
        sessionId: 'smoke-session',
        stepUp: { active: false, until: null },
      }),
    }),
  );

  await page.goto('/');

  // Default redirect lands on /minutes (ARCHITECTURE.md §3).
  await expect(page).toHaveURL(/\/minutes$/);
  await expect(page.getByRole('heading', { name: 'Minutes', level: 1 })).toBeVisible();

  // All five primary tabs are reachable. NavLinks render in both
  // sidebar and bottom tab bar — first() picks whichever is visible.
  for (const label of ['Minutes', 'Hazards', 'Inspections', 'Recommendations', 'More']) {
    await expect(page.getByRole('link', { name: label }).first()).toBeVisible();
  }

  // Tab navigation updates the URL and renders the target view.
  await page.getByRole('link', { name: 'Hazards' }).first().click();
  await expect(page).toHaveURL(/\/hazards$/);
  await expect(page.getByRole('heading', { name: 'Hazards', level: 1 })).toBeVisible();

  // Theme toggle cycles from 'system' (default) to 'light' on first click.
  const toggle = page.getByRole('button', { name: /^Theme:/ });
  await expect(toggle).toHaveAttribute('aria-label', /^Theme: system\./);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', /^Theme: light\./);
});
