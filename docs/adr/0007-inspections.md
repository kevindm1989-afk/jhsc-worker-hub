# ADR-0007: Inspections (templates + findings + signatures + PDF export)

Status: Accepted, Milestone 1.8
Date: 2026-06-01
Authors: codifies Milestone 1.8 architect-phase decisions; pairs with `SECURITY.md` §2.8 (forthcoming) and `docs/runbooks/inspections.md` (forthcoming).

## Context

Inspections are the operational core of the worker-side JHSC week: a zone monthly walk-through under OHSA s.9(26)/(27), and a CSA A344-style rack inspection that the rep co-signs alongside the supervisor. Both produce paper today, which the rep then re-keys into a spreadsheet, which the next rep argues with at the next meeting. 1.8 absorbs that paper into the app and treats every finding as future-evidence material.

Three things make inspections different from anything 1.5–1.7 has shipped:

1. **Templated, but versioned at conduct time.** The questions on the page determine what a finding _means_. CLAUDE.md non-negotiable #13 makes that immutable: an inspection conducted under Zone-Monthly v1 must always render v1's questions, even after the template moves to v2. Versioning is append-only at the row level; the inspection pins a specific row.
2. **Two status vocabularies in production at once.** Zone Monthly uses **ABC + X** (A = immediate, B = 1–7 days, C = longer-term, X = no issue / N/A). Rack uses **GAR** traffic-light per CSA A344. We do not flatten these to a common axis — the inspector's mental model is the vocabulary, and converting them silently in storage would invalidate the audit trail. The template carries its own vocabulary; findings validate against the template's vocabulary; the API rejects out-of-vocabulary values.
3. **Three-signature workflow for rack.** Rack inspections require Inspector + Supervisor + JHSC Worker Co-Chair signatures. This is the worker-side rationale for keeping the rack inspection in the rep's tool rather than employer infrastructure: the rep's chain-anchored evidence of who signed what, when, is the artifact a hostile arbitrator reads six months later. The employer's copy is the employer's problem; the rep's copy is ours.

`design/prototypes/inspection-detail.tsx` is the visual anchor (template-driven form rendering, photo strip per finding, promote chip, signature sheet). ARCHITECTURE.md §"Inspections Module (Detailed)" and §6a "Inspection Export" are the structural anchors. ROADMAP.md 1.8 scope is templates + findings + scheduling + capture flow + manual promotion + three-signature workflow + single-and-batch PDF export with `export_records`. Offline-first capture is officially deferred to 1.10 — 1.8 ships the capture flow online-only with Dexie hooks stubbed but not consuming.

## Decision

Land five tables (`inspection_templates`, `inspections`, `inspection_findings`, `inspection_signatures`, `export_records`) + seven new API routes + the template-driven web flow + a `pdfkit`-based PDF generator running inside the API request lifetime + six new audit chain event kinds. Template content is JSONB validated by a Zod schema, never free-form HTML. Findings' observation + corrective-action text are envelope-encrypted via `@jhsc/crypto` (same shape as hazards 1.5 / action-items 1.6 description fields). Photos attach via the polymorphic `evidence_files` table that 1.7 stood up; 1.8 opens the third accepted `linkedType` (`'inspection_finding'`) with the same route + trigger ratchet the 1.7 sec-F4 / priv-AI-F3 close-out established. PDF exports require step-up and emit a chain anchor carrying the output document SHA-256.

### 3.1 Template versioning model (append-only)

```
inspection_templates (
  id                    uuid primary key default gen_random_uuid(),
  template_code         text not null,                          -- 'zone_monthly' | 'rack_csa_a344' | 'custom_<slug>'
  version_number        integer not null check (version_number >= 1),
  name                  text not null,                          -- display name; non-PI
  status_system         text not null check (status_system in ('ABC_X','GAR')),
  status_vocab          jsonb not null,                         -- see 3.2 -- the canonical list of codes + labels
  cadence               text not null check (cadence in ('monthly','quarterly','annual','ad_hoc')),
  requires_signatures   text[] not null default '{}',           -- e.g. {'inspector','supervisor','jhsc_co_chair'}
  sections              jsonb not null,                         -- see 3.5 -- the section/item structure
  zone_scope            text,                                   -- null = any zone; or a stable zone_id
  source_authority      text,                                   -- e.g. 'CSA A344.1-21 §6.3'  (clause numbers only -- see 3.4)
  created_by_user_id    uuid references users(id),
  created_at            timestamptz not null default now(),
  retired_at            timestamptz,                            -- non-null = retired version
  unique (template_code, version_number)
);
```

