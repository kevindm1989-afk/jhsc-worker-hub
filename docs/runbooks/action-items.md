# Action Items Operations

Operator runbook for the Action Items module shipped in Milestone 1.6.
Pairs with ADR-0005 and SECURITY.md §2.6. Cross-references
`docs/runbooks/auth.md` for KEK rotation and chain-tamper response, and
`docs/runbooks/hazards.md` for the PIPEDA Principle 9 procedure shape.

## 1. Schema overview

Two tables (`action_items`, `action_item_moves`). Four encrypted column
pairs use the `@jhsc/crypto` envelope plus the move-row `reason_ct`:

| Field                             | Storage                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `action_items.description`        | `description_ct` + `description_dek_ct`                                                    |
| `action_items.recommended_action` | `recommended_action_ct` + `recommended_action_dek_ct` (NULL when none)                     |
| `action_items.raised_by`          | `raised_by_ct` + `raised_by_dek_ct` (NULL when an internal-rep user_id is set)             |
| `action_items.follow_up_owner`    | `follow_up_owner_ct` + `follow_up_owner_dek_ct` (NULL when an internal-rep user_id is set) |
| `action_item_moves.reason`        | `reason_ct` + `reason_dek_ct` (NULL when no note)                                          |

Pair-NULL invariants are enforced by CHECK constraints in migration 0005. The single encryption boundary lives in
`apps/api/src/action-items/crypto.ts`.

Non-encrypted columns: `id`, `sequence_number`, `type`, `type_subtype`,
`raised_by_user_id`, `follow_up_owner_user_id`, `department`, `status`,
`risk`, `section`, the three date columns (`start_date`, `target_date`,
`closed_date`), `verified_by_jhsc_id`, `meeting_id`, `source_type`,
`source_id`, `source_excel_hash`, `tags`, `created_at`, `updated_at`.

## 2. Sequence numbers (the "#" column)

The `sequence_number` is the per-section counter that mirrors the Excel
"#" column. It is allocated via `allocateSequenceNumber(tx, section)`
inside the create transaction AND inside the move/undo transactions.
Each section maintains its own monotonic counter, serialized by
`pg_advisory_xact_lock(hashtext('action_items.seq.' || section))`.

**Per-section semantics.** When an item moves between sections, it
**gets a fresh number in the destination section**. This matches the
Excel workflow: a row moved between sheets gets the new sheet's next
row number. The old number is not reserved or held.

**Concrete example:**

- A in `new_business`, seq=1.
- B in `old_business`, seq=1.
- Move A → `old_business`. A's seq becomes 2 in old_business (B is
  still 1). The new_business sequence does NOT roll backward — if a
  later item C lands in new_business it gets seq=2 there.

**The `(section, sequence_number)` UNIQUE index** enforces this at the
DB layer. A handler bug that forgot to re-allocate would surface as a
unique-constraint exception, not silent corruption.

**Non-contiguity.** Failed transactions advance the pg advisory lock
but don't commit the SELECT MAX+1 — the counter is monotonic but not
dense. A rollback leaves no gap (the lock releases at rollback). A
DELETE leaves a gap, but there is no DELETE path — items are
withdrawn via section → `archived` + status `Cancelled`, never
removed.

## 3. Section workflow and the "withdraw" path

Sections: `new_business → old_business → completed_this_period →
archived`, plus `recommendation` (formal s.9(20) escalation from
new_business or old_business). The pure-function graph in
`packages/shared-types/src/action-item-transitions.ts` is the single
source of truth.

**Withdraw an action item:**

1. PATCH the item to `status: 'Cancelled'`. The chain emits
   `action_item.updated` with `changedFields: ['status']`.
2. POST `/api/action-items/:id/moves` with
   `toSection: 'archived'`. Step-up auth required (60-second
   freshness floor). The chain emits `action_item.moved` with
   `{fromSection: <current>, toSection: 'archived'}`.
3. The row stays in the DB. All ciphertexts stay. All prior move
   rows stay. The chain stays verifiable.

There is no DELETE endpoint. Cancellation is reversible via the
move-undo path (also step-up gated) for ≤30 days; beyond that, the
operator opens a new item with `sourceType: 'manual'` and a comment
referencing the withdrawn item's id.

## 4. PIPEDA Principle 9 right-to-erasure procedure

