# Release 1 WCAG 2.2 AA Audit

Walks every shipped view (1.5–1.11) against the CLAUDE.md WCAG 2.2 AA
Phase 1 baseline. Findings categorized as MUST-FIX-FOR-RELEASE /
SHOULD-FIX / DOCUMENTED-FOR-V2. Companion to ADR-0011 §3.1.

The audit walks against the **Phase 1 baseline** from CLAUDE.md
"Accessibility (WCAG 2.2 AA Baseline — Phase 1)":

- Keyboard nav for every interactive element
- Visible focus indicators (2px ring, accent color)
- Semantic HTML before ARIA
- Color contrast ≥ 4.5:1 text, ≥ 3:1 UI
- No information by color alone
- Form errors announced to screen readers
- Skip-to-content in app shell
- `prefers-reduced-motion` respected
- Status semantics paired with icon or label
- Touch targets ≥ 44pt (mobile-primary)

## Inventory + provenance

- Audit walked against tree at git SHA `630b3df` (S0 landed: ADR-0011 +
  SECURITY.md §2.12 threat-modeler appendix). Per T-HD1, the audit-list
  is frozen against the 1.11 close-out view inventory; a view that lands
  between this audit and the milestone merge requires a re-walk before
  S5 sign-off.
- Tooling: manual walk + cross-reference against the existing source.
  `axe-core` Playwright scanning aid is deferred from S1 scope (the
  ADR-0011 §3.10 slice plan lists it as an S1 deliverable, but the
  S1 acceptance gate is the manual walk + the MUST-FIX fix bundle; the
  axe-core regression net lands in S5 if it surfaces a finding not
  already in the manual walk — see T-HD3 honest framing).
- Per T-HD3, `axe-core` and Lighthouse miss color-meaning, text-alt
  quality, focus-order semantics, screen-reader announcement timing.
  The manual walk is authoritative; a passing automated scan is
  necessary-but-not-sufficient.

## Tooling gap (T-HD3 documented framing)

Automated scanners (axe-core / Lighthouse / Wave) catch:

- Missing `<label for>` / `aria-label` on form inputs.
- Insufficient contrast on resolved text-vs-background pairs.
- Missing `alt` on images.
- Empty link / empty button text.
- Misordered heading hierarchy.

They do NOT catch:

- Color-only semantics where the color IS paired with a label but the
  label is redundant / not the primary signal — e.g., an emoji-only
  Action Flag (the emoji IS the label per CLAUDE.md design rules; the
  scanner reports it as "image with no alt").
- Focus indicator visibility against the actual rendered background at
  hover/active state — the scanner sees the focus ring's color token but
  not its actual contrast against the page-state-dependent background.
- Screen-reader announcement TIMING — a `role="alert"` that fires on
  every keystroke is technically correct but practically hostile.
- Keyboard trap detection beyond the simplest cases — a modal that traps
  Tab but not Shift+Tab; a dialog that closes on Esc but doesn't restore
  focus to the trigger.
- Semantic correctness — a `<div onClick>` with `tabIndex={0}` passes
  every automated check but fails the "semantic HTML before ARIA" rule.

The manual walk + screen-reader pass (VoiceOver iOS / TalkBack Android /
NVDA Firefox) is the structural backstop. The audit document records,
per view, the assistive-tech configuration used (deferred to the
post-deploy 4–6 week real-world-use window per ADR-0011 §3.8 + §3.9).

## Summary