- **Append-only.** Editing a template means inserting a new row with `version_number = max+1`. The prior row stays; historical inspections that pinned it stay valid. There is no `UPDATE inspection_templates SET sections = ...` path in the API surface.
- **Natural key.** `(template_code, version_number)` is unique. `template_code` is a stable slug; `version_number` is monotonic per code.
- **Immutability mechanism for inspections.** `inspections.template_version_id` is a FK to `inspection_templates.id` (the specific versioned row) — NOT to `template_code`. ON DELETE RESTRICT. This is the structural enforcement of non-negotiable #13: a v2 row cannot displace a v1 row's findings because the inspection's FK never moves.
- **Active version selection** is application-level: a "start inspection" call resolves `template_code → latest non-retired row` and pins that id to the inspection. Once pinned, the inspection never re-resolves.

### 3.2 Status vocabularies (ABC+X and GAR)

Each template declares its status system in `status_system` and its vocabulary in `status_vocab`. Two flavors ship in 1.8:

```ts
// packages/shared-types/src/inspection.ts
export const inspectionStatusSystem = ['ABC_X', 'GAR'] as const;
export type InspectionStatusSystem = (typeof inspectionStatusSystem)[number];

export const abcxCodes = ['A', 'B', 'C', 'X'] as const;
export type AbcxCode = (typeof abcxCodes)[number];

export const garCodes = ['G', 'A', 'R'] as const;
export type GarCode = (typeof garCodes)[number];

export type InspectionFindingStatus = AbcxCode | GarCode;
```

`status_vocab` carries the human-readable label + the severity hint used for sorting / batch UI. For `ABC_X`:

```jsonc
{
  "A": { "label": "Immediate", "promotable": true, "severityHint": "critical" },
  "B": { "label": "1–7 days", "promotable": true, "severityHint": "high" },
  "C": { "label": "Longer-term", "promotable": true, "severityHint": "medium" },
  "X": { "label": "No issue / N/A", "promotable": false, "severityHint": "none" },
}
```

For `GAR`:

```jsonc
{
  "G": { "label": "Green", "promotable": false, "severityHint": "none" },
  "A": { "label": "Amber", "promotable": true, "severityHint": "high" },
  "R": { "label": "Red", "promotable": true, "severityHint": "critical" },
}
```

**Why we accept two systems instead of forcing one.** ABC+X is the rep's existing language for zone walk-throughs (the codes already appear on the paper checklist they replace). GAR is the language CSA A344 uses for rack. Forcing both into a unified axis would mean the rep mentally re-translates at the moment of capture, which is exactly when accuracy matters. The cost of two systems is a single discriminated-union in shared-types and a one-line Zod refinement per finding. We accept that cost.

**Validation.** `inspection_findings.status` is `text` at the schema level. The route layer loads the pinned template version, reads `status_system + status_vocab`, and rejects any status not in the vocabulary with 422. `promotable: false` codes (X for ABC+X, G for GAR) are the route-layer gate in §3.7 below.

### 3.3 Zone binding (stable IDs, deploy-config display)

`inspections.zone_id` is `text` with no DB-side enum or FK. This is deliberate:

- **Zones are deploy-config, not data.** The list lives in `config/workplace.ts` (already shipping `ZoneId = 'zone_1' | ... | 'zone_10'`). They are not a workplace's editable resource — they are the deployment's identity.
- **Stable IDs, configurable display names** is CLAUDE.md non-negotiable #14. The column stores `zone_1`..`zone_10` literals; `config/workplace.ts:resolveZoneLabel()` renders the workplace-supplied display name at view time. Renaming "Zone 3" to "Cold Warehouse" never rewrites historical inspection rows.
- **Validation** is a Zod refinement against the `ZoneId` union at the route layer. Reusing the existing union avoids DB-side enums that drift from the TypeScript truth.
- **The DB has no `zones` table.** A future workplace that wants `zone_11` is a code change + redeploy, not a row insert. This is the same posture `workplace_keys` (1.7) took — single-tenant ops, no admin UI.

### 3.4 Seeded templates (Zone Monthly v1 + Rack CSA A344 v1)

Both templates ship as a TypeScript seeder in `scripts/seed-inspection-templates.ts`, run idempotently against the live DB after migrations apply. SQL migration carries only the schema; content lives in TypeScript so the Zod-validated shape is checked at build time. Each seeded row is anchored in the audit chain via a new `audit.inspection_template.seeded` event kind so a tampered seed is detectable.

**Zone Monthly v1** — 14 sections + Employee Interview closer, `status_system = 'ABC_X'`, `cadence = 'monthly'`, `requires_signatures = ['inspector']` (no rack-style three-sig requirement). Sections, in order:

> Emergency Exits · Racking · Floors / Aisles · Stairs · Dock Safety · GHS · PPE · Emergency Response Equipment · Machine Handling · Other Equipment · Compactor · Electrical Panels · Maintenance Area · Outside of Building · _(closer)_ Employee Interview

