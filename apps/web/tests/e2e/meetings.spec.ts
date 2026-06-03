// End-to-end browser test for the meeting lifecycle (Milestone 2.1 S3,
// ADR-0012 §3.4-§3.9).
//
// Stubs the API surface so the spec runs in CI without standing up
// Postgres + the Hono runtime. The shape of the stubbed responses
// mirrors the S2 route handlers exactly (apps/api/src/routes/meetings/
// index.ts) — when those routes evolve, the stubs evolve too.
//
// Covered:
//   - Meetings list (empty state) → create form
//   - Create meeting → redirect to detail
//   - Detail loads sections + (empty) attendance
//   - Add attendee → verify ciphertext on the wire (NOT plaintext)
//   - Append section notes → verify ciphertext on the wire
//   - Adjourn → metrics rendered
//   - Sign worker_co_chair via passkey path → ciphertext name
//   - Record 3 attestations → verify ciphertext for evidence
//   - Finalize → status flips to finalized
//
// The crypto path runs LIVE (libsodium-wrappers in the page). The
// spec asserts the ciphertext PRESENCE (not the inner shape) so a
// future crypto wire-format bump (v=0x03) does not invalidate the
// security contract being tested here: the rep's plaintext name
// never leaves the device.

import { expect, test, type Page, type Route } from '@playwright/test';
import sodium from 'libsodium-wrappers';

const FAKE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deterministic VALID X25519 public key for the fake workplace.
// `crypto_box_seal` calls `crypto_scalarmult` internally and
// REJECTS low-order points (the all-zeros 32-byte key is one); a
// zero key surfaced as a `WorkplaceKeyMissingError` swallow at the
// submit handler and no POST ever reached the route stub. We derive
// a real keypair at spec startup so the seal path can succeed —
// the corresponding private key is discarded (the server-side
// decrypt path is never exercised in this spec).
let FAKE_WORKPLACE_PUBLIC_KEY_B64 = '';

test.beforeAll(async () => {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  FAKE_WORKPLACE_PUBLIC_KEY_B64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
});

interface Stubs {
  meetingDetail: ReturnType<typeof makeMeetingDetail>;
  attendeeCalls: Array<unknown>;
  signatureCalls: Array<unknown>;
  notesCalls: Array<unknown>;
  meetingsCreated: Array<unknown>;
  adjournedAt: string | null;
  signedRoles: Set<string>;
  status: string;
}

function makeMeetingDetail() {
  const meetingId = '11111111-1111-4111-8111-111111111111';
  const sections = Array.from({ length: 10 }, (_, i) => ({
    id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
    sectionType:
      [
        'call_to_order',
        'roll_call_quorum',
        'minutes_review',
        'inspections_review',
        'old_business',
        'new_business',
        'recommendations',
        'other_business',
        'next_meeting',
        'adjournment',
      ][i] ?? 'other_business',
    visibility: 'standard' as const,
    orderIdx: i,
    startedAt: null as string | null,
    endedAt: null as string | null,
    notesEnvelopeCt: null as string | null,
    notesEnvelopeDekCt: null as string | null,
    version: 1,
  }));
  return {
    id: meetingId,
    meetingDate: '2026-06-15',
    location: 'Boardroom',
    status: 'in_progress' as string,
    scheduledStartAt: '2026-06-15T14:00:00Z',
    scheduledEndAt: '2026-06-15T16:00:00Z',
    actualStartAt: '2026-06-15T14:00:00Z',
    actualEndAt: null as string | null,
    agendaTemplateVersion: 1,
    currentSectionId: sections[0]!.id,
    createdByActorId: '33333333-3333-4333-8333-333333333333',
    version: 1,
    sections,
    attendance: [] as Array<unknown>,
    signatures: [] as Array<unknown>,
  };
}

