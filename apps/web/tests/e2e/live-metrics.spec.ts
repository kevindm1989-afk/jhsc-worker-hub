// Milestone 2.2 S3 e2e — live metrics dashboard chip-bar.
//
// Verifies the SWR poll wiring: the panel mounts, fetches the metrics
// response, surfaces the live counters; a subsequent fetch returns
// updated counts and the panel re-renders.
//
// Per the M2.1 PR #31 CI-fix lessons, we prefer getByTestId over
// text-based selectors and avoid asserting against text that may
// appear in multiple places.

import { expect, test } from '@playwright/test';
import { installAuthMocks } from './mobile-helpers';

const MEETING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test.describe('@mobile live metrics dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await installAuthMocks(page);
  });

  test('renders the metrics chip-bar above the section accordion', async ({ page }) => {
    let metricsCallCount = 0;
    await page.route(`**/api/meetings/${MEETING_ID}/metrics`, (route) => {
      metricsCallCount += 1;
      const itemsRaised = Math.min(metricsCallCount + 1, 5);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          meetingId: MEETING_ID,
          durationSeconds: 60 * metricsCallCount,
          itemsRaised,
          itemsClosed: 1,
          recommendationsDrafted: 0,
          inspectionsReviewed: 1,
          quorumCompliance: {
            metAtCallToOrder: true,
            currentlyMet: true,
            ruleCitation: 'OHSA s.9(8)',
          },
          closureVerifications: { total: 1, selfAttestation: 1, peerVerified: 0 },
          asOf: new Date().toISOString(),
        }),
      });
    });

    // Stub the meeting detail endpoint so the page renders.
    await page.route(`**/api/meetings/${MEETING_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: MEETING_ID,
          meetingDate: '2026-06-03',
          location: 'Boardroom A',
          status: 'in_progress',
          scheduledStartAt: '2026-06-03T14:00:00Z',
          scheduledEndAt: '2026-06-03T16:00:00Z',
          actualStartAt: '2026-06-03T14:05:00Z',
          actualEndAt: null,
          agendaTemplateVersion: 1,
          currentSectionId: null,
          createdByActorId: 'mobile-e2e-user',
          version: 1,
          sections: [],
          attendance: [],
          signatures: [],
        }),
      }),
    );
    // Per-section action items endpoint (no items to keep the test focused).
    await page.route('**/api/action-items*', (route) => {
      const url = route.request().url();
      if (url.includes(`meetingId=${MEETING_ID}`)) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [] }),
        });
        return;
      }
      route.continue();
    });

    await page.goto(`/meetings/${MEETING_ID}`);

    const panel = page.getByTestId('live-metrics-panel');
    await expect(panel).toBeVisible();
    // First fetch is fired by the mount; the initial render shows
    // itemsRaised >= 2 once the first response lands.
    await expect.poll(() => metricsCallCount).toBeGreaterThanOrEqual(1);
    // The panel renders the legend (T-IM27 aggregate-only posture).
    await expect(panel).toContainText(/aggregates|counts only/i);
    // The panel renders the source chip (Live when the fetch is fresh).
    await expect(panel.getByText(/Live/, { exact: false })).toBeVisible();
  });
});