The item text and "expected condition" criteria under each section come from the worker-authored checklist in `templates/inspection-zone-monthly.md` (to be created alongside this milestone). All wording is original to the project.

**Rack Inspection v1 (CSA A344)** — 4 sections, `status_system = 'GAR'`, `cadence = 'annual'`, `requires_signatures = ['inspector', 'supervisor', 'jhsc_co_chair']`. Sections:

> Structural Integrity · Beam & Hardware · Specialty Racking · Safety Documentation

**CSA copyright stance (CLAUDE.md Legal Reference Module Rules §5).** CSA A344.1 / A344.2 are copyrighted. The seeded template stores:

- **Clause numbers** as references (`source_authority = 'CSA A344.1-21'`, per-section `clause_refs = ['§6.3.1', '§6.3.2', ...]`).
- **Section headings** (the four above), which are commonplace structural labels and not the standard's expressive content.
- **Brief, original-language summaries we author**, capturing what the inspector is being asked to look at. Example: instead of quoting A344's beam-deflection text, we write "Beams show no visible bowing under load; clip locks intact and engaged."

We **never** store CSA's verbatim text, exemplar diagrams, or its prescriptive tolerance values transcribed from the standard. Where a numeric tolerance is essential to the question (e.g. plumb tolerance), the question prompts the inspector to check against "the manufacturer's specified tolerance" or "the value posted on the load-application sign at this rack," not against a number cribbed from the standard.

This is the first ADR to land copyrighted-standard material; the pattern set here is the precedent for any future CSA / ANSI / ACGIH / ISO surfaces (e.g. WBV, noise dosimetry). It mirrors `packages/legal-corpus`: clause-level references with `source_url + version_date + verified_by` provenance and never the source's full text.

### 3.5 Custom template authoring (JSONB + Zod, no HTML)

A workplace can author a custom template — same `template_code` namespace with a `custom_<slug>` prefix, same versioning rules, same status-system + vocab declaration. Templates are NOT a markup surface:

- **No HTML.** `sections` is JSONB validated by a Zod schema that accepts only structured fields (`section_number`, `title`, `items: [{ item_number, text, criteria? }]`, `closing_section?`).
- **Maximum sizes.** Up to 30 sections per template, up to 30 items per section, ≤ 240 chars per item text, ≤ 480 chars per criteria. The Zod schema enforces these and the route returns 400 with the failing path.
- **Persisted shape mirrors ARCHITECTURE.md §"Inspection Template Structure (`sections_json`)"** verbatim — that shape is the contract.
- **Editing is versioning.** The web surface offers "edit template" which loads the latest version, lets the rep edit, and POSTs a new row with `version_number = current+1`. The prior row stays. Retired versions are soft-flagged (`retired_at`) but not deleted.

There is no per-item rich text, no per-question conditional logic, no scoring. Adding any of those is a future ADR.

### 3.6 Finding + photo binding (opens `evidence_files.linked_type = 'inspection_finding'`)

```
inspection_findings (
  id                              uuid primary key default gen_random_uuid(),
  inspection_id                   uuid not null references inspections(id) on delete restrict,
  section_number                  integer not null,                         -- pinned at conduct time from template
  item_number                     text not null,                            -- '1.1', 'EI.2', etc.
  item_text                       text not null,                            -- snapshot from the template -- non-PI
  criteria                        text,                                     -- snapshot from the template -- non-PI
  status                          text not null,                            -- validated against template's status_vocab
  observation_ct                  bytea,                                    -- envelope-encrypted free-text observation
  observation_dek_ct              bytea,
  corrective_action_ct            bytea,                                    -- envelope-encrypted
  corrective_action_dek_ct        bytea,
  responsible_party_ct            bytea,                                    -- encrypted display name when external
  responsible_party_dek_ct        bytea,
  responsible_party_user_id       uuid references users(id),                -- internal rep alternative
  promoted_action_item_id         uuid references action_items(id)
                                    on update restrict on delete restrict,  -- §3.7
  promoted_at                     timestamptz,
  audit_idx                       bigint not null references audit_log(idx),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (inspection_id, item_number)
);
```

