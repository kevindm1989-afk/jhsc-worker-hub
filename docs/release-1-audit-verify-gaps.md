# Release 1 `audit-log-verify --full` — documented schema gaps

Milestone 1.12 S2, ADR-0011 §3.7.

The `--full` flag is specified to run four additional checks on top of the
existing chain-link verification:

1. Re-canonicalize each entry's payload via the same canonical-JSON used at
   write time, recompute its SHA-256, and assert it matches the stored
   `this_hash`.
2. Re-verify the signing chain — verify each entry's Ed25519 signature
   against the public key registered for that signing key id at the time of
   write.
3. Walk every `(actor_id, ts)` pair and assert monotonic per-actor sequence
   numbers if the schema has them.
4. Bound the verification window via `--since=<ISO timestamp>`.
5. Emit a machine-readable `--report=json` summary.

The implementation lands every check EXCEPT where the audit schema lacks
the column required to perform it. The gaps documented below are NOT
silently skipped — the verifier logs the gap with a clear marker so the
operator running the runbook sees what was not checked.

## Gap 1 — No `signing_key_id` / `signature` columns on `audit_log`

`packages/audit/src/schema.ts` defines `audit_log` with:

```
idx | ts | actor_id | kind | resource_type | resource_id | ip | user_agent
prev_hash | this_hash | payload
```

The chain's integrity guarantee is the hash linkage (`prev_hash` =
`this_hash` of idx-1) plus the per-row SHA-256 (`this_hash` =
`SHA256(prev_hash || canonical_json({headers, payload}))`). There is no
per-row Ed25519 signature column; the chain is hash-anchored, not
signature-anchored.

The ADR-0011 §3.7 specification for the `--full` flag includes "Re-verify
the signing chain" as a check, but inspecting the schema after the S0 ADR
landed reveals that signing keys live at the **export** layer (ADR-0008
recommendation exports, ADR-0007 inspection exports), not the audit-log
layer. Each export's PDF carries a signature; the audit row that records
the export references the export's `outputDocumentSha256`, but the audit
row itself is unsigned.

**Posture:** `--full` does NOT run a signature-verification pass on
`audit_log` rows because there is no signature to verify. The log line
`audit-log-verify --full: signature check skipped — no signing_key_id
column on audit_log schema (gap-1)` confirms the skip for the operator.

The audit-row signing surface is a known forward seam:

- The post-Release-1 hardening backlog includes "workplace signing key
  rotation script" (ADR-0011 §"Out of scope") which would land the
  signing-key infrastructure that the chain could then absorb.
- The chain's tamper-evidence today rests on the SHA-256 + the `this_hash`
  uniqueness index + the per-deploy chain export embedded in exported
  PDFs. A future audit-row signing layer is additive, not replacement.

## Gap 2 — No per-actor `sequence` column on `audit_log`

The chain is **globally** sequenced via the `idx` primary key (the
`pg_advisory_xact_lock` in `packages/audit/src/index.ts: append()`
serializes appenders so `idx` is monotonic for the whole chain). The
chain is NOT per-actor sequenced — `(actor_id, sequence)` does not exist.

The spec ("Walk every `(actor_id, timestamp)` pair and assert monotonic
per-actor sequence numbers if the schema has them") is conditional on the
schema. Since the schema does not have per-actor sequence numbers, the
check is replaced with a **per-actor monotonic-timestamp** check: for every
actor, the rows emitted by that actor must have non-decreasing `ts` in
`idx` order. A row that goes "backwards in time" for a given actor (e.g.
ts on idx=100 is earlier than ts on idx=50 for the same actor) is flagged.

This is weaker than a sequence-column check (timestamps can collide; a
clock skew across processes could in principle produce a false positive)
but covers the dominant tamper signal — a back-dated row inserted by an
attacker who controls the row body but not the `idx` allocation.

The log line `audit-log-verify --full: per-actor sequence check skipped —
no sequence column; running per-actor timestamp-monotonicity instead
(gap-2)` confirms the substitution.

## Gap 3 — Payload-shape validation is structural-only

ADR-0011 §3.7 specifies a `payloadShapeMismatches` array in the JSON
report — "a row missing `sourceSha256` for `excel_import.uploaded` is a
shape-mismatch". The implementation lands the array but populates it via
**structural** checks only (every payload must be a non-null object with a
`kind` field that matches the row's `kind` column). Per-kind field-level
validators (e.g. `excel_import.uploaded` requires `sourceSha256`,
`rowCount`, `schemaVersion`) would belong in a `@jhsc/shared-types` Zod
schema attached to each `AuditPayload` variant; that work is on the
post-Release-1 hardening backlog under the
`--check-inspections` / `--check-recommendations` / `--check-excel`
forward-defense flags noted in the ADR.

**Posture:** `--full` reports `payloadShapeMismatches` for the
structural cases it can detect today (null payload, mismatched kind,
non-object payload). Per-kind field validation is the
forward-defense-flags work, deferred per ADR.

## Summary

| Check                             | Status              | Reason                                                                         |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| Re-canonicalize + rehash payload  | LANDED              | Uses `@jhsc/audit` canonical-JSON + `computeThisHash`                          |
| Re-verify Ed25519 signature       | SKIPPED (gap-1)     | No `signing_key_id` / `signature` columns on schema                            |
| Per-actor monotonic sequence      | SUBSTITUTED (gap-2) | No `sequence` column; uses `ts` instead                                        |
| `--since=<ISO>` window            | LANDED              | Filters the chain walk by `ts >= since`                                        |
| `--report=json`                   | LANDED              | Machine-readable summary for runbook consumption                               |
| Per-kind payload field validation | DEFERRED (gap-3)    | Belongs in `--check-{inspections,recommendations,excel}` forward-defense flags |

Each gap maps to a documented residual in the post-Release-1 hardening
backlog enumerated in ADR-0011 §"Out of scope".
