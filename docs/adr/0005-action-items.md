# ADR-0005 — Action items data model + section workflow (Milestone 1.6)

Status: Accepted
Date: 2026-05-29
Authors: codifies Milestone 1.6 architect-phase decisions; pairs with `SECURITY.md` §2.6.

## Context

CLAUDE.md non-negotiable #12 makes action items their own entity, not a sub-concept of hazards. They're the operational primitive of the Minutes module: each lives in a section, moves between sections under the 21-day s.9(21) clock, and accumulates a move history that's evidence-grade in an arbitration or MLITSD complaint. Per ARCHITECTURE.md §"Action Items (Top-Level Entity)" they're also the convergence point for hazards (1.5), recommendations (1.9), inspection findings (1.8), incidents (later), and Excel-imported historical items (1.11).

The 1.6 milestone lands the entity, the move history, the four taxonomies (Type / Status / Section / Risk), the Action Flag pure function, and the list + detail + section-move UI. Linkage tables to future entities are placed as nullable FK seams that tighten in their owning milestones. Meetings (`meeting_id`) and inspections/recommendations/incidents source FKs are nullable text/uuid placeholders for the same reason.

`design/prototypes/meeting-minutes.tsx` is the visual anchor. The Excel workflow's `_MoveHistory` sheet is the operational anchor — we're replacing that spreadsheet with a cryptographically tamper-evident equivalent.

## Decision

Land two tables (`action_items`, `action_item_moves`), four pure-function helpers (type/status/section/risk validators + Action Flag computation), six API routes, six React surfaces, and four audit-chain event kinds. Description, `recommended_action`, `raised_by`, and `follow_up_owner` use the `@jhsc/crypto` envelope (1.3 pattern). The hazards 1.5 deferral closes here: `action_items.source_type='hazard'` + `source_id` FK to `hazards.id`.

### Tables

```
action_items (
  id                  uuid primary key default gen_random_uuid(),
  sequence_number     integer not null,                          -- per-section "#" column from Excel
  type                text not null check (type in
                        ('INSP','INSIGHT','FLI','INC','REC','TRAIN','PROC','OTHER')),
  type_subtype        text,                                      -- non-PI when type='OTHER'; null otherwise
  description_ct      bytea not null,
  description_dek_ct  bytea not null,
  recommended_action_ct       bytea,
  recommended_action_dek_ct   bytea,
  raised_by_ct        bytea,                                     -- encrypted display name; null when raised_by_user is set
  raised_by_dek_ct    bytea,
  raised_by_user_id   uuid references users(id),                 -- internal rep
  follow_up_owner_ct  bytea,                                     -- encrypted name when external
  follow_up_owner_dek_ct bytea,
  follow_up_owner_user_id uuid references users(id),             -- internal rep
  department          text,                                      -- non-PI; e.g. "Operations"
  status              text not null check (status in
                        ('Not Started','In Progress','Blocked','Pending Review','Closed','Cancelled')),
  risk                text not null check (risk in ('Low','Medium','High','Critical')),
  section             text not null check (section in
                        ('new_business','old_business','recommendation','completed_this_period','archived')),
  start_date          date not null,
  target_date         date,
  closed_date         date,
  verified_by_jhsc_id uuid references users(id),
  meeting_id          uuid,                                      -- FK lands in 1.10 (meetings)
  source_type         text check (source_type in
                        ('manual','hazard','recommendation','inspection','incident','excel_import')),
  source_id           uuid,                                      -- FK polymorphic via source_type
  source_excel_hash   bytea,                                     -- SHA-256 of the source Excel row (1.11)
  tags                text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

action_item_moves (
  id                  uuid primary key default gen_random_uuid(),
  action_item_id      uuid not null references action_items(id) on delete restrict,
  moved_by_user_id    uuid not null references users(id),
  moved_at            timestamptz not null default now(),
  from_section        text,                                      -- null on create
  to_section          text not null,
  reason_ct           bytea,                                     -- encrypted; optional
  reason_dek_ct       bytea,
  meeting_id          uuid,                                      -- nullable until 1.10
  audit_idx           bigint not null references audit_log(idx), -- chain anchor
  undone              boolean not null default false             -- Excel "Undone?" pattern
);
```