- **Snapshot the question text + criteria** onto the finding row at create time. This means a finding row is self-describing even if its template were ever to be force-deleted (it never will be — ON DELETE RESTRICT — but the snapshot makes the row independently auditable).
- **PI in observation + corrective_action.** Both can carry worker names, body-part injury detail, supervisor-by-name accusations. Envelope-encrypted via `@jhsc/crypto`, same `(*_ct, *_dek_ct)` pair shape as hazards/action-items. NOT plaintext in Postgres.
- **`responsible_party`** uses the same dual-shape as action_items' `follow_up_owner`: encrypted name when external, `user_id` when internal.
- **NOTE (S5 close-out, priv-F8 / T-I44 sibling).** The dual-shape (`user_id` reference for internal owners, encrypted name for external) is **deferred to 1.9** to keep the 1.8 schema flat. For 1.8, `responsible_party` is **encrypted-string-only** — the `responsible_party_user_id` column shown above is NOT implemented in migration 0007. The UI prompt (priv-F2 close-out — `apps/web/src/views/inspection-detail-view.tsx`) biases reps toward role/department language over individual names so the encryption-at-rest claim is the meaningful bound. The dual-shape ratchet plan: 1.9 adds the `responsible_party_user_id` column + Zod surface, the existing rows continue to read as encrypted-string-only, new writes prefer `user_id` for internal owners. Documented in `docs/runbooks/inspections.md` §11 as a forward seam.
- **Photos** attach via `evidence_files.linked_type = 'inspection_finding'`, `linked_id = inspection_findings.id`. The 1.8 migration extends the existing trigger (`evidence_files_linked_fk_guard`) with an `inspection_finding` branch that existence-checks against `inspection_findings`. The route layer's `acceptedLinkedTypes` array in `apps/api/src/routes/evidence/index.ts` adds `'inspection_finding'`. That ratchet is the entire 1.8-side change to evidence — the encrypt/decrypt path and key management are unchanged.

### 3.7 Manual promotion to action items (the ONLY path)

CLAUDE.md non-negotiable #15: manual promotion only, inspector chooses Risk, X / G fail-closed.

**API.** `POST /api/inspection-findings/:id/promote`:

```ts
body: {
  risk: 'Low' | 'Medium' | 'High' | 'Critical',
  // optional override of description; defaults to the finding's observation + item_text.
  descriptionOverride?: string,
  // optional override of follow-up owner; defaults to finding.responsible_party.
  followUpOwner?: { userId?: string; nameCleartext?: string },
}
```

Behavior:

1. Load the finding + its inspection + the pinned template's `status_vocab`.
2. **Fail-closed if `status_vocab[finding.status].promotable === false`.** Returns 422 `finding_not_promotable`. This is the route-layer enforcement of non-negotiable #15. X and G findings cannot be promoted; the UI button is hidden, but the API rejects regardless.
3. **Fail-closed if already promoted** (`promoted_action_item_id IS NOT NULL`). Returns 422 `already_promoted`. Re-promotion is not a feature.
4. Open a transaction. Insert an `action_items` row with `type = 'INSP'`, `section = 'new_business'`, `risk = body.risk`, `start_date = today`, `source_type = 'inspection'`, `source_id = finding.id`. The description ciphertext is the finding's observation re-sealed (decrypt-and-reseal happens server-side, plaintext lifetime bounded to the request).
5. UPDATE the finding: `promoted_action_item_id = <new>; promoted_at = now()`.
6. Emit `inspection_finding.promoted` audit anchor (kind below). Action-items' own `action_item.created` event also fires — both anchors land in one transaction.
7. Extend the 1.6 `action_items_source_fk_guard` trigger with an `inspection` branch validating `source_id IN (SELECT id FROM inspection_findings)`. The 1.6 ADR explicitly anticipated this — same per-source trigger pattern.
8. Extend the action-items route's `sourceType` Zod refinement to accept `'inspection'` (the 1.6 close-out limited it to `manual | hazard | excel_import` until 1.8 / 1.9 / later ship).

**`actionItemSourceType` already includes `'inspection'`** in `packages/shared-types/src/index.ts`, so no shared-types churn is needed beyond the new audit kind.

**Meeting binding.** The promoted action item lands in `section = 'new_business'`. ROADMAP scope says "of the next active meeting" — meetings (1.x) do not yet exist as a table. For 1.8 we leave `meeting_id = NULL`. When meetings ship, a one-shot backfill assigns NULL `meeting_id` items to the active meeting per their `created_at`. This matches the 1.6 ADR's documented forward seam (`meeting_id` nullable until 1.10).

**Bidirectional link.** The finding row carries `promoted_action_item_id`. The action item row carries `source_type='inspection' + source_id=<finding.id>`. The web detail view on either side renders a link to the other.

### 3.8 Three-signature workflow (separate table, chain-anchored each)

```
inspection_signatures (
  id                  uuid primary key default gen_random_uuid(),
  inspection_id       uuid not null references inspections(id) on delete restrict,
  signature_role      text not null check (signature_role in ('inspector','supervisor','jhsc_co_chair')),
  signed_by_user_id   uuid not null references users(id),
  signed_at           timestamptz not null default now(),
  note_ct             bytea,                                       -- optional encrypted note
  note_dek_ct         bytea,
  audit_idx           bigint not null references audit_log(idx),
  unique (inspection_id, signature_role)
);
```

