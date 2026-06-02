# Recommendation Operations

Operator runbook for the Recommendations + Citations + Responses +
Action-Item Bridge + Signed Export surface shipped in Milestone 1.9.
Pairs with ADR-0008 and SECURITY.md §2.9. Cross-references
`docs/runbooks/auth.md` (KEK rotation), `docs/runbooks/evidence.md`
(workplace key pair discipline reused for the SSE-AES256 PUT),
`docs/runbooks/inspections.md` (the 1.8 PDF/export discipline the 1.9
signed-bundle layer extends), `docs/runbooks/action-items.md` (the
recommendation → action-item bridge on submit), and
`docs/runbooks/legal-corpus.md` (the citation source of truth).

## 1. Schema overview

Five new tables (`recommendations`, `recommendation_citations`,
`recommendation_responses`, `recommendation_action_item_links`,
`workplace_signing_keys`) plus an extension to `export_records` (four
new nullable columns + a `kind` CHECK widening + a column-nullness
alignment CHECK) plus an extension to `inspection_findings`
(`responsible_party_kind` + `responsible_party_user_id` for the
dual-shape close-out of the 1.8 priv-F8 residual).

**`recommendations`** — the worker-side Notice of Recommendation row.

| Field                                                          | Storage                                                                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                           | `uuid` PK.                                                                                                                                                      |
| `recommendation_number`                                        | `integer` ≥ 1. Per-jurisdiction sequence allocated under an advisory lock at submit time (T-R4).                                                                |
| `jurisdiction`                                                 | `text` CHECK in (`ON`, `CA-FED`). Stable for the row's lifetime.                                                                                                |
| `status`                                                       | `text` CHECK in (`draft`, `submitted`, `response_received`, `resolved`, `withdrawn`). Lifecycle CHECK constraint backstops every status/timestamp combo (T-R1). |
| `title_ct` / `title_dek_ct`                                    | Envelope-encrypted via `@jhsc/crypto`. NULL-pair CHECK.                                                                                                         |
| `body_ct` / `body_dek_ct`                                      | Same shape. NULL-pair CHECK.                                                                                                                                    |
| `drafted_by_user_id`                                           | FK to `users(id)`.                                                                                                                                              |
| `drafted_at` / `submitted_at` / `resolved_at` / `withdrawn_at` | Lifecycle timestamps; set by the route on state transitions.                                                                                                    |
| `withdrawn_reason`                                             | Enum-constrained 200-char `text` (PI-clean — `rescinded`, `superseded`, `addressed_pre_submission`). NOT encrypted (T-R34).                                     |
| `audit_idx`                                                    | UNIQUE FK into `audit_log(idx)` — `recommendation.drafted` chain row.                                                                                           |

UNIQUE `(jurisdiction, recommendation_number)` enforces T-R5 structural backstop.

**`recommendation_citations`** — full-replace on PATCH; pinned to corpus state at submit time.

| Field               | Storage                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `recommendation_id` | FK to `recommendations(id)` `ON DELETE CASCADE` (citations are entirely owned by their parent). |
| `statute_code`      | `text` (e.g. `OHSA`, `CLC_PART_II`).                                                            |
| `clause_id`         | `uuid`. NOT FK to `clauses` by design — see §3 corpus-amendment invariance.                     |
| `version_date`      | `date`. Together with `statute_code` + `clause_id` forms the historical pin.                    |
| `position`          | `integer` ≥ 1. Dense within a recommendation per the Zod gate.                                  |

UNIQUE `(recommendation_id, position)` + UNIQUE `(recommendation_id, statute_code, clause_id, version_date)` enforce density + de-dup at the SQL layer.

**`recommendation_responses`** — append-only.

