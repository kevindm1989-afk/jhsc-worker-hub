# M2.1 Security Review

Reviewer: independent S5 (security)
Reviewed commits: b535424, 251ae69, 9afe0b6, 5645f97, 942e0b6, 8f4e718, 5355f26
Scope: §A encryption, §B signatures, §C audit chain, §D quorum/metrics, §E payload PI, §F step-up, §G signing key

## Findings

### CRITICAL (release-blocker for M2.1)

None.

### HIGH (fix in S5 bundle)

- **F-S1: Signature route accepts in_app_passkey while meeting is `in_progress` (pre-adjournment).**
  - **Where:** `apps/api/src/routes/meetings/index.ts:1792-1801`
  - **What:** The status precondition for `POST /api/meetings/:id/signatures` is `status IN ('pending_finalization','adjourned','in_progress')`. ADR-0012 §3.9 specifies that finalization (including signature collection) starts post-adjournment — the meeting moves `adjourned → pending_finalization` and signatures are collected then. Permitting signatures during `in_progress` breaks the temporal contract that signatures attest to a frozen post-adjournment record (T-ML7 framing: "the chain records the timestamps in submission order [over a frozen content]"). A worker-co-chair could in-app-passkey-sign mid-meeting BEFORE the action items were even raised, and the same meeting could then finalize after adjournment with the signature already in place.
  - **Why it matters:** Weakens the T-ML5/T-ML7 evidentiary posture (signature claims to attest to a meeting record the signer could not have seen at sign time). Not a 4-of-4 bypass (T-ML4 still holds via the finalize gate), but undermines the chain's narrative of "all four attested to the finalized record."
  - **Fix:** Tighten the predicate to `status IN ('pending_finalization','adjourned')` and update the test to assert 422 `meeting_not_signable_in_state` when status is `in_progress`.

- **F-S2: `--check-meetings` Gate 1 hardcodes the 4 signer roles; route reads them from env.**
  - **Where:** `apps/api/scripts/audit-log-verify.ts:336-341` vs `apps/api/src/routes/meetings/index.ts:1885-1887` (reads `workplace.minutesSignerRoles`).
  - **What:** The verifier's `REQUIRED_SIGNER_ROLES` constant is `['worker_co_chair','mgmt_co_chair','mgmt_external_1','mgmt_external_2']`. The finalize route accepts whatever roles `loadWorkplaceConfig()` produces from env. T-ML41 (workplace-config rotation) anticipates per-meeting role snapshots; absent a snapshot column on `meetings`, a future env change would silently desync the verifier and the chain.
  - **Why it matters:** T-ML4 (4-sig bypass) close-out partially regresses if a workplace config edit introduces a fifth or differently-named role; the verifier would still pass meetings signed under the old 4-role set, but new meetings under the new role set would be flagged as `finalized_missing_signatures`. Also: a malicious operator who edits env to a 1-role set could pass the route's gate; the verifier would still flag, but the report would be operator-controlled.
  - **Fix:** Either (a) emit `requiredSignerRoles: SignerRoleId[]` on the `meeting.created` payload and have the verifier read per-meeting, or (b) add an explicit deploy-runbook check that the verifier's constant matches `WORKPLACE_MINUTES_SIGNER_*` env. Recommend (a) — it is the structural answer to T-ML41 as well.

- **F-S3: No integration test asserts `meeting.finalized` chain payload shape on finalize.**
  - **Where:** `apps/api/src/routes/meetings/meetings.integration.test.ts:349-421` (finalize gate test) — verifies the route returns 200 and `verify(db).ok === true`, but does not assert that a `meeting.finalized` audit_log row was emitted with `signatureIds: [4]` or that `signerRoles` are correct.
  - **Why it matters:** T-ML22 (chain anchor missing on finalize) — the threat model calls for an explicit assertion that the finalize transition emits the chain row. A regression that silently dropped the `append()` call would not be caught by the current test (chain integrity passes because no row exists to mis-link).
  - **Fix:** Append a query for the `meeting.finalized` row at the end of the existing test; assert `payload.meetingId`, `payload.finalizedAt`, and `payload.signatureIds.length === 4`.

