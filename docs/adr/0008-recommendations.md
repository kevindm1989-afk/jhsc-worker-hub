# ADR-0008: Recommendations (s.9(20) drafting + 21-day clock + signed PDF export)

Status: Accepted, Milestone 1.9
Date: 2026-06-02
Authors: codifies Milestone 1.9 architect-phase decisions; pairs with `SECURITY.md` §2.9 (forthcoming) and `docs/runbooks/recommendations.md` (forthcoming).

## Context

A Notice of Recommendation is the worker co-chair's most consequential statutory artifact. Under OHSA s.9(20), the worker members of a JHSC may make written recommendations to the constructor or employer for the improvement of worker health and safety. Under s.9(21), the employer must respond in writing within twenty-one days, agreeing or disagreeing with the recommendation and setting out a timetable for any agreed action. Under the federal Canada Labour Code Part II analogues (s.135(5)/(6)), the workplace committee has equivalent recommendation authority and the employer must respond "as soon as possible" — no fixed-day clock, but a written-response duty all the same.

The rep currently drafts recommendations in Word, prints them, hand-delivers them to a management co-chair, and tracks the 21-day clock in their head or on a sticky note. The response comes back as a PDF attachment in employer email, gets pasted into the minutes, and the next rep cohort argues at the next meeting about whether the timetable was actually met. None of that is evidence-defensible six months later in front of an MLITSD inspector or an OLRB reprisal panel — the only artifact in the rep's possession is whatever they remembered to save, and there is no chain-of-custody on any of it.

1.9 brings the entire recommendation lifecycle into the rep's tool. Three things distinguish it from 1.5–1.8:

