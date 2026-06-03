# ADR-0012: Meeting Lifecycle (meetings + sections + attendance + inspection review + signers)

Status: Accepted, Milestone 2.1
Date: 2026-06-03
Authors: codifies Milestone 2.1 architect-phase decisions; pairs with `SECURITY.md` §2.13 (forthcoming, threat-modeler agent in parallel) and `docs/runbooks/meetings.md` (forthcoming, S5).

## Context

The Excel workbook is what the rep replaces with Release 2. Release 1 (ADR-0001 through ADR-0011) shipped the substrate: auth + step-up, envelope encryption, the tamper-evident chain, the legal corpus, hazards, action items as a first-class entity per CLAUDE.md non-negotiable #12, evidence capture, template-versioned inspections per non-negotiable #13, the Notice-of-Recommendation s.9(20) flow, the offline-first sync queue per ADR-0009, the Excel import path per ADR-0010, and the 1.12 release-hardening capstone. The placeholder Minutes view at `apps/web/src/views/minutes-view.tsx` is the canonical landing surface declared by `apps/web/src/lib/tabs.ts:34-41` and CLAUDE.md "Minutes-centric." 2.1 is the milestone where it stops being a placeholder.

The Minutes module is the operational hub per `ARCHITECTURE.md` §2 ("Meetings ... where action items live, age, and move between sections under the 21-day s.9(21) clock") and `ARCHITECTURE.md` §"Meetings" (lines 183-239 sketch a `meetings` + `meeting_attendance` + `meeting_sections` + `meeting_inspection_review` shape). The 1.6 action-items ADR (`docs/adr/0005-action-items.md` §"Tables") already laid the seam: `action_items.meeting_id` is a nullable `uuid` whose FK was deliberately deferred until the `meetings` table existed; the 1.6 `action_item_moves.meeting_id` carries the same deferral. ROADMAP.md lines 183-198 enumerate the milestone scope: `meetings` table + Drizzle schema, `meeting_sections` table (typed sections), `meeting_attendance` table, `meeting_inspection_review` table, meeting creation flow, agenda template (10 standing items, time allocations), live meeting view (mobile-primary), attendance capture (Union / Management / Guest, present / regrets), section-by-section workflow, adjournment with auto-generated key metrics, minutes finalization (counter-signed by 4 signers: Worker Co-Chair, Mgmt Co-Chair, Warehouse Mgr, Plant Mgr).

Three things make 2.1 different from anything Release 1 has shipped:

1. **It is the FIRST entity whose primary surface is a live, in-meeting view, not a CRUD list.** Hazards, action items, inspections, and recommendations all have list-then-detail surfaces; 2.1 ships a `live meeting view` at `/meetings/:id` where the rep navigates section-by-section over a 60-90 minute meeting and the UI is the moment-of-truth for capture. The mobile primary requirement (CLAUDE.md non-negotiable #9) is acute here — the rep is in the meeting room with a phone, not at a desk with a laptop. The interaction shape is closer to a Things 3 / Notion mobile checklist than to a CRUD form.
2. **Meetings REFERENCE action items; they do not OWN them.** CLAUDE.md non-negotiable #12 is the load-bearing invariant: action items are first-class. The 2.1 surface does not move action items under meetings; it captures the MOMENT-IN-TIME STATE of an action item AT a meeting (the row's status / section / assignee at the time the agenda item was discussed). When the meeting is finalized, that snapshot is the immutable record. The live action item continues to evolve outside the meeting; the meeting record preserves what was true at the meeting. The PDF in 2.3 renders the snapshot, not the live row.
3. **Finalization is a 4-signature workflow where 3 signers are EXTERNAL to the app.** Worker Co-Chair, Mgmt Co-Chair, Warehouse Mgr, Plant Mgr — only the first is an in-app actor (the rep). The other three are employer-side roles; the rep collects their sign-off off-app (paper, email, signed PDF) and records the evidence in-app. This is the structural extension of CLAUDE.md non-negotiable #6 (no employer infrastructure dependencies) — the app does not require the employer to install or authenticate; the rep is the custodian who records what the off-app signers attested. The chain anchors what the rep recorded; the recipient verifies that the rep recorded a paper-signature scan, not that the paper signature is itself unforgeable. Same posture as the recommendation export (ADR-0008 §3.7) where the workplace signs the export but the recipient is offline.

`apps/web/src/views/minutes-view.tsx` is the current placeholder this ADR replaces. `apps/web/src/lib/tabs.ts` is unchanged — Minutes remains the first tab, the bottom-tab landing on mobile. `apps/api/src/db/schema.ts:418-513` (action_items + action_item_moves) is the existing table the meeting FK now reaches. `apps/api/src/db/schema.ts:854-1010` (recommendations + linkage tables) is where a new `meeting_id` FK lands on `recommendations` for the in-meeting drafting path. `apps/api/src/db/schema.ts:632-731` (inspections + inspection_findings) is the surface the new `meeting_inspection_review` table references. `config/workplace.ts` is the source of the four signer ROLE names (per non-negotiable #1); the per-meeting display names per role come from `meeting_attendance` rows. ADR-0007 (inspections, template versioning at conduct time, three-signature workflow) and ADR-0008 (recommendations, status-machine lifecycle, audit-anchored state transitions, export signing) are the closest size + shape precedents. ADR-0009 (offline sync, optimistic UI with `If-Match` etag, `clientId` body field) is the cross-cutting substrate every new route consumes. ADR-0010 (Excel import, batch transactional commit, step-up on commit) is the closest precedent for "an operation that flips the canonical state and emits a high-value chain anchor."

## Decision

Land four new tables (`meetings`, `meeting_sections`, `meeting_attendance`, `meeting_inspection_review`) plus three supporting tables (`meeting_templates` for the agenda template version, `meeting_action_item_state` for the per-meeting snapshot of an action item's state, `meeting_signatures` for the 4-signer counter-sign workflow), extend `action_items` with `first_raised_meeting_id` (nullable FK), extend `recommendations` with `meeting_id` (nullable FK) so the in-meeting drafting path links the recommendation to the meeting it was raised in, ship a `meeting_templates` seed (the canonical 12-section agenda template at version 1) parallel to `seed-inspection-templates.ts`, land the eleven new API routes that drive the lifecycle, build the mobile-primary live meeting view + the 4-signer finalization surface, emit eleven new `AuditEventKind` values for the chain, and integrate the new POST routes into the 1.10 `Idempotency-Key` middleware + `clientId` body-field pattern verbatim. Sensitive fields (co-chair notes, section notes, attendee display names, signer display names, signature evidence) are envelope-encrypted via the same `@jhsc/crypto` shape the 1.5-1.11 surfaces use; `display_name_envelope` mirrors the `(display_name_ct, display_name_dek_ct)` pair convention. Step-up is required for creating a meeting, adjourning, finalizing, recording a signature, and importing pre-meeting drafts; step-up is NOT required for routine section moves, note capture, or attendance toggling (those are operational; step-up every time would break the in-meeting flow per non-negotiable #9). The chain anchors every meeting lifecycle transition; the four signature events anchor independently. Action items are NOT moved under meetings — they continue to live as first-class entities per non-negotiable #12; the `meeting_action_item_state` snapshot is the immutable record of state-at-meeting. The recommendation drafting path inside a meeting is the existing 1.9 surface with a `meeting_id` parameter; no new recommendation lifecycle. The inspection-review path inside a meeting is a new `meeting_inspection_review` row that links an existing 1.8 inspection to the meeting; the inspection itself is not modified. The agenda template is version-pinned at meeting creation time (the same pattern as ADR-0007 §3.1 for inspections per non-negotiable #13); an inspection template v1 inspection stays under v1 forever, and an agenda template v1 meeting stays under v1 forever. Quorum is computed live from `meeting_attendance` per the OHSA s.9(7-8) rule; the legal corpus carries the rule text (added in S1 if not already present per ADR-0003). Finalization is gated on all four `meeting_signatures` rows being present; until then the meeting sits in `pending_finalization`. The 4-6 week real-world-use window between 1.12 deploy and 2.1 start (per ROADMAP.md line 175) is the operational context — the rep has been using the imported Excel minutes for a quarter; 2.1 is the milestone where the next quarter's minutes are native.

### 3.1 Tables (Drizzle schema design)

Seven tables land in `apps/api/src/db/schema.ts` + `migrations/0011_meeting_lifecycle.sql` (next-in-sequence, append-only per CLAUDE.md migration rules). Primary key strategy is `clientId`-as-primary per ADR-0009 §3.3 — UUIDv7 client-generated at create time (the existing pattern; the chain anchor binds to the same uuid end-to-end). Each table that mutates carries a `version integer not null default 1` column for the 1.10 `If-Match` optimistic-concurrency ratchet per ADR-0009 §3.7, and an `audit_idx bigint not null references audit_log(idx)` per ADR-0002 anchoring discipline. Encrypted columns use the `(*_ct, *_dek_ct)` envelope pair shape from `@jhsc/crypto` — sealed under the workplace KEK (XChaCha20-Poly1305 + Argon2id, the master key in Fly Secrets per CLAUDE.md Encryption Rules).

#### `meetings`

```
meetings (
  id                       uuid primary key default gen_random_uuid(),  -- clientId-overridable per 3.4
  workplace_singleton      smallint not null default 1 check (workplace_singleton = 1),  -- single-tenant marker (#1)
  meeting_date             date not null,
  location                 text,                                          -- non-PI; "Boardroom A" / "Teams" / etc.
  scheduled_start_at       timestamptz not null,
  scheduled_end_at         timestamptz not null,
  actual_start_at          timestamptz,                                   -- set on first "Start meeting" tap
  actual_end_at            timestamptz,                                   -- set on adjourn
  agenda_template_id       uuid not null references meeting_templates(id) on delete restrict on update restrict,
  status                   text not null default 'scheduled'
                             check (status in ('scheduled','in_progress','adjourned','pending_finalization','finalized','archived')),
  current_section_id       uuid references meeting_sections(id) on delete set null,  -- where the co-chair is right now
  created_by_actor_id      uuid not null references users(id) on delete restrict on update restrict,
  notes_envelope_ct        bytea,                                         -- co-chair private notes; nullable
  notes_envelope_dek_ct    bytea,
  audit_idx                bigint not null references audit_log(idx) on delete restrict on update restrict,
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
```

Indexes: `meetings_meeting_date_idx` on `(meeting_date desc)` for the chronological list; `meetings_status_idx` on `status` for the "active meeting" lookup; `meetings_audit_idx_unique` UNIQUE on `audit_idx` per the per-entity audit-anchor invariant (mirrors `recommendations_audit_idx_unique` at `schema.ts:892`). CHECK constraints: `meetings_one_active_check` partial UNIQUE on `(workplace_singleton)` WHERE `status in ('in_progress','pending_finalization')` — at most ONE active meeting at a time per non-negotiable #1 single-tenant scope; the rep cannot accidentally start a second meeting while the first is mid-flow. Pair-NULL CHECK on `(notes_envelope_ct, notes_envelope_dek_ct)` (both NULL or both NOT NULL — same pattern as ADR-0007 §3.6 for finding notes). Lifecycle CHECK enforces `actual_start_at IS NOT NULL when status NOT IN ('scheduled')`, `actual_end_at IS NOT NULL when status IN ('adjourned','pending_finalization','finalized','archived')`. Cascade: deleting a meeting CASCADES to `meeting_sections`, `meeting_attendance`, `meeting_inspection_review`, `meeting_action_item_state`, `meeting_signatures` per §3.1 cascade rules below; but meeting deletes are restricted at the route layer to `archived` status only (a finalized meeting is evidentially load-bearing — the chain row remains regardless).

#### `meeting_sections`

```
meeting_sections (
  id                       uuid primary key default gen_random_uuid(),
  meeting_id               uuid not null references meetings(id) on delete cascade on update restrict,
  section_type             text not null
                             check (section_type in (
                               'call_to_order','roll_call_quorum','minutes_review',
                               'inspections_review','incident_review','complaints_review',
                               'old_business','new_business','recommendations',
                               'other_business','next_meeting','adjournment'
                             )),
  order_idx                smallint not null check (order_idx >= 0 and order_idx <= 31),
  started_at               timestamptz,
  ended_at                 timestamptz,
  time_allocation_minutes  smallint not null,                             -- snapshot from template at create time
  notes_envelope_ct        bytea,
  notes_envelope_dek_ct    bytea,
  audit_idx                bigint not null references audit_log(idx) on delete restrict on update restrict,
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
```

Indexes: `meeting_sections_meeting_order_unique` UNIQUE on `(meeting_id, order_idx)` — the sequential render's structural backstop (no two sections share the same order within a meeting); `meeting_sections_meeting_idx` on `meeting_id` for the live-view fetch; `meeting_sections_audit_idx_unique` UNIQUE on `audit_idx`. Pair-NULL CHECK on `(notes_envelope_ct, notes_envelope_dek_ct)`. Section-type-unique CHECK is INTENTIONALLY NOT enforced at the DB level (the agenda template may include multiple `other_business` sections, and a custom template version could repeat structural sections) — the template's `requireUniqueTypes` JSON flag is the source of truth, validated at the route layer. The 12 section_type values mirror the canonical agenda per §3.3.

**Section type count reconciliation.** The user's brief listed 12 section types; ROADMAP.md line 192 said "10 standing items"; ARCHITECTURE.md §"Meeting Sections" line 221 listed 7 + custom. The 2.1 milestone settles on 12 standing types (the structural enum + the template defines which subset appears at this version). The 12 cover the canonical Robert's-Rules / JHSC-shape agenda; the v1 template at S4 instantiates 10 of them (omitting `incident_review` and `complaints_review` as instance-optional sections that the template v2 may add). The OPTION to add custom sections is dropped from 2.1 scope — `section_type` is a closed enum to keep the chain payload's `meeting.section.added` shape PI-free; custom-name sections would require a `display_name_envelope` column (PI risk), which lands as a forward seam for 2.4 or later.

#### `meeting_attendance`

```
meeting_attendance (
  id                       uuid primary key default gen_random_uuid(),
  meeting_id               uuid not null references meetings(id) on delete cascade on update restrict,
  role                     text not null check (role in
                             ('worker_co_chair','mgmt_co_chair','worker_rep','mgmt_rep','guest')),
  party                    text not null check (party in ('union','management','guest')),
  display_name_ct          bytea not null,                                -- ENCRYPTED (#1 + #4)
  display_name_dek_ct      bytea not null,
  attendee_user_id         uuid references users(id) on delete restrict on update restrict, -- nullable; in-app actor when role=worker_co_chair
  present_status           text not null default 'present'
                             check (present_status in
                               ('present','regrets','absent_unexcused','late_arrival','early_departure')),
  arrived_at               timestamptz,                                   -- set when status=late_arrival
  departed_at              timestamptz,                                   -- set when status=early_departure
  audit_idx                bigint not null references audit_log(idx) on delete restrict on update restrict,
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
```

Indexes: `meeting_attendance_meeting_idx` on `meeting_id` for live quorum compute; `meeting_attendance_role_idx` on `(meeting_id, role)` for the finalization lookup (the worker_co_chair attendance row is the in-app signer); `meeting_attendance_audit_idx_unique` UNIQUE on `audit_idx`. **CRITICAL — non-negotiable #1 + #4:** `display_name_ct` is mandatory (no nullable display name; every attendee is identified). The DB never sees the plaintext name. The `attendee_user_id` FK is populated ONLY for the worker_co_chair role (the in-app rep) and only when that role's attendee is the authenticated user; every other row's user_id is NULL because mgmt co-chair, mgmt reps, and guests are not in-app users (per non-negotiable #6 — no employer SSO). Lifecycle CHECK: `arrived_at IS NOT NULL WHEN present_status='late_arrival'`; `departed_at IS NOT NULL WHEN present_status='early_departure'`. Role-uniqueness for the two co-chair roles: `meeting_attendance_one_worker_co_chair_unique` partial UNIQUE on `(meeting_id)` WHERE `role='worker_co_chair'` (exactly one worker co-chair per meeting); same for `mgmt_co_chair`. Worker_rep / mgmt_rep / guest roles are unbounded.

#### `meeting_inspection_review`

```
meeting_inspection_review (
  id                       uuid primary key default gen_random_uuid(),
  meeting_id               uuid not null references meetings(id) on delete cascade on update restrict,
  inspection_id            uuid not null references inspections(id) on delete restrict on update restrict,
  reviewed_at              timestamptz not null default now(),
  outcome                  text not null check (outcome in
                             ('accepted_as_complete','findings_promoted','deferred')),
  notes_envelope_ct        bytea,
  notes_envelope_dek_ct    bytea,
  audit_idx                bigint not null references audit_log(idx) on delete restrict on update restrict,
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
```

Indexes: `meeting_inspection_review_meeting_idx` on `meeting_id`; `meeting_inspection_review_inspection_idx` on `inspection_id`; `meeting_inspection_review_meeting_inspection_unique` UNIQUE on `(meeting_id, inspection_id)` — one review row per (meeting, inspection) pair; `meeting_inspection_review_audit_idx_unique` UNIQUE on `audit_idx`. Pair-NULL CHECK on `(notes_envelope_ct, notes_envelope_dek_ct)`. The link is uni-directional — the inspection row itself is not modified (an inspection's state is governed by ADR-0007 §3.1 lifecycle, not by the meeting). The `outcome` field captures the meeting's verdict, not a state change on the inspection. `findings_promoted` is a documentary tag; the actual promotion to an action item still goes through the existing 1.8 `POST /api/inspections/findings/:id/promote` route per ADR-0007 §3.7 and CLAUDE.md non-negotiable #15.

#### `meeting_templates` (per §3.3)

```
meeting_templates (
  id                       uuid primary key default gen_random_uuid(),
  template_code            text not null,                                 -- 'jhsc_standard_v1' / 'jhsc_compact_v1' etc.
  version_number           integer not null check (version_number >= 1),
  name                     text not null,                                 -- display name; non-PI ("JHSC Standard Agenda")
  jurisdiction             text not null check (jurisdiction in ('ON','CA-FED')),
  sections                 jsonb not null,                                -- canonical 12-section list w/ time allocations
  default_total_minutes    smallint not null,                             -- sum of allocations; sanity bound
  retired_at               timestamptz,
  created_at               timestamptz not null default now(),
  created_by_user_id       uuid references users(id) on delete set null on update restrict,
  unique (template_code, version_number)
);
```

Append-only versioning per non-negotiable #13 (same posture as `inspection_templates` at `schema.ts:596-625`). Partial UNIQUE on `(template_code)` WHERE `retired_at IS NULL` enforces at most one active version per code. `sections` JSONB carries `[{ section_type, order_idx, time_allocation_minutes, label_override? }]` with Zod validation on insert (the seed is the only insert path in 2.1; route-layer create is deferred to a later milestone). Indexes: `meeting_templates_code_idx` on `template_code`; `meeting_templates_code_version_unique` UNIQUE on `(template_code, version_number)`. No `audit_idx` column — the template seed itself anchors via `audit.meeting_template.seeded` (a new audit kind per §3.10) at the package level, same shape as `audit.inspection_template.seeded`.

#### `meeting_action_item_state` (the snapshot per §3.2)

```
meeting_action_item_state (
  id                       uuid primary key default gen_random_uuid(),
  meeting_id               uuid not null references meetings(id) on delete cascade on update restrict,
  action_item_id           uuid not null references action_items(id) on delete restrict on update restrict,
  snapshot_status          text not null,                                 -- action_items.status at meeting time
  snapshot_section         text not null,                                 -- action_items.section at meeting time
  snapshot_assignee_ct     bytea,                                         -- encrypted follow_up_owner name
  snapshot_assignee_dek_ct bytea,
  snapshot_assignee_user_id uuid references users(id) on delete restrict on update restrict, -- when assignee is in-app
  snapshot_target_date     date,
  snapshot_at              timestamptz not null default now(),
  snapshot_kind            text not null default 'live' check (snapshot_kind in ('live','finalized')),
  audit_idx                bigint not null references audit_log(idx) on delete restrict on update restrict,
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
```

Indexes: `meeting_action_item_state_meeting_idx` on `meeting_id`; `meeting_action_item_state_action_item_idx` on `action_item_id`; `meeting_action_item_state_meeting_kind_idx` on `(meeting_id, snapshot_kind)`; `meeting_action_item_state_audit_idx_unique` UNIQUE on `audit_idx`. Partial UNIQUE on `(meeting_id, action_item_id, snapshot_kind)` WHERE `snapshot_kind='finalized'` — exactly one finalized snapshot per (meeting, action_item) pair; the route-layer can write multiple `live` snapshots during the meeting (as the rep refreshes the view), but on adjournment the route promotes the latest live snapshot to a finalized snapshot in a transaction. Pair-NULL CHECK on `(snapshot_assignee_ct, snapshot_assignee_dek_ct)`. Lifecycle: `live` snapshots are computed-on-read during `in_progress`; `finalized` snapshots are immutable after the meeting's `actual_end_at` is set. The §3.2 design justifies why this beats a "freeze at meeting close" denormalization.

#### `meeting_signatures` (the 4-signer counter-sign per §3.9)

```
meeting_signatures (
  id                       uuid primary key default gen_random_uuid(),
  meeting_id               uuid not null references meetings(id) on delete cascade on update restrict,
  signer_role              text not null check (signer_role in
                             ('worker_co_chair','mgmt_co_chair','warehouse_mgr','plant_mgr')),
  signer_display_name_ct   bytea not null,                                -- ENCRYPTED (#1)
  signer_display_name_dek_ct bytea not null,
  signer_user_id           uuid references users(id) on delete restrict on update restrict,  -- worker_co_chair only
  signed_at                timestamptz not null default now(),
  signed_method            text not null check (signed_method in
                             ('in_app_passkey','paper_attestation','email_attestation')),
  evidence_envelope_ct     bytea,                                         -- scan of paper / email body; nullable for in_app_passkey
  evidence_envelope_dek_ct bytea,
  evidence_storage_key     text,                                          -- Tigris key for the scan blob; nullable
  step_up_jti              text,                                          -- only populated for in_app_passkey
  audit_idx                bigint not null references audit_log(idx) on delete restrict on update restrict,
  created_at               timestamptz not null default now()
);
```

Indexes: `meeting_signatures_meeting_role_unique` UNIQUE on `(meeting_id, signer_role)` — exactly one signature per role per meeting (T-M-class invariant; the finalization gate counts rows); `meeting_signatures_audit_idx_unique` UNIQUE on `audit_idx`; `meeting_signatures_meeting_idx` on `meeting_id`. Method-shape CHECK: `signed_method='in_app_passkey' IMPLIES (step_up_jti IS NOT NULL AND signer_user_id IS NOT NULL AND evidence_envelope_ct IS NULL)`; `signed_method IN ('paper_attestation','email_attestation') IMPLIES (evidence_envelope_ct IS NOT NULL AND evidence_envelope_dek_ct IS NOT NULL)`. Pair-NULL CHECK on `(evidence_envelope_ct, evidence_envelope_dek_ct)`. The Tigris `evidence_storage_key` is set when the rep uploads a scan; the bytes live in the Tigris bucket per ADR-0006 §3, the row carries the integrity anchor. Append-only — no UPDATE path on signature rows (a correction is a new signature with `signed_method='paper_attestation'` overwriting the old via the meeting-roll-up logic; the old row stays as evidence of the correction sequence, surfacing in the chain).

#### Action item + recommendation table extensions

The migration adds two columns to existing tables:

- `action_items.first_raised_meeting_id uuid references meetings(id) on delete set null on update restrict` — the meeting where this item was first raised; NULL for items imported from Excel (per ADR-0010 — the import's source is the workbook, not a meeting) or for items raised pre-meeting (created from the action-items list view directly). The existing `meeting_id` column on `action_items` (`schema.ts:456`) carries a DIFFERENT semantic: per ADR-0005 it tags the CURRENT meeting the item is being discussed in. The 2.1 migration leaves `meeting_id` as-is (FK semantics finally activated, pointing at the new `meetings` table; the column has been a placeholder uuid since 1.6) and ADDS the new `first_raised_meeting_id`. The two are deliberately separate: `first_raised_meeting_id` is immutable (provenance); `meeting_id` is mutable (operational context). The 1.6 `action_item_moves.meeting_id` (`schema.ts:503`) becomes a real FK to `meetings(id)` in the same migration.
- `recommendations.meeting_id uuid references meetings(id) on delete set null on update restrict` — the meeting where this recommendation was drafted; NULL for recommendations drafted outside a meeting (the existing 1.9 surface). Same forward-seam idea — it lets the 2.3 PDF generator render "drafted in meeting of 2026-Q3" if the recommendation was raised in a meeting.

Both column additions are nullable so the existing 1.5-1.11 data does not need backfill; the new FKs are populated when the in-meeting create paths fire.

#### Cascade rules

- DELETE `meetings` CASCADES to `meeting_sections`, `meeting_attendance`, `meeting_inspection_review`, `meeting_action_item_state`, `meeting_signatures`. The route layer restricts DELETE to `archived` status; finalized meetings have evidentiary value and stay.
- DELETE `meeting_sections` CASCADES to nothing (sections do not own external rows; the `meeting_action_item_state` rows reference the meeting directly, not the section).
- DELETE `action_items` is RESTRICTED if any `meeting_action_item_state` references it (same posture as ADR-0007 §3.6 for promoted findings — once an action item is in a finalized meeting record, the meeting depends on it).
- DELETE `inspections` is RESTRICTED if any `meeting_inspection_review` references it.

#### Audit-chain integration

Every write to a meeting-lifecycle row emits a chain anchor via `@jhsc/audit`'s `append()` call inside the route's transaction; the inserted row's `audit_idx` FK locks the row to the chain entry (the inspection ADR-0007 §3.6 pattern). Eleven new `AuditEventKind` values land in `packages/shared-types/src/index.ts` (per §3.10): `meeting.created`, `meeting.section.added`, `meeting.attendance.recorded`, `meeting.attendance.updated`, `meeting.section.note_captured`, `meeting.action_item_state_snapshot`, `meeting.inspection_reviewed`, `meeting.adjourned`, `meeting.signature.recorded`, `meeting.finalized`, `audit.meeting_template.seeded`. Each kind's payload shape lands in the `AuditPayload` discriminated union in `shared-types`, with the standard "no PI in chain payloads" rule (T-AC9-class) — names are NEVER in payloads; the chain carries IDs + counts + hashes only. Section move audit re-uses the existing `action_item.moved` kind from ADR-0005 §3 — the meeting context is recorded via the row's existing `meeting_id` reference, not a new kind.

**Migration file path:** `migrations/0011_meeting_lifecycle.sql`. Append-only per the CLAUDE.md migration rule. Down-migration is the standard "we don't ship down migrations" stance.

### 3.2 Action item ↔ meeting linkage (preserving non-negotiable #12)

Action items are first-class. CLAUDE.md non-negotiable #12 makes this load-bearing: "_Action items have first-class status. They are not a sub-concept of hazards. Hazards, recommendations, and meeting outputs can all become or link to action items, but action items are their own entity with their own lifecycle._" 2.1 extends the same posture to meetings — action items are NOT a sub-concept of meetings either. Meetings REFERENCE action items; meetings do not OWN them.

The linkage shape is three-layered:

**Layer 1 — Provenance.** `action_items.first_raised_meeting_id` is the immutable "this item was first raised in meeting X" FK. It is set at create time (when the rep taps "+ Add action item" inside the live meeting view) and never changes. It is NULL for items imported from Excel (per ADR-0010, the source is the workbook) and for items raised from the action-items list view directly (no in-meeting context). It is a documentary surface — the PDF in 2.3 will render "First raised: 2026-Q3 meeting" alongside the item.

**Layer 2 — Operational.** `action_items.current_section` already exists from 1.6 (per `packages/shared-types/src/index.ts:176` — `'new_business' | 'old_business' | 'recommendation' | 'completed_this_period' | 'archived'`). The 1.6 lifecycle is unchanged. The section semantics are the OPERATIONAL section the item is in across meetings — a `new_business` item raised in Q3 becomes `old_business` at Q4 if it's still open. The 2.1 `meeting_sections.section_type` enum (per §3.1) overlaps with the action_items section vocabulary intentionally for `old_business`, `new_business`, `recommendations` — these are the three section types that hold action items during a meeting. The other 9 meeting sections (call_to_order, roll_call_quorum, minutes_review, inspections_review, etc.) do NOT hold action items as their primary content (they hold notes + structured sub-data). The agreed semantics: when the rep navigates to the `new_business` meeting section in the live view, the displayed action items are filtered by `action_items.current_section='new_business'` AND `action_items.status NOT IN ('Closed','Cancelled')`. The meeting section is a VIEW filter over action items; the action items themselves are unchanged. No new column on action_items for "which meeting section am I in"; the inference is route-side.

**Layer 3 — Snapshot at meeting time.** `meeting_action_item_state` (per §3.1) is the new table that captures the moment-in-time state of an action item AT a specific meeting. Columns: `meeting_id`, `action_item_id`, `snapshot_status`, `snapshot_section`, `snapshot_assignee_ct/dek_ct/user_id`, `snapshot_target_date`, `snapshot_at`, `snapshot_kind` (`live` or `finalized`). During a meeting in progress, the snapshot is the LIVE state (refreshed when the rep opens the section); on adjournment, the latest live snapshot is promoted to `finalized` in a transaction; the finalized row is immutable. The PDF in 2.3 renders the FINALIZED snapshot, not the current live action item.

**Why a snapshot table beats "freeze at meeting close" denormalization.** Three trade-offs justify the separate table over a denormalized "finalized_minutes_json" blob on the meeting row:

1. **Per-item provenance for arbitration.** A hostile arbitrator six months from now reads the chain and asks: "what was action item AI-2026-014 at the moment the 2026-Q3 meeting adjourned?" A snapshot row answers this directly with its own `audit_idx` anchor. A denormalized JSON blob on the meeting row makes the question harder — the rep would have to extract the item from a blob and prove the blob was not tampered with. The per-row chain anchor is cleaner.
2. **In-meeting reflection of mid-meeting changes.** During the live meeting, the rep moves an action item from `new_business` to `recommendation`. The action item's `current_section` updates in real time (per ADR-0005 §3 swipe interaction). The snapshot table can capture the IN-MEETING progression (multiple `live` snapshots over the meeting's duration) so the PDF can render "raised in new_business; moved to recommendation during the meeting" — a freeze-at-close denormalization loses this history. The 2.2 milestone (in-meeting action item management) consumes this directly.
3. **Decoupling from the action item's continued evolution.** After the meeting, the action item keeps moving — the rep updates status, changes assignee, etc. The meeting's finalized record must NOT change. A snapshot table is structurally immutable per the `meeting_signatures`-style append-only invariant. A "freeze at close" denormalization would require either copying the action item's state into a blob (same complexity as the snapshot table, fewer guarantees) or marking the action item itself as frozen (which would break non-negotiable #12 — the action item must keep evolving).

**Cost.** The snapshot table grows with `meetings × open_action_items`. A typical quarterly meeting reviews 30-50 open items + 5-10 new items; over 4 meetings per year × 10 years that is ~2000 snapshot rows per action item. At single-tenant scale this is negligible. The route layer projects the SNAPSHOT plus the LIVE action item side-by-side in the in-meeting view so the rep sees both.

**The action_item.moved event is the cross-table chain.** Per ADR-0005 §3, every section move emits `action_item.moved` with the meeting_id in the payload. The 2.1 surface does not replace this — section moves inside the live meeting view still emit `action_item.moved`. The `meeting.action_item_state_snapshot` event is emitted ONLY when the snapshot row is INSERTED or UPDATED (new live snapshot, or promotion to finalized at adjournment). The two chains compose: the action item's section move history is queryable via `action_item.moved`; the meeting-time state is queryable via `meeting.action_item_state_snapshot`. The PDF generator in 2.3 will query both.

### 3.3 Agenda template (10 of 12 standing items at v1)

ROADMAP.md line 192 says "Agenda template (10 standing items, time allocations)". The §3.1 enum lists 12 section types. The reconciliation: the section_type enum is 12 to leave headroom for instance-optional sections (incident_review + complaints_review), and the v1 seeded template instantiates 10 of them. The 10 in v1:

| order_idx | section_type       | time_allocation_minutes | Notes                                              |
| --------- | ------------------ | ----------------------- | -------------------------------------------------- |
| 0         | call_to_order      | 5                       | Welcome + agenda confirmation                      |
| 1         | roll_call_quorum   | 5                       | Attendance + OHSA s.9(7-8) quorum check            |
| 2         | minutes_review     | 10                      | Prior meeting minutes acceptance                   |
| 3         | inspections_review | 15                      | Workplace inspection findings                      |
| 4         | old_business       | 30                      | Open action items from prior meetings              |
| 5         | new_business       | 15                      | New action items raised this meeting               |
| 6         | recommendations    | 10                      | s.9(20) Notice of Recommendation drafting + review |
| 7         | other_business     | open                    | Anything else                                      |
| 8         | next_meeting       | 5                       | Date/location of next meeting                      |
| 9         | adjournment        | 5                       | Adjournment + key metrics generation               |

Total default duration: 100 minutes (plus open for other_business). `incident_review` and `complaints_review` are instance-optional and NOT in v1; they can be inserted ad-hoc by the rep in the live view (forward seam) or added in a v2 template.

**Time allocations as enum-driven.** Per the user's brief — time allocations are an enum (`5min | 10min | 15min | 30min | open`) stored as `time_allocation_minutes smallint` per row in `meeting_sections.time_allocation_minutes`. The `open` value is represented as `0` (zero) with a route-level rendering convention; the template's JSONB schema uses the string literal `"open"`. Time allocations are data, not free-text — the rep cannot type "20 minutes" for a section. The constraint is intentional: a template that allows arbitrary durations encourages drift (every meeting becomes a different duration mix); a closed enum forces meeting-design discipline. The cost is that a rep who wants 20 minutes for old_business uses 30 and ends early; documented.

**Template version pinning at meeting creation time.** Per CLAUDE.md non-negotiable #13 — "Inspections preserve their template version at conduct time." The same pattern applies to meetings: when a meeting is created, the agenda template version it was created under is preserved via `meetings.agenda_template_id` FK to a specific `meeting_templates.id` row. An update to the agenda template at v2 never retro-affects v1 meetings. The 12 v1 sections are immutable for any v1 meeting; a v2 meeting with reorganized sections is structurally a different shape and the migration path is the standard append-only template version add.

**The template lives in `apps/api/scripts/seed-meeting-template.ts` (new).** Parallel to `apps/api/scripts/seed-inspection-templates.ts` per the existing pattern. The seed is versioned (idempotent re-run uses `ON CONFLICT (template_code, version_number) DO NOTHING`); the v1 template ships in S4. The seed runs as part of the deploy runbook (per ADR-0011 §3.9) after the migration lands. The seed emits an `audit.meeting_template.seeded` chain event with the template_code, version_number, and the canonical-JSON hash of the sections array (so the chain proves WHICH version of the template was seeded).

**`meeting_templates` table** (per §3.1) is the storage. The S1 migration creates the table; the S4 seed populates v1.

### 3.4 Meeting creation flow

**Route:** `POST /api/meetings`. Idempotency-key required per ADR-0009 §3.4 (the route is wrapped by the existing `idempotencyKeyGuard` middleware). The handler accepts:

```ts
{
  clientId?: string;            // uuid v7 generated client-side per ADR-0009 §3.3
  meetingDate: string;          // YYYY-MM-DD
  location?: string;            // non-PI; "Boardroom A" / "Teams"
  scheduledStartAt: string;     // ISO 8601
  scheduledEndAt: string;       // ISO 8601
  agendaTemplateCode: string;   // 'jhsc_standard'
  attendeesPrefill?: PrefillAttendee[];  // see below
}
```

**Server validation:**

1. Actor's `worker_co_chair` role check. The single-tenant scope means there is one worker co-chair (the rep); the route reads the actor's role from the session and rejects with 403 `not_worker_co_chair` if the actor is not the co-chair. Per ADR-0001, the role assignment is the first-run setup step; the rep IS the worker co-chair by virtue of being the in-app user.
2. Idempotency-key cache lookup per ADR-0009 §3.4. On hit, return the cached response.
3. `clientId` collision check per ADR-0009 §3.3. On hit, return 409 `id_collision`.
4. Active-meeting check. The `meetings_one_active_check` partial UNIQUE constraint catches a concurrent insert; the route-level pre-check returns 409 `meeting_already_in_progress` with the conflicting meeting_id when there's an active meeting. The rep adjourns the active meeting first.
5. Duplicate-date check. UNIQUE constraint on `(meeting_date)` is NOT enforced at the DB level (a meeting may legitimately recur on the same date in pathological cases — e.g., a short morning meeting followed by an emergency afternoon meeting). The route layer surfaces a soft warning ("A meeting already exists for 2026-09-15; create another?") with explicit confirmation; the second create succeeds.
6. Template resolve. `agendaTemplateCode → latest non-retired meeting_templates row`. The resolved `id` is pinned to `meetings.agenda_template_id`. The template's sections are materialized into `meeting_sections` rows in the same transaction (one row per template section; `order_idx` and `time_allocation_minutes` snapshotted).

**Attendees prefill.** The optional `attendeesPrefill` array carries `[{ role, party, display_name_ct, display_name_dek_ct, attendee_user_id? }]` shapes — the BROWSER produces these by reading the prior meeting's attendance list, decrypting locally, presenting the rep with "same attendees as last time?" and re-encrypting under the workplace public key on submit. The server stores ciphertext only; the names are never plaintext on the wire. If `attendeesPrefill` is omitted, the meeting is created with zero attendance rows and the rep adds them in the roll_call_quorum section.

**Transaction shape:** `BEGIN; INSERT meetings; INSERT meeting_sections (one per template section); INSERT meeting_attendance (one per prefill, if any); INSERT audit_log; COMMIT;`. Single transaction. Failure rollback per the standard `@jhsc/audit` advisory-lock pattern from ADR-0002.

**Chain anchor:** Single `meeting.created` event with payload `{meetingId, meetingDate, agendaTemplateId, agendaTemplateVersion, sectionCount, attendeeCount, scheduledDurationMinutes}` — all IDs + counts, no PI.

**Returns:** The meeting envelope (`{id, status, sections: [...], attendance: [...], agendaTemplate: {code, version, name}}`) — the same shape `GET /api/meetings/:id` returns. The browser populates the live view.

**Step-up:** Required (per §3.10 — meeting creation is a non-routine high-value operation). The route declares `action='meeting.create'` and the freshness window is 60s per the existing inspection pattern. A stale grant returns 401 `step_up_required`.

### 3.5 Live meeting view (mobile-primary)

The hardest UX surface in 2.1. The view lives at `/meetings/:id` and is the single-page surface that drives the entire meeting. Implementation in `apps/web/src/meetings/` (new directory parallel to `inspections/`, `recommendations/`).

**Mobile (390px viewport):**

- Sticky top bar (`data-print="hide"` per the 1.12 print convention) carries the meeting metadata: date, current section indicator, elapsed time vs. scheduled, quorum status chip.
- Vertically stacked section accordion. Only ONE section is open at a time; tapping a closed section collapses any open one and opens the tapped one. The current section pointer is `meetings.current_section_id` (per §3.1); changes to which section is open update the column server-side via `PATCH /api/meetings/:id/current-section` (idempotent + If-Match etag).
- Within an open section: a card-list of relevant items (action items for `old_business` / `new_business` / `recommendations`; inspections for `inspections_review`; notes editor for free-form sections). Each card is tap-expandable.
- Sticky bottom action bar (`data-print="hide"`) carries three actions: "Add note" (opens a slide-up sheet for the section's `notes_envelope`), "Move to next section" (advances `current_section_id` to the next `order_idx`), "Pause meeting" (records `actual_end_at = NULL` and the meeting stays `in_progress` — the rep can step away).

**Tablet/desktop (≥768px):**

- Two-pane layout. Left pane: vertical section nav showing all 12 sections (current highlighted; completed = green dot; pending = zinc dot). Right pane: the current section content.
- Same content within sections; the layout is wider and the action bar is in the right pane footer rather than fixed-bottom.

**The "current section" pointer.** Tracked in `meetings.current_section_id` (per §3.1). Changes are queued via the 1.10 sync queue per ADR-0009 §3.2 — the move-to-next-section action is queueable offline (it's a low-stakes operational signal, not a state transition). Optimistic UI: the local Dexie row updates immediately; the queue drains in the background. The PATCH carries `If-Match: <version>` and a 409 surfaces in the sync conflict UI if a concurrent change landed.

**Section content patterns:**

- `call_to_order`: notes editor only. `data-print="hide"` on the editor chrome; the notes plaintext (revealed for the rep, encrypted at rest) prints in the PDF (per the chain payload semantics — notes are sensitive; the PDF rendering decrypts under the workplace private key at PDF generation time per ADR-0008 §3.7).
- `roll_call_quorum`: the attendance capture surface per §3.6. Live quorum compute below the attendee list.
- `minutes_review`: notes editor only; the prior meeting's minutes (a finalized PDF) is referenced by hyperlink — the link opens the prior meeting's view.
- `inspections_review`: a card-list of `inspections` rows since the prior meeting; each card has a tap-to-review affordance that creates a `meeting_inspection_review` row (per §3.7).
- `old_business`, `new_business`, `recommendations`: card-list of action items filtered per §3.2 Layer 2; each card has the existing 1.6 swipe interaction for section move + status update. NEW action items in `new_business`: tap "+ Add action item" → opens the existing 1.6 create form pre-populated with `first_raised_meeting_id = <currentMeetingId>` and `current_section='new_business'`. NEW recommendations in `recommendations`: tap "+ Draft recommendation" → opens the existing 1.9 drafting flow with `meeting_id = <currentMeetingId>` pre-populated.
- `other_business`, `next_meeting`: notes editor only.
- `adjournment`: the auto-generated key metrics dashboard (per §3.8) + the "Adjourn meeting" CTA.

**Offline behavior.** The live meeting view works offline via the 1.10 sync queue per ADR-0009 §3.5. The view reads from Dexie first (the `meetings` + `meeting_sections` + `meeting_attendance` + `meeting_action_item_state` rows are cached locally on first load). Mutations (note edits, attendance toggles, section moves) queue via the 1.10 queue and drain on reconnect. Some operations are require-online per §3.6 — the `POST /api/meetings` create itself, `POST /api/meetings/:id/adjourn`, `POST /api/meetings/:id/signatures` — these surface a "Network required" banner when offline. The dichotomy follows the ADR-0009 §3.6 rule: routine ops are queueable; state-machine transitions that emit a high-value chain anchor are require-online. The meeting's `adjourned` and `finalized` transitions are require-online; `current_section_id` advancement is queueable; note capture is queueable; attendance toggling is queueable.

**Print stylesheet.** All chrome is `data-print="hide"`; the printable layout is the canonical minutes printout per the existing 1.12 print convention. The 2.3 PDF generator replicates this layout server-side; the print stylesheet is the rep's preview-before-export. Print-only `data-print="evidentiary"` metadata: meeting date + chain-anchor idx + document hash (the 2.3 PDF generator binds this).

**Accessibility.** WCAG 2.2 AA per the 1.12 baseline. Keyboard nav across sections (left-pane keyboard arrow keys cycle sections; right-pane Tab moves through cards; Enter expands; Escape collapses). Visible focus indicators per CLAUDE.md design rules. Screen-reader announcements on section advance ("now on section X of 10; old business"). The sticky bottom action bar's actions are keyboard-accessible via standard form-submit semantics.

### 3.6 Attendance capture

The roll_call_quorum section's primary content. Two modes per the user's brief:

**Mode 1 — Pre-populate from prior meeting.** The browser fetches the prior meeting's `meeting_attendance` list (decrypted client-side; the names live in JS heap for the lifetime of the view), shows them as a one-tap "Same attendees as last time?" affordance. On tap, the browser re-encrypts each name under the workplace public key (the same sealed-box shape from ADR-0009 §3.1) and POSTs them to `POST /api/meetings/:id/attendance/batch`. The plaintext lives in JS heap; the wire carries ciphertext.

**Mode 2 — Add fresh.** "+ Add attendee" opens a slide-up sheet with fields: `role` (radio: worker_co_chair / mgmt_co_chair / worker_rep / mgmt_rep / guest), `party` (auto-derived from role), `display_name` (free text), `attendee_user_id` (auto-set when role=worker_co_chair AND the name matches the rep's profile). The name is encrypted under the workplace public key client-side before submit; the wire carries ciphertext. Server: `POST /api/meetings/:id/attendance` with `clientId`, `role`, `party`, `display_name_ct`, `display_name_dek_ct`, `attendee_user_id?`.

**Default present_status.** Every newly-added attendee starts as `present`. The co-chair flips to `regrets` / `absent_unexcused` / `late_arrival` / `early_departure` via a tap on the attendee card. The state change emits `meeting.attendance.updated` with `{attendanceId, from_status, to_status, arrived_at?, departed_at?}` — no name in payload (T-AC9-class).

**Late arrival captures `arrived_at`; early departure captures `departed_at`.** The capture is at the moment of the status change (server-side `now()`); the rep cannot back-date for the in-meeting context (preserves chain integrity). The 2.4 milestone may absorb a manual back-date with an audit-anchored reason if the rep needs to record an attendee's actual arrival time from a paper sign-in.

**Quorum compute.** Lives in the `roll_call_quorum` section UI below the attendee list. Pure function `computeQuorum(attendance: AttendanceRow[]): QuorumResult` in `packages/shared-types/src/meeting-quorum.ts` (new). Rule per OHSA s.9(7-8): "at least half the members, with at least one worker rep present." The function returns `{ met: boolean; required_member_count: number; present_member_count: number; worker_reps_present: number; rule_citation: string }`. The rule_citation is a static string referencing the legal corpus entry; the citation entry is added to `packages/legal-corpus` in S1 if not already there (S0 audit confirms; OHSA s.9(7-8) is core JHSC procedure, likely already seeded per ADR-0003). The compute fires reactively as attendance changes; the quorum chip in the top bar updates live.

**OHSA s.9(7-8) rule operational nuance.** Worker reps + management reps both count toward "half the members"; the additional constraint is at least one worker rep must be present. The rule citation is mandatory in the compute output so the UI surfaces "Quorum met — OHSA s.9(7)" rather than a bare boolean. For CA-FED jurisdiction (CLC Part II), the equivalent rule is CLC s.135.1; the function reads `WORKPLACE.jurisdiction` from `config/workplace.ts` and selects the right citation.

**Attendance row encryption posture.** `display_name_ct` is sealed-box-encrypted under the workplace public key per CLAUDE.md Encryption Rules. The server never decrypts attendance names except inside the 2.3 PDF generator (where the name renders into the minutes document); the live view decrypts client-side after the server returns the ciphertext (the same posture as the recommendation drafting view per ADR-0008). The rep on a stolen phone post-meeting sees the ciphertext in Dexie; the workplace private key on the server is the bound.

### 3.7 Section-by-section workflow

Each section has: optional notes (envelope-encrypted; `notes_envelope_ct` + `notes_envelope_dek_ct` on `meeting_sections`), optional structured items (action items linked, inspections reviewed, recommendations drafted), a `started_at` / `ended_at` timestamp pair.

**Section start / end.** Tapping a section to expand it sets `meeting_sections.started_at = now()` if it's NULL (first time the rep enters the section). Tapping "Move to next section" sets `meeting_sections.ended_at = now()` and advances `meetings.current_section_id` to the next `order_idx`. The route `PATCH /api/meetings/:id/sections/:sid` accepts `{started_at?, ended_at?}` and emits no chain anchor for these timestamp ratchets (they are operational telemetry, not state-machine transitions; ADR-0002 §3 bounds the chain to meaningful state changes). The `version` etag bumps; the row updates.

**Notes capture.** Tapping "Add note" in the section's bottom action bar opens a slide-up sheet. The rep types the note; on save, the plaintext is sealed-box-encrypted client-side under the workplace public key, POSTed via `POST /api/meetings/:id/sections/:sid/notes` (the route REPLACES the section's notes envelope; notes are not append-only in 2.1 — the rep edits the section's notes as a single field; an append-only response-style shape lands in 2.4 if the field-level edit history becomes load-bearing). The route emits `meeting.section.note_captured` with `{meetingId, sectionId, sectionType, noteHash, byteSize}` — no plaintext, no PI. The hash is `sha256(notes_envelope_ct)` so a re-edit produces a new chain entry with a different hash.

**Action items in sections.** Per §3.2 Layer 2, the `old_business` / `new_business` / `recommendations` sections render action items via a route-side filter on `action_items.current_section`. The card render uses the existing 1.6 action-item-row component (per `apps/web/src/views/action-items-view.tsx`). Section-move swipes in-meeting use the existing 1.6 `POST /api/action-items/:id/moves` route (no new route; the meeting context flows through the existing `meeting_id` body parameter). The snapshot table writes a `live` row on every in-meeting status change (per §3.2 Layer 3) — the live snapshot is the in-meeting record; the finalized snapshot is the immutable record at adjournment.

**Action item CREATION inside a meeting.** Tap "+ Add action item" in `new_business` → opens the existing 1.6 create form. The form's hidden fields: `first_raised_meeting_id = <currentMeetingId>`, `current_section = 'new_business'`. The route is the existing `POST /api/action-items` per ADR-0005 §3; no new route. The new column `first_raised_meeting_id` (per §3.1) is set from the body field. The existing `action_item.created` chain event fires.

**Action item LINKAGE from existing items.** No new affordance — the existing action items are already in the section view (via the §3.2 Layer 2 filter). The "link" is implicit in the section filter; no manual link table is needed beyond the snapshot table.

**Recommendations DRAFTED in the recommendations section.** Tap "+ Draft recommendation" → opens the existing 1.9 drafting flow at `/recommendations/new?meeting_id=<currentMeetingId>`. The existing 1.9 route `POST /api/recommendations` accepts the new `meeting_id` body field (per §3.1 — the `recommendations.meeting_id` column is added in this migration); the route's Zod schema is extended with an optional `meeting_id` field. The chain event `recommendation.drafted` already exists per ADR-0008; no new kind. The meeting context is recorded in the recommendation row's `meeting_id` column.

**Inspections REVIEWED.** In `inspections_review`, the card-list shows inspections completed since the prior meeting (filtered by `inspections.completed_at` post-prior-meeting). Each card has three CTAs: "Accept as complete", "Findings need promotion to action items", "Defer to next meeting". The CTA fires `POST /api/meetings/:id/inspection-review` with `{inspection_id, outcome, notes_envelope_ct?, notes_envelope_dek_ct?}` and the server creates a `meeting_inspection_review` row per §3.1. The chain event `meeting.inspection_reviewed` fires with `{meetingId, inspectionId, outcome, notesHash?}`. The "findings need promotion" outcome is documentary only — the actual promotion goes through the existing 1.8 `POST /api/inspections/findings/:id/promote` route per ADR-0007 §3.7 and CLAUDE.md non-negotiable #15 (manual promotion). The meeting record carries the verdict; the promotion is a separate transaction.

### 3.8 Adjournment with auto-generated key metrics

The `adjournment` section's primary content. "Adjourn meeting" CTA at the bottom of the section. Step-up gated per §3.10.

**Route:** `POST /api/meetings/:id/adjourn`. Idempotency-key required.

**Server transaction:**

1. Verify `meetings.status = 'in_progress'`. Otherwise 422 `illegal_transition`.
2. Set `meetings.actual_end_at = now()`.
3. Set `meetings.status = 'adjourned'`.
4. For each action item that appeared in any section's view during the meeting (queryable via `meeting_action_item_state` `live` rows for this meeting), INSERT a `finalized` snapshot row with the action item's CURRENT state (re-read from `action_items` inside the transaction). Mark the live snapshots as superseded (a new column `superseded_at` on `meeting_action_item_state` could capture this; v1 keeps it simple — the partial-unique on `(meeting_id, action_item_id, snapshot_kind='finalized')` is the structural defense, and live rows are queryable for audit but not authoritative post-adjournment).
5. Append the chain entry `meeting.adjourned` with the auto-generated metrics dict in metadata.
6. COMMIT.

**The auto-generated key metrics.** Computed inside the transaction from query results, NOT stored as denormalized columns on the meeting row. Recompute-on-read is the canonical posture (the user's brief explicitly calls for this) so the metrics always reflect the audit chain truth — a stored count could drift from the underlying rows; a recomputed count cannot. The metrics are EMITTED into the chain payload at adjournment time (the chain row's metadata is the immutable snapshot of "what the metrics were at adjournment"); the live UI may recompute on subsequent views (showing changes since adjournment — e.g., "this meeting closed 14 items at adjournment; 2 have since been reopened").

**Metrics dict shape (chain payload):**

```ts
{
  meetingId: string;
  durationMinutes: number;       // (actual_end_at - actual_start_at) / 60000
  itemsRaisedThisMeeting: { count: number; ids: string[] };       // action_items where first_raised_meeting_id = meetingId
  itemsClosedThisMeeting: { count: number; ids: string[] };       // action_items closed during the meeting window
  recommendationsDrafted: { count: number; ids: string[] };       // recommendations.meeting_id = meetingId
  inspectionsReviewed: { count: number; ids: string[] };          // meeting_inspection_review rows
  quorumCompliance: {
    met_at_call_to_order: boolean;
    quorum_lost_intervals: [{ from: string; to: string }];        // intervals when quorum dropped (late departure)
    rule_citation: string;
  };
  actionItemCountBySection: {
    new_business: number;
    old_business: number;
    recommendation: number;
    completed_this_period: number;
    archived: number;
  };
}
```

**Audit event:** `meeting.adjourned` with the metrics dict. Note this is the ONE place where the chain payload carries a structured metrics blob (the prior ADR-0002 discipline limits chain payloads to IDs + counts + hashes; metrics are an exception because they are the evidentiary anchor for "what was true at adjournment"). The payload still carries zero PI — IDs are uuids, counts are integers, intervals are timestamps. The names of attendees, the content of notes, the descriptions of action items are NOT in the payload.

**Post-adjournment state.** `meetings.status = 'adjourned'`. The live view re-renders with the adjournment summary; the "Finalize minutes" CTA appears at the bottom. The meeting is NOT yet finalized; the 4-signature workflow per §3.9 is the gate. Action items can be acted on freely between adjournment and finalization — per the rights-protective copy in §3.9, finalization is the formal sign-off, not a gate on operational work.

### 3.9 Minutes finalization (counter-sign by 4 signers)

The most security-sensitive surface in 2.1. Post-adjournment, the meeting moves to `pending_finalization` (sub-state representation: `status = 'pending_finalization'` directly — the §3.1 enum includes both `adjourned` and `pending_finalization`; the route `POST /api/meetings/:id/start-finalization` advances `adjourned → pending_finalization`).

**The 4 signers** per ROADMAP.md line 197: Worker Co-Chair, Mgmt Co-Chair, Warehouse Mgr, Plant Mgr.

**CRITICAL — non-negotiable #1.** The signer ROLES are hardcoded in the §3.1 enum (`signer_role` check constraint). The signer DISPLAY NAMES come from two sources, in this order:

1. **Workplace config** (`config/workplace.ts`). The four signer ROLES are EXPOSED as part of the workplace config, NOT the names themselves. The config gains a new field:

   ```ts
   export interface WorkplaceConfig {
     // ... existing fields
     readonly minutesSignerRoles: readonly SignerRoleDef[];
   }
   export type SignerRole = 'worker_co_chair' | 'mgmt_co_chair' | 'warehouse_mgr' | 'plant_mgr';
   export interface SignerRoleDef {
     readonly role: SignerRole;
     readonly displayRoleLabel: string; // "Plant Manager" vs the bare "plant_mgr"
   }
   ```

   No names. The role labels are display strings ("Worker Co-Chair", "Management Co-Chair", "Warehouse Manager", "Plant Manager") so the UI does not hardcode "Plant Mgr" but reads it from config — a workplace whose plant manager is called "Site Director" would set `displayRoleLabel: 'Site Director'` for `role: 'plant_mgr'`. The structural role stays; the display label is configurable.

2. **The per-meeting `meeting_attendance` row for that role**, when present. The mgmt_co_chair attendee at THIS meeting has a `display_name_ct` envelope; the finalization surface uses it as the pre-fill for the signer's display name. Per-meeting, per-signer — there is no static "the warehouse manager is X" anywhere in the schema (warehouse_mgr is not a JHSC member role per OHSA s.9 — they are a signer of the minutes, but they may or may not have attended the meeting). The route's pre-fill logic: read `meeting_attendance WHERE meeting_id = $1 AND role IN ('worker_co_chair','mgmt_co_chair')` to populate the two co-chair signer names; for warehouse_mgr and plant_mgr, the rep enters the name fresh at the finalization surface (the names are encrypted before submit).

**The signer NAMES are encrypted at rest on `meeting_signatures.signer_display_name_ct`.** Per non-negotiable #1 + #4 — even the signer name is treated as sensitive PI.

**Worker Co-Chair signs in-app via step-up auth + passkey.** Per ADR-0001, step-up gates the signature. The route `POST /api/meetings/:id/signatures` with `{signer_role: 'worker_co_chair', signer_display_name_ct, signer_display_name_dek_ct, signed_method: 'in_app_passkey'}` requires:

- Step-up freshness ≤60s (`action='meeting.sign.worker_co_chair'`). The session's `stepUpUntil` claim is verified.
- The `step_up_jti` from the session claim is recorded on the signature row (per §3.1 schema).
- The signer_user_id is auto-set to the actor's user_id (the rep IS the worker co-chair).
- No `evidence_envelope` (the in-app signature does not need a paper scan; the step-up + audit are the evidence).
- The `signed_at` is `now()`.

**The OTHER 3 signers are EXTERNAL to the app.** They sign off-app (paper, email, signed PDF). The rep collects the evidence and records it. The route `POST /api/meetings/:id/signatures` with `{signer_role: 'mgmt_co_chair' | 'warehouse_mgr' | 'plant_mgr', signer_display_name_ct, signer_display_name_dek_ct, signed_method: 'paper_attestation' | 'email_attestation', evidence_envelope_ct, evidence_envelope_dek_ct, evidence_storage_key?}` requires:

- Step-up freshness ≤60s (`action='meeting.sign.<role>'`).
- The `evidence_envelope_ct` is mandatory (sealed-box-encrypted scan of the paper signature or email body); the bytes are uploaded to Tigris under `evidence_storage_key` (the same Tigris bucket as 1.7 evidence per ADR-0006); the row carries the storage key + the ciphertext SHA-256.
- The `signer_user_id` is NULL (no in-app account).
- The `signed_at` is the timestamp the rep records (the rep enters when the signer attested; defaults to `now()` if the rep does not specify).

**Method-shape integrity check.** The `meeting_signatures` table CHECK (per §3.1) enforces:

- `signed_method='in_app_passkey'` requires `step_up_jti IS NOT NULL` and `signer_user_id IS NOT NULL` and `evidence_envelope_ct IS NULL`.
- `signed_method IN ('paper_attestation','email_attestation')` requires `evidence_envelope_ct IS NOT NULL` and `evidence_envelope_dek_ct IS NOT NULL`.

**Finalization gate.** Route `POST /api/meetings/:id/finalize`. Server transaction:

1. Verify `meetings.status = 'pending_finalization'`.
2. Count `meeting_signatures` rows for this meeting: must equal 4, must cover all four `signer_role` values (the UNIQUE on `(meeting_id, signer_role)` per §3.1 prevents duplicates).
3. Set `meetings.status = 'finalized'`. Set `meetings.updated_at = now()`.
4. Promote any `live` action item state snapshots to `finalized` (idempotent — if §3.8's adjournment transaction already did this, the partial-unique constraint catches duplicates).
5. Append `meeting.finalized` with `{meetingId, signerRoles: ['worker_co_chair','mgmt_co_chair','warehouse_mgr','plant_mgr'], signedMethodCounts: { in_app_passkey: 1, paper_attestation: N, email_attestation: M }, finalizedAt}`.
6. COMMIT.

If signatures < 4, return 422 `signatures_incomplete` with the list of missing roles. The UI surfaces "Waiting for Plant Manager signature" — the rep collects + records + retries.

**Audit events on every signature.** `meeting.signature.recorded` with `{meetingId, signerRole, signedMethod, evidenceHash?, stepUpJti?, signedAt}` — no PI; the names are not in the payload. Four chain rows per finalized meeting (one per signer) + one `meeting.finalized` row.

**Step-up freshness required.** Each signature route call requires fresh step-up (60s window). The rep gets prompted four times (once per signature) — this is intentional friction proportional to the evidentiary weight. If the rep is recording all 4 in one sitting, the step-up grants stay fresh across the four calls; if the rep is recording one per day, they re-step-up each day.

**Rights-protective copy.** Per non-negotiable #7. The workflow MUST NOT suggest the rep must wait for all signatures before publishing the action items. Items can be acted on as soon as the meeting adjourns. Finalization is the formal sign-off, not a gate on operational work. The UI copy on the adjournment screen reads:

> "Meeting adjourned. The action items raised, closed, and moved during this meeting are now live in the operational record. Minutes finalization (the 4 counter-signatures) is the formal sign-off that produces the canonical PDF; the action items themselves do not wait on finalization."

The "Finalize minutes" CTA is a separate path with neutral framing — "Record signatures to finalize minutes" — not "Waiting for management to approve". The four signatures are recorded as evidentiary attestations the rep collected; they do not gate the rep's worker-side work.

### 3.10 Audit + step-up integration

**Eleven new `AuditEventKind` values** land in `packages/shared-types/src/index.ts` extending the existing union (per `shared-types/src/index.ts:92-128`):

```ts
| 'meeting.created'
| 'meeting.section.added'                  // emitted when a section is materialized at meeting create (one per section)
| 'meeting.attendance.recorded'            // POST /api/meetings/:id/attendance
| 'meeting.attendance.updated'             // PATCH attendance row (present_status change)
| 'meeting.section.note_captured'          // POST notes envelope on a section
| 'meeting.action_item_state_snapshot'     // INSERT/UPDATE meeting_action_item_state
| 'meeting.inspection_reviewed'            // POST inspection review row
| 'meeting.adjourned'                      // POST adjourn
| 'meeting.signature.recorded'             // POST signature (4× per finalized meeting)
| 'meeting.finalized'                      // POST finalize
| 'audit.meeting_template.seeded'          // seed-meeting-template.ts seed event
```

Each kind's `AuditPayload` shape lands in the discriminated union in `shared-types`. Per the T-AC9-class invariant (ADR-0002), NO PI in chain payloads — names, note contents, descriptions are NEVER in the payload. IDs, counts, hashes, timestamps, structured rule citations are the allowed shape.

**Step-up gating** per non-negotiable #16 + the user's brief:

| Route                                        | Step-up required? | Action                  | Rationale                                                                                             |
| -------------------------------------------- | ----------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /api/meetings`                         | Yes               | `meeting.create`        | High-value entity create; chain anchors one meeting row + N sections.                                 |
| `PATCH /api/meetings/:id/current-section`    | No                | —                       | Operational; the co-chair will tap this many times per meeting.                                       |
| `POST /api/meetings/:id/attendance`          | No                | —                       | Operational; attendees added in bulk at roll call.                                                    |
| `PATCH /api/meetings/:id/attendance/:aid`    | No                | —                       | Operational; status flips frequent during meeting.                                                    |
| `POST /api/meetings/:id/sections/:sid/notes` | No                | —                       | Operational; the co-chair edits notes throughout.                                                     |
| `POST /api/meetings/:id/inspection-review`   | No                | —                       | Operational; review verdict.                                                                          |
| `POST /api/meetings/:id/adjourn`             | Yes               | `meeting.adjourn`       | State-machine transition; emits metrics chain payload.                                                |
| `POST /api/meetings/:id/start-finalization`  | No                | —                       | Sub-state transition; no new entity, no new payload.                                                  |
| `POST /api/meetings/:id/signatures`          | Yes               | `meeting.sign.<role>`   | Per non-negotiable #16 — every signature is a high-value evidentiary anchor.                          |
| `POST /api/meetings/:id/finalize`            | Yes               | `meeting.finalize`      | Terminal state-machine transition; emits the finalization chain anchor.                               |
| `POST /api/meetings/:id/import-drafts`       | Yes               | `meeting.import_drafts` | Pre-meeting drafts importer (forward seam; the route ships as 422-by-default in 2.1 and 2.4 absorbs). |

**Step-up freshness window.** 60 seconds per the existing inspection + recommendation pattern (per ADR-0007 §3.6 + ADR-0008 §3.7). The rep step-ups once, gets a 60s window, performs the gated action; if they hesitate past 60s the modal returns. This is the established UX from 1.8 + 1.9; the in-meeting flow assumes the same window. The signature workflow specifically may require multiple step-ups if the rep is collecting signatures over a long period (per §3.9 — the 4 signers may sign over hours or days).

**Idempotency.** Every POST route is wrapped by the existing `idempotencyKeyGuard` middleware per ADR-0009 §3.4. The `clientId` body field is accepted per ADR-0009 §3.3 on creates (`POST /api/meetings`, `POST /api/meetings/:id/attendance`, `POST /api/meetings/:id/inspection-review`, `POST /api/meetings/:id/sections/:sid/notes`, `POST /api/meetings/:id/signatures`). The PATCH routes accept `If-Match: <version>` per ADR-0009 §3.7. The 1.10 ratchet is mechanical — every new route consumes the same middleware substrate.

### 3.11 Slice plan

- **S0 — architect + threat-modeler.** This ADR + a `SECURITY.md` §2.13 "Meeting Lifecycle" pass with T-M1..T-Mn threats. Threat model covers: in-app-signer step-up bypass, off-app-signer attestation forgery, signer-name PI leak via chain payload (T-AC9-class), pre-meeting drafts importer attack surface, attendance-name plaintext in chain payload, quorum compute spoofing (clock skew), `current_section_id` rollback during finalization, multi-device concurrent in-meeting capture, recommendation-meeting linkage chain payload PI, action_item snapshot consistency at adjournment, signer Tigris evidence orphan-ciphertext (forward seam from 1.7 deferral), the four-signature gate bypass via direct DB write, paper-attestation evidence hash collision, configuration injection via `minutesSignerRoles` env var, and the chain-anchor latency interaction with the 1.10 offline queue for meetings-in-progress. The threat-modeler runs against this ADR in parallel.

- **S1 — schema + migration + shared-types + audit kinds.** `migrations/0011_meeting_lifecycle.sql` (the seven new tables + the two existing-table column additions per §3.1). Drizzle schema additions to `apps/api/src/db/schema.ts`. `packages/shared-types` additions: `MeetingStatus`, `MeetingSectionType`, `MeetingTemplateCode`, `AttendanceRole`, `AttendanceParty`, `PresentStatus`, `SignerRole`, `SignedMethod`, `MeetingReviewOutcome`, the eleven new `AuditEventKind` values + per-kind `AuditPayload` shapes. `computeQuorum` pure function in `packages/shared-types/src/meeting-quorum.ts`. `config/workplace.ts` extension for `minutesSignerRoles`. Trigger for `version` auto-increment on UPDATE (mirrors the 1.10 pattern). Tests: schema-version migration roundtrip, quorum compute unit tests for ON + CA-FED jurisdictions, status-machine transition validation, the `meeting_action_item_state` partial-unique constraint, the `meeting_signatures` method-shape CHECK. Estimated lines: ~600.

- **S2 — server routes.** `apps/api/src/routes/meetings/` (new). Eleven routes:
  - `POST /api/meetings` (create + materialize sections + materialize prefill attendance)
  - `GET /api/meetings` (list, paginated, status-filtered)
  - `GET /api/meetings/:id` (envelope read)
  - `PATCH /api/meetings/:id/current-section` (advance section pointer; If-Match)
  - `POST /api/meetings/:id/attendance` (add attendee)
  - `POST /api/meetings/:id/attendance/batch` (prefill batch from prior meeting)
  - `PATCH /api/meetings/:id/attendance/:aid` (toggle present_status; If-Match)
  - `POST /api/meetings/:id/sections/:sid/notes` (replace section notes envelope)
  - `POST /api/meetings/:id/inspection-review` (create review row)
  - `POST /api/meetings/:id/adjourn` (state transition + metrics chain payload)
  - `POST /api/meetings/:id/start-finalization` (sub-state transition)
  - `POST /api/meetings/:id/signatures` (record one of 4 signatures; step-up; method-shape validation)
  - `POST /api/meetings/:id/finalize` (gate on 4 signatures; terminal transition)
  - `POST /api/meetings/:id/import-drafts` (422 stub — 2.4 absorbs)
  - Plus extensions to existing routes: `POST /api/action-items` accepts `first_raised_meeting_id`; `POST /api/recommendations` accepts `meeting_id`; `POST /api/inspections/findings/:id/promote` accepts `triggering_meeting_id` (optional, for chain payload context).
  - Meeting crypto helper in `apps/api/src/meetings/crypto.ts` (parallel to inspections/recommendations crypto helpers).
  - Integration tests: full lifecycle (create → in-meeting writes → adjourn → start-finalization → 4 signatures → finalize), step-up gate enforcement, idempotency middleware behavior, If-Match etag on PATCH, attendance role-uniqueness constraints, quorum compute integration. Estimated lines: ~1200.

- **S3 — web client (live meeting view + attendance capture + section workflow + adjournment + finalization).** `apps/web/src/meetings/` (new directory). The `apps/web/src/views/minutes-view.tsx` placeholder is REPLACED with the new active-meeting routing view that delegates to:
  - `meetings-list-view.tsx` (when no active meeting; the "Start new meeting" empty state)
  - `meeting-live-view.tsx` (the live meeting surface per §3.5; the largest component)
  - `meeting-create-form.tsx` (the "Start new meeting" modal per §3.4)
  - `meeting-finalization-view.tsx` (the 4-signature surface per §3.9; step-up gated)
  - `meeting-adjournment-summary.tsx` (the key metrics dashboard per §3.8)
  - `attendance-capture-sheet.tsx` (per §3.6)
  - `section-notes-sheet.tsx` (per §3.7)
  - `quorum-chip.tsx` (the live compute display per §3.6)
  - Mobile-primary per CLAUDE.md non-negotiable #9. Print stylesheet for the meeting detail (preview-before-PDF per ARCHITECTURE.md §"Print Stylesheet for Minutes Document"). `data-print="hide"` on chrome; `data-print="evidentiary"` on chain-anchor metadata per the 1.12 convention.
  - Dexie schema extensions in `apps/web/src/db/dexie.ts` for the seven new tables (`meetings`, `meeting_sections`, `meeting_attendance`, `meeting_inspection_review`, `meeting_action_item_state`, `meeting_signatures`, `meeting_templates`); the `_sync_state` + `_local_id` discipline from ADR-0009 §3.1 applies to the mutable tables (meetings, sections, attendance, inspection_review, signatures); `meeting_templates` is a read-only cache.
  - Sync queue plumbing: per-meeting attendance + section-note + section-move operations queue via the 1.10 sync queue per ADR-0009 §3.2; create + adjourn + finalize + signatures are require-online per §3.6 + §3.10.
  - Tests: live view component rendering, attendance capture with envelope-encryption round-trip (mocked), quorum compute display, adjournment metrics rendering, finalization 4-signature gate, the `data-print` attributes round-trip (a Playwright `emulateMedia({media:'print'})` spec). Estimated lines: ~2200.

- **S4 — agenda template seed + meeting_templates versioning.** `apps/api/scripts/seed-meeting-template.ts` (new). The v1 template (per §3.3 — 10 sections, 100 minutes default). The seed uses `ON CONFLICT (template_code, version_number) DO NOTHING` for idempotency. Emits `audit.meeting_template.seeded` with `{templateCode, versionNumber, sectionsHash}`. Documents the operator-side run procedure in the runbook stub (S5 finalizes the runbook). Estimated lines: ~300.

- **S5 — independent reviewers (security, privacy/UX, action-item linkage, signer-workflow) + fix bundle.** Same pattern as 1.4 / 1.5 / 1.6 / 1.7 / 1.8 / 1.9 / 1.10 / 1.11. Four reviewer hats this time given the surface breadth:
  - **Security reviewer:** step-up gate completeness, sig-method CHECK enforcement, the four-signature finalization gate, attendance encryption round-trip, signer-name envelope discipline, chain payload PI audit.
  - **Privacy + UX reviewer:** rights-protective copy on the finalization screen, the offline-submit clock interaction with meeting `adjourned_at` (per ADR-0009 §3.12 — same legal stance), mobile flow at 390px, screen-reader announcements on section advance, the 4-step-up signature flow's friction calibration.
  - **Action-item linkage reviewer:** the §3.2 snapshot vs. live-action-item discipline, the `first_raised_meeting_id` vs. `meeting_id` semantic separation, the 2.2 (in-meeting action item management) integration seam.
  - **Signer-workflow reviewer:** the off-app-signer evidentiary discipline, the Tigris storage key handling, the method-shape CHECK, the rep-as-records-custodian framing in the runbook.
  - Fix bundle absorbs the close-out items into S2 / S3 code + the runbook. Threat model close-out lands the operational findings into `docs/runbooks/meetings.md`. Estimated lines: ~800.

**Estimated total:** ~5100 lines across S1-S5. Fits one milestone.

## Consequences

### Positive

- **The Minutes module is the operational hub per CLAUDE.md "Minutes-centric."** The placeholder view ships its real implementation. The rep no longer Excel-imports their current quarter's meeting after the fact; they capture the meeting natively. The 21-day s.9(21) clock starts from the in-meeting raise (per ADR-0005 §3) and the chain anchors at server-receipt time (per ADR-0009 §3.2 + §3.12 — same legal stance applies to meeting events).
- **Action items remain first-class per non-negotiable #12.** The §3.2 three-layered linkage (provenance / operational / snapshot) preserves the invariant. Meetings reference action items; meetings do not own them. The PDF renders the snapshot; the live action item continues evolving. No structural sub-typing.
- **The 4-signature counter-sign workflow is structurally honest.** Worker Co-Chair signs in-app via step-up + passkey; the other 3 sign off-app and the rep records the evidence. Non-negotiable #6 (no employer infra dependency) is preserved — the app does not assume the employer's signers are app users. The chain anchors what the rep recorded, not the unforgeability of the paper signatures themselves; the recipient verifies the rep's evidentiary record, not the original off-app signatures.
- **Template versioning per non-negotiable #13.** The agenda template is pinned at meeting creation time; a v2 template never retro-affects v1 meetings. The same pattern as 1.8 inspections; the migration path for a template update is the established append-only seed shape.
- **Quorum is structural, not editorial.** The `computeQuorum` pure function reads `meeting_attendance` rows and applies OHSA s.9(7-8) (or CLC s.135.1 for CA-FED) with the rule citation. The chip on the top bar is the canonical display. The chain payload of `meeting.adjourned` carries the quorum compliance over the meeting's duration (per §3.8 — `quorum_lost_intervals`).
- **All PI stays out of chain payloads (T-AC9-class).** Per §3.10 — no names in events, no note plaintexts in events, no description plaintexts. The chain carries IDs, counts, hashes, timestamps, structured rule citations. The discriminated union in `shared-types` is the typechecker-level gate; a route that tries to include a name fails type compile.
- **The 1.10 offline-sync substrate composes cleanly.** Routine in-meeting ops (attendance toggling, section advance, note capture) queue via the existing sync queue with the existing `Idempotency-Key` + `clientId` + `If-Match` ratchets per ADR-0009 §3.2-§3.7. No new middleware. The require-online operations (create, adjourn, signatures, finalize) are the same posture as the 1.10 reveal flows + the 1.11 import commit.
- **The 4-6 week real-world-use window (per ROADMAP.md line 175) informs the design.** The rep has been operating with the imported Excel minutes since 1.12 deploy; 2.1 is the next quarter's meeting. The schema fields, the section vocabulary, the metrics shape, the 4-signature roles — all map to the Excel workflow vocabulary the rep already knows. The cognitive switching cost is minimal.

### Negative / accepted tradeoffs

- **Three new audit chain kinds are emitted PER section (per the 12 sections × the multiple operations per section).** A typical 90-minute meeting may produce 50-100 chain rows (one per section-add, per note-capture, per attendance update, per inspection review, per snapshot, per adjournment, per signature, per finalization). The chain grows; the verifier walks more rows. Mitigation: at single-tenant scale (~4 quarterly meetings × 100 rows = 400 chain rows/year for meetings), this is negligible. The `audit-log-verify --full` flag from ADR-0011 §3.7 absorbs the new kinds via the `--check-meetings` extension (added in S2; documented in the runbook).
- **The 12 section types are a closed enum; custom sections are deferred.** Per §3.1 reconciliation — adding a custom-named section would require a `display_name_envelope` column on `meeting_sections` (PI risk if reps name sections with employee identifiers; chain payload contamination). The 12 standing types cover the canonical JHSC + Robert's Rules shape; custom sections land in 2.4 with a separate `meeting_custom_sections` table that the chain payload reads via section_id reference only (no name in payload). 2.1 accepts the closed enum.
- **The `meeting_action_item_state` snapshot table grows with `meetings × open_action_items`.** Per §3.2 — at single-tenant quarterly cadence × 30-50 items per meeting × 10 years, ~2000 rows per action item or ~50,000 rows total for the historical archive. The size is fine; the indexes carry the cost; the query pattern (per-meeting fetch + per-action-item history) is efficient. Documented.
- **The 4 step-up prompts during signature collection.** The rep may collect 4 signatures over hours or days; each requires a fresh step-up grant. Friction proportional to evidentiary weight per non-negotiable #16; the rep accepts the cost. If the rep collects all 4 in one sitting, the 60s window typically covers all 4 sequential calls. Documented.
- **The current section pointer is queueable but the adjournment is not.** Per §3.6 + §3.10 — a meeting in progress can advance sections offline; an offline rep tapping "Adjourn meeting" sees the "Network required" banner. The mid-meeting transition between "I can do this offline" and "I cannot adjourn offline" is a UX seam; mitigation: the live view surfaces the network status chip throughout the meeting so the rep knows the constraint. Documented.
- **The signer DISPLAY NAMES are encrypted at rest but printed in plaintext on the PDF.** Per non-negotiable #1 — names are PI. The PDF (2.3) decrypts the signer names under the workplace private key inside the PDF generator (same posture as the recommendation export per ADR-0008 §3.7); the rendered PDF carries plaintext names. The recipient gets a PDF with names; the at-rest DB row carries ciphertext only. Documented.
- **Off-app signer evidence is rep-recorded, not signer-cryptographically-verified.** A malicious rep COULD forge a paper signature scan and record it as a `paper_attestation`. The mitigations are organizational (the rep is the data custodian; a hostile rep is out of scope per ADR-0001's single-tenant single-actor scope) + chain (the `meeting.signature.recorded` event records `signedMethod` + `evidenceHash` + `signedAt` immutably; a later challenge to the signature would surface the recorded evidence for forensic comparison to the off-app source). Documented as accepted residual; the threat model treats it as out-of-scope-for-2.1 (a rep who would forge a signature would also forge the rest of the chain; the structural defense is not in 2.1).
- **`meeting.import-drafts` is a 422 stub in 2.1.** The route exists in the API surface (per §3.10) so 2.4 can absorb it without a route-add; the 2.1 handler returns 422 `not_implemented_until_2_4`. Documented forward seam.

### Risks

- **A bug in the four-signature gate could let an unfinalized meeting flip to `finalized`.** Mitigation: the `meeting_signatures_meeting_role_unique` UNIQUE on `(meeting_id, signer_role)` plus the route's COUNT(\*) = 4 check inside the finalize transaction; an integration test asserts the gate rejects finalize with 0/1/2/3 signatures; the chain's `meeting.finalized` event payload carries `signerRoles: ['worker_co_chair','mgmt_co_chair','warehouse_mgr','plant_mgr']` so a missing role surfaces in the verifier.
- **A bug in the snapshot promotion at adjournment could lose action-item context.** Mitigation: the adjournment transaction's snapshot-promotion step is idempotent (the partial-unique on `(meeting_id, action_item_id, snapshot_kind='finalized')` catches duplicates); an integration test asserts every action item that appeared in any section during the meeting has a `finalized` snapshot row after `meeting.adjourned` fires; the verifier `--check-meetings` flag (S2 extension) cross-references `meeting.adjourned` payloads against the snapshot rows.
- **A bug in the quorum compute could mis-report compliance over the meeting's duration.** Mitigation: the function is pure + unit-tested for the ON and CA-FED rules + tested for edge cases (no attendees, all guests, exactly half present, all worker reps absent); the chain payload's `quorum_lost_intervals` is regression-tested against fixture attendance change sequences.
- **A bug in the chain payload could leak PI (T-AC9-class).** Mitigation: the discriminated union in `shared-types` is the typechecker-level gate per ADR-0002; the route handlers cannot pass a name field to `append()` without a type error; the §S0 threat-modeler review explicitly checks the 11 new payload shapes for name fields.
- **A bug in the off-app signer evidence storage could orphan ciphertext in Tigris.** Mitigation: the same Tigris orphan-ciphertext GC posture as ADR-0006 §3 — a deferred GC job sweeps `evidence_files` and `meeting_signatures.evidence_storage_key` references and deletes orphans (forward seam, lands in a future hardening milestone same as the 1.7 GC deferral); the documented bound is the Tigris bucket size at single-tenant scale (a leak of one signature evidence per meeting × 4 meetings per year × 10 years = 40 orphan blobs; acceptable).
- **The `current_section_id` pointer is mutable concurrently with section adds/updates; a race could leave the pointer dangling.** Mitigation: the FK `meetings.current_section_id REFERENCES meeting_sections(id) ON DELETE SET NULL` catches the dangling case; the route's section-deletion path (only available pre-adjournment, restricted to meetings in `scheduled` state) re-points the pointer if it was the deleted section.
- **An incorrect `workplace.jurisdiction` env var could route the rep to the wrong quorum rule.** Mitigation: the env var validation in `config/workplace.ts:parseJurisdiction` already defaults to `ON`; a CI lint (the 1.12 deploy runbook env-var lint precedent per ADR-0011 §3.9) confirms the var is set explicitly; the runbook flags this as a deploy-time check.

## Compliance check

- **#1 no names in source.** Signer ROLES are in `config/workplace.ts` (env-driven `minutesSignerRoles`); signer DISPLAY NAMES are encrypted per-meeting on `meeting_signatures.signer_display_name_ct`. Attendee names are encrypted on `meeting_attendance.display_name_ct`. The DB never sees plaintext names; the chain payload never carries names. Source code has zero hardcoded names.
- **#2 chain-of-custody.** Eleven new audit kinds per §3.10. Every meeting lifecycle transition emits a chain anchor. The `meeting.adjourned` payload carries the structured metrics dict (the one exception to "IDs + counts + hashes only" — the metrics are evidentiary anchors and stay PI-free per §3.8). The verifier extension (`--check-meetings` flag, added in S2) walks the new kinds.
- **#4 privacy-by-default.** Sensitive fields are envelope-encrypted via `@jhsc/crypto`: `notes_envelope` on meetings + sections, `display_name` on attendance, `signer_display_name` on signatures, `evidence_envelope` on off-app signatures, `snapshot_assignee` on snapshot rows. The DB sees ciphertext; the chain sees hashes + IDs.
- **#5 legal citations.** Quorum compute returns a `rule_citation` field referencing the corpus entry (OHSA s.9(7-8) for ON; CLC s.135.1 for CA-FED). The corpus entry is added in S1 if not already seeded per ADR-0003. No generated citations outside the corpus.
- **#6 no employer infrastructure.** The 4 off-app signers do not have in-app accounts; the app does not SSO with the employer IdP; the rep records evidence of their off-app sign-off. Non-negotiable #6 is structurally honored.
- **#7 rights-protective UI.** Per §3.9 — the finalization workflow MUST NOT suggest the rep waits for management before action items are live. The copy explicitly decouples operational work from finalization. Withdrawal-style discouraging language is banned per the established 1.5-1.9 convention.
- **#8 no automated regulator submission.** The 2.1 surface produces minutes; the 2.3 PDF generator (next milestone) is the export. The rep distributes the PDF; the app does not transport it anywhere external.
- **#9 mobile-primary.** The live meeting view is 390px-first per §3.5. Vertical section accordion on mobile; two-pane on tablet/desktop. Sticky bottom action bar with touch-target ≥44pt. The sync-status chip from ADR-0009 is reused. Pull-to-refresh on the meetings list.
- **#10 restrained legal-grade aesthetic.** No union iconography. No marketing flourishes. The agenda template uses Lucide icons (`ScrollText` for the Minutes tab per `tabs.ts:40`); the signature flow uses neutral framing; the metrics dashboard at adjournment is data-dense per the Linear / Stripe Dashboard reference bar.
- **#12 action items are first-class.** The §3.2 three-layered linkage preserves this load-bearing invariant. Meetings reference action items; the snapshot is the meeting-time record; the action item keeps evolving outside the meeting. No structural sub-typing.
- **#13 inspections preserve template version at conduct time.** Extended to meetings: the agenda template is pinned at meeting creation per §3.3. A v2 template never retro-affects v1 meetings. Same migration shape as 1.8.
- **#14 zone IDs stable.** Inspections are referenced via `meeting_inspection_review.inspection_id` (FK to the existing 1.8 row); the zone_id is read via the inspection's pinned template version per ADR-0007 §3.3. No new zone handling.
- **#15 inspection findings manually promoted.** The `meeting_inspection_review.outcome='findings_promoted'` is documentary; the actual promotion goes through the existing 1.8 route per ADR-0007 §3.7. The inspector chooses Risk level per non-negotiable #15.
- **#16 exports step-up + audit log + document hash.** The 2.3 PDF generator (next milestone) inherits ADR-0008 §3.7's discipline. The 2.1 surface itself ships no export; the data substrate for the export lands here. Step-up gates the finalization (which produces the canonical post-finalization minutes data the PDF reads).

## Follow-ups

- [ ] **Threat-modeler:** append `SECURITY.md` §2.13 "Meeting Lifecycle" with T-M1..T-Mn threats + mitigations (in-app-signer step-up bypass, off-app-signer attestation forgery, signer-name PI leak via chain payload, pre-meeting drafts importer attack surface, attendance-name plaintext in chain payload, quorum compute spoofing, current_section_id rollback during finalization, multi-device concurrent in-meeting capture, recommendation-meeting linkage chain payload PI, action_item snapshot consistency at adjournment, signer Tigris evidence orphan-ciphertext, four-signature gate bypass via direct DB write, paper-attestation evidence hash collision, configuration injection via minutesSignerRoles env var, chain-anchor latency for meetings-in-progress).
- [ ] **S1:** Migration 0011 + Drizzle schema additions + shared-types additions (eleven new audit kinds + per-kind payloads + meeting enums + computeQuorum pure function) + config/workplace.ts extension for minutesSignerRoles + the `version` trigger extension to the new tables.
- [ ] **S2:** Eleven new routes in `apps/api/src/routes/meetings/` + extensions to `POST /api/action-items` (first_raised_meeting_id) + `POST /api/recommendations` (meeting_id) + `POST /api/inspections/findings/:id/promote` (triggering_meeting_id) + meeting crypto helper + integration test suite + `audit-log-verify --check-meetings` extension.
- [ ] **S3:** Web client — replace `apps/web/src/views/minutes-view.tsx` placeholder with the live meeting view + meetings list + create form + adjournment summary + finalization view + attendance capture sheet + section notes sheet + quorum chip; Dexie schema extensions for seven new tables; sync-queue plumbing for routine operations; require-online banners for create/adjourn/sign/finalize; print stylesheet for the meeting detail.
- [ ] **S4:** `apps/api/scripts/seed-meeting-template.ts` + v1 template seed + `audit.meeting_template.seeded` event + deploy runbook integration.
- [ ] **S5:** Independent reviewers (security, privacy + UX, action-item linkage, signer-workflow) + fix bundle. Runbook `docs/runbooks/meetings.md` covering: the lifecycle (create → in-meeting → adjourn → pending_finalization → finalized), the 4-signature workflow (in-app vs off-app + evidence capture), the chain-anchor latency interaction with offline meeting capture (per ADR-0009 §3.12 — the chain proves server-receipt time, not meeting-start time), the quorum rule citations per jurisdiction, the snapshot vs. live action item discipline, the rep-as-records-custodian framing for off-app signer evidence, the operator-side seed procedure for the agenda template, the post-meeting "Network required" UX for adjournment + finalization, the rights-protective copy stance on the finalization screen, the deferred residuals (custom sections, off-app signer crypto verification, signer Tigris evidence GC).
- [ ] **`packages/legal-corpus`:** Confirm OHSA s.9(7) + s.9(8) (quorum rule) are seeded; if not, S1 adds them. Confirm CLC s.135.1 + CLC s.135.91 (federal quorum equivalent) are seeded; if not, S1 adds them. The `computeQuorum` function's `rule_citation` field reads the corpus entry's stable id.
- [ ] **2.2 (In-Meeting Action Item Management) absorbs:** The §3.2 Layer 3 snapshot table's `live` row promotion to `finalized` on status updates during a live meeting (the `live` snapshots accumulate; 2.2 adds the verify-item-closure-with-JHSC-counter-sign route that emits a chain event); the in-meeting move history surfaces in the section navigation; the key metrics dashboard becomes live-updating (currently it generates at adjournment only).
- [ ] **2.3 (Minutes Document Generation) absorbs:** The PDF generator that renders the `finalized` snapshot per §3.2 + the chain receipt panel + the 4 signature renderings + the distribution tracking. Source Serif 4 per the existing `pdf-shared` extraction from ADR-0008. Same step-up + audit + document-hash discipline per non-negotiable #16.
- [ ] **2.4 (Excel Re-Import Update Mode) absorbs:** The `POST /api/meetings/:id/import-drafts` route's 422-stub graduation to real implementation. The route lets the rep draft a meeting's notes/attendance in Excel and import the partial state into an in-progress in-app meeting; the reconciliation engine from ADR-0010 §3.5 extends for the meeting shape.
- [ ] **2.5+ absorbs:** Custom-named meeting sections via a `meeting_custom_sections` table (per §"Negative tradeoffs"); the section_type closed enum stays the structural backbone; custom sections carry a `display_name_envelope` and the chain payload references them by id only.
- [ ] **Release 2.x hardening absorbs:** Off-app signer Tigris evidence orphan-ciphertext GC job (forward seam from 1.7 deferral); off-app signer cryptographic verification via signer-supplied public key (forward seam — currently the rep is the custodian; a future workplace whose mgmt signers can publish keys could move to cryptographically-verified signatures); the `signer_display_name_ct` rotation procedure (mass-name-update on workplace org-chart changes).
- [ ] **Release 3 absorbs:** E2EE messaging between reps about a meeting (currently single-rep scope; multi-rep collaborative drafting of meeting notes is R3); AI-assisted minutes review (Adversarial Lens applied to meeting decisions — "how will this section of the minutes read in arbitration?"); push notifications for meeting reminders (Web Push placeholders ship in 1.10 per ADR-0009; the meeting reminder push lands in R3).
- [ ] `.context/decisions.md` entry referencing this ADR.

## S0 addendum — user decisions + threat-modeler folds

This section was appended at S0 close after the user resolved the three open scope questions and the threat-modeler (§2.13) surfaced five architectural concerns.

### User decisions (locked)

- **Snapshot retention.** `meeting_action_item_state` keeps the live mid-meeting rows after adjournment alongside the `finalized` row. The full deliberation history stays queryable; the table is single-tenant scale (one workplace, ~12 meetings/year, ~30 action items/meeting, ~5 status changes/meeting = ~1,800 rows/year — comfortably within audit-table sizing). The 2.3 PDF reads only the `finalized` snapshot.
- **Excel pre-meeting drafts.** `POST /api/meetings/:id/import-drafts` ships as a 422 stub in 2.1 with the documented "lands in 2.4" error body. Keeps 2.1 scope tight on the native flow; 2.4 (Excel Re-Import Update Mode) graduates the stub.
- **Section taxonomy.** The 12-value `section_type` enum is CLOSED for all of Release 2. `meeting_custom_sections` is removed from the post-2.1 backlog and pushed to Release 3 hardening (or never). Stable schema, predictable migrations across 2.1-2.10.

### Threat-modeler architectural folds (S1 owns implementation)

The §2.13 threat-modeler flagged five concerns that need to land in S1 to satisfy the threat coverage:

1. **TM-fold-1 (T-ML33) — `agenda_template_version` column on `meetings`.** S1 adds `meetings.agenda_template_version INT NOT NULL` (immutable post-creation, mirroring inspections per non-negotiable #13). The migration validates that the referenced template version exists in `meeting_templates` before commit; the route handler reads the version off the inserted row, not from request input, on subsequent operations.
2. **TM-fold-2 (T-ML9, T-ML11, T-ML25) — `meeting_sections.visibility` forward seam.** S1 adds `meeting_sections.visibility TEXT NOT NULL DEFAULT 'standard' CHECK (visibility IN ('standard', 'co_chair_only'))`. The `co_chair_only` value is a forward seam — 2.1 ships only `standard` populated, but the column exists so 2.5+ in-camera deliberation surfaces don't need a schema migration. The chain payload for `meeting.section.notes_appended` already excludes notes ciphertext per §3.10; this column gates the API's GET-section response shape too.
3. **TM-fold-3 (T-ML42) — `meeting.recommendation_drafted` chain anchor.** S1 extends the audit kind enum with `meeting.recommendation_drafted`, fired when a recommendation is drafted DURING a meeting (via the linkage from §3.2's `recommendations.meeting_id`). The payload carries `meeting_id`, `recommendation_id`, `section_id`, and the existing `recommendation.created` event's hash (the cross-chain anchor). This is in addition to (not instead of) the 1.9 `recommendation.created` event.
4. **TM-fold-4 (T-ML5, T-ML23) — `meeting_signatures.chain_of_custody_note_ct` + workplace signing-key signature.** S1 adds two columns to `meeting_signatures`:
   - `chain_of_custody_note_ct BYTEA` — encrypted free-text the rep records describing how the off-app signature was obtained (e.g., "received via signed PDF email from <role> 2026-06-10").
   - `attestation_signed_ct BYTEA` — the workplace signing key's Ed25519 signature over `SHA-256(signature_row_canonical_json)`. This makes the attestation row itself tamper-evident at the workplace-key layer (not just chain-anchored), defense in depth against DB-write tampering that goes around the chain.
5. **TM-fold-5 (T-ML29) — Excel attendance importer deferred to 2.4.** S1 does NOT consume an attendance sheet from Excel. The 422 stub at `POST /api/meetings/:id/import-drafts` matches TM-fold-5: when 2.4 graduates the stub, the attendance-sheet reconciliation lives there. S1 ships only the native `POST /api/meetings/:id/attendees` route.

### Slice handoff

S1 begins from this ADR + SECURITY §2.13. The S1 brief MUST reference these five TM-folds explicitly so the implementation doesn't drift. S5 reviewers verify each fold landed.