### MEDIUM (document or defer)

- **F-S4: Worker-co-chair attestation does not bind the WebAuthn challenge (T-ML6 deepening).**
  - **Where:** `apps/api/src/routes/meetings/index.ts:1763` — `stepUpJti = auth.sessionId` for the canonical attestation row.
  - **What:** ADR-0012 §3.9 calls for the WebAuthn `clientDataJSON` challenge to include `meetingId` for cross-meeting replay defense (T-ML6/T-ML8 deepening). The current implementation uses the bare `auth.sessionId` as `step_up_jti`; the meeting-id is signed implicitly via the AttestationRowCanonical (which includes `meetingId`), so per-meeting binding holds via the Ed25519 sig — but the step-up grant itself is not bound. A stolen-session attacker who could replay a step-up grant could sign any meeting in the freshness window. Lower priority because session theft is already a 1.2 auth bound; documented because the SECURITY.md §2.13 T-ML6 mitigation text claims the challenge binds `meetingId` and the code does not.
  - **Fix:** Either land a per-meeting WebAuthn challenge extension to the step-up flow (1.2 reach), or amend SECURITY.md T-ML6 to reflect that the meeting-binding lives on the attestation row (Ed25519 over canonical JSON), not the step-up challenge.

- **F-S5: Signature route status predicate allows `adjourned` directly (no `start-finalization` step).**
  - **Where:** `apps/api/src/routes/meetings/index.ts:1793-1794`, `1902` (finalize accepts `adjourned` too).
  - **What:** ADR-0012 §3.9 describes an explicit `POST /api/meetings/:id/start-finalization` sub-state transition (`adjourned → pending_finalization`). The route file never implements this endpoint (the route listing in the file header omits it; cf line 1-31). Both `signatures` and `finalize` accept `adjourned` directly. Functionally fine, but the documented sub-state transition does not exist; the verifier cannot distinguish "adjourned, never started finalization" from "adjourned and signatures recorded." Documented vs. shipped divergence.
  - **Fix:** Either add the `start-finalization` route + corresponding chain anchor, or update the ADR §3.9 to record that the sub-state transition is implicit on first signature.

- **F-S6: Signature private key opened outside transaction; tx rollback leaves no rotation/zeroize gap, but mid-flight failure widens the in-memory key residency window.**
  - **Where:** `apps/api/src/routes/meetings/index.ts:1759-1782`.
  - **What:** `openWorkplaceSigningPrivateKey()` is called before `db.transaction`; the private key bytes live in JS heap for the entire transaction (DB INSERT + chain append). `sodium.memzero` in finally is correct; the residency window is short. Not security-load-bearing — same posture as the recommendation signing path. Documented for completeness; no change requested.

### LOW

- **F-S7: `meeting.attendance.recorded` audit kind reused for both create and update.**
  - **Where:** `apps/api/src/routes/meetings/index.ts:1235` (POST) and `1367` (PATCH).
  - **What:** ADR S0 fixed the audit kinds at 11; the same `meeting.attendance.recorded` kind covers both initial recording and subsequent status changes. The verifier cannot distinguish "added" from "updated" without timestamp order. Acceptable; documented in ADR §3.10. No action.

- **F-S8: GET /meetings/:id exposes `attestation_signed_ct` bytes in the envelope response.**
  - **Where:** `apps/api/src/routes/meetings/index.ts:689`.
  - **What:** The 64-byte Ed25519 detached signature is returned base64-encoded to the client. Anyone with the workplace public key can verify it; exposure is not a leak. Mentioned because the field name `*_ct` suggests "ciphertext" — it is not (it is a public signature). Rename or comment would aid clarity. No security change.

- **F-S9: Adjournment metrics duration computed from `now() - actual_start_at` inside RETURNING; an Idempotency-Key replay would re-compute and produce a different `durationSeconds` if the row was not COALESCEd.**
  - **Where:** `apps/api/src/routes/meetings/index.ts:1631-1642`.
  - **What:** The UPDATE uses `actual_end_at = COALESCE(actual_end_at, now())` so a replay reuses the first-write timestamp, and the RETURNING clause computes duration from `now()` not `actual_end_at`. On replay this would compute against a slightly later `now()`. In practice Idempotency-Key middleware (per ADR-0009 §3.4) returns the cached response and never re-enters the route body, so the bug is unreachable. Documented for completeness.

