// @jhsc/excel-import — public API surface (Milestone 1.11 S2).
//
// Per ADR-0010 §3.1 and CLAUDE.md non-negotiable #11:
//
//   This workspace is BROWSER-ONLY. No Node imports. No IO. The four
//   public entry points (parseWorkbook / parseWorkbookInWorker /
//   reconcile / commit) are pure functions consumed by the web bundle
//   + the Vitest suite. SheetJS (`xlsx`) is the only sizable runtime
//   dependency.
//
// S2 lands:
//   - parser.worker.ts (FULL): SheetJS-in-Worker body with hardened
//     options + 10MB cap + source SHA-256 first.
//   - schema.ts (FULL): detector + per-sheet parsers + cell-type
//     validation.
//   - reconciliation.ts (FULL): pure content_hash diff engine.
//   - this index.ts: parseWorkbook (main-thread) +
//     parseWorkbookInWorker (worker-spawning) implementations.
//
// IMPORTANT: per SECURITY T-X2, this workspace's contract is "no IO
// from the package". A future PR that adds fetch() / XMLHttpRequest /
// navigator.sendBeacon / Node imports breaks the contract. The S5
// runbook documents the bundle-grep assertion that enforces this.

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
// Schema + parser shapes (FULL implementation in S2)
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
  ValidationError,
  WorkbookLike,
} from './schema';

export { detectSchema } from './schema';

export type { WorkerInputMessage, WorkerResponseMessage } from './parser.worker';
export { MAX_FILE_BYTES, parseArrayBuffer } from './parser.worker';

// ---------------------------------------------------------------------------
// Reconciler (FULL implementation in S2)
// ---------------------------------------------------------------------------

export { reconcile } from './reconciliation';

// ---------------------------------------------------------------------------
// Main-thread parse + worker-spawning parse
// ---------------------------------------------------------------------------

import type { DetectionResult, ReconciliationPlan, CommitOperations } from './schema';
import { parseArrayBuffer } from './parser.worker';
import type { WorkerInputMessage, WorkerResponseMessage } from './parser.worker';

/**
 * Parse a workbook ArrayBuffer through the schema detector + per-sheet
 * parsers. Returns a `DetectionResult` discriminated union.
 *
 * Runs in the current thread (no worker spawn). Used by the unit tests
 * + the non-Worker fallback for environments without `Worker`.
 */
export async function parseWorkbook(arrayBuffer: ArrayBuffer): Promise<DetectionResult> {
  return parseArrayBuffer(arrayBuffer);
}

/**
 * Browser-side helper: spawn the parser.worker, post the ArrayBuffer,
 * await the response, terminate the worker (T-X3 ephemerality).
 *
 * The Web Worker URL is resolved via `new URL('./parser.worker.ts',
 * import.meta.url)` — Vite + esbuild + webpack all recognize this
 * pattern at build time and emit a separate worker bundle. The
 * `{type: 'module'}` option keeps the worker as ES-modules so the
 * `import * as XLSX from 'xlsx'` at the top of parser.worker.ts
 * resolves correctly in the worker scope.
 */
export async function parseWorkbookInWorker(arrayBuffer: ArrayBuffer): Promise<DetectionResult> {
  if (typeof Worker === 'undefined') {
    // Fallback path for Node tests + SSR contexts that don't expose
    // `Worker`. Runs the parser inline — same result; just no
    // off-main-thread isolation.
    return parseArrayBuffer(arrayBuffer);
  }
  // The worker URL is resolved by the bundler at build time. The
  // `type: 'module'` option keeps the worker ESM-native.
  const workerUrl = new URL('./parser.worker.ts', import.meta.url);
  const worker = new Worker(workerUrl, { type: 'module' });
  try {
    return await new Promise<DetectionResult>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerResponseMessage>) => {
        const msg = event.data;
        if (msg.kind === 'detection') {
          resolve(msg.result);
        } else {
          reject(new Error(msg.message));
        }
      };
      const onError = (err: ErrorEvent) => {
        reject(new Error(err.message || 'worker_error'));
      };
      worker.addEventListener('message', onMessage, { once: true });
      worker.addEventListener('error', onError, { once: true });
      const msg: WorkerInputMessage = { kind: 'parse', arrayBuffer };
      // Transfer the ArrayBuffer to the worker so the main thread does
      // not retain a second copy (memory budget + T-X3 wipe-after-parse
      // posture).
      worker.postMessage(msg, [arrayBuffer]);
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Build the commit-operations payload from a ReconciliationPlan.
 *
 * S2 STATUS: still a forward seam. The commit-builder lives in the web
 * layer (S3) because it needs the workplace public key (envelope
 * encryption is performed client-side) + access to Dexie for the
 * client-id allocation. The server route in
 * `apps/api/src/routes/excel-imports/index.ts` consumes the wire-shape
 * `operations` array directly — the helper here would have been a
 * convenience wrapper that the web layer never actually needs (the
 * preview view already walks the plan to build the operations inline
 * for the optimistic-UI render).
 */
export async function commit(
  _plan: ReconciliationPlan,
  _opts: { workplacePublicKey: Uint8Array; importId: string },
): Promise<CommitOperations> {
  throw new Error('commit: not implemented (consumed in apps/web/src/excel-import/ — see S3)');
}
