import { expect, test } from '@playwright/test';

// Print stylesheet verification — companion to ADR-0011 §3.2.
//
// Walks the canonical print invariants per CLAUDE.md design rules ("Print
// stylesheet for every printable view — evidence-grade output") + the
// SECURITY.md §2.12 T-HD5..T-HD7 threat-model entries:
//
//   - Source Serif 4 applied to body text on print (Inter is UI-only).
//   - App chrome hidden (top bar, bottom tab bar, skip-to-content,
//     FABs, sidebar).
//   - Elements marked `data-print="hide"` are hidden in print mode.
//   - Elements marked `data-print="evidentiary"` are visible in print mode.
//   - T-HD7 negative case: step-up-gated reveal selectors that are
//     hidden on screen remain hidden on print — the print stylesheet
//     never `display: none → display: block`s an encrypted-field
//     placeholder.
//
// Real-printer divergence (T-HD5) is bounded by the post-deploy smoke
// test on the rep's actual printer. This spec runs against Playwright's
// `page.emulateMedia({ media: 'print' })` emulation, which is the
// CI-grade coverage.

test.describe('print stylesheet — evidence-grade output', () => {
  test.beforeEach(async ({ page }) => {
    // Stub auth so the spec exercises the chrome rather than the auth
    // gate — same pattern as smoke.spec.ts.
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
          userId: 'print-user',
          displayName: 'Print User',
          sessionId: 'print-session',
          stepUp: { active: false, until: null },
        }),
      }),
    );
  });

  test('top bar + bottom tab bar are hidden in print emulation', async ({ page }) => {
    await page.goto('/minutes');
    await expect(page.getByRole('heading', { name: 'Minutes', level: 1 })).toBeVisible();

    // Top bar is visible on screen.
    const topBar = page.locator('header.sticky');
    await expect(topBar).toBeVisible();

    // Bottom tab bar is visible on mobile-viewport screen mode; on
    // desktop chromium the `md:hidden` collapses it, so guard the
    // assertion to viewport.
    const bottomTabBar = page.locator('nav[aria-label="Primary"]');

    // Switch to print emulation.
    await page.emulateMedia({ media: 'print' });

    // Under print emulation, both chrome elements collapse to
    // display: none via the @media print rules in index.css. The
    // computed style is the load-bearing assertion.
    await expect(topBar).toHaveCSS('display', 'none');
    if ((await bottomTabBar.count()) > 0) {
      await expect(bottomTabBar.first()).toHaveCSS('display', 'none');
    }
  });

  test('Source Serif 4 is applied to body text under print emulation', async ({ page }) => {
    await page.goto('/minutes');
    await page.emulateMedia({ media: 'print' });

    // The body font-family stack starts with Source Serif 4 under
    // @media print. The computed string may include the Inter fallback
    // if the variable font hasn't loaded — assert by substring match.
    const fontFamily = await page.evaluate(() => {
      return window.getComputedStyle(document.body).fontFamily;
    });
    expect(fontFamily).toContain('Source Serif 4');
  });

  test('data-print=hide elements are hidden under print emulation', async ({ page }) => {
    // The /more view renders a list of secondary-nav items. None of
    // them carry data-print="hide" directly, but the bottom tab bar
    // (data-print covered by nav selector) and the top bar (header.sticky)
    // both must hide. We use a generated probe element on a known view.
    await page.goto('/hazards');

    // Inject a probe so the spec is independent of the page's own
    // data-print markup (which may evolve over time).
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'print-probe-hide';
      probe.setAttribute('data-print', 'hide');
      probe.textContent = 'should be hidden in print';
      document.body.appendChild(probe);
    });

    // On-screen the probe is visible.
    await expect(page.locator('#print-probe-hide')).toBeVisible();

    await page.emulateMedia({ media: 'print' });

    // Under print emulation the probe is hidden.
    await expect(page.locator('#print-probe-hide')).toHaveCSS('display', 'none');
  });

  test('data-print=evidentiary elements remain visible under print emulation', async ({ page }) => {
    await page.goto('/minutes');

    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'print-probe-evidentiary';
      probe.setAttribute('data-print', 'evidentiary');
      probe.textContent = 'should be visible in print';
      document.body.appendChild(probe);
    });

    await page.emulateMedia({ media: 'print' });

    // The print rule sets display: block on evidentiary elements
    // (the rule uses `display: block !important`).
    await expect(page.locator('#print-probe-evidentiary')).toHaveCSS('display', 'block');
  });

  test('M2.1 S5 F-P1 — meeting section accordion bodies expand on print', async ({ page }) => {
    // Inject a fake meeting-detail surface fragment that mirrors the
    // SectionAccordion shape: a parent card with a button toggle and a
    // body wrapper carrying [data-section-accordion-body]. The body is
    // `hidden` on screen (Tailwind's display: none) to mimic the
    // collapsed state. Under print emulation the canonical print rule
    // must force the body open.
    await page.goto('/minutes');

    await page.evaluate(() => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `
        <div data-print="card" id="print-probe-accordion">
          <button type="button" data-section-accordion-toggle aria-expanded="false">
            Section header (collapsed on screen)
          </button>
          <div data-section-accordion-body class="hidden" id="print-probe-accordion-body">
            Section body content that must surface on print.
          </div>
        </div>`;
      document.body.appendChild(wrapper);
    });

    // On screen the body is hidden via the Tailwind `hidden` class.
    await expect(page.locator('#print-probe-accordion-body')).toBeHidden();

    await page.emulateMedia({ media: 'print' });

    // Under print emulation the body must surface (display: block).
    await expect(page.locator('#print-probe-accordion-body')).toHaveCSS('display', 'block');
  });

  test('T-HD7 — step-up-gated selectors do not un-hide on print', async ({ page }) => {
    // The print stylesheet operates on the DOM that's already present.
    // A field that's structurally absent on-screen (the reveal-gated
    // plaintext that the rep has not tapped Reveal for) must remain
    // absent in print emulation. This spec injects a probe that mimics
    // the canonical pattern: a screen-only `display: none` element
    // that contains hypothetical plaintext.
    await page.goto('/hazards');

    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'print-probe-reveal-gated';
      probe.style.display = 'none';
      probe.setAttribute('data-print', 'hide'); // belt-and-suspenders
      probe.textContent = 'should never leak to print';
      document.body.appendChild(probe);
    });

    await page.emulateMedia({ media: 'print' });

    // The probe stays hidden in print.
    await expect(page.locator('#print-probe-reveal-gated')).toHaveCSS('display', 'none');
  });
});