**Why a separate table over a JSONB blob on `inspections`:**

- Each signature is independently chain-anchored (`audit_idx` FK). A JSONB blob would force one chain anchor for the whole signing event or no anchor per individual signature; both are weaker.
- The `(inspection_id, signature_role)` unique index gives us "at most one of each role" for free, where a JSONB approach would need a CHECK on the blob shape.
- Querying "show me every inspection co-chair Worker X signed" is a simple WHERE on a normal column.
- The 1.6 `action_item_moves` table set the precedent: one row per event, each chain-anchored. Signatures are events; this is the same shape.

**Workflow.** The web `/inspections/:id/sign` route renders a sheet listing required signatures from `templates.requires_signatures`. Each role's signer hits "Sign as Supervisor" / etc. The API requires the signer's identity to match `signed_by_user_id = auth.userId` for the inspector + co-chair roles (no signing-on-behalf for those). The supervisor role accepts a signer that is not a registered user only via a future invite flow (deferred — 1.8 ships supervisor signing as authenticated-user-only).

**Audit anchor.** Each signature emits `inspection.signed { inspectionId, role, signerUserId }`. The optional note is envelope-encrypted (PI risk: a co-chair might write "supervisor refused to acknowledge §6.3 defect"); ciphertext lives on the row, no plaintext in the audit payload.

**An inspection is considered "complete" only when `requires_signatures` is fully satisfied.** The inspection's `status` transitions `in_progress → completed` automatically inside the last-signature transaction. Findings can still be authored after `completed` only via an explicit reopen step (step-up gated, documented in the runbook follow-up); the default UX disables editing post-completion.

### 3.9 PDF export — `pdfkit`, store-in-Tigris, hash-anchored

**Library.** `pdfkit` over `@react-pdf/renderer`.

- `pdfkit` is a streaming, imperative API that fits the "decrypt-photos-as-we-go-then-zero" memory discipline. We control the order of operations and can call `sodium.memzero` on each photo buffer the moment its bytes are written to the PDF stream.
- `@react-pdf/renderer` is reactive and builds an in-memory virtual tree, which keeps every decrypted photo buffer alive until the whole document renders. Worse plaintext-lifetime story.
- `pdfkit` is single-runtime (Bun/Node), no JSX, no separate worker. Lower surface area.
- Source Serif 4 is embedded as a TTF font file shipped in `apps/api/src/inspections/fonts/` (already vendored for hazards 1.5 print stylesheet preview); `pdfkit.registerFont` consumes it directly.

**Storage.** Generated PDFs are written to Tigris under `exports/<exportId>/inspection-<exportId>.pdf` (immutable, addressed by `exportId`). Rationale:

- **Re-issuability for chain-of-custody.** A subpoena six months out asking "produce the exhibit you exported on 2026-08-14" is answerable by `SELECT … WHERE id = <exportId>` + fetch from Tigris. Without storage, we can only regenerate, and a regenerated PDF will differ in byte-level (timestamp pages, embedded ImageMetadata) even if the rendered content is identical. The original-bytes guarantee is the defensible exhibit.
- **Cheap.** A typical inspection PDF with 10 embedded photos is ~2–5 MB. 100-inspection batches are ~50–500 MB. Tigris pricing accommodates.
- **30-day TTL configurable per workplace.** The default lifecycle policy is 30 days; `WORKPLACE_EXPORT_TTL_DAYS` overrides per deploy. After expiry the row in `export_records` remains (with `output_sha256` for any re-verification of a previously-distributed copy); only the PDF object in Tigris ages out. Re-export remains possible — same content yields a new `exportId`.
- **Encryption at rest:** PDFs in Tigris are written through the existing workplace sealed-box path? No — that path is for upload-from-browser. For server-generated PDFs we use Tigris-side encryption (SSE) plus the route-level step-up gate. PDF plaintext is acceptable on Tigris because (a) the PDF is itself the disclosable artifact, not source data, and (b) the export is gated by step-up + audit. This decision is called out for review.

**`export_records` table:**

```
export_records (
  id                       uuid primary key default gen_random_uuid(),
  kind                     text not null check (kind in ('inspection_single','inspection_batch')),
  requested_by_user_id     uuid not null references users(id) on delete restrict,
  requested_at             timestamptz not null default now(),
  inspection_ids           uuid[] not null,                       -- 1..100 entries
  output_storage_key       text,                                  -- 'exports/<uuid>/inspection-<uuid>.pdf' -- null after TTL expiry
  output_sha256            bytea not null,                        -- 32 bytes; persists past TTL
  byte_size                bigint not null check (byte_size > 0),
  step_up_jti              text,                                  -- the auth session jti that passed step-up
  audit_idx                bigint not null references audit_log(idx),
  expires_at               timestamptz                            -- TTL hint; Tigris lifecycle is the actual enforcement
);
```

