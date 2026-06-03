# ADR-0013: In-Meeting Action Item Management

Status: Proposed, Milestone 2.2
Date: 2026-06-03
Authors: codifies Milestone 2.2 architect-phase decisions; pairs with `SECURITY.md` §2.14 (forthcoming, threat-modeler agent in parallel) and `docs/runbooks/in-meeting-action-items.md` (forthcoming, S5).

## Context

M2.1 (ADR-0012) shipped the meeting lifecycle substrate. PR #31 (merged commit `51f317a`) landed the seven new tables (`meetings`, `meeting_sections`, `meeting_attendance`, `meeting_inspection_review`, `meeting_signatures`, `meeting_templates`, `meeting_action_item_state`), the 4-signer counter-sign workflow, the 13 audit kinds (the eleven enumerated in ADR-0012 §3.10 plus the two TM-folds — `meeting.recommendation_drafted` per TM-fold-3 / T-ML42 and the implicit start/end split that became `meeting.section.started` + `meeting.section.ended`), the `live` / `finalized` snapshot two-state machine on `meeting_action_item_state`, the action-item PATCH extension that drops `live` snapshot rows when the patched item points at an `in_progress` meeting (`writeLiveActionItemSnapshot` in `apps/api/src/routes/meetings/index.ts:2116`), the immutable `action_items.first_raised_meeting_id` provenance column + the mutable `action_items.meeting_id` operational column per ADR-0012 §3.2, and the adjournment promotion sweep that walks `DISTINCT ON (action_item_id)` live rows and INSERTs `finalized` companions inside the adjourn transaction (`apps/api/src/routes/meetings/index.ts:1611-1666`). The S5 reviewer-trio (`docs/release-2-m2.1-{security,privacy-ux,linkage-signer}-review.md`) verified the linkage substrate is clean (linkage review §"Verified clean", lines 198-260): provenance immutability is enforced by the `.strict()` PATCH Zod schema, snapshot writes correctly short-circuit on non-`in_progress` meetings, the finalized partial UNIQUE catches adjourn-replay, live rows are retained post-adjournment per S0 user-decision so the deliberation history stays queryable, and the `worker_co_chair`-only `in_app_passkey` shape gate has defense in depth at both the route and the DB CHECK layers.

Three follow-ups from ADR-0012 land in 2.2 per the "2.2 absorbs" bullet (ADR-0012 line 644): (a) the `live` snapshot's promotion to `finalized` on **in-meeting status updates** beyond the existing PATCH-time snapshot, plus a new "verify-item-closure-with-JHSC-counter-sign" route that emits a chain event; (b) the in-meeting move history surfaces in the section navigation (currently the M2.1 meeting detail view at `apps/web/src/views/meeting-detail-view.tsx:447-462` punts to a `/action-items?meetingId=` link per F-L8 — "defer to 2.2"); (c) the key metrics dashboard becomes live-updating (currently it computes only at adjournment per `apps/api/src/routes/meetings/index.ts:1581-1607`, payload-embedded in `meeting.adjourned`). M2.2 also picks up F-L3 (count chip in section view) and the closure-verification gap that the action-item taxonomy in CLAUDE.md has always implied (`Pending Review` → `Closed` is "Verified by JHSC" per the Status table) but that 1.6 left as a plain status PATCH with no counter-signer attestation.

ROADMAP.md §"Milestone 2.2" (lines 199-205) enumerates four scope lines: add action items during a live meeting; move items between sections in real time; status updates during the meeting; verify item closure with JHSC counter-sign; key metrics dashboard live-updates. The first three are already structurally possible through the M2.1 + 1.6 substrate — `POST /api/action-items` accepts `firstRaisedMeetingId`, `POST /api/action-items/:id/moves` accepts `meetingId`, and `PATCH /api/action-items/:id` extends `meeting_action_item_state` via `writeLiveActionItemSnapshot`. What is missing is the **surface**: the meeting detail view's section panels must hold the action-item cards directly (not link out), the swipe-to-move + inline status menu must operate without leaving the meeting view, the meeting-aware count chip must surface per-section live counts sourced from the snapshot table, and the move history must render in the section navigation. The fourth scope line is the new entity: closure verification with JHSC counter-sign is a state transition stronger than a plain `Pending Review → Closed` status PATCH; per the spirit of M2.1's 4-signer attestation pattern, it deserves its own attestation route + chain anchor + step-up gate so an arbitrator reading the chain sees "this item was closed AND a JHSC counter-signer attested to that closure" as a distinct evidentiary moment.

The 1.6 substrate makes most of this cheap. `apps/api/src/db/schema.ts:452` already carries `verifiedByJhscId uuid REFERENCES users(id)` on `action_items` (added in 1.6 anticipating this milestone); the M2.1 `meeting_action_item_state` table is the snapshot the live metrics dashboard reads from; the chain has `action_item.created` / `action_item.updated` / `action_item.moved` / `meeting.action_item_snapshot` already and we add a thin layer of meeting-aware cross-anchors plus the new closure-verification kind. The substrate is dense; this ADR is mostly extensions. The deeper architectural question — whether closure verification is "just a status change with a counter-signer" or "a state-machine transition that emits its own anchor and is recorded in its own table" — is settled in §3.1 below in favor of a small dedicated table (`action_item_closures`) for the same reasons ADR-0012 §3.9 settled on `meeting_signatures` rather than denormalizing a JSON blob on the parent: per-row chain anchoring, structural append-only invariant, and an immediate seam for the 2.3 PDF generator to render "closed by X; counter-signed by Y".