| Field                                   | Storage                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `recommendation_id`                     | FK to `recommendations(id)` `ON DELETE RESTRICT`.                     |
| `position`                              | `integer` ≥ 1 with CHECK `position <= 50` (T-R42 SQL backstop).       |
| `received_at`                           | `timestamptz` default `now()`.                                        |
| `received_by_user_id`                   | FK to `users(id)`.                                                    |
| `author_role_ct` / `author_role_dek_ct` | Envelope-encrypted. NULL-pair CHECK.                                  |
| `body_ct` / `body_dek_ct`               | Same shape.                                                           |
| `audit_idx`                             | UNIQUE FK into `audit_log(idx)` — `recommendation.response_captured`. |

UNIQUE `(recommendation_id, position)` is the structural T-R10 backstop. No PATCH or DELETE route exists; the only API write is the append-only POST.

**`recommendation_action_item_links`** — one-rec-per-action-item bridge created at submit.

| Field               | Storage                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `recommendation_id` | FK to `recommendations(id)` `ON DELETE RESTRICT`.                                           |
| `action_item_id`    | UNIQUE FK to `action_items(id)` `ON DELETE RESTRICT` (T-R13).                               |
| `link_kind`         | `text` CHECK in (`tracks`, `replaces`). 1.9 ships `tracks` only; `replaces` is a 1.12 seam. |

**`workplace_signing_keys`** — separate primitive from the X25519 sealed-box `workplace_keys` (T-R18 ratchet).