Action items are the operational primitive (CLAUDE.md non-negotiable
#12) and the convergence point for hazards, recommendations,
inspections, and incidents. They accumulate worker names faster than
any other surface — most commonly via:

- `description` mentioning a specific worker (encrypted at rest).
- `raised_by` carrying an external worker's name (encrypted at rest).
- `follow_up_owner` carrying an external person's name (encrypted).
- `reason_ct` on a move row carrying a note that names someone
  (encrypted).

A request from a named individual (PIPEDA Principle 9 — challenging
accuracy) follows the same refuse-or-redact matrix as hazards
(`docs/runbooks/hazards.md` §"PIPEDA Principle 9 response procedure"):

1. **Confirm identity out of band.** CLAUDE.md non-negotiable #1 bars
   storing names; the co-chair verifies the requester directly.
2. **Identify the rows.** Search by date range + section + risk.
   Decrypt as the co-chair to confirm the match.
3. **Choose a response:**
   - **(a) The item is still active.** Refuse deletion under PIPEDA
     Principle 4.5 (retention only as long as necessary). The item's
     purpose hasn't been fulfilled. Document the refusal in writing.
   - **(b) The item is closed but inside a regulatory retention
     window** (MLITSD, OLRB, WSIB). Refuse deletion citing
     evidentiary necessity. Document.
   - **(c) The named individual requests their NAME be removed but
     the operational record stays.** This is the typical answer for
     `raised_by` or a `description` mentioning a non-member worker:
     1. Open a transaction.
     2. UPDATE the encrypted columns to NULL (the pair-NULL CHECK
        accepts it): `description_ct = NULL` is NOT allowed because
        the description is NOT NULL; instead, re-encrypt a redacted
        description with the same `sealField` helper and replace.
        For `raised_by`/`follow_up_owner`/`reason_ct`: set both
        halves of the pair to NULL.
     3. Emit `action_item.updated` with the appropriate
        `changedFields` entry (`description`, `raised_by`,
        `follow_up_owner`, etc.) so the chain records the redaction
        without recording the prior value.
     4. Commit.
   - **(d) The item was filed in error.** Move to `archived` with a
     documented reason in `reason_ct`. Status: `Cancelled`.
4. **Why we don't fully delete.** The chain link is the audit-trail
   anchor under CLAUDE.md non-negotiable #2. The
   `action_item_moves.audit_idx` FK with `ON DELETE RESTRICT`
   cryptographically pins each move row to its chain anchor —
   deletion would break the chain's `prev_hash` linkage at every
   subsequent event. The chain's verifiability IS the worker's
   protection in a reprisal case.
5. **Document the refusal** in writing per Principle 10 and inform
   the individual of their right to complain to the OPC.

## 5. KEK rotation impact on action items

KEK rotation is the auth-runbook §3a procedure. Action items
participate in two ways:

1. **Five `*_dek_ct` columns** carry per-row DEKs sealed under the
   KEK (description, recommended_action, raised_by,
   follow_up_owner, and move-row reason). The rotation script
   (`scripts/kek-rotate.ts` — 1.12 hardening line item) sweeps each
   `*_dek_ct`, opens with the OLD KEK, re-seals with the NEW KEK,
   writes back. Ciphertexts (`*_ct`) are untouched.
2. **List endpoint must tolerate a row failing to open.** The list
   route at `apps/api/src/routes/action-items/index.ts` wraps the
   per-row `openField` call in try/catch (matching the 1.5 hazards
   sec-F5 pattern). A row whose DEK rotated mid-flight surfaces as
   `summary: '[unreadable — open the detail view for diagnostics]'`
   so the rest of the list stays usable.

A rotation should run during a low-traffic window, immediately
followed by an API restart to refresh the in-process KEK cache.

## 6. Tamper response — chain mismatch involving action-item events

If `audit-log-verify` reports a divergence at an `action_item.*` row,
follow `docs/runbooks/auth.md` §7 (chain tamper response). Additional
checks for action-item-specific tampering:

1. `action_item_moves.audit_idx` FK with `ON DELETE RESTRICT` means
   a delete of a chain row is rejected by Postgres. A divergence
   therefore implies in-place mutation of the chain row OR in-place
   mutation of the move row. The chain's `prev_hash` linkage tells
   you which.
2. Cross-check the divergent row's payload against the
   `action_items` table:
   - `action_item.created.itemId` must point to an existing row.
   - `action_item.moved.{fromSection, toSection}` must match a
     contiguous pair in `action_item_moves` for that
     `action_item_id`.
   - `action_item.updated.changedFields` must intersect the
     `actionItemUpdateField` allow-list in shared-types.
3. Run `audit-log-verify --check-action-items` (1.12 hardening line
   item) once it lands; until then, the cross-check above is
   manual.

## 7. Operational invariants — quick reference

- Action items are envelope-encrypted at rest; KEK in Fly Secrets,
  never in source or DB.
- Section transitions go through the
  `ACTION_ITEM_ALLOWED_TRANSITIONS` pure-function graph in
  shared-types. The graph is the single source of truth for both
  API and UI.
- `→ archived`, `archived → old_business`, and
  `completed_this_period → old_business` require step-up auth
  (60-second freshness floor).
- Move-undo is always step-up gated.
- `sequence_number` is per-section monotonic and re-allocated on
  every move (sec-review F2 1.6).
- Audit chain emits 4 event kinds: `action_item.created`,
  `action_item.updated`, `action_item.moved`,
  `action_item.move_undone`. Payloads are non-PI: ids + enums +
  the `changedFields` allow-list.
- `audit_idx` on `action_item_moves` FK-pins the chain row to the
  move row.
- `raised_by` / `follow_up_owner` external-name disclosure is NOT
  step-up gated by design (T-AI13 — these are minutes-sheet
  operational metadata, not reprisal-risk identity).