Notes:

- **Type taxonomy is fixed-8.** Matches CLAUDE.md Action Item Conventions verbatim. `type_subtype` is mandatory when `type='OTHER'` (Zod check at route layer; not a CHECK because Postgres CHECK can't conditionally require another column except via CASE).
- **Section workflow** (CLAUDE.md):
  ```
  new_business ──> old_business ──> completed_this_period ──> archived
       │
       └──> recommendation (formal s.9(20) under 21-day clock)
       │
       └──> completed_this_period (closed before the 21-day boundary)
  ```
  Plus universal moves to `archived` from any non-archived section (operator cleanup) and a `recommendation → completed_this_period` path when management responds + the item closes. The graph lives in `packages/shared-types/src/action-item-transitions.ts` next to the 1.5 hazard transitions.
- **Status × Section interaction.** Closing an item (`status='Closed'`) does NOT automatically move it to `completed_this_period`. The rep performs the section move explicitly via the swipe/drag interaction, and the move is audit-logged. This matches the Excel workflow: the rep stamps the row Closed _then_ slides it to the Closed sheet at end-of-meeting.
- **Action Flag is computed.** Pure function over `(section, status, start_date, closed_date, today)`. Not a DB column. The function is the single source of truth, shared by the API list projection and the web rendering layer — same shape as `hazard-transitions.ts`.
- **Encrypted fields.** Four pairs of `(*_ct, *_dek_ct)` columns:
  - `description` — required (matches Excel "What was raised").
  - `recommended_action` — optional ("What we recommend").
  - `raised_by` — optional encrypted display name for non-members (e.g. a worker's name from the floor). Internal-rep raises set `raised_by_user_id` and leave the ciphertext NULL.
  - `follow_up_owner` — same shape: external person's name encrypted, internal rep's `user_id` referenced.
- **`source_excel_hash`** is reserved for 1.11 reconciliation. Stays NULL through 1.6.
- **No DELETE.** Section `archived` + status `Cancelled` is the cancellation path. Cancelled items keep their move history.

### Action Flag (pure function — `packages/shared-types/src/action-item-flag.ts`)

Mirrors ARCHITECTURE.md §5 verbatim. Inputs: `(section, status, startDate, closedDate, today)`. Output: one of `null` or a tagged union `{ kind, label, severity }` so the renderer picks the right color + icon without re-parsing the emoji label. Concretely:

```ts
type ActionFlag =
  | { kind: 'recently_closed'; label: '✓ Recently Closed'; severity: 'resolved' }
  | { kind: 'aging_under_21'; label: '🟠 <21 days'; severity: 'pending' }
  | { kind: 'aging_over_21'; label: '🟠 >21 days — move to Old Business'; severity: 'pending' }
  | { kind: 'response_received'; label: '✓ Response received'; severity: 'resolved' }
  | { kind: 'response_overdue'; label: '🔴 s.9(21) response overdue'; severity: 'open' }
  | { kind: 'response_countdown'; daysRemaining: number; severity: 'pending' } // label rendered from daysRemaining
  | { kind: 'archive_due'; label: '⬇ Archive to Closed sheet'; severity: 'archived' };
```

The recommendation `response_received` / `response_overdue` distinction uses a `hasManagementResponse` derived field — for 1.6 that's pinned to `false` everywhere (recommendation responses land in 1.9), so 1.6 always renders the countdown / overdue states for items in the `recommendation` section.

### API surface

`apps/api/src/routes/action-items/`:

- `POST /api/action-items` — create. Body: `{ type, typeSubtype?, description, recommendedAction?, raisedBy? | raisedByUserId?, followUpOwner? | followUpOwnerUserId?, department?, status, risk, section, startDate, targetDate?, sourceType?, sourceId?, tags? }`. Emits `action_item.created`. Inserts a bootstrap move row (NULL → section) pinned to the chain.
- `GET /api/action-items` — list. Query: `section[]?`, `status[]?`, `risk[]?`, `type[]?`, `q?` (title-equivalent ILIKE over a decrypted-then-trimmed description preview), `meetingId?`, `limit?`, `offset?`. Returns projections with decrypted-summary description; the Action Flag computed server-side from the canonical clock.
- `GET /api/action-items/:id` — full detail. Returns all decrypted fields + move history with chain `audit_idx` anchors.
- `PATCH /api/action-items/:id` — update non-section fields (status, risk, description, recommended_action, target_date, etc.). Emits `action_item.updated`.
- `POST /api/action-items/:id/moves` — section move. Body: `{ toSection, reason?, meetingId? }`. Validates against the section-graph helper; rejects illegal moves with 422. Emits `action_item.moved`. Step-up required for `→ archived` (operator cleanup) and for undoing a prior move.
- `POST /api/action-items/:id/moves/:moveId/undo` — undo a specific move (Excel "Undone?" pattern). Step-up required. Sets `undone=true` on the move row, emits `action_item.move_undone`, and writes a fresh move row reverting the section.

No DELETE. Cancellation goes through PATCH `status='Cancelled'` then move to `archived`.

### Encryption boundary

Apply at the route layer through `apps/api/src/action-items/crypto.ts` — same shape as the hazards module (`sealField`, `sealOptionalField`, `safeSummary` for the list projection). Reuses `getMasterKey()` from the auth-crypto module; no new KEK derivation paths.

### Audit-chain events

Four new kinds in `packages/shared-types`:

```ts
| { kind: 'action_item.created'; itemId: string; type: ActionItemType; section: ActionItemSection;
    risk: ActionItemRisk }
| { kind: 'action_item.updated'; itemId: string; changedFields: ReadonlyArray<string> }
| { kind: 'action_item.moved'; itemId: string; fromSection: ActionItemSection | null;
    toSection: ActionItemSection; undone?: boolean }
| { kind: 'action_item.move_undone'; itemId: string; movedItemId: string;
    revertedFromSection: ActionItemSection; revertedToSection: ActionItemSection }
```

`changedFields` is a string-only allow-list (`['status', 'risk', 'description', 'recommended_action', 'target_date', 'tags', 'follow_up_owner']`) — never the values. No PI in any payload.

### Web surfaces

- `/action-items` — list with section tabs (mobile) / column-per-section kanban (desktop). Filters: section, status, type, risk. Search: ILIKE over the decrypted-summary preview from the server.
- `/action-items/new` — intake form. Mobile-first single column. Sticky bottom submit.
- `/action-items/:id` — detail. Status / risk pickers inline; description editable in-place. "Move section" button opens a sheet with the destination options and a reason prompt. Move history rendered chronologically with audit indices.
- `/action-items/:id/move` — gesture target on mobile (sheet); on desktop the Kanban supports drag-and-drop with the same backend call.
- `<ActionFlagBadge />` — renders the pure-function output with the right color + icon. Lives in `apps/web/src/action-items/components.tsx`.
- `<SectionMover />` — sheet/drawer that confirms the move target + collects the reason. Step-up enforcement is server-side; the modal opens via `stepUpEmitter.dispatch` on 401.

### Implementer slices

- **S1: shared-types + schema package.** Add `ActionItemType` / `ActionItemStatus` / `ActionItemSection` / `ActionItemRisk` enums + transition graph + Action Flag pure function with unit tests. `apps/api/src/db/schema.ts` adds both tables. Migration 0005. Tests: enum exhaustiveness, transition graph (allowed/illegal pairs), Action Flag boundary cases (≤21, >21, just-closed, archive-due).
- **S2: crypto helper + routes.** `apps/api/src/action-items/crypto.ts`, `apps/api/src/routes/action-items/` with the six endpoints above. Integration suite covering create + read + list + update + move + move-undo. Step-up enforced on archive moves + move-undo. The hazards-source path lands here: POST with `sourceType='hazard'` writes the FK and surfaces in detail.
- **S3: web — list + intake.** `/action-items` list with the section-grouped layout. `/action-items/new` intake form. Tests: empty-state CTA, filter chips, intake validation + submit.
- **S4: web — detail + section move.** `/action-items/:id` with the inline editors + move drawer. Move-undo button on each move row. Tests: detail render, move happy path, undo round-trip, step-up dispatch on archive.
- **S5: independent security + privacy review** — same pattern as 1.4/1.5.

## Consequences

### Positive

- CLAUDE.md non-negotiable #12 lands structurally — action items are an independent table with their own lifecycle, not a hazard sub-type.
- The Excel `_MoveHistory` sheet is replaced with a chain-anchored, tamper-evident equivalent — the operational primitive that defines worker-side JHSC value.
- The hazards 1.5 deferral closes: `action_items.source_type='hazard'` + `source_id` FK gives hazards a path to actionable tracking without putting action-item state on the hazards row.
- The Action Flag pure function shipped here is what makes the Minutes module legible at the first glance the rep gets when they open the app — the emoji vocabulary the team already reads from spreadsheets.

### Negative / accepted tradeoffs

- **Polymorphic `(source_type, source_id)`.** Postgres can't FK to "one of N tables" without trigger gymnastics. The source_type/source_id pair stays text+uuid with route-level validation. When the source table lands (recommendations 1.9, inspections 1.8, incidents later), a trigger backstop joins on source_type. Documented; the integrity bound is the route-level check.
- **`meeting_id` nullable through 1.10.** Items created in 1.6 won't link to meetings until 1.10's meetings table lands. The column is nullable text/uuid; no FK enforcement. Documented.
- **List route decrypts every row's description** for the preview. Same as hazards; same per-row try/catch defence (sec-F5 1.5 pattern). Same rate-limit + body-limit middleware applied.
- **Section move audit chain emits every move**, including reverts via undo. The chain grows fast under heavy edit traffic. Acceptable; chain rows are tiny (no PI in payload).

### Risks

- **Sequence-number collision under concurrent inserts.** `sequence_number` is per-section, used as the "#" column. We allocate it via a per-section monotonic counter computed at insert time inside the transaction (`SELECT MAX(sequence_number) WHERE section = $1 FOR UPDATE`). Two concurrent inserts into the same section serialize on the row lock; ROLLBACK on failure does not advance the counter (unlike a sequence). Mitigation: documented; the per-section counter is reset to 1 on section move (not on initial create).
- **Undo loop.** An attacker could spam moves + undoes to grow the chain. Mitigation: rate-limit applies; undo is step-up-gated so a compromised credential alone can't loop indefinitely. Documented.
- **Encrypted-field staleness during KEK rotation.** Same shape as hazards; list-projection wraps decryption in try/catch. Documented in §"KEK rotation impact" of the action-items runbook.

## Compliance check

- [x] Aligns with `.context/constraints.md` — no cross-border transfer, no new subprocessor, Ontario residency unchanged.
- [ ] Threat model updated — **follow-up: threat-modeler appends SECURITY.md §2.6 "Action Items" with T-AI1..T-AIn.**
- [x] No new subprocessor.
- [x] CLAUDE.md non-negotiables #1 (no names — `raised_by`/`follow_up_owner` are encrypted), #2 (evidence-grade audit chain), #4 (encryption at app layer), #12 (action items first-class) honored.
- [x] WCAG 2.2 AA — intake + detail use semantic form elements; the section mover is a focusable button with a labelled sheet; flags pair color with icon + label.

## Follow-ups

- [ ] Threat-modeler: SECURITY.md §2.6 — action-item threats + mitigations.
- [ ] S1: shared-types + schema + migration 0005.
- [ ] S2: action-items crypto helper + six routes + integration tests.
- [ ] S3: web list + intake.
- [ ] S4: web detail + section move.
- [ ] S5: security + privacy reviewers.
- [ ] Runbook: `docs/runbooks/action-items.md` covering section-move audit invariants, undo procedure, KEK rotation impact, PIPEDA right-to-erasure procedure.
- [ ] `.context/decisions.md` entry.
