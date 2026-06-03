# ADR-0010: Excel Import (browser-side SheetJS + reconciliation + step-up commit)

Status: Accepted, Milestone 1.11
Date: 2026-06-02
Authors: codifies Milestone 1.11 architect-phase decisions; pairs with `SECURITY.md` §2.11 (forthcoming) and `docs/runbooks/excel-import.md` (forthcoming).

## Context

The rep has years of meeting-minutes Excel workbooks. They are the operational history of the JHSC under the prior — and still ongoing — spreadsheet workflow: one `.xlsx`/`.xlsm` per quarter, sheets named `NEW BUSINESS`/`OLD BUSINESS`/`NOTICE OF RECOMMENDATION`/`COMPLETED`/`Closed Items History`, a `_MoveHistory` tab that approximated the chain, and an embedded `Inspection Review` section with notes from the floor walks. 1.5–1.10 shipped the native equivalents — hazards, action items with the §3.6 section semantics, inspections under template version pinning, recommendations under the s.9(20)/s.9(21) clock, and the offline-first sync queue that lets the rep work on a freezer dock — but the migration path from the old workbooks to the new app was a forward seam. CLAUDE.md non-negotiable #11 names it: _"Excel imports are sanitized. Imported files are parsed in the browser, sensitive fields encrypted client-side before server sync. Imported data never bypasses the audit chain."_ The ROADMAP 1.11 scope (`packages/excel-import` + SheetJS + schema detector + per-sheet parsers + PII heuristic + reconciliation engine + preview UI + `excel_imports` / `excel_import_items` tables + step-up on commit + 30-day reversal + `docs/excel-import-format.md`) is the structural answer. 1.11 is the migration path; this ADR codifies it.

CLAUDE.md non-negotiable #11 is the dominant constraint and bounds the entire shape of the milestone. The raw `.xlsx` bytes **never leave the browser**. SheetJS (`xlsx`) is a browser-only dependency in `packages/excel-import`; the API never sees the file. The parse runs in a Web Worker so a 50K-row workbook does not block the main thread; the worker is browser-bound. Sensitive fields (action-item descriptions that contain PII, attendance lists, responsible-party names, the source filename which often carries the workplace name) are envelope-encrypted under the workplace public key — the same sealed-box pattern as 1.7 evidence (`apps/web/src/evidence/crypto.ts: sealEvidence`) — before any API call. The server stores ciphertext; the chain anchor binds to the source file's SHA-256, not to the file itself.

Three things make 1.11 different from anything 1.5–1.10 has shipped:

1. **The import is a batch transaction, not a stream of single-row mutations.** A single workbook produces dozens to hundreds of action_items, possibly a handful of recommendations, and a JSONB snapshot of the inspection-review notes — all of which the chain must anchor to a single `excel_import.committed` event. The 1.10 sync queue is shaped for per-row idempotency with retry; a batch import is shaped for atomicity. The two models do not compose, and 1.11 decides — explicitly — that the import commit does **not** flow through the sync queue (§3.12). The commit is single-shot, online-required, step-up-gated, server-side transactional. The parse and preview are offline-capable; the commit is not.
2. **Reconciliation is the operational heart, not the parsing.** Reps re-import the same workbook many times — once a quarter, plus debugging mid-quarter when the workbook has been edited. The reconciliation engine (`content_hash = sha256(canonical(description||start_date))`) makes re-imports idempotent: same content hash → already-imported → skip. A description edit produces a new content_hash → conflict that surfaces in the preview's field-level diff for the rep. The 1.10 conflict-resolution shape (per ADR-0009 §3.7) is the closest precedent, but the import variant is much wider — every row in the workbook is potentially a conflict, and the preview UI is the rep's single review surface for the whole batch.
3. **No legal-citation auto-import.** The rep's Excel notes may mention OHSA s.25(2)(h) or CLC s.135(7) in the recommendation rows; the parser **does not** auto-cite. CLAUDE.md non-negotiable #5 is binding: citations come only from `packages/legal-corpus`. The preview surfaces clause-shape strings as a UX nudge — "this row mentions s.25(2)(h); use the citation picker after import to attach the corpus entry" — but the import path itself does not write a `recommendation_citations` row from cell content. This is the same posture as the 1.4 corpus-only-citations gate, extended to the import surface.

`packages/excel-import` is the new workspace. `apps/web/src/excel-import/` is the upload + preview UI surface. `apps/api/src/routes/excel-imports/index.ts` is the commit/reverse route. `migrations/0010_excel_imports.sql` is the schema. `docs/excel-import-format.md` is the schema spec the detector enforces (the existing placeholder file is replaced in S1 with the authoritative version). ADR-0007 (inspections) is the closest size + shape precedent — a new workspace + a CRUD route + a workflow lifecycle + a step-up-gated commit with chain anchoring — and ADR-0009 (offline-sync) is the closest precedent for the conflict-resolution UX and the workplace-public-key envelope discipline on the client side. 1.11 absorbs no prior-milestone forward deferrals; it is purely additive.

## Decision

Land `packages/excel-import` as a new pure workspace with no DOM or Node dependencies beyond `xlsx` (SheetJS) and `libsodium-wrappers` (envelope sealing), expose `parseWorkbook` / `reconcile` / `commit` as pure functions consumed by both the browser bundle and the Vitest suite, run the parse inside a Web Worker (`packages/excel-import/src/parser.worker.ts`), introduce the `Meeting Minutes v1` schema detector that returns a discriminated union (recognized | unrecognized with reason), parse the four section sheets (`NEW BUSINESS` / `OLD BUSINESS` / `NOTICE OF RECOMMENDATION` / `COMPLETED`) plus the closed-items archive plus a JSONB snapshot of the inspection-review sheet (read-only — NOT promoted to native inspection records per ROADMAP scope), run a four-class PII heuristic (capitalized name-shape, email regex, phone regex, SIN-shape 9-digit) over the parsed cell values to surface flags in the preview UI, envelope-encrypt every sensitive field client-side using the workplace public key from `/api/auth/session` (mirrors the 1.7 sealed-box shape — server holds the private key, browser only ever produces ciphertext), reconcile against existing `action_items` via `content_hash = sha256(canonical(description||start_date))` to classify each parsed row as create / update / skip / conflict_pending, render a per-row preview with field-level diff for conflicts and a "Keep as-is | Skip | Edit before commit" affordance, land `excel_imports` and `excel_import_items` tables (both append-only after commit; PATCH allowed only in the preview→commit window), step-up gate the commit (`maxAgeSeconds=60`, `action='excel_import.commit'`), emit three new chain-anchor kinds (`excel_import.uploaded` / `excel_import.committed` / `excel_import.reversed`), commit transactionally on the server with `allocateSequenceNumber` per new row inside the transaction, support reverse-an-import within 30 days by walking the chain entries for that `import_id` and reverting each row to its prior state (after 30 days the route 410s), and explicitly decline to queue the commit through the 1.10 sync queue (commit is fail-closed offline; the parse and preview are offline-capable so the rep can prepare imports in the freezer and commit when they reach WiFi). The existing 1.6 `actionItemSourceType='excel_import'` forward seam (`packages/shared-types/src/index.ts:191`, `apps/api/src/routes/action-items/index.ts:113,139`) is consumed verbatim; the per-row `source_excel_hash` column already on `action_items` (1.6 migration line 36) carries the row's content_hash for provenance. No new `actionItemSourceType` value; no new polymorphic-FK ratchet; the import is plumbing onto the existing entity. `.xls` (binary 97-2003) is out of scope; multi-tab merges across separate uploads are out of scope; per-attendee field-level encryption of the attendance list is out of scope (1.11 ships one encrypted blob per attendance list — 1.12 absorbs the row-per-attendee shape); cross-workplace import is out of scope (single-tenant); Excel WRITE is Release 2.