## Verified clean

- **§A Encryption discipline.** Every sensitive field (attendee name, section notes, signer name, COC note, evidence envelope, snapshot assignee, meeting notes) is base64 ciphertext on POST and stays ciphertext in `meeting_*_ct` columns. No route handler calls `openMeetingField` / `unsealMeetingNotes` — server never decrypts. The GET envelope returns ciphertext+DEK pairs verbatim (`base64FromBytes`). Web client uses a single `getOrRefreshWorkplaceKey()` cache via `@/excel-imports/crypto`, no duplicate key store. T-ML1 / T-ML9 / T-ML19 hold.

- **§B Signatures.** `signAttestation` canonical JSON includes `meetingId` → cross-meeting replay (T-ML8) blocked. UNIQUE on `(meeting_id, signer_role)` blocks intra-meeting replay. Method-shape pre-check + DB CHECK enforce in_app_passkey vs paper/email envelope shape (T-ML5). Step-up freshness ≤60s enforced on create / adjourn / sign.<role> / finalize (T-ML6). No temporal ordering enforced between the 4 signatures (intentional per ADR §3.9, T-ML7).

- **§C Audit chain.** `--check-meetings` Gate 1-4 cover (1) 4-of-4 signature presence by role for `meeting.finalized`, (2) upstream `meeting.created` for `meeting.adjourned` + structural metrics shape, (3) `recommendationCreatedEventHash` cross-chain match for `meeting.recommendation_drafted`, (4) `meeting.created` template version backed by upstream `audit.meeting_template.seeded`. No production code mutates `audit_log` (only test fixtures DELETE/UPDATE it for tamper-simulation). T-ML13 / T-ML24 / T-ML42 hold (subject to F-S2).

- **§D Quorum and metrics.** `apps/api/src/lib/compute-quorum.ts` and `apps/web/src/meetings/quorum.ts` are byte-for-byte equivalent in semantics (ON: ceil(n/2) + ≥1 worker rep; CA-FED: floor(n/2)+1 + worker reps ≥ half of present). Adjournment metrics computed inside the transaction at adjourn-time from query results. Idempotency-Key middleware binds the first computation. T-ML14 / T-ML34 hold.

- **§E Audit kind PI leak.** The `AuditPayload` discriminated union in `packages/shared-types/src/index.ts:776-900` makes name fields a compile-time error for every meeting kind. `meeting.attendance.recorded` carries `nameHash` (sha256 of ciphertext); `meeting.section.notes_appended` carries `notesHash`; `meeting.signed` carries `evidenceHash` + `attestationSigHash`; `meeting.action_item_snapshot` carries `assigneeNameHash`. Integration tests assert payload JSON does NOT contain the plaintext markers. T-ML17 / T-ML25 hold.

- **§F Step-up window posture.** create / adjourn / sign.<role> / finalize all call `stepUpGate(c, action, maxAgeSeconds=60)`. PATCH meeting metadata, section CRUD, attendance add/patch, inspection-review, section start/end/notes are NOT step-up gated — matches ADR-0012 §3.10. The `stepUpGate` action label is per-signer-role for signatures (`meeting.sign.worker_co_chair` etc.) so the WWW-Authenticate header surfaces the right action.

- **§G Workplace signing key.** `meeting_signatures.attestation_signed_ct` is the 64-byte Ed25519 sig from the SAME `workplace_signing_keys` table used by 1.9 recommendation signing (`apps/api/src/evidence/workplace-signing-key.ts`). FK `signing_key_id` points at that row. No separate key registry; rotation surface is shared with 1.9.

---

Severity totals: CRITICAL 0, HIGH 3, MEDIUM 3, LOW 3.

Verdict: M2.1 is structurally sound — encryption, signature, chain, and quorum discipline all hold; ship after S5 bundle absorbs F-S1, F-S2, F-S3.
