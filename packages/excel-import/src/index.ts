// @jhsc/excel-import — public API surface (S1).
//
// Per ADR-0010 §3.1 and CLAUDE.md non-negotiable #11:
//
//   This workspace is BROWSER-ONLY. No Node imports. No IO. The four
//   public entry points (parseWorkbook / reconcile / commit /
//   parseWorkbookInWorker) are pure functions consumed by the web
//   bundle + the Vitest suite. SheetJS (`xlsx`) is the only sizable
//   runtime dependency; libsodium-wrappers will be added in S2 for the
//   envelope-encryption helpers (the package re-uses
//   `apps/web/src/evidence/crypto.ts: sealEvidence` posture).
//
// S1 lands:
//   - canonical.ts (FULL): content_hash canonicalization + SHA-256.
//   - pii.ts (FULL): the 4-class PII heuristic.
//   - schema.ts (TYPES): the DetectionResult / ParsedSheets /
//     ReconciliationPlan / CommitOperations contracts.
//   - parser.worker.ts (TYPES): the Worker message contract.
//   - reconciliation.ts (STUB): function signature; S2 lands body.
//   - this index.ts: the public API surface re-exports.
//
// S2 will land the parser body, the detector, the per-sheet parsers,
// the reconciler body, and the commit builder.
//
// IMPORTANT: per SECURITY T-X2, this workspace's contract is "no IO
// from the package". A future PR that adds fetch() / XMLHttpRequest /
// navigator.sendBeacon / Node imports breaks the contract. The S5
// runbook will document the bundle-grep assertion that enforces this.

// ---------------------------------------------------------------------------
// content_hash canonicalization (FULL implementation in S1)
// ---------------------------------------------------------------------------

export {
  canonicalizeDescription,
  canonicalizeStartDate,
  computeContentHash,
  contentHashHex,
} from './canonical';

// ---------------------------------------------------------------------------
// PII heuristic (FULL implementation in S1)
// ---------------------------------------------------------------------------

export { scanForPii } from './pii';
export type { PiiFlags, PiiMatch } from './pii';

// ---------------------------------------------------------------------------
// Schema + parser shapes (types only in S1; bodies land in S2)
// ---------------------------------------------------------------------------

export type {
  CommitOperation,
  CommitOperations,
  DetectionResult,
  ExcelImportSchemaVersion,
  ExistingActionItemView,
  ParsedActionItem,
  ParsedInspectionReview,
  ParsedMeetingMetadata,
  ParsedSheets,
  ReconcileDecision,
  ReconcileDecisionKind,
  ReconciliationPlan,
} from './schema';

export type { WorkerInputMessage, WorkerResponseMessage } from './parser.worker';

// ---------------------------------------------------------------------------
// Reconciler stub (S2 fleshes out)
// ---------------------------------------------------------------------------

export { reconcile } from './reconciliation';

// ---------------------------------------------------------------------------
// S1 placeholder API for parseWorkbook + commit + parseWorkbookInWorker
//
// These are intentionally stubs that throw — the route layer + the
// web UI scaffolding can already import them so S2 lands as an
// implementation swap, not an API surface change. T-X2 contract is
// honored even in the stubs (no fetch, no IO; just `throw new Error`).
// ---------------------------------------------------------------------------

import type { DetectionResult, CommitOperations, ReconciliationPlan } from './schema';

/**
 * Parse a workbook ArrayBuffer through the schema detector + per-sheet
 * parsers. Returns a DetectionResult discriminated union.
 *
 * S1 STATUS: throws `'not implemented (S2)'`. S2 lands the SheetJS
 * invocation per ADR §3.2 + the detector per §3.3 + the per-sheet
 * parsers per §3.4.
 */
export async function parseWorkbook(_arrayBuffer: ArrayBuffer): Promise<DetectionResult> {
  throw new Error('parseWorkbook: not implemented (S2)');
}

/**
 * Browser-side helper: spawn the parser.worker, post the ArrayBuffer,
 * await the response, terminate the worker (T-X3 ephemerality).
 *
 * S1 STATUS: throws `'not implemented (S2)'`. S2 lands the
 * `new Worker(new URL('./parser.worker.ts', import.meta.url))`
 * invocation + the structured-clone postMessage + the result await.
 */
export async function parseWorkbookInWorker(_arrayBuffer: ArrayBuffer): Promise<DetectionResult> {
  throw new Error('parseWorkbookInWorker: not implemented (S2)');
}

/**
 * Build the commit-operations payload from a ReconciliationPlan.
 * Envelope-seals every sensitive field under the workplace public key
 * (mirrors `apps/web/src/evidence/crypto.ts: sealEvidence`). Returns
 * the ordered operations the route handler POSTs.
 *
 * S1 STATUS: throws `'not implemented (S2)'`. S2 lands the libsodium
 * sealed-box invocation per ADR §3.9 + the per-row clientId allocation
 * + the operation ordering.
 */
export async function commit(
  _plan: ReconciliationPlan,
  _opts: { workplacePublicKey: Uint8Array; importId: string },
): Promise<CommitOperations> {
  throw new Error('commit: not implemented (S2)');
}
