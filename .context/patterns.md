# Patterns — JHSC Worker Hub

Recurring shapes worth naming so we use them consistently and don't reinvent them. When a new pattern shows up twice, add it here. When a pattern is superseded, mark it and link the replacement.

---

## Result<T, E> for fallible operations

- Every function that can fail returns `Result<T, E>` from `@jhsc/shared-types`. No throwing across module boundaries.
- `E` is a discriminated union with a `kind` literal, never a bare `Error` or string.
- Callers `match` on `kind`; UI maps each kind to a copy string. No silent fallbacks.

## Audit-first sensitive writes

- Any write to evidentially sensitive data appends an `audit_log` row in the same transaction as the data write.
- The audit row carries: actor, action, resource ref, before/after hash (not contents), prev_hash, this_hash, timestamp, request_id.
- If the audit append fails, the data write fails. There is no "best-effort" audit.

## Envelope encryption for sensitive fields

- Per-record data key generated at write time, used with XChaCha20-Poly1305 from `@jhsc/crypto`.
- Data key is sealed with the workplace key; only the sealed key is stored on the row.
- Reads decrypt at the application layer; the DB never sees plaintext for sensitive fields.

## Stable IDs, configurable display names

- `zone_1` … `zone_10` are stable identifiers and must never be renumbered or remapped.
- Display names live in `workplace_config` and may change at any time. UI always renders the current display name; historical records always link by stable ID.
- Apply the same rule to any future enum where the workplace might rename the human label.

## Immutable historical artifacts

- Inspections, minutes, and exports are immutable once finalized.
- Edits create a new version; old versions remain queryable and remain the source of truth for any link that was made against them.
- Template version is snapshotted onto the instance at conduct/issue time.

## Action items as first-class

- Hazards, recommendations, and meeting outputs may _create or link to_ action items, but action items live in their own table with their own lifecycle.
- A finding is promoted to an action item only by an explicit user action and only if it is not status X or G.

## Step-up + hash for exports

- Every PDF export requires fresh auth (passkey or TOTP) immediately before generation.
- The audit entry for the export carries the SHA-256 of the generated PDF and the purpose string the user typed.

## Opt-in AI with per-feature consent

- AI features are off by default. Each feature gates its first invocation behind a consent dialog that names the data category and the destination.
- Consent is recorded as an `audit_log` event of kind `consent.granted` with the feature key and the policy hash in force at the time.