async function setupStubs(page: Page, stubs: Stubs): Promise<void> {
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
        userId: 'e2e-user',
        displayName: 'E2E User',
        sessionId: 'e2e-session',
        stepUp: { active: true, until: new Date(Date.now() + 60_000).toISOString() },
        workplaceKey: {
          id: 'wk-1',
          publicKeyB64: FAKE_WORKPLACE_PUBLIC_KEY_B64,
        },
      }),
    }),
  );

  await page.route('**/api/meetings?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await page.route('**/api/meetings', (route) => handleMeetings(route, stubs));
  await page.route(/\/api\/meetings\/[0-9a-f-]+$/i, (route) => handleMeetingDetail(route, stubs));
  await page.route(/\/api\/meetings\/[0-9a-f-]+\/attendees$/i, (route) =>
    handleAttendees(route, stubs),
  );
  await page.route(/\/api\/meetings\/[0-9a-f-]+\/sections\/[0-9a-f-]+\/notes$/i, (route) =>
    handleNotes(route, stubs),
  );
  await page.route(/\/api\/meetings\/[0-9a-f-]+\/adjourn$/i, (route) =>
    handleAdjourn(route, stubs),
  );
  await page.route(/\/api\/meetings\/[0-9a-f-]+\/signatures$/i, (route) =>
    handleSignature(route, stubs),
  );
  await page.route(/\/api\/meetings\/[0-9a-f-]+\/finalize$/i, (route) =>
    handleFinalize(route, stubs),
  );
}

async function handleMeetings(route: Route, stubs: Stubs): Promise<void> {
  if (route.request().method() === 'POST') {
    const body = JSON.parse(route.request().postData() ?? '{}');
    stubs.meetingsCreated.push(body);
    stubs.meetingDetail.id = body.clientId ?? stubs.meetingDetail.id;
    stubs.meetingDetail.meetingDate = body.meetingDate ?? stubs.meetingDetail.meetingDate;
    stubs.meetingDetail.location = body.location ?? null;
    stubs.meetingDetail.status = 'in_progress';
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: stubs.meetingDetail.id,
        status: 'in_progress',
        version: 1,
        sections: stubs.meetingDetail.sections,
      }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [], nextCursor: null }),
  });
}

async function handleMeetingDetail(route: Route, stubs: Stubs): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ...stubs.meetingDetail, status: stubs.status }),
  });
}

async function handleAttendees(route: Route, stubs: Stubs): Promise<void> {
  const body = JSON.parse(route.request().postData() ?? '{}');
  stubs.attendeeCalls.push(body);
  const attId = '44444444-4444-4444-8444-444444444444';
  const att = {
    id: attId,
    role: body.role,
    party: body.party,
    presentStatus: body.presentStatus ?? 'present',
    displayNameCt: body.displayNameCt,
    displayNameDekCt: body.displayNameDekCt,
    attendeeUserId: null,
    arrivedAt: null,
    departedAt: null,
    version: 1,
  };
  stubs.meetingDetail.attendance.push(att);
  await route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({
      id: attId,
      meetingId: stubs.meetingDetail.id,
      role: body.role,
      party: body.party,
      presentStatus: body.presentStatus ?? 'present',
      version: 1,
      nameHash: 'deadbeef',
    }),
  });
}

async function handleNotes(route: Route, stubs: Stubs): Promise<void> {
  const body = JSON.parse(route.request().postData() ?? '{}');
  stubs.notesCalls.push(body);
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 'sect-1', notesHash: 'feedface' }),
  });
}

async function handleAdjourn(route: Route, stubs: Stubs): Promise<void> {
  stubs.adjournedAt = new Date().toISOString();
  stubs.meetingDetail.actualEndAt = stubs.adjournedAt;
  stubs.status = 'pending_finalization';
  stubs.meetingDetail.status = 'pending_finalization';
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: stubs.meetingDetail.id,
      status: 'pending_finalization',
      adjournedAt: stubs.adjournedAt,
      version: 2,
      metrics: {
        durationSeconds: 3600,
        itemsRaised: 2,
        itemsClosed: 1,
        recommendationsDrafted: 0,
        inspectionsReviewed: 1,
        quorumCompliance: { metAtCallToOrder: true, ruleCitation: 'OHSA s.9(8)' },
      },
    }),
  });
}