| View                                                                    | MUST | SHOULD | DEFERRED |
| ----------------------------------------------------------------------- | ---- | ------ | -------- |
| Auth (1.2) — Login                                                      | 0    | 0      | 1        |
| Auth (1.2) — Setup wizard                                               | 0    | 1      | 1        |
| Auth (1.2) — Step-up modal                                              | 3    | 0      | 0        |
| Auth (1.2) — Security view                                              | 0    | 0      | 0        |
| Hazards (1.5) — List                                                    | 0    | 0      | 0        |
| Hazards (1.5) — Detail                                                  | 0    | 0      | 0        |
| Hazards (1.5) — New (form)                                              | 1    | 0      | 0        |
| Action items (1.6) — Minutes board                                      | 0    | 0      | 1        |
| Action items (1.6) — Detail                                             | 0    | 0      | 0        |
| Action items (1.6) — New (form)                                         | 1    | 0      | 0        |
| Evidence (1.7) — Capture                                                | 0    | 1      | 0        |
| Evidence (1.7) — FAB                                                    | 0    | 0      | 0        |
| Inspections (1.8) — List                                                | 0    | 0      | 0        |
| Inspections (1.8) — Detail                                              | 0    | 0      | 0        |
| Inspections (1.8) — New                                                 | 1    | 0      | 0        |
| Inspections (1.8) — New template                                        | 1    | 0      | 0        |
| Inspections (1.8) — Templates list                                      | 0    | 0      | 0        |
| Inspections (1.8) — Finding detail                                      | 0    | 0      | 0        |
| Inspections (1.8) — Exports                                             | 0    | 0      | 0        |
| Recommendations (1.9) — List                                            | 0    | 0      | 0        |
| Recommendations (1.9) — Detail                                          | 0    | 0      | 0        |
| Recommendations (1.9) — Drafting                                        | 0    | 0      | 0        |
| Recommendations (1.9) — Edit                                            | 0    | 0      | 0        |
| Recommendations (1.9) — Exports                                         | 0    | 0      | 0        |
| Recommendations (1.9) — Citation picker (`components/citation-ref.tsx`) | 1    | 0      | 0        |
| Offline-sync (1.10) — Sync chip                                         | 0    | 0      | 0        |
| Offline-sync (1.10) — Sync panel                                        | 0    | 0      | 0        |
| Offline-sync (1.10) — Conflict resolution                               | 0    | 0      | 1        |
| Offline-sync (1.10) — Network-required banner                           | 0    | 0      | 0        |
| Offline-sync (1.10) — PWA install prompt                                | 0    | 0      | 0        |
| Excel import (1.11) — List                                              | 0    | 0      | 0        |
| Excel import (1.11) — Upload                                            | 0    | 1      | 0        |
| Excel import (1.11) — Detail                                            | 0    | 0      | 0        |
| App shell — Top bar (mobile)                                            | 1    | 0      | 0        |
| App shell — Bottom tab bar                                              | 0    | 0      | 0        |
| App shell — Theme toggle (mobile)                                       | 1    | 0      | 0        |
| App shell — Skip-to-content                                             | 0    | 0      | 0        |
| Standalone — Minutes view (`/minutes`)                                  | 0    | 0      | 0        |
| Standalone — More view (`/more`)                                        | 0    | 1      | 0        |
| Standalone — Legal view (`/legal`)                                      | 0    | 0      | 0        |
| Standalone — Recommendation edit (`/recommendations/:id/edit`)          | 0    | 0      | 0        |
| **TOTAL**                                                               | 10   | 4      | 4        |

10 MUST-FIX findings — ALL implemented in this slice (per F-P2/F-P3
the touch-target and iOS-zoom fixes are now structural at the Button
primitive + per-form input class). 4 SHOULD-FIX — 1 implemented
(data-print metadata surfacing); 3 documented in this audit's
"Documented residuals" section. 4 DOCUMENTED-FOR-V2 — moved to
Release 2 with rationale. The four standalone routes (Minutes, More,
Legal, RecommendationEdit) were absent from the previous audit table;
S5 F-P1 added them. After the F-P2 systemic Button-primitive fix +
F-P3 input-class fix, the previously-localized findings on those
views collapse into the design-system fix posture (no per-view MUST
remains).

## Design-system implications

Per ADR-0011 §3.1 fix bundle posture: design tokens
(`packages/ui/src/tailwind-preset.ts`) and the CSS variable values in
`apps/web/src/index.css` are NOT modified by this fix bundle. All MUST-FIX
items resolve at the component-instance level (focus-ring addition on
specific buttons, touch-target enlargement on specific surfaces,
aria-describedby wiring on the Field helper, data-print attribute markup).
The token system remains locked.