- **`inspection_ids` is a `uuid[]`** not a join table. Exports are append-only event rows; a join table would imply queryability we don't need. ROADMAP cap of 100 per batch is the array's de-facto max length; the route's Zod schema enforces it.
- **`step_up_jti`** identifies the step-up grant that authorized the export. The auth runbook covers revoking grants; this column lets the audit log show "this export rode on a since-revoked grant" after the fact.
- **No plaintext fields** on the row itself. The `inspection_ids` are opaque uuids; the file lives in Tigris, addressed by hash; the row is the chain anchor + the receipt.

**Plaintext lifetime inside the API request.** This is the same bounded-plaintext discipline as 1.7's evidence decrypt, made explicit:

1. Begin request. Verify step-up. Begin transaction.
2. Open the workplace private key (sealed under KEK).
3. Stream the PDF to a temp buffer:
   - Decrypt each inspection's findings (envelope-open `observation`, `corrective_action`, `responsible_party`, signature notes). Write to PDF stream. **Zero each plaintext immediately** after writing the corresponding PDF page-region.
   - Decrypt each linked photo (`evidence_files.sealed_dek` → DEK → ciphertext from Tigris → plaintext). Embed in PDF stream. `sodium.memzero` on the plaintext buffer the moment `pdfkit.image()` returns. Verify `plaintext_sha256` against the row before embedding (same integrity check as the 1.7 decrypt route).
4. Finish the PDF stream. Hash the bytes with SHA-256 → `output_sha256`.
5. Upload the bytes to Tigris under `exports/<exportId>/...`.
6. Insert `export_records` row, emit `inspection.exported` chain anchor with `{exportId, inspectionIds, outputSha256, byteSize}`. Commit.
7. Stream the bytes to the client (same buffer, no second decryption).
8. `sodium.memzero` on the workplace private key + any remaining DEKs.

The runbook (follow-up) will state this in operational language; the ADR is the architectural commitment.

**Footer.** Every PDF page renders (per ARCHITECTURE.md §6a):

> Exported by [user] on [ISO date] · Doc hash: sha256 [hex] · Audit anchor: [hex]

The `Doc hash` is `output_sha256` of the FINAL PDF — yes, hashing the document while it's being constructed is circular. We resolve this by writing the footer with the placeholder `__HASH__` during the stream, then post-processing: compute SHA-256 of the placeholder-bearing bytes, perform an in-place string replace of the literal `__HASH__` for the hex digest, recompute the final hash, and store the FINAL value. The pre-replace hash is discarded; only the post-replace hash is canonical. This is documented as a known footnote in the inspection runbook.

### 3.10 Step-up posture for exports

Same `checkStepUpFreshness` helper as 1.7 evidence decrypt. Action string `inspection.export`. Freshness floor: **60 seconds** (matches the 1.7 evidence-read posture). The freshness floor is justified by the same plaintext-on-server boundary as evidence: the export route opens the workplace private key and decrypts every linked photo. A 5-minute step-up grant from an unrelated action is too generous for the privilege the export route exercises.

- Rate-limit: 5 exports per hour per user (matches SECURITY.md §4a control 5). Enforced by the existing per-name token bucket middleware.
- Batch size: 100 inspections max per export. Enforced in the Zod schema for the batch route.
- Header on the 401: `WWW-Authenticate: StepUp realm="jhsc", action="inspection.export", max_age="60"`.

### 3.11 Slice plan

