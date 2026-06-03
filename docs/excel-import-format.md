# Excel Import Format — Supported Schema

Status: **authoritative** (Milestone 1.11, ADR-0010 §3.3).

This document is the authoritative reference for the Excel workbook
schema the import parser recognizes. The detector (`packages/excel-
import/src/schema.ts`) is implemented against this spec; a workbook
that does not match this spec produces `{ kind: 'unrecognized',
reason }` and **no partial import** (CLAUDE.md Excel Import Rule 6,
SECURITY.md T-X8 fail-closed).

See `docs/adr/0010-excel-import.md` and `SECURITY.md` §2.11 for the
threat model and the broader architecture.

---

## Scope (Release 1)

**One file family is supported: Meeting Minutes workbooks (v1).**

- Format: `.xlsx` or `.xlsm`. `.xls` (binary 97-2003) is **out of
  scope**; the file-picker `accept` attribute filters by extension,
  and a drag-dropped `.xls` rejects with a clear "open in Excel and
  re-save as .xlsx" message (SECURITY T-X44).
- `.csv` is out of scope.
- Inspection-file imports are out of scope — inspections are
  conducted natively in-app from Milestone 1.8 onward.

If the workbook doesn't match the schema below, the parser produces a
clear `"we don't recognize this file"` error. **No partial imports.**

---

## File constraints

| Bound                  | Value    | Enforcement                    | Threat |
| ---------------------- | -------- | ------------------------------ | ------ |
| On-disk size           | ≤ 10 MB  | File picker + worker pre-parse | T-X6   |
| Decompressed size      | ≤ 100 MB | SheetJS hardened parser        | T-X6   |
| Row count (all sheets) | ≤ 50,000 | Post-parse assertion           | T-X6   |
| Per-cell text          | ≤ 8 KB   | Per-row Zod parser             | T-X11  |

Macros (`.xlsm` VBA) are ignored — never executed, never stored.
Formulas are not evaluated; SheetJS is configured with
`cellFormula: false`, `cellHTML: false`, `cellText: true`, `raw: false`
(ADR §3.2, SECURITY T-X5).

---

## Schema-recognition rules

The detector matches **sheet names AND first-row column headers**.
Both must match for `recognized`; any miss returns `unrecognized` with
a specific reason string.

**Header matching is case-insensitive + whitespace-trimmed.**
`"new business"`, `"NEW BUSINESS"`, `" New Business "` all match
`NEW BUSINESS`. The case-folding is `String.prototype.toLowerCase`;
the trim is `String.prototype.trim`.

**Sheet-presence is strict.** A workbook missing ANY required sheet
returns `unrecognized` with the missing-sheet name in the reason. The
detector NEVER returns a partial `recognized` shape — there is no
discriminated-union variant for "recognized-but-degraded."

---

## Recognized sheets

| Sheet name (canonical)     | Required? | Maps to                                               |
| -------------------------- | --------- | ----------------------------------------------------- |
| `Minutes`                  | yes       | meeting metadata + workbook version                   |
| `NEW BUSINESS`             | yes       | action items, `section='new_business'`                |
| `OLD BUSINESS`             | yes       | action items, `section='old_business'`                |
| `NOTICE OF RECOMMENDATION` | yes       | action items, `section='recommendation'`              |
| `COMPLETED`                | yes       | action items, `section='completed_this_period'`       |
| `Closed Items History`     | yes       | action items, `section='archived'`, `status='Closed'` |
| `Inspection Review`        | optional  | JSONB read-only snapshot                              |
| `_MoveHistory`             | optional  | informational; native chain replaces it               |

A missing required sheet yields:
`{ kind: 'unrecognized', reason: "missing required sheet 'NEW BUSINESS'" }`.

---

## `Minutes` sheet

The `Minutes` sheet carries meeting metadata. Expected cells (header
column in column A, value in column B):

| Cell label         | Type             | Required? | Notes                                                                                                  |
| ------------------ | ---------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `Meeting Date`     | date             | yes       | Parsed `YYYY-MM-DD`.                                                                                   |
| `Quorum`           | boolean          | optional  | Accepts `TRUE`/`FALSE`/`Yes`/`No`/empty.                                                               |
| `Attendance`       | text (multiline) | optional  | Newline- or comma-separated names; envelope-encrypted as one blob in 1.11.                             |
| `Workbook Version` | text             | optional  | Free-text version string (e.g. `"v1"`); used by the detector when version-string detection is enabled. |

**Attendance is sensitive.** The whole blob is envelope-encrypted under
the workplace public key before any API call. Per-attendee row-per-name
encryption is deferred to 1.12 (ADR §"Out of scope" + SECURITY T-X14).

---

## Action-item sheets

The four section sheets (`NEW BUSINESS`, `OLD BUSINESS`,
`NOTICE OF RECOMMENDATION`, `COMPLETED`) share a column shape. Each
row becomes one parsed `action_items` candidate.

