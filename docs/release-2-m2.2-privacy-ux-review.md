# M2.2 Privacy + UX Review

Reviewer: independent S5 (privacy/UX)
Reviewed commits: 1f925e7 (S0), 42012d2 (S1), 11d8e62 (S2), b7455f9 + 5adcea5 (S3)
Branch: claude/m2.2-in-meeting-action-items
Scope: §A rights-protective copy (T-IM25 / T-IM26 / T-IM27), §B selfAttestation banner (S0 Q2), §C no-names discipline (T-IM28 / T-IM29 / non-negotiable #1), §D mobile-primary patterns (non-negotiable #9), §E print stylesheet (data-print convention), §F empty states, §G accessibility (WCAG 2.2 AA), §H citation refs, §I M2.1 regression touchpoints

---

## Findings

### CRITICAL

(none)

### HIGH

- **F-P1: `isCoChair = currentUserId !== null` is a permission stub, not a permission check (T-IM25 / non-negotiable #6 / SECURITY §2.14 T-IM3-class).**
  - Where: `apps/web/src/components/meetings/section-action-item-card.tsx:90` (`const isCoChair = currentUserId !== null; // single-rep scope per S0 Q1`) and the analogous `session !== null` guard at `apps/web/src/views/action-item-detail-view.tsx:345`.
  - What: The Reopen affordance is shown to ANY authenticated user, on the rationale that single-tenant scope makes the rep the only user. That rationale evaporates the moment 2.5 onboards a second in-app `worker_rep` (the documented forward seam in ADR-0013 §3.5). The control flow then shows Reopen to a user whose role does NOT include `worker_co_chair`, contradicting the close-verification stance (T-IM25 — counter-sign as the rep's evidence) and creating a UI affordance the server route will reject with 422.
  - Why: The contract in `config/workplace.ts` (`SignerRoleId = 'worker_co_chair' | 'mgmt_co_chair' | …`) makes the role enum available; the auth session does not yet expose it client-side. The comment correctly identifies this as a forward seam but the variable name `isCoChair` is load-bearing on a permission that is not being checked. The reviewer six months from now reading this will not notice the gap.
  - Fix: Rename the local to `isAuthenticated` (honest), OR add a `TODO(M2.5): replace with role-enum check from auth session` adjacent to a runtime invariant (`if (auth.session?.role !== 'worker_co_chair') return null;` once the role lands on the session). Add a vitest that asserts the Reopen CTA does NOT render for a session whose role is something other than `worker_co_chair` (currently no such test exists — the behaviour is implicit).

- **F-P2: Closure-verification view does not surface the `selfAttestation` banner before the `Verify closure` CTA on the `Pending Review`-but-`Not Started`-history path (S0 Q2 framing gap).**
  - Where: `apps/web/src/views/action-item-close-verification-view.tsx:163` — `ineligibleStatus = item.status === 'Cancelled' || (item.status === 'Not Started' && state.kind !== 'success')`.
  - What: An item whose status is `Not Started` is treated as ineligible AND shown an amber `AlertTriangle` warning that the item is "not eligible for closure verification" with the suggested workaround "Move it to Pending Review first, or cancel it via the routine status flow." This contradicts ADR-0013 §3.2 ("a `Not Started` item closing without ever being worked on is a SOFT WARNING surfaced in the UI, not a route-layer error — see §3.5 rights-protective stance"). The current copy uses warning-amber framing and prescribes the workaround as if it's a gate, not a soft hint. A rep who has done off-system work on an item that was never moved to `In Progress` (a routine pattern when the work happens between meetings) is told their valid closure is blocked.
  - Why: T-IM25 says the closure surface must read as rep authority, not gatekeeping. The amber banner reads as gatekeeping (warning iconography + "not eligible" framing + prescriptive "Move it first" workaround).
  - Fix: Soften to a neutral informational banner (blue, `data-print="hide"`): "This action item is in status `Not Started`. You can proceed with the closure verification, or move it to `In Progress` / `Pending Review` first if you want the chain to reflect the working history." Allow the form to submit; the route's §3.2 design accepts this with the soft-warning chain-payload flag.

- **F-P3: `selfAttestation` banner uses informational-blue but is paired with a `ShieldCheck` icon that reads as a security affirmation, not a constraint disclosure (T-IM25 framing).**
  - Where: `apps/web/src/views/action-item-close-verification-view.tsx:341`.
  - What: The banner copy ("You are both the closer and the counter-signer because no other in-app worker co-chair is available…") correctly states the single-rep constraint per S0 Q2. The `<ShieldCheck>` icon visually communicates verified-security, which inverts the semantic — the banner is disclosing a DEGRADED attestation posture (single-rep self-attest vs. independent counter-sign), not affirming a verified one. A rep reading the icon-first will skip the prose and conclude the system has fully verified the closure.
  - Why: Per CLAUDE.md design rules ("Always pair color with icon or label — never color alone"), the icon is part of the semantic. `ShieldCheck` is the icon used elsewhere for the "Verify closure" affirmative CTA on the section card (`section-action-item-card.tsx:226`) — overloading it on the constraint-disclosure banner conflates the two meanings.
  - Fix: Swap to `Info` (Lucide) or `UserCheck` for the banner; reserve `ShieldCheck` for the affirmative verification action. Alternatively, accept the visual ambiguity and prepend the banner copy with a non-decorative label like "Single-rep self-attestation:" so the disclosure framing leads the prose.

### MEDIUM

- **F-P4: `liveMetricsLegend` copy promises "no per-rep attribution" but the panel's `closureVerifications.self` / `peer` split is a structural step in that direction (T-IM27 surveillance posture).**
  - Where: `apps/web/src/components/meetings/live-metrics-panel.tsx:275-281` renders `total / self / peer` for closure verifications; the legend at line 188 reads `MEETING_RIGHTS_COPY.liveMetricsLegend = 'Live aggregates from this meeting. Counts only — no per-rep attribution.'`.
  - What: At single-tenant scale `self` is operationally equivalent to "the rep self-attested" and `peer` is "someone other than the rep counter-signed" — both of which trivially de-anonymize to the single rep. The legend's "no per-rep attribution" promise is technically true (the chips show counts, not names) but the `self / peer` decomposition reads as the first step toward per-actor tracking. Per T-IM27 the structural defense is aggregate-only; this is the rare place where the structural defense and the operational surface drift.
  - Why: ADR-0013 §3.5's `selfAttestation` flag is informational, not surveillance — exposing the count on the live dashboard turns the rep's self-attestation rate into a productivity metric a future co-chair or auditor could read as "how often is this rep working alone." The S0 Q2 user-decision intentionally chose the minimal-friction banner so self-attestation doesn't read as shame; surfacing the running tally undoes that.
  - Fix: Collapse the chip to `total` only, surface the `self / peer` split only inside the per-item closure metadata where it has evidentiary value. OR strengthen the legend copy to acknowledge the breakdown's purpose: "Self-attestation count reflects single-rep constraint, not rep performance." OR move the breakdown to an expandable detail that requires an explicit tap.

- **F-P5: Move history empty state ("No moves in this meeting yet.") fails the CLAUDE.md "empty states do work" rule.**
  - Where: `apps/web/src/components/meetings/section-move-history.tsx:80`.
  - What: The copy is the canonical anti-pattern called out in the design system ("Never 'No data.' Show what to do next."). The rep opening the move history mid-meeting needs to know that (a) moves ARE tracked here, (b) what counts as a move (section transitions via the section navigation), and (c) the rest of the meeting's chain anchors will populate it as the meeting runs.
  - Why: CLAUDE.md design system explicit rule. Other M2.2 surfaces (section-action-items empty state) get this right.
  - Fix: "No items have moved between sections during this meeting. Swipe an action item left/right (or use the section move panel on the detail view) to move it; every move is anchored in the audit chain."

- **F-P6: Meeting history timeline on the action-item detail view exposes raw meeting UUID prefixes as the user-facing label (UX + chain-of-custody framing).**
  - Where: `apps/web/src/views/action-item-detail-view.tsx:688` — `{entry.meetingId.slice(0, 8)}…` rendered as a tappable link.
  - What: The timeline entry header is `[uuid-prefix]…` which is unintelligible to a rep three months from now who wants to know "which meeting was that." The rest of the action item detail (above this) uses dates (`Raised {item.startDate}`, line 224) so the UI mixes date-as-identifier and uuid-as-identifier. For an evidentiary surface this is meaningfully worse: an arbitrator reading the printed minutes sees `[a3f2c9e8]… · first touch 2026-04-15` and cannot connect the meeting to its agenda.
  - Why: The S3 boundary explicitly forbids new server endpoints (per the file comment at lines 14-17), so meeting-date lookup is not yet wired. But the cached Dexie `meetings` table almost certainly carries the meeting date already, and using `entry.firstSeenAt` (which IS rendered, line 692) as the primary label would be a one-line fix.
  - Fix: Lead with the local-time first-touch date (`new Date(entry.firstSeenAt).toLocaleDateString()`) as the link text; relegate the uuid prefix to a secondary `<span data-print="evidentiary">` for the chain-traceable identifier. Print stylesheet already covers the evidentiary surface.

- **F-P7: Status menu on `section-action-item-card` is dismissed only on outside click via the parent, but no escape-key handling and no `aria-controls` linkage (WCAG 2.2 AA — keyboard accessibility).**
  - Where: `apps/web/src/components/meetings/section-action-item-card.tsx:247-302`.
  - What: The menu is rendered as a plain `<button>` toggle that flips `menuOpen` state and shows a `<div role="menu">`. The trigger has `aria-haspopup="menu"` and `aria-expanded`, which is good. But (a) pressing `Esc` does not close the menu, (b) there is no `aria-controls` pointing at the menu id, (c) the menu items are not focus-trapped, (d) there is no outside-click handler so the menu stays open if the rep taps elsewhere on the page. The mobile menu trigger is 44pt (good) but the menu surface options at 28pt (`py-2 text-xs`) are likely under-target.
  - Why: WCAG 2.2 AA + CLAUDE.md mobile-primary touch-target rule. The Radix Select primitive specified by ADR-0013 §3.9 was NOT used — the implementation is a hand-rolled menu. Radix would give all of this for free.
  - Fix: Migrate the menu to the existing shadcn/ui DropdownMenu (Radix) primitive, which handles Esc, outside-click, focus management, ARIA linkage, and touch target sizing. The migration is local to this one component; the rest of the M2.2 surface is unaffected.

### LOW

- **F-P8: Closure-verification view's `evidenceStorageKey` text input lets the rep hand-paste a Tigris storage key with empty envelope ciphertexts (file-level acknowledged forward seam).**
  - Where: `apps/web/src/views/action-item-close-verification-view.tsx:194-211` + the inline comment at lines 199-206 explicitly flags this for S5 review.
  - What: The current path sends `envelopeCtB64: ''` + `envelopeDekCtB64: ''` when the rep pastes a storage key without going through the proper 1.7 evidence flow. The server's HEAD-verify enforces correctness, but the UX is misleading — the rep sees an input, types a key, and gets a recorded-but-not-encrypted-by-them attachment. A rep in the heat of a meeting could attach unverified evidence with no encryption envelope and not realize the structural gap.
  - Why: ADR-0013 §3.5 specifies the evidence flow REUSES the 1.7 Tigris encrypt-before-upload pattern. The current S3 surface hand-pastes instead. The author tagged this for review.
  - Fix: Hide the storage-key input entirely for S3; surface a "Attach evidence" button that opens the existing `CaptureFab` / `EvidenceUpload` flow (already integrated in the action-item detail view per `action-item-detail-view.tsx:321`). The hand-paste pathway should not ship.

- **F-P9: The `closureVerificationBanner` carries `data-print="evidentiary"` (blue background banner intended as a screen-side prose intro).**
  - Where: `apps/web/src/views/action-item-close-verification-view.tsx:300-305`.
  - What: The banner reads "Closure verification is your evidence that this item was addressed. The chain anchor makes it tamper-evident for a future MLITSD review." This is screen-side intro copy explaining the workflow, NOT evidentiary chain metadata. Marking it `data-print="evidentiary"` will render the marketing-style prose in JetBrains Mono with a bordered divider on the printed evidence document — inverting the print convention from `apps/web/src/index.css` lines 285-293 where `data-print="evidentiary"` is reserved for chain anchors, audit row indices, signatures.
  - Why: The print convention is documented in CLAUDE.md ("Mark evidentiary metadata that must surface in print but is normally muted on screen with `data-print="evidentiary"`"). The banner is neither muted-on-screen nor canonical chain metadata.
  - Fix: Change to `data-print="hide"` (the banner is screen-side guidance; the printed closure record carries the chain anchor + attestation sig from the success panel's `data-print="evidentiary"` block which is correct).

- **F-P10: `aria-live` region on `LiveMetricsPanel` covers the loading skeleton but not the metric value updates (WCAG 2.2 AA — status messages).**
  - Where: `apps/web/src/components/meetings/live-metrics-panel.tsx:192` — `aria-live="polite"` is on the loading grid only; the `MetricsGrid` itself has none.
  - What: SWR polls every 5 seconds and updates the stat tiles in place. A screen-reader user has no signal that the values changed. Per ADR-0013 §A this should be `aria-live="polite"` on the values region (the prompt explicitly called this out as a check item).
  - Why: WCAG 2.2 AA — value changes that matter to the user should be announced. 5s polling without announcement is silently-changing content.
  - Fix: Add `aria-live="polite"` and `aria-atomic="true"` to the `MetricsGrid` wrapper. Consider `aria-relevant="text"` to scope the announcement.

- **F-P11: Closure-verification success panel's `Detail` rows render the raw closer-actor-id, counter-signer-actor-id as full UUIDs in muted-foreground emerald (no truncation, no copy-affordance hint).**
  - Where: `apps/web/src/views/action-item-detail-view.tsx:528-529` — `<DetailRow label="Closer" value={closure.closedByActorId} mono />`.
  - What: Per T-IM28 the actor UUIDs are non-PI under the project's payload convention (names are encrypted elsewhere), but rendering the full UUID with `break-all` mid-prose creates a wall of unreadable text. The same content on the printed evidence record (data-print="evidentiary" inherited via the parent block) is the canonical evidentiary form; the on-screen version should be the short prefix with a tap-to-copy affordance.
  - Why: UX density rule; T-IM28 mitigation is structural (UUID-only at rest, KEK-encrypted name on export) — the on-screen render is the secondary surface.
  - Fix: Truncate to `xxxx…xxxx` (first 8 + last 4 chars) on screen with a copy button; keep the full UUID in the `data-print="evidentiary"` print row.

- **F-P12: No `<CitationRef>` for OHSA s.9(21) (the 21-day clock) anywhere on the move history or section action item surfaces (CLAUDE.md Citation Hover signature interaction).**
  - Where: `section-move-history.tsx` (mentions "21-day s.9(21) clock" only in a code comment); `section-action-item-card.tsx` (same — comment only); `live-metrics-panel.tsx` carries the quorum citation as raw text at line 300.
  - What: The Citation Hover signature is per CLAUDE.md a defining interaction. The M2.2 surfaces materially extend the 21-day s.9(21) machinery (the ActionFlag aging chip rendered on every card is the clock indicator) but none of the new UI surfaces wraps the citation as `<CitationRef />`. The rep tap-and-holding the flag chip gets no contextual citation card.
  - Why: CLAUDE.md UI rule + the existing `meeting-detail-view.tsx:754` correctly wraps s.9(20) / s.135(5) on the recommendations section header — the precedent exists; M2.2 missed it.
  - Fix: Wrap "21 days" and "s.9(21)" with `<CitationRef />` on (a) the ActionFlag badge tooltip, (b) the empty-state copy on `section-move-history.tsx`, (c) the `liveMetricsLegend` if the legend ever references the clock. Also wrap the `quorumCompliance.ruleCitation` value on `live-metrics-panel.tsx:300` since the route already returns a structured citation.

- **F-P13: Closer-vs-counter-signer constraint failure (422) shows the raw server message verbatim ("closer_counter_signer_conflict" passthrough risk).**
  - Where: `apps/web/src/views/action-item-close-verification-view.tsx:259-261` and `reopen-dialog.tsx:78` — both surface `body?.message ?? 'Closure rejected — see the route response.'`.
  - What: The fallback string "see the route response" leaks implementation framing to the rep. The 422 conditions documented in ADR §3.5 are concrete (not closable via verification / closer-counter-signer-conflict / etc.); the UI should translate each to a rights-protective message rather than echo the route's enum.
  - Why: Rights-protective copy posture — the rep should never see route-layer jargon. The snapshot test covers the canonical copy module but not the inline error fallbacks.
  - Fix: Map each documented 422 error code in the route Zod schema to a rights-protective string in `rights-protective-copy.ts`; add snapshot coverage. Default to a neutral "We couldn't record this closure — refresh the action item and try again."

- **F-P14: `MeetingHistoryTimeline` empty state ("This item has not been touched in a meeting yet.") works (per CLAUDE.md), but the surrounding helper text uses inline `style={{ fontFamily: '"Source Serif 4 Variable", …' }}` instead of a Tailwind utility (style drift).**
  - Where: `apps/web/src/views/action-item-detail-view.tsx:665-670`.
  - What: The inline style escapes the design token system. M2.1 / M2.2 elsewhere relies on the Tailwind theme to govern font stacks. Inline `style=` on an evidentiary surface is hard to audit and will not be caught by the existing print-stylesheet rules that reference utility classes.
  - Why: Design system consistency.
  - Fix: Add a `font-serif` utility (or equivalent) to the Tailwind config keyed to the Source Serif 4 stack; replace the inline style.

---

## Verified clean

- The `closureSelfAttestationBanner`, `closureReasonPlaceholder`, `closureSubmitCta`, `closureOfflineHint`, `closureSuccessHeading`, `closureVerificationBanner`, `reopenDialogTitle`, `reopenDialogDescription`, `reopenSubmitCta`, `reopenSuccessMessage`, `liveMetricsLegend` strings are all in `apps/web/src/meetings/rights-protective-copy.ts` and covered by the snapshot guard at `apps/web/src/__tests__/meetings-rights-protective-copy.test.ts`. The snapshot includes property-level guards for evidence framing (T-IM25), no-justify framing (T-IM26), aggregate-only attribution (T-IM27), and the S0 Q2 selfAttestation framing. Drift-resistant.
- The `selfAttestation` banner copy is verbatim from the S0 addendum (apps/web/src/views/action-item-close-verification-view.tsx:342 + apps/web/src/meetings/rights-protective-copy.ts:95-96). No checkbox; minimal friction; informational-blue tone (not red/warning). Matches S0 Q2 user decision.
- No `console.log` / `console.error` / `console.warn` in any of the M2.2 S3 surfaces (verified via grep across the 7 review-scoped files).
- No hardcoded workplace names, real names, role display labels, or facility-specific strings in the M2.2 S3 surfaces. The minutesSignerRoles config is consumed only server-side; the client treats the worker_co_chair role as the auth.session user (forward-seam acknowledged in F-P1).
- Closure-verification view sticky-bottom CTA pattern is correct: `h-12 md:h-9` 48pt mobile / 36pt desktop touch targets on Submit + Cancel; textarea + evidence input use `text-base md:text-sm` (16px mobile to avoid iOS zoom).
- Reopen dialog Cancel + Submit buttons are 48pt mobile (`h-12 md:h-9`); the dialog opens with focus visible-ring on the reason select (the implicit autofocus on the first interactive element + `focus:ring-2 focus:ring-ring`); pressing Esc on the dialog: NOT implemented — clicking the backdrop is the only close path (UX risk, mentioned in F-P7 context).
- The `LiveMetricsPanel` correctly omits per-rep counts in the payload schema + UI (T-IM27 structural defense holds for everything EXCEPT the self/peer breakdown — see F-P4).
- The `useOptionalAuthSession` pattern on action-item-detail-view preserves the 1.6 test harness while gating the production reopen CTA on session presence; the gating is a permission stub (F-P1) but the test-vs-prod separation is sound.
- Print stylesheet correctly tags `live-metrics-panel`, `closure-verification-panel`, `meeting-history-timeline`, `closure-success-panel` as `page-break-inside: avoid` + force-expands collapsed move-history bodies (apps/web/src/index.css:335-351). Closure verification panel surfaces the chain anchor + attestation sig + evidence key under `data-print="evidentiary"` (action-item-detail-view.tsx:540-551) which is correct evidentiary metadata for the printed record.
- Inline status menu correctly EXCLUDES `Closed` from the options list (per ADR §3.9 — closing requires the verification view); helper text at section-action-item-card.tsx:298 redirects: "Closing? Use Verify closure to record the JHSC counter-sign."
- Cancellation is on the status menu (per S0 Q3 — Cancelled-in-meeting emits the same cross-anchor).
- The closure-reason textarea placeholder asks "What was done to verify closure?" — descriptive, not justificatory; passes T-IM26.
- Meeting detail view correctly cross-links to `<SectionActionItems>` only for `new_business`, `old_business`, `recommendations` sections (per `MEETING_TO_ACTION_SECTION` map at meeting-detail-view.tsx:71-75) — roll_call, agenda, etc. correctly do NOT host action items.
- M2.1 finalization view's signature workflow + quorum chip + pull-to-refresh — UNTOUCHED by M2.2 S3 (the snapshot test would catch any drift; live-metrics chip renders inside meeting-detail-view ABOVE the section accordion, parallel to the existing quorum chip in the sticky top bar — no duplication).
- The `requireOnline` wrapper at `apps/web/src/sync/typed-client.ts` is correctly applied to BOTH the close-verification submit and the reopen submit — both routes are step-up + chain-anchor operations per ADR §3.8 and cannot queue offline.