- **S0 — architect + threat-modeler.** This ADR + a SECURITY.md §2.8 "Inspections" pass with T-I1..T-In threats. The threat-modeler runs against the ADR in parallel.
- **S1 — schema + shared-types + migration 0007.** Drizzle schema additions for the five tables. `packages/shared-types`: `InspectionStatusSystem`, `AbcxCode`, `GarCode`, `InspectionFindingStatus`, six new audit kinds (`inspection.created`, `inspection_finding.created`, `inspection_finding.promoted`, `inspection.signed`, `inspection.exported`, `audit.inspection_template.seeded`) added to `AuditEventKind` + `AuditPayload`. Migration 0007 with CHECKs + indexes + the extended `evidence_files_linked_fk_guard` + the extended `action_items_source_fk_guard`. `scripts/seed-inspection-templates.ts` ships here. Tests: vocab validation, template Zod shape, status-vocabulary promotability, seeded-template round-trip.
- **S2 — routes (templates / inspections / findings / promote / sign).** `apps/api/src/routes/inspections/` with: `POST/GET/GET-by-id /api/inspection-templates`, `POST/GET/GET-by-id/PATCH /api/inspections`, `POST/PATCH /api/inspection-findings`, `POST /api/inspection-findings/:id/promote`, `POST /api/inspections/:id/sign`. Also extend `apps/api/src/routes/evidence/index.ts` `acceptedLinkedTypes` with `'inspection_finding'`. Encrypt/decrypt helper in `apps/api/src/inspections/crypto.ts` (same shape as hazards 1.5 `crypto.ts`). Integration test suite covering create + finding capture + photo link + manual promotion (with X/G fail-closed assertions) + three-signature happy path + reject-out-of-vocab.
- **S3 — web (list, detail, capture-flow, finding card, promote dialog, sign sheet).** `apps/web/src/inspections/` with `/inspections` list (grouped by status, with cadence-based "due soon" surfacing), `/inspections/:id` template-driven detail view, `/inspections/:id/capture` mobile-first capture flow (one section at a time, sticky bottom action), finding card with promote chip + status picker, promote dialog with Risk select, sign sheet with role-aware buttons. Dexie hooks stubbed (write to memory, sync queue deferred). Tests: empty state, template-rendering parity across v1/v2 of the same code, promote happy path + promote-rejected-for-X, three-sig flow.
- **S4 — PDF export.** `apps/api/src/routes/exports/index.ts` with `POST /api/exports/inspection` (single) + `POST /api/exports/inspection-batch` + `GET /api/exports/:id` (re-fetch by exportId, step-up still required). `apps/api/src/inspections/pdf.ts` houses the `pdfkit` renderer. `export_records` writes happen here. Tests: golden-PDF fixtures (hash of a known-input PDF stable across builds — `pdfkit` is deterministic when fed fixed bytes + fixed font), step-up gate, rate-limit enforcement, plaintext-zero assertions (a separate test pins `sodium.memzero` call counts via spy).
- **S5 — independent security + privacy reviewers.** Same pattern as 1.4 / 1.5 / 1.6 / 1.7. Threat model close-out lands the operational findings into `docs/runbooks/inspections.md`.

## Consequences

### Positive

- **CLAUDE.md non-negotiable #13 (template immutability) is structurally enforced** by the `inspections.template_version_id` FK to a specific versioned row. There is no API surface that can mutate a template; there is no FK that points at a `template_code`.
- **CSA-copyrighted content is handled correctly the first time.** The pattern established here — clause numbers + headings + our-own-words summaries + provenance reference — is the template for every future copyrighted-standard surface (WBV, noise, MSD). Future ADRs cite ADR-0007 §3.4.
- **Two status vocabularies coexist without leakage.** The template carries its own vocab; findings validate against the pinned template's vocab; the route layer is the single enforcement point. The implementer never has to ask "is this an A or an Amber?" — the template tells them.
- **The polymorphic evidence linkedType pattern from 1.7 stays load-bearing.** 1.8 opens one new branch on the same trigger and one new branch on the same route. The next milestone (1.9 recommendations) opens the fourth. The shape doesn't change; only the ratchet advances.
- **The three-signature workflow's separate-row design** gives us "show me every rack inspection User X signed as supervisor" for free, and gives us per-signature chain anchors which a JSONB blob couldn't.
- **PDF storage in Tigris (with 30-day TTL)** makes "produce the exhibit you exported" answerable months later via byte-identical re-fetch. Regenerated exports would not be byte-identical even with the same source data; we keep the original.

### Negative / accepted tradeoffs

- **The 1.8 PDF route opens the workplace private key + decrypts every linked photo on the server.** Same posture as 1.7 evidence decrypt — bounded plaintext for the lifetime of one request, `sodium.memzero` discipline, step-up gated, chain-anchored. The trade is identical to T-E3 from 1.7: documented and accepted for single-tenant scope.
- **`inspections.zone_id` has no DB-side FK.** A typo at the route layer ("`zone_11`") would write a bad value before the Zod check fires — except the Zod check fires before the DB write. Documented; the `ZoneId` union is the single source of truth.
- **Custom templates can author content the seed migration never validated.** Workplace-authored templates are validated by the same Zod schema as seeded ones, but a rep could still author a confusing or poorly-worded question. That's an editorial concern, not an architectural one; the template-versioning model means a bad v1 can be superseded by a v2 without invalidating prior inspections.
- **Meetings (`action_items.meeting_id`) is still nullable through 1.8.** Promoted action items land with `meeting_id = NULL`. This matches the 1.6 ADR's explicit forward seam; the 1.x meetings backfill closes it.
- **Supervisor signing in 1.8 is authenticated-user-only.** A real workplace's supervisor may not be in the rep's tool. The 1.8 ADR accepts this — supervisors who refuse to sign in-app sign on paper, and the paper is attached as `evidence_files` to the inspection. A future invite flow lets external supervisors sign without full accounts; deferred.
- **`pdfkit` is a smaller community than `@react-pdf/renderer`.** Bus factor is the trade. The plaintext-lifetime story is decisive.

