# Excel Import Runbook (Milestone 1.11)

Operational reference for the Excel-import surface. Covers the upload +
parse + preview + commit + reverse lifecycle, the browser-side sealed-
box encryption posture, the PIPEDA Principle 9 stance, the lost-device
threat model, and the 1.12 hardening backlog the S5 reviews landed.

Audience: the worker co-chair, the rep team, and an operator on the
escalation rotation. Read in order; the §11 backlog is the contract for
what is intentionally deferred.

Related references:

- `docs/adr/0010-excel-import.md` — architectural decisions + risk
  framing.
- `SECURITY.md §2.11` — threat model entries T-X1..T-X53.
- `docs/excel-import-format.md` — supported workbook schema.

---

## 1. Schema overview

Two tables back the import lifecycle (`migrations/0010_excel_import.sql`):

- **`excel_imports`** — one row per uploaded workbook. Status walks
  `pending → preview → committed | cancelled`; a committed import can
  later flip to `reversed` via the 30-day reverse path. Five `*_at`
  timestamps trace the state machine; the
  `excel_imports_state_consistency_check` CHECK enforces every
  `(status, *_at)` tuple is coherent so a drifted route cannot land a
  contradictory row.
- **`excel_import_items`** — one row per parsed action_item from the
  workbook. UNIQUE `(import_id, content_hash)` collapses same-hash
  duplicates within one import. The `before_state_json` JSONB captures
  the pre-import snapshot the 30-day reverse restores from.

Three encrypted column pairs on `excel_imports` carry sensitive data
(S5 sec-F1 / sec-F2 / priv-F6 close-outs):

| Pair                                          | Purpose                                                                               | Source                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| `source_filename_ct + source_filename_dek_ct` | Source filename (T-X19 / T-X45)                                                       | Sealed-box from browser |
| `inspection_review_snapshot_ct + _dek_ct`     | Inspection Review JSONB (T-X13 / T-X46)                                               | Sealed-box from browser |
| `meeting_metadata_ct + _dek_ct`               | Meeting metadata blob (attendance + meeting_date + quorum + workbook_version) (T-X48) | Sealed-box from browser |

Plus `source_sha256` (plaintext — a content hash is not the content;
T-X43).

**Trigger ratchet.** Migration 0010 promotes the `'excel_import'`
branch of `action_items_source_fk_guard` from a no-op skip (legacy
0007/0008 posture) to a fail-closed branch: an `action_items` row with
`source_type='excel_import'` MUST point its `source_id` at an existing
`excel_imports.id` (the batch row, not the per-row join). The route's
Zod refinement is the upstream gate; the trigger is the DB-layer
backstop against a hand-crafted INSERT.

---

## 2. Upload + parse + preview + commit flow

The rep walks three phases (`apps/web/src/views/new-excel-import-view.tsx`):

1. **Upload.** Drag-drop or file-picker; the
   `apps/web/src/excel-imports/upload-drop-zone.tsx` component accepts
   `.xlsx` / `.xlsm` up to 10 MB only. A `<details>` block surfaces the
   data-handling posture (S5 priv-F15 close-out).
2. **Preview.** SheetJS runs in a Web Worker
   (`packages/excel-import/src/parser.worker.ts`); the parser produces
   `ParsedSheets { metadata, newBusiness, oldBusiness, recommendations,
completed, closedHistory, inspectionReview, validationErrors }`. The
   reconciler then classifies every row as `create / update / skip /
conflict_pending` against the existing `action_items` pool. The PII
   heuristic runs across every per-row action_item field + the source
   filename + the Minutes attendance + the joined Inspection Review
   snapshot (S5 priv-F5 close-out).
3. **Commit.** Step-up gated (60s freshness, action
   `excel_import.commit`); single-shot transaction allocates per-row
   sequence numbers, INSERTs action_items, emits per-row
   `action_item.created` / `action_item.updated` chain anchors (with
   the additive `createdByImportId` field), then the batch-level
   `excel_import.committed` anchor.

The rep can `cancel` from `pending` or `preview` (no chain anchor;
sec-F13 / §11 backlog) or `reverse` from `committed` (within 30 days,
step-up gated, 3/hour rate limit).