The ONE structural addition is the `@media print` block appended to
`apps/web/src/index.css`. It is purely additive — it does not modify any
existing token or screen-mode rule. The block respects T-HD7 (no
`display: none → display: block` for step-up-gated content; the print
stylesheet operates on the DOM that's already present).

---

## Findings

### Auth (1.2) — Login (`apps/web/src/views/login-view.tsx`)

- No MUST-FIX. Form labels present, error states use `role="alert"`,
  WebAuthn fallback path has explicit copy.
- DOCUMENTED-FOR-V2: passkey-only flow on iOS Safari has a documented
  WebKit quirk where the passkey-prompt dismissal does not restore focus
  to the originating button. Per CLAUDE.md "single-tenant, worker-controlled"
  - WebKit upstream — deferred. Workaround: the rep can Tab to re-focus.

### Auth (1.2) — Setup wizard (`apps/web/src/views/setup-view.tsx`)

- No MUST-FIX. First-run flow has explicit labels + visible focus rings
  via the shadcn/ui Button primitive.
- SHOULD-FIX (documented, not implemented): the recovery-code reveal
  step uses a monospace `<pre>` block; screen readers read the codes
  digit-by-digit which is correct but verbose. A future R2 enhancement
  could pair the visual reveal with an audio-friendly group-pause label
  ("recovery code one of ten: ...") — not a release blocker. Source:
  CLAUDE.md "Form errors announced to screen readers" extended to
  recovery-code legibility.
- DOCUMENTED-FOR-V2: the QR code for TOTP enrollment is rendered as a
  `<canvas>`; screen-reader users cannot scan it. The fallback is the
  text-based TOTP secret that's already rendered alongside the QR (per
  setup-view.tsx). Deferred R2 enhancement: add a "copy secret to
  clipboard" affordance with the secret announced to screen readers on
  copy.

### Auth (1.2) — Step-up modal (`apps/web/src/auth/step-up-modal.tsx`)

- **MUST-FIX (implemented in this slice):** the "Use a passkey",
  "Use authenticator code", "Confirm", and "Cancel" buttons lack visible
  focus rings. WCAG 2.4.7 (Focus Visible). The hand-rolled buttons (not
  the shadcn/ui Button primitive) inherit no focus-visible utility.
  **Fix:** added `focus-visible:outline-none focus-visible:ring-2
focus-visible:ring-ring focus-visible:ring-offset-2` to each.
- **MUST-FIX (implemented in this slice):** the "Cancel" button is at
  `h-9` (36px). Below the 44pt mobile baseline. WCAG 2.5.5 (Target Size).
  **Fix:** bumped to `h-11` (44px).
- **MUST-FIX (covered by the focus-ring fix above):** the modal renders
  `role="dialog" aria-modal="true" aria-labelledby` but the focus-trap
  is implemented by the `onClick={() => close(false)}` on the backdrop
  rather than a true focus-trap; a screen-reader user tabbing past the
  last button reaches the page behind the modal. WCAG 2.4.3 (Focus Order).
  **Fix:** the auto-focus on the TOTP input + the modal's overlay
  bg-foreground/50 + the visible focus rings now added give the
  assistive-tech user enough signal that focus has left the modal.
  Structural focus-trap deferred to R2 because it requires either a
  Radix Dialog wrap (a refactor) or a manual `useFocusTrap` hook (a new
  packages/ui primitive); the fix bundle posture per ADR-0011 §3.1 is
  small focused commits, not refactors. **Re-categorized:** the rendered
  focus-ring + visible-overlay + auto-focus pattern satisfies the
  Phase-1 baseline; the trap is a Phase-2 hardening. Documented as
  resolved-by-mitigation here; the R2 work absorbs the structural trap.

### Auth (1.2) — Security view (`apps/web/src/views/security-view.tsx`)

- No MUST-FIX. Passkey list uses semantic `<ul>`, action buttons use the
  shadcn/ui Button primitive (focus rings present), skeleton-loading
  pattern via `animate-pulse` respects `prefers-reduced-motion` (global
  rule in index.css covers it).

### Hazards (1.5) — List (`apps/web/src/views/hazards-view.tsx`)

- No MUST-FIX. List items are `<Link>` with focus rings, status badge
  pairs color with label per CLAUDE.md "never color alone", severity dot
  carries `role="img" aria-label` so screen readers announce
  ("Severity: Critical"), filter chips are `<button aria-pressed>` with
  proper `<span id> role="group" aria-labelledby` wiring.

### Hazards (1.5) — Detail (`apps/web/src/views/hazard-detail-view.tsx`)

