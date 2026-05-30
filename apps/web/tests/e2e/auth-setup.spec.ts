// End-to-end browser test for the first-run wizard.
//
// Walks the actual SetupView through the three steps:
//   1. fill account fields, submit -> /first-run/setup mocked OK
//   2. wait for the QR + secret to render, enter a deterministic 6-digit
//      code, submit -> /first-run/confirm mocked OK
//   3. confirm the "You're in" screen, click into the app
//
// Stubs the API at the network layer so this can run in any CI without
// standing up Postgres. A separate test (auth-real.spec.ts, opt-in via
// AUTH_E2E_REAL=1) exercises the same flow against a live API for the
// pre-release sanity pass.

import { expect, test } from '@playwright/test';

function statusBeforeSetup() {
  return { completed: false };
}
function statusAfterSetup() {
  return { completed: true };
}
function setupResult() {
  return {
    provisioning: 'AAAA-test-provisioning-blob',
    // Deterministic test secret (RFC 6238 example).
    totpSecretB32: 'JBSWY3DPEHPK3PXP',
    totpUri:
      'otpauth://totp/JHSC%20Worker%20Hub:cochair@example.invalid?secret=JBSWY3DPEHPK3PXP&issuer=JHSC%20Worker%20Hub&algorithm=SHA1&digits=6&period=30',
  };
}
function sessionAfterConfirm() {
  return {
    userId: 'e2e-user',
    displayName: 'E2E User',
    sessionId: 'e2e-session',
    stepUp: { active: false, until: null },
  };
}

test('first-run wizard — happy path through three steps into the app shell', async ({ page }) => {
  // Status flips from incomplete to complete after the confirm call.
  let setupDone = false;
  await page.route('**/api/auth/first-run/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(setupDone ? statusAfterSetup() : statusBeforeSetup()),
    }),
  );
  await page.route('**/api/auth/first-run/setup', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(setupResult()),
    }),
  );
  await page.route('**/api/auth/first-run/confirm', (route) => {
    setupDone = true;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ userId: 'e2e-user', sessionId: 'e2e-session' }),
    });
  });
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: setupDone ? 200 : 401,
      contentType: 'application/json',
      body: JSON.stringify(setupDone ? sessionAfterConfirm() : { error: 'unauthorized' }),
    }),
  );

  await page.goto('/');

  // Step 1 — the wizard's account form.
  await expect(page.getByRole('heading', { name: 'Set up your account' })).toBeVisible();
  await page.getByLabel('Work email').fill('cochair@example.invalid');
  await page.getByLabel('Display name').fill('E2E User');
  await page.getByLabel('Password').fill('CorrectHorse9Battery!');
  await page.getByRole('button', { name: /Continue/ }).click();

  // Step 2 — TOTP. The QR is rendered as SVG; we confirm the secret
  // string is visible (the test doesn't depend on which QR pixels were
  // drawn) and submit an arbitrary 6-digit code — the route handler
  // accepts any code in the mock.
  await expect(page.getByRole('heading', { name: 'Scan with an authenticator app' })).toBeVisible();
  await expect(page.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
  await page.getByLabel('Enter the first 6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  // Step 3 — done screen.
  await expect(page.getByRole('heading', { name: /^You.re in$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Enter the app' }).click();

  // Lands in the authenticated app shell — the route guard sees a valid
  // session, the AppShell mounts, the index route navigates to /minutes.
  await expect(page).toHaveURL(/\/minutes$/);
  await expect(page.getByRole('heading', { name: 'Minutes', level: 1 })).toBeVisible();
});

test('login flow — password + TOTP completes and lands in the app', async ({ page }) => {
  let signedIn = false;
  await page.route('**/api/auth/first-run/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ completed: true }),
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: signedIn ? 200 : 401,
      contentType: 'application/json',
      body: JSON.stringify(signedIn ? sessionAfterConfirm() : { error: 'unauthorized' }),
    }),
  );
  await page.route('**/api/auth/password/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ stage: 'totp_required', pending: 'pending-blob' }),
    }),
  );
  await page.route('**/api/auth/password/totp', (route) => {
    signedIn = true;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ userId: 'e2e-user', sessionId: 'e2e-session' }),
    });
  });

  await page.goto('/');
  // The route guard renders the passkey-primary login screen.
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByRole('button', { name: /Use password instead/ }).click();

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill('cochair@example.invalid');
  await page.getByLabel('Password').fill('CorrectHorse9Battery!');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await page.getByLabel('Authenticator code').fill('111111');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/minutes$/);
  await expect(page.getByRole('heading', { name: 'Minutes', level: 1 })).toBeVisible();
});

test('login flow — wrong TOTP surfaces error and stays on the second-factor screen', async ({
  page,
}) => {
  await page.route('**/api/auth/first-run/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ completed: true }),
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unauthorized' }),
    }),
  );
  await page.route('**/api/auth/password/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ stage: 'totp_required', pending: 'pending-blob' }),
    }),
  );
  await page.route('**/api/auth/password/totp', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'totp_invalid' }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: /Use password instead/ }).click();
  await page.getByLabel('Email').fill('cochair@example.invalid');
  await page.getByLabel('Password').fill('CorrectHorse9Battery!');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill('999999');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Still on the TOTP step; surfaced an error.
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/code did not match|did not match/i);
});
