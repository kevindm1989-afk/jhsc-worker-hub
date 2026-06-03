// Milestone 2.2 S3 e2e — action item closure verification flow.
//
// Per the M2.1 PR #31 CI-fix lessons, we:
//   - Build the workplace public key via sodium.crypto_box_keypair()
//     in beforeAll (NEVER 32 all-zero bytes — that's a low-order X25519
//     point and crypto_box_seal throws).
//   - Scope text selectors to role=heading where possible to avoid
//     strict-mode multi-match.
//   - Prefer getByTestId for primary actions.
//
// Flow:
//   1. Auth mocks installed.
//   2. Workplace key endpoint serves a real X25519 public key.
//   3. Action item detail load returns a Pending Review item.
//   4. Rep navigates to /action-items/:id/close-verify.
//   5. The closeVerification POST captures the body — assert the
//      closureReason ciphertext is a non-empty base64 blob (NOT
//      plaintext on the wire) and the selfAttestation flag is true.
//   6. The success heading renders and the chain anchor surfaces.

import sodium from 'libsodium-wrappers';
import { expect, test } from '@playwright/test';
import { installAuthMocks } from './mobile-helpers';

const ITEM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACTOR_ID = 'mobile-e2e-user';

test.describe('@mobile action item closure verification', () => {
  let workplacePublicKeyB64 = '';

  test.beforeAll(async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    workplacePublicKeyB64 = Buffer.from(kp.publicKey).toString('base64');
  });

  test.beforeEach(async ({ page }) => {
    await installAuthMocks(page);
    // The @/excel-imports/crypto workplace-key endpoint shape.
    await page.route('**/api/workplace/public-key', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          publicKeyB64: workplacePublicKeyB64,
          keyId: 'wpk-1',
          activeSince: '2026-01-01T00:00:00Z',
        }),
      }),
    );
    // Action item detail — Pending Review status so the close-verify
    // CTA is eligible.
    await page.route(`**/api/action-items/${ITEM_ID}*`, async (route) => {
      const url = route.request().url();
      if (url.includes('/close-verification') || url.includes('/reopen')) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: ITEM_ID,
          sequenceNumber: 7,
          type: 'INSP',
          typeSubtype: null,
          description: 'Fix anti-slip mat in zone 3',
          recommendedAction: null,
          raisedBy: null,
          raisedByUserId: null,
          followUpOwner: null,
          followUpOwnerUserId: null,
          department: null,
          verifiedByJhscId: null,
          status: 'Pending Review',
          risk: 'High',
          section: 'old_business',
          startDate: '2026-04-01',
          targetDate: null,
          closedDate: null,
          sourceType: null,
          sourceId: null,
          meetingId: null,
          tags: [],
          flag: null,
          allowedTransitions: [],
          history: [],
        }),
      });
    });
  });

  test('closure flow seals reason client-side + records chain anchor', async ({ page }) => {
    let capturedBody: Record<string, unknown> | null = null;
    await page.route(`**/api/action-items/${ITEM_ID}/close-verification`, async (route) => {
      capturedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: ITEM_ID,
          actionItemId: ITEM_ID,
          closureId: 'closure-9',
          status: 'Closed',
          closedAt: '2026-06-03T10:00:00Z',
          counterSignedAt: '2026-06-03T10:00:00Z',
          chainAnchorHash: 'a'.repeat(64),
          attestationSigHash: 'b'.repeat(64),
          selfAttestation: true,
          version: 2,
        }),
      });
    });

    await page.goto(`/action-items/${ITEM_ID}/close-verify`);
    // Use role-scoped heading to avoid the duplicate-text match the
    // M2.1 PR #31 CI noted (success copy may appear inline).
    await expect(page.getByRole('heading', { name: 'Verify closure', level: 1 })).toBeVisible();

    // selfAttestation banner shows because the rep is the lone in-app
    // worker_co_chair (S0 Q2).
    await expect(page.getByTestId('closure-self-attestation-banner')).toBeVisible();

    await page
      .getByTestId('closure-reason-input')
      .fill('Verified by inspection — corrected mat in zone 3.');

    await page.getByTestId('closure-submit-cta').click();

    // The wire body should carry sealed envelope, never plaintext.
    await expect.poll(() => capturedBody !== null).toBeTruthy();
    expect(capturedBody).not.toBeNull();
    const body = capturedBody!;
    expect(body.selfAttestation).toBe(true);
    expect(body.counterSignerActorId).toBe(ACTOR_ID);
    const reason = body.closureReason as { ciphertextB64: string; dekCiphertextB64: string };
    expect(reason.ciphertextB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(reason.ciphertextB64.length).toBeGreaterThan(20);
    expect(reason.dekCiphertextB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Plaintext must never appear on the wire.
    expect(reason.ciphertextB64).not.toContain('Verified');
    expect(reason.ciphertextB64).not.toContain('zone');

    // The success heading renders; the chain anchor surfaces via the
    // closure-success-panel testid.
    await expect(page.getByRole('heading', { name: /closure verified/i })).toBeVisible();
    const panel = page.getByTestId('closure-success-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('a'.repeat(16));
    await expect(panel).toContainText('b'.repeat(16));
  });
});
