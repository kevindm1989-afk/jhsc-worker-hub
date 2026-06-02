// Excel-import reconciliation engine — S1 stub, S2 implementation.
//
// The reconciliation engine takes a `ParsedSheets` (the parser's
// output) plus a projection of the existing action_items
// (`ExistingActionItemView[]`) and classifies each parsed row into
// one of four decision kinds per ADR-0010 §3.6:
//
//   create           — no existing row matches the content_hash
//   update           — match + at least one mutable field differs
//   skip             — match + no fields differ (idempotent re-import)
//   conflict_pending — match + the existing row was edited since the
//                      last import; rep must resolve in preview UI
//
// S1 lands the function signature so the route handler + the web
// layer's preview UI scaffolding can already import against it. S2
// fleshes out the body (the content_hash lookup, the field-diff
// computation, the conflict-detection rule).
//
// The function is pure — no IO. The caller passes the existing
// projection in as plain data; the reconciler does not fetch.

import type { ExistingActionItemView, ParsedSheets, ReconciliationPlan } from './schema';

/**
 * Reconcile a parsed workbook against the existing action_items
 * projection. Returns a deterministic plan the preview UI renders +
 * the commit-builder consumes.
 *
 * Pure function (S2 will land the body). Same input → same output;
 * non-mutating on both arguments.
 *
 * S1 STATUS: throws `'not implemented (S2)'`. The signature is stable
 * and exported from `./index.ts`; callers can already import it.
 */
export function reconcile(
  _parsed: ParsedSheets,
  _existing: ReadonlyArray<ExistingActionItemView>,
  _importId: string,
): ReconciliationPlan {
  throw new Error('reconcile: not implemented (S2)');
}
