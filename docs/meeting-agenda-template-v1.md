# Meeting Agenda Template v1

**Milestone 2.1 S4** · **Owner:** `apps/api/scripts/seed-meeting-template.ts` · **Schema:** `meeting_templates` (ADR-0012 §3.1)

This document describes the canonical "JHSC Standing Agenda v1" template that the M2.1 S4 seed script writes for the workplace's configured jurisdiction.

## Why this document exists

Per CLAUDE.md non-negotiable #13 (extended to meetings per ADR-0012 §3.3), the template a meeting was conducted under is pinned at meeting-creation time. A v1 meeting stays v1 forever — even if the template is later retired in favor of v2. This document captures the v1 shape so a future maintainer can read what the v1 meetings were structured by, without having to reverse-engineer the seed script.

The seed script is the only writer; the route handler (S2) trusts the column shape and casts. There is no route-level template editor in 2.1.

## The 11 ordered sections

Template v1 instantiates 11 entries from the closed 12-value `meeting_section_type` enum. The 12th slot (`complaints_review`) is deliberately left as a forward seam (see "Forward seams" below).

| `order_idx` | `section_type`       | `default_time_alloc_minutes` | `default_visibility` |
| ----------- | -------------------- | ---------------------------- | -------------------- |
| 0           | `call_to_order`      | 5                            | `standard`           |
| 1           | `roll_call_quorum`   | 5                            | `standard`           |
| 2           | `minutes_review`     | 10                           | `standard`           |
| 3           | `old_business`       | 20                           | `standard`           |
| 4           | `new_business`       | 20                           | `standard`           |
| 5           | `inspections_review` | 15                           | `standard`           |
| 6           | `incident_review`    | 10                           | `standard`           |
| 7           | `recommendations`    | 15                           | `standard`           |
| 8           | `other_business`     | 10                           | `standard`           |
| 9           | `next_meeting`       | 5                            | `standard`           |
| 10          | `adjournment`        | 5                            | `standard`           |

Total scheduled minutes: **120**. A typical JHSC quarterly meeting runs 90-120 minutes; v1 sits at the top of that band. The rep can extend any individual section in the live view — the `time_allocation_minutes` column on `meeting_sections` is per-row mutable even though the template default is fixed.

## Time-allocation rationale

The defaults reflect the cadence and shape of a quarterly JHSC meeting that has been operating with imported Excel minutes for one prior quarter (per ROADMAP.md line 175 — 2.1 lands after the 4-6 week real-world-use window).

- **`call_to_order`, `roll_call_quorum` — 5 min each.** Procedural bookends; the rep moves through them quickly. The `roll_call_quorum` section also hosts the live quorum compute per OHSA s.9(7-8) or CLC s.135.1, but the computation is incremental as attendance is captured — it does not add discussion time.
- **`minutes_review` — 10 min.** Re-reading the prior meeting's minutes is usually short but occasionally surfaces a correction the rep needs to record.
- **`old_business`, `new_business` — 20 min each.** This is where the meeting's real work happens. Carried items often outnumber new ones early in a quarter and flip late; the allocation is balanced.
- **`inspections_review` — 15 min.** A typical monthly inspection (per ADR-0007) produces 1-3 findings to discuss. The section reviews the rep's monthly walk-throughs plus any specialty inspections (e.g. annual rack inspection).
- **`incident_review` — 10 min.** Incident review is binary at this cadence — usually none happened in the period, occasionally one did and dominates. The allocation reflects the mean; the rep can extend when needed.
- **`recommendations` — 15 min.** Drafting an OHSA s.9(20) Notice of Recommendation in-meeting is rare but high-stakes. The allocation reserves space without forcing every meeting to produce one.
- **`other_business` — 10 min.** Catches anything not covered above.
- **`next_meeting`, `adjournment` — 5 min each.** Procedural closers.

## Forward seams

### The unused `complaints_review` slot

The `meeting_section_type` enum carries 12 values (per ADR-0012 §3.1 reconciliation + S0 user-decision: the enum is CLOSED for all of Release 2). Template v1 instantiates 11 of them. The 12th slot, `complaints_review`, is reserved as a forward seam:

- A workplace that wants formal complaints handling (e.g. for handling worker-submitted health/safety complaints under OHSA s.43 or CLC s.128 inside the standing meeting) can ship as a v2 template that adds the section.
- Because the section_type enum already accepts `complaints_review`, a v2 template lands as a NEW `meeting_templates` row with `version_number=2` and a `retired_at` set on the v1 row. No enum migration, no schema migration.
- The v2 surface lands as a separate milestone (out of 2.1 scope). The seed script does not handle v2.

### Multi-jurisdiction template variants

The current seed writes one row per jurisdiction (`ON` or `CA-FED`, read from the `WORKPLACE_JURISDICTION` env var via `config/workplace.ts`). The single-tenant scope per CLAUDE.md non-negotiable #1 means one workplace, one jurisdiction, one v1 row — no cross-jurisdiction multi-tenant complexity in this seed.

A future federal workplace conducted under the Canada Labour Code Part II uses the same v1 SHAPE; only the `jurisdiction` column differs. The quorum citation that surfaces in the `meeting_sections` `roll_call_quorum` section is computed against the runtime jurisdiction (OHSA s.9(7-8) vs CLC s.135.1) — the template structure is jurisdiction-agnostic.

## Versioning discipline

Per CLAUDE.md non-negotiable #13 (extended to meetings per ADR-0012 §3.3):

1. **v1 templates are immutable.** A meeting created with `agenda_template_version=1` stays v1 forever. The TM-fold-1 column `meetings.agenda_template_version` is `INT NOT NULL` and never UPDATEd post-create.
2. **v2 lands as a new row.** When a v2 template ships, the seed script (or a future operator-side migration) INSERTs a new `meeting_templates` row with `version_number=2` and SETs `retired_at = now()` on the v1 row. The historical v1 meetings keep their pinned reference; new meetings get v2.
3. **Append-only.** The seed script never UPDATEs an existing version row. The idempotency guard is a SELECT-first on `(template_code, version_number)`; if the row exists, the script logs `skipped=1` and exits 0 without emitting an audit anchor.
4. **The chain anchors the seed.** On the INSERT path the script emits one `audit.meeting_template.seeded` event with payload `{ templateVersion, jurisdiction, templateHash }`. The hash is `SHA-256(canonicalJsonStringify(sections))` — deterministic, PI-free, and the load-bearing anchor for the `--check-meetings` forward-defense walker (`apps/api/scripts/audit-log-verify.ts`). The walker rejects any `meeting.created` event whose `(jurisdiction, agendaTemplateVersion)` pair does not have a corresponding `audit.meeting_template.seeded` upstream.

## Legal corpus references

The template's structure is informed by the following statutory + procedural references. Per CLAUDE.md non-negotiable #5, the canonical citations live in `packages/legal-corpus`; the entries below are the corpus IDs the meeting surfaces reference at runtime:

- **OHSA s.9(18)** — Subjects the JHSC is required to address at its meetings (the basis for `minutes_review`, `inspections_review`, `incident_review`, `old_business`, `new_business`, `recommendations`).
- **OHSA s.9(19)** — Quarterly meeting frequency (the basis for the 120-minute scheduled default — quarterly meetings carry a heavier per-meeting agenda than monthly).
- **OHSA s.9(7-8)** — Quorum rule (live-computed in the `roll_call_quorum` section).
- **OHSA s.9(20)** — Notice of Recommendation (the basis for the `recommendations` section). The existing 1.9 surface (per ADR-0008) is the drafting flow this section references.
- **CLC s.135.1** — Federal equivalent of OHSA s.9 for the `CA-FED` jurisdiction; the seed's jurisdiction selector + the quorum computation switch on this.

Per the corpus discipline, the seed itself does NOT carry any citation text — only the structural section names. The `roll_call_quorum` quorum compute reads the citation at runtime from the corpus per `computeQuorum` in `packages/shared-types/src/meeting-quorum.ts`.

## Runbook reference

See `docs/release-1-deploy-runbook.md` §4.4a for the operator-side seed step + verification SQL. The seed is part of the post-migration bootstrap sequence and runs ONCE per deployed environment per jurisdiction.