### 3.1 `packages/excel-import` workspace scaffolding (pure module + browser-only deps)

`packages/excel-import/` is a new pnpm workspace member, dependency `xlsx` (SheetJS) plus `libsodium-wrappers` for the envelope shape, no Node-only imports anywhere. The workspace exports four entry points:

- `parseWorkbook(arrayBuffer: ArrayBuffer): Promise<DetectionResult>` — the schema detector + parser entry point. Returns `{ kind: 'recognized', schema: 'meeting_minutes', version: 'v1', sheets: ParsedSheets, rawSha256: string }` on success or `{ kind: 'unrecognized', reason: string }` on a workbook the detector cannot classify. Pure: no IO beyond the input ArrayBuffer; no DOM; no fetch.
- `reconcile(parsed: ParsedSheets, existing: ExistingActionItemView[]): ReconciliationPlan` — per-row classification into `created | updated | skipped | conflict_pending`. Pure function over the parsed rows + a projection of the rep's current action_items (which the caller fetches via the typed API client and passes in). `ExistingActionItemView` carries `{id, contentHash, description, startDate, targetDate, section, status, version}` — the projection is non-sensitive metadata only.
- `commit(plan: ReconciliationPlan, opts: { workplacePublicKey: Uint8Array; importId: string }): CommitOperations` — encrypts the sensitive fields under the workplace public key, produces the list of `{kind: 'create' | 'update' | 'skip', clientId, ciphertext, sealedDek, ...metadata}` operations that the route handler consumes. Pure: no fetch; the caller POSTs the result to `/api/excel-imports/:id/commit`.
- `parseWorkbookInWorker(arrayBuffer: ArrayBuffer): Promise<DetectionResult>` — the browser-side helper that posts to `parser.worker.ts` and awaits the response. The worker bundle is built by the consuming app (`apps/web` via `new Worker(new URL('./parser.worker.ts', import.meta.url))`).

The pure-functions shape lets the Vitest suite run the parser + reconciler against fixture workbooks without a DOM. The 1.10 typed-client wrapper pattern (read-Dexie-first + background refresh per ADR-0009 §3.5) does not apply — the import is a one-shot user action, not a routine read/write surface; there is no "import inbox" to reconcile.

### 3.2 SheetJS in a Web Worker (parse off the main thread; the worker contract)

`packages/excel-import/src/parser.worker.ts` is a `Worker` whose entry point reads `event.data: { kind: 'parse', arrayBuffer: ArrayBuffer }` and posts back `{ kind: 'result', result: DetectionResult }` or `{ kind: 'error', message: string }`. The worker contract is intentionally narrow: one message in, one message out, no streaming. The reason is structured cloning — passing the parsed-sheet shape across the worker boundary is cheap for the data sizes (a few hundred rows × dozen columns; well under 10MB), and the simplification of "one round-trip per parse" outweighs any streaming win.

