# Hazards Operations

Operator runbook for the Hazards module shipped in Milestone 1.5. Pairs
with ADR-0004 and SECURITY.md §2.5. Cross-references
`docs/runbooks/auth.md` for KEK rotation and chain-tamper response.

## 1. Schema overview

Two tables (`hazards`, `hazard_status_history`). Four encrypted column
pairs use the `@jhsc/crypto` envelope:

| Field                          | Storage                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `hazards.description`          | `description_ct` + `description_dek_ct`                                   |
| `hazards.reporter_identity`    | `reporter_identity_ct` + `reporter_identity_dek_ct` (NULL when anonymous) |
| `hazards.location_detail`      | `location_detail_ct` + `location_detail_dek_ct` (NULL when not provided)  |
| `hazard_status_history.reason` | `reason_ct` + `reason_dek_ct` (NULL when no note)                         |

The pair-NULL invariant is enforced by CHECK constraints in migration
0004 — both halves must be NULL together or NOT NULL together. The
seeder + API route handlers go through `sealOptionalField` /
`openOptionalField` (`apps/api/src/hazards/crypto.ts`), the single
encryption boundary for hazards.

Title, severity, status, jurisdiction, hazard_code, reported_by, and
location_zone are plaintext columns. Title is bounded to 120 chars at
four layers (HTML maxLength, client validate, Zod max, SQL CHECK).

## 2. Hazard codes (H-NNN) — non-contiguous by design

Hazard codes come from the `hazards_code_seq` standalone sequence. Each
INSERT calls `nextval()` once. Postgres sequences are
**not transactional** — a failed transaction still consumes the value.
Concrete consequences:

- A rep who hits a constraint violation, advisory-lock timeout, or
  network drop mid-insert leaves a permanent gap in the H-NNN counter.
- The visible counter is monotonic but NOT dense. H-001 → H-002 → H-005
  is normal operational state, not corruption.
- T-H11 in SECURITY.md treats the visible counter as a workplace-size
  oracle inside the single-co-chair scope. Gaps actually mitigate
  T-H11 (the rep can no longer infer total count exactly from the max
  code).

If a reset is genuinely needed (e.g. for a fresh dev environment):

```sql
ALTER SEQUENCE hazards_code_seq RESTART WITH 1;
```

This is destructive in production — running it after H-047 has been
issued will start re-issuing H-001 on the next insert and collide on
the UNIQUE index. Only use in a clean environment.

## 3. Withdrawn — the only cancellation path

There is no DELETE endpoint. A rep who reports a hazard and later
realizes it was a duplicate, mistake, or already-resolved condition
moves the hazard to status `withdrawn` via PATCH /api/hazards/:id/status.

The transition has these properties:

1. **Step-up auth required.** `requiresStepUp(from, 'withdrawn')` is
   true for every non-terminal `from`. The PATCH route gates on
   `checkStepUpFreshness({maxAgeSeconds: 60})` — the rep needs to have
   re-authenticated within the last minute.
2. **Reason required.** The web UI's TransitionPanel rejects an empty
   reason for `withdrawn` and the API documents the field as optional
   only for non-destructive transitions. The reason is stored
   encrypted in `hazard_status_history.reason_ct`.
3. **Chain anchor.** A `hazard.status_changed` event is appended to
   `audit_log` with `{hazardId, hazardCode, fromStatus, toStatus:
'withdrawn'}`. No PI in the payload.
4. **Row preserved.** The hazards row stays in the DB with status
   updated to `withdrawn`. Description ciphertext, reporter identity
   ciphertext, location detail ciphertext, and all prior status
   history rows remain. The chain stays verifiable.

`withdrawn` is a terminal status — no transitions out per the
ALLOWED_TRANSITIONS graph in `packages/shared-types/src/hazard-transitions.ts`.

## 4. PIPEDA right-to-erasure responses

The Personal Information Protection and Electronic Documents Act
(PIPEDA) recognizes a qualified right of individuals to challenge the
accuracy and completeness of their personal information (Principle 9).
A right-to-deletion request from a worker (the reporter, or a worker
named in the description) is bounded by the workplace's evidentiary
necessity.

**Default response: refuse deletion, withdraw the hazard if
appropriate.**

The procedure when an individual requests deletion of a hazard record:

1. Confirm the requester's identity out of band. CLAUDE.md
   non-negotiable #1 bars storing names in the system; the requester's
   identity is verified by the JHSC co-chair directly, not by querying
   the database.
2. Identify the rows: search by date range + zone + severity. If the
   target is a `reporter_identity_ct`, the co-chair uses GET
   /api/hazards/:id/reporter (step-up gated) to confirm match.