async function handleSignature(route: Route, stubs: Stubs): Promise<void> {
  const body = JSON.parse(route.request().postData() ?? '{}');
  stubs.signatureCalls.push(body);
  stubs.signedRoles.add(body.signerRole);
  const sig = {
    id: `sig-${stubs.signedRoles.size}`,
    signerRole: body.signerRole,
    signedMethod: body.signedMethod,
    signedAt: new Date().toISOString(),
    signerDisplayNameCt: body.signerDisplayNameCt,
    signerDisplayNameDekCt: body.signerDisplayNameDekCt,
    signerUserId: body.signedMethod === 'in_app_passkey' ? 'e2e-user' : null,
    evidenceStorageKey: body.evidenceStorageKey ?? null,
    evidenceEnvelopeCt: body.evidenceEnvelopeCt ?? null,
    evidenceEnvelopeDekCt: body.evidenceEnvelopeDekCt ?? null,
    chainOfCustodyNoteCt: body.chainOfCustodyNoteCt ?? null,
    chainOfCustodyNoteDekCt: body.chainOfCustodyNoteDekCt ?? null,
    attestationSignedCt: 'ZmFrZS1hdHRlc3RhdGlvbg==',
    signingKeyId: 'wk-1',
  };
  stubs.meetingDetail.signatures.push(sig);
  await route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({
      id: sig.id,
      meetingId: stubs.meetingDetail.id,
      signerRole: body.signerRole,
      signedMethod: body.signedMethod,
      attestationSigHash: 'cafebabe',
    }),
  });
}

async function handleFinalize(route: Route, stubs: Stubs): Promise<void> {
  if (stubs.signedRoles.size < 4) {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'signatures_incomplete',
        signedCount: stubs.signedRoles.size,
        missingRoles: [
          'worker_co_chair',
          'mgmt_co_chair',
          'mgmt_external_1',
          'mgmt_external_2',
        ].filter((r) => !stubs.signedRoles.has(r)),
      }),
    });
    return;
  }
  stubs.status = 'finalized';
  stubs.meetingDetail.status = 'finalized';
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: stubs.meetingDetail.id,
      status: 'finalized',
      finalizedAt: new Date().toISOString(),
      version: 3,
      signatureIds: Array.from(stubs.signedRoles).map((_, i) => `sig-${i + 1}`),
    }),
  });
}

