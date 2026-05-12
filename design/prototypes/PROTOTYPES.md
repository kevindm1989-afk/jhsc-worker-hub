# PROTOTYPES.md — Design Contracts for Claude Code

The files in `design/prototypes/` are **visual and interaction-design references** for the production JHSC Worker Hub. They use mock data and exist to lock the look, feel, and behavior of each surface **before** production code is written.

Claude Code must treat them as **design contracts** when building production components.

---

## The Prototypes

| File | Surface | Establishes |
|---|---|---|
| `app-shell.tsx` | App shell, dashboard, hazards list, recommendations list | Navigation patterns, bottom tab bar (mobile) / sidebar (desktop), command palette, FAB, card-list canonical layout, status semantics, color tokens, typography hierarchy, density |
| `hazard-detail.tsx` | Hazard detail view, evidence display, witness statements, audit drawer | Detail-view layout, **Citation Hover signature interaction**, section labeling, evidence tile pattern, encryption indicators, audit trail visibility, slide-overs (desktop) vs full-screen (mobile) |
| `recommendation-drafting.tsx` | Recommendation drafting, citation picker, preview modal | Long-form editing patterns, citation insertion workflow, right-rail context panels (outline, status stepper, citations used, provenance), sticky bottom action bar (mobile), 21-day clock visualization |
| `capture-to-record.tsx` | Mobile photo capture → encrypted draft hazard flow | **Capture-to-Record signature interaction**, five-stage flow (idle/capture/preview/draft/confirmed), mobile camera viewport, GPS lock indicator, encryption-at-capture badging, auto-suggested content from GPS pin |
| `adversarial-lens.tsx` | Adversarial Lens — strategic preparation against management response | **Adversarial Lens signature interaction**, prediction cards with rebuttal scaffolds, precedent surfacing, pre-empt moves, likelihood meters, outcome tagging for prediction quality improvement |
| `meeting-minutes.tsx` | Minutes module — action item list, section tabs, move workflow, key metrics dashboard | **Section Move signature interaction**, action item card pattern, action flag aging indicators, section tabs with counts, meeting metadata header, key metrics dashboard, move-item bottom sheet, audit chain visibility |

---

## How Claude Code Should Use These

### Rule 1: Visual contracts are binding

The prototypes establish the visual language of the entire app. When Claude Code builds a new screen not represented in the prototypes, it must:

- Reuse the same color tokens, typography, spacing, radius, and border treatments
- Reuse component patterns (Section labels, status badges, card layouts, filter chips)
- Match the density and information hierarchy
- Use the same icon set (Lucide) at the same stroke weights
- Maintain the restrained legal-grade aesthetic
- **Exception:** Action Flag indicators in the Minutes module use emoji intentionally (🟠 🟡 🔴 ✓ ⬇) — this matches the established Excel workflow vocabulary that reps already read fluently. This is the only place emoji are allowed in UI chrome.

If a new screen needs a new pattern not in the prototypes, Claude Code should derive it from the closest existing pattern, not invent freely.

### Rule 2: Signature interactions are pixel-faithful

Four interactions define the app's identity. Production implementations must match the prototypes:

- **Citation Hover** (`hazard-detail.tsx`, `recommendation-drafting.tsx`) — the legal corpus is ambient throughout the app. Hover/tap any citation, get a card with statute summary, version date, source link, and "Insert into draft" action. Same Source Serif 4 in the summary body. Same corpus hash footer. Same dimensions.
- **Capture-to-Record** (`capture-to-record.tsx`) — five-stage flow from FAB tap to confirmed encrypted hazard. The "42 seconds from camera to record" target is real. Photo never touches the device camera roll. GPS, hash, and encryption visible at every stage.
- **Adversarial Lens** (`adversarial-lens.tsx`) — strategic summary card at top, ranked predictions with rebuttal scaffolds, precedent, pre-empt moves, outcome tagging. The dark hero card on the strategic summary is intentional.
- **Section Move** (`meeting-minutes.tsx`) — the operational primitive of the Minutes module. Swipe an action item left/right (mobile) or use the Move button (desktop) → bottom sheet with target sections → confirm. Every move is audit-logged with timestamp, actor, optional reason. This is what makes the action item lifecycle work.

### Rule 3: Production code replaces mock data, not the design

When building the production version of a prototyped screen:

- Keep the visual structure exactly
- Replace mock data with real Drizzle queries
- Add loading skeletons matching the layout
- Add error boundaries with proper recovery copy
- Add accessibility (keyboard nav, focus management, ARIA where needed)
- Add encryption for sensitive fields per `ARCHITECTURE.md` §8
- Emit audit events for sensitive operations per `SECURITY.md`
- Add tests including security checks

### Rule 4: When in doubt, ask

If a production requirement seems to conflict with a prototype design, Claude Code must surface the conflict, propose a resolution that preserves both design intent and security requirement, and wait for confirmation.

---

## Extracting Components

The prototypes contain inline components for brevity. When building production, Claude Code should extract reusable patterns into `packages/ui`:

From `app-shell.tsx`:
- `AppShell`, `CommandPalette`, `FAB`, `StatusBadge`, `FilterChip`, `SectionHeader`, `Stat`

From `hazard-detail.tsx`:
- `Citation` + `CitationCard`, `EvidenceTile`, `WitnessRow`, `ActivityRow`, `AuditDrawer`, `Section`

From `recommendation-drafting.tsx`:
- `MetaField`, `StatusStepper`, `RailSection`, `OutlineItem`, `CitationListItem`, `CitationPicker`, `PreviewModal`, `Counter`

From `capture-to-record.tsx`:
- `Field` (form field with label, required, help text)
- `CaptureFlow` state machine

From `adversarial-lens.tsx`:
- `Prediction` (expandable counterargument card)
- `SummaryChip`

From `meeting-minutes.tsx`:
- `ActionItemCard`, `SectionTabs`, `MeetingMetadata`, `KeyMetricsDashboard`, `MoveItemSheet`, `ActionFlag`, `RiskDot`, `HistoryRow`

Build them in `packages/ui` with TypeScript prop types and Vitest tests.

---

## Updating Prototypes

Prototypes are living references. If production use reveals a design problem:

1. Fix the prototype first
2. Verify the fix in the prototype
3. Then update the production code to match
4. Commit prototype and production changes together

This keeps the prototypes as the source of truth for design decisions.