### Risks

- **Footer hash post-replace is fiddly.** The `__HASH__` placeholder + post-stream string replace is a two-pass dance and a bug here would leave the visible hash mismatched against the actual hash. Mitigation: a unit test renders a fixture PDF, parses the footer text out, computes SHA-256 of the bytes, asserts the footer matches the computed digest. Runs in CI on every PR that touches `pdf.ts`.
- **Tigris storage growth for stored exports.** 30-day TTL is the bound; the runbook covers tuning `WORKPLACE_EXPORT_TTL_DAYS` per deploy.
- **Template versioning interacts with custom-template authoring.** A rep edits "their" template, bumps to v2, then realizes v1 was right. Recovery path: edit again, copy v1's content forward, bump to v3. There is no "revert to v1." Documented as an accepted operational cost — append-only is the precedent.
- **Promoted action item description re-seal lands plaintext on the server briefly.** Same bounded-plaintext story as PDF export, much shorter window. The promote route uses the same envelope helpers as the action-items intake; no new crypto surface.

## Compliance check

- **#2 chain-of-custody.** Every inspection write (template seed, inspection create, finding create, photo link via evidence, promotion, signature, export) emits a chain anchor. Signatures are individually chain-anchored; the export footer carries the chain anchor hex.
- **#4 privacy-by-default.** `observation`, `corrective_action`, `responsible_party` (external), and signature notes are envelope-encrypted via `@jhsc/crypto`. The DB sees ciphertext; plaintext exists only inside route handlers for the duration of the request.
- **#5 legal corpus.** Rack-template content stores clause numbers + headings + original-language summaries. No verbatim CSA text in `inspection_templates.sections`. Cited references go through the `packages/legal-corpus` pattern.
- **#13 template versioning at conduct time.** `inspections.template_version_id` FKs the specific versioned row, not the code. Append-only template rows. ON DELETE RESTRICT throughout.
- **#14 stable zone IDs.** `inspections.zone_id` stores the stable `zone_N` literal; display names render from `config/workplace.ts` at view time.
- **#15 manual promotion only.** Promotion is its own endpoint; X / G findings fail-closed at the route layer; no auto-promote on save, on close, or on signature.
- **#16 step-up + audit for exports.** `inspection.export` action gates the PDF route with a 60-second step-up freshness floor; `inspection.exported` chain anchor carries `outputSha256`; `export_records` persists the receipt.

## Follow-ups

- [ ] Threat-modeler: append `SECURITY.md` §2.8 "Inspections" with T-I1..T-In threats + mitigations (CSA-copyright handling, plaintext-on-server during export, GAR-vs-ABC validation, zone-config drift, stored-PDF lifetime).
- [ ] S1: shared-types + schema + migration 0007 + the two seeded templates + the trigger ratchets.
- [ ] S2: inspections crypto helper + seven routes + the evidence route's `acceptedLinkedTypes` extension + integration tests.
- [ ] S3: web list + detail + capture flow + finding card + promote dialog + sign sheet.
- [ ] S4: PDF export route + `pdfkit` renderer + `export_records` + golden-PDF tests + plaintext-zero spy assertions.
- [ ] S5: security + privacy reviewers.
- [ ] Runbook: `docs/runbooks/inspections.md` covering template-versioning operations (how to retire a version, how to roll forward a custom edit, recovery path for a bad v2), CSA copyright stance (what to store, what NOT to store), three-signature reopen procedure, PDF export operations (re-issue from `export_records`, TTL tuning, footer-hash invariant), plaintext-lifetime guarantees, the workplace-key dependency, and a "what 1.10 (offline sync) needs to absorb" stub.
- [ ] **1.10 (offline-first sync) absorbs:** the capture flow's Dexie stubs (queue findings + photos for upload), conflict resolution for concurrent edits on the same inspection, signature queueing (do we re-sign on conflict resolution? answer to be settled in 1.10's ADR).
- [ ] **1.12 (hardening) absorbs:** workplace key-pair rotation rewraps the stored export PDFs only if we move them under the sealed-box path (currently they ride SSE, so rotation is operationally orthogonal); per-template editorial review pass on the seeded Zone Monthly and Rack v1 wording before first production deploy; a `evidence_redactions`-style `inspection_finding_redactions` table for misfiled findings.
- [ ] **Release 2 absorbs:** invite-and-sign flow for external supervisors; per-question conditional logic in templates; rich-text in custom-template item text.
- [ ] `.context/decisions.md` entry referencing this ADR.