test.describe('meeting lifecycle — create → attend → note → adjourn → finalize', () => {
  test('full happy path: create, attend, notes, adjourn, sign 4, finalize', async ({ page }) => {
    const stubs: Stubs = {
      meetingDetail: makeMeetingDetail(),
      attendeeCalls: [],
      signatureCalls: [],
      notesCalls: [],
      meetingsCreated: [],
      adjournedAt: null,
      signedRoles: new Set(),
      status: 'in_progress',
    };
    await setupStubs(page, stubs);

    // 1. Land on the minutes list (empty state).
    await page.goto('/minutes');
    await expect(page.getByRole('heading', { name: 'Minutes', level: 1 })).toBeVisible();
    await expect(page.getByText('No meetings yet.')).toBeVisible();

    // 2. Click "Start new meeting" → land on the form.
    await page
      .getByRole('link', { name: /Start new meeting/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/meetings\/new$/);
    await expect(page.getByRole('heading', { name: 'Start new meeting' })).toBeVisible();

    // 3. Fill + submit.
    await page.locator('#meeting-location').fill('Boardroom A');
    await page.getByTestId('new-meeting-submit').click();

    // 4. Lands on detail; verify the create body carried a clientId UUID.
    await page.waitForURL(/\/meetings\/[0-9a-f-]+$/i);
    expect(stubs.meetingsCreated).toHaveLength(1);
    const created = stubs.meetingsCreated[0] as { clientId?: string; meetingDate: string };
    expect(created.clientId).toMatch(FAKE_UUID_RE);
    expect(created.meetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 5. Detail loads. The "Add" attendee button is visible.
    await expect(page.getByRole('button', { name: /^Add$/ })).toBeVisible();

    // 6. Open the attendance sheet + record an attendee.
    await page.getByRole('button', { name: /^Add$/ }).click();
    await expect(page.getByRole('dialog', { name: /Add attendee/ })).toBeVisible();
    await page.getByLabel('Display name').fill('Test Co-Chair');
    await page.getByTestId('attendance-submit').click();
    // T-ML1 mitigation assertion: the wire body carries CIPHERTEXT,
    // never the plaintext name.
    await expect.poll(() => stubs.attendeeCalls.length).toBeGreaterThan(0);
    const att = stubs.attendeeCalls[0] as { displayNameCt: string; displayNameDekCt: string };
    expect(att.displayNameCt).toBeTruthy();
    expect(att.displayNameDekCt).toBeTruthy();
    // Critical: the plaintext NEVER appears in the wire payload.
    const serialised = JSON.stringify(stubs.attendeeCalls);
    expect(serialised).not.toContain('Test Co-Chair');

    // 7. Append section notes on the first section.
    // Reload to surface the attendance row, then open the first section
    // and tap "Add notes".
    await page.reload();
    await page.getByRole('button', { name: /Call to order/i }).click();
    await page.getByRole('button', { name: /Add notes/i }).click();
    await expect(page.getByRole('dialog', { name: /Section notes/ })).toBeVisible();
    await page
      .getByPlaceholder('What was discussed in this section.')
      .fill('Meeting deliberation notes that should never leak in plaintext.');
    await page.getByTestId('section-notes-submit').click();
    await expect.poll(() => stubs.notesCalls.length).toBeGreaterThan(0);
    const notes = stubs.notesCalls[0] as { notesEnvelopeCt: string; notesEnvelopeDekCt: string };
    expect(notes.notesEnvelopeCt).toBeTruthy();
    expect(notes.notesEnvelopeDekCt).toBeTruthy();
    const notesSerialised = JSON.stringify(stubs.notesCalls);
    expect(notesSerialised).not.toContain('Meeting deliberation notes');

    // 8. Adjourn → metrics rendered.
    await page.goto(`/meetings/${stubs.meetingDetail.id}/adjourn`);
    await expect(page.getByRole('heading', { name: /Adjourn meeting/ })).toBeVisible();
    await page.getByTestId('meeting-adjourn-confirm').click();
    await expect(page.getByText('Meeting adjourned')).toBeVisible();
    await expect(page.getByTestId('adjournment-metrics')).toBeVisible();

    // 9. Navigate to the finalization view + sign worker_co_chair.
    await page.getByRole('button', { name: /Record signatures/i }).click();
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+\/finalize$/i);
    await expect(page.getByRole('heading', { name: 'Finalize minutes' })).toBeVisible();

    await page.getByTestId('sign-worker_co_chair-cta').click();
    await page.getByLabel('Your name (as shown in the minutes)').fill('E2E Co-Chair');
    await page.getByTestId('worker-co-chair-sign').click();
    await expect.poll(() => stubs.signedRoles.has('worker_co_chair')).toBe(true);
    const workerSig = stubs.signatureCalls[0] as {
      signedMethod: string;
      signerDisplayNameCt: string;
    };
    expect(workerSig.signedMethod).toBe('in_app_passkey');
    expect(workerSig.signerDisplayNameCt).toBeTruthy();
    expect(JSON.stringify(stubs.signatureCalls)).not.toContain('E2E Co-Chair');

    // 10. Record 3 attestations.
    for (const role of ['mgmt_co_chair', 'mgmt_external_1', 'mgmt_external_2']) {
      await page.getByTestId(`sign-${role}-cta`).click();
      await page.getByLabel('Signer name').fill(`Off-app ${role}`);
      await page
        .getByLabel('Evidence body (encrypted on this device)')
        .fill(`Email body from ${role}`);
      await page.getByLabel('Chain-of-custody note').fill('Received via email 2026-06-15');
      await page.getByTestId(`record-${role}-attestation`).click();
      await expect.poll(() => stubs.signedRoles.has(role)).toBe(true);
    }

    // Ciphertext discipline: no plaintext signer names or chain-of-
    // custody notes anywhere in the recorded request bodies.
    const sigSerialised = JSON.stringify(stubs.signatureCalls);
    expect(sigSerialised).not.toContain('Off-app mgmt_co_chair');
    expect(sigSerialised).not.toContain('Email body from');
    expect(sigSerialised).not.toContain('Received via email');

    // 11. Finalize.
    await page.getByTestId('meeting-finalize-confirm').click();
    await expect.poll(() => stubs.status).toBe('finalized');
  });
});