| Field                                   | Storage                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`                                    | `uuid` PK.                                                                                                |
| `algorithm`                             | `text` CHECK in (`ed25519`). Forward-compat for future scopes.                                            |
| `public_key`                            | `bytea(32)` (Ed25519 raw public key). CHECK `length(public_key) = 32`.                                    |
| `private_key_ct` / `private_key_dek_ct` | Envelope-encrypted under the KEK. NULL-pair CHECK.                                                        |
| `active`                                | `boolean`. Partial UNIQUE INDEX `(active) WHERE active=true` enforces "at most one active" (T-R19).       |
| `created_at` / `retired_at`             | Lifecycle timestamps. Retired keys stay queryable forever for verification of historical exports (T-R21). |
| `audit_idx`                             | UNIQUE FK into `audit_log(idx)` — `audit.workplace_signing_key.seeded`.                                   |

The `export_records.signing_key_id` FK pins the historical key on every recommendation export row (forever-verifiability per T-R18).

**`export_records` extensions (migration 0008).**

| New field          | Storage                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `signing_key_id`   | nullable `uuid` FK to `workplace_signing_keys(id)` `ON DELETE RESTRICT`. NOT NULL for `kind='recommendation_single'` per the alignment CHECK. |
| `signature_sha256` | nullable `bytea(32)`. NOT NULL for `kind='recommendation_single'`.                                                                            |
| `kind` widening    | CHECK extended to include `recommendation_single` alongside the 1.8 `inspection_single` / `inspection_batch`.                                 |

The column-nullness alignment CHECK enforces `kind='recommendation_single' IMPLIES inspection_ids IS NULL AND signing_key_id IS NOT NULL AND signature_sha256 IS NOT NULL` so a misuse fails at INSERT with 23514 (T-R32).

## 2. Lifecycle

The 1.9 happy-path lifecycle for one recommendation:

1. **`POST /api/recommendations`** with `{title, body, jurisdiction, citations?}`. Server-side envelope-encrypts title + body. Emits `recommendation.drafted`. Status = `draft`.
2. **`PATCH /api/recommendations/:id`** (zero or more times). Allow-list: `title`, `body`, `citations` (full replace). Jurisdiction is intentionally immutable after draft save. Emits `recommendation.draft_patched` on every successful mutation (S5 sec-F4 close-out, T-R44) with PI-clean priorCitationsHash + newCitationsHash + bodyChanged boolean.
3. **`POST /api/recommendations/:id/submit`** — the bridge to action_items. Re-validates the citation set against the live corpus (T-R7 / T-R8). Allocates the per-jurisdiction recommendation_number. INSERTs the linked action_items row + recommendation_action_item_links row + emits `recommendation.submitted` — all in one transaction (T-R13).
4. **`POST /api/recommendations/:id/responses`** per management response. Position is allocated under an advisory lock; UNIQUE is the SQL backstop. Status flips `submitted → response_received` on FIRST response only (subsequent appends leave the status pinned per ADR-0008 §3.4).
5. **`POST /api/recommendations/:id/resolve`** — requires `status='response_received'`. Linked action_item moves to `completed_this_period` + `status='Closed'`. Emits `recommendation.resolved`.
6. **`POST /api/recommendations/:id/withdraw`** — side state from `draft`, `submitted`, or `response_received`. Reason is the PI-clean enum (T-R34). Linked action_item (if any) moves to `archived` + `Cancelled`. Emits `recommendation.withdrawn`.
7. **`POST /api/recommendations/:id/exports`** — step-up gated at 60s. Renders the PDF, signs with the active workplace signing private key, assembles the deterministic ZIP, PUTs to Tigris with SSE-AES256, INSERTs `export_records` row, emits `recommendation.exported`. The 30-day TTL hint is enforced at the download route.
8. **`GET /api/recommendations/exports/:id/download`** — step-up gated at 60s + CSRF-header gated. Re-fetches the ZIP, runs the TOCTOU verify (manifest pdfSha256 + observed PDF sha + observed signature sha against the chain-anchored `signature_sha256` per S5 sec-F3), then emits `recommendation.export.downloaded` (S5 sec-F2 close-out, T-R43) before streaming bytes back. Failed verifies return 500 `export_tamper_detected` or 500 `export_signature_tamper_detected` and do NOT anchor.

## 3. Citation discipline

The corpus is the only source of legal text (CLAUDE.md non-negotiable #5). The four-way Zod gate runs at create AND PATCH AND submit:

1. **Corpus presence.** Every `(statute_code, clause_id, version_date)` triple must resolve in `legal_clauses` joined to `statutes` via `statute_code`. Submit-time re-validation against the live corpus (T-R7 / T-R8 close-out).
2. **Dense positions.** Positions are 1..N with no gaps or duplicates.
3. **Marker density.** Every `[[cite:N]]` marker in the body has a matching position entry in the citation list.
4. **Citation density.** Every citation list entry has a corresponding `[[cite:N]]` marker in the body.

**S5 sec-F8 close-out: PATCH body-only re-validation.** When the PATCH body changes but citations don't (no `citations` field in the request), the route re-runs `validateCitations` against the EXISTING citation set. Dangling markers and unreferenced citations now surface as 422 `citation_marker_mismatch` at PATCH time, not deferred to submit.

**Corpus-amendment invariance (T-R8).** `recommendation_citations.clause_id` does NOT FK to `clauses(id)`. The corpus seeder is INSERT-only (1.4 T-LC5); a new `version_date` is a new row with a `superseded_by` pointer. The export resolveRecommendation handler joins to `clauses` by `(statute_code, clause_id, version_date)` triple and returns the historical row regardless of newer versions. The signed PDF's footnote provenance pins to the version_date at submit time; a corpus amendment between submit and a fresh export of the same recommendation produces a different `citationsHash` and the chain records both.

**S5 sec-F4 close-out (T-R44): PATCH chain anchor records churn.** Every successful `PATCH /api/recommendations/:id` emits `recommendation.draft_patched` with `priorCitationsHash` + `newCitationsHash` (computed via `computeCitationRowsHash` in `apps/api/src/recommendations/citations.ts` — a JOIN-free hash over the raw triples). A bad-faith rep who replaces an OHSA s.25(2)(h) citation with an unrelated clause while preserving the body wording leaves a chain row showing the swap. The submit anchor's `citationCount` + the export anchor's `citationsHash` continue to capture the FINAL state. The two hashes together close the draft-state forensic gap the S4 reviewer flagged.

**S5 sec-F12 documented residual: direct SQL INSERT bypass.** `recommendation_citations` intentionally has no FK to `clauses` (corpus-amendment invariance). The Zod gate is the only enforcement. A direct SQL INSERT with arbitrary `(statute_code, clause_id, version_date)` succeeds — admin SQL access bypasses the gate. The export resolveRecommendation handler catches the inconsistency at export time with `citation_corpus_missing` 500. If you ever see `citation_corpus_missing` at export, run a diff between `recommendation_citations` and `clauses` to find the rogue row.

## 4. 21-day s.9(21) clock

The deadline is computed server-side in the projection (per `recommendation-clock.ts`). Jurisdiction branches the behavior:

- **`ON`** — hard 21-day deadline per OHSA s.9(21). The badge surfaces "Due by `<date>`" + escalates to overdue when `now > submitted_at + 21d` and no response is received.
- **`CA-FED`** — informational only per CLC s.135(6) "as soon as possible". No fixed clock, no overdue label. The badge surfaces "days since submission: N" without color escalation (non-negotiable #5 — we do not invent a statutory deadline that doesn't exist).

The web client renders the returned `deadline_at` + `days_remaining` + badge severity verbatim and does NOT re-compute (T-R16 mitigation — local-clock-manipulation defense).

## 5. Action-item bridge

The bridge auto-creates at SUBMIT only (NOT at draft create — T-R12). Per the inspection-promote pattern from 1.8:

- `action_items` row INSERTed with `source_type='recommendation'`, `source_id=<recommendation_id>`, `type='REC'`, `section='recommendation'`, `status='Not Started'`, `risk='Medium'`. The description is PI-CLEAN: `"Recommendation #N (jurisdiction): Open the recommendation for full text."` (T-R12 close-out — no body / title plaintext welded in).
- `recommendation_action_item_links` row INSERTed with `link_kind='tracks'`. UNIQUE on `(action_item_id)` is the structural backstop.
- Both INSERTs + the `recommendation.submitted` chain anchor run in one transaction (T-R13).
- The 1.6 `action_items_source_fk_guard` trigger gains a `'recommendation'` branch in migration 0008. A hand-crafted INSERT into `action_items` with `source_type='recommendation'` and a bogus `source_id` fails with 23514 at the trigger. The route-level Zod refinement REJECTS `sourceType='recommendation'` on `POST /api/action-items` with 400 `recommendation_source_requires_submit_route` (T-R14) — the only legitimate emitter is the recommendation submit handler.

**Resolution.** `POST /api/recommendations/:id/resolve` UPDATEs the linked action_item to `section='completed_this_period'` + `status='Closed'` + `closed_date=now()` inside the recommendation status flip transaction.

**Withdrawal.** `POST /api/recommendations/:id/withdraw` UPDATEs the linked action_item (if any) to `section='archived'` + `status='Cancelled'` + `closed_date=now()` inside the same transaction. The action_item reason is the literal template `"Recommendation withdrawn."` — never the rep's free-text reason. The rep's enum reason lives on `recommendations.withdrawn_reason` in plaintext (PI-clean enum, T-R34).

## 6. Workplace signing key

The workplace signing keypair is a SECOND primitive — distinct from the X25519 sealed-box workplace keypair (1.7 ADR-0006). Both keypairs are seeded at first-run; the seed handler emits `audit.workplace_signing_key.seeded` after the row INSERT.

**Algorithm.** Ed25519. Selected for the small signature size (64 bytes) and the wide library support; libsodium ships the primitive across every target language a future third-party verifier might use.

**Storage.** Public key as raw 32 bytes in `workplace_signing_keys.public_key`. Private key as envelope-encrypted ciphertext under the KEK in `private_key_ct` + `private_key_dek_ct`. Postgres sees ciphertext only; the KEK lives in Fly Secrets.

**At-most-one-active.** Partial UNIQUE INDEX `(active) WHERE active=true` enforces the invariant at the DB layer. A migration bug that produces two `active=true` rows fails with 23505 at the second INSERT (T-R19).

**Pinning on every export row.** `export_records.signing_key_id` FKs the historical row with `ON DELETE RESTRICT`. Past exports retain their signing-key pointer forever — a future rotation does not break verification of historical bundles (T-R21).

**Rotation.** Deferred to 1.12. The procedure: INSERT a new row with `active=true`; UPDATE the prior row to `active=false, retired_at=now()`. The DB never DELETEs the row. The migration linter rejects any `DELETE FROM workplace_signing_keys` diff. A verifier consulting the manifest's `signingPublicKeyB64` continues to validate past exports because the public key bytes are pinned in the manifest and on the chain row.

**Public key encoding (S5 sec-F5 close-out).** The session response (`GET /api/auth/session`) and the export manifest both encode the public key with `sodium.to_base64(..., base64_variants.URLSAFE_NO_PADDING)`. Standardizing on one variant means a future client-side fingerprint comparison works without normalization. Cross-codec normalization is fragile — pick one and stick with it.

## 7. Audit anchors on the recommendation path

The 1.9 chain contract is **eleven kinds** related to recommendations (nine added in S1, two added in S5):

| Kind                                        | Emitted on                                                 | Payload (PI-clean)                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `recommendation.drafted`                    | `POST /api/recommendations`                                | `{recommendationId, recommendationNumber, jurisdiction}`                                                                                           |
| `recommendation.draft_patched` (NEW S5)     | `PATCH /api/recommendations/:id`                           | `{recommendationId, recommendationNumber, priorCitationsHash, newCitationsHash, bodyChanged}` — sec-F4 close-out. Citation churn now in the chain. |
| `recommendation.submitted`                  | `POST /api/recommendations/:id/submit`                     | `{recommendationId, recommendationNumber, jurisdiction, citationCount, linkedActionItemId}`                                                        |
| `recommendation.response_captured`          | `POST /api/recommendations/:id/responses`                  | `{recommendationId, responseId, position}` — no role text, no body                                                                                 |
| `recommendation.resolved`                   | `POST /api/recommendations/:id/resolve`                    | `{recommendationId, linkedActionItemId}`                                                                                                           |
| `recommendation.withdrawn`                  | `POST /api/recommendations/:id/withdraw`                   | `{recommendationId, linkedActionItemId                                                                                                             | null}` — reason NEVER in payload (T-R34) |
| `recommendation.exported`                   | `POST /api/recommendations/:id/exports`                    | `{exportId, recommendationId, outputSha256, signatureSha256, signingKeyId, citationsHash, byteSize}` — all hashes/ids/counts                       |
| `recommendation.export.downloaded` (NEW S5) | `GET /api/recommendations/exports/:id/download`            | `{exportId, recommendationId, downloadedByUserId}` — sec-F2 close-out. Mirrors the 1.8 `inspection.export.downloaded` retrofit.                    |
| `inspection_finding.read`                   | `GET /api/inspections/findings/:id` (1.8 retrofit)         | `{findingId, inspectionId}` — closes 1.8 priv-F3 residual                                                                                          |
| `inspection.export.downloaded`              | `GET /api/inspections/exports/:id/download` (1.8 retrofit) | `{exportId, downloadedByUserId}` — closes 1.8 priv-F5 residual                                                                                     |
| `audit.workplace_signing_key.seeded`        | First-run signing key seeder                               | `{signingKeyId, algorithm, publicKeySha256}` — fingerprint only, no private bytes                                                                  |

**Documented residual: `recommendation.read` is NOT chain-anchored in 1.9** (S5 sec-F9 / priv-F5). The reveal endpoint (`GET /api/recommendations/:id/reveal`) is step-up gated at 60s and decrypts title + body + every response's author_role + body, but emits no chain row. The 30-day TTL on exports + the 60s step-up freshness window are the residual bound. A 1.12 ratchet adds the kind without ceremony (the 1.7 evidence path added three kinds the same way; the 1.8 inspection_finding.read close-out is the most recent precedent).

**Chain payload contract.** All eleven payloads pass through the same typed-emit boundary as 1.3 priv-F2 — PI-clean by construction (ids + hashes + counts + enums only, never names or free text). The discriminated union in `packages/shared-types/src/index.ts` rejects PI fields at the typechecker.

## 8. PIPEDA P9 response

Workers and incidentally-named third parties have a right under PIPEDA Principle 9 to challenge accuracy and request access or amendment. For recommendations specifically:

**Default response.** Refuse the request and direct the requester to the workplace's complaint mechanism (OHSA s.9(20) / CLC s.135(5) / MLITSD / PIPEDA Commissioner). Rationale: recommendations are statutory artifacts, the rep is the worker-side custodian, and removing or modifying a submitted recommendation would compromise chain of custody. Recommendations are structurally immutable past the `draft` state — the PATCH route returns 422 `not_draft_state` for `submitted` / `response_received` / `resolved` / `withdrawn`.

**Append-only responses.** `recommendation_responses` has no PATCH or DELETE route. A typo in a transcribed management response is corrected by APPENDING an additional response (position N+1) — never edit. The `(recommendation_id, position)` UNIQUE plus the `position >= 1` CHECK make a clobber require explicit UPDATE SQL — and the chain payload's `responseId + position` would no longer match the row.

**Conditional disclosure.** A request from a worker for recommendation data that DEPICTS THAT WORKER (named in the encrypted body, named in an encrypted response) MAY be answered by:

1. Step-up authenticating as the rep operator.
2. Calling `GET /api/recommendations/:id/reveal` (no chain anchor lands today — see §7 residual).
3. Delivering the plaintext out-of-band, with a written record of which recommendation IDs were touched.
4. Recording the disclosure as a note in a meeting-minutes entry (does NOT mutate the recommendation row).

**Amendment / redaction.** Recommendation rows have NO mutation path once submitted. The in-place redaction model (`recommendation_redactions` table with a `redacted_at` + `redacted_reason` column pair plus a placeholder ciphertext swap) is **deferred to 1.12**. Until then, the operator's options are (a) leave the recommendation in place and add a clarifying note on the linked action item or as a follow-up response (position N+1, append-only); (b) defer to the PIPEDA Commissioner if the matter is urgent.

**PIPEDA P9 on the signed PDF that left the rep's hand.** Once the signed bundle is hand-served on the employer, the EMPLOYER is the data custodian for that physical artifact (or PDF on the employer's file system). PIPEDA P9 requests against the printed Notice should be directed to the employer, not the rep. The rep retains the signed bundle in Tigris for the 30-day TTL window; thereafter the operator's local copy is the authoritative artifact. The rep IS the data custodian for their own evidentiary copy.

## 9. Signed bundle verification recipe

Every signed export ZIP contains a `README.txt` with the recipient verification recipe. The runbook is the canonical operator-facing copy:

1. Read `manifest.json`. Decode the base64 `signingPublicKeyB64` (URL-safe no-padding RFC 4648 §5) to a 32-byte Ed25519 public key.
2. Compute `sha256(recommendation.pdf)` as hex.
3. Compute `sha256(manifest.json bytes — exactly as you read them from the ZIP, including the trailing newline)`.
4. Build the signed message string: `${sha256(pdf hex)}:${sha256(manifest hex)}` — two 64-char hex digests separated by a single colon (129 bytes UTF-8).
5. Pass that 129-byte UTF-8 string, the `signature.bin` bytes, and the public key to `crypto_sign_verify_detached`. Verification succeeds iff the bundle has not been altered AND was produced by the workplace whose public key matches.

The manifest's `signatureScope: 'pdf_and_manifest'` field documents the scope — both the PDF and the manifest are bound by the signature. Tampering with either flips verification to false.

**Cross-check the chain row.** A verifier with chain access should ALSO compare `manifest.pdfSha256` against `audit_log` payload's `outputSha256` on the `recommendation.exported` event and `manifest.signingKeyId` against the chain row's `signingKeyId`. The download route does this server-side (S5 sec-F3 close-out — signature.bin's sha256 is now cross-checked against `export_records.signature_sha256` BEFORE the bytes return).

## 10. Tigris-side discipline

**Server-Side Encryption.** Every `putEvidenceObject` call sets `ServerSideEncryption: 'AES256'` (1.8 priv-F1 / T-I40 close-out carries forward). The signed ZIP is encrypted at rest on Tigris. `AES256` is the safe S3-compatible default; `aws:kms` is a future swap when a KMS key is provisioned for the bucket. The bucket-level default-encryption policy is a **1.12 ops follow-up** — Tigris ops should set `ServerSideEncryption: 'AES256'` as the bucket default so any direct PUT (admin tooling, future migrations) inherits the SSE.

**30-day TTL.** Enforced by the download route's `expires_at` check (`exports.ts:expires_at` against `Date.now()`). Returns 410 `export_expired`. The Tigris bucket lifecycle policy to delete `exports/*` objects after 30 days is a **1.12 ops follow-up** — the application-layer TTL is the only enforcer today.

**Storage key shape.** `exports/<exportId>/recommendation-<recommendationId>-<exportId>.zip`. The exportId is the unguessable `gen_random_uuid()` (122-bit entropy); access requires presigned URLs minted by the API. The bucket has no public-read policy.

**Orphan ZIP cleanup (sec-F6 / T-I42 mirror).** The route wraps the `db.transaction` in a try/catch. On rollback after a successful Tigris PUT, best-effort `DeleteObject` runs against the orphaned `storageKey` + logs at warn level. Never throws from cleanup; the original transaction error re-raises.

**Re-download path.** Step-up gated at 60s (action `recommendation.export.download`). `X-Requested-With: jhsc-web` CSRF guard at the route layer. The route runs the TOCTOU verify (manifest pdfSha256 + observed PDF sha + observed signature sha vs the chain-anchored hashes) BEFORE emitting the `recommendation.export.downloaded` chain anchor + streaming bytes back. Failed verifies return 500 `export_tamper_detected` or 500 `export_signature_tamper_detected` and do NOT anchor.

**S5 sec-F7 documented residual: per-process rate limit.** The 5/hr per-actor export cap is currently in-memory per-process. Each Fly Machine has its own bucket; across N machines the actual limit is N × 5/hour. Fly routes typically pin connections via Fly-Cookie + recommendations are not high-volume; the limit is conservative. The pg-boss-backed cross-process limiter is a 1.12 follow-up.

## 11. Forward seams (1.12 hardening backlog)

Seams documented for the 1.12 ratchets, so a 6-month-out operator knows what is **deliberately deferred** vs accidentally missing:

- **`recommendation.read` audit kind** (sec-F9 / priv-F5 residual). Adds a 12th recommendation-related chain kind. The reveal endpoint is step-up gated but doesn't anchor per-decrypt today. The 1.8 inspection_finding.read close-out is the precedent.
- **True per-action step-up binding** (sec-F1 close-out — user-authorized doc-only fix). Current model is single-grant freshness-window; `checkStepUpFreshness` ignores the action parameter when matching grants. Honest stance documented in SECURITY.md §2.9 T-R29. The refactor: track `(action, stepUpUntil)` tuples on the session model, update `checkStepUpFreshness` to compare against the recorded action, add integration tests asserting cross-action rejection.
- **pg-boss-backed per-actor rate limit** (sec-F7 residual). Replaces the per-process in-memory token bucket. Cross-process semantics + survives API restart.
- **`responsible_party` `user_ref` user picker** (priv-F1 follow-up). The S5 web form ships only the `name_text` shape. A `user_ref` picker requires a workplace user list with display names — minor UI work bounded by the single-tenant scope.
- **Workplace signing key rotation script** (T-R21 residual). Insert + retire pattern documented in §6; script ships in 1.12.
- **PAdES embedded signatures** (T-R26 follow-up). Replace the sidecar `signature.bin` model with a PAdES-embedded signature inside the PDF itself. The recipient verifier built into Adobe / pdftools picks up the signature natively.
- **`recommendation_redactions` table** (PIPEDA P9 § 8 follow-up). In-place redaction model with a `redacted_at` + `redacted_reason` column pair plus a placeholder ciphertext swap.
- **`--check-recommendations` audit-log-verify flag** (§12 follow-up). Extends `apps/api/scripts/audit-log-verify.ts` with a cross-check of recommendation chain payloads against the live `recommendations` / `export_records` rows.
- **Full Ed25519 crypto verify on download** (sec-F3 follow-up). The S5 close-out cross-checks signature.bin's SHA-256 against the chain-anchored `signature_sha256` — catches the consistent-ZIP-swap attack. A full `crypto_sign_verify_detached` on every download is a 1.12 hardening item (the SHA-256 cross-check is the cheap-and-correct close-out per the S5 reviewer).
- **Tigris bucket-level default-encryption + lifecycle policy** (1.12 ops). Bucket inherits SSE for any direct PUT; lifecycle policy deletes `exports/*` objects after 30 days. The application-layer TTL is the only enforcer today.

## 12. Chain-of-custody verification

Before walking into an arbitration or MLITSD hearing with recommendation exhibits, run the chain verifier against the relevant rows. The 1.8 `--check-inspections` pattern extends in 1.12 to:

```bash
pnpm tsx scripts/audit-log-verify.ts \
  --since <iso-date> \
  --kinds recommendation.drafted,recommendation.draft_patched,recommendation.submitted,recommendation.response_captured,recommendation.resolved,recommendation.withdrawn,recommendation.exported,recommendation.export.downloaded,audit.workplace_signing_key.seeded \
  --check-recommendations
```

The `--check-recommendations` flag is **documented as a 1.12 follow-up** — it does NOT exist in 1.9. The intent: scan every recommendation-related chain payload for zero-UUID placeholders (same forward-defense as the 1.7 sec-F1 `--check-evidence` pattern); cross-reference every `recommendation.exported` payload's `outputSha256` against the `export_records.output_sha256` column AND `signatureSha256` against `signature_sha256` AND `signingKeyId` against the FK target; cross-reference every `recommendation.draft_patched` payload's hashes against a re-computation from the recommendation_citations rows at the audit row's timestamp (best-effort — citations are full-replace so the hash isn't recoverable after subsequent PATCHes).

Until the flag ships, the operator runs the generic chain replay:

```bash
pnpm tsx scripts/audit-log-verify.ts --since <iso-date>
```

The verifier replays the hash chain from genesis, asserting no tampering. Print the resulting JSON dump as the exhibit appendix.

## 13. Rep-visible identity surface on the printed PDF (priv-F13)

The signed PDF's cover surfaces an **8-char UUID prefix** of the drafting rep's user id (`draftedByUserIdPrefix`) and, per response, an 8-char prefix of the receiving rep's user id (`receivedByUserIdPrefix`). The prefix choice is documented inline at `apps/api/src/recommendations/pdf-renderer.ts:99-101`:

> "8-char prefix of the receiving rep's user uuid. The rep does the join offline if they need the full identity — PIPEDA-cleaner than surfacing the full uuid in the disclosable PDF."

**Single-rep operational implication.** In a single-rep deployment (only one person drafts recommendations), the 8-char prefix is functionally a name — it uniquely identifies the rep on every PDF the workplace produces. PIPEDA P4 minimize-collection holds (the prefix is the minimum identifier the rep needs to prove "I wrote this"), but the rep should know this is what's on the printed artifact before they hand it to the employer.

**Operational workaround.** A rep facing reprisal who wants the Notice attributed to "the JHSC worker co-chair" rather than a UUID prefix can author the title accordingly — e.g. "JHSC Worker Co-Chair recommendation: ..." — so the recipient's eye anchors on the institutional role rather than the cover's UUID prefix. The prefix stays on the cover because it's the chain-of-custody binding to the user row.
