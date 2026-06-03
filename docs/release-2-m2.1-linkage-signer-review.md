# M2.1 Linkage + Signer Review

Reviewer: independent S5 (linkage + signer)
Reviewed commits: b535424, 251ae69, 9afe0b6, 5645f97, 942e0b6, 8f4e718, 5355f26
Branch: `claude/m2.1-meeting-lifecycle`
Scope: §A action item linkage, §B 4-signer workflow, §C cross-chain anchor,
§D workplace_singleton, §E failure modes

## Findings

### CRITICAL

(none)

### HIGH

- **F-L1: Off-app signature route accepts a stub `pending:<uuid>` storage
  key, allowing a signature row to exist with NO Tigris-backed evidence
  blob.**
  - Where: `apps/web/src/views/meeting-finalization-view.tsx:618`
    (`const key = storageKey.trim() || `pending:${cryptoRandomKey()}`);
`apps/api/src/routes/meetings/index.ts:188`accepts any non-empty
string ≤512 chars for`evidenceStorageKey`.
  - What: ADR-0012 §3.9 promises off-app signature evidence bytes live
    in Tigris; the row carries the storage key + ciphertext SHA-256.
    The S3 client lets the rep skip the storage key entirely and
    synthesises a `pending:<uuid>` placeholder so the route's pre-check
    passes. The server stores the placeholder verbatim. The CHECK on
    `meeting_signatures.evidence_envelope_ct NOT NULL` is satisfied
    because the encrypted "evidence body" textarea is required, but
    the actual scan/email artefact may never have been uploaded.
  - Why: T-ML5 (paper-attestation forgery) and T-ML23 (evidence hash
    collision) both assume the storage-key referenced object exists in
    Tigris with `Content-MD5` enforcement. A `pending:<uuid>` key
    bypasses both. ADR §3.9 contract is broken; the recipient
    verifying the signature has no Tigris artefact to compare against.
  - Fix: (a) Route-level Zod regex rejecting keys starting with
    `pending:`; (b) the client must require a real key returned by
    the 1.7 evidence-upload flow; (c) until 1.7's upload surface is
    wired into this view, surface a 422 with "Upload evidence via
    Evidence module first" rather than synthesising a sentinel.

- **F-L2: `signing_key_id` is pinned on each row, but rotation between
  meeting create and finalize lets the same meeting carry signatures
  produced under DIFFERENT keys with no cross-signature consistency
  check.**
  - Where: `apps/api/src/routes/meetings/index.ts:1754-1782` (the
    signing key is re-pulled per signature; no check against prior
    signatures' `signing_key_id`).
  - What: The route calls `getActiveWorkplaceSigningPublicKey(db)` for
    EACH signature, embedding whichever key is currently active. If
    the workplace rotates keys between signature 2 and 3, the meeting
    has two attestations under key A and two under key B. The
    `meeting.finalized` chain anchor records signature IDs but does
    NOT bind the active signing_key_id at finalization, so a verifier
    walking the row has no single key-of-record for the meeting.
  - Why: This is the §E rotation residual flagged in the brief
    surfacing as an actual seam. Per-row `signing_key_id` allows
    verification but the multi-key meeting raises the arbitration bar
    (the verifier must independently check each signature). Acceptable
    if documented; currently undocumented in the route.
  - Fix: At minimum, the `meeting.finalized` payload should include
    `signingKeyIds: string[]` so the chain proves which keys were in
    play. Stronger: the finalize route rejects with 422 if rows span
    multiple `signing_key_id` values.

### MEDIUM

- **F-L3: Signatures can be recorded while meeting is `in_progress`,
  not just post-adjournment.**
  - Where: `apps/api/src/routes/meetings/index.ts:1792-1800` (the
    method-shape check allows `in_progress`, `adjourned`,
    `pending_finalization`).
  - What: ADR-0012 §3.9 specifies signatures land in
    `pending_finalization` after `adjourn`. The implementation permits
    in_progress signing. A rep could pre-sign an unfinished meeting;
    the structural ordering (T-ML7 mitigation) records the moment but
    the meeting content is still mutable, so the attestation row's
    `evidenceHash` binds nothing about the section notes / attendance
    that may still change. The Ed25519 attestation does NOT sign over
    the meeting content hash — only the row's own fields — so this is
    a UX/correctness gap, not a structural break.
  - Why: T-ML7 documents this as "ordering is meaningful evidence",
    but the ADR contract says post-adjournment. Either tighten the
    code to match the ADR OR update the ADR to allow in-progress
    signing and document the implication for the recipient.
  - Fix: Either reject `in_progress` (ADR-aligned) or document that
    in_progress signatures are valid in the runbook.

- **F-L4: The `meeting.recommendation_drafted` cross-chain anchor
  binds the `recommendation.drafted` event's `thisHash`, but the
  recommendation INSERT happens AFTER both audit appends inside the
  same transaction.**
  - Where: `apps/api/src/routes/recommendations/index.ts:473-540`. The
    `recommendation.drafted` chain row is appended first (line 473),
    then the `recommendations` row is INSERTed (line 485), then the
    cross-chain anchor `meeting.recommendation_drafted` is appended
    (line 528).
  - What: If the INSERT into `recommendations` fails after the
    `recommendation.drafted` anchor was already written, the
    transaction rolls back and both chain rows disappear together
    (good — atomic). HOWEVER: the recommendation row's `audit_idx` FK
    points at the `recommendation.drafted` row's idx, NOT the
    `meeting.recommendation_drafted` row. A verifier walking forward
    from `meeting.recommendation_drafted.recommendationId` and
    expecting to find the recommendation row's audit_idx pointing back
    at it will be surprised. The current shape is correct per ADR
    (Gate 3 verifies the prior-chain hash); just unobvious.
  - Why: TM-fold-3 / T-ML42 — the cross-chain anchor mechanism works,
    but the verifier's mental model (`row.audit_idx → the latest
anchor`) does not hold for in-meeting drafted recs. Document.
  - Fix: Add a comment in the recommendations route + the verifier's
    Gate 3 explanation noting the asymmetry. No code change.

- **F-L5: `meeting.inspection_reviewed` audit kind specified in
  ADR-0012 §3.10 is NOT implemented; inspection-review writes either
  emit no anchor (when no notes) or emit `meeting.section.notes_appended`
  with `resourceType: 'meeting_inspection_review'`.**
  - Where: `apps/api/src/routes/meetings/index.ts:1446-1464`.
  - What: ADR §3.10 lists `meeting.inspection_reviewed` as one of the
    11 named kinds. The route comment says "the brief calls it
    documentary" and reuses `meeting.section.notes_appended` with a
    different resource_type. The SECURITY §2.13 threat-modeler also
    lists the kind. The chain currently does not carry the inspection
    outcome (`accepted_as_complete` / `findings_promoted` / `deferred`)
    — that semantic is in the DB row only.
  - Why: T-ML42-class verifier loses the chain-side inspection-review
    semantics. A row INSERT followed by no anchor (when notes absent)
    means an inspection-review can happen with zero chain trace beyond
    the DB row's existence. Non-negotiable #2 (chain-of-custody on
    every sensitive data path) is dented.
  - Fix: Add `meeting.inspection_reviewed` kind to shared-types and
    emit on every inspection-review INSERT with
    `{meetingId, reviewId, inspectionId, outcome, notesHash?}`.

### LOW

- **F-L6: Same-day meeting duplicate-detection (ADR §3.4 step 5) is
  not implemented.**
  - Where: `apps/api/src/routes/meetings/index.ts` (POST handler — no
    duplicate-date check).
  - What: ADR §3.4 calls for a soft warning when a meeting already
    exists on `meeting_date`. The route accepts the create without
    checking. Two meetings on the same date are legal per ADR. §D
    concern — low impact.
  - Fix: Add a pre-insert query + return a `same_day_exists` warning
    payload. Or document the omission as accepted.

- **F-L7: The `attendance.updated` event re-uses kind
  `meeting.attendance.recorded` for both POST and PATCH.**
  - Where: `apps/api/src/routes/meetings/index.ts:1367` (PATCH
    handler emits `meeting.attendance.recorded`).
  - What: ADR §3.10 specified `meeting.attendance.updated` distinct
    from `meeting.attendance.recorded`. The shared-types union only
    contains `meeting.attendance.recorded`. Verifier-side
    distinguishability is lost (the verifier sees a stream of
    `attendance.recorded` events with the same nameHash for what is
    actually a presence toggle). Low impact at single-tenant scale.
  - Fix: Add `meeting.attendance.updated` kind OR add a `transition`
    field to the existing payload (`{from: presence, to: presence}`).

- **F-L8: The meeting detail view links to action-items rather than
  embedding a live count.**
  - Where: `apps/web/src/views/meeting-detail-view.tsx:448-462`.
  - What: Consistent with non-negotiable #12 (meetings reference, do
    not own). However the rep cannot see at a glance "how many action
    items are live in this meeting" without navigating away. No copy
    or count is shown — just a "Open action items" button. The card
    text correctly frames the boundary ("they are not owned by this
    meeting — meetings reference them"). Borderline LOW — the
    operational ergonomics ADR §3.5 implied a card-list inside the
    section view, which lands in 2.2 (per ADR scope notes); the
    current state is consistent.
  - Fix: Optional — add a count chip ("N action items live this
    meeting") sourced from the snapshot rows. Defer to 2.2.

- **F-L9: `adjourned` status is dead code.**
  - Where: `apps/api/src/routes/meetings/index.ts:1633` (adjourn
    sets `pending_finalization` directly); line 1902 (finalize
    allows `pending_finalization` OR `adjourned`).
  - What: The DB CHECK enum and finalize handler both reference
    `adjourned`, but no route ever sets it. Dead path.
  - Fix: Either remove `adjourned` from the enum (a migration; not
    worth the cost in 2.1) or add a runbook note explaining the
    collapsed sub-state.

- **F-L10: Step-up freshness window is fixed at 60s without a
  signature-flow accommodation for the 4 sequential signings.**
  - Where: `apps/api/src/routes/meetings/index.ts:251-262` and the
    signature route's `stepUpGate` call.
  - What: ADR §3.10 documents the cost (rep may need 4 step-ups for
    4 signatures). §E failure mode confirmed — if the rep's step-up
    expires between page load and submit for any of the 4 signatures,
    they get a clean 401 + the client (line 487-491) dispatches the
    step-up modal. The recovery path works. Low.
  - Fix: None — accepted per ADR §"Negative tradeoffs".

### Verified clean

- **`firstRaisedMeetingId` immutability**: PATCH Zod (`apps/api/src/
routes/action-items/index.ts:172-192`) is `.strict()` and does NOT
  include `firstRaisedMeetingId`; an attempt to PATCH it returns 400
  `invalid_body`. Non-negotiable #12 provenance is preserved.
- **Snapshot creation gating on meeting status**: `writeLiveActionItemSnapshot`
  (lines 2002-2052) explicitly short-circuits when meeting status
  is not `in_progress`. PATCHes during `pending_finalization` /
  `finalized` correctly do NOT write live snapshots, preserving the
  finalized meeting's immutability (#13 spirit).
- **Finalized snapshot promotion exhaustiveness**: Adjourn (lines
  1571-1627) loops over `DISTINCT ON (action_item_id)` of all live
  snapshots and INSERTs `finalized` rows; the partial UNIQUE on
  `(meeting_id, action_item_id) WHERE snapshot_kind='finalized'`
  catches replay. Idempotent.
- **Live snapshots retained post-adjournment**: No DELETE on the
  live rows during adjourn (per S0 user-decision); verified by code
  inspection. Mid-meeting deliberation history queryable.
- **Action item cascade on meeting delete**: `action_items.meeting_id`
  and `action_items.first_raised_meeting_id` are both `ON DELETE SET
NULL` per migration 0011 lines 541, 546. Snapshot rows cascade-
  delete on meeting delete; action_items themselves SURVIVE (per
  non-negotiable #12). Verified clean (note: no DELETE route ships
  in 2.1, but the FK behavior is correct for when one does).
- **`worker_co_chair`-only in_app_passkey constraint**: Route
  (line 1713-1716) checks before the DB INSERT; the
  `meeting_signatures_method_shape_check` CHECK constraint is the
  structural backstop (migration line 433-445). Defense in depth.
- **Off-app evidence ciphertext requirement**: Route lines 1721-1734
  reject the off-app branches when any of `evidenceEnvelopeCt`,
  `evidenceEnvelopeDekCt`, or `evidenceStorageKey` is missing (clean
  422). The DB CHECK is the structural backstop. (Caveat: see F-L1
  for the synthetic-key bypass.)
- **Finalize 4-of-4 gate**: Route lines 1885-1927 read
  `workplace.minutesSignerRoles` from config; compares against the
  signatures-present set; returns 409 `signatures_incomplete` with
  the `missingRoles` array if any role is missing. The
  `meeting_signatures_meeting_role_unique` partial UNIQUE prevents
  the duplicate-role case. Clear error.
- **`config/workplace.ts` role validation**: `assertSignerRolesConfigured`
  (line 124) fails closed if any env label is missing; the IDs are
  fixed at 4 (`SIGNER_ROLE_IDS`, line 59-64); the enum cannot drift
  to 3 or 5 (T-ML28 mitigation).
- **Step-up freshness on every signature**: Route line 1707 calls
  `stepUpGate(c, 'meeting.sign.${body.signerRole}')` before any DB
  work for EVERY signer including off-app. T-ML6 covered.
- **Attestation signing payload completeness**: `AttestationRowCanonical`
  (`apps/api/src/lib/meeting-crypto.ts:114-126`) includes
  `meetingId`, `signerRole`, `signedMethod`, `signedAt`,
  `evidenceHash`, `stepUpJti`, `signingKeyId`. Cross-meeting replay
  (T-ML8) blocked by `meetingId` in the signed material. Re-binding
  a paper hash to a different meeting fails verification.
- **Signer-name encryption under workplace public key**:
  `apps/web/src/meetings/crypto.ts` uses `getOrRefreshWorkplaceKey`
  from the 1.11 excel-imports cache; sealed-box DEK wrap matches the
  1.9 recommendations envelope pattern. Non-negotiable #1 + #4
  preserved.
- **Rights-protective copy**: `apps/web/src/meetings/rights-protective-
copy.ts` factual ("Pending" / "Signature recorded" / "Management
  signatures pending"); zero "refused" / "declined" / "rejected"
  framing in the chrome. The 30-day s.50/s.147 hint is informational,
  non-prescriptive. Snapshot-test exists at `apps/web/src/__tests__/
meetings-rights-protective-copy.test.ts`. T-ML20 / T-ML21 / T-ML26
  / T-ML27 covered.
- **Cross-chain anchor hash composition (TM-fold-3)**: Recommendations
  route line 473 emits `recommendation.drafted` and captures
  `chainRow.thisHash`; line 525-540 then emits
  `meeting.recommendation_drafted` with that hash in the payload.
  Both emissions are inside the same transaction — if the
  recommendation INSERT fails the chain rolls back together
  (no orphan cross-anchor). Verifier Gate 3
  (`apps/api/scripts/audit-log-verify.ts:463-495`) re-checks the
  hex hash matches.
- **`workplace_singleton` invariant**: CHECK
  (`workplace_singleton = 1`) is at the table level (migration line
  158-159). No route ever writes the column (default is 1). The
  partial UNIQUE on `(workplace_singleton) WHERE status IN
('in_progress','pending_finalization')` (line 195-197) enforces
  at-most-one-active-meeting at the DB layer.
- **Tigris-unreachable failure mode (§E)**: The off-app evidence
  storage key is a route input (the upload itself is the 1.7 flow,
  out of scope here); a Tigris-unreachable upload fails BEFORE the
  signature row insert, so no orphan row is created. (See F-L1 for
  the synthetic-key concern that subverts this.)
- **`meeting.finalized` payload signerRoles enumeration**: The
  finalize route includes the row-level signature IDs (line 1944)
  but NOT the role names directly. Acceptable — the IDs FK to the
  rows whose `signer_role` is verifiable; T-ML4 mitigation holds.