`apps/web/src/views/meeting-detail-view.tsx` is the canonical surface this ADR extends; `apps/web/src/views/action-item-detail-view.tsx` gains the closure-verification flow + the per-meeting history timeline; `apps/web/src/views/action-items-view.tsx` is unchanged for 2.2 (the list view's filter set already includes `meetingId`). ADR-0012 §3.2 is the load-bearing reference for the snapshot-vs-live discipline; ADR-0005 is the action-item lifecycle backbone; ADR-0009 is the offline-sync substrate every new route consumes; ADR-0001 §"step-up" is the gate for the counter-sign route; ADR-0002 §"Audit chain payloads" is the T-AC9 PI-free payload invariant. The 6-8 week real-world-use window between M2.1 deploy and M2.2 start — the rep will have run at least one full native quarterly meeting end-to-end before this milestone — informs the design: the friction calibration of the inline status menu and the count-chip placement should reflect what the rep actually wanted while running M2.1.

## Decision

Land one new table (`action_item_closures` — the JHSC counter-sign attestation row, parallel in shape to `meeting_signatures` but scoped to a single action item's closure), no new columns on existing tables, eight new API routes (or four new routes plus four extensions to existing routes — see §3.2), one new `meeting_action_item_section_moves` materialized read-view (not a table) computed from the existing `action_item.moved` chain anchors filtered by `payload.meetingId`, four new `AuditEventKind` values (`action_item.closure_verified`, `meeting.action_item_added`, `meeting.action_item_moved`, `meeting.action_item_status_changed`), and extend the M2.1 meeting detail view to hold per-section action-item card lists with inline status menu + swipe-to-move + closure-verification CTA. The live metrics dashboard becomes a `GET /api/meetings/:id/metrics` endpoint that recomputes on every call (single-tenant scale; cost is bounded; the canonical pattern matches ADR-0012 §3.8's "compute on every read" stance for adjourned-meeting metrics). The new dashboard renders inside the live meeting view as a sticky chip group above the section accordion + a full panel inside the `adjournment` section (the latter pre-exists from M2.1 — the M2.2 change extends it to live mode pre-adjournment).

Closure verification is a STATE transition stronger than a status PATCH: an action item moves through `Pending Review → Closed` only via `POST /api/action-items/:id/close-verification`, which requires step-up (per non-negotiable #16 — verification produces evidentiary value), records the closer's identity + the counter-signer's identity + the closure reason (encrypted envelope) + an optional Tigris evidence blob, sets `action_items.verified_by_jhsc_id`, sets `action_items.closed_date = now()`, sets `action_items.status = 'Closed'`, emits the `action_item.closure_verified` chain anchor with the canonical-row hash from the new `action_item_closures` row, and — if the action item is linked to an active meeting — also emits a `meeting.action_item_status_changed` cross-anchor so the meeting's chain composes with the action item's. The closer and counter-signer MUST be different users (single-tenant scope means today this is a forward seam — the rep is both roles until 2.5 introduces a second in-app worker rep; documented under §3.5's rights-protective posture); the in-app counter-signer must have `worker_co_chair` role per the M2.1 `config/workplace.ts` `minutesSignerRoles` enum.

In-meeting moves and status changes do NOT require step-up — the routine `PATCH /api/action-items/:id` and `POST /api/action-items/:id/moves` routes are mobile-primary operations the rep will run dozens of times per meeting; step-up every time would break the in-meeting flow per ADR-0012 §3.10's same calibration. The existing 1.6 step-up gates for `* → archived` and `archived → old_business` and `completed_this_period → old_business` remain unchanged. The cross-chain anchors (`meeting.action_item_added`, `meeting.action_item_moved`, `meeting.action_item_status_changed`) are emitted alongside the existing per-action-item anchors when the operation occurs inside an `in_progress` meeting; they wrap the existing 1.6 chain kinds with a meeting-context envelope (per the same TM-fold-3 / T-ML42 pattern that wrapped `recommendation.drafted` with `meeting.recommendation_drafted` in M2.1). The in-meeting move history surfaces in the section navigation via a read-only query against the audit chain filtered by `(meeting_id, kind='action_item.moved')` and the new `meeting.action_item_moved` cross-anchor — no new materialized table; the chain is the source of truth.

The live metrics dashboard recomputes on every read (per the M2.1 §3.8 stance carried forward — single-tenant cost is bounded; consistency with the chain is the priority). The dashboard's read endpoint is `GET /api/meetings/:id/metrics`; the response carries the same shape as the M2.1 `meeting.adjourned` payload metrics dict (per ADR-0012 §3.8 lines 396-418) plus a `byStatus` breakdown derived from the `live` snapshot rows. Reads are NOT chain-anchored (M2.1's `evidence.list_accessed` precedent shows the project is selective about read anchoring; metrics reads on the live meeting view fire potentially dozens of times during the meeting as the rep refreshes; chain-anchoring each one would explode the chain for no evidentiary value — the canonical metrics anchor is still the `meeting.adjourned` payload at adjournment time). The web client extends `meeting-detail-view.tsx`'s section content patterns from "link out to action-items list" to "inline card-list with inline status menu + swipe-to-move + count chip + closure-verification CTA". The card-list component reuses the existing 1.6 `ActionItemRow` rendering (already covered for accessibility per the 1.12 WCAG audit); the inline status menu is a Radix Select primitive per the established shadcn/ui pattern; swipe-to-move composes Framer Motion gesture detection per the established 1.6 signature interaction. The action-item detail view gains the closure verification flow (a sheet that opens on the existing detail page; sticky bottom CTA on mobile) and the per-meeting history timeline (a new section in the existing detail page that renders the chain-derived meeting touch history).

### 3.1 Tables + existing-table extensions

One new table lands in `apps/api/src/db/schema.ts` + `migrations/0012_in_meeting_action_items.sql` (next-in-sequence per the CLAUDE.md append-only rule). Zero new columns on existing tables — the M2.1 substrate already carries everything else.

#### `action_item_closures` — JHSC counter-sign attestation

```
action_item_closures (
  id                          uuid primary key default gen_random_uuid(),
  action_item_id              uuid not null references action_items(id) on delete restrict on update restrict,
  meeting_id                  uuid references meetings(id) on delete set null on update restrict,
                                -- nullable: closure may be recorded outside a meeting context
  closed_by_actor_id          uuid not null references users(id) on delete restrict on update restrict,
  closed_at                   timestamptz not null default now(),
  counter_signer_actor_id     uuid not null references users(id) on delete restrict on update restrict,
  counter_signed_at           timestamptz not null default now(),
  closure_reason_ct           bytea not null,                              -- envelope-encrypted (#4)
  closure_reason_dek_ct       bytea not null,
  evidence_storage_key        text,                                        -- optional Tigris key
  evidence_envelope_ct        bytea,                                       -- nullable; sealed if evidence present
  evidence_envelope_dek_ct    bytea,
  step_up_jti                 text not null,                               -- the counter-signer's step-up grant
  attestation_signed_ct       bytea not null,                              -- Ed25519 sig over canonical row JSON
  signing_key_id              uuid not null references workplace_signing_keys(id)
                                on delete restrict on update restrict,
  audit_idx                   bigint not null references audit_log(idx)
                                on delete restrict on update restrict,
  version                     integer not null default 1,
  created_at                  timestamptz not null default now()
);
```

Indexes: `action_item_closures_action_item_unique` UNIQUE on `(action_item_id)` — exactly one closure attestation per action item; reopening (`completed_this_period → old_business` per the 1.6 transition graph at `packages/shared-types/src/action-item-transitions.ts:45`) does NOT create a second closure row, it appends an `action_item.reopened` chain anchor while keeping the prior closure attestation as historical evidence of "this was once closed and counter-signed". A subsequent re-close MUST go through a new route (`POST /api/action-items/:id/close-verification` is idempotent on the UNIQUE — see §3.2); the structural answer is to allow at most one attestation per action item AND to surface the reopening as a chain event rather than a second attestation. `action_item_closures_meeting_idx` on `meeting_id` for the live dashboard's "items closed this meeting" query (the route uses `meeting_id` to count). `action_item_closures_audit_idx_unique` UNIQUE on `audit_idx` per the per-entity audit-anchor invariant carried forward from ADR-0007 §3.6. Pair-NULL CHECK on `(evidence_envelope_ct, evidence_envelope_dek_ct)`. Method-shape CHECK: `closed_by_actor_id != counter_signer_actor_id` (the two roles cannot be the same user — see §3.5 for the forward seam handling).

**Why a separate table beats denormalizing on `action_items`.** Three trade-offs justify the parallel-to-`meeting_signatures` shape over extending `action_items` with `counter_signer_actor_id` + `counter_signed_at` + `closure_reason_envelope` columns:

1. **Append-only invariant for evidentiary defensibility.** The action_items row mutates routinely (status, risk, dates, follow-up owner, section). Adding three closure-attestation columns means routine PATCHes must NEVER write those columns (defense-in-depth required: route-layer allowlist + DB CHECK that closure columns are write-once). A separate table with `INSERT ONLY` semantics and `attestation_signed_ct` Ed25519 over canonical row JSON (the same TM-fold-4 pattern from M2.1) is structurally append-only — no UPDATE path on the table, period.
2. **Per-row chain anchoring with its own audit_idx.** The `action_item_closures` row has its own `audit_idx` FK to the `action_item.closure_verified` chain row. The `meeting_signatures` pattern (ADR-0012 §3.1) is the direct precedent. A denormalized-on-action_items version would either reuse `action_items.audit_idx` (the row already has it from 1.6 — but it anchors `action_item.created`, not closure; reusing it overloads the FK semantics) or add a second audit_idx column to action_items (denormalization with no upside).
3. **Workplace signing-key signature over row canonical-JSON.** Like `meeting_signatures.attestation_signed_ct` (TM-fold-4 per ADR-0012), the closure row carries an Ed25519 detached signature over `SHA-256(canonical_row_json)` produced by the workplace signing key. This makes the attestation tamper-evident at the workplace-key layer in addition to chain-anchoring — defense in depth against a DB-level attacker who goes around the chain. Denormalizing on `action_items` would force the signature to be computed over the entire action_items row (which mutates), defeating the cryptographic anchor.

**Cost.** One additional table; one additional join when rendering an action item's closure metadata (the existing 1.6 detail view query already joins to `action_item_moves` for the history, so the precedent is established). Acceptable.

**No new columns on `action_items`.** The 1.6 schema (`apps/api/src/db/schema.ts:452`) already carries `verifiedByJhscId uuid REFERENCES users(id)` (added 1.6 anticipating this milestone). The closure-verification route SETs this column at the same time as it INSERTs the closure row + flips status to `Closed` + sets `closed_date`; the column is the fast-path lookup for "is this item closed" while the closure row carries the evidentiary record.

**Move-history materialization.** The "in-meeting move history surfaces in the section navigation" deliverable (ADR-0012 follow-up) does NOT require a new materialized table. The existing `action_item_moves` table (`apps/api/src/db/schema.ts:494`) already carries `meeting_id` since 1.6 + a `moved_by_user_id` + `from_section` + `to_section` + `audit_idx` FK; the existing `action_item.moved` chain anchor carries the same data PI-free. The §3.6 read path queries `action_item_moves WHERE meeting_id = $1 ORDER BY moved_at DESC` and joins to `users` for the actor display — no new schema. The cross-chain anchor `meeting.action_item_moved` (per §3.3) wraps the existing `action_item.moved` event with a meeting envelope; the verifier walks both kinds. Justification: a new `meeting_section_moves` table would denormalize what `action_item_moves` already carries; the existing table is the canonical source; the M2.1 chain-anchor wrapping pattern (`meeting.recommendation_drafted` wraps `recommendation.drafted` per TM-fold-3) is the same recipe.

**Migration file path:** `migrations/0012_in_meeting_action_items.sql`. Append-only. Down-migration: the standard "we don't ship down migrations" stance.

### 3.2 Routes

Four new routes + four extensions to existing routes. All POST routes are wrapped by the existing `idempotencyKeyGuard` middleware per ADR-0009 §3.4; mutating routes accept `If-Match: <version>` per ADR-0009 §3.7 where applicable; `clientId` body field accepted on creates per ADR-0009 §3.3.

#### New routes

- **`POST /api/action-items/:id/close-verification`** — the JHSC counter-sign closure attestation. Step-up required (`action='action_item.close_verification'`, 60s window). Body: `{ counterSignerActorId, closureReasonCt, closureReasonDekCt, evidenceStorageKey?, evidenceEnvelopeCt?, evidenceEnvelopeDekCt?, clientId? }`. Validation: action item exists; current `status IN ('Pending Review', 'In Progress', 'Blocked')` (a `Not Started` item closing without ever being worked on is a soft warning surfaced in the UI, not a route-layer error — see §3.5 rights-protective stance); current `section IN ('new_business', 'old_business', 'recommendation')` (a `completed_this_period` or `archived` item is already at a closed state; this route is for the verification moment, not the section move that follows); no existing closure row for this action_item (UNIQUE catches; route returns 409 `already_verified` with the existing closure row's metadata); the counter-signer has `worker_co_chair` role per M2.1 `config/workplace.ts`; the counter-signer is different from the closer (the route reads the closer from the authenticated session; if `auth.userId === counterSignerActorId` the route returns 422 `closer_counter_signer_conflict` with the rights-protective forward-seam message — see §3.5). Server transaction: INSERT `action_item_closures` row; UPDATE `action_items SET status='Closed', closed_date=now(), verified_by_jhsc_id=<counterSignerActorId>, version=version+1`; if `action_items.meeting_id` is set AND that meeting is `in_progress`, write a `live` snapshot row via the existing `writeLiveActionItemSnapshot` helper from M2.1 (`apps/api/src/routes/meetings/index.ts:2116`); emit `action_item.closure_verified` chain anchor with the closure row's canonical-row hash + the workplace signing-key id; if linked to an active meeting, emit `meeting.action_item_status_changed` cross-anchor. COMMIT. Returns the closure envelope + the updated action item.

- **`GET /api/meetings/:id/metrics`** — the live metrics dashboard read endpoint. No step-up. Read-only. Computes on every call from the underlying tables (NOT from a cached column). Returns:

  ```ts
  {
    meetingId: string;
    asOf: string;                           // server timestamp
    durationSecondsElapsed: number;         // (now - actual_start_at), 0 if not yet started
    itemsRaisedThisMeeting: { count: number; ids: string[] };
    itemsClosedThisMeeting: { count: number; ids: string[] };        // from action_item_closures.meeting_id
    recommendationsDrafted: { count: number; ids: string[] };
    inspectionsReviewed: { count: number; ids: string[] };
    quorumCompliance: { metAtCallToOrder: boolean; currentlyMet: boolean; ruleCitation: string };
    actionItemCountBySection: {
      new_business: number; old_business: number;
      recommendation: number; completed_this_period: number; archived: number;
    };
    actionItemCountByStatus: {                                       // NEW vs. M2.1
      'Not Started': number; 'In Progress': number; 'Blocked': number;
      'Pending Review': number; 'Closed': number; 'Cancelled': number;
    };
    sectionMoveCount: number;               // chain-anchor count for this meeting
  }
  ```

  The query joins `meetings` + `action_items` (filtered by `meeting_id` for current-discussion items + `first_raised_meeting_id` for raised-this-meeting items) + `action_item_closures` (filtered by `meeting_id` for closed-this-meeting items) + `recommendations` (filtered by `meeting_id` per the M2.1 extension) + `meeting_inspection_review` + `meeting_attendance` (for quorum). All counts derived live; no denormalization. The route is NOT chain-anchored (selective read-anchoring posture per `evidence.list_accessed` precedent). Returns 404 if the meeting does not exist; returns the metrics regardless of meeting status (the route is useful pre-start to show "0 items raised" empty state, mid-meeting to show live counts, and post-adjournment to show "what changed since adjournment" — same shape, different temporal context).

- **`GET /api/meetings/:id/action-items`** — the meeting-scoped action item list for the in-section card-list render. Read-only. No step-up. Returns the action items relevant to a meeting, grouped by the section the rep would expect them in for the meeting's purposes:

  ```ts
  {
    meetingId: string;
    items: {
      new_business: ActionItemSummary[];   // current_section='new_business' AND status NOT IN ('Closed','Cancelled')
      old_business: ActionItemSummary[];   // current_section='old_business' AND status NOT IN ('Closed','Cancelled')
      recommendation: ActionItemSummary[]; // current_section='recommendation' AND status NOT IN ('Closed','Cancelled')
      closedThisMeeting: ActionItemSummary[]; // closed via action_item_closures.meeting_id = $1
    };
    asOf: string;
  }
  ```

  Each `ActionItemSummary` carries the existing 1.6 `ActionFlag`, `summary` (per the existing `safeSummary` decrypt-on-server pattern), `status`, `risk`, `section`, `sequenceNumber`, `version` (for the next If-Match), and a new `meetingContext: { firstRaisedHere: boolean; previousMeetingTouchCount: number }` so the UI can render the "raised this meeting" badge vs. the "carried from N meetings ago" indicator (per §3.7 cross-meeting visibility). The route's content lives at the meeting endpoint not the action-items endpoint because it composes the closure + snapshot + recommendation data the live meeting view needs; the existing `GET /api/action-items?meetingId=` is unchanged (it returns a flat list, no per-section grouping, no closed-this-meeting bucket).

- **`GET /api/action-items/:id/meeting-history`** — the per-action-item meeting touch history for the action-item detail view's new timeline section. Read-only. No step-up. Returns the rows from `action_item_moves` filtered by `action_item_id = $1` joined to `meetings` for date context, plus the rows from `meeting_action_item_state` filtered by `action_item_id = $1` for per-meeting snapshot history, plus the closure row if present. The shape:

  ```ts
  {
    actionItemId: string;
    firstRaisedMeetingId: string | null;
    firstRaisedMeetingDate: string | null;
    history: Array<{
      meetingId: string;
      meetingDate: string;
      moves: Array<{
        fromSection: string | null;
        toSection: string;
        movedAt: string;
        movedByActor: string;
      }>;
      snapshots: Array<{
        snapshotKind: 'live' | 'finalized';
        snapshotAt: string;
        status: string;
        section: string;
      }>;
      closure?: {
        closedAt: string;
        counterSignedAt: string;
        closedByActor: string;
        counterSignerActor: string;
      };
    }>;
    asOf: string;
  }
  ```

  Decrypts the closer + counter-signer names client-side (server returns the user_ids; the web client looks them up against the cached attendance display names). The route is read-only and decrypts NOTHING server-side (the closure reason envelope is fetched via the existing detail endpoint with appropriate step-up gating, not here).

#### Extensions to existing routes

- **`POST /api/action-items`** (1.6 + M2.1) — already accepts `firstRaisedMeetingId` per ADR-0012 §3.2 / `apps/api/src/routes/action-items/index.ts:108`. M2.2 adds the emission of `meeting.action_item_added` cross-anchor when the create call carries a non-null `firstRaisedMeetingId` AND the referenced meeting's `status='in_progress'`. The cross-anchor wraps the existing `action_item.created` event per the TM-fold-3 pattern; the payload carries `{ meetingId, actionItemId, sectionType, actionItemCreatedHash }` (the hash of the prior chain row per the M2.1 `computeChainEntryHash` helper at `apps/api/src/routes/meetings/index.ts:2179`).

- **`POST /api/action-items/:id/moves`** (1.6 + M2.1) — already accepts `meetingId` per the 1.6 `moveBody` Zod schema at `apps/api/src/routes/action-items/index.ts:194`. M2.2 adds the emission of `meeting.action_item_moved` cross-anchor when the call carries a non-null `meetingId` AND the referenced meeting is `in_progress`. Payload: `{ meetingId, actionItemId, fromSection, toSection, actionItemMovedHash }`. The existing 1.6 step-up gating (`* → archived` and the reopen paths) is unchanged.

- **`PATCH /api/action-items/:id`** (1.6 + M2.1) — already writes `live` snapshots via `writeLiveActionItemSnapshot` per ADR-0012 §3.2 Layer 3 / `apps/api/src/routes/action-items/index.ts:907`. M2.2 adds the emission of `meeting.action_item_status_changed` cross-anchor when the PATCH includes a `status` change AND the resulting row's `meeting_id` points at an `in_progress` meeting. Payload: `{ meetingId, actionItemId, fromStatus, toStatus, actionItemUpdatedHash }`. The `live` snapshot write is unchanged from M2.1.

- **`POST /api/meetings/:id/adjourn`** (M2.1) — already promotes `live` snapshots to `finalized` per ADR-0012 §3.8 / `apps/api/src/routes/meetings/index.ts:1611-1666`. M2.2 extends the metrics-dict computation in the chain payload (lines 1684-1694) to include the new `actionItemCountByStatus` breakdown and the `sectionMoveCount` (chain-derived). The payload shape change is additive (new optional fields); the existing M2.1 finalize verifier (the `--check-meetings` extension per ADR-0012 §S0) tolerates the extra fields because the audit-payload Zod schema is parse-on-extra-rejection at the type layer but the verifier's payload-shape check accepts additive extensions per the 1.12 T-HD28 forward-defense pattern.

### 3.3 Audit kinds

Four new `AuditEventKind` values land in `packages/shared-types/src/index.ts` extending the existing union (per `packages/shared-types/src/index.ts:108-171`):

```ts
| 'action_item.closure_verified'             // POST /api/action-items/:id/close-verification (write)
| 'meeting.action_item_added'                // cross-anchor on POST /api/action-items when first_raised_meeting_id active
| 'meeting.action_item_moved'                // cross-anchor on POST /api/action-items/:id/moves when meetingId active
| 'meeting.action_item_status_changed'       // cross-anchor on PATCH /api/action-items/:id when meetingId active + status changed
```

Per-kind `AuditPayload` shapes land in the discriminated union in `packages/shared-types/src/index.ts:776+` (extending the existing meeting payload block from M2.1). Per the T-AC9 invariant (ADR-0002), NO PI in chain payloads — IDs, counts, hashes, structured rule citations, role enums, status/section enum values; never names, never note plaintexts, never closure-reason plaintexts. The closure-verification payload carries `{ meetingId?, actionItemId, closureId, counterSignerActorId, closedByActorId, closureReasonHash, evidenceHash?, attestationSignatureHash, signingKeyId, closedAt }` — note: the user IDs (closer, counter-signer) ARE in the payload (consistent with `meeting.signed` per ADR-0012 §3.10 which carries `signerActorId`); user IDs are UUIDs and per the M2.1 precedent they are non-PI under the project's payload convention (the names are encrypted; the IDs are stable internal identifiers).

**Read-vs-write anchoring discipline.** All four new kinds anchor WRITES, not reads:

- `action_item.closure_verified` — anchors the closure INSERT; one row per closure attestation; UNIQUE on `action_item_id` upstream makes replay benign.
- `meeting.action_item_added` — anchors the cross-meeting bind on a create; one row per create-inside-a-meeting; the underlying `action_item.created` is the per-item anchor.
- `meeting.action_item_moved` — anchors the cross-meeting bind on a move; one row per move-inside-a-meeting; the underlying `action_item.moved` is the per-item anchor.
- `meeting.action_item_status_changed` — anchors the cross-meeting bind on a status change; one row per status-change-inside-a-meeting; the underlying `action_item.updated` is the per-item anchor.

The `GET /api/meetings/:id/metrics` route does NOT emit an anchor. The `GET /api/meetings/:id/action-items` route does NOT emit an anchor. The `GET /api/action-items/:id/meeting-history` route does NOT emit an anchor. The project's read-anchoring posture is selective per the 1.7 precedent (`evidence.read` anchors decryption events because plaintext exposure is the load-bearing event; `evidence.list_accessed` anchors list reads because the list of evidence IDs is itself sensitive). In-meeting metrics reads expose no PI and surface aggregates only; chain-anchoring each refresh would explode the chain. The canonical evidentiary anchor for metrics remains `meeting.adjourned`'s payload (per M2.1 §3.8 — a quarterly meeting produces one canonical metrics snapshot, anchored once, in the chain).

**Chain growth at single-tenant scale.** Four new kinds × the operational frequencies: closure-verifications happen for ~30-50 items/year (the rate at which items close in a typical workplace); cross-anchors fire on every in-meeting operation (per a quarterly meeting: ~30 moves, ~50 status changes, ~10 adds = ~90 cross-anchors/meeting × 4 meetings = ~360/year). Total: ~410 new chain rows/year. Negligible at the existing chain scale (~1000-2000 rows/year per the 1.12 backup-restore runbook bound).

### 3.4 Live metrics dashboard

The dashboard renders inside the live meeting view as TWO surfaces:

1. **Sticky chip-bar above the section accordion** — a horizontally-scrollable row of 5-7 chips (Items raised | Items closed | Recommendations drafted | Inspections reviewed | Quorum status | Section moves | Duration) with current values, refreshed via SWR-style poll (5s interval) when the meeting is `in_progress`, no refresh post-adjournment (the static metrics are the canonical record). Each chip is a Lucide-icon + label + value pattern; tapping a chip opens a slide-up sheet with the breakdown (e.g., "5 items raised this meeting → list view"). Mobile-primary: chips wrap to a second row at 390px if needed; touch targets ≥44pt.

2. **Full panel inside the `adjournment` section** — the existing M2.1 adjournment summary surface (per `apps/web/src/views/meeting-adjournment-view.tsx`) gains a live pre-adjournment mode. Pre-adjournment, the panel shows the same metrics dict the chip-bar surfaces but with the new `actionItemCountByStatus` breakdown rendered as a small stacked bar chart (Recharts, per the locked stack) plus a "These metrics will be the canonical adjournment record" banner. Post-adjournment, the panel renders the chain-anchored metrics from `meeting.adjourned`'s payload (immutable).

**Refresh mechanism.** SWR with `refreshInterval: 5000` on the `GET /api/meetings/:id/metrics` endpoint while the meeting is `in_progress`. No SSE, no WebSockets — the polling cost at 5s/12-per-minute × 90 min = ~1100 reads per meeting × cheap aggregate queries × single-tenant scale is well within budget. The poll suspends when the meeting status is anything other than `in_progress` (post-adjournment the metrics are static). The poll also suspends when the document is hidden (per `document.visibilityState === 'hidden'` — the rep on a backgrounded tab does not need fresh metrics).

**Offline behavior.** The metrics endpoint is best-effort online — the dashboard surfaces a "Cached from <T>" badge when the last fetch is stale (>30s). The Dexie cache stores the last successful response with a TTL; the offline mode reads from cache. No queued writes drive metrics (metrics are read-only). The mobile-primary calibration: a rep walking through a no-signal hallway sees the most recent metrics in the chip-bar with the stale badge; no spinner, no error, no degraded experience.

**Mobile-primary layout per non-negotiable #9.** At 390px, the chip-bar is the primary surface; tapping a chip slides up the breakdown. The full adjournment-section panel uses the existing M2.1 layout pattern (single-column on mobile, two-column on tablet/desktop). The chip-bar carries `data-print="hide"` per the 1.12 print convention; the full adjournment panel renders in print with the static metrics + `data-print="evidentiary"` on the metric values' JetBrains-Mono rendering.

### 3.5 JHSC counter-sign workflow

The most security-sensitive surface in M2.2. The closure verification is a state transition stronger than a status PATCH: an action item's closure produces an evidentiary moment that a hostile arbitrator six months from now will read as "this item was closed AND a JHSC counter-signer attested to the closure on date X with reason Y and (optionally) evidence Z." The same posture as ADR-0012 §3.9's meeting finalization — the closure attestation is the chain anchor; the rep is the records custodian.

**Who counter-signs.** A single role: `worker_co_chair` per the M2.1 `config/workplace.ts` `minutesSignerRoles` enum. This is the worker-side authoritative signer; the counter-sign verifies that "the JHSC's worker side accepts that this item is closed." A future milestone could extend the counter-sign to require a 2-signer (worker + management) attestation at the item level, but M2.2 keeps it simple: one counter-signer, the worker co-chair, the same in-app actor who signs meeting finalizations. Per single-tenant scope, the worker_co_chair role is held by exactly one in-app user (the rep) at any time per ADR-0001's first-run setup.

**Closer-vs-counter-signer distinction.** The closure attestation table CHECK requires `closed_by_actor_id != counter_signer_actor_id`. The closer is the in-app user who tapped "Close item"; the counter-signer is the in-app user who tapped "Counter-sign" on the same item. At single-tenant scale with one in-app user, this constraint is a forward-seam — until 2.5 introduces a second in-app worker rep, the rep cannot satisfy the constraint and the closure route will return 422 `closer_counter_signer_conflict`. The rep workaround for 2.2: the closure attestation route includes a `selfAttestation: boolean` field; when `true`, the route accepts `closed_by_actor_id == counter_signer_actor_id` BUT records a chain-anchored note `selfAttestation: true` in the payload + surfaces a rights-protective copy banner in the UI ("You closed and counter-signed this item; in a multi-rep setup, the counter-sign would be a second worker rep. The chain records this as a self-attestation."). The `selfAttestation` flag is the structural seam; when 2.5 lands the second worker rep, the flag becomes `false` for the routine path and `true` only for emergency self-attestations the rep documents.

**Step-up gate.** Required per non-negotiable #16 (every export/evidentiary action requires step-up + audit). Action: `action_item.close_verification`. Freshness window: 60s, the M2.1 precedent. The counter-signer must satisfy step-up freshness AT the time of the route call; if the rep is collecting the closure over a longer period (rare; closure is typically a single moment), the step-up modal re-prompts. The `step_up_jti` is recorded on the `action_item_closures` row per the M2.1 `meeting_signatures` pattern.

**Closure reason.** Free-text encrypted envelope. The rep types the closure rationale in the slide-up sheet; the plaintext is sealed-box-encrypted client-side under the workplace public key (same posture as M2.1 attendance display names) before submit. The server stores ciphertext only. The reason renders in the 2.3 PDF generator via the established workplace-private-key decryption path. The chain payload carries `closureReasonHash = sha256(closureReasonCt)` — no plaintext, no PI. The reason field is MANDATORY (the closure verification's evidentiary weight depends on the documented rationale); the route validates min-length-1 + max-length-4000 per Zod.

**Evidence (optional Tigris blob).** A rep may attach evidence to the closure (e.g., a photo of the corrected condition, an email confirming the fix). The evidence flow reuses the 1.7 Tigris evidence pattern per ADR-0006: client-side encryption + content-MD5-enforced presign + chain-anchored hash. The closure row carries `evidence_storage_key` (Tigris key) + `evidence_envelope_ct` + `evidence_envelope_dek_ct` + the chain payload carries `evidenceHash` (the hash of the ciphertext blob). Evidence is OPTIONAL: a closure with no evidence is valid; the chain payload's `evidenceHash` is `null` in that case.

**Rights-protective copy stance.** Per non-negotiable #7. Counter-signing is **verification, not gatekeeping**. The copy must not suggest that a closure cannot proceed without a counter-sign; it must surface the counter-sign as the JHSC's verification moment, separate from the closer's operational closure. If a worker rep wants to close an item but a counter-signer is unavailable, the flow:

1. The rep can flip the item to `Pending Review` via the routine `PATCH /api/action-items/:id`. This is NOT closure; it's the operational signal that the rep believes the work is done.
2. The item stays in `Pending Review` until a counter-signer is available; the UI surfaces "Awaiting JHSC counter-sign" with neutral framing.
3. When the counter-signer is available, the closure-verification route fires and the item flips to `Closed`.

The copy on the closure-verification CTA reads "Verify closure" (not "Close item" or "Approve closure" or "Sign off"). The copy on the `Pending Review` state reads "Pending JHSC verification" (not "Awaiting management approval"). The copy on the `selfAttestation: true` banner reads "You are both the closer and the counter-signer; in a multi-rep setup, this would be a second worker rep. The chain records this as a self-attestation" (no judgment, no friction, no discouragement).

The `Cancelled` status is NOT a closure verification path. A rep cancelling an item (per the 1.6 `Cancelled` status — "Won't be pursued (with reason)") is documenting that the item was decided against, not that it was completed. Cancellations do NOT require counter-sign; the routine `PATCH /api/action-items/:id { status: 'Cancelled' }` is the canonical path. The closure-verification route REJECTS `Cancelled` items (422 `not_closable_via_verification`) and points the rep to the routine PATCH.

### 3.6 In-meeting move history surface

The "move history surfaces in the section navigation" deliverable from ADR-0012's 2.2-absorbs bullet. The rep navigating to a meeting's `old_business` section wants to see, at a glance, "which items moved INTO or OUT OF this section during the meeting." The render lives inside the meeting detail view's section panel.

**Where it renders.** Inside each section panel of `apps/web/src/views/meeting-detail-view.tsx`, below the action-item card-list, a collapsible "Move history this meeting" subsection. When the meeting is `in_progress` or `pending_finalization` the subsection shows live moves; when the meeting is `finalized` the subsection shows the immutable history. The render is a chronological list of moves: `[Action item #N | from-section → to-section | actor | timestamp]`. Each row links to the action item detail.

**Read shape.** The data sources are the existing `action_item_moves` table (filtered by `meeting_id = $1`) joined to `meetings` for date context. The route: `GET /api/meetings/:id/action-items` (per §3.2) returns a `moves` array inside the response envelope alongside the section-grouped items. The route's query: `SELECT m.action_item_id, m.from_section, m.to_section, m.moved_at, m.moved_by_user_id, ai.sequence_number FROM action_item_moves m JOIN action_items ai ON ai.id = m.action_item_id WHERE m.meeting_id = $1 ORDER BY m.moved_at`. No new materialized table; the chain is the source of truth via the existing 1.6 table; the cross-anchor `meeting.action_item_moved` is the chain-side mirror.

**Why not a new materialized table.** Three reasons: (a) `action_item_moves` already carries `meeting_id` since 1.6 (per `apps/api/src/db/schema.ts:513`) — the data exists; (b) the M2.1 pattern for cross-meeting reads is "join through the existing tables, don't denormalize" per the snapshot table's design (per ADR-0012 §3.2 Layer 3); (c) a materialized `meeting_section_moves` table would need to track inserts and deletes to stay consistent with `action_item_moves` (the undo route at `apps/api/src/routes/action-items/index.ts:1053` would have to write to both tables) — needless duplication. The chain-anchored read pattern is the canonical recipe.

**Mobile-primary considerations.** The move history subsection is collapsed-by-default on mobile (390px); a "Show move history (N)" affordance expands it. When expanded, the chronological list uses a vertical timeline pattern with a left-rail of timestamps + a right-column of the move description. Touch targets ≥44pt for the per-row link. The subsection carries `data-print="evidentiary"` per the 1.12 print convention because the move history IS the section's evidentiary record for the meeting (printing the meeting detail view should preserve it).

**Print stylesheet posture.** The move history surface renders in print with the static chronological list + `data-print="evidentiary"` styling per the 1.12 convention (bordered divider + JetBrains Mono for timestamps + actor IDs). The chrome (the collapse affordance, the "Show more" link) carries `data-print="hide"`. The 2.3 PDF generator will read the same data via the same route and render the timeline in the canonical Source Serif 4 layout.

### 3.7 Cross-meeting state visibility

When an action item raised in meeting A is being worked on in meeting B, the rep needs to see:

- **In the section navigation of meeting B:** the item appears in `old_business` (per the 1.6 `current_section` lifecycle); the meeting-context summary on the card shows "Raised in meeting A (2026-Q3)" + the Action Flag from the existing 1.6 computation (the aging indicator that drives the 21-day s.9(21) clock).
- **In the action-item detail view:** the new "Meeting history" timeline section (per the new `GET /api/action-items/:id/meeting-history` route) renders the full per-meeting touch history: which meetings the item appeared in, what status/section transitions occurred per meeting, when the snapshot rows were captured, the closure attestation (if present). The render is a vertical timeline with one block per meeting; each block summarizes the meeting date, the section the item was in at meeting close, the status at meeting close (from the `meeting_action_item_state` finalized snapshot), and the moves that occurred during that meeting.

**The "raised 3 meetings ago" indicator.** The card's meeting-context summary computes:

```ts
previousMeetingTouchCount = COUNT(DISTINCT meeting_id) FROM meeting_action_item_state
                            WHERE action_item_id = $1
                              AND meeting_id != $currentMeetingId
                              AND snapshot_kind = 'finalized'
```

The count is included in the `GET /api/meetings/:id/action-items` response per §3.2. The UI renders:

- `previousMeetingTouchCount = 0`: "First discussed this meeting" badge (blue).
- `previousMeetingTouchCount = 1`: "Discussed in 1 prior meeting" badge (zinc).
- `previousMeetingTouchCount > 1`: "Discussed in N prior meetings" badge (amber if N > 3, zinc otherwise — N > 3 means the item has been carried for >1 year of quarterly meetings, surface as attention-worthy without being alarming).

The badge tap opens the action-item detail with the meeting-history timeline scrolled to the relevant period.

**The first-raised provenance.** `action_items.first_raised_meeting_id` (immutable per ADR-0012 §3.2 Layer 1) is the canonical "where did this item come from" answer. The card shows it as a "Raised in <meeting date>" label (decoupled from the prior-meeting-touch count); the detail view shows it as the timeline's first entry. The label is queryable via the existing `GET /api/action-items/:id` endpoint (which joins to `meetings` for the date context); no new endpoint is needed.

### 3.8 Offline behavior

In-meeting capture often happens with spotty connectivity (the rep is in the meeting room with marginal signal). The M2.2 routes inherit the ADR-0009 §3.5 patterns. The route-level decisions:

| Route                                                         | Sync-queueable | Require-online | Rationale                                                                                                                    |
| ------------------------------------------------------------- | -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/action-items` (with `firstRaisedMeetingId`)        | Yes            | —              | Routine create; offline-queueable per ADR-0009. The cross-anchor `meeting.action_item_added` emits when the queue drains.    |
| `POST /api/action-items/:id/moves` (with `meetingId`)         | Yes            | —              | Routine move; offline-queueable per ADR-0005 + ADR-0009. Cross-anchor emits on drain.                                        |
| `PATCH /api/action-items/:id` (with status change in meeting) | Yes            | —              | Routine status update; offline-queueable. Cross-anchor + live snapshot write emit on drain.                                  |
| `POST /api/action-items/:id/close-verification`               | No             | Yes            | Step-up gated per non-negotiable #16 — step-up requires online passkey assertion. Returns "Network required" banner offline. |
| `GET /api/meetings/:id/metrics`                               | Best-effort    | —              | Best-effort online; cached fallback per §3.4.                                                                                |
| `GET /api/meetings/:id/action-items`                          | Best-effort    | —              | Best-effort online; cached fallback.                                                                                         |
| `GET /api/action-items/:id/meeting-history`                   | Best-effort    | —              | Best-effort online; cached fallback.                                                                                         |

The closure-verification route is the only require-online write per the established M2.1 §3.10 calibration (step-up gates are require-online because the WebAuthn assertion needs server-side challenge verification). The mobile-primary friction: a rep wanting to record a closure verification while offline gets a "Network required" banner with the recovery affordance ("Connect to network → retry"). The closure record is not silently queued because the step-up + the cryptographic attestation cannot be produced offline.

**Optimistic UI for queueable routes.** The web client applies the standard ADR-0009 §3.2 optimistic-UI pattern: the local Dexie row updates immediately; the meeting detail view's card-list and chip-bar reflect the change; the queue drains in the background; conflicts surface in the existing sync conflict UI. The cross-anchor chain rows emit ONLY when the queue drains (the chain is server-side; offline mutations cannot anchor until they reach the server). The chain-anchor timing is server-receipt-time per the established ADR-0009 §3.12 stance.

### 3.9 Web client surfaces

#### Extensions to `apps/web/src/views/meeting-detail-view.tsx`

- **In-section action-item cards.** Each section panel (`old_business`, `new_business`, `recommendation`) renders the relevant action items as a card-list, sourced from the `GET /api/meetings/:id/action-items` response's per-section bucket. The card reuses the existing 1.6 `ActionItemRow` component for the row body (description, action flag, status, risk, type badge, follow-up owner) and adds a meeting-context strip: the "First raised here" / "Discussed in N prior meetings" badge per §3.7. The card list replaces the M2.1 "Open action items" link punt at lines 447-462; the F-L8 deferral closes.
- **Inline status menu.** Each card carries a status dropdown (Radix Select wrapped per the shadcn/ui pattern). Tapping the dropdown opens a list of legal status transitions per the existing 1.6 status enum; selecting a new status fires `PATCH /api/action-items/:id` with the `status` field + `If-Match: <version>` + `meetingId: <currentMeetingId>`; the cross-anchor `meeting.action_item_status_changed` emits server-side; the live snapshot row writes per M2.1; the local optimistic UI reflects the change. The status `Closed` is NOT in the dropdown — closing an item requires the closure-verification flow (per §3.5); the dropdown surfaces the "Verify closure" CTA when the status is `Pending Review`.
- **Swipe-to-move (mobile) / drag-to-move (desktop).** Per the existing 1.6 signature interaction. The swipe action triggers `POST /api/action-items/:id/moves` with the target section + `meetingId: <currentMeetingId>`; the cross-anchor `meeting.action_item_moved` emits. The transition graph from `packages/shared-types/src/action-item-transitions.ts` gates the legal target sections; illegal targets surface a tooltip. The 1.6 step-up gating for `* → archived` is unchanged (the modal opens; the user steps up; the move completes).
- **Live metrics chip-bar.** Above the section accordion, per §3.4. SWR poll on `GET /api/meetings/:id/metrics`; chips render the live counts.
- **Move history subsection.** Per §3.6, inside each section panel below the card-list.
- **Section count chips.** Each section's accordion header (the closed-state collapsed view) carries a count chip: "Old business (12)" / "New business (3)" / "Recommendation (1)". Counts source from `GET /api/meetings/:id/action-items` per-bucket arrays. The chip color follows the existing 1.6 status semantics (zinc for routine; amber for sections with overdue items per the Action Flag computation).

#### Extensions to `apps/web/src/views/action-item-detail-view.tsx`

- **Closure verification flow.** A new sticky bottom CTA appears when `status === 'Pending Review'`: "Verify closure". Tapping opens a full-screen slide-up sheet (mobile) / slide-over (desktop) with: a counter-signer picker (single-option dropdown showing the worker_co_chair user per the M2.1 config), a closure reason textarea (sealed client-side per §3.5), an optional evidence upload (reuses the 1.7 evidence capture flow), a step-up prompt (the existing modal pattern from 1.2), and a confirm CTA "Record verification". On confirm, the route fires; the action item's `status` flips to `Closed`; the detail view re-renders with the closure metadata (closer, counter-signer, date, reason, evidence link). The sheet carries `data-print="hide"`; the closure metadata section renders in print with `data-print="evidentiary"`.
- **Per-meeting history timeline.** A new section in the detail view, below the move history, titled "Meeting history". Renders the response from `GET /api/action-items/:id/meeting-history` as a vertical timeline. Each entry summarizes the meeting (date, section at meeting close, status at meeting close from the finalized snapshot, moves during the meeting). The closure attestation (when present) renders as the timeline's terminal entry with the closer + counter-signer + date + reason snippet (first 80 chars; tap to expand the full reason — requires step-up to decrypt since the reason is envelope-encrypted PI). The timeline carries `data-print="evidentiary"` per the 1.12 convention.
- **`selfAttestation` banner.** When a closure row's `selfAttestation = true`, the detail view's closure metadata section renders a neutral banner: "Self-attestation: closer and counter-signer are the same user. The chain records this distinction." No alarming color; the banner uses the established 1.6 informational-blue semantics.

#### New components

- **`apps/web/src/meetings/live-metrics-chip-bar.tsx`** — the §3.4 chip-bar. Standalone component consumed by `meeting-detail-view.tsx`; SWR-driven; respects `prefers-reduced-motion` per the 1.12 WCAG audit.
- **`apps/web/src/meetings/section-action-item-list.tsx`** — the per-section card-list with inline status menu + swipe-to-move + closure CTA. Reuses 1.6 `ActionItemRow`.
- **`apps/web/src/meetings/meeting-move-history.tsx`** — the §3.6 collapsible move-history subsection.
- **`apps/web/src/action-items/closure-verification-sheet.tsx`** — the §3.5 slide-up sheet for the closure flow.
- **`apps/web/src/action-items/meeting-history-timeline.tsx`** — the §3.7 cross-meeting history timeline.

### 3.10 Audit + step-up integration

**Step-up gating** per non-negotiable #16:

| Route                                                         | Step-up required?        | Action                                                 | Rationale                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/action-items` (with `firstRaisedMeetingId`)        | No                       | —                                                      | Routine create per 1.6. Cross-anchor emits server-side.                                                                                                                                                                            |
| `POST /api/action-items/:id/moves` (with `meetingId`)         | Per 1.6 transition graph | `action_item.move.<to>` for `* → archived` and reopens | Existing 1.6 calibration; M2.2 inherits.                                                                                                                                                                                           |
| `PATCH /api/action-items/:id` (with status change in meeting) | No                       | —                                                      | Routine status update; high-friction step-up every time would break the mobile-primary in-meeting flow.                                                                                                                            |
| `POST /api/action-items/:id/close-verification`               | **Yes**                  | `action_item.close_verification`                       | Per non-negotiable #16 — verification is the evidentiary moment; step-up gates the WebAuthn assertion that binds the counter-signer's identity.                                                                                    |
| `GET /api/meetings/:id/metrics`                               | No                       | —                                                      | Read-only; no PI; selective read-anchoring posture.                                                                                                                                                                                |
| `GET /api/meetings/:id/action-items`                          | No                       | —                                                      | Read-only; the safeSummary decrypt is the existing 1.6 pattern.                                                                                                                                                                    |
| `GET /api/action-items/:id/meeting-history`                   | No                       | —                                                      | Read-only; the closure reason plaintext is NOT in the response (only the closure metadata); decrypting the reason requires a separate detail-view route with its own step-up gate per the established 1.7 evidence-reveal pattern. |

**Step-up freshness window.** 60s per the M2.1 / 1.7 precedent. The closure-verification flow re-prompts if the step-up grant expires between sheet-open and submit; the recovery path is the established 401-StepUp modal handshake per 1.2.

**Idempotency.** Every POST route is wrapped by the existing `idempotencyKeyGuard` middleware. The `clientId` body field is accepted on `POST /api/action-items/:id/close-verification` for the offline-retry path (though the route itself is require-online per §3.8 — the clientId is the dedup primitive for retry-after-timeout).

**If-Match required.** The closure-verification route reads `If-Match: <version>` on the action item per ADR-0009 §3.7 and fails 428 if absent + 409 on mismatch (the canonical pattern). The cross-anchor wrap routes (`POST /api/action-items`, `POST /api/action-items/:id/moves`, `PATCH /api/action-items/:id`) keep their existing If-Match behavior unchanged.

**Audit emission discipline.** Cross-anchors are emitted inside the same transaction as the primary mutation per the ADR-0002 atomic-emit invariant. The `action_item.closure_verified` anchor and the optional `meeting.action_item_status_changed` cross-anchor (when the closure happens inside an active meeting) emit in the same transaction; the closure row's `audit_idx` points at the `action_item.closure_verified` row; the `meeting.action_item_status_changed` cross-anchor carries the `action_item.closure_verified` row's hash (per the TM-fold-3 cross-anchor pattern) so the verifier walks both kinds and the meeting → closure linkage is chain-traceable.

### 3.11 Negative tradeoffs

- **Pulling action items into the meeting detail view increases DB load on the detail-read path.** The M2.1 detail-read fetched 5 tables (meeting, sections, attendance, inspection-review, signatures); the M2.2 detail-read adds `action_items` (filtered + decrypted), `action_item_moves` (filtered by meeting), `meeting_action_item_state` (filtered by meeting for the snapshot context), and `action_item_closures` (filtered by meeting for the closed-this-meeting bucket). Single-tenant scale absorbs this (a meeting touches ~50 items max; the joins are cheap). The new `GET /api/meetings/:id/action-items` endpoint is the dedicated path so the detail-read itself stays scoped to meeting metadata; the action-item composition is a separate request that loads in parallel from the client. Documented.
- **Live metrics recompute on every read is wasteful at scale.** The `GET /api/meetings/:id/metrics` endpoint runs ~6 aggregate queries per call; SWR's 5s poll over a 90-min meeting fires ~1100 reads. Each call is cheap (<50ms at single-tenant scale per the M2.1 §3.4 latency budget); total CPU is bounded. At multi-tenant scale this would warrant a Redis cache or a denormalized snapshot table; at single-tenant scale the canonical posture is "the chain is the source of truth; compute from chain-anchored data; don't cache to avoid drift" (per ADR-0012 §3.8's same stance). Documented as accepted residual; the forward seam if/when multi-tenant lands.
- **A separate `action_item_closures` table adds a join vs. denormalizing on `action_items`.** Per §3.1 — the join is one row per closed item; the existing detail-read joins to `action_item_moves` already; the cost is negligible. The append-only invariant + per-row chain anchor + workplace-key signature defense outweighs the join cost. Documented.
- **The `selfAttestation: true` path is operationally permissive.** Until 2.5 introduces a second in-app worker rep, every closure is a self-attestation; the chain payload's `selfAttestation: true` flag is informational but not preventive. A rep who routinely self-attests cannot demonstrate "this item was verified by an independent JHSC counter-signer" until the 2.5 second-rep onboarding ships. The forward seam is real; the rights-protective copy makes the limitation honest; documented.
- **The cross-anchor pattern grows chain row counts non-linearly with operational frequency.** A quarterly meeting with 50 status changes + 30 moves + 10 adds emits 90 cross-anchor rows in addition to the 90 per-item anchors. The 1:1 ratio is intentional (every in-meeting operation gets both the per-item anchor and the meeting-context anchor for verifier composability) but it doubles the chain row count for in-meeting activity. At single-tenant scale (~400 added rows/year) this is negligible. At multi-tenant scale a future "anchor batching" pattern could collapse cross-anchors; documented as a forward seam.
- **The closure-verification route cannot run offline.** Per §3.8 — step-up requires a fresh WebAuthn assertion; the cryptographic attestation requires the workplace signing key. A rep in a no-signal zone cannot record a closure verification; they must wait until signal returns. The UX recovery is the "Network required" banner; the operational impact is bounded (closures are not time-critical; the rep can flip to `Pending Review` offline and verify on reconnect). Documented.

### 3.12 Risks + mitigations

- **A bug in the closure-verification route could let `Cancelled` items hit the closure flow.** Mitigation: the route's pre-INSERT status check rejects `Cancelled` with 422 `not_closable_via_verification`; the UI's "Verify closure" CTA does not render for `Cancelled` items; an integration test asserts the rejection.
- **A bug in the cross-anchor emit could leave the meeting → action-item linkage chain-unanchored.** Mitigation: the chain-anchor + primary-mutation transaction discipline per ADR-0002 — both anchors are in the same `db.transaction`; a failure rolls both back. Integration tests assert that every `meeting.action_item_added` / `meeting.action_item_moved` / `meeting.action_item_status_changed` row has a paired per-item anchor with the matching hash. The `audit-log-verify --check-meetings` extension from M2.1 gains an `--check-action-item-cross-anchors` flag (or extends the existing flag) to cross-verify the pairings.
- **A bug in the live snapshot write could under-count items in the metrics dashboard.** Mitigation: the metrics endpoint reads from the canonical tables (`action_items`, `action_item_closures`, `recommendations`, `meeting_inspection_review`), NOT from the snapshot rows; the snapshot table is for the immutable per-meeting record, not for live metrics. The metrics endpoint's query joins through the canonical tables; a snapshot bug would not affect metric accuracy. The snapshot-vs-live divergence is the M2.1-documented residual; M2.2 inherits the same posture.
- **A bug in the closer-vs-counter-signer CHECK could allow self-attestation without the `selfAttestation: true` flag.** Mitigation: the DB CHECK constraint (`closed_by_actor_id != counter_signer_actor_id OR self_attestation = true`) is the structural backstop; the route's Zod validation is the type-layer defense; an integration test asserts the CHECK rejects (false-flagged) self-attestations.
- **A bug in the SWR poll could hammer the metrics endpoint at sub-second intervals.** Mitigation: SWR's `refreshInterval` is a fixed config; the suspense-on-hidden-document logic is standard; an e2e test asserts the poll fires at 5s intervals + zero polls when the document is hidden + zero polls when the meeting status is not `in_progress`.
- **A bug in the cross-anchor hash could let the verifier accept a tampered linkage.** Mitigation: the cross-anchor's `actionItemUpdatedHash` is computed via the existing M2.1 `computeChainEntryHash` helper at `apps/api/src/routes/meetings/index.ts:2179` — pure function, unit-tested per the M2.1 fixture-driven test suite. M2.2 extends the fixture to cover the four new cross-anchor kinds.
- **A bug in the closure attestation Ed25519 signature could let a forged closure row pass verification.** Mitigation: the workplace signing-key signature pattern is the established TM-fold-4 defense from M2.1 (`meeting_signatures.attestation_signed_ct`); the `attestationSignedCt` column on `action_item_closures` follows the same shape; the verifier's signature-check walks every closure row + every signature row + every cross-anchored hash. Integration tests cover the signature round-trip.

## Compliance check

- **#1 no names in source.** The closer + counter-signer display names are decrypted client-side from the M2.1 `meeting_attendance.display_name_ct` cache; the workplace signing-key id is from `config/workplace.ts` (env-driven per M2.1). The closure reason is envelope-encrypted; the DB never sees plaintext. The chain payloads carry IDs + hashes; never names.
- **#2 chain-of-custody.** Four new audit kinds. Every closure verification emits a chain anchor; every in-meeting create/move/status-change emits a cross-anchor that composes with the per-item anchor. The `action_item.closure_verified` payload carries the workplace-key-signed attestation hash for defense-in-depth.
- **#4 privacy-by-default.** Closure reasons are envelope-encrypted. Evidence (when present) follows the 1.7 Tigris client-side-encrypt pattern. The metrics endpoint surfaces aggregates only; no PI in the metrics response.
- **#5 legal citations.** The quorum citation in the metrics endpoint reads from `packages/legal-corpus` via the M2.1 `computeQuorum` helper. No generated citations outside the corpus.
- **#6 no employer infrastructure.** The counter-signer is the in-app worker co-chair per the M2.1 config; no employer SSO; no employer signature requirement at the action-item layer.
- **#7 rights-protective UI.** The closure verification copy is neutral ("Verify closure" / "Pending JHSC verification" / "Awaiting JHSC counter-sign"). The `selfAttestation: true` banner is informational not judgmental. The `Pending Review` state does not gate any operational work; the rep can keep working on items in any status; the counter-sign is verification, not gatekeeping. Per §3.5.
- **#8 no automated regulator submission.** M2.2 surfaces produce closure records; no automated submission anywhere.
- **#9 mobile-primary.** The live metrics chip-bar is 390px-first per §3.4. The in-section card-list reuses the existing 1.6 `ActionItemRow` mobile patterns. The closure-verification sheet is full-screen on mobile, slide-over on desktop. Touch targets ≥44pt.
- **#10 restrained legal-grade aesthetic.** No new iconography beyond Lucide. The chip-bar uses neutral slate/zinc + amber for attention. The status color semantics are unchanged from 1.6.
- **#12 action items are first-class.** The closure-verification table is parallel to `meeting_signatures` — action items have their own attestation lifecycle; meetings reference but do not own. The cross-anchors compose chains; they do not subordinate one chain to the other. The `selfAttestation: true` flag preserves the rep's ability to close items even at single-rep scale; the chain records the distinction honestly. Non-negotiable #12 is preserved.
- **#13 inspections preserve template version at conduct time.** No change to inspections; M2.2 does not touch the inspection lifecycle.
- **#14 zone IDs stable.** No change.
- **#15 inspection findings manually promoted.** No change; the promotion flow is unchanged. Items promoted from inspections inherit the M2.2 closure-verification path like any other action item.
- **#16 exports step-up + audit log + document hash.** The closure verification IS an evidentiary export-equivalent operation; step-up gates it; the chain anchor + the workplace-key signature is the evidentiary trail. The 2.3 PDF generator (next milestone) will inherit the discipline for the rendered closure record.

## Follow-ups

- [ ] **Threat-modeler:** append `SECURITY.md` §2.14 "In-Meeting Action Item Management" with T-IM1..T-IMn threats + mitigations. Coverage to include: closer-vs-counter-signer CHECK bypass via direct DB write, closure-verification step-up replay, cross-anchor hash collision allowing a forged meeting → action-item linkage, `selfAttestation: true` weaponization in the multi-rep forward seam, metrics endpoint DoS via SWR-poll abuse, in-meeting status PATCH bypass of the `Pending Review → Closed` route via direct status PATCH, closure reason envelope plaintext leak via API response, evidence-blob orphan ciphertext (forward seam from 1.7 GC deferral), the cross-meeting visibility's `previousMeetingTouchCount` chain-payload-PI risk (none expected since the count is an integer), the workplace signing-key reuse pattern (the same key signs M2.1 meeting signatures + M2.2 closures; rotation cadence interaction), the `Cancelled` status path's "no counter-sign required" interaction with closure-verification, the action-item move history's actor-ID leak in cross-meeting display, and the offline-queue interaction with the closure-verification require-online posture (a rep who flips to `Pending Review` offline + reconnects must not have a stale snapshot blocking the verification). The modeler will reserve T-IM\* identifiers; this ADR cross-references the placeholders by name.
- [ ] **S1:** Migration `0012_in_meeting_action_items.sql` (the `action_item_closures` table + the CHECK constraints + the UNIQUE on `(action_item_id)`); Drizzle schema additions to `apps/api/src/db/schema.ts`; `packages/shared-types` additions (four new `AuditEventKind` values + per-kind `AuditPayload` shapes); Zod schemas for the new route bodies; tests for the schema-version migration roundtrip + the CHECK enforcement.
- [ ] **S2:** The four new routes (`POST /api/action-items/:id/close-verification`, `GET /api/meetings/:id/metrics`, `GET /api/meetings/:id/action-items`, `GET /api/action-items/:id/meeting-history`) + the four extensions (cross-anchor emission on `POST /api/action-items`, `POST /api/action-items/:id/moves`, `PATCH /api/action-items/:id`; the metrics-dict extension on `POST /api/meetings/:id/adjourn`); the action-item-closures crypto helper in `apps/api/src/action-items/closure-crypto.ts` (parallel to the M2.1 `meeting-crypto.ts`); integration tests for the full closure-verification lifecycle, the cross-anchor pairing invariant, the metrics endpoint accuracy, and the offline-queue interaction; `audit-log-verify --check-action-item-cross-anchors` extension.
- [ ] **S3:** Web client — the five new components per §3.9; extensions to `meeting-detail-view.tsx` (section card-lists + chip-bar + move history); extensions to `action-item-detail-view.tsx` (closure flow + meeting history timeline); Dexie schema extensions for the `action_item_closures` cache + the metrics cache; sync-queue plumbing for the queueable routes; the closure-verification require-online banner; print stylesheet for the new surfaces per the 1.12 `data-print` convention.
- [ ] **S4:** No new seed data this milestone (the closure-verification flow doesn't introduce templates or corpus entries). S4 budget folds into S5.
- [ ] **S5:** Independent reviewers (security, privacy + UX, action-item linkage, closure-workflow) + fix bundle. Runbook `docs/runbooks/in-meeting-action-items.md` covering: the closure-verification lifecycle, the self-attestation forward-seam, the live metrics dashboard's refresh/cache posture, the move history surface, the cross-meeting visibility patterns, the offline behavior calibration, the closer-vs-counter-signer CHECK semantics, and the operator-side verification of the chain extension.
- [ ] **2.3 (Minutes Document Generation) absorbs:** The PDF rendering of the closure-verification attestation (the closure metadata + the workplace-key signature verification stamp + the optional evidence link); the rendered cross-anchor history per meeting (the move + status timeline rendered in Source Serif 4); the live metrics dashboard's post-adjournment static rendering (already handled by M2.1's `meeting.adjourned` payload). Same step-up + audit + document-hash discipline per non-negotiable #16.
- [ ] **2.4 (Excel Re-Import Update Mode) absorbs:** The reconciliation behavior when an Excel import contains a closure attestation for an item already closed in-app (the import's closure metadata vs. the in-app closure attestation — likely the in-app version wins as the canonical record; the import surfaces a conflict for rep review).
- [ ] **2.5 (Work Refusals) and beyond:** The second worker rep onboarding that closes the `selfAttestation` forward-seam — when a second in-app `worker_rep` lands, the closure-verification flow's counter-signer picker shows the alternative actor; `selfAttestation: true` becomes the emergency path documented in the runbook rather than the routine path.
- [ ] **Release 3 absorbs:** AI-assisted closure-reason drafting (Adversarial Lens applied to the closure attestation — "how will this closure rationale read in arbitration?"); push notifications for items pending JHSC verification (Web Push placeholders from 1.10); analytics over closure velocity + section move frequency (per Release 3 §3.7 — "Section velocity (how fast items move from new → old → closed)" reads from M2.2's chain extension).
- [ ] **`packages/legal-corpus`:** No new corpus entries required for M2.2. The closure-verification surface does not generate citations; the quorum citation in the live metrics endpoint reads the existing M2.1-seeded entries.
- [ ] **`.context/decisions.md`** entry referencing this ADR.

## Open questions for user

1. **Counter-signer role expansion.** §3.5 settles on `worker_co_chair` as the sole counter-signer role. Should the M2.2 closure-verification flow also accept a `worker_rep` counter-signer (per the OHSA s.9 multi-worker-rep convention) once 2.5 introduces a second in-app worker rep, or should the counter-sign remain co-chair-only? The ADR leaves the M2.2 implementation co-chair-only with the forward-seam expansion deferred to 2.5; user to confirm or override.
2. **`selfAttestation` UI friction.** §3.5 surfaces the `selfAttestation: true` path with a neutral banner and no additional friction. Should there be additional ceremony (e.g., a confirm-checkbox "I acknowledge I am both closer and counter-signer") to make the distinction operationally visible? The ADR's default is minimal-friction-with-honest-banner; user to confirm or escalate.
3. **Cross-anchor scope on cancellations.** §3.5 treats `Cancelled` as a routine `PATCH /api/action-items/:id` without closure verification. Should `Cancelled`-while-in-meeting still emit a `meeting.action_item_status_changed` cross-anchor (which the §3.3 design already does, since the status change happens via the same PATCH)? The ADR's default is "yes, same cross-anchor as any status change"; user to confirm.
4. **Metrics endpoint cache TTL.** §3.4 specifies SWR poll at 5s with no server-side cache. Should the route gain a 1-2s in-memory cache to absorb a multi-tab refresh storm (the rep on a phone + tablet during a meeting)? The ADR's default is "no cache; trust the DB at single-tenant scale"; user to confirm or escalate if multi-tab is an expected pattern.
5. **Move-history retention scope.** §3.6 reads `action_item_moves WHERE meeting_id = $1`. Should the section panel also surface PAST-meeting moves (the item's lifecycle across all prior meetings) inline, or strictly the current-meeting moves with the cross-meeting view reserved for the action-item detail view? The ADR's default is "current-meeting only in the section panel; cross-meeting in the detail view"; user to confirm.

## S0 addendum — user decisions + threat-modeler folds

Appended at S0 close after the user resolved the 5 open questions and the threat-modeler (§2.14, 44 T-IM threats) surfaced 5 architectural folds for S1.

### User decisions (locked)

- **Q1 Counter-signer role.** M2.2 ships co-chair-only counter-sign. The `worker_rep` expansion is the explicit 2.5 forward seam — when a second in-app worker rep onboards, the counter-signer picker shows the alternative actor; `selfAttestation: true` shifts from the routine path to the documented emergency path. The S2 route validates `counterSignerActorId` resolves to a role in the env-driven `minutesSignerRoles` list with `worker_co_chair` as the sole accepted value for 2.x.
- **Q2 `selfAttestation` friction.** Minimal banner, no confirm-checkbox. The banner reads (per §3.5's rights-protective stance): "You are both the closer and the counter-signer because no other in-app worker co-chair is available. This is recorded in the chain so a future reviewer can see the single-rep constraint." No additional ceremony — adding "I acknowledge..." framing edges toward shame language.
- **Q3 Cancelled cross-anchor.** Cancelled-in-meeting emits `meeting.action_item_status_changed` uniformly with other status transitions. The chain has symmetric coverage of the meeting's state machine; audit-verify rules stay simple.
- **Q4 Metrics cache.** No server-side cache. Single-tenant + ~12 meetings/year + 5s SWR poll = trivial load. The route reads from DB on every request. Revisit only if a multi-tab pattern emerges in real use.
- **Q5 Move history scope.** Current-meeting moves render in the section nav; cross-meeting history lives in the action-item detail view (one tap away via the existing 1.6 navigation). The §3.6 query `WHERE meeting_id = $1` stays; the detail view's history query is `WHERE action_item_id = $1` per non-negotiable #12's first-class lifecycle framing.

### Threat-modeler architectural folds (S1 owns implementation)

The §2.14 threat-modeler surfaced 5 folds that need to land in S1 to satisfy the threat coverage. All compatible with the §3.x design; some are column additions, some are transaction-isolation upgrades, some are response-header discipline:

1. **TM-fold-1 (T-IM3, T-IM4, T-IM32) — `action_items.closure_verification_id FK` + CHECK constraint.** S1 adds `action_items.closure_verification_id UUID NULLABLE REFERENCES action_item_closures(id) ON DELETE RESTRICT` plus a CHECK: `status = 'Closed' IFF closure_verification_id IS NOT NULL`. This makes the "closing without counter-sign" bypass (T-IM3) structurally impossible at the DB layer, prevents re-opening (T-IM4) from orphaning closure rows, and catches duplicate closure-verification (T-IM32) via the FK uniqueness.
2. **TM-fold-2 (T-IM7, T-IM11) — `meeting_action_item_state` snapshot dedupe.** S1 adds a partial UNIQUE index on `meeting_action_item_state (meeting_id, action_item_id, snapshot_kind, snapshot_status, snapshot_section) WHERE snapshot_kind = 'live'`. A stuck-retry idempotent PATCH that lands the same status+section combination won't spam new snapshot rows; only semantically-distinct changes accumulate. The M2.1 partial-UNIQUE on `(meeting_id, action_item_id) WHERE snapshot_kind='finalized'` stays as-is.
3. **TM-fold-3 (T-IM17, T-IM18) — metrics endpoint Zod + `Cache-Control: no-store`.** S1's metrics route handler sets `Cache-Control: no-store, no-cache` + `Pragma: no-cache` + `Vary: Cookie` headers + a Zod-validated query schema with `enum` for the only legal parameter (`meeting_id`). Defends against the recompute-DoS shape (rate-limited at the route handler per the existing 1.5 rate-limit middleware) + prevents intermediate-cache leak across meetings.
4. **TM-fold-4 (T-IM30, T-IM36) — SERIALIZABLE adjournment transaction.** S1's `POST /api/meetings/:id/adjourn` upgrades from the default READ COMMITTED to `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` for the metrics-compute + finalized-snapshot-write + chain-emit sequence. Closes the transactional gap where a malicious in-flight `live` snapshot insert between metrics compute and chain emit could falsify the `meeting.adjourned` payload. M2.1's S2 adjourn route stays READ COMMITTED for its non-snapshot work; the SERIALIZABLE wrap is scoped to the snapshot section.
5. **TM-fold-5 (T-IM33) — `action_item_closures.signing_key_id` + `meeting.finalized` payload extension.** S1 adds `action_item_closures.signing_key_id UUID NOT NULL REFERENCES workplace_signing_keys(id)` mirroring `meeting_signatures.signing_key_id` from M2.1 F-L2. The closure-verification chain anchor's payload carries the signing_key_id so a verifier can cross-reference key rotations. Additionally, the existing `meeting.finalized` payload (M2.1) is extended in S1 with `closureVerificationCount: number` so the audit-verify --check-meetings gate can cross-reference the count of closure-verified items against the count of in-meeting `Closed` transitions on the chain. Both extensions land via shared-types audit-payload bumps; no migration to meeting_signatures.

### Slice handoff

S1 begins from this ADR + SECURITY §2.14. The S1 brief MUST reference these 5 TM-folds explicitly so implementation doesn't drift. S5 reviewers verify each fold landed (security reviewer reads the action_item_closures table + chain-anchor payloads; linkage reviewer reads the closure_verification_id FK CHECK).

## Post-M2.2 backlog (S5 fix-bundle deferrals)

The three S5 reviewers (security, privacy/UX, linkage) surfaced 1
CRITICAL + 8 HIGH + 10 MEDIUM defects, all closed in the S5 fix
bundle. A short tail of 5 LOW findings is deferred to a dedicated
follow-up milestone — the items are real but the impact is bounded
and the fixes are heavier than an S5 bundle warrants (workflow
extensions, new server endpoints with their own threat surfaces,
or substantive design-system additions).

1. **F-S7 — step-up freshness `action` claim is decorative.** The
   `checkStepUpFreshness` helper accepts a step-up grant for ANY
   action within the 60s window; the SECURITY §2.14 T-IM2 / T-IM41
   mitigation language promises per-action and per-resource binding
   that the substrate doesn't enforce. The fix is a step-up grant
   tuple `(action, until, resourceId?)` + tightened freshness check;
   this is a workspace-wide auth refactor, not an action-item-
   scoped change. Track as the dedicated step-up hardening
   milestone alongside the per-resource `clientDataJSON` binding
   (T-IM41 deepening fold).

2. **F-S8 — reopen route emits no `meeting.*` cross-anchor.** An
   in-meeting reopen lands only the per-item `action_item.reopened`
   event; the meeting's chain envelope has no parallel event even
   when the reopen happens during an `in_progress` meeting (a
   plausible workflow: a closure verified earlier is reconsidered
   later in the same meeting). The fix mirrors the PATCH + close-
   verification cross-anchor pattern: emit `meeting.action_item_
status_changed { fromStatus: 'Closed', toStatus: 'In Progress'
}` when the reopen's meeting_id points at an `in_progress`
   meeting. Defer to the post-M2.2 reopen-completion pass.

3. **F-S9 — counter-signer role gate is a string equality.** The
   close-verification route gates on `counterSignerActorId ===
auth.userId` per single-tenant scope; the documented
   `worker_co_chair` role check is collapsed because the rep is
   the sole in-app worker_co_chair until 2.5 introduces a second
   in-app worker rep. The fix is the 2.5 second-worker-rep
   onboarding — replace the equality with a JOIN against the
   user_roles table filtered by `role IN minutesSignerRoles`.
   Surface in the M2.2 runbook so the 2.5 implementer doesn't
   drift; no work needed at single-rep scope.

4. **F-S6 — `previousClosureId` chain semantics under repeat
   reopen + re-close cycles.** With the S5 CRITICAL fix (F-L1)
   landing the partial UNIQUE on (action_item_id) WHERE
   superseded_at IS NULL, the chain CAN now anchor multiple
   `closure_verified` events per item interleaved with
   `reopened` events. Gate 2 (`reopened_no_prior_closure`) only
   checks that SOME prior closure exists; it doesn't validate
   that `previousClosureId` matches the MOST-RECENT prior
   closure. A tampered chain could pair a reopen with an
   earlier-still-superseded closure. The fix tightens Gate 2 to
   resolve `previousClosureId` against the most-recent closure
   upstream; modest verifier work but requires a payload-shape
   migration. Defer to the chain-verifier hardening pass.

5. **F-L7 — `action_item_closures.audit_idx` FK was not added.**
   The ADR §3.1 column list specifies `audit_idx bigint not null
references audit_log(idx)` + a `action_item_closures_audit_idx_
unique` index for the per-entity audit-anchor invariant carried
   forward from ADR-0007 §3.6. The verifier walks the chain (not
   the table) so the operational impact is limited to out-of-band
   admin discoverability ("show me the chain event for closure
   X"). The fix is a new migration + closure-route update to
   populate the column from `closureChainRow.idx`. Defer to the
   chain-row-back-pointer pass.

Once these five items have a target milestone, they should be
lifted out of this Post-M2.2 backlog into the relevant ROADMAP
entries with the appropriate cross-references.