3. Choose a response:
   - **(a) The hazard is still active and tracking an open condition.**
     Refuse deletion under PIPEDA Principle 4.5 (Retention): "Personal
     information shall be retained only as long as necessary for the
     fulfilment of those purposes." The hazard's purpose has not been
     fulfilled until the condition is resolved. Document the refusal
     in writing with a copy in the JHSC binder.
   - **(b) The hazard is resolved or archived but inside a regulatory
     retention window** (MLITSD inspection retention, OLRB limitation
     periods, WSIB statutory periods). Refuse deletion citing
     evidentiary necessity. Document.
   - **(c) The reporter requests their identity be removed but the
     condition stays.** Set `reporter_identity_ct = NULL` and
     `reporter_identity_dek_ct = NULL` via an out-of-band SQL update
     INSIDE a transaction that ALSO emits an `audit.hazards.reporter_redacted`
     chain anchor (this chain kind is a 1.12 hardening line item — until
     it lands, the operator-CLI sweep is the procedure). Note: the
     pair-NULL CHECK accepts this.
   - **(d) The hazard was filed in error and never reflected a real
     condition.** Transition to `withdrawn` with a documented reason.
     Row stays; chain stays.
4. **Why we don't fully delete.** The chain link is the audit-trail
   anchor under CLAUDE.md non-negotiable #2 ("Chain-of-custody and
   tamper-evident logging on every sensitive data path"). The
   `hazard_status_history.audit_idx` foreign key with `ON DELETE
RESTRICT` cryptographically pins the row to the chain — a row
   delete would break the chain at every subsequent event's
   `prev_hash`. The chain's verifiability is itself the worker's
   protection in a reprisal case, so destroying it would harm the
   class of workers PIPEDA protects.
5. Document the refusal in writing per Principle 10 (Challenging
   Compliance) and tell the individual they may complain to the OPC.

The procedural seam: an explicit `audit.hazards.reporter_redacted`
chain event (response 3c) lands as a 1.12 hardening item alongside the
audit-log IP/UA redaction sweep. Until then, the operator uses raw SQL
in a documented runbook entry and emits an `audit.ip_redacted`-style
sweep marker.

## 5. KEK rotation impact on hazards

KEK rotation is the procedure in `docs/runbooks/auth.md` §3a. The
hazards schema participates in rotation in two ways:

1. **`*_dek_ct` columns hold per-row DEKs sealed under the KEK.** The
   rotation script (`scripts/kek-rotate.ts` — 1.12 hardening line item;
   `rewrapEnvelopeDek` from `@jhsc/crypto` is the building block) reads
   each `*_dek_ct`, opens it with the OLD KEK, re-seals it with the NEW
   KEK, writes back. Ciphertexts (`*_ct`) are untouched.
2. **List endpoint must tolerate one row failing to open.** The list
   route at `apps/api/src/routes/hazards/index.ts` wraps each
   `openField` call in a try/catch. A row whose DEK was rewrapped to a
   newer KEK while the API is still loaded with the older KEK surfaces
   as `summary: '[unreadable — open the detail view for diagnostics]'`
   in the list — the rest of the list stays usable.

Operationally: a KEK rotation should happen during a low-traffic
window with a brief API restart immediately after to refresh the
in-process KEK cache.

## 6. Tamper response — chain mismatch involving hazard events

If `audit-log-verify` reports a divergence at a `hazard.created` or
`hazard.status_changed` row, follow `docs/runbooks/auth.md` §7 (chain
tamper response). Additional steps for hazards-specific tampering:

1. The `hazard_status_history.audit_idx` FK enforces that every
   history row pins a specific chain row. A divergence at a
   `hazard.status_changed` chain row implies either the history row
   was tampered (FK satisfied; payload doesn't match) or the chain
   row's bytes were rewritten.
2. Cross-check: SELECT the history row's `hazard_id`, then read the
   chain row's payload — `hazardId` must match.
3. If a chain row that anchors a history row is missing entirely
   (delete attempt) the FK is violated — Postgres rejected the
   delete; check for partial RESTRICT failures in the operator log.
4. Run `audit-log-verify --check-hazards` (1.12 hardening line item)
   once it lands; until then, the cross-check above is manual.

## 7. Operational invariants — quick reference

- Hazards are encrypted at rest with envelope encryption; KEK lives in
  Fly Secrets, never in source, never in DB.
- Status transitions follow the ALLOWED_TRANSITIONS pure-function
  graph in `packages/shared-types/src/hazard-transitions.ts`. The
  graph is the single source of truth for both API and UI.
- `withdrawn` is terminal. Reopens go through `assessing` (with
  step-up).
- Hazard codes are monotonic but non-contiguous. Gaps are normal.
- Audit chain emits 2 event kinds per hazard:
  `hazard.created` and `hazard.status_changed`. Payloads carry no PI.
- The chain audit_idx is FK-pinned to hazard_status_history; the
  history table cannot reference a chain row that doesn't exist, and
  the chain row cannot be deleted while history references it.
- Reporter identity disclosure is step-up gated (60-second freshness
  floor). The list route never includes identity in any form.