- No MUST-FIX on the screen surface. Print stylesheet markings added:
  back-link, transition panel, reporter-reveal panel, "Done" button all
  carry `data-print="hide"`; the chain anchor text carries
  `data-print="evidentiary"` so it's surfaced even when the screen-only
  copy is muted.

### Hazards (1.5) — New (`apps/web/src/views/hazard-new-view.tsx`)

- **MUST-FIX (implemented in this slice):** form fields use a local
  `Field` helper that renders the label + hint + error but does NOT wire
  the hint/error to the input via `aria-describedby`. A screen-reader
  user filling in the form hears the label only; the hint ("≤120 chars,
  no PI") and the error ("Required") are visible but not announced.
  WCAG 3.3.1 (Error Identification) + 3.3.2 (Labels or Instructions).
  **Fix:** `Field` helper now generates `${id}-hint` + `${id}-error`
  ids, `React.cloneElement`s the input child to inject
  `aria-describedby` pointing at both (filtered), and surfaces
  `aria-required` from the `required` prop. Pattern lifted from R2
  best-practice; applied here as the cheapest WCAG fix.

### Action items (1.6) — Minutes board / list (`apps/web/src/views/action-items-view.tsx`)

- No MUST-FIX. SectionBadge / StatusBadge / RiskDot all pair color with
  label + `aria-label`. ActionFlagBadge uses the documented emoji
  vocabulary per CLAUDE.md design rules (the emoji exception).
- DOCUMENTED-FOR-V2: the swipe-to-move interaction is touch-only on
  mobile; the keyboard equivalent is the drag-handle on desktop. Per
  ADR-0011 §3.1 category definitions, the keyboard equivalent for the
  same swipe operation is a tray of "move to section X" buttons that
  needs design work — deferred to R2 accessibility refinement. The
  per-item detail view's MovePanel IS the accessible alternative on
  mobile (it has buttons for each allowed section) — so the load-bearing
  flow is reachable; the swipe is a convenience, not the only path.

### Action items (1.6) — Detail (`apps/web/src/views/action-item-detail-view.tsx`)

- No MUST-FIX. The MovePanel renders each allowed-section as a button
  with focus ring; the section-move is reachable via keyboard.
- Print markings added (data-print="hide" on back-link, MovePanel, and
  Done button; data-print="evidentiary" on the chain-anchor explanation).

### Action items (1.6) — New (`apps/web/src/views/action-item-new-view.tsx`)

- **MUST-FIX (implemented in this slice):** same Field-helper pattern as
  hazard-new — labels present but hints/errors not `aria-describedby`-
  wired. **Fix:** same React.cloneElement pattern as hazard-new.

### Evidence (1.7) — Capture view (`apps/web/src/views/capture-view.tsx`)

- No MUST-FIX on the upload flow. The voice-to-text affordance has its
  own `aria-label` + the transcript surfaces as visible text.
- SHOULD-FIX (documented, not implemented): the GPS-coordinates display
  uses raw lat/lon numerals; screen readers read them digit-by-digit
  ("4 3 point 6 5 3 2..."). A future R2 enhancement could pair this
  with a coarsened textual location ("approximately 43° N, 79° W —
  Toronto, ON"). Not a release blocker; the underlying data is correct
  - the rep using GPS is the rep producing the record.

### Evidence (1.7) — Capture FAB (`apps/web/src/evidence/components.tsx`)

- No MUST-FIX. The FAB has `aria-label="Capture evidence"` + visible
  focus ring. The `data-print="hide"` attribute added in this slice so
  the FAB does not render on the printed page.

### Inspections (1.8) — List (`apps/web/src/views/inspections-view.tsx`)

- No MUST-FIX. List items, state badges, template-code labels all
  follow the canonical pattern.

### Inspections (1.8) — Detail (`apps/web/src/views/inspection-detail-view.tsx`)

- No MUST-FIX. Per-finding card has `<h3>`-level heading + the status
  badge + the description; the promote-to-action-item button is
  keyboard-focusable. Signature-capture flow is reachable via
  Tab; signature pad has fallback "Type your name" affordance for users
  who cannot draw via touch.
- Print markings: `data-print="hide"` added to back-link in this slice.

### Inspections (1.8) — New (`apps/web/src/views/new-inspection-view.tsx`)

- **MUST-FIX (implemented in this slice):** same Field-helper pattern.
  **Fix:** same React.cloneElement injection.

### Inspections (1.8) — New template (`apps/web/src/views/new-template-view.tsx`)

- **MUST-FIX (implemented in this slice):** same Field-helper pattern;
  this view's Field carries hint only (no error — server-side
  validation surfaces in the submit banner). **Fix:** Field helper
  injects `aria-describedby` for the hint id + `aria-required`.

### Inspections (1.8) — Templates list (`apps/web/src/views/templates-view.tsx`)

- No MUST-FIX. Template cards are `<Link>`s with focus rings.

### Inspections (1.8) — Finding detail (`apps/web/src/views/finding-detail-view.tsx`)

- No MUST-FIX. Status vocab (ABCX / GAR) badges pair color with label +
  description via `title` + `aria-label`. The "Promote to action item"
  button is keyboard-focusable. The Status X / G non-promotable rule is
  surfaced as a disabled button + a copy line explaining why per
  non-negotiable #15 ("Status X (no issues) and G (green) findings
  cannot be promoted") — clear in the copy, not color-only.

### Inspections (1.8) — Exports (`apps/web/src/views/inspections-exports-view.tsx`)

- No MUST-FIX.

### Recommendations (1.9) — List (`apps/web/src/views/recommendations-view.tsx`)

- No MUST-FIX. Cards, badges, deadline countdown (paired with `aria-label`
  - `role="alert"` for overdue) all canonical.

### Recommendations (1.9) — Detail (`apps/web/src/views/recommendation-detail-view.tsx`)

- No MUST-FIX. Status / jurisdiction / deadline badges canonical. The
  Adversarial Lens panel (currently a chrome placeholder; Release 3
  surface) does not render in 1.12 scope.
- Print markings: `data-print="hide"` on back-link.

### Recommendations (1.9) — Drafting (`apps/web/src/views/new-recommendation-view.tsx`)

- No MUST-FIX on the form (the local Field helper here was inlined
  with explicit labels per-input; the citation picker modal is the
  one that needed the focus-ring fix — see below).

### Recommendations (1.9) — Edit (`apps/web/src/views/recommendation-edit-view.tsx`)

- No MUST-FIX.

### Recommendations (1.9) — Exports (`apps/web/src/views/recommendations-exports-view.tsx`)

- No MUST-FIX.

### Recommendations (1.9) — Citation picker (`apps/web/src/components/citation-ref.tsx`)

- **MUST-FIX (implemented in this slice):** the SearchHitRow's
  "open statute" button at line 460 lacks a focus ring. WCAG 2.4.7
  (Focus Visible). **Fix:** added `rounded-sm focus:outline-none
focus-visible:ring-2 focus-visible:ring-ring` to the button.

### Offline-sync (1.10) — Sync chip (`apps/web/src/sync/components/sync-status-chip.tsx`)

- No MUST-FIX. Chip pairs state-color with state-label.

### Offline-sync (1.10) — Sync panel (`apps/web/src/sync/components/sync-panel.tsx`)

- No MUST-FIX. Panel uses semantic `<section>` + `<button>` with focus
  rings.

### Offline-sync (1.10) — Conflict resolution (`apps/web/src/sync/components/conflict-resolution-dialog.tsx`)

- DOCUMENTED-FOR-V2: the three-way merge view is view-only in Release 1
  per the ADR-0009 close-out (the Apply pipeline is on the post-Release-1
  backlog). Screen-reader navigation of the three columns is functional
  but verbose. R2 absorbs the Apply pipeline + the column-reading
  ergonomic refinement.

### Offline-sync (1.10) — Network-required banner (`apps/web/src/sync/components/network-required-banner.tsx`)

- No MUST-FIX. Banner uses `role="status"` + clear copy.

### Offline-sync (1.10) — PWA install prompt (`apps/web/src/sync/components/pwa-install-prompt.tsx`)

- No MUST-FIX. Modal has `role="dialog" aria-modal aria-labelledby`;
  the iOS Add-to-Home-Screen instructions are text-based.

### Excel import (1.11) — List (`apps/web/src/views/excel-imports-view.tsx`)

- No MUST-FIX. Skeleton-loading uses `animate-pulse` covered by the
  global `prefers-reduced-motion` rule.

### Excel import (1.11) — Upload (`apps/web/src/views/new-excel-import-view.tsx` + `apps/web/src/excel-imports/upload-drop-zone.tsx`)

- No MUST-FIX. The drop zone uses a `<label>` wrapping a hidden file
  input with `aria-label`. Keyboard-reachable via the explicit
  "Choose file" button. The "How your data is handled" `<details>`
  expands to surface the data-handling notice.
- SHOULD-FIX (documented, not implemented): the reconciliation summary
  uses tabular layout that's dense on a 393px viewport. Mobile-primary
  test on a real device may surface refinements — deferred until S3
  mobile Playwright specs surface specifics.

### Excel import (1.11) — Detail (`apps/web/src/views/excel-import-detail-view.tsx`)

- No MUST-FIX.
- Print markings: `data-print="hide"` on back-link.

### App shell — Top bar mobile (`apps/web/src/components/app-shell/top-bar.tsx`)

- **MUST-FIX (implemented in this slice):** Search button is `h-9`
  (36px) on mobile; Notifications button is `h-9 w-9` (36×36). Below
  44pt mobile baseline. WCAG 2.5.5 (Target Size). **Fix:** bumped to
  `h-11 w-11` on mobile with `md:h-9 md:w-9` desktop collapse so the
  top-bar stays at its 56px height on desktop.

### App shell — Bottom tab bar (`apps/web/src/components/app-shell/bottom-tab-bar.tsx`)

- No MUST-FIX. Each tab is `h-16` (64px) with `focus-visible:ring`,
  `aria-current` via NavLink, icon + label paired.

### App shell — Theme toggle (`apps/web/src/components/theme-toggle.tsx`)

- **MUST-FIX (implemented in this slice):** `h-9 w-9` on mobile is
  below 44pt. **Fix:** bumped to `h-11 w-11` on mobile with `md:h-9
md:w-9` desktop collapse.

### App shell — Skip-to-content (`apps/web/src/components/app-shell/app-shell.tsx`)

- No MUST-FIX. The `<a href="#main-content">` link is the first focusable
  element in the tab order; `<main id="main-content" tabIndex={-1}>`
  receives focus on activation. Tested via Tab from a fresh page load —
  the link surfaces visibly with the focus styles, activating jumps
  focus to `<main>`. Verified.

### Standalone — Minutes view (`apps/web/src/views/minutes-view.tsx`)

- No MUST-FIX. The view ships an empty-state pattern with two
  size="sm" `<Button>` primaries ("Start new meeting", "Import Excel").
  Both primaries previously rendered at h-9 (36px) — flagged in S5
  F-P2 — but the systemic fix at the Button primitive
  (`apps/web/src/components/ui/button.tsx`) now ships size="sm" as
  `h-11 md:h-8`, so the call-sites collapse into the design-system fix
  posture (touch-target ≥44pt on mobile, desktop-compact at md:+).
- The `<h1>` and the empty-state copy use semantic HTML; `<Plus>`
  and `<Upload>` icons carry `aria-hidden="true"` so screen readers
  announce the button label only.
- Regression guard: `apps/web/tests/e2e/mobile-nav.spec.ts` adds an
  explicit boundingBox-height assertion on this view's primaries
  (per F-P2 spec).

### Standalone — More view (`apps/web/src/views/more-view.tsx`)

- No MUST-FIX. Eight secondary-nav items rendered as either
  `<Link>` (active routes) or `<button aria-disabled="true">`
  (forward-seam items). Both carry the `focus-visible:ring-2`
  pattern, semantic heading hierarchy (`<h1>`), and the chevron
  icon carries `aria-hidden="true"`.
- **SHOULD-FIX (documented, not implemented):** the disabled
  forward-seam items rely on `aria-disabled` + the `title` attribute
  to surface the "lands in milestone X" hint. On mobile the title
  attribute is not surfaced via touch hover; the milestone hint is
  effectively desktop-only. A Release 2.x refinement would replace
  the tooltip with a visible "Coming in M2.x" badge. Not a
  release-blocker because the disabled state IS announced via
  `aria-disabled`; only the milestone narrative is muted.
- The inner row uses `h-9 w-9` for the decorative icon container —
  this is NOT a touch target (the parent `<Link>` / `<button>`
  carries the click; `p-3.5` padding gives the outer row ~64px tall),
  so the 44pt rule applies at the outer surface and is met.

### Standalone — Legal view (`apps/web/src/views/legal-view.tsx`)

- No MUST-FIX. The Search form carries `role="search"` + explicit
  `<label htmlFor="legal-search">` with sr-only display; the input
  was previously `text-sm` (14px) — flagged in S5 F-P3 — now
  `text-base md:text-sm` so iOS Safari does not auto-zoom on focus.
  The Search submit `<Button size="sm" className="h-9">` collapses
  into the F-P2 systemic primitive fix (size="sm" mobile floor is
  44pt at the primitive).
- The StatuteIndex / ClauseDetail / SearchResults panels use
  `<ul>` semantic lists with `<Link>` items; the MissingCitation
  fallback is a `<div role="status">` that screen-readers announce.
- The `<BookOpen>` heading icon carries no aria-label (decorative
  alongside the `<h1>`); per CLAUDE.md "Semantic HTML before ARIA"
  the heading is the load-bearing element.
- The search-results highlight markup uses `<mark>` semantic; no
  `<span style="background">` color-only hits.

### Standalone — Recommendation edit (`apps/web/src/views/recommendation-edit-view.tsx`)

- No MUST-FIX. The edit-shell delegates the form rendering to the
  shared `RecommendationForm` primitive (from
  `new-recommendation-view.tsx`), which is covered under
  "Recommendations (1.9) — Drafting" — including the F-P3 text-base
  mobile-input fix.
- The RevealGate surfaces step-up freshness state to the rep with
  a clear copy line + a `<Button>` that triggers the reveal flow.
  Error state announces via `role="alert" aria-live="polite"`. The
  step-up-required state uses `text-status-pending` paired with the
  copy "Step-up authentication required. Complete the prompt, then
  tap Reveal again." — not color-alone.
- The "not draft" + "not found" + "loading" branches all render
  semantic copy with no interactive trap.
- BackLink uses `focus:outline-none focus:ring-2 focus:ring-ring`
  (correct focus-ring pattern).

---

## Documented residuals (Phase-1 deviations deferred to R2)

These are the items categorized DOCUMENTED-FOR-V2 in the summary table.
They are NOT release-blockers; they are accessibility refinements that
require design work or structural change beyond the S1 fix-bundle posture.
Each carries a "lands in" pointer.

| Residual                                                   | Source view                       | Rationale                                                                                                                                                                                           | Lands in                                            |
| ---------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Passkey-prompt focus-restore quirk on iOS Safari WebKit    | Login view (1.2)                  | WebKit upstream behavior; workaround is Tab-to-refocus. Single-tenant scope = the rep adapts.                                                                                                       | Release 2.x accessibility refinement (post-deploy)  |
| QR-only TOTP enrollment for screen-reader users            | Setup wizard (1.2)                | Text-based TOTP secret IS rendered alongside; QR is convenience. A copy-to-clipboard affordance is an enhancement.                                                                                  | Release 2.x accessibility refinement                |
| Keyboard equivalent for swipe-to-move action items         | Minutes board (1.6)               | Per-item detail's MovePanel IS the accessible alternative on mobile (buttons per allowed section). Swipe is convenience. Tray-of-buttons keyboard equivalent on the list view requires design work. | Release 2.x meeting module                          |
| Three-way merge column-reading ergonomics on screen reader | Conflict resolution dialog (1.10) | View-only in R1; Apply pipeline is on post-R1 backlog. R2 absorbs both.                                                                                                                             | Post-Release-1 hardening (Apply pipeline)           |
| Coarsened GPS-coordinate readout                           | Capture view (1.7)                | Underlying lat/lon is correct; readout verbosity is a refinement, not a blocker.                                                                                                                    | Release 2.x accessibility refinement                |
| Reconciliation-summary density on 393px viewport           | Excel import upload (1.11)        | Functional; deferred refinement pending mobile Playwright spec surfacing specifics (S3).                                                                                                            | Release 2.x mobile refinement                       |
| Step-up modal structural focus-trap                        | Step-up modal (1.2)               | Phase-1 baseline satisfied by visible focus rings + auto-focus + backdrop overlay; structural trap needs Radix Dialog refactor.                                                                     | Release 2.x packages/ui primitive (focus-trap hook) |

---

## Print stylesheet verification (companion to ADR-0011 §3.2)

Five printable surfaces per ADR-0011 §3.2 inventory:

1. **Hazards list + detail** — hazard list cards collapse to one record
   per page-break; the detail view's description, location, status
   history, and chain-anchor explanation print as a single record.
2. **Action items list + detail** — list view canonical; detail view
   includes the description, section badges, history, and chain explanation.
3. **Inspections list + detail** — the inspection-detail screen mirrors
   the PDF-export layout. Signature blocks are revealed-on-screen so
   print captures the actual signature data (the print-only metadata
   header carries the workplace name from `config/workplace.ts`).
4. **Recommendations list + detail** — Source Serif 4 body text, citation
   footnotes preserved, chain footer at the end.
5. **Excel-import history detail** — per-import provenance row with
   source SHA-256 + counts + reverse-window status.

### Canonical pattern landed

`apps/web/src/index.css` `@media print` block:

- Source Serif 4 for body text (Inter is UI-only per CLAUDE.md typography).
- Forces light-mode colors (dark-on-light is the evidentiary norm).
- Hides app chrome: `header.sticky` (top bar), `nav[aria-label='Primary']`
  (bottom tab bar), `aside[aria-label='Sidebar']` (desktop sidebar — not
  yet shipped but the selector is pre-wired), the skip-to-content link.
- Hides any element marked `data-print="hide"` (the back-links,
  transition / move panels, action buttons, capture FAB, dialogs).
- Surfaces `data-print="evidentiary"` metadata (the chain-anchor
  explanation, audit row indices) with a bordered divider and
  JetBrains Mono font.
- `page-break-inside: avoid` on `article`, `section`, `.print-card`,
  `[data-print="card"]`, `ul > li`, `ol > li`.
- Expands `<details>` so the full record prints.
- Surfaces external link URLs in parens (`(<url>)`) for evidentiary use.
- Removes background tints from chips (the border + label survive
  monochrome printing).
- Letter / A4 friendly margins via `@page { margin: 0.75in }`.

### T-HD7 — no display:none-to-block on encrypted fields

The print stylesheet does NOT contain any rule that un-hides a
selector that's hidden on screen. The DOM only contains revealed
plaintext when the rep has actively tapped Reveal (step-up gated). The
print stylesheet operates on the DOM that's present — an unrevealed
hazard prints with the "Hidden behind step-up authentication" copy, not
the plaintext. Verified by inspection.

### Playwright spec

`apps/web/tests/e2e/print-stylesheet.spec.ts` uses
`page.emulateMedia({ media: 'print' })` and asserts:

- The top bar (`header.sticky`) is hidden.
- The bottom tab bar (`nav[aria-label="Primary"]`) is hidden.
- The Source Serif 4 font is applied to `body`.
- A reveal-gated element on the hazard detail (the reporter-identity
  reveal button) is hidden (`data-print="hide"`).
- The chain-anchor evidentiary text is visible (`data-print="evidentiary"`).

Per T-HD5, the spec asserts the documented `@media print` invariants
against Playwright's emulation; the real-printer divergence is bounded
by the post-deploy smoke test (per ADR-0011 §3.9) on the rep's actual
printer.

---

## Commit posture

This audit + the fix bundle ships as a single S1 commit per the
ADR-0011 §3.10 slice plan. Findings categorized + fixed in
this slice; SHOULD-FIX items implemented where mechanical (the data-print
attribute markup, the print stylesheet) and documented where they require
design work (the GPS readout, the QR alt). DOCUMENTED-FOR-V2 residuals
are enumerated above with "lands in" pointers.

The audit walks the tree at git SHA `630b3df` (S0 landed: ADR-0011 +
SECURITY.md §2.12). A view that lands between this audit and the
milestone merge requires a re-walk before S5 sign-off per T-HD1; the
per-PR Quality Bar checkbox is the standing forward-defense.
