# Excel Import Format — Supported Schema

Status: **placeholder** — filled in during Release 1, Milestone 1.11.

This document is the authoritative reference for the Excel files the import
parser will recognize. See `ARCHITECTURE.md` §6 (Excel Import Architecture)
and `SECURITY.md` §4 (Excel Import Security) for the surrounding context.

---

## Scope (Release 1)

**One file family is supported: Meeting Minutes workbooks.**

Inspection file imports are intentionally out of scope for Release 1. From
Release 1 onward, inspections are conducted natively in-app (see Milestone
1.8). Historical inspection files remain in their source files.

If a workbook does not match the schema described below, the parser produces
a clear `"we don't recognize this file"` error. **No partial imports.**

---

## File constraints

- Format: `.xlsx` or `.xlsm`
- Maximum on-disk size: 10 MB (rejected at file picker)
- Maximum decompressed size: 100 MB
- Macros (.xlsm VBA) are ignored — never executed, never stored
- Formulas are not evaluated; cell values are read as data

---

## Recognized sheets

To be detailed in Milestone 1.11. Expected sheet names:

- `Meeting Minutes` — primary data sheet
- `Agenda` — meeting metadata
- `_MoveHistory` — action item move log (informational only; the app rebuilds
  history via its own tamper-evident audit chain)
- `Closed Items` — archived action items

---

## Column mapping for action items

To be detailed in Milestone 1.11. Expected column header row contains:

`#`, `Type`, `Issue Description`, `Recommended Action`, `Start Date`,
`Raised By`, `Follow Up`, `Dept`, `Status`, `Risk`, `Action Flag`, `Age (Days)`

Section headers between data rows (`NEW BUSINESS`, `OLD BUSINESS`, `NOTICE OF
RECOMMENDATION`, `COMPLETED`) drive the `section` field on each parsed
action item.

---

## Reconciliation

Items are matched by `content_hash = sha256(description + start_date)`.
See `ARCHITECTURE.md` §6 for the create / update / skip / conflict rules.

---

## Privacy & security

- The raw file never leaves the device. SheetJS runs entirely in the browser.
- Sensitive fields are encrypted client-side before any sync to the server.
- The file's SHA-256 is recorded for provenance — the file itself is not
  stored anywhere on app-managed infrastructure.

See `SECURITY.md` §4 for the full control list.