| Column header (canonical) | Type              | Required? | Encrypted? | Maps to (1.6)           |
| ------------------------- | ----------------- | --------- | ---------- | ----------------------- |
| `Type`                    | text (enum)       | yes       | no         | `type`                  |
| `Issue Description`       | text              | yes       | **yes**    | `description_ct`        |
| `Recommended Action`      | text              | optional  | **yes**    | `recommended_action_ct` |
| `Start Date`              | date              | yes       | no         | `start_date`            |
| `Raised By`               | text              | optional  | **yes**    | `raised_by_ct`          |
| `Follow Up`               | text              | optional  | **yes**    | `follow_up_owner_ct`    |
| `Dept`                    | text              | optional  | no         | `department`            |
| `Status`                  | text (enum)       | yes       | no         | `status`                |
| `Risk`                    | text (enum)       | yes       | no         | `risk`                  |
| `Target Date`             | date              | optional  | no         | `target_date`           |
| `Closed Date`             | date              | optional  | no         | `closed_date`           |
| `Tags`                    | text (comma-list) | optional  | no         | `tags[]`                |

**Length caps (T-X11):**

- `Issue Description`: ≤ 2,000 chars (target); ≤ 8,192 chars (hard cap;
  larger → row rejected as unrecognized with a per-row reason)
- `Recommended Action`: same caps
- `Raised By`: ≤ 200 chars
- `Follow Up`: ≤ 200 chars
- `Tags`: each tag ≤ 64 chars; max 16 tags per row

**Enum mapping:**

- `Type`: maps to the 1.6 `ActionItemType` taxonomy
  (`INSP`/`INSIGHT`/`FLI`/`INC`/`REC`/`TRAIN`/`PROC`/`OTHER`).
  Unknown legacy values map to `OTHER` with the original string captured
  in `excel_import_items.before_state_json` as a warning provenance
  marker (SECURITY T-X10).
- `Status`: maps to the 1.6 `ActionItemStatus` taxonomy. Unknown
  values map to `Not Started` with the original captured as a warning.
- `Risk`: maps to `Low`/`Medium`/`High`/`Critical`. Unknown values
  reject the row with a per-row reason (Risk is not optional).

**`Closed Items History` sheet** carries the same columns plus an
implicit `section='archived'` and `status='Closed'`. The `Closed Date`
column is **required** on this sheet.

---

## Cell-type validation

Each parsed cell is Zod-validated against its expected shape:

- **Dates** (`Start Date`, `Target Date`, `Closed Date`, `Meeting Date`):
  ISO `YYYY-MM-DD` after SheetJS's `raw: false` normalization. Invalid
  dates (`2024-13-45`, `1899-01-01`, `2099-12-31`) reject with a
  per-row warning; the row's reconciliation classification is forced
  to `conflict_pending` until the rep edits in the preview UI
  (SECURITY T-X9, T-X15).
- **Booleans** (`Quorum`): accepts `TRUE`/`FALSE`/`Yes`/`No`/`1`/`0`
  case-insensitively; anything else → `null`.
- **Enums** (`Type`, `Status`, `Risk`): per the mapping above.
- **Text**: trimmed; multi-internal whitespace preserved verbatim
  inside the cell (canonicalization only happens for the
  content_hash, not for the encrypted-at-rest value).

A row with any required-field rejection lands in
`excel_import_items` at `status='conflict_pending'` with the
rejection reasons; the rep edits in the preview before commit. A
sheet-level rejection (missing column, bad sheet name) returns
`unrecognized` at the detector layer.

---

## `Inspection Review` sheet (optional)

The `Inspection Review` sheet, when present, is parsed as a 2D
`string[][]` and stored on `excel_imports.inspection_review_snapshot_ct`
(envelope-encrypted JSONB). The snapshot is **read-only** — not
promoted to native inspection records. The 1.8 inspection schema is
the going-forward path; historical inspection notes survive as
provenance only.

---

## `_MoveHistory` sheet (optional, informational)

Parsed if present and stored as a JSONB snapshot. The native action-
item move history (per ADR-0005) is the going-forward source of truth;
the legacy snapshot is provenance, not behavior. **Not** wired in S1
schema (no column allocated yet); S2 may add a `move_history_snapshot_ct`
pair if the schema reveals it's needed.

---

## `content_hash` canonicalization

The reconciliation engine matches rows across imports via:

```
content_hash = sha256(canonical(description) + '|' + canonical(start_date))
```

Where:

- `canonical(description) = description.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()`
- `canonical(start_date) = date.toISOString().slice(0, 10)` (UTC YYYY-MM-DD)

The `'|'` separator structurally prevents `(desc='a b', date='c')` from
colliding with `(desc='a', date='b c')` — `'|'` cannot appear in an
ISO date.