**SheetJS configuration:** `XLSX.read(arrayBuffer, { type: 'array', cellFormula: false, cellHTML: false, cellText: true, raw: false })`. The four flags are load-bearing: `cellFormula: false` disables formula parsing — a workbook with `=cmd|'/C calc'!A0` style formula-injection payloads never gets evaluated; `cellHTML: false` strips Microsoft-generated HTML from cells; `cellText: true` returns the formatted display string (the rep's notes as they typed them); `raw: false` returns strings for every cell type. The threat model (§"Critical guardrails") names formula-injection as a real surface and the parser configuration is the structural mitigation. SheetJS does not execute formulas in any configuration, but `cellFormula: false` removes the formula text from the parsed cell object entirely so it cannot leak into a downstream render.

**Source SHA-256 is computed in the worker.** Before SheetJS parses, the worker computes `sha256(arrayBuffer)` via WebCrypto and includes it in the `DetectionResult.rawSha256`. This is the file-level integrity anchor; the chain payload of `excel_import.uploaded` carries it; re-importing the same bytes yields the same hash → reconciliation classifies every row as skipped.

**The 10MB on-disk + 100MB decompressed bound (per `docs/excel-import-format.md`) is enforced in the worker before `XLSX.read`.** A workbook that decompresses past 100MB rejects with `unrecognized: payload_too_large` before parsing starts. This is the zip-bomb defense (covered in the threat model as T-XI-Z1).

### 3.3 Schema detector (Meeting Minutes v1; tolerance for header variation; strict on sheet presence)

The detector reads the workbook's sheet names and the first-row column headers and matches against `packages/excel-import/src/schemas/meeting-minutes-v1.ts`. The schema is a structured object: `{ requiredSheets: ['Meeting Minutes', 'Agenda', 'NEW BUSINESS', 'OLD BUSINESS', 'NOTICE OF RECOMMENDATION', 'COMPLETED', 'Closed Items History', 'Inspection Review'], optionalSheets: ['_MoveHistory'], columnsBySheet: { ... } }`.

**Header matching is case-insensitive + whitespace-trimmed but presence-strict.** `"new business"`, `"NEW BUSINESS"`, `" New Business "` all match `NEW BUSINESS`; the absence of a `NEW BUSINESS` sheet yields `{ kind: 'unrecognized', reason: "missing required sheet 'NEW BUSINESS'" }`. Column headers within each sheet follow the same rule: `"Issue Description"`, `"issue description"`, `"  Issue Description  "` all match; missing the `Issue Description` column on `NEW BUSINESS` yields `{ kind: 'unrecognized', reason: "sheet 'NEW BUSINESS' missing column 'Issue Description'" }`.

**Partial recognition is a fail-closed, not a partial import.** If two required sheets match and one is missing, the detector returns the unrecognized variant — it never returns a partial `recognized` with a degraded shape. The rep sees an unambiguous error in the UI ("We don't recognize this workbook format — expected sheet 'NEW BUSINESS' but it wasn't found. Compare your workbook to `docs/excel-import-format.md`."). This is the structural cousin of CLAUDE.md non-negotiable #11's "Imported data never bypasses the audit chain" — a partial parse would land partial chain entries; refusing the parse keeps the chain coherent.

**Schema versioning.** The detector currently returns only `version: 'v1'`; a future `v2` schema (e.g. a workbook with reorganized sheet names) lands as a new module in `packages/excel-import/src/schemas/meeting-minutes-v2.ts` and the detector tries v2 first then v1, returning the first match. The detection ordering is in `packages/excel-import/src/schema-detector.ts`. No silent migration between versions; each schema is a separate code path. (No v2 ships in 1.11.)

### 3.4 Per-sheet parsers (meeting metadata + 4 action-item sections + inspection review + closed history)

**Meeting metadata** (`Agenda` sheet): parses meeting date (`YYYY-MM-DD`), quorum (boolean), attendance list (newline-separated names → single string blob). Attendance is sensitive — names appear inline; 1.11 envelope-encrypts the whole attendance string as one ciphertext blob (per §"Out of scope" — per-attendee row-per-name encryption is deferred to 1.12). The meeting metadata becomes a row on `excel_imports` (one meeting per file).

**Action items per section** (`NEW BUSINESS` / `OLD BUSINESS` / `NOTICE OF RECOMMENDATION` / `COMPLETED`): each row becomes an `action_items` candidate. Column → field mapping (per `docs/excel-import-format.md`):

| Excel column         | `action_items` field                                 | Encrypted? | Notes                                                                                                    |
| -------------------- | ---------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `#`                  | (ignored — sequence allocated server-side at commit) | —          | The legacy `#` is for the rep's own reference; not authoritative.                                        |
| `Type`               | `type` (ActionItemType)                              | No         | Mapped via the existing 1.6 taxonomy. Unknown type → `OTHER` + `type_subtype` carries the legacy string. |
| `Issue Description`  | `description_ct`                                     | **Yes**    | Envelope-encrypted.                                                                                      |
| `Recommended Action` | `recommended_action_ct`                              | **Yes**    | Envelope-encrypted.                                                                                      |
| `Start Date`         | `start_date`                                         | No         | Parsed `YYYY-MM-DD`; carries into the content_hash.                                                      |
| `Raised By`          | `raised_by_ct`                                       | **Yes**    | Names appear here.                                                                                       |
| `Follow Up`          | `follow_up_owner_ct`                                 | **Yes**    | Responsible-party name.                                                                                  |
| `Dept`               | `department`                                         | No         | Department code/name; non-PII.                                                                           |
| `Status`             | `status` (ActionItemStatus)                          | No         | Mapped to the 1.6 enum; unknown → `Not Started` with the legacy string in `import_warnings`.             |
| `Risk`               | `risk` (ActionItemRisk)                              | No         | Mapped to Low/Medium/High/Critical.                                                                      |
| `Action Flag`        | (informational; carries into `import_warnings`)      | —          | The flag (🟠 / ✓ / ⬇) is rep-facing UX, not authoritative; computed live from dates.                     |
| `Age (Days)`         | (ignored)                                            | —          | Recomputed live.                                                                                         |

The `section` field is set from the sheet name verbatim: `NEW BUSINESS` → `new_business`, `OLD BUSINESS` → `old_business`, `NOTICE OF RECOMMENDATION` → `recommendation`, `COMPLETED` → `completed_this_period`. The `Closed Items History` sheet maps every row to `section='archived'` with `status='Closed'` and a non-null `closed_date`.

**Inspection review sheet** (read-only): the cells are parsed as a 2D `string[][]` and stored as a JSONB column `excel_imports.inspection_review_snapshot_ct` (envelope-encrypted because the snapshot may contain PII — supervisor names, witness names). The snapshot is **not** promoted to native inspection records — the 1.8 inspection tooling is the going-forward path, and the historical notes remain queryable from the import row for audit purposes only. This is the explicit ROADMAP scope ("Workplace inspection review (read-only — not converted to native inspection records)").

**`_MoveHistory` sheet** (optional, informational): parsed if present and stored on the import row as a JSONB snapshot (`move_history_snapshot_ct`, envelope-encrypted because move-history rows may carry actor names). The native action_item move history (per ADR-0005) is the going-forward source of truth; the legacy snapshot is provenance, not behavior.

### 3.5 PII heuristic (the four-class scanner + when to flag for rep review)

The PII heuristic runs against the parsed cell values **before** envelope encryption — it sees plaintext one last time, classifies, and surfaces flags in the preview UI. Four classes:

- **Name-shape:** `\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b` — ≥2 capitalized words within 60 chars. Matches `"John Doe"`, `"Sarah Johnson"`, `"VP Sarah Johnson"`, `"Dr. Alice Chen"`. False-positive risk on `"Health Safety Committee"` is acceptable — the heuristic is a UX nudge, not a gate.
- **Email:** `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`.
- **Phone (Ontario shapes):** `\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b`.
- **SIN-shape:** `\b\d{3}[-.\s]?\d{3}[-.\s]?\d{3}\b` — 9-digit numbers (Canadian SIN format).

The heuristic runs in `packages/excel-import/src/pii-scanner.ts` as a pure function over each row's cell values, returning `{ row, fieldsWithPII: { description: ['name', 'email'], follow_up: ['name'] }, totalFlags: 3 }`. The preview UI aggregates per-section counts ("12 rows have name-shape data; 3 have email-shape data; 0 have SIN-shape data") and per-row badges so the rep can tap a row and see exactly what was flagged.

**The encrypt-everything-sensitive default stays.** Every action_item row ships with `description_ct`, `recommended_action_ct`, `raised_by_ct`, `follow_up_owner_ct` envelope-encrypted **regardless of PII flag** — the 1.6 contract is binding. The PII heuristic exists for:

- **Preview surfacing** — the rep sees what's about to be sealed before committing. A row flagged with SIN-shape gets a "this looks like an SIN — confirm before commit" affordance; the rep can edit the row to scrub it if it was a typo.
- **Attendance-list nudge** — names in attendance are unavoidable; the heuristic flags them and shows "X attendees identified by name. These will be encrypted at rest. Consider typing roles ('Worker Co-Chair', 'Supervisor A') instead of names for future workbooks." Documentary copy; not a blocker.
- **Source-filename check** — if the file is named `JHSC Minutes [Workplace Name] 2025-Q3.xlsx`, the filename carries the workplace name (a non-negotiable #1 leak surface). The filename is always envelope-encrypted on `excel_imports.source_filename_ct`; the PII heuristic additionally surfaces a "filename contains name-shape data — encrypted at rest" badge in the preview.

The heuristic does **not** auto-scrub. It is a UX surface only. Auto-scrubbing the rep's data would silently rewrite evidence; that's a non-negotiable #2 violation. The rep is always the authority on what the row says.

### 3.6 Reconciliation engine (content_hash matching; create / update / skip / conflict_pending)

The content hash is the deterministic dedup key. Per `docs/excel-import-format.md` and CLAUDE.md Excel Import Rule 5: _"Same Description + Start Date = same item across imports."_

**Hash derivation:** `content_hash = sha256(utf8(canonical(description) || '||' || canonical(start_date)))` where `canonical(s) = s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()` and `canonical(date) = date.toISOString().slice(0,10)`. Pure function in `packages/excel-import/src/content-hash.ts`. The canonicalization is deliberate — `"  Pallet jack repair  "` and `"pallet jack repair"` reconcile as the same item; date timezone drift is collapsed to the `YYYY-MM-DD` slice.

**Reconciliation classification.** For each parsed row, the reconciler computes `contentHash` and consults the existing action_items projection:

- **Create:** no existing row matches the hash → new `action_items` row at commit.
- **Update:** existing row matches the hash AND at least one mutable field differs (target_date, closed_date, status, risk, tags, follow_up_owner, recommended_action) → PATCH at commit with `If-Match: <existing version>` (per ADR-0009 §3.7).
- **Skip:** existing row matches the hash AND no fields differ → no-op; recorded in `excel_import_items` with `status='skipped'` for provenance.
- **Conflict_pending:** existing row matches the hash AND a field differs in a way that suggests genuine ambiguity — specifically: the existing `description` matches the import's `description` (hash already collides) AND the existing `start_date` matches AND the existing row has been **manually edited since its last import** (the row's `version > 1` AND its last `action_item.updated` audit entry was actor-driven rather than import-driven). The conflict surfaces in the preview as a field-level diff.

**Field-level diff for conflicts.** The preview renders a per-field three-column comparison: `current | import | resolution`, with the rep picking `keep current | apply import | edit before commit` per field. This is the same shape as the 1.10 sync_conflicts UI (ADR-0009 §3.7) but scoped to the import preview rather than a separate conflict-resolution view — the import preview IS the conflict resolution surface. After the rep resolves all conflicts, the commit proceeds.

**Idempotent re-imports.** Re-uploading the same `.xlsx` produces the same `rawSha256` and (for unchanged rows) the same `contentHash`. Every row reconciles as `skipped`; the resulting `excel_imports` row records `created_count=0, updated_count=0, skipped_count=N`. The chain anchor still fires (`excel_import.uploaded` and `excel_import.committed`), so re-imports are auditable but produce no data churn.

### 3.7 Preview UI shape (sections + per-row affordances + step-up gated commit button)

The preview view (`apps/web/src/excel-import/preview-view.tsx`) renders the reconciled plan as four collapsible sections — Create, Update, Skip, Conflict — each with a row count badge and a list. Per-row affordances:

- **Keep as-is** (default for create/update; explicit ack for conflict) — accepts the reconciler's classification verbatim.
- **Skip** — flips the row to `excel_import_items.status='skipped'`; the action_item is not touched at commit.
- **Edit before commit** — opens an inline edit panel where the rep can amend any field (description, recommended_action, target_date, status, risk, tags). Edits are applied to the in-memory `ReconciliationPlan` and persisted to Dexie under a `_excel_import_drafts` table so the preview survives a refresh.

**The commit button is step-up gated.** Tap → step-up modal (`requireStepUp({ action: 'excel_import.commit', maxAgeSeconds: 60 })`) → success → POST `/api/excel-imports/:id/commit` with the encrypted operations payload. The freshness window is 60 seconds — same posture as 1.7/1.8/1.9 export commits. The step-up `action` parameter is `excel_import.commit`; per ADR-0009's honest stance, the action-binding is cosmetic until 1.12 ships the action-bound step-up token (the freshness check is the real defense; the action label is for audit-log clarity).

**Per-section summary at the top of the preview** shows: rows-parsed total, by-section breakdown, by-classification counts, PII-flag totals ("18 rows flagged for name-shape data; 4 for email; 0 for SIN"), source filename (shown plaintext to the rep — the filename is encrypted at rest but the rep's own browser session holds it in memory for the duration of the preview), source SHA-256 (truncated, with a "copy" affordance for evidence purposes).

**The "Cancel" button** (top-right) discards the preview without committing. The `excel_imports` row at `status='preview'` is marked `status='cancelled'`; no chain anchor fires on cancel (cancel is not an evidentiary event — the upload anchor already fired; the cancel just closes the window).

### 3.8 `excel_imports` + `excel_import_items` schema (append-only after commit; status enum; audit_idx)

`migrations/0010_excel_imports.sql`. Two tables.

```sql
CREATE TABLE excel_imports (
  id                            uuid PRIMARY KEY,
  imported_by_user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_filename_ct            bytea NOT NULL,          -- envelope-encrypted; may carry workplace name
  source_filename_dek_ct        bytea NOT NULL,
  source_sha256                 bytea NOT NULL,          -- sha256(raw file bytes); 32 bytes
  schema_version                text NOT NULL,           -- e.g. 'meeting_minutes_v1'
  row_count                     integer NOT NULL CHECK (row_count >= 0),
  status                        text NOT NULL CHECK (status IN
                                  ('pending','preview','committed','cancelled','reversed')),
  step_up_jti                   text,                    -- the step-up token's jti at commit time
  meeting_metadata_ct           bytea,                   -- agenda + attendance blob (envelope-encrypted)
  meeting_metadata_dek_ct       bytea,
  inspection_review_snapshot_ct bytea,                   -- read-only JSONB blob (envelope-encrypted)
  inspection_review_dek_ct      bytea,
  move_history_snapshot_ct      bytea,                   -- optional _MoveHistory JSONB (envelope-encrypted)
  move_history_dek_ct           bytea,
  created_count                 integer DEFAULT 0,
  updated_count                 integer DEFAULT 0,
  skipped_count                 integer DEFAULT 0,
  conflict_resolved_count       integer DEFAULT 0,
  audit_idx                     bigint UNIQUE,           -- FK to chain anchor (NULL until committed)
  reverse_audit_idx             bigint UNIQUE,           -- FK to reverse anchor (NULL until reversed)
  created_at                    timestamptz NOT NULL DEFAULT now(),
  committed_at                  timestamptz,
  reversed_at                   timestamptz,
  cancelled_at                  timestamptz
);

CREATE TABLE excel_import_items (
  id                  uuid PRIMARY KEY,
  import_id           uuid NOT NULL REFERENCES excel_imports(id) ON DELETE RESTRICT,
  section             text NOT NULL CHECK (section IN
                        ('new_business','old_business','recommendation',
                         'completed_this_period','archived')),
  content_hash        bytea NOT NULL,                    -- 32 bytes; sha256(canonical(description||start_date))
  action_item_id      uuid REFERENCES action_items(id) ON DELETE RESTRICT, -- populated after commit
  source_row_index    integer NOT NULL,                  -- 0-based row index within the sheet
  source_sheet        text NOT NULL,                     -- 'NEW BUSINESS', 'OLD BUSINESS', etc.
  status              text NOT NULL CHECK (status IN
                        ('created','updated','skipped','conflict_pending','conflict_resolved')),
  import_warnings     jsonb,                             -- legacy values that didn't map cleanly
  pii_flags           jsonb,                             -- {description: ['name'], follow_up: ['name']}
  audit_idx           bigint UNIQUE,                     -- FK to per-row chain anchor (action_item.created/updated)
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX excel_import_items_import_id_idx ON excel_import_items(import_id);
CREATE INDEX excel_import_items_content_hash_idx ON excel_import_items(content_hash);
CREATE INDEX excel_import_items_action_item_id_idx ON excel_import_items(action_item_id)
  WHERE action_item_id IS NOT NULL;
```

**Append-only after commit.** PATCH on `excel_imports` is allowed only while `status IN ('pending', 'preview')`. After `status='committed'`, the only allowed mutation is the reverse path (which flips `status='reversed'` and stamps `reversed_at`). After `status='cancelled'`, the row is frozen. After `status='reversed'`, the row is frozen. Same posture as the 1.8 inspections lifecycle (ADR-0007 §3.6) — terminal states are immutable.

**`source_filename_ct` is encrypted because the filename leaks workplace identity.** A rep who saved the file as `JHSC Minutes [Workplace Name] 2025-Q3.xlsx` would leak the workplace name into Postgres if the column were plaintext. The envelope encryption mirrors the 1.7 evidence pattern; the server holds ciphertext, the workplace private key is in Fly Secrets, decryption requires the reveal path.

**`source_sha256` is plaintext.** It's a content hash, not the content. It's the integrity anchor for the chain; storing it plaintext lets the import index lookup by hash (e.g. "did I already import this exact file?"). No PI in a SHA-256.

**`audit_idx` UNIQUE constraint** enforces 1-to-1 with the chain anchor. The chain row's `idx` is the FK target. Same shape as the 1.6 `action_items.audit_idx`, the 1.7 `evidence_files.audit_idx`, the 1.8 `inspections.audit_idx`, and the 1.9 `recommendations.audit_idx`.

### 3.9 Commit transaction (server-side; allocateSequenceNumber per row; chain anchor emission; single-shot atomicity)

The commit endpoint `POST /api/excel-imports/:id/commit` runs the entire batch in a single Postgres transaction. The request body carries the ordered list of operations:

```typescript
{
  operations: Array<
    | { kind: 'create'; clientId: uuid; section: ActionItemSection; type: ActionItemType;
        descriptionCt: b64; descriptionDekCt: b64; ... ; sourceExcelHash: b64; importItemId: uuid; }
    | { kind: 'update'; actionItemId: uuid; ifMatchVersion: number;
        descriptionCt?: b64; ... ; importItemId: uuid; }
    | { kind: 'skip'; importItemId: uuid; existingActionItemId: uuid }
  >
}
```

The transaction:

1. Verify the step-up token (60s freshness, `action='excel_import.commit'`).
2. Verify the import row is in `status='preview'` and `imported_by_user_id = ctx.user.id`.
3. For each operation in order:
   - `create`: validate `clientId` does not collide (per ADR-0009 §3.3 — collision is a 409); call `allocateSequenceNumber(tx, section)` (per ADR-0005 §3 + `apps/api/src/routes/action-items/index.ts:1085`) inside the transaction; INSERT the `action_items` row with `source_type='excel_import'`, `source_id=NULL` (the 1.6 `excel_import` branch already permits NULL source_id per `apps/api/src/routes/action-items/index.ts:113`), `source_excel_hash=<contentHash>` (the 1.6 forward-seam column); emit the `action_item.created` chain anchor (same shape as the existing 1.6 create path); update the `excel_import_items` row with the new `action_item_id` and the chain anchor's `audit_idx`.
   - `update`: SELECT FOR UPDATE on `action_items` WHERE `id = $1` and `version = $ifMatch`; if version mismatch, ABORT the entire transaction with 409 (the whole batch fails — the rep returns to the preview and re-reconciles); UPDATE the row; emit `action_item.updated`; link to the import item.
   - `skip`: no-op; link the existing `action_item_id` to the import item for provenance; no chain anchor.
4. Stamp `excel_imports`: `status='committed'`, `committed_at=now()`, `created_count`, `updated_count`, `skipped_count`, `conflict_resolved_count`.
5. Emit the batch-level chain anchor `excel_import.committed` with payload `{importId, sourceSha256, schemaVersion, createdCount, updatedCount, skippedCount, conflictResolvedCount}`; the chain row's `idx` is written back to `excel_imports.audit_idx`.
6. COMMIT.

**Why single-shot rather than the 1.10 sync queue.** The 1.10 queue retries per-row on 5xx; for a 200-row import, a partial-failure midway would leave 100 action_items committed and 100 still in the queue, with the batch's `excel_import.committed` anchor unable to fire (the counts would be wrong). The atomicity of the batch is a feature — either the whole import lands or none of it lands. The rep prepares offline (parse + preview + reconciliation decisions) and commits online in one transaction. The runbook documents this; the commit-while-offline path renders "Network required" rather than queueing.

**`allocateSequenceNumber` per row inside the transaction is the right call.** The 1.6 advisory-lock pattern (`pg_advisory_xact_lock(hashtext('action_items.seq.' || section))`) serializes inserts into the same section; concurrent imports for different sections do not contend. A 200-row import into `new_business` holds the advisory lock for the duration of the transaction — measured in low hundreds of milliseconds — which is acceptable at single-tenant scale.

**`action_item.created` for each new row, NOT a single batch chain anchor for the actions.** Each action_item gets its own chain row so the per-item audit trail is uniform with native-create action_items. The `excel_import.committed` anchor is the batch-level provenance row; the per-action_item rows carry `created_by_import_id` in their payload (a new field on the `action_item.created` payload, additive — the existing payload schema absorbs the optional field cleanly).

### 3.10 Step-up posture (60s freshness; action label; CSRF; rate limit)

**Freshness:** 60 seconds, same as 1.7 evidence finalize, 1.8 inspection export, 1.9 recommendation export. The rep authenticates at the start of the import flow → opens the file picker → SheetJS parses → reconciliation runs → preview renders → rep reviews → rep taps commit → step-up modal (typically a passkey on the same device; passwords + TOTP fallback) → commit fires. The 60s window is the upper bound from step-up grant to commit POST. The runbook documents the recovery path if the freshness expires mid-review (a "Re-authenticate to commit" banner appears in the preview).

**Action label:** `excel_import.commit`. Per ADR-0009 §3.6's honest stance, the action label is cosmetic until 1.12 ships action-bound tokens; the freshness check is the real defense. The label exists for audit-log readability ("user U exercised step-up for action `excel_import.commit` at time T") and for the future binding when 1.12 ratchets it in.

**CSRF guard:** the existing `csrfHeaderGuard()` middleware (per `apps/api/src/index.ts`) covers the commit route. The commit POST carries `X-CSRF-Token` from the session; same posture as every other mutation route.

**Rate limit:** the `rateLimit()` middleware bounds per-actor request volume. For 1.11 the import-commit rate limit is **5 imports per actor per hour** (the use case is batch import of historical files; a higher rate suggests a malicious replay attempt). Configured in `apps/api/src/middleware/rate-limit.ts`'s route-specific overrides. The reverse path is bounded at **3 reverses per actor per hour** — same reasoning.

### 3.11 30-day reversibility (walks the chain; emits `excel_import.reversed`; 410 after window)

CLAUDE.md Excel Import Rule 4: _"Imports are reversible for 30 days via the audit log."_

**Reverse endpoint:** `POST /api/excel-imports/:id/reverse`. Step-up gated (60s, `action='excel_import.reverse'`). The handler:

1. SELECT the `excel_imports` row WHERE `id = $1` AND `imported_by_user_id = ctx.user.id` AND `status = 'committed'` AND `committed_at > now() - interval '30 days'`. If any condition fails, return 410 `import_reverse_window_expired` (after 30 days) or 409 `import_not_reversible` (wrong status, wrong actor).
2. Read all `excel_import_items` for this import.
3. For each `created` item: DELETE the linked `action_items` row IF its current state is exactly the imported state (i.e. no subsequent edits — `version = 1`). If the row has been edited (`version > 1`), the reverse fails-closed for that row with `action_item_modified_since_import` and the rep is told to reverse individual edits manually. (We do not silently overwrite the rep's subsequent work.)
4. For each `updated` item: revert the row's fields to the prior state captured in the chain payload of the `action_item.updated` anchor for that import row. Use the chain's payload as the source of truth (the chain is append-only and cryptographically bound; the audit row itself is the rollback record).
5. For each `skipped` item: no-op (skip never touched the row).
6. Stamp `excel_imports.status='reversed'`, `reversed_at=now()`.
7. Emit `excel_import.reversed` chain anchor with payload `{importId, reversedAt, deletedCount, revertedCount, refusedCount}`.

**The reverse path is partial-success-capable.** Some rows revert cleanly; some are refused because the rep edited them after import. The runbook documents this — the rep sees a per-row outcome list ("47 rows reverted; 3 rows refused — edited after import; reverse them manually if desired"). The chain anchor's `refusedCount` records the partial outcome.

**After 30 days the reverse path 410s** with a body that points to the operator-script-only recovery (`scripts/excel-import-reverse.ts`, a Bun script that takes an import_id and a `--force` flag; documented in the runbook but not in the API). Operator-only escalation aligns with the "no automated rollback after the window" posture of evidentiary systems.

**Reverse does NOT delete the `excel_imports` row.** The import row stays at `status='reversed'`; the chain anchor `excel_import.reversed` is the evidentiary record. The deleted action_items are gone but the chain's `action_item.created` rows for them remain (chain is append-only). An arbitration query can reconstruct the timeline: imported at T1 → reversed at T2 → here's what was created → here's what was deleted.

### 3.12 Offline-first interaction (parse + preview offline; commit require-online; rationale for not queueing)

**Parse:** offline. The Web Worker runs entirely client-side; no network required. The rep can upload a workbook on the dock with no LTE and see the parse output.

**Preview:** offline. The reconciler reads the existing `action_items` projection from Dexie (per ADR-0009 §3.1) — the workplace's current list of action_items is cached locally; the reconciliation classifies offline. The preview UI renders offline. The rep can edit rows offline. The reconciliation decisions persist to Dexie under `_excel_import_drafts`.

**Commit:** **require-online**, **fail-closed**. The commit button checks `navigator.onLine + /api/health probe` before opening the step-up modal; offline taps render "Network required to commit. Your reconciliation is saved; commit when you reach a network." The drafts persist; the rep returns later and commits.

**Why not queue the commit through 1.10.** Three reasons, in priority order:

1. **Atomicity.** The 1.10 queue is per-row idempotent + per-row retry. A 200-row import enqueued as 200 operations would commit partially on a mid-drain network blip; the batch-level `excel_import.committed` anchor cannot fire with partial counts. The single-shot transaction guarantees the batch is all-or-nothing.
2. **Step-up freshness.** The 1.10 queue can drain hours after the rep typed; step-up freshness is 60 seconds. A queued commit would never honor the freshness window. (Per ADR-0009 §3.6, step-up flows are explicitly require-online.)
3. **Sequence-number allocation.** Each new action_item allocates a section-scoped sequence number under an advisory lock at commit time. Allocating sequence numbers in the queue worker would mean each row's number depends on the order other queued imports drain — non-deterministic for the rep. The single-shot transaction allocates them in one ordered pass.

The per-row `action_item.created` anchors that the commit emits are NOT queued individually — they're emitted inside the commit's transaction, all at server-time. The chain row order matches the row order in the operations payload, which matches the row order in the preview UI, which matches the row order in the source workbook (sheet-then-row). Deterministic; reviewable.

### 3.13 Slice plan

- **S0 — architect + threat-modeler.** This ADR + a `SECURITY.md` §2.11 "Excel Import" pass with T-XI1..T-XIn threats. Threat model covers: formula-injection via cell content (mitigation §3.2's `cellFormula: false`), zip-bomb / XML-entity-expansion in `.xlsx` ZIPs (mitigation: 10MB + 100MB bounds + SheetJS's hardened parser), XSS via cell content in the preview render (mitigation: React's escape-by-default + textContent-only renderer), PII leakage in the source filename (mitigation: envelope encryption), source-SHA-256 chain-binding tampering (mitigation: hash computed in the worker before parsing; transparent to the rep), content_hash collision attack (mitigation: sha256 collision space is structurally negligible; behavior on collision is "treat as same item" which is safe), reverse-window expiry race (mitigation: server-side `now()` comparison; not client-side), step-up bypass on commit (mitigation: 60s freshness + action label + CSRF), commit-mid-network-drop atomicity (mitigation: single Postgres transaction; rollback on any failure), and the legal-citation-auto-import refusal (mitigation: documented in §3, refused at the parser layer — the parser does NOT emit `recommendation_citations` rows).
- **S1 — `packages/excel-import` scaffolding + migration 0010 + shared-types + `docs/excel-import-format.md`.** Workspace scaffolded (`package.json` + `tsconfig.json` + entry points exporting the four functions per §3.1). Migration 0010 adds `excel_imports` and `excel_import_items` per §3.8. `packages/shared-types` additions: `ExcelImportStatus`, `ExcelImportItemStatus`, `ExcelImportSchemaVersion` (currently `'meeting_minutes_v1'` only), `DetectionResult`, `ReconciliationPlan`, `ParsedSheets`, three new `AuditEventKind` values (`excel_import.uploaded`, `excel_import.committed`, `excel_import.reversed`). `docs/excel-import-format.md` is fleshed out from the existing placeholder into the authoritative schema spec — sheet-by-sheet column tables, the canonicalization rules for `content_hash`, the error-message table the detector returns.
- **S2 — parser + detector + PII heuristic + reconciliation engine + Web Worker + commit route + reverse route.** `packages/excel-import/src/parser.worker.ts` + `schema-detector.ts` + per-sheet parsers in `src/parsers/*.ts` + `pii-scanner.ts` + `content-hash.ts` + `reconciler.ts` + `commit-builder.ts`. `apps/api/src/routes/excel-imports/index.ts` with the upload-record / commit / reverse handlers (the upload-record handler creates the `excel_imports` row at `status='preview'` and emits `excel_import.uploaded`; the commit handler runs the transaction per §3.9; the reverse handler walks the chain per §3.11). Integration tests: parse a fixture workbook, run reconciliation, post commit, verify chain anchors fire in order, verify `action_items` rows land with correct `source_type` + `source_excel_hash`, verify a re-import yields zero new rows, verify a reverse within 30 days rolls back cleanly, verify a reverse after 30 days returns 410, verify a step-up-expired commit returns 401 and the `excel_imports` row stays at `status='preview'`.
- **S3 — web UI for upload + preview + per-row affordances + commit button.** `apps/web/src/excel-import/upload-view.tsx` (file picker + drag-drop + Web Worker invocation + progress bar). `preview-view.tsx` (four collapsible sections + per-row diff + edit panel + per-section PII summary + step-up gated commit button). `import-history-view.tsx` (list of prior imports with status badges; tap into a committed import → see its row-level provenance; reverse button on committed imports within the 30-day window). Tests: preview renders correctly for create/update/skip/conflict mixes, per-row edit persists to Dexie, step-up freshness expiry surfaces the banner, network-offline commit blocks with the "Network required" copy.
- **S4 — integration tests + acceptance fixtures.** `packages/excel-import/test/fixtures/*.xlsx` with: a clean Meeting Minutes v1 workbook, a workbook with the `Inspection Review` snapshot populated, a workbook that re-imports cleanly (idempotency test), a workbook with a row that conflicts against an existing action_item, an `.xls` binary file (rejected by detector — wrong format), a workbook missing the `NEW BUSINESS` sheet (rejected by detector), a workbook with formula-injection payloads in cells (parser strips per §3.2), a 9.5MB workbook (accepted), an 11MB workbook (rejected by size gate), a zip-bomb workbook (rejected by decompressed-size gate). Vitest suite runs all fixtures + parses + reconciles + asserts. Playwright e2e covers the upload + preview + commit + reverse end-to-end.
- **S5 — independent security + privacy reviewers.** Same pattern as 1.4 / 1.5 / 1.6 / 1.7 / 1.8 / 1.9 / 1.10. Threat-model close-out lands operational findings into `docs/runbooks/excel-import.md`. The runbook absorbs: the parse-in-worker contract, the schema-detector failure modes, the PII heuristic's false-positive rate and how the rep should read it, the reconciliation classification rules, the step-up freshness UX, the 30-day reverse window + the operator-script-only escalation past the window, the legal-citation-auto-import refusal + the citation-picker recovery path, and the "what 1.12 needs to absorb" stub.

## Consequences

### Positive

- **Non-negotiable #11 is structurally honored.** The raw file never leaves the browser; SheetJS runs in a Web Worker; sensitive fields are envelope-encrypted under the workplace public key before any API call; the server only ever sees ciphertext + non-PI metadata. The threat model treats the browser as the trust boundary for the file bytes and the workplace private key as the trust boundary for plaintext decryption — both bounds are structural, not policy.
- **The migration path from spreadsheet workflow to native app is the rep's own ratchet.** Reps re-import the same workbook quarterly; the content_hash reconciliation makes that idempotent. A new quarter's workbook produces N new rows; the rest reconcile as `skipped`. The rep is not asked to delete-and-replace their historical data; the data accumulates into the native app layer-by-layer.
- **The chain anchor is the legal-grade migration record.** Every import emits `excel_import.uploaded` (preview state) + `excel_import.committed` (commit state) + per-action_item `action_item.created`/`action_item.updated` rows. An arbitrator six months later can run `scripts/audit-log-verify.ts` and see the exact byte-hash of the source workbook, when it was committed, by whom, what it created, and the integrity of the chain. The `source_sha256` is the integrity anchor — the file's bytes are not stored but their hash is, and re-importing the same bytes yields the same hash.
- **The existing `excel_import` source_type forward-seam is consumed without churn.** The 1.6 close-out left `source_type='excel_import'` permitted in the generic action-items create route with `source_id` optional (`apps/api/src/routes/action-items/index.ts:113,139`); the `source_excel_hash` column was reserved in `migrations/0005_action_items.sql:36`. 1.11 uses both without any new ratchet on the action_items table.
- **No new polymorphic-FK ratchet.** ADR-0007 §3.7 + ADR-0008 §3.5 extended the linked_type pattern; 1.11 doesn't. The `excel_import_items.action_item_id` FK is a uni-directional join; no polymorphic shape required.
- **The 1.4 corpus-only-citations gate extends naturally.** The parser flags clause-shape strings ("s.25(2)(h)") in the preview UI for the rep's awareness but does not write a `recommendation_citations` row. The rep adds citations via the picker after import; the corpus remains the single source of truth.
- **Preview UI is the conflict-resolution surface.** Per ADR-0009 §3.7 the sync_conflicts UI is a separate full-screen view for one-row-at-a-time conflicts; the import preview is a batch view for many-rows-at-once conflicts. The two UIs reuse the field-level-diff component (`apps/web/src/components/field-diff/field-diff-card.tsx`) — the visual vocabulary is consistent.

### Negative / accepted tradeoffs

- **SheetJS is a sizable browser dependency.** The `xlsx` package adds ~600KB gzipped to the web bundle. The mitigation is dynamic import — `packages/excel-import/src/index.ts` is loaded only when the rep opens the import view (`apps/web/src/excel-import/upload-view.tsx`); the home and minutes views never pull it. The bundle-budget linter (per 1.10 §"Don't") flags any non-dynamic import of the workspace from outside `apps/web/src/excel-import/`.
- **The PII heuristic is best-effort.** False positives on "Health Safety Committee" or "Pallet Jack Replacement" (capitalized two-word phrases that aren't names) are acceptable — the heuristic is a UX nudge, not a data gate. False negatives on lowercase names ("john doe") or non-Western name shapes are real. The rep is always the authority; the documentary copy in the preview says "PII heuristic — review your data before commit."
- **The commit is online-required.** A rep who prepared a preview offline and then drove home to a network-free apartment cannot commit. The reconciliation drafts persist (per §3.12); they commit when the rep next reaches a network. Documented in the UI; the offline-first promise of 1.10 is not extended to commit, by design.
- **The `Inspection Review` snapshot is read-only.** Reps with years of inspection notes in their workbooks see them surface as a static blob in the import row; they do not become queryable inspection records (the 1.8 schema is the going-forward path, and the legacy notes don't map cleanly to the template-pinned model). The runbook explains this; the threat model treats the snapshot as evidentiary-grade-at-rest but not first-class behavioral data.
- **Attendance is one encrypted blob.** Per-attendee field-level encryption (one row per attendee) is deferred to 1.12. The 1.11 shape stores the whole attendance string as one ciphertext; the rep cannot query "did Alice attend the Q3 meeting?" without revealing the whole list. The mitigation is the reveal route (which decrypts on demand for the rep's eyes) — search-by-attendee is a 1.12 feature.
- **The reverse path is partial-success-capable.** A rep who imported, then edited 3 rows, then tried to reverse, gets back 47 rows reverted + 3 refused. They have to reverse the 3 edits manually if they want a full rollback. The mitigation is the per-row outcome list in the reverse UI; the rep sees exactly what didn't roll back and why.
- **The 30-day window is hard-coded.** A rep who realizes on day 31 they want to reverse must escalate to the operator script. The 30-day bound comes from CLAUDE.md Excel Import Rule 4; widening it to (say) 90 days would mean keeping prior-state payloads in the chain for longer, which is fine but breaks the documented contract. The script-based escalation is the safety valve.

### Risks

- **A bug in the schema detector lets a near-recognized workbook commit partial garbage.** Mitigation: the detector returns `recognized` only when ALL required sheets + ALL required columns match; any miss returns `unrecognized`. Unit tests in S2 cover the missing-sheet, missing-column, renamed-column, and case-variation matrix.
- **A bug in `content_hash` canonicalization produces hash drift between imports.** Mitigation: pure function (`canonicalContentHash` in `packages/excel-import/src/content-hash.ts`); unit-tested with NFC vs NFD inputs, whitespace variants, case variants, and ISO date format vs Excel serial date. A drift would produce false `create` classifications (the system would create duplicate action_items); the duplicate-detection check at commit time (per `excel_import_items.content_hash_idx`) is the second-line defense.
- **A bug in the commit transaction lets a partial batch land.** Mitigation: Postgres transaction discipline; any per-row failure aborts the whole transaction; the `excel_imports.status` stays at `preview`. The integration test in S4 simulates a mid-transaction `If-Match` mismatch and asserts the entire batch rolls back.
- **The Web Worker contract leaks the parsed plaintext if the worker is reused across imports.** Mitigation: the worker terminates after each `parse` message (`worker.terminate()` in `parseWorkbookInWorker`'s `finally` block); a new worker spins up per parse. Documented in the runbook; the threat model treats the worker as ephemeral.
- **A malicious workbook with a 100MB decompressed size targets the parse-step memory ceiling.** Mitigation: the worker checks `arrayBuffer.byteLength <= 10*1024*1024` before SheetJS parse; SheetJS itself enforces the decompressed-size bound via its hardened parser (per `xlsx` security advisories). The threat model treats this as T-XI-Z1.
- **A rep's device clock can skew the `created_at` on the `excel_imports` row.** The server's `created_at = now()` is the canonical timestamp; the client doesn't influence it. The chain anchor's `ts_ms` is server-side. Documented; no risk.
- **The source_sha256 cannot be verified without the source file.** A rep who deletes the source workbook after import loses the ability to prove they imported THIS file. Mitigation: the rep is encouraged in the preview UI ("This file's SHA-256 is X. Save the file alongside your evidence backup; the chain anchors to this hash."); the runbook covers the recommended archival posture.

## Compliance check

- **#2 chain-of-custody.** Every import produces three classes of chain anchors: the file-level (`excel_import.uploaded`, `excel_import.committed`, `excel_import.reversed`); the per-row (`action_item.created`, `action_item.updated` on every created/updated row); and the integrity anchor (the `source_sha256` in the upload + commit payloads). An arbitrator can reconstruct: who imported what, when, from what file hash, with what outcome, plus the per-row creation timeline. No queued mutation bypasses the chain.
- **#4 privacy-by-default + minimize collection.** Sensitive fields (descriptions, recommended_actions, raised_by, follow_up_owner, attendance, source filename, inspection-review snapshot) are envelope-encrypted under the workplace public key client-side before any API call. The server stores ciphertext; the workplace private key is in Fly Secrets; decryption requires the reveal path with step-up. The PII heuristic surfaces what's about to be encrypted so the rep can scrub before commit. No analytics on the imported data.
- **#5 legal citations from corpus only.** The parser flags clause-shape strings in the preview as a UX nudge but does NOT write `recommendation_citations` rows from cell content. The rep adds citations via the post-import picker; the corpus (per ADR-0003) remains the single source of truth.
- **#9 mobile-primary.** The upload + preview UI is mobile-primary — bottom-tabbed section view, sticky bottom commit button, full-screen detail on phone, slide-over on desktop. The file picker accepts iOS Safari's document-picker output (since iOS 13+); workbook-on-phone is a real use case for a rep migrating from email attachments. Per the runbook, the rep can upload a 1MB Q3 minutes file from their phone in the parking lot.
- **#10 restrained legal-grade aesthetic.** The preview UI is a four-section accordion + a per-row card list, no marketing flourish. The PII flag badges are zinc + a small icon, no celebratory animation. The commit button is plain accent-blue; the step-up modal is the existing 1.7/1.8/1.9 modal.
- **#11 Excel imports browser-only + sensitive-fields-encrypted-before-sync + audit-chain integrity.** The dominant non-negotiable for this milestone. Honored structurally per §3.1 (no Node deps), §3.2 (Web Worker), §3.5 (envelope encryption), §3.8 (encrypted source_filename + sensitive columns), §3.9 (chain anchors on commit).
- **#12 action items first-class.** Imports create action_items via the same row shape and chain semantics as the native create route. The `excel_import_items` table is a provenance join, not a parent — the action_item is the entity; the import row is the inverse linkage. No "imported action items" sub-concept.
- **#16 step-up + audit on every export.** No export in this milestone (the import is intake, not output). But the commit IS step-up + audit-logged with the source file's SHA-256 — same posture as exports.

## Follow-ups

- [ ] Threat-modeler: append `SECURITY.md` §2.11 "Excel Import" with T-XI1..T-XIn threats + mitigations (formula-injection via cells, zip-bomb / XML entity expansion, XSS via cell content render, source-filename leakage, PII heuristic false-negatives, content_hash collision behavior, reverse-window race, step-up bypass on commit, commit-mid-network-drop atomicity, legal-citation-auto-import refusal, Web Worker plaintext leakage across imports, source-SHA-256 chain-binding tampering, schema-detector partial-recognition fail-closed).
- [ ] S1: `packages/excel-import` scaffolding + migration 0010 (excel_imports + excel_import_items) + shared-types additions (`ExcelImportStatus`, `ExcelImportItemStatus`, `ExcelImportSchemaVersion`, `DetectionResult`, `ReconciliationPlan`, three `AuditEventKind` values) + `docs/excel-import-format.md` authoritative schema spec.
- [ ] S2: Web Worker parser + schema detector + per-sheet parsers + PII heuristic + content_hash canonicalization + reconciler + commit-builder + `POST /api/excel-imports` (upload-record) + `POST /api/excel-imports/:id/commit` + `POST /api/excel-imports/:id/reverse` + integration tests covering the full happy path + the idempotent re-import + the 30-day reverse + the post-window 410 + the step-up freshness expiry + the partial-batch rollback on If-Match mismatch.
- [ ] S3: upload view + preview view (four section accordion + per-row diff + edit panel + PII summary + step-up gated commit) + import-history view + the reverse confirmation modal + the "Network required" banner on offline commit attempt.
- [ ] S4: fixture workbooks (clean, re-import, conflict, .xls reject, missing-sheet reject, formula-injection, oversized, zip-bomb) + Vitest suite + Playwright e2e covering upload → preview → commit → reverse.
- [ ] S5: security + privacy reviewers.
- [ ] Runbook: `docs/runbooks/excel-import.md` covering the parse-in-worker contract (worker terminates per parse; no plaintext leakage across imports), the schema-detector failure modes (specific error messages + the recovery — compare to `docs/excel-import-format.md`), the PII heuristic's false-positive / false-negative behavior (the rep is the authority), the reconciliation classification rules (create / update / skip / conflict_pending), the step-up freshness UX (re-auth banner if 60s expires mid-review), the 30-day reverse window + the operator-script escalation past the window (`scripts/excel-import-reverse.ts --force`), the legal-citation-auto-import refusal + the citation-picker recovery path, the chain-anchor structure (file-level + per-row + integrity anchor), and the source-file archival recommendation (save the file alongside the evidence backup; the chain binds to its SHA-256).
- [ ] **1.12 (Release 1 hardening) absorbs:** the action-bound step-up token (cosmetic action label becomes load-bearing); per-attendee row-per-name encryption on the meeting metadata (replaces the 1.11 one-blob shape with one row per attendee, queryable by attendee); the `.xls` (binary 97-2003) fallback parser if the operator decides it's worth the dependency cost (defer; 1.11 stance is .xlsx + .xlsm only); automated content_hash dedup detection across multiple imports (if the same content_hash appears in two separate `excel_imports` rows, surface as a deduplication warning rather than two separate `created` events); the source-filename-PII detector with a stronger heuristic (the 1.11 envelope-encrypts the filename regardless, but a stronger heuristic could rename-suggest in the upload UI before parse); a reverse-window admin UI for the co-chair (currently operator-script-only past 30 days).
- [ ] **Release 2 absorbs:** Excel WRITE — a native-to-Excel export of the minutes, mirroring the import schema, so reps who still need to share with non-app stakeholders can produce a workbook from the native data. Round-trip integrity test: import workbook A → export workbook B → assert content equivalence (modulo the integrity anchor changes).
- [ ] **Release 3 absorbs:** AI-assisted reconciliation (Adversarial Lens for the import preview — "the imported description differs from the existing row by these phrases; here's what management might argue about each variant"). Opt-in per non-negotiable #3.
- [ ] `.context/decisions.md` entry referencing this ADR.