**Safe-parse flags.** SheetJS is configured with `cellFormula: false`,
`cellHTML: false`, `cellNF: false`, `cellDates: true`. Formula-injection
payloads (`=HYPERLINK(...)`, `=cmd|...!A0`, DDE-style) are stripped at
parse; the display string survives. T-X5 details the bound.

---

## 3. Browser-side sealed-box encryption (S5 sec-F1 / sec-F2 / priv-F6 close-out)

Prior to S5, three sensitive import-level fields crossed the wire in
plaintext JSON and got envelope-encrypted on the server:

- the source filename (workplace-name leak per non-negotiable #1),
- the Inspection Review snapshot (supervisor + witness names per T-X13),
- the Meeting metadata blob (attendance list per T-X14).

The two independent reviews flagged this as a non-negotiable #11 breach:
"sensitive fields encrypted client-side before server sync". S5 lands
the fix: every sensitive import-level field is sealed-box-encrypted in
the BROWSER using libsodium's `crypto_box_seal` against the workplace
public key, before any API call. The server stores the bytes as-is;
the workplace private key is held under the master KEK and opened
one-shot at decrypt time (mirror of the 1.7 evidence reveal pattern).

**Wire format (v=0x02 envelope, browser → server):**

```
ciphertext = 0x02 || nonce[24] || crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, dek, nonce)
sealed_dek = crypto_box_seal(dek, workplace_public_key)
```

Both are base64-encoded for transit; the route's Zod schema accepts
`{sourceFilenameCt, sourceFilenameSealedDek, ...}` only — the legacy
plaintext `sourceFilename` field is `.strict()`-rejected with HTTP 400.

**Workplace public key cache.** The view fetches the workplace public
key from `/api/auth/session` at boot. The
`apps/web/src/excel-imports/crypto.ts:getOrRefreshWorkplaceKey()` helper
re-fetches if the cache is older than 1 hour, limiting the
workplace-key-rotation-during-preview surface (T-X33 / priv-F16). A
key rotation that races a long preview still surfaces as a 409 from the
route on save attempt; the rep re-fetches via a reload.

**Reveal path.** The GET `/api/excel-imports/:id` detail handler is
step-up-gated (action `excel_import.read`, 60s freshness). Without
fresh step-up the response is the structural metadata shape with
`sourceFilename: null + sourceFilenameMasked: true`; the UI renders
"tap to reveal" and dispatches the step-up modal. With fresh step-up
the handler opens the workplace private key (one-shot, zeroed
immediately), decrypts the three sealed fields, and returns the
plaintexts. T-X50 documents the posture.

---

## 4. `content_hash` reconciliation

Every parsed row's content_hash is
`sha256(canonical(description) || '|' || canonical(start_date))`. The
canonicalization (`packages/excel-import/src/canonical.ts`) is pinned:
NFC-normalize → trim → collapse whitespace → lowercase for description;
ISO YYYY-MM-DD with round-trip calendar validation for date. The same
input on different runtimes / platforms produces the same hash.

The reconciler classifies each parsed row:

- **create** — no existing action_item matches the hash → INSERT at
  commit with `source_type='excel_import'`, `source_id=<importId>`.
- **update** — match + ≥1 mutable field differs → PATCH at commit
  with `If-Match: <existing version>`.
- **skip** — match + no fields differ → no-op; the
  `excel_import_items` row records the provenance link.
- **conflict_pending** — match + the existing action_item was edited
  since its prior import → preview UI surfaces the field-level diff;
  rep must resolve before commit.

**Cross-section transitions.** A row that moves NEW BUSINESS → OLD
BUSINESS across quarters hashes the same (section is intentionally NOT
in the hash per T-X22); the reconciler classifies as `update` and the
diff surfaces the section transition.

**Cross-import duplicates.** A re-imported workbook (same content_hash
within the same import) collapses to one row via the UNIQUE
`(import_id, content_hash)` index; a re-imported workbook across two
imports of the same `source_sha256` reconciles to skips (the
idempotent re-import path per ADR §3.6).

---

## 5. Server-side reconciliation re-run (S5 sec-F3 close-out)

The security review flagged that the commit handler's conflict gate
trusted `excel_import_items.status` — a client-supplied field. A rep
who fabricated `status: 'created'` on every row in the POST body could
bypass the conflict-resolution UI entirely.

S5 lands a server-side re-reconciliation. At commit time the route:

1. Pulls every `excel_import_items` row + the `content_hash` bytes.
2. For every row asserted as `'created'`, cross-joins against the live
   `action_items` pool — `JOIN action_items ON ai.id =
eii.action_item_id` for rows that already provenance-link to a live
   row, filtered to non-Cancelled rows in the same workplace.
3. Any collision surfaces as a 422
   `conflicts_detected_server_side` response with the offending content
   hashes; the rep must re-open the preview and reconcile.

The client's `item.status` is now ADVISORY ONLY. The server is the
canonical reconciler. The browser-side reconciler stays as the preview
surface; the server-side re-run is the load-bearing audit invariant
(T-X47).

**Idempotent retry.** The per-row INSERT into `action_items` carries
`ON CONFLICT (id) DO NOTHING`. A 5xx mid-commit (not cached by the
Idempotency-Key middleware) + retry walks the handler again; the
per-row INSERT is now idempotent against the prior attempt's
`clientId`. T-X53 / sec-F6 close-out.

---

## 6. PII heuristic (S5 priv-F5 close-out)

The heuristic in `packages/excel-import/src/pii.ts` is a pure function
with four classes:

| Class        | Shape                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| `nameShape`  | ≥2 capitalized words in close proximity ("John Doe", "Dr. Alice Chen") |
| `emailShape` | RFC-ish `local@domain.tld`                                             |
| `phoneShape` | NANP 10-digit shapes with optional separators                          |
| `sinShape`   | Canadian SIN (9-digit) — intentionally loose; over-flags on purpose    |

The heuristic runs across four surfaces post-S5:

1. The per-row action_item fields (description, recommendedAction,
   raisedBy, followUpOwner).
2. The source filename (S5 priv-F5).
3. The Minutes attendance string (S5 priv-F5).
4. The joined Inspection Review snapshot cells (S5 priv-F5).

The reconciliation summary's PII rollup surfaces three extra
documentary nudges ("filename may carry name/email/phone shape",
"attendance list contains name-shape entries", "inspection-review
snapshot contains name/phone/SIN shape").

**The heuristic is a UX nudge, not a data gate.** Every sensitive
column is sealed-box-encrypted before upload regardless of the flag.
The flag is a documentary chance to scrub before commit.

**False positives.** "Health Safety Committee" reads as a name-shape;
the SIN regex over-flags phone-shape strings (the two regex classes
overlap for 3-3-4 vs 3-3-3 patterns — sec-F9 / priv-F13). The
documentary stance is "over-flag on purpose; the rep is the authority".
A future 1.12 tooltip can disambiguate the SIN/phone overlap.

**False negatives.** Single-token names ("Garcia"), lowercase names
("john doe"), obfuscated emails ("name [at] domain"). Documented in
T-X17.

---

## 7. Commit step-up + rate limit

The commit + reverse routes are step-up gated:

- **Freshness floor.** 60 seconds — the step-up grant must have been
  issued within the last 60s of the request. The action label
  (`excel_import.commit` / `excel_import.reverse` / `excel_import.read`)
  is cosmetic until 1.12 lands action-bound tokens with a jti pin on
  the `excel_imports.step_up_jti` column (T-X26 honest stance).
- **Per-actor rate buckets.** 5 commits/hour, 3 reverses/hour
  (in-memory token bucket per `apps/api/src/routes/excel-imports/
index.ts`). A `pg-boss`-backed limiter is a 1.12 follow-up.
- **CSRF guard.** Every mutating route requires
  `X-Requested-With: jhsc-web` (the typed client at
  `apps/web/src/excel-imports/api.ts` sets it on every call).
- **Idempotency-Key.** The 1.10 idempotency middleware caches 2xx + 409
  responses; 5xx is intentionally not cached. S5 sec-F6 close-out: the
  per-row INSERT now carries `ON CONFLICT (id) DO NOTHING` so a 5xx +
  retry doesn't PK-violate.

---

## 8. 30-day reverse path

The reverse route is the operational rollback. Window is 30 days from
`committed_at`; past the window the route returns 410
`import_too_old_to_reverse`. Within the window:

- **Created rows** (where `action_items.version = 1`): soft-delete via
  `status='Cancelled' + section='archived'` (chain-of-custody
  preservation — the chain row's `action_item_id` reference stays
  valid, only the row's status flips).
- **Created rows** (where `version > 1`): refused; the rep's
  subsequent edits are preserved.
- **Updated rows**: the original pre-import field values from
  `before_state_json` are restored; subsequent edits beyond the
  import's bump (version > ifMatchVersion + 1) refuse.

The reverse handler emits a single `excel_import.reversed` chain anchor
with `{deletedCount, revertedCount, refusedCount}` counts. T-X36 /
T-X38 document the partial-success semantics.

**Post-30-day escalation.** An operator script
(`scripts/excel-import-reverse.ts --force`, deferred to 1.12) is the
escalation path. The script emits the same anchor with an additional
payload field `{viaOperatorScript: true, operatorUserId, justification}`
so the chain still records the rollback (T-X39).

---

## 9. PIPEDA Principle 9 stance

The default-refuse stance from 1.6 action_items + 1.9 recommendations
extends to the Excel-import surfaces. Per-surface posture:

| Surface                                                                    | Stance                                                                                                          | Recovery                                                                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `excel_imports` row (filename, sha256, schema_version)                     | Default-refuse post-commit. The chain anchors the row; redaction would fork the chain.                          | Reverse the import within 30 days to undo the committed action_items; the `excel_imports` row itself stays as evidentiary record. |
| `excel_import_items.before_state_json`                                     | Default-refuse post-commit. The JSONB carries the pre-import snapshot the reverse path restores from.           | Same as above.                                                                                                                    |
| Encrypted snapshot pairs (filename / inspection_review / meeting_metadata) | Default-refuse post-commit. Sealed under the workplace public key; redaction requires the operator-script path. | Reverse the import; the snapshots stay encrypted at rest.                                                                         |
| Per-action_item description fields                                         | Inherits 1.6 P9 stance (default-refuse + per-action_item redaction sub-path).                                   | Use the action_items redaction flow; the reverse path is orthogonal.                                                              |

The rep facing a P9 request 6 months post-commit must reverse + re-
import with the request's redactions applied to the source workbook,
or escalate to the operator script. The runbook is the authoritative
record of this stance.

---

## 10. Lost-or-stolen device during preview

The preview state lives in React `useState` only in 1.11 (Dexie
persistence is intentionally deferred — see §11 backlog item).
Consequences for a forensic adversary:

- **The parsed cells** sit in JS heap of the browser tab for the
  duration of the review. Same surface as the 1.10 T-S1 / priv-F1
  IndexedDB plaintext residual: the rep-typed sensitive content is
  ephemeral in 1.11 (no IndexedDB at-rest leak), but a forensic dump
  of the running tab's heap can recover the bytes until commit.
- **The sealed-box-encrypted ciphertext** is the only thing that
  crosses the wire. A wire-side adversary sees opaque bytes.
- **The workplace private key** stays under the master KEK on the
  server; the browser cannot decrypt the ciphertext post-upload.

Lost-device incident response (mirror of `docs/runbooks/auth.md`):

1. Revoke the rep's session via the auth runbook.
2. Escalate to the operator if the workbook contained
   high-sensitivity content (witness statements, accommodation
   details). The operator reviews the audit chain for the affected
   import + any committed action_items.
3. The rep re-uploads from a clean device; the content_hash
   reconciliation collapses the re-imported rows to skips against the
   already-committed pool.

**Tab eviction.** iOS Safari evicts tabs aggressively under memory
pressure. A rep on phone may lose the preview state mid-review. The
S5 review (priv-F4) flagged the Dexie persistence as a HIGH finding;
per user authorization the Dexie persistence is DEFERRED to 1.12 (see
§11). The runbook documents the bound; the rep accepts the
re-upload-on-tab-eviction posture in 1.11.

---

## 11. 1.12 hardening backlog (S5 review deferrals)

The two independent S5 reviews surfaced 28 findings (2 CRITICAL + 6
HIGH + 10 MEDIUM + 10 LOW). Per user authorization, the following are
documented as 1.12 follow-ups:

- **Dexie preview persistence** (priv-F4 HIGH, user-authorized
  deferral). The ADR §3.7 commitment to `_excel_import_drafts` is
  deferred; preview state stays in React `useState` only. A page
  refresh / tab eviction loses the rep's per-row edits. Tracked as the
  load-bearing UX hazard for the 1.11 mobile flow; closed by the 1.12
  WebAuthn-PRF / session-derived at-rest encryption ratchet (same fix
  as 1.10 T-S1).
- **Per-attendee row-per-name encryption** (T-X14 / T-X48). Attendance
  is one envelope blob in 1.11; per-attendee P9 redaction needs the
  1.12 ratchet that splits the blob into queryable rows.
- **`excel_import.cancelled` chain anchor kind** (sec-F13 / priv-F9).
  The cancellation transition is not chain-anchored in 1.11; the
  upload anchor already binds the abandoned event. Future
  chain-kind addition.
- **`audit-log-verify.ts --check-excel` flag** (T-X40 lineage).
  Cross-joins `excel_import_items.content_hash` against
  `action_items.source_excel_hash` for forward-defense. Operationally
  manual until 1.12 lands the flag.
- **Source workbook archival decision** (T-X43 lineage). The rep's
  responsibility today; a future PWA-backed archival under the
  workplace KEK is deferred.
- **Action-bound step-up tokens** (T-X26 honest stance). The action
  label is cosmetic until 1.12 ships action-bound tokens with a jti
  pin on `excel_imports.step_up_jti`.
- **`before_state_json` envelope encryption** (priv-F7). The JSONB
  column carries plaintext `priorTags` + structural metadata. The
  tags field is bounded + the column is only read during the
  step-up-gated reverse path; a full envelope encryption is deferred
  to align with the per-action_item redaction work.
- **Second-rep test infrastructure** (sec-F4). The integration test's
  cross-actor 404 boundary is currently `it.todo` because the
  first-run/setup helper is single-tenant by contract. A
  "create-second-user" test helper is deferred to 1.12.
- **Workplace key rotation race recovery** (T-X33 / priv-F16). The
  view re-fetches the workplace key if the cache is >1h stale; a true
  rotation-mid-preview surfaces as a 409 from the route. A cleaner
  per-key-id pin on the POST body (so the server can early-reject
  with a clear "key rotated; refresh and retry" message) is deferred.

---

## 12. Chain-of-custody verification

The auditor / arbitrator reconstructs an Excel-import event from three
chain anchors + one additive field:

- `excel_import.uploaded` — `{importId, sourceSha256, rowCount,
schemaVersion}`. Anchors the upload; PI-clean.
- `excel_import.committed` — `{importId, createdCount, updatedCount,
skippedCount, conflictResolvedCount}`. Anchors the commit
  transaction; PI-clean.
- `excel_import.reversed` — `{importId, reversedAt, deletedCount,
revertedCount, refusedCount, viaOperatorScript?, operatorUserId?}`.
  Anchors the reverse (if any); PI-clean.
- `createdByImportId` additive field on `action_item.created` /
  `action_item.updated` payloads — the auditor greps the chain for
  `createdByImportId == <import>` and reconstructs the per-import
  action_item list without joining tables.

**Verifying a workbook against the chain:**

1. The rep presents the workbook (or the archived copy).
2. Compute `sha256(file_bytes)`; compare against the
   `excel_import.uploaded` anchor's `sourceSha256`. A match proves
   "this is the file that was imported."
3. Walk the per-row anchors via `createdByImportId`; each carries a
   `source_excel_hash` (the content_hash of the parsed row). The rep
   can re-parse the workbook locally + compare per-row hashes for
   bit-exact verification.
4. The reverse anchor (if present) carries the per-row outcome
   counts; the rep's subsequent edits to action_items past the
   reverse are anchored in their own `action_item.updated` rows.

**The chain is necessary but not sufficient evidence.** The workbook
itself is corroborating; the rep is encouraged (per T-X43) to archive
the source workbook alongside their evidence backup. The chain
records what was committed FROM the workbook; the workbook records
what the rep typed.

---

_Last updated: Milestone 1.11 S5 (security + privacy reviewer fix
bundle)._
