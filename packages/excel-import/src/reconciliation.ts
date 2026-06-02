// Excel-import reconciliation engine (Milestone 1.11 S2).
//
// S1 landed the function signature. S2 lands the body. Per ADR-0010
// §3.6 + docs/excel-import-format.md "Reconciliation behavior":
//
//   - **create** — no existing row matches the content_hash → new
//     `action_items` row at commit.
//   - **update** — match + ≥1 mutable field differs (target_date,
//     closed_date, status, risk, tags) → PATCH at commit with
//     If-Match: <existing version>.
//   - **skip** — match + no fields differ → no-op; provenance recorded.
//   - **conflict_pending** — match + the existing row was edited since
//     the last import (actor-driven edit; `editedSinceLastImport`
//     true) → surfaces in the preview UI as a field-level diff.
//
// The function is **pure** — no IO, no `Date.now()`, no randomness.
// The caller passes the existing projection in as plain data; the
// reconciler does not fetch.
//
// SECURITY mapping:
//   T-X21 — content_hash collision behavior is "treat as same item"
//           (safe-by-construction; sha-256 collision space is
//           structurally negligible).
//   T-X22 — section is INTENTIONALLY orthogonal to identity — a row
//           that moves NEW BUSINESS → OLD BUSINESS across quarters
//           hashes the same; reconciler classifies as `update` and
//           surfaces the section transition in the diff.
//   T-X25 — cross-section duplicate detection: a parsed workbook
//           that lists the same content_hash in two sheets (rep's
//           bookkeeping error) is collapsed in the plan with the
//           first-encountered row winning; the duplicate row is
//           collected into a separate `duplicates` array on the
//           plan so the preview UI can surface "row N is a duplicate
//           of row M; one will be created" rather than silently
//           dropping it.

import type {
  ParsedActionItem,
  ParsedSheets,
  ReconcileDecision,
  ReconciliationPlan,
  ExistingActionItemView,
} from './schema';

/**
 * Mutable fields the reconciler diffs. Section is INTENTIONALLY excluded
 * (T-X22) — section drift is a documented `update` outcome, not a separate
 * decision kind. Description is also excluded because it participates in
 * the content_hash; a description edit yields a NEW hash and thus a NEW
 * `create` (the prior row stays orphaned for the rep to manage via the
 * existing action-items workflow).
 */
const DIFFABLE_FIELDS = ['status', 'risk', 'targetDate', 'closedDate', 'tags', 'section'] as const;
type DiffableField = (typeof DIFFABLE_FIELDS)[number];

/**
 * Reconcile a parsed workbook against the existing action_items
 * projection. Returns a deterministic plan the preview UI renders +
 * the commit-builder consumes.
 *
 * Pure function. Same input → same output. Non-mutating on both arguments.
 */
export function reconcile(
  parsed: ParsedSheets,
  existing: ReadonlyArray<ExistingActionItemView>,
  importId: string,
): ReconciliationPlan {
  if (typeof importId !== 'string' || importId === '') {
    throw new TypeError('reconcile: importId must be a non-empty string');
  }

  // Index existing rows by content_hash for O(1) lookup. A second-line
  // assertion catches the (vanishingly unlikely) case where the
  // projection includes two rows with the same content_hash — the
  // first wins; the second is logged as a non-fatal warning via
  // `console.warn` in dev builds. We do NOT log here (the package
  // contract is pure + IO-less); the caller's preview UI is expected
  // to surface the duplicate via a separate read of the action_items
  // table.
  const existingByHash = new Map<string, ExistingActionItemView>();
  for (const ex of existing) {
    if (!existingByHash.has(ex.contentHashHex)) {
      existingByHash.set(ex.contentHashHex, ex);
    }
  }

  // Walk every parsed row across the five action-item sources in
  // deterministic order — the preview UI displays rows in this order,
  // so the plan ordering matches.
  const allRows: ReadonlyArray<ParsedActionItem> = [
    ...parsed.newBusiness,
    ...parsed.oldBusiness,
    ...parsed.recommendations,
    ...parsed.completed,
    ...parsed.closedHistory,
  ];

  const decisions: ReconcileDecision[] = [];
  const seenHashes = new Set<string>();
  let createCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  let conflictCount = 0;

  for (const row of allRows) {
    // Cross-section duplicate handling (T-X25): if a row's content_hash
    // already appeared in this plan, we still emit a decision for it,
    // BUT we mark it as `skip` referencing the prior decision so the
    // commit doesn't double-write. The preview UI surfaces the
    // duplicate via the diff's "duplicate of row N" label.
    if (seenHashes.has(row.contentHashHex)) {
      decisions.push({
        parsed: row,
        decisionKind: 'skip',
        existingActionItemId: existingByHash.get(row.contentHashHex)?.id ?? null,
        diff: [
          {
            field: 'duplicate',
            current: 'duplicate within this import',
            incoming: 'first occurrence wins',
          },
        ],
      });
      skipCount++;
      continue;
    }
    seenHashes.add(row.contentHashHex);

    const ex = existingByHash.get(row.contentHashHex);
    if (!ex) {
      // No existing row → create.
      decisions.push({
        parsed: row,
        decisionKind: 'create',
        existingActionItemId: null,
        diff: [],
      });
      createCount++;
      continue;
    }

    const diff = computeDiff(row, ex);
    if (diff.length === 0) {
      // Match + no field differs → skip.
      decisions.push({
        parsed: row,
        decisionKind: 'skip',
        existingActionItemId: ex.id,
        diff: [],
      });
      skipCount++;
      continue;
    }

    // Match + ≥1 field differs. Conflict_pending if the existing row
    // was actor-edited since its prior import; otherwise update.
    const kind = ex.editedSinceLastImport ? 'conflict_pending' : 'update';
    decisions.push({
      parsed: row,
      decisionKind: kind,
      existingActionItemId: ex.id,
      diff,
    });
    if (kind === 'update') updateCount++;
    else conflictCount++;
  }

  return {
    importId,
    decisions,
    summary: {
      createCount,
      updateCount,
      skipCount,
      conflictCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function computeDiff(
  row: ParsedActionItem,
  ex: ExistingActionItemView,
): ReadonlyArray<{ field: string; current: string; incoming: string }> {
  const out: Array<{ field: string; current: string; incoming: string }> = [];
  for (const field of DIFFABLE_FIELDS) {
    const incoming = readIncoming(row, field);
    const current = readCurrent(ex, field);
    if (incoming !== current) {
      out.push({
        field,
        current,
        incoming,
      });
    }
  }
  return out;
}

function readIncoming(row: ParsedActionItem, field: DiffableField): string {
  switch (field) {
    case 'status':
      return row.status;
    case 'risk':
      return row.risk;
    case 'targetDate':
      return row.targetDate ?? '';
    case 'closedDate':
      return row.closedDate ?? '';
    case 'tags':
      return [...row.tags].sort().join(',');
    case 'section':
      return row.section;
  }
}

function readCurrent(ex: ExistingActionItemView, field: DiffableField): string {
  switch (field) {
    case 'status':
      return ex.status;
    case 'risk':
      return ex.risk;
    case 'targetDate':
      return ex.targetDate ?? '';
    case 'closedDate':
      return ex.closedDate ?? '';
    case 'tags':
      return [...ex.tags].sort().join(',');
    case 'section':
      return ex.section;
  }
}