**Section is intentionally NOT part of the hash** (SECURITY T-X22).
A row that moves from `NEW BUSINESS` in Q3 to `OLD BUSINESS` in Q4
hashes the same; the Q4 import reconciles it as `update` and the
preview surfaces the section transition.

See `packages/excel-import/src/canonical.ts` for the implementation
and `canonical.test.ts` for the stability matrix (NFC, whitespace,
case, ISO-date round-trip).

---

## PII heuristic (UX nudge — not a gate)

The 4-class scanner (`packages/excel-import/src/pii.ts`) runs against
each parsed cell value **before envelope encryption**:

- **nameShape** — ≥2 capitalized words in close proximity (`John Doe`,
  `Dr. Alice Chen`). Documented false positives on phrases like
  `Health Safety Committee`; documented false negatives on single-token
  surnames and lowercase names (T-X17, T-X18).
- **emailShape** — `LOCAL@DOMAIN.TLD` regex. Documented false negative
  on obfuscated `name [at] domain` forms (T-X17).
- **phoneShape** — NANP / Ontario 10-digit shapes with optional
  country code. International phone shapes are out of scope in 1.11.
- **sinShape** — Canadian SIN 9-digit shape. **Intentionally loose**
  per ADR §3.5: false positives on bare 9-digit runs (timestamps, part
  numbers) are acceptable; false negatives are not.

The heuristic is a **UX nudge** that surfaces flags in the preview
UI. It is **not** a data gate — every sensitive column is
envelope-encrypted regardless of PII flag (the 1.6 encrypt-everything-
sensitive default is binding).

---

## Worker contract

The parser runs in a Web Worker (`packages/excel-import/src/parser.worker.ts`).
The contract is intentionally narrow: **one message in, one message out.**

**Main thread → worker:**

```ts
postMessage({ kind: 'parse', arrayBuffer });
```

**Worker → main thread:**

```ts
{ kind: 'detection', result: DetectionResult }
// or
{ kind: 'error', message: string }
```

The worker has no access to cookies, `localStorage`, `sessionStorage`,
or `document.*` (Web Worker scope excludes DOM + storage APIs). It
computes `sourceSha256` via WebCrypto **before** SheetJS parsing, so
the chain anchor binds to the file bytes even if SheetJS rejects the
parse (the rejected upload still emits no chain anchor — see ADR §3.1).

The worker is `worker.terminate()`'d in `parseWorkbookInWorker`'s
`finally` block; plaintext cell state never crosses imports
(SECURITY T-X3, T-X4).

---

## Non-recognized workbook errors

| Reason string                           | Meaning                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `payload_too_large`                     | On-disk size > 10 MB or decompressed > 100 MB                               |
| `row_count_exceeded`                    | Total parsed rows > 50,000                                                  |
| `unsupported_extension`                 | `.xls` / `.csv` / unknown extension                                         |
| `missing required sheet '<name>'`       | Detector found no sheet whose name (case-insensitive trim) matches `<name>` |
| `sheet '<name>' missing column '<col>'` | A required sheet's first-row headers don't include `<col>`                  |
| `cell at row N exceeds 8KB`             | Per-cell length cap exceeded                                                |
| `unparseable workbook`                  | SheetJS threw mid-parse; the worker caught it                               |

Each reason is human-readable and PI-clean; none of them embed cell
content.

---

## Reconciliation behavior

For each parsed row the reconciler computes `content_hash` and
classifies against the existing `action_items` projection:

- **create** — no existing row matches the hash → new `action_items`
  row at commit.
- **update** — existing row matches AND ≥1 mutable field differs
  (`target_date`, `closed_date`, `status`, `risk`, `tags`,
  `follow_up_owner`, `recommended_action`) → PATCH at commit with
  `If-Match: <existing version>`.
- **skip** — existing row matches AND no fields differ → no-op;
  recorded for provenance.
- **conflict_pending** — match + the existing row was edited since
  the last import (`version > 1` AND last edit was actor-driven) →
  surfaces in the preview UI as a field-level diff.

See `ADR-0010` §3.6 for the full classification rules.

---

## Privacy & security

- The raw file **never leaves the device.** SheetJS runs entirely in
  the browser (non-negotiable #11).
- Sensitive cells (`description`, `recommended_action`, `raised_by`,
  `follow_up_owner`, `Attendance`, `Inspection Review` snapshot, the
  source filename) are envelope-encrypted client-side under the
  workplace public key before any API call.
- The file's SHA-256 is recorded for provenance — the file itself is
  not stored anywhere on app-managed infrastructure.
- The reverse path is available for 30 days from commit
  (CLAUDE.md Excel Import Rule 4); after 30 days, operator-script-only
  recovery via `scripts/excel-import-reverse.ts` (runbook lands in S5).

See `SECURITY.md` §2.11 for the full T-X1..T-X44 threat matrix.