1. **The drafting surface is long-form prose with structured citations.** Hazards and inspections carry short observation text; recommendations are 200–2000 word documents the rep authors over multiple sessions, with statutory citations inserted inline and resolved to legal-corpus clauses at submit time. Every citation must originate in `packages/legal-corpus` (non-negotiable #5). The renderer that produces the export PDF expands inline `[[cite:N]]` markers into numbered footnotes anchored to corpus clause body hashes.
2. **The status machine spans an external counterparty.** Hazards close when the rep closes them. Recommendations only close when management responds and the rep records the response — i.e. the lifecycle has a beat the app does not control. The 21-day clock is the structural reminder that the counterparty owes a deliverable; if the clock blows, that fact is itself evidence.
3. **The export PDF is a signed evidentiary artifact.** Inspections (1.8) export plain PDFs with chain-anchored hashes; recommendations export PDFs that are _cryptographically signed_ with a workplace-controlled key so a recipient can verify the bytes were produced by this workplace's rep tool and have not been altered. The signature primitive is separate from the workplace encryption keypair already in `workplace_keys` (1.7) — Ed25519 for signing, X25519 for sealed-box encryption. Mixing them in one keypair is poor hygiene; rotation semantics differ (signing-key rotation must preserve verification of past exports forever).

Worker-side rationale for keeping the whole lifecycle in the rep's tool rather than employer infrastructure: the rep's chain-anchored evidence of _what they drafted, when they submitted it, what management said in response, and on what date_ is the artifact a hostile arbitrator reads. The employer's copy is the employer's problem. This is the same posture 1.8's three-signature rack workflow established and 1.7's evidence module before it.

`design/prototypes/recommendation-detail.tsx` is the visual anchor (drafting form, CitationRef picker, deadline banner, response capture sheet, signed-export panel). ARCHITECTURE.md §"Inspections Module (Detailed)" + §6a "Inspection Export" are the structural ancestors. ADR-0007 is the closest model — same shape (data model + lifecycle + step-up + export pipeline) and the same evidence-export bones. ROADMAP.md 1.9 scope is the recommendation data model + deadline tracking + s.9(20) drafting + 21-day clock + citation insertion + status workflow + response capture + signed PDF export + recommendations link to action items in `section='recommendation'`.

## Decision

Land five tables (`recommendations`, `recommendation_citations`, `recommendation_responses`, `recommendation_action_item_links`, `workplace_signing_keys`) plus a `kind='recommendation_single'` extension to the 1.8 `export_records` table + seven new API routes + the long-form drafting web flow + an Ed25519-signed PDF export pipeline (reusing the 1.8 `pdfkit` renderer skeleton) + nine new audit chain event kinds (five for recommendations, two retrofitted into the 1.8 inspections surface, plus the signing-key seed and rotation kinds). All sensitive recommendation prose — title, body, response body, response author role — is envelope-encrypted via `@jhsc/crypto` (same `(*_ct, *_dek_ct)` shape as hazards 1.5 / action-items 1.6 / inspections 1.8). Citations are persisted as resolved triples `{statuteCode, clauseId, versionDate}` validated against the live `legal_clauses` table at submit time. Submission auto-creates a linked action item in `section='recommendation'` (per the 1.6 enum + the polymorphic source-FK pattern; `actionItemSourceType` already includes `'recommendation'` per `packages/shared-types/src/index.ts:157`). The PDF export rides the 1.8 pipeline — `pdfkit`, Source Serif 4, generic metadata, no JS surface, step-up gated at 60s — and adds an Ed25519 detached signature in a ZIP sidecar bundle. The 1.7/1.8 polymorphic-FK ratchet pattern advances the same way: `evidence_files.linked_type='recommendation'` opens at the route layer + trigger layer in this migration, completing the forward seam called out in `packages/shared-types/src/index.ts:260`.

### 3.1 Lifecycle + status state machine

```
                       (any state)
                            │
                            ▼
                       withdrawn
                            ▲
                            │
draft ──submit──▶ submitted ──response_captured──▶ response_received ──resolve──▶ resolved
```

Five terminal states + one side-state. The transition graph is enforced at the route layer (each transition is its own endpoint), not in the DB CHECK — the CHECK accepts every value in `recommendationStatus`. The route's Zod refinement rejects backwards or skip-a-state moves with 422; the rationale matches ADR-0007 §3.7's promote fail-closed posture (the API surface is the single source of truth for transitions, the DB is the storage substrate).

**Transition semantics:**

- `draft → submitted`. The `POST /api/recommendations/:id/submit` handler runs the citation-validity pass (§3.3), creates the linked `action_items` row in `section='recommendation'` (§3.5), sets `submitted_at = now()`, starts the 21-day clock for ON jurisdictions (§3.6), and emits `recommendation.submitted`. This is the transition where the most state changes; everything else is record-keeping.
- `submitted → response_received`. The response-capture handler appends a `recommendation_responses` row, sets the recommendation's `response_received_at = first response's received_at` (only on the first response — subsequent responses leave it pinned), and emits `recommendation.response_captured`. Status flips to `response_received`.
- `response_received → resolved`. The rep marks the recommendation resolved. The linked action item moves from `section='recommendation'` to `section='completed_this_period'` (§3.5), `resolved_at = now()`, status `Closed`, emits `recommendation.resolved`.
- `* → withdrawn`. Any non-resolved state can transition to withdrawn. The linked action item (if one exists — only created at submit) moves to `section='archived'` with `status='Cancelled'`, emits `recommendation.withdrawn`. The withdrawal chain payload carries the linked action item id but **not** the rep's reason text (the reason is PI-risk free-text — supervisor names, accommodation context — and is stored on the row in an encrypted field, never in the chain payload).

**"Submitted" means delivered to the workplace's employer co-chair, not to a regulator.** Non-negotiable #8 is hard. There is no automated transport to MLITSD, ESDC, or any regulator. The PDF is the deliverable; a human hands it (or emails it from their own account) to management. The UI copy, the route copy ("Mark this Notice of Recommendation as submitted to the employer co-chair"), and the runbook all say this in the same words.

### 3.2 Recommendation schema (encrypted title + body; per-period number; jurisdiction-aware)

```
recommendations (
  id                          uuid primary key default gen_random_uuid(),
  recommendation_number       integer not null,                       -- per-jurisdiction-period sequence, allocated like action_items.sequence_number
  title_ct                    bytea not null,                         -- envelope-encrypted
  title_dek_ct                bytea not null,
  body_ct                     bytea not null,                         -- envelope-encrypted long-form prose
  body_dek_ct                 bytea not null,
  jurisdiction                text not null check (jurisdiction in ('ON','CA-FED')),
  status                      text not null check (status in
                                ('draft','submitted','response_received','resolved','withdrawn')),
  drafted_by_user_id          uuid not null references users(id) on delete restrict,
  drafted_at                  timestamptz not null default now(),
  submitted_at                timestamptz,
  response_received_at        timestamptz,
  resolved_at                 timestamptz,
  withdrawn_at                timestamptz,
  withdrawal_reason_ct        bytea,                                  -- envelope-encrypted; PI-risk
  withdrawal_reason_dek_ct    bytea,
  audit_idx                   bigint not null references audit_log(idx),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (jurisdiction, recommendation_number)
);
```

- **`recommendation_number` is per-jurisdiction-period, NOT globally monotonic.** ON recommendations and CA-FED recommendations have independent sequences; "Notice of Recommendation ON-2026-014" and "Notice of Recommendation CA-FED-2026-003" are both well-formed. Allocated via the same `pg_advisory_xact_lock(hashtext('recommendations.number.<jurisdiction>'))` pattern as `allocateSequenceNumber` in `apps/api/src/routes/action-items/index.ts:945`. The period semantics (calendar year vs JHSC fiscal year) are deferred to a `WORKPLACE_RECOMMENDATION_PERIOD` config knob — defaults to calendar year; the UI surfaces "Recommendation #014 of 2026" formatted client-side.
- **Title and body are maximally sensitive.** Recommendations carry supervisor names ("Plant Manager X failed to act on the November report"), accommodation context ("Worker A's permanent medical restriction excludes operating the compactor"), reprisal narratives ("After raising this hazard in September, Worker B was reassigned"), and witness identifiers. Treat both fields as max-sensitive: envelope-encrypted with `sealWithEnvelope`, never plaintext in Postgres, never returned by API to anyone but the drafting rep or a step-up-authenticated reader. This is stricter than action-item descriptions; same posture as hazard descriptions and inspection observation text.
- **`jurisdiction` is a hard enum.** ON and CA-FED triggers different statutory framing, different deadline behavior, and different citation pickers (the corpus picker scopes by `statutes.jurisdiction`). No "international" or "other" — single-tenant deploys pick one or both jurisdictions at config time.
- **`audit_idx` is required and FK to `audit_log(idx)`.** Same shape as every other sensitive table in the project. The chain anchor for `recommendation.created` (sub-state of `draft`) is what audit_idx points to.

### 3.3 Citation model (`[[cite:N]]` markers + `recommendation_citations` join)

```
recommendation_citations (
  recommendation_id   uuid not null references recommendations(id) on delete restrict,
  position            integer not null check (position >= 1),         -- 1-indexed; matches [[cite:N]] markers
  statute_code        text not null,                                  -- e.g. 'OHSA', 'CLC_PART_II'
  clause_id           uuid not null references clauses(id) on update restrict on delete restrict,
  citation_text       text not null,                                  -- snapshot of clauses.citation at submit time (e.g. 's.9(20)')
  version_date        date not null,                                  -- snapshot of clauses.version_date
  body_hash           bytea not null,                                 -- snapshot of clauses.body_hash for export provenance
  primary key (recommendation_id, position),
  unique (recommendation_id, statute_code, citation_text, version_date, position)
);
```

- **The body carries `[[cite:N]]` markers inline.** The rep types prose; when they tap "insert citation," a `<CitationRef />` web component opens the corpus picker scoped to the recommendation's jurisdiction; on select, the picker writes a `[[cite:N]]` marker at the cursor (where `N` is the next available position) and adds an entry to the local citation list. The marker is plain text in the encrypted body; the resolved triple lives in `recommendation_citations`.
- **The body text NEVER contains the citation's legal text.** Only the marker. The renderer expands markers to footnotes by joining on `recommendation_citations` and then to `clauses` for the corpus body (or `body_summary` for `third_party_restricted` statutes). This keeps the encrypted body small, keeps corpus updates from invalidating drafts, and means a re-seed that publishes a new clause version surfaces as a `body_hash` mismatch at recommendation-read time (per `clauses.bodyHash` design in `packages/legal-corpus/src/schema.ts:94`).
- **Non-negotiable #5 enforcement is at the route layer.** The submit handler runs each citation through a Zod schema that resolves `(statuteCode, citation_text, version_date)` against `statutes` joined to `clauses` and rejects with 422 `citation_not_in_corpus` if any triple has no row. The Zod refinement also asserts: (a) every `[[cite:N]]` marker in the body has a corresponding `position=N` entry in the citation list (no dangling markers); (b) every citation list entry has a corresponding marker in the body (no unreferenced citations); (c) `N` values are dense (1..K with no gaps); (d) every clause's `corpus_version` matches the currently active `corpus_versions.version` (rejects citations against retired corpus versions). The four rejections are the only paths to submit-failure on citations; together they bound the corpus surface to "current, in-corpus, marker-matched, dense."
- **Workplace-policy citations are NOT corpus citations.** A rep referencing the workplace's own lockout procedure or PPE policy writes that reference as free body text. Those references receive no `[[cite:N]]` marker and no footnote; the runbook calls this out so the rep doesn't go hunting for a corpus entry that will never exist. The export PDF renders workplace-policy mentions inline as the rep wrote them, no footnote.

### 3.4 Response capture (append-only `recommendation_responses`)

```
recommendation_responses (
  id                       uuid primary key default gen_random_uuid(),
  recommendation_id        uuid not null references recommendations(id) on delete restrict,
  position                 integer not null check (position >= 1),
  received_at              timestamptz not null,                      -- the date stamped on management's response
  received_by_user_id      uuid not null references users(id),        -- the rep who transcribed it
  author_role_ct           bytea not null,                            -- envelope-encrypted; "VP Operations", "Plant Manager"
  author_role_dek_ct       bytea not null,
  body_ct                  bytea not null,                            -- envelope-encrypted; the management response text
  body_dek_ct              bytea not null,
  audit_idx                bigint not null references audit_log(idx),
  created_at               timestamptz not null default now(),
  unique (recommendation_id, position)
);
```

**Decision: append-only, one row per response, position-indexed.** A management response is the evidentiary artifact; an amendment from management is its own evidentiary artifact (a different person, a different date, possibly a different position). Either we model that as a mutation of one row — losing the history of what management said the first time — or we model it as an append. Append is the only choice consistent with non-negotiable #2 (chain-of-custody on every state transition). The rep enters the first response at `position=1`; if management replies with a revised timetable two weeks later, the rep enters that as `position=2`. The recommendation row's `response_received_at` pins to the first row's `received_at` and never moves.

**`author_role` is encrypted, not a `user_id`.** Management authors are external counterparties; they are not registered users of the worker-side tool. The role string ("VP Operations", "Health & Safety Coordinator") is itself PI-adjacent — combined with the workplace name (from `config/workplace.ts`) it identifies a specific human. Encrypt it. The audit payload carries `responseId + position + recommendationId` only — no role text in the chain.

**Chain anchor:** `recommendation.response_captured` with `{recommendationId, responseId, position}`. Status flips `submitted → response_received` only on `position=1`; subsequent appends leave the status pinned (a recommendation does not return to `submitted` because management amended).

### 3.5 Action-item bridge (auto-create on submit; resolution moves to completed_this_period)

```
recommendation_action_item_links (
  recommendation_id   uuid not null references recommendations(id) on delete restrict,
  action_item_id      uuid not null references action_items(id) on update restrict on delete restrict,
  link_kind           text not null check (link_kind in ('tracks','replaces')),
  created_at          timestamptz not null default now(),
  unique (recommendation_id, action_item_id)
);
```

- **The link table tracks the bridge, not the data.** The linked action item is its own row in `action_items` with `source_type='recommendation'`, `source_id=<recommendations.id>`. The 1.6 `action_items_source_fk_guard` trigger gets a `recommendation` branch in this migration (same pattern ADR-0007 §3.7 used to open the `inspection` branch). `actionItemSourceType` already enumerates `'recommendation'` (`packages/shared-types/src/index.ts:157`) so no shared-types churn for the source type; the trigger is the route-layer enforcement of the polymorphic FK.
- **The action_item is created in the submit transaction, not at draft create.** Drafts can sit for weeks while the rep iterates; we do not want every aborted draft to clutter the minutes' `new_business` or `recommendation` section. The action item is created only when the rep submits. The bridge row is inserted in the same transaction as the action item insert + the recommendation status flip + the `recommendation.submitted` chain anchor. Fail-closed: if any step in the transaction fails, the recommendation stays in `draft` and no action item is created.
- **`link_kind`** is `'tracks'` for the standard case (the action item tracks management's response and timetable). `'replaces'` is the slot for the recommendation-supersedes-an-earlier-hazard pattern (1.5 hazards can already promote into action items; if the rep is making the recommendation _because_ the hazard wasn't addressed, the recommendation's action item can `replace` the prior hazard-derived item). The `replaces` semantics are documented but the UI surface is deferred to Release 2; in 1.9 only `'tracks'` is reachable from the route.
- **Resolution moves the linked action item from `section='recommendation'` to `section='completed_this_period'`.** This rides the existing 1.6 section-move handler (`POST /api/action-items/:id/move`) called from inside the `POST /api/recommendations/:id/resolve` handler's transaction. The move emits `action_item.moved` on its own chain anchor; the recommendation emits `recommendation.resolved` on a separate anchor in the same transaction. Two chain rows, one transaction.
- **Withdrawal moves the linked action item to `section='archived'` with `status='Cancelled'`** and a reason of "Recommendation withdrawn." The reason text is **literal and template-supplied** — it is not the rep's free-text reason (which is encrypted on `recommendations.withdrawal_reason_ct`). This keeps the action_item move's PI surface PI-clean.

### 3.6 21-day clock (calculated; ON hard deadline, CA-FED informational)

The 21-day s.9(21) clock is **not a stored column.** It is `submitted_at + interval '21 days'` evaluated at read time. Three reasons:

1. **No "deadline drift."** A stored column needs a backfill if the calculation rule ever changes (e.g. business-day vs calendar-day disambiguation). A calculated field always reflects the current rule.
2. **Jurisdiction-aware without conditional storage.** The same row read from ON jurisdiction returns a hard deadline; from CA-FED returns informational metadata (s.135(6) is "as soon as possible"). The branch is one ternary in the route's projection.
3. **The clock IS the badge.** The UI's days-remaining badge is the operative surface; storing a redundant column invites the drift the badge would otherwise mask.

**ON:** `deadline_at = submitted_at + interval '21 days'`. `days_remaining = ceil((deadline_at - now()) / interval '1 day')`. Badge color: green ≥ 7 days remaining; amber 1–6; red 0; red-with-overdue-label ≤ -1. Once `status` flips to `response_received`, the badge changes to "responded on day N" (where N = days between submitted_at and the first response's received_at); this is the evidentiary surface — a 30-day response is still s.9(21)-deficient, and the badge records the fact.

**CA-FED:** No fixed deadline. The badge reads "days since submission: N" with no color escalation. The CLC s.135(6) "as soon as possible" duty is informational; the rep, not the app, judges whether N days is unreasonable. We do **not** invent a default deadline (e.g. "treat CA-FED as 30 days") because non-negotiable #5 forbids invention.

The badge is built as a pure function in `packages/shared-types/src/recommendation-clock.ts` (same shape as `action-item-flag.ts`). The route's projection calls it server-side so the client never re-computes day boundaries (matches the 1.6 action-flag posture).

### 3.7 Workplace signing key (separate table from `workplace_keys`; Ed25519; sealed private)

```
workplace_signing_keys (
  id                  uuid primary key default gen_random_uuid(),
  active              boolean not null default true,
  public_key          bytea not null,                                 -- Ed25519 public key (32 bytes)
  private_key_ct      bytea not null,                                 -- Ed25519 private key, envelope-encrypted under workplace KEK
  private_key_dek_ct  bytea not null,
  fingerprint         bytea not null,                                 -- SHA-256(public_key); for human-readable identification
  created_at          timestamptz not null default now(),
  retired_at          timestamptz,
  unique (fingerprint)
);
create unique index workplace_signing_keys_active_unique
  on workplace_signing_keys (active) where active = true;
```

**Decision: separate table from `workplace_keys`, not a `kind` column extension.** Three reasons:

1. **Different primitive.** `workplace_keys.public_key` is an X25519 public key for sealed-box encryption (`crypto_box_seal_open`). The signing key is Ed25519 for `crypto_sign_detached`. The bytes happen to be the same length (32) but the cryptosystems are not interchangeable; one column with two interpretations is the kind of conflation that produces "we accidentally signed with an X25519 key" bugs.
2. **Different rotation semantics.** Encryption-key rotation re-wraps existing ciphertext DEKs under the new KEK (the 1.7 ADR's rewrap path). Signing-key rotation must preserve verification of past signatures forever — retired keys stay queryable in the table; PDF exports record the `signing_key_id` they were signed with (in the signature sidecar's manifest); a verifier consulting the API gets the historical public key by id without any rewrap step.
3. **Different operational risk surface.** A leaked encryption private key compromises confidentiality of past sealed bytes (bad). A leaked signing private key allows forgery of past-dated signed PDFs (different bad). Documenting them on separate tables makes the runbook responses distinct — encryption-key leak → rotate + rewrap; signing-key leak → rotate + publish revocation notice + every past export is now in question.

**Public signing key shipped via `/api/auth/session`.** The session response gets a new `workplaceSigningKey: { id, publicKey, fingerprint }` field next to the existing `workplaceKey` shape (`apps/api/src/routes/auth/session.ts:101`). The web client uses this to verify signatures locally if it wants to (the export-detail view will show "Signature verified ✓ against workplace key {fingerprint}").

**Private signing key sealed under the workplace KEK**, same envelope pattern as `workplace_keys.private_key_ct`. The KEK is in Fly Secrets (`MASTER_KEY`); the private signing key is opened inside the export route's bounded plaintext window (same posture as the 1.8 export's photo decrypt), used to sign the PDF bytes, then `sodium.memzero`'d immediately.

**At most one active row.** Partial unique index `WHERE active = true` enforces it at the DB layer. Retired keys stay in the table forever (signature verification depends on them).

**Rotation is deferred to 1.12.** Same forward-seam pattern as the encryption keypair. The 1.9 first-run path generates the initial signing keypair; the 1.12 rotation path adds a second `active=true` row + flips the prior to `active=false + retired_at = now()`. New exports use the new key; verification of old exports consults the retired row by id. The runbook (follow-up) documents the rotation operationally.

### 3.8 PDF export pipeline (reuses 1.8 pdfkit + step-up + Tigris SSE + 30-day TTL)

Reuse the entire 1.8 `pdfkit` pipeline (`apps/api/src/inspections/pdf-renderer.ts`), Source Serif 4 embedded font, generic metadata (`/Title="JHSC Recommendation Export"`, `/Author="JHSC Worker Hub"`, no `/Subject`, no `/Keywords`), no JS surface (no `/JS`, `/JavaScript`, `/AA`, `/OpenAction` — same T-I25 posture). The renderer module is `apps/api/src/recommendations/pdf-renderer.ts` — a sibling to inspections, not a fork; the shared concerns (font registration, footer layout primitives, mime-type allow-list for embedded images, the placeholder-free hash discipline ADR-0007 §3.9 simplified) live in a small `apps/api/src/pdf-shared/` extraction that both renderers import. That extraction is a 1.9 deliverable — small surface, one cross-cutting concern (font + footer primitives), no Behavior change in the inspections export.

**Renderer surface differs from inspections:** long-form prose with citation footnotes, not a tabular finding list. The renderable bundle:

```ts
interface RenderableRecommendation {
  id: string;
  recommendationNumber: number;
  jurisdiction: 'ON' | 'CA-FED';
  title: string; // decrypted at render-time
  bodyWithMarkers: string; // decrypted; contains [[cite:N]] markers
  citations: ReadonlyArray<RenderableCitation>;
  draftedAt: string;
  submittedAt: string;
  draftedByDisplayName: string;
  responses: ReadonlyArray<RenderableResponse>;
}
interface RenderableCitation {
  position: number;
  statuteCode: string;
  citationText: string; // e.g. 's.9(20)'
  versionDate: string; // ISO date
  bodyText: string; // resolved at render time from clauses.body (or body_summary for restricted)
  bodyHash: string; // hex; what's printed in the footnote provenance
}
```

The render pass:

1. Decrypt title + body + every response's author_role + body (same bounded-plaintext window as the 1.8 photo decrypt, `sodium.memzero` discipline on the buffers; JS strings are kept for the render duration of one request, same documented tradeoff as 1.8).
2. Resolve each citation: join `recommendation_citations` to `clauses` to fetch body text + body_hash. For `third_party_restricted` statutes, use `body_summary` instead of `body` (the structural copyright guard from `packages/legal-corpus`).
3. Render the document in three passes: title page (recommendation number, jurisdiction, draft+submit dates, drafter display name); body (prose with markers expanded inline to superscript reference numbers); footnotes (numbered list, one per citation, format `[N] {citationText} ({versionDate}) — {bodyText}. Provenance: clause hash {bodyHash}`); response appendix (if any responses, render each as a dated block with author role + body); provenance footer on every page.
4. Provenance footer (per ADR-0007 §3.9 simplified pattern — no in-PDF hash placeholder dance): left `Recommendation {recommendationNumber}/{jurisdiction}`; center `page N of M`; right `Chain idx {predictedIdx}`.

**Storage + step-up + TTL: identical to 1.8.** Tigris `exports/<exportId>/recommendation-<exportId>.zip` (the ZIP-bundle decision in §3.9), `ServerSideEncryption: 'AES256'` (per the 1.8 priv-F1 close-out), 30-day TTL via Tigris lifecycle policy, `WORKPLACE_EXPORT_TTL_DAYS` override. The export response returns `{exportId, outputSha256, signatureSha256, byteSize, chainIdx, expiresAt}`.

**Chain anchor:** `recommendation.exported` with `{recommendationId, exportId, outputSha256, signatureSha256, byteSize, citationsHash, signingKeyId}`. The `citationsHash` = sha256(canonical-JSON of the resolved citations array including each citation's `body_hash` from corpus) — this is the binding between the exported PDF and the exact corpus state it was rendered against. A re-seed of the corpus that publishes an amendment will produce a different `citationsHash` on a new export of the same recommendation; the chain row records both.

### 3.9 Signed export format (Ed25519 sidecar in a ZIP bundle; defer embedded PAdES)

**Recommendation: detached Ed25519 signature, packaged with the PDF in a ZIP bundle.**

```
recommendation-<exportId>.zip
├── recommendation-<exportId>.pdf
├── recommendation-<exportId>.pdf.sig          (64 bytes — Ed25519 detached signature of the PDF bytes)
└── manifest.json                              (signing_key_id, signing_key_fingerprint, signed_at,
                                                output_sha256, signature_sha256, jhsc_signature_format_version)
```

**Why sidecar, not embedded PAdES:**

- **`pdfkit` does not natively support PAdES.** PAdES (PDF Advanced Electronic Signatures, ETSI EN 319 142) requires inserting a signature dictionary into the PDF's incremental update region, computing the byte range to be hashed, and writing the CMS/PKCS#7 signature object into the placeholder — all of which are operations `pdfkit`'s streaming API does not expose. Adding a third-party signing library (`node-signpdf`, `@signpdf/signpdf`) introduces a non-trivial dependency surface and a different bundle posture from what 1.8 audited.
- **Ed25519 detached signatures are a primitive `libsodium` already provides** (`crypto_sign_detached`). The 1.7 evidence module already depends on libsodium for sealed-box decrypt; the marginal surface for signing is one function call.
- **ZIP bundle is a recognized envelope format** (every OS handles it, the bytes are deterministic enough to hash, the manifest format is self-documenting). A recipient who wants to verify gets the public key fingerprint from the manifest, fetches the public key from this workplace's signed-export verifier endpoint (1.12 ships a public verification page; 1.9 ships a `GET /api/recommendations/exports/:id/manifest` endpoint that returns the manifest + the historical signing key for that id), and runs a one-line `sodium.crypto_sign_verify_detached(signature, pdfBytes, publicKey)`.
- **Cost of sidecar vs embedded:** the recipient must keep three files together (PDF + sig + manifest). The ZIP bundle is the mitigation — they're shipped as one file. The cost of embedded PAdES is dependency surface + non-streaming render + the bus factor of a third-party signing library. The sidecar trade-off is the right one for 1.9.

**Manifest fields:**

```json
{
  "jhsc_signature_format_version": 1,
  "export_id": "<uuid>",
  "recommendation_id": "<uuid>",
  "signed_at": "<iso8601>",
  "signing_key_id": "<uuid>",
  "signing_key_fingerprint": "<hex>",
  "output_sha256": "<hex>",
  "signature_sha256": "<hex>",
  "signature_algorithm": "Ed25519"
}
```

The manifest is itself non-signed (it's metadata about the signature, not subject to forgery — a tampered manifest just fails verification when the recipient checks the sig against the PDF bytes). The runbook documents the verification recipe.

**PAdES upgrade is a documented 1.12 follow-up.** A future hardening pass can move to embedded signatures (better UX in PDF readers that show a signature panel) without invalidating any sidecar-signed PDF — old exports remain verifiable via the sidecar route, new exports embed.

### 3.10 Step-up posture (60s floor, action='recommendation.export', mirrors 1.8)

Same `checkStepUpFreshness` helper as the 1.8 exports route. Action string: `recommendation.export` for the create path, `recommendation.export.download` for the re-download path. Freshness floor: 60 seconds (matches the 1.7 / 1.8 evidence + export posture). The export route opens the workplace encryption private key (to decrypt body + responses) AND the workplace signing private key — a 5-minute step-up grant from an unrelated action is too generous for the privilege the route exercises.

- Rate limit: 5 exports per hour per user (matches SECURITY.md §4a control 5 + the 1.8 per-actor token bucket). Reuses the existing in-memory bucket pattern; the pg-boss-backed cross-process variant remains a 1.12 follow-up per the 1.8 runbook.
- Body limit: 64 KB (same as 1.8 — the request body is just a recommendation id and an export options object).
- `WWW-Authenticate` header on the 401: `StepUp realm="jhsc", action="recommendation.export", max_age="60"`.
- The download path requires `X-Requested-With: jhsc-web` (same belt-and-suspenders CSRF check as the 1.7 evidence decrypt + 1.8 export download — sec-F2 belt-and-suspenders against same-site phishing tabs).

### 3.11 `export_records` reuse (extend the `kind` enum, do not create a separate table)

**Decision: reuse `export_records`, extend the `kind` CHECK to include `'recommendation_single'`.** A new `recommendation_exports` table would duplicate 80% of the columns (id, requested_by_user_id, requested_at, output_storage_key, output_sha256, byte_size, step_up_jti, audit_idx, expires_at) for marginal cleanliness. The `kind` column is the discriminator; routes filter on it; no schema is conflated.

Migration delta to `export_records`:

- Drop the existing `CHECK (kind in ('single','batch'))` (1.8 named them `inspection_single`-equivalent — verify against the actual 1.8 migration during S1 and rename if necessary).
- Add `CHECK (kind in ('inspection_single','inspection_batch','recommendation_single'))`.
- Make `inspection_ids` nullable (currently `NOT NULL`); the recommendation kind uses a new nullable `recommendation_id uuid` column instead.
- Add `recommendation_id uuid REFERENCES recommendations(id) ON DELETE RESTRICT`, nullable.
- Add `signature_sha256 bytea`, nullable (only populated for `kind='recommendation_single'`).
- Add `signing_key_id uuid REFERENCES workplace_signing_keys(id) ON DELETE RESTRICT`, nullable (only populated for `kind='recommendation_single'`).
- Add `citations_hash bytea`, nullable (only populated for `kind='recommendation_single'`).
- Add a CHECK constraint asserting `kind` and column-nullness alignment: `((kind = 'recommendation_single' AND recommendation_id IS NOT NULL AND signature_sha256 IS NOT NULL AND signing_key_id IS NOT NULL AND citations_hash IS NOT NULL AND inspection_ids IS NULL) OR (kind IN ('inspection_single','inspection_batch') AND inspection_ids IS NOT NULL AND recommendation_id IS NULL))`. The CHECK is the structural enforcement that no row mixes the two families.

The downside is the table grows wider for both inspection and recommendation rows. Acceptable — 4 nullable columns and 1 CHECK is a small cost; the alternative is duplicating the audit-chain + step-up + Tigris + TTL plumbing in a sibling table that would need to be kept aligned by hand on every future export-system change.

### 3.12 1.8 follow-up absorption

The 1.8 runbook (`docs/runbooks/inspections.md` §11) explicitly defers four items to 1.9. All four absorb here:

1. **`inspection_finding.read` audit kind.** Step-up gated `GET /api/inspections/findings/:id` (the route that surfaces decrypted finding text) gets a chain anchor on every read. Payload: `{findingId, inspectionId, readerUserId}`. The S1 migration adds the kind to `AuditEventKind` + `AuditPayload`; the route emits in its existing transaction. Closes the gap noted in the 1.8 runbook between the step-up gate (which is per-request) and the chain (which currently has no per-read anchor).
2. **`inspection.export.downloaded` audit kind.** The 1.8 `GET /api/inspections/exports/:id/download` route currently has no per-download chain anchor (1.8 contract was fixed at six audit kinds; the runbook called it a 1.9 follow-up). Add the kind, emit on every download with `{exportId, downloaderUserId}`. Payload is PI-clean.
3. **`responsible_party_user_id` dual-shape on `inspection_findings`.** 1.8 ships responsible_party as encrypted-string-only; the dual-shape (`user_id` for internal owners, encrypted name for external) was deferred per ADR-0007 §3.6's S5 close-out note. Add the column in migration 0008, plumb the Zod surface in the inspection-finding routes to accept either shape, leave the existing encrypted-string-only rows untouched (they read as `responsible_party_user_id IS NULL + responsible_party_ct IS NOT NULL`). New writes prefer `user_id` for internal owners. This is a small column-add + route-shape change; absorbing in 1.9 is cheaper than spinning a 1.8.1 patch.
4. **`scripts/inspections-signers.ts`** + **`--check-inspections` flag for `audit-log-verify.ts`.** Both are small script deltas. The signers script reconciles `inspection_signatures.signed_by_user_id` UUIDs to display names for the signer-role rotation procedure. The `--check-inspections` flag (documented in `docs/runbooks/inspections.md` §12) scans inspection chain payloads for zero-UUID placeholders, cross-references `inspection.exported` payloads against `export_records.output_sha256`, and cross-references `inspection_finding.promoted` payloads against the bidirectional FK. Absorbing both into S2's audit-kind PR is the cleanest path; the 1.9 surface is the natural moment to extend the verifier.

### 3.13 Slice plan

- **S0 — architect + threat-modeler.** This ADR + a `SECURITY.md` §2.9 "Recommendations" pass with T-R1..T-Rn threats. The threat-modeler runs against the ADR in parallel.
- **S1 — schema + shared-types + migration 0008.** Drizzle schema additions for the five tables (`recommendations`, `recommendation_citations`, `recommendation_responses`, `recommendation_action_item_links`, `workplace_signing_keys`) + the `export_records` extension. `packages/shared-types` additions: `recommendationStatus`, `recommendationJurisdiction`, `recommendationLinkKind`, plus nine `AuditEventKind` additions (`recommendation.created`, `recommendation.submitted`, `recommendation.response_captured`, `recommendation.resolved`, `recommendation.withdrawn`, `recommendation.exported`, `inspection_finding.read`, `inspection.export.downloaded`, `audit.workplace_signing_key.seeded`) + per-kind `AuditPayload` shapes. `recommendation-clock.ts` pure function. `packages/shared-types/src/index.ts:260`'s `evidenceLinkedType` entry for `'recommendation'` is the existing forward seam that this migration's trigger update opens. Trigger updates: `evidence_files_linked_fk_guard` gets a `recommendation` branch (existence-checks `recommendations` table); `action_items_source_fk_guard` gets a `recommendation` branch (existence-checks `recommendations`). Migration 0008's down-migration is the standard "we don't write down-migrations" stance (CLAUDE.md "migrations are append-only" rule). Tests: status-machine refinement coverage, citation Zod validation (corpus-existence + marker-density + dense-positions), append-only response semantics, signing-key seed roundtrip, the `responsible_party_user_id` dual-shape backfill.
- **S2 — routes (recommendations CRUD + submit + response + resolve + withdraw + the 1.8 retrofit audit kinds).** `apps/api/src/routes/recommendations/` with `POST/GET/GET-by-id/PATCH /api/recommendations`, `POST /api/recommendations/:id/submit`, `POST /api/recommendations/:id/responses`, `POST /api/recommendations/:id/resolve`, `POST /api/recommendations/:id/withdraw`. Plus the inspections-side retrofits: `inspection_finding.read` anchor in the existing `GET /api/inspections/findings/:id` route; `inspection.export.downloaded` anchor in the existing `GET /api/inspections/exports/:id/download` route; `responsible_party_user_id` shape in the existing finding-create + finding-patch routes. Recommendations crypto helper in `apps/api/src/recommendations/crypto.ts` (same shape as `apps/api/src/inspections/crypto.ts`). Integration test suite: full lifecycle (draft → submit → response → resolve), withdrawal from each non-resolved state, citation rejection on dangling marker / unreferenced citation / non-corpus triple / retired corpus version, response append-only invariant, the action-item bridge transaction (submit fails → no action item created), the 21-day clock calculation for ON and CA-FED jurisdictions.
- **S3 — web (list, detail, drafting form, CitationRef, response capture, resolution flow).** `apps/web/src/recommendations/` with `/recommendations` list (grouped by status; deadline badge surfacing), `/recommendations/:id` detail (read-only view of submitted/responded/resolved recommendations + the chain receipt panel), `/recommendations/new` and `/recommendations/:id/edit` drafting form (RHF + Zod, autosave to draft on field change, `<CitationRef />` web component integrated, marker-density linter surfaced inline), `/recommendations/:id/respond` response capture sheet, `/recommendations/:id/resolve` resolution flow with action-item move confirmation, `/recommendations/:id/withdraw` withdrawal flow with reason capture. CitationRef component: corpus picker modal scoped to recommendation jurisdiction, inserts `[[cite:N]]` at cursor position, maintains local citation list, surfaces "validate citations" button that runs the same Zod rules client-side before submit. Mobile-primary per CLAUDE.md non-negotiable #9 (390px phone first). Tests: empty state, drafting happy path, citation insertion + linting, response capture, the resolve action-item-move confirmation copy.
- **S4 — PDF export + Ed25519 signing.** `apps/api/src/routes/recommendations/exports.ts` with `POST /api/recommendations/exports`, `GET /api/recommendations/exports/:id/download`, `GET /api/recommendations/exports/:id/manifest`. `apps/api/src/recommendations/pdf-renderer.ts` houses the long-form prose + footnote renderer. `apps/api/src/recommendations/signing.ts` houses the Ed25519 sign + ZIP bundle assembly. The `apps/api/src/pdf-shared/` extraction (font + footer primitives shared with the inspections renderer) ships here. `apps/api/src/recommendations/workplace-signing-key.ts` houses the seal/open/getActive shape (sibling to `apps/api/src/evidence/workplace-key.ts`). Tests: golden-PDF fixture (deterministic when fed fixed bytes + fixed citations + fixed font), signature verification roundtrip, step-up gate, rate-limit enforcement, plaintext-zero assertions, ZIP-bundle byte stability.
- **S5 — independent security + privacy reviewers.** Same pattern as 1.4 / 1.5 / 1.6 / 1.7 / 1.8. Threat model close-out lands the operational findings into `docs/runbooks/recommendations.md`. The runbook also absorbs the 1.8 deferred items' operational guidance (signers script, --check-inspections flag).

## Consequences

### Positive

- **The entire s.9(20) lifecycle is in one chain-anchored substrate.** Draft, submit, response, resolution, withdrawal — five chain anchors, no employer-infrastructure dependency, no paper-to-spreadsheet re-keying. The rep's evidentiary posture six months later is "here is the audit chain; verify it."
- **Citation provenance is structural, not editorial.** The corpus is the only source; markers are validated for density; clause body hashes are anchored in the export. A re-seed of the corpus produces a different `citationsHash` on the next export and the chain records both. There is no "I think this OHSA reference was right at the time" doubt.
- **Signed PDFs are a recipient-verifiable artifact.** A recipient with the workplace public signing key (or with the public verification page that 1.12 ships) can confirm the PDF was produced by this workplace's rep tool and has not been altered. This is a stronger evidentiary claim than the inspections PDF's chain-anchored hash, which only the rep can verify (they need their own audit-chain access).
- **The polymorphic-FK ratchet pattern is closed for `evidence_files`** (the fifth and final accepted `linkedType` ships in this migration: `'recommendation'`). The 1.7 forward seam is fully consumed; the next milestone that wants to link evidence to a new resource type adds a new value to the enum + a new trigger branch + a new route allow-list entry, which is now a documented three-step recipe.
- **The 1.8 deferred items close out cleanly.** Two new audit kinds + one schema dual-shape + two small scripts. Nothing else in the inspections surface needs to change; the 1.8 contract was always going to extend at 1.9.
- **Append-only response capture matches the evidentiary model.** Management's first response and its subsequent amendments are separately recorded; a future arbitration can read what was said when, not just the latest state.

### Negative / accepted tradeoffs

- **The export route opens TWO workplace private keys (encryption + signing).** Same bounded-plaintext discipline as the 1.8 photo decrypt, scaled to two keys. Both are `sodium.memzero`'d immediately after use; both decrypts happen inside the step-up window; the request lifetime is the plaintext lifetime. Documented and accepted.
- **The ZIP bundle is one more layer of complexity for the recipient.** They must extract before viewing the PDF (most OSes auto-extract; this is mild). A future PAdES upgrade reduces this to a single PDF that PDF readers verify natively. Accepted for 1.9.
- **The 21-day clock is jurisdiction-conditional.** ON has a hard deadline; CA-FED is informational. The UI surfaces this distinction explicitly (badge copy differs), but a rep operating in a hybrid jurisdiction (rare; mostly federal aviation/marine/banking) needs to read the badge carefully. Documented in the runbook.
- **`recommendation_responses` is append-only with no edit path.** A typo in a response transcription requires the rep to append a corrected `position=N+1` entry rather than edit `position=N`. This is the right evidentiary stance but it's an operational cost. Documented.
- **The `export_records` table widens for both inspection and recommendation rows.** Four nullable columns + one CHECK is the cost of avoiding a duplicated sibling table. Accepted per §3.11.
- **The `recommendation_number` is per-jurisdiction, not globally monotonic.** Two recommendations submitted on the same day in different jurisdictions get the same year-prefix number with different jurisdiction tags. The UI surfaces "ON-2026-014" and "CA-FED-2026-003" formatted client-side, which is unambiguous, but a casual viewer might miss the jurisdiction tag. Accepted.

### Risks

- **Signing-key compromise is catastrophic for past exports.** A leaked private signing key allows forgery of past-dated PDFs that verify against the workplace public key. Mitigation: the runbook documents the operational response (rotate the key, publish a revocation notice via the public verification page, every export signed under the compromised key is now suspect). The chain row's `signing_key_id` makes "which exports were signed under the compromised key" a one-query answer. The KEK-sealing of the private key is the structural defense; the runbook is the operational defense.
- **Citation Zod validation is the only gate against non-corpus citations.** A bug in the validator or a Zod refinement skip would let an invented citation through. Mitigation: a CI test in `packages/legal-corpus` asserts the validator rejects a known-bad triple; another asserts every fixture's `(statuteCode, citation, version_date)` triple resolves; a third asserts marker-density is enforced for representative bodies. Same test posture as 1.4's corpus tests.
- **Withdrawal chain payload must NOT carry the rep's reason text.** A bug in the route that included `withdrawalReason` in the chain payload would leak PI into the immutable chain. Mitigation: the `AuditPayload` discriminated union in `packages/shared-types/src/index.ts` does not include `reason` on the `recommendation.withdrawn` variant — the typechecker rejects the field at the `append()` call site. Same T-AC9-class mitigation pattern as ADR-0002.
- **Action-item bridge transaction failure mid-submit is fail-closed but visible.** If the action_item insert succeeds and the chain anchor fails (advisory-lock contention, audit_log_pkey collision), the whole transaction rolls back — no orphan action_item, no orphan link row, recommendation stays in `draft`. The rep retries. Same posture as the 1.8 export transaction.
- **PDF render with large response counts (>20 responses) could exceed reasonable rendering time.** The 21-day clock typically produces 1–3 responses; >20 is a pathological scenario (an amendment war between rep and management). Mitigation: a soft cap of 50 responses per recommendation, enforced at the route layer with 422 `response_cap_exceeded`. The cap is configurable; the rationale is documented.

## Compliance check

- **#2 chain-of-custody.** Every recommendation state transition emits a chain anchor: `recommendation.created` (on draft create), `recommendation.submitted`, `recommendation.response_captured` (per response), `recommendation.resolved`, `recommendation.withdrawn`, `recommendation.exported`. The linked action item's `action_item.created` + `action_item.moved` anchors fire alongside in the same transactions. Six recommendation-specific kinds + three retrofitted into the 1.8 surface = nine new `AuditEventKind` additions.
- **#4 privacy-by-default.** `title`, `body`, response `author_role`, response `body`, withdrawal `reason` are all envelope-encrypted via `@jhsc/crypto`. The DB sees ciphertext; plaintext exists only inside route handlers for the duration of one request. Audit payloads carry IDs + counts + hashes only — never PI.
- **#5 legal corpus.** Every citation is validated against the live `legal_clauses` table at submit time; non-corpus triples are rejected with 422. Marker density is enforced both client-side (linter in CitationRef) and server-side (Zod refinement). The export PDF's footnotes reference clauses by `(statuteCode, citation, version_date, body_hash)` — the body_hash is the structural proof the rendered text came from the corpus row in effect at submit time.
- **#7 rights-protective UI.** The drafting form copy never discourages the recommendation. The withdrawal flow does not editorialize ("Are you sure you want to give up on this recommendation?" is banned copy); the confirm reads "Withdraw recommendation. The linked action item will be archived. This action is recorded in the audit chain." Status-machine transitions are framed as record-keeping, not advocacy.
- **#8 no automated regulator submission.** The `submitted` status means "delivered to the employer co-chair," not to MLITSD or ESDC. There is no API surface that transports the PDF anywhere external. The route copy + runbook + UI all say this in the same words.
- **#12 action items are first-class.** The recommendation's action item is a real `action_items` row with its own lifecycle, not a sub-concept. The link table is the bridge, not the substitute. Resolving the recommendation triggers a `action_item.moved` event with its own chain anchor.
- **#16 step-up + audit on every export.** PDF export gates at `recommendation.export` with 60s freshness; emits `recommendation.exported` with `output_sha256 + signature_sha256 + citations_hash + signing_key_id`. The retrofitted `inspection.export.downloaded` audit kind closes the 1.8 download-anchor gap.

## Follow-ups

- [ ] Threat-modeler: append `SECURITY.md` §2.9 "Recommendations" with T-R1..T-Rn threats + mitigations (signing-key compromise, citation invention, response-amendment forgery, marker-density bypass, withdrawal-reason chain leak, jurisdiction confusion).
- [ ] S1: shared-types + schema + migration 0008 + the two trigger ratchets (`evidence_files_linked_fk_guard` and `action_items_source_fk_guard` both get the `recommendation` branch) + the `responsible_party_user_id` dual-shape column.
- [ ] S2: recommendations crypto helper + seven recommendation routes + the three 1.8 retrofits (finding-read anchor, export-download anchor, responsible-party dual-shape) + `scripts/inspections-signers.ts` + `--check-inspections` flag on `audit-log-verify.ts` + integration tests.
- [ ] S3: web list + detail + drafting form + CitationRef component + response capture + resolution flow + withdrawal flow. Print stylesheet for the recommendation detail view.
- [ ] S4: recommendation PDF export route + long-form prose renderer + footnote layout + Ed25519 signing + ZIP bundle + manifest endpoint + the `pdf-shared` extraction + workplace-signing-key seal/open helper + golden-PDF tests + signature verification roundtrip.
- [ ] S5: security + privacy reviewers.
- [ ] Runbook: `docs/runbooks/recommendations.md` covering the drafting workflow (autosave, citation insertion, marker-density linting), the submit transaction (what's transactional and what fails the submit), the 21-day clock operationally (when to escalate, what "responded on day N" means evidentially), the response capture flow (append-only, why a typo means a new row), the resolution flow (action-item move, when to use `resolve` vs `withdraw`), the signed-export operations (download, verify, ZIP-bundle handling, signature-verification recipe for recipients), the workplace signing key (where it lives, how it's rotated in 1.12), the workplace-policy-citation stance (free body text, never a corpus citation), the absorption of 1.8 follow-ups (signers script usage, `--check-inspections` flag invocation), the "what 1.10 (offline sync) needs to absorb" stub.
- [ ] **1.10 (offline-first sync) absorbs:** offline drafting queue (the drafting form is the obvious offline candidate — long-form text editing on a phone in a warehouse with patchy WiFi), conflict resolution if two devices edit the same draft, citation picker offline behavior (the corpus is small enough to ship in IndexedDB; offline citation insertion is a 1.10 deliverable), submit + sign flow remains online-only (signing requires the workplace private key which lives on the API).
- [ ] **1.11 (Excel import) absorbs:** historical-recommendation import from prior minutes spreadsheets (the existing minutes carry "Notice of Recommendation" entries with response transcriptions; the import path lands them as `status='resolved'` with the response transcription as a single `recommendation_responses` row at `position=1`).
- [ ] **1.12 (hardening) absorbs:** workplace signing-key rotation procedure + public verification page + retired-key verification path; PAdES embedded signature upgrade (sidecar exports remain verifiable; new exports embed); `recommendation_redactions` table for PIPEDA P9 access-and-correction requests (the body is encrypted but the chain payload is immutable — a redaction surface is the right shape, same as the deferred `evidence_redactions` / `inspection_finding_redactions` tables); pg-boss-backed cross-process export rate limiter.
- [ ] **Release 2 absorbs:** recommendation template library (a rep authors common recommendation patterns once — repetitive-strain accommodation, lockout-procedure update, PPE specification — and instantiates them with workplace-specific details; templates are not corpus entries, they are workplace-owned authoring helpers); the `'replaces'` link kind UI (a recommendation that supersedes a prior hazard-derived action item).
- [ ] **Release 3 absorbs:** Adversarial Lens UI (per CLAUDE.md "Signature Interactions" — "How will management respond?" generates likely counter-arguments side-by-side with rebuttal points; this is the milestone 3.2 deliverable per ROADMAP); E2EE messaging surface for rep-to-rep collaboration on draft recommendations (multi-rep drafting is explicitly out of scope for 1.9 — single-tenant single-rep authoring is the 1.9 scope).
- [ ] `.context/decisions.md` entry referencing this ADR.
