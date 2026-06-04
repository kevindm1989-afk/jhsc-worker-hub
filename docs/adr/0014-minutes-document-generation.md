# ADR-0014: Minutes Document Generation

Status: Proposed, Milestone 2.3
Date: 2026-06-03
Authors: codifies Milestone 2.3 architect-phase decisions; pairs with `SECURITY.md` §2.15 (forthcoming, threat-modeler agent in parallel) and `docs/runbooks/minutes-documents.md` (forthcoming, S5).

## Context

M2.1 (ADR-0012, PR #31, commit `51f317a`) shipped the meeting lifecycle substrate — seven new tables, the 4-signer counter-sign workflow, the live/finalized snapshot two-state machine on `meeting_action_item_state`, and the eleven (plus two TM-fold) chain kinds for `meeting.*`. M2.2 (ADR-0013, PR #32, commit `5a5e0df`) shipped in-meeting action-item management — the `action_item_closures` JHSC counter-sign attestation table, four new chain kinds, the live metrics endpoint, the cross-meeting visibility surfaces. The full lifecycle is in place: `scheduled → in_progress → adjourned → pending_finalization → finalized`. Closure verification is a state transition stronger than a status PATCH, anchored at the workplace-key layer. The metrics dashboard recomputes live during the meeting and crystallises into the `meeting.adjourned` chain payload at adjournment.

M2.3 is the export. ROADMAP.md §"Milestone 2.3" (lines 207-215) enumerates seven scope lines: PDF export matching the Excel file's print layout; Source Serif 4 evidence-grade formatting; all sections rendered; signatures embedded; document hash + audit chain anchor at foot; distribution tracking (who got the minutes); retention statement (2 years per OHSA). The "2.3 absorbs" follow-up from ADR-0012 line 645 named it concretely: the PDF generator renders the `finalized` snapshot from `meeting_action_item_state` + a chain receipt panel + the 4 signature renderings + distribution tracking, using Source Serif 4 per the existing `pdf-shared` extraction from ADR-0008, with the same step-up + audit + document-hash discipline per non-negotiable #16. ADR-0013 line 384 added the per-closure-attestation render (closure metadata + workplace-key signature verification stamp + optional evidence link) + the rendered cross-anchor history per meeting.

Three structural facts shape M2.3:

1. **This is the canonical instance of non-negotiable #16.** Inspections (1.8) and recommendations (1.9) ship step-up + audit + document-hash on export and they are the precedents. M2.3 is where the rep produces the artifact a hostile arbitrator reads as "this is what the JHSC said on date X." Every prior milestone leads here. The bar is the highest: the PDF is evidentiary; the chain anchor is non-negotiable; the document hash is the bind; distribution tracking is the post-handoff record of who saw it.
2. **This is the first export whose data substrate is decrypt-on-server at non-trivial scale.** ADR-0008 §3.7 established the workplace-private-key-in-bounded-window posture for recommendation exports (the body + responses get decrypted server-side under the workplace KEK, rendered into the PDF, then `sodium.memzero`'d). M2.3 extends that surface to four envelope-encrypted columns per meeting (notes on `meetings`, notes on `meeting_sections`, attendee display names on `meeting_attendance`, signer display names on `meeting_signatures`) plus the closure reasons on `action_item_closures` plus the action-item summaries that already have a `safeSummary` decrypt path. The render is a fan-out over potentially dozens of envelope-encrypted rows; the bounded-plaintext window discipline carries forward.
3. **The PDF is a snapshot of the finalize-time state, not the live state.** The meeting transitions to `finalized` when all 4 signatures land; from that moment forward the rendered PDF reads from the `meeting_action_item_state` finalized snapshot rows + the closure rows that were present at finalize time. A post-finalization action item move does NOT change what the PDF renders; re-generating the PDF after a typo fix produces a new document hash on the same chain (per §3.5 re-generation discipline). The PDF is the canonical post-finalize artifact; the live action items continue their lifecycle outside it.

`apps/web/src/views/meeting-finalization-view.tsx` (M2.1 surface) is the natural prior-art landing — its `data-print="evidentiary"` / `data-print="hide"` discipline (per `apps/web/src/index.css`'s `@media print` block) is the canonical pattern this milestone extends. `apps/web/src/views/meeting-detail-view.tsx` (M2.2 surface) already renders the per-section action-item cards + move history + chip-bar — M2.3 reads the same data but in a print-stylesheet-canonical layout. `apps/api/src/inspections/pdf-renderer.ts` is the closest size + shape precedent (server-side pdfkit, generic metadata, no JS surface, bounded-plaintext window). `apps/api/src/recommendations/pdf-renderer.ts` is the long-form-prose precedent. `apps/api/src/routes/inspections/exports.ts` is the step-up + rate-limit + Tigris + chain-anchor pipeline that M2.3 mirrors. The `apps/api/src/pdf-shared/` extraction promised in ADR-0008 §S4 has NOT YET landed (verified empty); M2.3 ships it as a real package extraction with the inspections + recommendations renderers refactored to consume it (a small migration, no behavior change). `apps/api/src/db/schema.ts:808-846` (the `exportRecords` table extended by ADR-0008 §3.11 with `kind='recommendation_single'`) is the substrate this milestone extends a third time. `packages/legal-corpus/seed/ohsa.toml` carries `s.9(28)` (already seeded for M2.1 quorum work) and equivalents; the retention statement citations land in §3.4.

The 4-6 week real-world-use window between M2.2 deploy and M2.3 start informs the design — the rep will have run at least one full native quarterly meeting through finalization before this milestone. The cognitive switching cost from the rep's prior Excel-print workflow to the M2.3 PDF should be near zero: the layout, the section order, the action-item table shape, the closure-attestation block, the 4-signature panel, and the chain-receipt + retention footer are the same surfaces the rep already reads in the on-screen meeting-detail view.

## Decision

Land two new tables (`minutes_documents` — append-only one-row-per-generation record; `minutes_distributions` — append-only one-row-per-distribution record), zero new columns on existing tables, four new API routes (`POST /api/meetings/:id/minutes-documents` generates a new PDF; `GET /api/meetings/:id/minutes-documents` lists the prior generations + their distributions; `GET /api/minutes-documents/:id/download` re-fetches stored bytes with step-up + integrity recheck; `POST /api/minutes-documents/:id/distributions` records a distribution event), four new `AuditEventKind` values (`minutes_document.generated`, `minutes_document.regenerated`, `minutes_document.downloaded`, `minutes_document.distributed`), one new web view `apps/web/src/views/meeting-minutes-pdf-view.tsx` plus a sticky CTA on `meeting-finalization-view.tsx` and `meeting-detail-view.tsx` (`finalized` state) that opens it. The `apps/api/src/pdf-shared/` extraction (font registration, header/footer primitives, mime-type allow-list, the chain-receipt + retention-statement footer primitives, the workplace-decryption-key bounded-window helpers) ships in S2 and the inspections + recommendations renderers refactor to consume it in the same slice with byte-for-byte golden-PDF fixture invariance enforced. The server-side render path uses pdfkit per the established ADR-0007 / ADR-0008 stance (NOT puppeteer/Chromium — same T-I25 anti-JS posture). Source Serif 4 for narrative + section bodies, JetBrains Mono for hashes / IDs / chain-receipt + document-hash footer, Inter for headers/labels (font fallback to PDF-native if `PDF_FONT_DIR` is unset). Page size is `WORKPLACE.documentPageSize` per `config/workplace.ts` (new field; default `'letter'` per the Ontario default; valid values `'letter' | 'a4'`).

The PDF is a snapshot of the finalize-time state. The route requires `meetings.status='finalized'` (route returns 422 `meeting_not_finalized` on `scheduled`/`in_progress`/`adjourned`/`pending_finalization`). The data substrate is the M2.1 `meeting_action_item_state.snapshot_kind='finalized'` rows joined to the live `action_items` for type/risk/sequence_number context + the M2.2 `action_item_closures` rows (joined by `(meeting_id, action_item_id)` where `closed_this_meeting` is the rendered grouping) + the M2.1 `meeting_signatures` rows for the 4-signer panel + the `meeting_inspection_review` rows for the inspections-review section + the `recommendations WHERE meeting_id = $1` rows for the recommendations-drafted section. Decryption runs server-side inside a bounded window using the workplace KEK (per the established ADR-0008 §3.7 + ADR-0007 §3.6 pattern); `sodium.memzero` wipes every plaintext buffer before the chain anchor fires. Re-generation is a NEW row in `minutes_documents` with a NEW `document_hash` (per §3.5 — append-only); the prior row stays in Tigris; the web UI surfaces both. Distribution tracking is a NEW row in `minutes_distributions` per send event; the chain anchors with `recipient_role` + `recipient_hash` (SHA-256 of the canonical-JSON `{role, displayName}` envelope) + `sent_method` — NEVER the recipient's plaintext display name (T-AC9-class invariant). The PDF itself is not sent by the app (non-negotiable #6 — no employer infrastructure dependencies; the rep distributes out-of-band); the row records that the rep distributed it.

Step-up gates every write per non-negotiable #16. Generation requires step-up (`action='minutes_document.generate'`, 60s floor). Download requires step-up (`action='minutes_document.download'`). Distribution requires step-up (`action='minutes_document.distribute'`). Reads (`GET /api/meetings/:id/minutes-documents` for the list, `GET /api/minutes-documents/:id` for the metadata envelope) do not require step-up — they return metadata only (document hash, generated_at, distribution list with recipient_hash + method; no recipient plaintext name, no document bytes). The PDF format is versioned (`format_version='v1'` per `MinutesDocumentFormatVersion` enum in `shared-types`); a meeting's first generation pins the version; re-generations preserve the version unless the rep explicitly opts into upgrading to `v2+` when a future milestone ships it (the version field is the structural seam parallel to non-negotiable #13's template-version pin). Per-page footer carries the meeting metadata + page X of Y + a truncated document hash; the canonical full document hash + chain receipt + retention statement live in a final-page receipt panel.

### 3.1 New tables + posture justification

Two new tables land in `apps/api/src/db/schema.ts` + `migrations/0013_minutes_documents.sql` (next-in-sequence per the CLAUDE.md append-only rule). Zero columns added to existing tables. The `exportRecords` table from ADR-0008 §3.11 is deliberately NOT extended a third time — see §3.1.3 for the justification.

#### 3.1.1 `minutes_documents` — append-only per-generation record

```
minutes_documents (
  id                          uuid primary key default gen_random_uuid(),
  meeting_id                  uuid not null references meetings(id)
                                on delete restrict on update restrict,
  generated_at                timestamptz not null default now(),
  generated_by_actor_id       uuid not null references users(id)
                                on delete restrict on update restrict,
  generation_kind             text not null
                                check (generation_kind in ('initial','regeneration')),
  prior_document_id           uuid references minutes_documents(id)
                                on delete restrict on update restrict,
                                -- nullable: NULL for initial; FK to the prior row for regenerations
  format_version              text not null
                                check (format_version in ('v1')),
  page_size                   text not null
                                check (page_size in ('letter','a4')),
  document_hash               bytea not null,                       -- SHA-256 of the rendered PDF bytes
  document_size_bytes         bigint not null check (document_size_bytes > 0),
  storage_key                 text not null,                        -- Tigris object key
  step_up_jti                 text not null,                        -- the generator's step-up grant
  signing_key_id              uuid not null references workplace_signing_keys(id)
                                on delete restrict on update restrict,
  attestation_signed_ct       bytea not null,                       -- Ed25519 sig over canonical row JSON
  audit_idx                   bigint not null references audit_log(idx)
                                on delete restrict on update restrict,
  created_at                  timestamptz not null default now()
);
```

Indexes: `minutes_documents_meeting_idx` on `meeting_id` (the list-prior-generations query); `minutes_documents_document_hash_unique` UNIQUE on `document_hash` (per §3.10 — a regeneration with byte-identical output is idempotent at the hash layer; the route's pre-INSERT check returns the existing row on hash collision rather than creating a duplicate); `minutes_documents_audit_idx_unique` UNIQUE on `audit_idx` per the per-entity audit-anchor invariant carried forward from ADR-0007 §3.6 / ADR-0008 §3.2 / ADR-0012 §3.1 / ADR-0013 §3.1; `minutes_documents_storage_key_unique` UNIQUE on `storage_key` (one Tigris object per row); `minutes_documents_meeting_generated_at_idx` on `(meeting_id, generated_at DESC)` for the chronological list rendering. The CHECK `generation_kind='regeneration' IMPLIES prior_document_id IS NOT NULL` is enforced via SQL CHECK constraint in the migration; the inverse (`generation_kind='initial' IMPLIES prior_document_id IS NULL`) is also enforced. No UPDATE path on the table — append-only per the established ADR-0007 §3.6 / ADR-0012 §3.1 / ADR-0013 §3.1 pattern (`meeting_signatures`, `action_item_closures` precedent); a correction is a regeneration which inserts a new row.

The `attestation_signed_ct` column carries the workplace signing-key's Ed25519 detached signature over canonical-JSON of the row (excluding the signature itself, of course) — the same TM-fold-4 pattern from ADR-0012 §3.1 (`meeting_signatures.attestation_signed_ct`) and ADR-0013 §3.1 (`action_item_closures.attestation_signed_ct`). This makes the row tamper-evident at the workplace-key layer in addition to chain-anchoring; defense in depth against a DB-level attacker who goes around the chain.

#### 3.1.2 `minutes_distributions` — append-only per-distribution record

```
minutes_distributions (
  id                          uuid primary key default gen_random_uuid(),
  document_id                 uuid not null references minutes_documents(id)
                                on delete restrict on update restrict,
  distributed_at              timestamptz not null default now(),
  distributed_by_actor_id     uuid not null references users(id)
                                on delete restrict on update restrict,
  recipient_role              text not null
                                check (recipient_role in
                                  ('mgmt_co_chair','worker_rep','mgmt_rep',
                                   'union_local','warehouse_mgr','plant_mgr',
                                   'mlitsd_inspector','legal_counsel','other')),
  recipient_display_name_ct   bytea not null,                       -- envelope-encrypted (#1 + #4)
  recipient_display_name_dek_ct bytea not null,
  recipient_hash              bytea not null,                       -- SHA-256 over canonical
                                                                    -- {role, displayName} envelope
  sent_method                 text not null
                                check (sent_method in
                                  ('email_off_app','printed_handoff','portal_upload',
                                   'mail','in_person','other')),
  sent_at                     timestamptz not null,                 -- the rep's recorded send time
  notes_envelope_ct           bytea,                                -- optional rep note about delivery
  notes_envelope_dek_ct       bytea,
  step_up_jti                 text not null,
  audit_idx                   bigint not null references audit_log(idx)
                                on delete restrict on update restrict,
  created_at                  timestamptz not null default now()
);
```

Indexes: `minutes_distributions_document_idx` on `document_id` (the per-document distribution list); `minutes_distributions_audit_idx_unique` UNIQUE on `audit_idx`; `minutes_distributions_recipient_role_idx` on `(document_id, recipient_role)` for the "did we send this to mgmt co-chair?" lookup; `minutes_distributions_recipient_hash_unique` UNIQUE on `(document_id, recipient_hash)` so the SAME recipient cannot be recorded twice for the same document (the rep distributing again to the same recipient writes a NEW row for a NEW document — re-generation produces a new `document_id` per §3.5; same recipient on the same document is captured as one row + a `notes_envelope` describing repeat handoffs if needed). Pair-NULL CHECK on `(notes_envelope_ct, notes_envelope_dek_ct)` per the established pattern. Append-only — no UPDATE path on the table; a correction is a new row + a note on the prior row's `recipient_hash` referenced by clientside reconciliation. The `recipient_display_name_ct` envelope encrypts the recipient's display name under the workplace public key (sealed-box; same posture as `meeting_attendance.display_name_ct` and `meeting_signatures.signer_display_name_ct`); the `recipient_hash` is the chain-payload-safe identifier (per §3.6 — names never in chain payloads, hashes are).

#### 3.1.3 Why a separate table family instead of extending `export_records`

ADR-0008 §3.11 extended `export_records` to absorb `kind='recommendation_single'` rather than create a sibling table. M2.3 deliberately diverges from that posture; three trade-offs justify the new family:

1. **Distribution tracking is a first-class entity, not a metadata bag on an export row.** The export-record pattern (`export_records` from 1.8 / 1.9) carries `requested_by_user_id`, `output_sha256`, `byte_size`, `storage_key`, `step_up_jti`, `expires_at` — one row per render. Distribution is a separate event with its own actor, its own recipient, its own method, its own timestamp; one render can have many distributions, and the distribution table is the per-event evidentiary record. Cramming distributions into a JSON column on `export_records` would defeat the per-row chain-anchor + workplace-key-signature posture used everywhere else in the codebase.
2. **The minutes document has format versioning (per §3.12 / non-negotiable #13 parallel).** A v1 minutes PDF and a v2 minutes PDF are rendered by different pipelines; the format_version is structurally significant and pins to the row. Extending `export_records` with a `format_version` column that's nullable-except-for-kind='minutes' is the kind of conflation ADR-0008 §3.7 explicitly avoided with the workplace_signing_keys table split. The minutes table carries its own scope cleanly.
3. **Re-generation discipline differs from re-export.** Inspection exports (1.8) and recommendation exports (1.9) treat re-export as a new `export_records` row with a new step-up — same posture. M2.3 re-generation additionally writes a `prior_document_id` FK (per §3.5) so the chain of regenerations is queryable as a list, not just a temporal-ordering inference from `requested_at`. The `prior_document_id` FK pattern doesn't belong on `export_records` (the 1.8/1.9 surfaces have no concept of "this export supersedes that one"); putting it there would conflate scopes.

The cost is a new migration + two new tables. Acceptable — append-only tables are cheap; the alternative is overloading the export_records table with a fourth `kind` discriminator + nullable distribution-tracking columns that 1.8/1.9 rows would carry as forever-NULL. The export_records pattern stays scoped to inspections + recommendations; M2.3 takes its own table family.

#### 3.1.4 Cascade rules

- DELETE `meetings` was already RESTRICTED at the route layer to `status='archived'` per ADR-0012 §3.1. M2.3 strengthens this: a meeting with ANY `minutes_documents` row is RESTRICTED from delete (the FK `minutes_documents.meeting_id ON DELETE RESTRICT` is the structural backstop). Operationally a finalized meeting with a generated minutes document is permanently RESTRICTED from delete; the chain row anchored on the document means the meeting itself is load-bearing for the document's evidentiary record.
- DELETE `minutes_documents` is RESTRICTED if any `minutes_distributions` references it (`ON DELETE RESTRICT`). A distribution record bound to a document depends on the document for its evidentiary chain.
- DELETE on `minutes_documents` is impossible from any route in 2.3 — the table is append-only; the closest operational primitive is "regeneration" which inserts a new row and leaves the prior. The 1.12 forensic-procedure runbook (per ADR-0011 §3.7) is the only path that would touch the table, and it's the same posture as every other audit-anchored append-only table.
- DELETE `minutes_distributions` is impossible from any route. Same posture.

#### 3.1.5 Migration file path

`migrations/0013_minutes_documents.sql`. Append-only per the CLAUDE.md migration rule. Down-migration: standard "we don't ship down migrations" stance.

### 3.2 PDF render pipeline

#### 3.2.1 Server-side, pdfkit, NOT puppeteer

The render runs server-side in the Hono+Bun API process via the established `pdfkit` library per the ADR-0007 §3.9 + ADR-0008 §3.8 stance. Three reasons (carrying forward the ADR-0007 analysis):

1. **No headless browser surface.** Puppeteer/Chromium has a vastly larger attack surface than pdfkit — the chrome process is a full sandboxed browser; the bundle size in the Fly Machine is ~150MB+ vs pdfkit's ~2MB. The T-I25 anti-JS posture (no `/JS`, `/JavaScript`, `/AA`, `/OpenAction` in the rendered PDF) is the established invariant; pdfkit's API does not provide any path to those PDF features, while a chrome renderer would have to be carefully configured to avoid them.
2. **Streaming render lets the caller free per-row plaintext incrementally.** The M2.3 render walks ~50 action item snapshot rows + ~10 attendance rows + 4 signature rows + N section notes rows; each carries decrypted plaintext that must memzero before the next read. pdfkit's streaming API supports this; @react-pdf/renderer builds an in-memory virtual tree that retains every buffer until render.
3. **Existing precedent.** The inspection (1.8) and recommendation (1.9) renderers both use pdfkit; M2.3 is the third such renderer + the trigger for the `pdf-shared` extraction. Switching to a different renderer for M2.3 would create three-renderer divergence; consistency is the cheaper choice.

#### 3.2.2 The `pdf-shared` extraction

ADR-0008 §3.8 promised a `apps/api/src/pdf-shared/` extraction for font + footer primitives shared between the inspection and recommendation renderers but the extraction never landed (verified empty in the repo). M2.3's S2 slice ships it as a real package extraction. Surface:

- `apps/api/src/pdf-shared/fonts.ts` — Source Serif 4 + JetBrains Mono + Inter font registration with the `PDF_FONT_DIR` discovery + fallback discipline from the inspection renderer.
- `apps/api/src/pdf-shared/footer.ts` — the per-page provenance footer primitive: left `Title`, center `page N of M`, right `Chain idx <N>` + truncated document hash (per §3.3.5 page footer shape).
- `apps/api/src/pdf-shared/receipt-panel.ts` — the canonical final-page chain receipt panel + retention statement footer per §3.3.7 + §3.4.
- `apps/api/src/pdf-shared/bounded-decrypt.ts` — the bounded-plaintext-window helper that opens the workplace private key, performs N envelope decrypts, and memzeros all buffers in a `finally` block. Same shape as the ad-hoc helpers in `apps/api/src/routes/inspections/exports.ts` (the `resolveInspection` function) and `apps/api/src/routes/recommendations/exports.ts`; the M2.3 extraction is the canonical version.
- `apps/api/src/pdf-shared/page-size.ts` — the `WorkplaceConfig.documentPageSize` resolver (Letter vs A4) + the corresponding pdfkit page dimensions.
- `apps/api/src/pdf-shared/metadata.ts` — the generic `/Title`, `/Author`, `/Producer` metadata posture per T-I28 + CLAUDE.md non-negotiable #1: never set `/Subject` or `/Keywords`; never embed workplace name in metadata.

The inspections + recommendations renderers refactor in the same slice to consume `pdf-shared`. The S2 invariance gate is a golden-PDF fixture for each renderer: byte-for-byte identical output before vs. after the refactor for the canonical fixture inputs. The refactor introduces no behavior change; it's a code-organization extraction.

#### 3.2.3 Typography

Source Serif 4 for narrative body, section notes, closure reasons, attendance display, and signature display per CLAUDE.md design tokens. JetBrains Mono for chain receipt panel content (audit idx, document hash, distribution recipient hash, signing key fingerprint, action item sequence numbers). Inter for headers, labels, and table column headers. Fallback: if `PDF_FONT_DIR` is unset, pdfkit defaults to its built-in Helvetica/Courier-equivalent fonts (visual regression noted; the runbook flags `PDF_FONT_DIR` as a required deploy env var).

#### 3.2.4 Page size

`WorkplaceConfig.documentPageSize` is a new field added to `config/workplace.ts` in S1. Type: `'letter' | 'a4'`. Default: `'letter'` (the Ontario default per the rep's existing workflow). The env var: `WORKPLACE_DOCUMENT_PAGE_SIZE`. The runbook documents that a workplace switching jurisdictions or distributing primarily to a federal CLC jurisdiction may prefer `a4`. The page size is pinned per-document at generation time (`minutes_documents.page_size`); a re-generation under a different config value will produce a NEW row with the NEW size + a new document hash (per §3.5 — this is one of the inputs that breaks idempotency).

#### 3.2.5 The full template (rendered in this order)

1. **Cover page.** Workplace JHSC meeting minutes title (the workplace's display name pulled from `config/workplace.ts` at render time — surfacing the configured name is the rep's intent, not a #1 violation since the workplace identity is config-loaded). Meeting date (humanised). Meeting status badge (`finalized` always at this point). Meeting location. Scheduled vs actual duration. Quorum compliance summary (computed from M2.1 `computeQuorum`). Page count anchor "Minutes — N pages." Format version + page size + generated_at + generated_by display name (decrypted server-side from the M2.1 `meeting_attendance` row for the worker_co_chair role).

2. **Attendance roster.** Table: `Role | Party | Display Name | Status | Arrival | Departure`. Display names DECRYPTED server-side under the workplace KEK at render time using the bounded-window helper from `pdf-shared`. Roles render with their `displayRoleLabel` from `WORKPLACE.minutesSignerRoles` (per the M2.1 ADR-0012 §3.9 config extension). Status (`present` / `regrets` / `absent_unexcused` / `late_arrival` / `early_departure`) renders with neutral framing per the T-ML2 mitigation — `regrets` and `absent_unexcused` render distinctly because the worker-side internal record retains the distinction (per ADR-0012 §3.5 + T-ML2 design — the internal-vs-external roster split is a UI affordance; the canonical PDF is the internal version since this is the worker's evidentiary copy).

3. **Sections rendered in `order_idx` order** per the M2.1 agenda template snapshot. Each section block: section header (`displayRoleLabel` mapped from `section_type`) → started_at / ended_at timestamps → notes (decrypted from `meeting_sections.notes_envelope_ct` if present; rendered in Source Serif 4 prose) → structured sub-content per section type:
   - `roll_call_quorum` — the quorum compliance verdict + the legal corpus rule citation (read from `packages/legal-corpus` per non-negotiable #5).
   - `inspections_review` — table of `meeting_inspection_review` rows with `inspection_id` + `outcome` + decrypted notes.
   - `old_business` / `new_business` / `recommendation` — per-section action items table per §3.2.6.
   - `recommendations` — list of recommendations drafted in this meeting (`recommendations WHERE meeting_id=$1`) with title + draft date + status + citation count.
   - `adjournment` — the chain-anchored metrics dict from the M2.1 `meeting.adjourned` payload (immutable; read from the audit chain row, not recomputed).

4. **Action items snapshot table** (per-section, with summary across sections). Reads from `meeting_action_item_state WHERE meeting_id=$1 AND snapshot_kind='finalized'` joined to `action_items` for type / risk / sequence_number. Columns: `Seq #`, `Type`, `Risk`, `Summary` (decrypted), `Status` (snapshot), `Section` (snapshot), `Assignee` (decrypted from `snapshot_assignee_ct`), `Target Date`, `Action Flag`. Items closed in this meeting (joined to `action_item_closures WHERE meeting_id=$1`) carry a closure annotation block: closer display name + counter-signer display name + closed_at + closure reason (decrypted) + evidence link + signing key fingerprint + workplace-key signature verification stamp. `selfAttestation` rows render the M2.2 §3.5 neutral banner.

5. **Recommendations drafted.** Per-recommendation block with title, status, draft + submitted timestamps, citation count, link to the recommendation's own signed PDF (per ADR-0008) by `recommendation_id`.

6. **Move history this meeting.** Chronological list of moves from `action_item_moves WHERE meeting_id=$1` per ADR-0013 §3.6. Each row: action item sequence number → from_section → to_section → moved_by display name (decrypted) → timestamp.

7. **4-signature panel.** Per-signer block (worker_co_chair, mgmt_co_chair, warehouse_mgr, plant_mgr in the M2.1 fixed enum order). Each block: role label (from `WORKPLACE.minutesSignerRoles`) + signer display name (decrypted) + signed_at + signed_method + (for in_app_passkey) step_up_jti truncated + (for paper_attestation / email_attestation) evidence link + chain_of_custody note (decrypted, from TM-fold-4 ADR-0012 §3.1) + signing key fingerprint + workplace-key attestation signature verification stamp.

8. **Closure-verification attestation appendix.** Per closure (one per `action_item_closures` row scoped to this meeting). Block: action item sequence number + summary + closer display name + counter-signer display name + closed_at + counter_signed_at + closure reason (decrypted) + evidence link (if present) + signing key fingerprint + Ed25519 attestation signature truncated.

9. **Chain receipt panel** (final page; per §3.3.7). Document hash (full, JetBrains Mono) + audit chain idx of `minutes_document.generated` + canonical-JSON of the payload (truncated) + signing key id + signing key fingerprint + workplace-key signature truncated + generation timestamp + generator display name.

10. **Retention statement footer** (final page; per §3.4). Jurisdiction-aware text + corpus citation.

11. **Per-page footer** (every page): left `Meeting <YYYY-MM-DD> · <location>`; center `page N of M`; right `doc <document_hash_truncated_to_8>...`.

#### 3.2.6 Action items table shape (per section)

Replicates the rep's Excel print layout for cognitive zero-cost transition. Columns + widths tuned for Letter portrait: `#` (Seq) ~6%, `Type` ~6%, `Risk` ~6%, `Description` (summary; truncated to ~2 lines with continuation marker) ~30%, `Status` ~10%, `Assignee` ~14%, `Target Date` ~10%, `Flag` ~6%, `Closure` ~12%. The closure column carries a checkmark + counter-signer initials when `action_item_closures` rows match `(meeting_id, action_item_id)`; blank otherwise. Status color is paired with a status icon per CLAUDE.md "no information by color alone." Action Flag uses the 🟠 / ✓ / ⬇ emoji vocabulary per the established CLAUDE.md exception ("Action Flag indicators in minutes use emoji intentionally").

### 3.3 Distribution tracking

ROADMAP.md line 214 calls for "Distribution tracking (who got the minutes)." The pattern:

#### 3.3.1 The app records the distribution; the app does not send it

Per non-negotiable #6 — no employer infrastructure dependencies. The rep distributes the PDF out-of-band (downloads it, emails it from their own account, prints it for handoff, mails it, uploads it to a portal the rep accesses externally). The app records the distribution event in `minutes_distributions`; the chain anchors. The rep is the records custodian for the actual delivery — the same posture as the off-app-signer evidence in ADR-0012 §3.9.

The runbook flags that an employer-portal "send" button is an explicit non-feature for the same reason the worker_co_chair never authenticates to an employer IdP — the app is worker-controlled, not employer-integrated.

#### 3.3.2 The distribute form

A panel on `meeting-minutes-pdf-view.tsx` (per §3.7) opens a slide-up sheet (mobile) / slide-over (desktop) with:

- **Recipient role picker** (enum: `mgmt_co_chair` / `worker_rep` / `mgmt_rep` / `union_local` / `warehouse_mgr` / `plant_mgr` / `mlitsd_inspector` / `legal_counsel` / `other`). The `other` value opens a sibling text field for the rep's free-form description.
- **Recipient display name** (free text; the rep types). Sealed-box-encrypted client-side under the workplace public key before submit (same posture as M2.1 attendance display names). NEVER plaintext on the wire.
- **Sent method picker** (enum: `email_off_app` / `printed_handoff` / `portal_upload` / `mail` / `in_person` / `other`).
- **Sent at** (datetime picker; defaults to `now()`; the rep can back-date to capture an out-of-app handoff that happened earlier — captures the rep's recorded delivery time, not the server-receipt time per ADR-0009 §3.12's legal-stance pattern).
- **Notes** (optional free-text, sealed-box-encrypted; for the rep's records — "MLITSD inspector requested copy during 2026-08-15 visit").
- **Confirm CTA** "Record distribution" (step-up gated).

On confirm, the route fires `POST /api/minutes-documents/:id/distributions`. The server: opens the workplace private key (bounded window); decrypts the recipient display name into a JS string; computes `recipient_hash = sha256(canonical_json({role: recipientRole, displayName: decryptedName}))` (the canonical-JSON shape is the same `@jhsc/audit` canonical-JSON helper from ADR-0002); memzeros the buffer; INSERTs the `minutes_distributions` row with the encrypted name + the hash; emits `minutes_document.distributed` with payload `{documentId, distributionId, recipientRole, recipientHash, sentMethod, sentAt, distributedByActorId}` — NEVER the recipient's plaintext name (T-AC9-class invariant).

#### 3.3.3 Multi-recipient distributions are multiple rows

A rep distributing to 5 reps + the mgmt co-chair creates 6 distribution rows + 6 chain events. The list view groups by `document_id` and renders the recipients as a chronological list with the role + sent method + sent_at + a "distributed" badge. The recipient_hash is the chain-payload-safe identifier; the chain row doesn't carry the plaintext name; an arbitrator can verify a specific recipient was on the list by hashing the role + display name themselves and comparing to the chain.

#### 3.3.4 Distribution to the same recipient on a re-generation

A new `minutes_documents` row (per §3.5 re-generation) has a different `document_id`; the rep re-distributing to the same recipient creates a new `minutes_distributions` row keyed to the new document. The list view surfaces both: "v1 (2026-09-20) distributed to mgmt_co_chair on 2026-09-21; v2 (2026-09-25 after typo fix) distributed to mgmt_co_chair on 2026-09-26."

#### 3.3.5 The PDF itself is NOT modified by distribution

Distribution does not edit the PDF; the document hash stays bound to the document row; the chain anchors the distribution events as independent rows. A rep distributing to one recipient produces the same bytes as a rep distributing to ten; the bytes are the rendered PDF.

### 3.4 Retention statement

The PDF foot renders a retention statement keyed to `WORKPLACE.jurisdiction` (the M2.1 config field). The corpus citations:

- **Ontario OHSA (jurisdiction='ON')**: O. Reg. 851 (the "Industrial Establishments" regulation) carries the workplace records retention duty implicitly through s.6 (records of accidents) + s.30/s.31 (committee records) — the canonical citation for committee minute retention in the JHSC operational tradition is "the minutes of meetings of the committee shall be made available for examination by an inspector and shall be retained by the employer for two years." The Industrial Establishments Reg + OHSA s.9(28) (cited above in the M2.1 work as a near-neighbor; if not seeded, S1 adds the canonical retention citation entry to `packages/legal-corpus`).

- **Canada Labour Code Part II (jurisdiction='CA-FED')**: CLC s.135(7.2) (committee records) + the COHSR equivalent — federal jurisdiction has different cadence requirements. S1 confirms the corpus entries are seeded; if not, the legal-corpus S1 task adds them.

The retention statement renders in Source Serif 4 italic, paired with the citation reference via the established `<CitationRef />` server-render equivalent (the corpus body + version_date stamp). Sample copy (Ontario):

> "These minutes are an evidentiary record of the Joint Health & Safety Committee meeting held on <date>. Per O. Reg. 851 s.<N> [version <YYYY-MM-DD>] and OHSA s.9(28), workplace records of JHSC meetings must be retained for not less than two years and made available for inspection by an Ontario Ministry of Labour, Immigration, Training and Skills Development inspector. This worker-side copy is the JHSC worker co-chair's independent record under OHSA s.9(20-21) and is not employer infrastructure."

The CA-FED variant cites CLC + COHSR. The runbook documents both variants verbatim.

Per CLAUDE.md non-negotiable #5, the retention statement's citation tuples (statute_code, citation, version_date, body_hash) are persisted on the `minutes_documents` row as part of the `attestation_signed_ct` canonical-JSON envelope (so the chain row + the workplace-key signature lock the citation snapshot to the document; a future corpus re-seed that publishes an amendment does not retroactively change what THIS PDF cited).

### 3.5 Re-generation discipline

A meeting's minutes can be re-generated after `finalized`. Three triggers:

1. **Typo fix in a decrypted display name** (the rep notices a misspelling in the post-finalization PDF). The rep updates the attendance row via the existing M2.1 attendance PATCH; re-generates the PDF.
2. **Edge-case post-finalization closure** (a closure verification lands AFTER finalize for an action item that was `Pending Review` at finalize time — rare, but the M2.2 closure-verification route does not gate on meeting finalization). The post-finalization closure does NOT silently appear in the existing PDF (the document hash is bound to the bytes); a regeneration produces a new document that reflects the new closure attestation.
3. **Distribution to a new recipient who needs a fresh copy** (e.g., 6 months later an MLITSD inspector requests the minutes; the rep regenerates so the new download produces an integrity-verified bytestream).

#### 3.5.1 The mechanism

Each generation produces a NEW `minutes_documents` row with:

- A NEW `document_hash` (bytes change because of any decrypted-display-name update, any post-finalize closure, any timestamp metadata in the footer).
- The `generation_kind='regeneration'` + `prior_document_id=<latest_prior_row.id>`.
- A NEW `audit_idx` anchoring `minutes_document.regenerated` in the chain.
- A NEW Tigris object key (the prior object STAYS in Tigris — append-only Tigris storage, never overwrite).
- A NEW `attestation_signed_ct` over the new canonical-JSON.

The web UI surfaces the chain of generations as a vertical timeline on `meeting-minutes-pdf-view.tsx`: "v3 (latest) — generated 2026-12-10; v2 — generated 2026-10-05; v1 (initial) — generated 2026-09-20" with download CTAs per version + distribution list per version.

#### 3.5.2 Step-up on every generation + regeneration

Per non-negotiable #16. The `action='minutes_document.generate'` step-up is required for both the initial and every regeneration. The 60s freshness window matches M2.1 §3.10 + ADR-0013 §3.10.

#### 3.5.3 Idempotency at the hash layer

The route's pre-INSERT check computes the document hash AFTER rendering but BEFORE `chain.append()` (the same ordering as the inspection export per `apps/api/src/routes/inspections/exports.ts` discipline). If the computed hash matches an existing `minutes_documents.document_hash` for this `meeting_id`, the route returns the existing row's metadata WITHOUT writing a new row OR firing a chain anchor (idempotent on hash). This handles the corner case where the rep clicks "Regenerate" but nothing has changed (e.g., the rep clicked it accidentally; or a deterministic regeneration produces byte-identical output). The UI surfaces "Regeneration produced identical bytes; no new version created" with the existing row's metadata. Documented as the expected idempotent path.

#### 3.5.4 No re-generation after meeting archive

If `meetings.status='archived'`, the regeneration route returns 422 `meeting_archived_no_regeneration`. The archive transition (a future scope item — ADR-0012 §3.1 status enum includes `archived` but no route transitions to it in 2.1+2.2+2.3) is the documented end-of-life for the meeting record; post-archive regeneration would be a forensic-procedure scope item, not a routine operation.

### 3.6 Audit kinds + step-up

Four new `AuditEventKind` values land in `packages/shared-types/src/index.ts`:

```ts
| 'minutes_document.generated'      // POST /api/meetings/:id/minutes-documents (initial)
| 'minutes_document.regenerated'    // POST /api/meetings/:id/minutes-documents (regeneration)
| 'minutes_document.downloaded'     // GET /api/minutes-documents/:id/download
| 'minutes_document.distributed'    // POST /api/minutes-documents/:id/distributions
```

Per-kind `AuditPayload` shapes:

```ts
'minutes_document.generated': {
  meetingId: string;
  documentId: string;
  documentHash: string;             // hex
  documentSizeBytes: number;
  formatVersion: 'v1';
  pageSize: 'letter' | 'a4';
  signingKeyId: string;
  attestationSignatureHash: string; // hex
  generatedAt: string;              // iso
  generatedByActorId: string;
  retentionCitations: ReadonlyArray<{ statuteCode: string; citation: string; versionDate: string; bodyHash: string }>;
  // Cross-anchor metadata:
  finalizedActionItemCount: number;
  closureVerifiedCount: number;
  signatureCount: number;           // always 4 for a finalized meeting
};

'minutes_document.regenerated': {
  meetingId: string;
  documentId: string;
  priorDocumentId: string;
  priorDocumentHash: string;        // hex
  documentHash: string;             // hex
  documentSizeBytes: number;
  formatVersion: 'v1';
  pageSize: 'letter' | 'a4';
  signingKeyId: string;
  attestationSignatureHash: string;
  generatedAt: string;
  generatedByActorId: string;
};

'minutes_document.downloaded': {
  meetingId: string;
  documentId: string;
  documentHash: string;             // hex; for TOCTOU integrity recheck per §3.6.2
  downloadedAt: string;
  downloadedByActorId: string;
};

'minutes_document.distributed': {
  meetingId: string;
  documentId: string;
  distributionId: string;
  recipientRole: string;
  recipientHash: string;            // hex; PI-clean per T-AC9
  sentMethod: string;
  sentAt: string;
  distributedByActorId: string;
};
```

#### 3.6.1 No PI in payloads

Per T-AC9 invariant (ADR-0002): no recipient names, no signer names, no attendee names, no closure reasons, no notes plaintexts in payloads. The retention citations are corpus-derived (legal, non-PI). The actor IDs are UUIDs (the M2.1 + M2.2 precedent treats actor IDs as non-PI). The recipient_hash is the chain-payload-safe identifier; an arbitrator with the canonical recipient display name + role can verify a chain row references that recipient by reproducing the hash.

#### 3.6.2 Download integrity recheck (T-I27 carryover)

`GET /api/minutes-documents/:id/download` re-verifies the stored bytes' SHA-256 against `minutes_documents.document_hash` before returning. Same posture as the inspection export download per `apps/api/src/routes/inspections/exports.ts` discipline. A mismatch returns 500 `storage_integrity_violation` + emits an `audit.tigris_integrity_violation` event (a forward-seam audit kind that the existing 1.7 evidence integrity pattern already established; no new kind for M2.3). The `minutes_document.downloaded` event embeds the document hash in the payload so the chain itself proves which bytes the rep received.

#### 3.6.3 Step-up gating

| Route                                           | Step-up required? | Action                        | Rationale                                                                                                        |
| ----------------------------------------------- | ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /api/meetings/:id/minutes-documents`      | **Yes**           | `minutes_document.generate`   | Per non-negotiable #16 — every PDF generation is a high-value evidentiary anchor. 60s window.                    |
| `GET /api/meetings/:id/minutes-documents`       | No                | —                             | Read-only list of metadata (document hashes, generation timestamps, distribution counts). No PI exposure.        |
| `GET /api/minutes-documents/:id`                | No                | —                             | Read-only metadata envelope.                                                                                     |
| `GET /api/minutes-documents/:id/download`       | **Yes**           | `minutes_document.download`   | The PDF bytes contain decrypted PI (attendee names, signer names, closure reasons). 60s window.                  |
| `POST /api/minutes-documents/:id/distributions` | **Yes**           | `minutes_document.distribute` | Distribution is an evidentiary action (the chain proves the rep handed the doc over to a recipient). 60s window. |
| `GET /api/minutes-documents/:id/distributions`  | No                | —                             | Read-only list of distribution metadata (recipient hashes, methods). No plaintext name in response.              |

Step-up freshness window: 60s per the established ADR-0007 / ADR-0008 / ADR-0012 / ADR-0013 precedent.

#### 3.6.4 Idempotency + clientId

Every POST route is wrapped by the existing `idempotencyKeyGuard` middleware per ADR-0009 §3.4. The `clientId` body field is accepted on creates per ADR-0009 §3.3 — for `POST /api/meetings/:id/minutes-documents` the clientId becomes the `minutes_documents.id` if provided. The distribution POST accepts a `clientId` that becomes `minutes_distributions.id`. The download GET is naturally idempotent.

#### 3.6.5 Rate limit

Generation is expensive (font load + N envelope decrypts + N rows joined + PDF render). The route gets a per-actor token bucket of 10/hour (more permissive than the 5/hour inspection-export bucket — the rep iterating on a typo fix might regenerate 3-4 times in one sitting; 5/hour would frustrate the legitimate workflow). The download route gets the standard 60/hour per-actor bucket. The distribution route gets the standard 60/hour per-actor bucket. The IP-keyed bucket per `rateLimit({ name: 'minutes-documents', capacity: 60, refillPerSecond: 10 })` is the DoS bound; per-actor is the abuse bound.

### 3.7 Web client surfaces

#### 3.7.1 New view: `apps/web/src/views/meeting-minutes-pdf-view.tsx`

The canonical M2.3 surface. Mounted at `/meetings/:id/minutes`. Visible only when `meetings.status='finalized'`. The view's structure:

- **Header** — meeting metadata (date, location, status badge "Finalized"). Back-link to `/meetings/:id` (`data-print="hide"`).
- **Generation section** — "Generate minutes PDF" CTA (step-up gated). When no documents exist yet, the empty state copy reads "No PDF generated yet. Generating will produce the canonical evidentiary record of this meeting; the document hash will be chain-anchored." When at least one document exists, the section shows the latest with "Regenerate" CTA + a "Why regenerate?" tooltip explaining §3.5 triggers.
- **Preview panel** — When a document is selected (latest by default), an iframe loads the PDF via a one-time-use signed URL fetched from the API (the standard Tigris presign pattern from ADR-0006 §3 + the inspections-exports download discipline). Mobile: the preview is collapsed by default with a "Preview PDF" CTA that opens the OS PDF viewer; iframe-in-page is not reliable on mobile Safari. Desktop: the iframe is the primary surface.
- **Document chain panel** — vertical timeline of all `minutes_documents` rows for this meeting (latest first). Per row: version label (v1/v2/...), generated_at, generated_by display name (decrypted client-side from the cache or via a thin server projection), document hash (truncated + tap-to-expand), document size, distribution count chip, download CTA (step-up gated), "Show distribution history" expandable.
- **Distribution panel** — "Record distribution" CTA opens the slide-up sheet per §3.3.2. Below the CTA, a list of all distributions for the currently-selected document: recipient role + sent method + sent at + recipient hash chip (tap to reveal the rep's locally-cached recipient name for the chain-verify recipe).
- **Retention reminder card** — `data-print="evidentiary"` static panel at the bottom of the view rendering the jurisdiction-appropriate retention text + corpus citation. Same text the PDF renders; the on-screen surface and the print surface match.

The view follows the M2.1 + M2.2 print stylesheet conventions: chrome (`data-print="hide"`), evidentiary metadata (`data-print="evidentiary"`). The PDF rendered server-side and the in-browser print stylesheet diverge in layout (the server-side PDF is the canonical evidentiary artifact; the in-browser print is a "preview the PDF layout" affordance for the rep who wants to print directly from the browser — but the canonical bytes are the server-rendered ones, anchored in the chain).

#### 3.7.2 Extensions to existing views

- **`apps/web/src/views/meeting-finalization-view.tsx`** — When the meeting transitions to `finalized` (all 4 signatures land), the success copy adds "Generate the canonical minutes PDF →" with a link to the new view. Existing copy + layout unchanged.
- **`apps/web/src/views/meeting-detail-view.tsx`** — When `meetings.status='finalized'`, the sticky bottom bar gains a "Minutes PDF" CTA linking to the new view. The meeting metadata header gains a "PDF: vN" chip showing the latest document version + distribution count.

#### 3.7.3 New components

- **`apps/web/src/meetings/minutes-document-list.tsx`** — the document chain panel per §3.7.1.
- **`apps/web/src/meetings/minutes-distribution-list.tsx`** — the distribution list panel per §3.7.1.
- **`apps/web/src/meetings/minutes-distribution-sheet.tsx`** — the slide-up sheet per §3.3.2.
- **`apps/web/src/meetings/minutes-pdf-preview.tsx`** — the iframe-or-OS-viewer preview component per §3.7.1.
- **`apps/web/src/meetings/minutes-retention-card.tsx`** — the retention statement card.

### 3.8 Offline behavior

Generation is REQUIRE-ONLINE. Reasons: (a) step-up requires a fresh WebAuthn assertion; (b) the workplace private key + signing key live in Fly Machine memory and are not exposed to the client; (c) the render is expensive and the Tigris upload is part of the transaction. The mobile-primary friction: a rep wanting to generate offline gets a "Network required" banner with the recovery affordance ("Connect to network → retry"). The render cannot be queued because the cryptographic primitives are server-side.

Download is REQUIRE-ONLINE for the initial fetch + integrity recheck. Subsequent reads can hit the service-worker cache (the standard 1.10 PWA caching strategy from ADR-0009) for the same document_hash + the same actor. The Dexie cache stores the document metadata + a content-addressable handle to the bytes; the bytes themselves are cached in the service worker's Cache Storage keyed on the storage URL + the document hash. A re-open from offline pulls from Cache Storage if present; integrity is verified client-side against the stored hash before render.

Distribution recording is REQUIRE-ONLINE. Same reasons as generation — step-up + chain emit + workplace-key decryption of the recipient name (the canonical-JSON for the recipient_hash requires the decrypted name, computed server-side). A rep recording a handoff offline gets the "Network required" banner; the recovery is reconnect-and-retry. The `clientId` body field accepted on the route lets the rep populate the form offline (the form persists in Dexie) and submit when reconnected.

The metrics-style read endpoints (`GET /api/meetings/:id/minutes-documents`, `GET /api/minutes-documents/:id`) are best-effort online; the Dexie cache stores the metadata; offline reads hit cache with a staleness badge per the M2.2 §3.4 precedent.

| Route                                           | Sync-queueable | Require-online | Rationale                                                                       |
| ----------------------------------------------- | -------------- | -------------- | ------------------------------------------------------------------------------- |
| `POST /api/meetings/:id/minutes-documents`      | No             | Yes            | Server-side render + step-up + bounded private-key window.                      |
| `GET /api/meetings/:id/minutes-documents`       | Best-effort    | —              | Read-only metadata; cached fallback.                                            |
| `GET /api/minutes-documents/:id`                | Best-effort    | —              | Read-only metadata; cached fallback.                                            |
| `GET /api/minutes-documents/:id/download`       | No             | Yes (first)    | Step-up + integrity recheck. Subsequent reads can hit the service-worker cache. |
| `POST /api/minutes-documents/:id/distributions` | No             | Yes            | Step-up + server-side hash compute over decrypted recipient name + chain emit.  |
| `GET /api/minutes-documents/:id/distributions`  | Best-effort    | —              | Read-only metadata; cached fallback.                                            |

### 3.9 Cross-cutting controls

#### 3.9.1 Encryption

The render path decrypts on the server inside a bounded window — the workplace private key is opened from `workplace_keys` (the X25519 sealed-box key from 1.7) via the existing `openWorkplacePrivateKey` helper (`apps/api/src/evidence/workplace-key.ts`), used to open every envelope-encrypted field referenced in the render plan, then `sodium.memzero`'d in a `finally` block. The fields:

- `meetings.encrypted_notes_envelope_ct` (optional notes per ADR-0012 §3.1).
- `meeting_sections.notes_envelope_ct` (optional per-section notes per ADR-0012 §3.1).
- `meeting_attendance.display_name_ct` (per attendee per ADR-0012 §3.1).
- `meeting_signatures.signer_display_name_ct` (per signer per ADR-0012 §3.1).
- `meeting_signatures.chain_of_custody_note_ct` (per signer per ADR-0012 TM-fold-4).
- `meeting_signatures.evidence_envelope_ct` (optional per signer per ADR-0012 §3.1).
- `meeting_action_item_state.snapshot_assignee_ct` (per snapshot per ADR-0012 §3.1).
- `action_items.*` decrypted via the existing `safeSummary` pattern from 1.6.
- `action_item_closures.closure_reason_ct` (per closure per ADR-0013 §3.1).
- `action_item_closures.evidence_envelope_ct` (optional per closure per ADR-0013 §3.1).

The bounded-window helper from `pdf-shared/bounded-decrypt.ts` (per §3.2.2) is the canonical primitive; it accepts a list of envelopes + DEK ciphertexts + a render callback; opens the private key once; opens each envelope; calls the render callback with decrypted strings; memzeros every plaintext buffer in `finally`.

The workplace signing key (Ed25519) is opened separately via the existing 1.9 `openWorkplaceSigningPrivateKey` helper (`apps/api/src/evidence/workplace-signing-key.ts`) inside the same transaction to sign the `attestation_signed_ct` over the canonical-JSON of the row. The signing window is bounded to the route's transaction; memzero discipline same as 1.9.

#### 3.9.2 Audit emit

Every write emits a chain anchor inside the route's transaction per ADR-0002 atomic-emit invariant. The chain payload carries the document hash (the canonical bind between the row and the bytes) + the audit row index (back-referenced by the row's `audit_idx` FK). The footer of the rendered PDF embeds the chain idx for the `minutes_document.generated` event so an arbitrator reading the PDF can look up the chain row and verify (a) the document hash in the chain row matches the document hash recomputed from the PDF bytes, (b) the workplace-key signature over the row's canonical-JSON verifies. The chain-row-back-pointer pattern (the audit row index in the PDF footer) is the M2.3 forward-defense against F-L7 / ADR-0013 backlog item: the document carries its own chain idx, eliminating the "show me the chain event for this PDF" out-of-band lookup.

#### 3.9.3 Step-up

Generation + download + distribution all require step-up per §3.6.3. The 60s freshness window matches the established posture. The download path additionally requires `X-Requested-With: jhsc-web` header (same belt-and-suspenders CSRF check as the 1.7 evidence decrypt + 1.8 export download + 1.9 recommendation export — sec-F2 belt-and-suspenders against same-site phishing tabs).

#### 3.9.4 Rate limit

Per §3.6.5. The per-actor token bucket on generation is 10/hour; the route returns 429 with a `retryAfterSeconds` per the established pattern. The reset behavior is the standard `_resetExportBucketsForTests()` test-only helper per the ADR-0008 pattern.

#### 3.9.5 Tigris storage discipline

- `ServerSideEncryption: 'AES256'` per the ADR-0008 §3.8 close-out.
- 30-day TTL via the Tigris lifecycle policy with `WORKPLACE_MINUTES_DOCUMENT_TTL_DAYS` override (default 30 — but the canonical evidentiary record is the chain row's document hash + the workplace-key signature; the Tigris object is a re-download convenience, not the canonical store). After TTL expiry the rep regenerates from the live data substrate; the chain proves what the prior bytes were via the hash.
- Object key shape: `minutes/<meetingId>/<documentId>.pdf` (deterministic per row; the same Tigris hierarchical pattern as 1.8 exports).
- The GC posture for Tigris-orphan objects: same forward-seam as ADR-0006 §3 / ADR-0012 §3.1; the future hardening milestone absorbs the GC sweep.

### 3.10 Negative tradeoffs

- **Server-side decryption of attendee + signer names is the canonical case where the workplace private key is in Fly Machine memory.** ADR-0008 §3.7 established this for recommendation exports (the body + responses); M2.3 extends the surface to a fan-out of envelope-encrypted columns (attendance, signers, signer chain-of-custody notes, signer evidence, snapshot assignees, closure reasons, closure evidence, section notes, meeting notes). The threat surface is scoped: the route is step-up gated; the workplace private key is bounded inside the transaction; every plaintext buffer memzeros before the chain emit. The threat-modeler covers this in §2.15 (T-MD class threats).
- **The PDF generator is the second route after the metrics-style read paths that decrypts on the server.** ADR-0013 §3.10 noted the metrics endpoint surfaces aggregates (no decryption). The PDF generator is the canonical decrypt-on-server surface; the threat surface is bounded by step-up + audit + the bounded-window discipline.
- **Document hash uniqueness vs idempotency.** A re-generation that produces byte-identical output is idempotent on hash (returns the existing row). A re-generation that produces different bytes (any timestamp change, any decrypted-name update, any post-finalize closure) is non-idempotent (writes a new row). The chain reflects both behaviors faithfully; the UI documents the idempotent path.
- **Distribution tracking outside the chain wouldn't be tamper-evident.** The `minutes_distributions` table is chain-anchored per row; the recipient_hash is the chain-payload-safe identifier. A future external arbitrator can verify a chain row references a specific recipient by reproducing the canonical-JSON hash from the role + display name. The cost: the chain does not surface the plaintext recipient name; recovery requires the row's encrypted display name + the workplace private key. Documented.
- **Distribution recording is reversible only via append.** A rep who incorrectly records a distribution (e.g., wrong recipient role) cannot edit the row; they record a corrective new row with a `notes_envelope` describing the correction. The append-only invariant per CLAUDE.md non-negotiable #2 (chain-of-custody on every state transition) is the structural defense; the cost is the rep's friction. Documented; the runbook covers the correction pattern.
- **The PDF format version is pinned per-row; a v2 future format won't retro-affect v1 documents.** Parallel to non-negotiable #13 (template version pin). A future format upgrade is a route-layer opt-in on regeneration; old documents remain v1 forever. The cost is two render pipelines coexisting after v2 lands; the benefit is backward compatibility for the entire historical archive of generated PDFs.
- **Workplace-name surfacing in the PDF body.** Per non-negotiable #1, names live in `config/workplace.ts` (env-driven). The PDF body intentionally renders the workplace display name in the cover page header (the rep wants their PDF to say "ACME Cold Storage JHSC Meeting Minutes" not "Workplace JHSC Meeting Minutes"). This is the documented design — the workplace name is on the loaded config at runtime, not in source. The PDF metadata (`/Title`, `/Author`, `/Producer`) stays generic per T-I28 carryover; only the rendered body surfaces the workplace name. Same posture as the inspection PDF zone-display-name handling per the priv-F6 / T-I44 close-out (ADR-0007).
- **Re-distribution to the same recipient on different document versions is two rows.** A rep distributing v1 to mgmt_co_chair then v2 to mgmt_co_chair after a typo fix produces 2 rows + 2 chain events. The UI surfaces both; the chain anchors both. The cost is verbosity in the distribution list; the benefit is per-version evidentiary clarity. Documented.

### 3.11 Risks + mitigations

- **A bug in the render pipeline could leak plaintext to logs.** Mitigation: the bounded-window helper from `pdf-shared/bounded-decrypt.ts` wraps every envelope decrypt; no plaintext touches `console.*` or the Hono error path (errors return generic 500 envelopes; the actual error is logged at the structured-logger layer with PII redacted via the existing 1.5 logger discipline). Integration tests assert no plaintext field appears in the route's response when the route returns 500 mid-render.
- **A bug in the document hash compute could let a chain anchor reference a different byte sequence than what landed in Tigris.** Mitigation: the route computes the hash AFTER pdfkit's stream emits the final byte AND BEFORE the Tigris upload; the upload uses `Content-MD5` matching the computed hash (same T-I27 + 1.8 exports posture). On Tigris-side mismatch, the upload fails; the route aborts; no chain anchor fires. Integration test asserts the abort path.
- **A Tigris storage key forge could let an attacker substitute a different PDF for the row's document_hash.** Mitigation: the download path re-verifies the SHA-256 of fetched bytes against `minutes_documents.document_hash` before serving (T-I27 carryover). A mismatch returns 500 `storage_integrity_violation` + emits a forensic audit event (per ADR-0011 §3.7). The workplace-key signature over the row's canonical-JSON is the additional bind — even if Tigris bytes diverge, the row + chain + signature triangulate the canonical document.
- **A document hash collision could let two different bytes share the same hash.** Mitigation: SHA-256 collision resistance is the cryptographic assumption (same posture as 1.7 evidence + 1.8 inspections + 1.9 recommendations + M2.1 + M2.2). No practical second-preimage attack is known. Documented residual.
- **A bug in the workplace decryption key handling could leak the master key to a log.** Mitigation: the `openWorkplacePrivateKey` helper from 1.7 already has bounded-window discipline; M2.3 inherits. The runbook flags the discipline; integration tests assert the key is not exposed in any HTTP response.
- **A bug in the recipient_hash compute could allow a chain-payload-PI leak if the canonical-JSON shape changes.** Mitigation: the canonical-JSON helper from `@jhsc/audit` is the single source of truth (per ADR-0002 — the same helper used for the chain row hash). The recipient_hash compute path uses the same helper; the shape `{role, displayName}` is unit-tested for canonical-JSON stability + round-trip stability.
- **A bug in the `attestation_signed_ct` Ed25519 signature could let a forged minutes_documents row pass verification.** Mitigation: the workplace signing-key signature pattern (TM-fold-4 ADR-0012 + ADR-0013) is the established defense. The S2 integration tests cover the signature round-trip + the verifier's signature-check walks every `minutes_documents` row + every `minutes_distributions` row (the latter via the chain payload's audit_idx back-reference; the row itself does not carry an Ed25519 sig in 2.3 — see §3.13 for the rationale).
- **Cross-meeting decryption key leak.** Mitigation: the workplace KEK is single-tenant per CLAUDE.md non-negotiable #1; there is no cross-meeting key separation in 2.3 (a future multi-tenant scope would change this). The key rotation runbook from ADR-0008 §3.7 applies; the M2.3 route's bounded-window discipline carries forward.
- **Distribution recipient name PII leak through chain.** Mitigation: per §3.6.1 the chain payload carries `recipientHash`, NEVER `recipientDisplayName`. The discriminated-union type-layer gate prevents a route handler from passing the plaintext name to `append()`; the S0 threat-modeler review explicitly checks the four new payload shapes for name fields.
- **A PDF re-generation that exposes a post-finalize state change could surprise a reader.** Mitigation: the regeneration UI surfaces the trigger ("Closure verification added after finalize") + the prior_document_id chain. The reader sees both versions and can compare. The chain anchors both. Documented.
- **A rep regenerating the PDF 100 times in a day (e.g., debugging a typo).** Mitigation: the per-actor token bucket (10/hour generation) is the rate-limit defense. The idempotency-on-hash check is the no-op path for byte-identical regeneration. Documented.
- **A rep distributing the same document to 1000 recipients (e.g., a broad union distribution).** Mitigation: the distribution route is per-row (one distribution = one row = one chain anchor). 1000 rows + 1000 chain anchors is single-tenant scale fine (each row is ~1KB; the chain grows linearly). The route's rate limit (60/hour distribution) bounds the burst; a legitimate 1000-recipient distribution spans multiple hours or a batch-API addition lands as a 2.4+ scope item. Documented.

### 3.12 Format versioning

- **`format_version` is pinned per `minutes_documents` row.** Type: `MinutesDocumentFormatVersion = 'v1'` in `shared-types`. 2.3 ships v1 only.
- **A future v2 (e.g., a layout overhaul, a citation-footnote format change, an additional retention-statement clause) lives in a separate render pipeline.** The route's body accepts an optional `formatVersion: 'v1' | 'v2'` parameter that defaults to `'v1'` for backward compat. A regeneration may opt into v2 by passing the explicit param; the new row is `format_version='v2'`; the chain reflects the version bump.
- **An old finalized meeting always renders in its original `format_version` if regenerated with the same param.** The render pipeline is keyed on `format_version`; the routing layer dispatches to the appropriate renderer.
- **Parallel to non-negotiable #13.** Inspections preserve their template version at conduct time; minutes documents preserve their format version at generation time. The migration path for a v2 ship is the established append-only render-version add.

### 3.13 Slice plan

- **S0 — architect + threat-modeler.** This ADR + a `SECURITY.md` §2.15 "Minutes Document Generation" pass with T-MD1..T-MDn threats + mitigations. Coverage to include: workplace KEK leak via render path log, document hash forge via Tigris substitution, recipient PII leak via chain payload, recipient PII leak via API response, distribution-list enumeration without step-up, regeneration race condition (two reps hitting Regenerate simultaneously → two chain anchors with different bytes), step-up replay across multiple generation calls, PDF JS surface inclusion (T-I25 carryover), PDF metadata surfacing workplace name (T-I28 carryover), Ed25519 attestation signature forge, retention citation tampering (the corpus body_hash bind), distribution recording reversal (the append-only-only correction friction), distribution to MLITSD inspector recording (the rights-protective copy gate — does the workflow chill the rep's MLITSD contact?), distribution to legal_counsel recording (privilege-implications copy gate), service worker cache key collision across documents, iframe preview tab leakage, generation-during-network-disconnect partial-write, multi-tab generation race, the v1 → v2 format upgrade attack surface (a malicious v2 renderer could under-emit fields), the workplace_signing_keys rotation interaction with regeneration. The threat-modeler reserves T-MD\* identifiers; this ADR cross-references the placeholders by name.

- **S1 — schema + shared-types + audit kinds.** `migrations/0013_minutes_documents.sql` (the two new tables + the CHECK constraints + the UNIQUE on `(document_hash)` + the UNIQUE on `(document_id, recipient_hash)` + the GC index for hash-collision lookups). Drizzle schema additions to `apps/api/src/db/schema.ts`. `packages/shared-types` additions: `MinutesDocumentFormatVersion`, `MinutesDocumentGenerationKind`, `MinutesDistributionRecipientRole`, `MinutesDistributionSentMethod`, the four new `AuditEventKind` values + per-kind `AuditPayload` shapes. `config/workplace.ts` extension for `documentPageSize`. `WORKPLACE_DOCUMENT_PAGE_SIZE` env var validation. Zod schemas for the route bodies. Tests: schema-version migration roundtrip, the document-hash UNIQUE behavior, the recipient_hash UNIQUE per (document, recipient), the Ed25519 attestation signature roundtrip, the canonical-JSON shape stability for the recipient_hash compute. Estimated lines: ~700.

- **S2 — server routes + `pdf-shared` extraction.** `apps/api/src/pdf-shared/` (fonts, footer, receipt-panel, bounded-decrypt, page-size, metadata) per §3.2.2. The inspections + recommendations renderers refactor to consume `pdf-shared`; golden-PDF fixture asserts byte-for-byte invariance. `apps/api/src/routes/meetings/minutes-documents.ts` (new) — the four new routes (`POST /api/meetings/:id/minutes-documents`, `GET /api/meetings/:id/minutes-documents`, `GET /api/minutes-documents/:id`, `GET /api/minutes-documents/:id/download`). `apps/api/src/routes/minutes-documents/distributions.ts` (new) — the distribution routes (`POST /api/minutes-documents/:id/distributions`, `GET /api/minutes-documents/:id/distributions`). `apps/api/src/minutes/pdf-renderer.ts` (new) — the minutes-specific renderer that consumes `pdf-shared` + the M2.1 / M2.2 data substrate per §3.2.5. `apps/api/src/minutes/data-resolver.ts` (new) — the resolver that walks the M2.1 / M2.2 tables, calls the bounded-decrypt helper, and returns the renderable bundle. `apps/api/src/minutes/attestation.ts` (new) — the Ed25519 attestation signature compute. Integration tests: full happy path (generate → list → download → distribute → list distributions), 422 on non-finalized meeting, step-up gate on all writes + downloads, rate-limit enforcement, idempotency-on-hash returning existing row, regeneration with prior_document_id correctly set, integrity recheck on download, the canonical-JSON shape for distribution recipient hash, the chain payload schema for all 4 new kinds, the cross-anchor reading from M2.1 `meeting.adjourned` payload for the metrics dict in section 9. `audit-log-verify --check-minutes-documents` extension that walks the new kinds + cross-references the row's document hash against the chain payload's. Estimated lines: ~2400 (large slice — the renderer is the bulk).

- **S3 — web client.** `apps/web/src/views/meeting-minutes-pdf-view.tsx` (new). The five new components per §3.7.3. Extensions to `meeting-finalization-view.tsx` + `meeting-detail-view.tsx` (the "Minutes PDF" CTA + chip). Dexie schema extensions for `minutes_documents` + `minutes_distributions` (cache only — server is source of truth; the local cache is for offline preview only). Sync queue plumbing for the distribution-recording offline-form path. Print stylesheet for the new view per the 1.12 `data-print` convention — the on-screen view's preview iframe carries `data-print="hide"` (only the canonical server-rendered PDF is the print artifact; the in-browser print of the view itself is not the canonical record). The retention card carries `data-print="evidentiary"`. Tests: live view component rendering, the regeneration flow with hash-idempotency UI surfacing, the distribution sheet's encryption round-trip (mocked), the document chain timeline render, the offline banner on the generation CTA when the network is down, accessibility audit on the new components per the 1.12 WCAG baseline. Estimated lines: ~2200.

- **S4 — legal-corpus retention citations.** `packages/legal-corpus/seed/o-reg-851.toml` extension for the JHSC committee-records retention citation (if not already seeded; S0 verifies). `packages/legal-corpus/seed/cohsr.toml` extension for the CLC equivalent. The seed runs as part of the deploy runbook per ADR-0011 §3.9 after the migration lands. Emits `audit.legal_corpus.amended` chain event per the existing 1.4 versioning pattern. Estimated lines: ~150.

- **S5 — independent reviewers (security, privacy/UX, signer/attestation, distribution-workflow) + fix bundle.** Four reviewer hats:
  - **Security reviewer:** workplace KEK bounded-window discipline, Ed25519 attestation roundtrip, document-hash integrity recheck, step-up gate completeness, rate-limit posture, the chain payload PI audit for the four new kinds.
  - **Privacy + UX reviewer:** the rights-protective copy on the distribution sheet (especially for `mlitsd_inspector` and `legal_counsel` recipient roles — the copy must not chill regulator-contact or legal-consultation actions), the iframe preview surface accessibility on mobile, the regeneration "Why regenerate?" tooltip copy, the retention statement render fidelity, the workplace-name-in-PDF-body posture, the recipient-hash chip's reveal affordance UX.
  - **Signer/attestation reviewer:** the v1 render's fidelity to the M2.1 4-signer panel + the M2.2 closure-attestation appendix, the chain-of-custody note rendering, the workplace-key signature verification stamp visual.
  - **Distribution-workflow reviewer:** the off-app distribution tracking discipline, the rep-as-records-custodian framing, the multi-recipient bulk-distribution UX, the correction-via-append-only flow.
  - Fix bundle absorbs the close-out items into S2 / S3 code + the runbook `docs/runbooks/minutes-documents.md` covering: the generation + regeneration lifecycle, the distribution tracking discipline, the retention statement variants per jurisdiction, the offline behavior calibration, the operator-side verification recipe for the document hash + chain row + workplace-key signature, the deferred residuals (Tigris GC, batch distribution, embedded PAdES upgrade — the same forward-seam as ADR-0008 §3.9), the v1 → v2 format upgrade procedure (when a future v2 lands).
  - Estimated lines: ~1000.

**Estimated total:** ~6450 lines across S1-S5. Fits one milestone; the renderer is the bulk of the work and benefits from the `pdf-shared` extraction reducing inspection + recommendation renderer maintenance debt at the same time.

## Compliance check

- **#1 no specific names in source.** The workplace display name is from `config/workplace.ts` (env-driven); the PDF body renders it intentionally as the workplace's own identity per the documented design. The signer display labels are from `WORKPLACE.minutesSignerRoles` (per ADR-0012 §3.9). Recipient names + attendee names + signer names + closure reasons are envelope-encrypted at rest; decrypted only at render time inside a bounded server-side window; never persisted plaintext; never in chain payloads. PDF `/Title`, `/Author`, `/Producer` metadata stay generic per T-I28.
- **#2 chain-of-custody.** Four new audit kinds. Every generation, regeneration, download, and distribution emits a chain anchor. Each `minutes_documents` row carries a workplace-key Ed25519 signature over canonical-JSON for defense-in-depth at the row layer (TM-fold-4 pattern from M2.1 + M2.2). The chain payload carries the document hash + the audit row index back-pointer; the PDF embeds the chain idx in the receipt panel.
- **#3 no third-party data flows without opt-in.** No third-party SDK. PDF rendering is server-side via pdfkit (already in the bundle). No external font CDN (fonts loaded from `PDF_FONT_DIR` per the inspections precedent). No analytics on the new routes.
- **#4 privacy-by-default.** Recipient display names + notes are envelope-encrypted. Decryption only at render time (the document) or at distribution-record time (the recipient_hash compute). No "decrypt for analytics" — the distribution-list endpoint returns metadata only (role, hash, method, timestamps).
- **#5 legal citations.** The retention statement reads from `packages/legal-corpus` (jurisdiction-aware, ON OHSA + CA-FED CLC). The corpus body_hash is persisted in the `minutes_documents` row's `attestation_signed_ct` canonical-JSON so a future corpus re-seed does not retroactively alter what THIS PDF cited. No generated citations.
- **#6 no employer infrastructure.** The app records distribution; the rep distributes out-of-band. No employer-portal integration, no employer-SSO email send, no employer-CMS upload. The rep is the records custodian.
- **#7 rights-protective UI.** The distribution copy for `mlitsd_inspector` and `legal_counsel` recipient roles is reviewed for chilling-effect language by the privacy/UX reviewer in S5. The retention statement framing emphasizes the worker-side independent record under OHSA s.9(20-21), NOT compliance language. The PDF does not include "approval" or "endorsement" framing on the signature panel — neutral evidentiary attestation framing per ADR-0012 §3.9.
- **#8 no automated submission to regulators.** The PDF is the artifact; the rep distributes; the app records. No automated MLITSD upload, no automated email-send.
- **#9 mobile-primary.** The `meeting-minutes-pdf-view.tsx` is 390px-first. The PDF preview iframe is collapsed-by-default on mobile (the OS PDF viewer is the primary affordance); the distribution sheet is full-screen slide-up on mobile. Touch targets ≥44pt. The retention card is the same Source Serif 4 / muted-card pattern as the M2.1 finalization view.
- **#10 restrained legal-grade aesthetic.** Source Serif 4 / JetBrains Mono / Inter per the locked typography. No union iconography. No marketing flourishes. The chain receipt panel uses the same `data-print="evidentiary"` JetBrains-Mono pattern as the 1.12 print convention. The PDF design references audit-firm + legal tooling aesthetics per the CLAUDE.md design system.
- **#11 Excel imports sanitized.** Not directly touched by 2.3; the 1.11 Excel import path is unchanged. A future "import a finalized meeting from Excel" path (likely 2.4) would absorb the discipline.
- **#12 action items first-class.** The PDF renders the M2.1 `meeting_action_item_state` finalized snapshot — the per-meeting record of what was true at finalize time, NOT a sub-typing of meetings under action items or vice versa. The closure-attestation appendix renders the M2.2 `action_item_closures` rows for items closed in this meeting — preserving the action-item-first lifecycle.
- **#13 inspections preserve template version at conduct time.** The PDF renders the `meeting_inspection_review` rows by `inspection_id`; the inspections themselves are read via their pinned template_version (M2.1 ADR-0012 §3.1 / non-negotiable #13). M2.3 does not modify the inspection lifecycle. The minutes document's own `format_version` field is the parallel application of #13 — once a v1 minutes document is generated, regeneration in v1 preserves the format.
- **#14 zone IDs stable.** Inspections referenced in the inspections-review section render their zone display name from `config/workplace.ts` per the priv-F6 / T-I44 pattern (ADR-0007). Zone IDs stay stable.
- **#15 inspection findings manually promoted.** Not directly touched by 2.3; the promotion path is unchanged. Promoted items appear in the action-items snapshot as any other action item.
- **#16 exports step-up + audit log + document hash.** **THIS IS THE CANONICAL INSTANCE.** Every PDF generation requires step-up (`minutes_document.generate`, 60s window). The chain anchors `minutes_document.generated` with the document hash in the payload. The PDF embeds the chain idx + truncated document hash in the per-page footer + the full document hash in the receipt panel. The download path requires step-up + integrity-rechecks the bytes against the stored hash. The distribution event requires step-up + emits a chain anchor. Every export discipline non-negotiable #16 requires is structurally enforced.

## Follow-ups

- [ ] **Threat-modeler:** append `SECURITY.md` §2.15 "Minutes Document Generation" with T-MD1..T-MDn threats + mitigations. Coverage list per §3.13 S0.
- [ ] **S1:** Migration `0013_minutes_documents.sql` (the two new tables + CHECK constraints + UNIQUEs + audit_idx FK invariant); Drizzle schema additions; `packages/shared-types` additions (four new `AuditEventKind` + per-kind payloads + the new enums + the new format_version + the new page_size + the new recipient role + the new sent method); Zod schemas; `config/workplace.ts` extension for `documentPageSize`; the `WORKPLACE_DOCUMENT_PAGE_SIZE` env var validation; tests for the schema-version migration roundtrip + the CHECK enforcement + the canonical-JSON shape stability.
- [ ] **S2:** The `pdf-shared` extraction (fonts + footer + receipt-panel + bounded-decrypt + page-size + metadata); the inspections + recommendations renderer refactor to consume it (byte-for-byte golden-PDF fixture invariance gate); the four new routes (POST/GET generation + GET download + POST/GET distribution); the minutes-specific PDF renderer; the data resolver; the Ed25519 attestation compute; integration tests for the full lifecycle; `audit-log-verify --check-minutes-documents` extension that walks the new kinds + cross-references the document hash + recipient_hash invariants.
- [ ] **S3:** Web client — `meeting-minutes-pdf-view.tsx` + the five new components; extensions to `meeting-finalization-view.tsx` and `meeting-detail-view.tsx`; Dexie schema extensions; sync-queue plumbing for the offline distribution form; print stylesheet posture for the new view per the 1.12 `data-print` convention.
- [ ] **S4:** `packages/legal-corpus` extensions for the OHSA + O.Reg. 851 + CLC + COHSR retention statement citations (if not seeded); confirmation that the existing M2.1-era seeded citations cover the M2.3 retention statement requirement; legal-corpus version bump per the established 1.4 pattern.
- [ ] **S5:** Independent reviewers (security, privacy + UX, signer/attestation, distribution-workflow) + fix bundle. Runbook `docs/runbooks/minutes-documents.md` covering: the generation + regeneration lifecycle, the distribution tracking discipline, the retention statement variants per jurisdiction, the offline behavior calibration, the operator-side verification recipe for the document hash + chain row + workplace-key signature, the v1 → v2 format upgrade procedure (when a future v2 lands), the deferred residuals (Tigris GC, batch distribution, embedded PAdES upgrade).
- [ ] **2.4 (Excel Re-Import Update Mode) absorbs:** If the rep imports an Excel-format minutes for an in-progress meeting + later finalizes + generates the PDF in 2.3, the import provenance is captured on the `minutes_documents` row's `attestation_signed_ct` canonical-JSON (a future seam — the import event id, if applicable). 2.4 confirms whether this is in-scope; if not, the seam is documented for a later milestone.
- [ ] **2.5+ absorbs:** Batch distribution (one POST that creates N rows + N chain events; for a large union local distribution). The 2.3 single-recipient POST is the canonical form; batch is a future ergonomics layer.
- [ ] **Release 2.x hardening absorbs:** Tigris orphan-PDF GC job (forward seam from 1.7 / M2.1 GC deferral); embedded PAdES upgrade (forward seam from 1.9 ADR-0008 §3.9); cross-process pg-boss-backed export rate limiter (1.12 forward seam).
- [ ] **Release 3 absorbs:** E2EE distribution to other reps about a meeting's minutes (currently single-rep + off-app distribution; multi-rep encrypted distribution via the libsignal-protocol-typescript layer is R3); push notifications when management responds to a distributed minutes document; AI-assisted distribution-recipient suggestion based on prior distributions (off by default per non-negotiable #3); analytics over distribution-cadence + recipient-coverage (Release 3 §3.7).
- [ ] **`packages/legal-corpus`:** Confirm OHSA + O. Reg. 851 + CLC + COHSR retention statement citations are seeded. If not, S4 adds. Per CLAUDE.md non-negotiable #5 the citation triples (statute_code, citation, version_date, body_hash) MUST resolve in the corpus before the PDF render can pin them to the attestation signature.
- [ ] **`.context/decisions.md`** entry referencing this ADR.

## Open questions for user

1. **PDF page size default.** §3.2.4 defaults `WORKPLACE.documentPageSize` to `'letter'` for the Ontario default (the rep's existing Excel print workflow is Letter). A workplace primarily distributing to CA-FED recipients might prefer `'a4'`. The default is locked at `'letter'` with the env var override path; user to confirm or escalate if a different default is preferred.
2. **Regeneration cadence rate limit.** §3.6.5 specifies 10 generations/hour per actor (more permissive than the inspection-export 5/hour). A rep iterating on a layout debug might burst higher; user to confirm 10/hour as the cap, or accept the friction for the legitimate workflow.
3. **Iframe preview vs OS PDF viewer on mobile.** §3.7.1 ships the iframe preview collapsed-by-default on mobile with the OS PDF viewer as the primary affordance (iframe-in-page is unreliable on mobile Safari). A user testing the workflow may prefer iframe-always or OS-always; the default is the responsive split. User to confirm.
4. **Recipient role enum scope.** §3.1.2 ships nine recipient roles (`mgmt_co_chair` / `worker_rep` / `mgmt_rep` / `union_local` / `warehouse_mgr` / `plant_mgr` / `mlitsd_inspector` / `legal_counsel` / `other`). Some workplaces may want narrower or wider — e.g., a workplace that routinely distributes to a "Safety Director" might want a 10th role. The `other` value + the encrypted notes field is the structural escape hatch; user to confirm the nine enum values cover the canonical recipient list.
5. **Retention statement text vs. citation only.** §3.4 ships a verbose retention statement (the cited corpus body + the OHSA / CLC framing + the worker-side independence framing). A user might prefer terser citation-only ("Retain 2 years — OHSA s.9(28)"). The default is verbose for evidentiary clarity in front of an arbitrator; user to confirm.
6. **`minutes_document.downloaded` chain anchoring discipline.** §3.6.3 anchors every download. The chain grows by one row per download — a rep re-downloading the same document 20 times produces 20 chain rows. The selective-read-anchoring posture from M2.2 metrics (don't anchor reads) is the alternative; the M2.3 stance is anchor downloads because (a) the PDF bytes contain decrypted PI; (b) the inspections + recommendations exports DO anchor downloads (per ADR-0008 §3.12 retrofit). The ADR's default is "anchor every download per the established precedent"; user to confirm or escalate if the chain-row volume is a concern.

## S0 addendum — user decisions + threat-modeler folds

Appended at S0 close after the user resolved the 6 open questions and the threat-modeler (§2.15, 46 T-MD threats) surfaced 7 architectural folds for S1.

### User decisions (locked)

- **Q1 PDF page size.** `'letter'` default stays per the architect's framing. CLC-jurisdiction workplaces override via `WORKPLACE_DOCUMENT_PAGE_SIZE='a4'` env var (parsed in `config/workplace.ts`).
- **Q2 Regeneration cadence.** 10 generations/hour per actor (more permissive than the inspection-export 5/hour). The legitimate layout-debug iteration burst is honored; the rate limit still bounds the DoS surface from a compromised actor.
- **Q3 Mobile preview.** Responsive split — OS PDF viewer on mobile (iframe-in-page is unreliable on mobile Safari), iframe preview on desktop. The mobile flow: "Open in viewer" CTA triggers a signed-URL download + opens in the OS viewer.
- **Q4 Recipient role enum.** Ship 9 visible options BUT split source-vs-env per non-negotiable #1 (the AskUserQuestion default named `warehouse_mgr` + `plant_mgr` which would have regressed on the workplace-specific-name rule). The 7 GENERIC IDs hardcoded in `packages/shared-types`: `mgmt_co_chair`, `worker_rep`, `mgmt_rep`, `union_local`, `mlitsd_inspector`, `legal_counsel`, `other`. The 2 WORKPLACE-SPECIFIC slots: `workplace_role_1` + `workplace_role_2` (env-driven display labels via `MINUTES_RECIPIENT_ROLE_WORKPLACE_1_LABEL` + `MINUTES_RECIPIENT_ROLE_WORKPLACE_2_LABEL`). This mirrors the M2.1 `minutesSignerRoles` env-driven pattern. The `other` value + encrypted notes field stays as the escape hatch for everything else. Total: 9 visible options; zero workplace-specific job titles in source.
- **Q5 Retention statement text.** Verbose (per the architect's evidentiary-clarity framing). The PDF's footer renders the cited corpus body + the OHSA / CLC framing + the worker-side independence framing. Terse citation-only is a forward seam if a user testing reports the verbose version is too dense.
- **Q6 `minutes_document.downloaded` chain anchoring.** Anchor every download per ADR-0008 §3.12 precedent. The PDF bytes carry decrypted PI; every retrieval is a privacy-relevant event. Single-tenant scale (~50 downloads/year per meeting at the heaviest distribution cadence × ~12 meetings/year = ~600 download chain rows/year) is acceptable.

### Threat-modeler architectural folds (S1 owns implementation)

The §2.15 threat-modeler surfaced 7 folds. All compatible with the §3.x design:

1. **TM-fold-1 (T-MD2, T-MD29) — SERIALIZABLE + two-pass generation.** S1's generation route wraps the read-state + render + Tigris-upload + chain-emit + row-insert sequence in `SERIALIZABLE` isolation with a two-pass dance: pass 1 reads + renders (no DB writes); pass 2 computes hash, INSERTs `minutes_documents` row + chain anchor under SERIALIZABLE, then commits the Tigris upload AFTER the chain row is durable. Closes T-MD2 concurrent-generation race + T-MD29 re-generation race.
2. **TM-fold-2 (T-MD7, T-MD8, T-MD9, T-MD10) — Audience dual-render flag.** S1 adds `minutes_documents.render_audience TEXT CHECK IN ('jhsc_internal', 'external_distribution')`. The internal audience renders closure reasons + signer narratives in full. The external audience redacts to hashes + role IDs (T-IM26 escalation closed). The rep selects audience at generation time; the chain payload carries `renderAudience` so a verifier can confirm the bytes match the declared audience.
3. **TM-fold-3 (T-MD18, T-MD23, T-MD37) — Distribution recipient canonicalization.** S1 adds a pure helper `compute-recipient-hash.ts` that SHA-256s `{role, displayName, method}` in canonical alpha-sorted JSON. The chain payload carries ONLY this hash + the role enum; the encrypted display name lives in the `minutes_distributions.recipient_display_name_envelope_ct` column. Multiple-recipient-in-one-event is rejected at the Zod layer (per-recipient = per-row = per-chain-event).
4. **TM-fold-4 (T-MD24, T-MD25, T-MD28) — Tigris `storage_key` DB CHECK regex.** S1 adds `CHECK (tigris_storage_key ~ '^minutes/[0-9a-f-]{36}/[0-9]{14}/[0-9a-f]{64}\.pdf$')` on `minutes_documents`. The regex encodes the canonical key shape (`minutes/<meetingId>/<utc14>/<documentHash>.pdf`); a malformed key cannot insert. Signed-URL TTL set to 5 minutes (matches the existing 1.7 evidence flow); GC for retention-aged blobs deferred to a future hardening milestone per the §3.10 stance.
5. **TM-fold-5 (T-MD26, T-MD27) — Legal-corpus retention pre-flight.** S1's generation route reads the corpus entries for OHSA s.9(28) + CLC s.135.2 retention BEFORE rendering. Missing entries fail-closed with `RETENTION_CORPUS_MISSING`; the rep cannot generate without the citations resolving. The retention statement embeds the corpus entry hashes (not just citations) so a verifier can confirm the cited body matches what was rendered.
6. **TM-fold-6 (T-MD27) — Hold-state enum + routes.** S1 adds `minutes_documents.hold_state TEXT CHECK IN ('none', 'subpoena_hold', 'mlitsd_hold', 'litigation_hold')` + new routes `POST /api/minutes-documents/:id/hold` + `POST /api/minutes-documents/:id/hold-release` (both step-up gated; both chain-anchored as `minutes_document.hold_placed` + `minutes_document.hold_released`). A document under hold cannot be deleted at the 2-year retention boundary; the GC job (forward seam) consults this column. Hold reason is a free-text envelope per the rep's chain-of-custody discipline.
7. **TM-fold-7 (T-MD38, T-MD39, T-MD40) — `audit-log-verify --check-minutes-documents` extension.** S1 extends the verifier with a new flag that walks `minutes_document.*` events: every `generated` event must reference an existing `meeting.finalized` event for the same meeting_id; every `distributed` + `downloaded` event must reference an existing `generated` event; every `regenerated` event must reference a prior `generated` event; the `documentHash` in each event's payload must match the Tigris HEAD's ETag (if `TIGRIS_BUCKET` env is set; fail-soft to chain-only verification if not).

### Audit kinds expansion (M2.3 ships 6 load-bearing kinds)

The architect's draft listed 4 (generated, regenerated, downloaded, distributed). The threat-modeler surfaced 2 additional load-bearing kinds via TM-fold-6:

| Kind                             | Payload (PII-free)                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minutes_document.generated`     | `{ meetingId, documentId, documentHash, documentSize, formatVersion, renderAudience, generatedAt, generatedByActorId, retentionCorpusEntryHashes }` |
| `minutes_document.regenerated`   | `{ meetingId, documentId, priorDocumentId, documentHash, generatedAt, generatedByActorId, reason }`                                                 |
| `minutes_document.downloaded`    | `{ meetingId, documentId, documentHash, downloadedAt, downloadedByActorId }`                                                                        |
| `minutes_document.distributed`   | `{ meetingId, documentId, distributionId, documentHash, recipientHash, recipientRole, sentMethod, sentAt, sentByActorId }`                          |
| `minutes_document.hold_placed`   | `{ meetingId, documentId, holdState, holdReasonHash, placedAt, placedByActorId }`                                                                   |
| `minutes_document.hold_released` | `{ meetingId, documentId, priorHoldState, releasedAt, releasedByActorId }`                                                                          |

The threat-modeler also flagged an optional 7th kind `minutes_document.distribution_declined` for the T-MD34 rights-protective "Decline to distribute" path. S0 decision: DEFER to a post-M2.3 hardening milestone — the rep's not-distributing is the default state; emitting a chain event for a non-event is over-instrumentation. The "Decline to distribute" UI affordance still ships in M2.3 (T-MD34 mitigation) but produces no chain row.

### Slice handoff

S1 begins from this ADR + SECURITY §2.15. The S1 brief MUST reference these 7 TM-folds + Q4's split source-vs-env recipient role implementation. S5 reviewers verify each fold landed.
