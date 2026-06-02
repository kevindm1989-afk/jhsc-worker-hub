// Excel-import parser Web Worker — message contract only in S1.
//
// The worker BODY (SheetJS invocation, schema detection, per-sheet
// parsing, source-SHA-256 computation) lands in S2 per ADR-0010 §3.2.
// S1 lands the message-contract TYPES so:
//
//   - the web layer's worker spawner (apps/web/src/excel-import/) can
//     import the types now and have them stable;
//   - the test suite can import them to assert future regressions;
//   - any future PR that adds a fetch / postMessage shape outside this
//     narrow contract (T-X4 mitigation) trips the typechecker.
//
// The contract is intentionally narrow: ONE message in, ONE message
// out. No streaming. No mid-parse cancel signal (the rep closes the
// tab to abort; the worker is GC'd with the tab — SECURITY T-X3).

import type { DetectionResult } from './schema';

/**
 * Message the main thread posts to the worker.
 *
 *   - `kind: 'parse'`: parse this ArrayBuffer with SheetJS.
 *
 * No other message shapes are accepted. The worker's onmessage handler
 * (S2) rejects any input that does not match this shape.
 */
export interface WorkerInputMessage {
  readonly kind: 'parse';
  /** Raw .xlsx/.xlsm bytes (already size-checked by the spawner). */
  readonly arrayBuffer: ArrayBuffer;
}

/**
 * Message the worker posts back to the main thread.
 *
 *   - `kind: 'detection'`: success — the DetectionResult discriminated
 *     union (either `recognized` with the parsed shape, or
 *     `unrecognized` with a reason string).
 *
 *   - `kind: 'error'`: the worker hit an unrecoverable exception
 *     before producing a DetectionResult — SheetJS crashed, the worker
 *     ran out of memory, the ArrayBuffer was truncated mid-transfer.
 *     The message is human-readable but PI-clean (SECURITY T-X4: the
 *     worker has no access to cookies or storage, so the error string
 *     cannot carry session data even if a future logger leaked it).
 */
export type WorkerResponseMessage =
  | { readonly kind: 'detection'; readonly result: DetectionResult }
  | { readonly kind: 'error'; readonly message: string };
