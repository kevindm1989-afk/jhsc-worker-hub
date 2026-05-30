# ADR-0004 — Hazards data model + intake/list/detail workflow (Milestone 1.5)

Status: Accepted
Date: 2026-05-29
Authors: codifies Milestone 1.5 architect-phase decisions; pairs with `SECURITY.md` §2.5.

## Context

The Hazards module is the first worker-data surface in the app. Hazards are reports of real-world conditions (slip surface, WBV exposure, faulty guarding, near-miss, MSD risk, noise, etc.) raised by reps or workers and tracked through a lifecycle. Three things make hazards different from anything before this milestone:

1. **Worker-personal content.** A hazard's `description`, `reporter_identity`, and `location_detail` carry PI (a specific worker's words about a specific bodily risk, sometimes identifying a specific worker by name or shift). Non-negotiable #2: this is evidentially sensitive; non-negotiable #4: encrypt at the application layer with keys we control.
2. **Status workflow with audit-chain integration.** Every state move (`open → assessing → assigned → resolved → archived` and the dangerous one, `→ withdrawn`) is a written record under JHSC discipline. Every move is chain-anchored so a regulator's "who closed this, when, why" question has a tamper-evident answer.
3. **Linkage surface for later milestones.** Hazards anchor the recommendation/action-item/evidence/witness graph that lands across 1.6–1.9. The 1.5 schema has to leave the seams for that growth without overcommitting the shape.

`design/prototypes/hazard-detail.tsx` + `capture-to-record.tsx` are the visual anchors. ROADMAP 1.5 scope is core data model + UI; **excludes** action items (1.6), evidence vault (1.7), camera/GPS capture (1.7), witness statements (1.8), legal-citation embedding (already in 1.4 — surfaced here via `<CitationRef />`).

## Decision

Land two tables (`hazards`, `hazard_status_history`) plus four read/write routes, six React surfaces, and two audit-chain event kinds. Encryption applies at the field level via the existing `@jhsc/crypto` envelope. No Excel-import path lands in 1.5 — that's 1.11.

### Tables

```
hazards (
  id                  uuid primary key default gen_random_uuid(),
  hazard_code         text not null unique,                       -- H-NNN visible identifier
  title               text not null,                              -- short, non-PI summary (≤120 chars)
  description_ct      bytea not null,                             -- envelope-encrypted JSON body
  description_dek_ct  bytea not null,                             -- envelope per-row DEK
  reporter_identity_ct bytea,                                     -- envelope-encrypted; null when anonymous
  reporter_identity_dek_ct bytea,                                 -- envelope per-row DEK
  reported_by         uuid not null references users(id),         -- the rep who created the row
  severity            text not null check (severity in ('critical','high','medium','low')),
  status              text not null check (status in
                        ('open','assessing','assigned','resolved','archived','withdrawn')),
  -- Zone IDs are stable per CLAUDE.md non-negotiable #14; display name is
  -- looked up at render time from config/workplace.ts. Zones are not yet
  -- enforced as a FK -- ROADMAP 1.5 doesn't ship the zones table; the
  -- column lands as text and tightens in 1.6 inspections.
  location_zone       text,
  -- Free-text location for cases zones can't capture ("south of bay 3
  -- under the conveyor"). PI risk: minor; encrypted alongside description
  -- since they're usually written together.
  location_detail_ct  bytea,
  location_detail_dek_ct bytea,
  jurisdiction        text not null check (jurisdiction in ('ON','CA')),
  reported_at         timestamptz not null default now(),
  assessed_at         timestamptz,
  resolved_at         timestamptz,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

hazard_status_history (
  id                  uuid primary key default gen_random_uuid(),
  hazard_id           uuid not null references hazards(id) on delete restrict,
  from_status         text,                                       -- null for create
  to_status           text not null,
  actor_id            uuid not null references users(id),
  reason_ct           bytea,                                      -- envelope-encrypted note (optional)
  reason_dek_ct       bytea,
  audit_idx           bigint not null references audit_log(idx),  -- chain anchor
  occurred_at         timestamptz not null default now()
);
```

Notes:

- **Severity is fixed-4.** Critical/high/medium/low. No "info" tier — JHSC concerns reach the system once they're worth tracking; "info" hazards are noise.
- **Status workflow** (Mermaid-equivalent ASCII):

  ```
  open ──> assessing ──> assigned ──> resolved ──> archived
   │           │             │           │
   └───────────┴─────────────┴───────────┘
                   ↓
               withdrawn
  ```

  - `open` is the create state.
  - `assessing` is "rep is gathering more info."
  - `assigned` is "rep has named who owns the next move" (no FK to users yet — owner is part of the assessing slice in 1.5; promoted to a real FK in 1.6 alongside action_items).
  - `resolved` is "the underlying condition has been corrected."
  - `archived` is "this hazard is closed out, no further action."
  - `withdrawn` is the dangerous escape valve — "this report was a mistake or duplicate." Withdrawn is fully audited with mandatory reason; the row stays in the DB for the chain.

- **Hazard codes** are `H-` + a monotonic per-workplace counter; computed in the API at insert time so they're reproducible.
- **Encrypted fields** use the `@jhsc/crypto` envelope: per-row DEK sealed under the KEK; the column pair `(*_ct, *_dek_ct)` carries the ciphertext + sealed DEK. Read paths re-derive plaintext through `openEnvelope` (existing helper). Encryption applies to `description`, `reporter_identity`, `location_detail`, and `hazard_status_history.reason`.
- **No `linked_action_item_id` column yet.** ARCHITECTURE.md §"Hazards (Unchanged)" mentions it, but action_items lands in 1.6; the column lands in the 1.6 migration so we don't ship dead schema in 1.5.

### API surface

`apps/api/src/routes/hazards/`:

- `POST /api/hazards` — create. Body: `{ title, description, severity, location_zone?, location_detail?, jurisdiction, reporter_identity? }`. Returns the projected hazard DTO. Emits `hazard.created` audit event.
- `GET /api/hazards` — list. Query: `status[]?, severity[]?, q?, limit?, offset?`. Returns projections with description PI redacted to a short safe summary (first 80 chars of decrypted body trimmed at a word boundary; no `reporter_identity`).
- `GET /api/hazards/:id` — full detail. Returns the decrypted description + reporter identity (per the request actor's role) + status history with reasons.
- `PATCH /api/hazards/:id/status` — transition. Body: `{ to_status, reason? }`. Validates the transition matches the allowed-graph; emits `hazard.status_changed`. Step-up required for `withdrawn` and for any transition out of `resolved`/`archived`.

No DELETE endpoint. Withdrawn is the cancellation path; the row is never deleted.

### Encryption boundary

Apply the envelope sealing **inside the route handler** before the DB write — keep encryption out of Drizzle's serialization layer so a future "where did we decide to seal X" question is answerable by reading one file (`apps/api/src/hazards/crypto.ts`). The handler reads the KEK from env, seals each field with a fresh DEK, and writes the `(ct, dek_ct)` pairs verbatim. The reverse on read.

### Audit-chain events

Two new kinds added to `packages/shared-types` `AuditEventKind` + `AuditPayload`:

```ts
| { readonly kind: 'hazard.created'; readonly hazardId: string; readonly hazardCode: string;
    readonly severity: 'critical'|'high'|'medium'|'low'; readonly jurisdiction: 'ON'|'CA' }
| { readonly kind: 'hazard.status_changed'; readonly hazardId: string; readonly hazardCode: string;
    readonly fromStatus: string; readonly toStatus: string }
```

Note no PI in either payload. Reasons live in `hazard_status_history.reason_ct` (encrypted at rest); the chain row carries only the status transition.

### Web surfaces

- `/hazards` — list view (card-list mobile, table-on-desktop is deferred until 1.10 since the card list scales to ~200 rows). Filters: status, severity. Sort: reported_at desc default. Search: title contains.
- `/hazards/new` — intake form. Mobile-first single column; sticky bottom "Submit" button; the form lives on its own route (not a modal) so a back gesture preserves state via the URL.
- `/hazards/:id` — detail. Mobile: full screen. Desktop: slide-over from the list. Shows description (decrypted), reporter identity (decrypted if the actor is authorized), severity, status, location, status history with chain-anchored hashes, audit drawer.
- `<HazardStatusBadge />`, `<SeverityDot />`, `<HazardCard />` primitives lift to `apps/web/src/hazards/components/` (not `packages/ui` yet — same rationale as 1.4 CitationRef; lifts to packages/ui when a second app needs them).

### Implementer slices

- **S1: shared types + schema package.** `packages/shared-types` adds `HazardSeverity` / `HazardStatus` / hazard audit payloads. `apps/api/src/db/schema.ts` adds the two tables. Migration 0004. Slice ships with the Drizzle schema, types, validators, no routes yet. Tests: enum exhaustiveness; status-graph allowed transitions in a pure-function helper.
- **S2: crypto helper + routes.** `apps/api/src/hazards/crypto.ts` (envelope seal/open for the four encrypted fields). `apps/api/src/routes/hazards/` with the four endpoints above. Tests: integration suite covering create+read+list+transition, encryption round-trip, audit emission, transition rejection, step-up requirement.
- **S3: web — list + intake form.** `/hazards` route mounted, `<HazardsView />` with filters/sort/search. `/hazards/new` route with the intake form. Tests: jsdom RTL for empty state, list rendering, filter interaction, form submit → optimistic add.
- **S4: web — detail + status workflow.** `/hazards/:id`. Status transition UI with reason prompt. `<CitationRef />` rendered in description if the rep includes a citation. Tests: detail render, transition success path, step-up modal path.
- **S5: independent security + privacy review.** Same pattern as 1.4 slice 5.

## Consequences

### Positive

- CLAUDE.md non-negotiable #2 + #4 land at the worker-data boundary: the column-level envelope pattern from 1.3 is reused without bespoke crypto on this surface.
- Status changes become first-class chain events — the s.9-style "what did the JHSC do about hazard H-47?" audit question is answerable from `audit_log` alone.
- The mobile-first form + card list match the prototype verbatim, so the design vocabulary the rep already knows from spreadsheets transfers.

### Negative / accepted tradeoffs

- **No assignee FK in 1.5.** A free-text owner field would let a rep type a real person's name into a non-encrypted column — refused under non-negotiable #1. The decision: defer the owner relation to 1.6 when action items ship and bring it under audit-chained assignment.
- **Search is title-only.** Full-text search over description ciphertext is impossible without a server-side decrypt sweep. Title is non-encrypted by design (≤120 chars, no PI per intake form copy). Description FTS is a 2.x line item — by then we'll have client-side search index or a separately-keyed search projection.
- **No DELETE.** A rep who reports a hazard then realizes it's a duplicate has to use `withdrawn`. Avoids a "deleted by mistake, regulator wants to see it" failure mode.

### Risks

- **Reporter identity decryption boundary.** Anyone with API access to `/api/hazards/:id` sees the reporter's identity. Mitigation: the read route requires an authenticated session; step-up required to view reporter identity at all (T-H4 in SECURITY.md §2.5). For 1.5 every authenticated rep is the same trust level (single co-chair workplace per CLAUDE.md non-negotiable); the role check is a forward seam.
- **Status transition skew.** A handler bug that lets `open → archived` skip the workflow loses the JHSC discipline. Mitigation: the allowed-transitions graph is a pure function (S1) tested independently and the routes use it directly.
- **Audit-chain integration during creation.** A failed insert that leaves an orphan `hazard.created` chain row would surface as a verify divergence on the next sweep. Mitigation: hazard insert + chain emit run inside one `db.transaction`; the audit-chain `append()` (1.3) uses `pg_advisory_xact_lock` so concurrency stays serialized.

## Compliance check

- [x] Aligns with `.context/constraints.md` — no cross-border transfer, no new subprocessor, Ontario residency unchanged.
- [ ] Threat model updated — **follow-up: threat-modeler appends SECURITY.md §2.5 "Hazards" with T-H1..T-Hn.**
- [x] No new subprocessor.
- [x] CLAUDE.md non-negotiables #1 (no names), #2 (evidence-grade), #4 (encryption), #12 (action items first-class) honored.
- [x] WCAG 2.2 AA — intake form is single-column with explicit labels; transition UI uses focusable buttons.

## Follow-ups

- [ ] Threat-modeler: SECURITY.md §2.5 — hazard threats + mitigations.
- [ ] S1: shared-types + schema + migration 0004.
- [ ] S2: hazards crypto helper + routes + integration tests.
- [ ] S3: web list + intake form.
- [ ] S4: web detail + status workflow.
- [ ] S5: security + privacy reviewers.
- [ ] Runbook: `docs/runbooks/hazards.md` covering encryption rotation impact, withdrawn-row procedure, chain-tamper response specific to hazards.
- [ ] `.context/decisions.md` entry.
