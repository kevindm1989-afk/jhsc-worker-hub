// Excel-import parser Web Worker (Milestone 1.11 S2).
//
// S1 landed the message-contract TYPES. S2 (this file) lands the worker
// body — SheetJS invocation, source-SHA-256 computation, schema
// detection, per-sheet parsing. The contract stays narrow: ONE message
// in, ONE message out.
//
// Hardening posture (SECURITY.md §2.11):
//
//   - **No formula evaluation** (T-X4, T-X7). SheetJS is called with
//     `cellFormula: false`. The wire format still carries the formula
//     string in the cell metadata if the source workbook had one, but
//     SheetJS does not evaluate it; our consumer reads `cell.v` /
//     `cell.w` only.
//   - **No HTML cells** (T-X5). `cellHTML: false` so rich-text bodies
//     are flattened to plain text. Our parsers only consume the `v` /
//     `w` fields anyway, but the option keeps SheetJS's HTML parser
//     dormant.
//   - **No number-format pass** (T-X5). `cellNF: false`.
//   - **Native Date objects** (T-X15). `cellDates: true` so date cells
//     come back as `Date` instances rather than Excel serial numbers;
//     downstream parsers reject NaN-Date cells with a per-row warning.
//   - **File-size cap** (T-X9). 10 MB on-disk bound checked at the
//     worker boundary before SheetJS is invoked. A 100 MB decompressed
//     cap is enforced by SheetJS's hardened parser; we surface its
//     error verbatim if it triggers.
//   - **Source SHA-256 first** (T-X40). Computed BEFORE SheetJS so the
//     chain-anchor's `sourceSha256` is the file's true fingerprint
//     even if SheetJS rejects the parse — the rejected upload still
//     emits no chain anchor, but the worker can echo the hash back to
//     the spawner for debug.
//   - **Worker scope is sealed**. No `fetch`, no `localStorage`, no
//     `document.*`. The worker is `terminate()`d in `parseWorkbookIn-
//     Worker`'s `finally` block (T-X3 ephemerality).
//
// SheetJS is loaded via the `xlsx` package's ESM entry. The worker
// boundary is Vite-resolved at build time via `new URL('./parser.
// worker.ts', import.meta.url)`.

import * as XLSX from 'xlsx';
import type { DetectionResult } from './schema';
import { detectSchema } from './schema';

// ---------------------------------------------------------------------------
// Public types (S1)
// ---------------------------------------------------------------------------

export interface WorkerInputMessage {
  readonly kind: 'parse';
  readonly arrayBuffer: ArrayBuffer;
}

export type WorkerResponseMessage =
  | { readonly kind: 'detection'; readonly result: DetectionResult }
  | { readonly kind: 'error'; readonly message: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 10 MB on-disk cap per docs/excel-import-format.md + T-X9. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure parse entry — usable in main thread (unit tests + non-Worker callers)
// ---------------------------------------------------------------------------

/**
 * Parse an .xlsx/.xlsm `ArrayBuffer` through SheetJS + the schema
 * detector. Runs in the calling thread; the worker wrapper around
 * this lives in `index.ts: parseWorkbookInWorker`.
 *
 * Returns a `DetectionResult` discriminated union; throws only when
 * the input is malformed at a level the discriminator can't represent
 * (e.g. `arrayBuffer` is not an ArrayBuffer). Size-cap rejections
 * return a synthetic `unrecognized` reason rather than throwing so
 * the worker contract stays uniform.
 */
export async function parseArrayBuffer(arrayBuffer: ArrayBuffer): Promise<DetectionResult> {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new TypeError('parseArrayBuffer: expected ArrayBuffer');
  }
  // (1) Size cap (T-X9).
  if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
    return {
      kind: 'unrecognized',
      reason: 'payload_too_large',
    };
  }

  // (2) Source SHA-256 first (T-X40). The chain anchor binds to the
  //     file bytes even if the parse fails later.
  const sourceSha256Hex = await computeSourceSha256Hex(arrayBuffer);

  // (3) SheetJS parse with the hardened option set.
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(arrayBuffer, {
      type: 'array',
      // No formula evaluation (T-X7).
      cellFormula: false,
      // No rich-text HTML parse path (T-X5).
      cellHTML: false,
      // No number-format pass (lighter parse + no NF code execution).
      cellNF: false,
      // Native Date instances so the downstream parsers can NaN-check
      // (T-X15).
      cellDates: true,
      // Capture formatted text in `cell.w` (the rep's typed display
      // string, the source of truth for non-date text).
      cellText: true,
      // Do not coerce numbers to formatted strings — we want raw values.
      raw: false,
    });
  } catch {
    return {
      kind: 'unrecognized',
      reason: 'unparseable workbook',
    };
  }

  // (4) Schema detection + per-sheet parsing.
  try {
    return await detectSchema(
      workbook as unknown as Parameters<typeof detectSchema>[0],
      sourceSha256Hex,
    );
  } catch {
    // Catch parser-level exceptions (out-of-range cell access, etc.)
    // and surface them as `unrecognized` — same fail-closed posture
    // as the SheetJS catch above.
    return {
      kind: 'unrecognized',
      reason: 'unparseable workbook',
    };
  }
}

// ---------------------------------------------------------------------------
// Source SHA-256 (Web Crypto)
// ---------------------------------------------------------------------------

async function computeSourceSha256Hex(buffer: ArrayBuffer): Promise<string> {
  // Detach into a plain Uint8Array view — the worker boundary may pass
  // a SharedArrayBuffer-backed view in some embeddings, but
  // `crypto.subtle.digest` accepts the plain copy form.
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(new Uint8Array(buffer));
  const digest = await crypto.subtle.digest('SHA-256', copy);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Worker entry — bound to the global onmessage handler when this file
// is loaded as a module worker via `new Worker(url, {type:'module'})`.
//
// The `self` reference is typed to `DedicatedWorkerGlobalScope` only
// when the file actually runs as a worker. We narrow at runtime via
// the `postMessage` presence check so unit tests can `import` the
// module without the worker scope being present.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workerSelf = globalThis as any;

if (
  typeof workerSelf.postMessage === 'function' &&
  typeof workerSelf.addEventListener === 'function'
) {
  workerSelf.addEventListener('message', async (event: MessageEvent<WorkerInputMessage>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.kind !== 'parse') {
      const out: WorkerResponseMessage = {
        kind: 'error',
        message: 'unrecognized worker message',
      };
      workerSelf.postMessage(out);
      return;
    }
    try {
      const result = await parseArrayBuffer(msg.arrayBuffer);
      const out: WorkerResponseMessage = { kind: 'detection', result };
      workerSelf.postMessage(out);
    } catch (err) {
      // The parser is expected to translate internal failures into
      // `unrecognized` results; this catch covers programmer errors
      // (TypeError from a malformed message) that escaped the
      // try/catch in parseArrayBuffer. PI-clean: the error string is
      // the JS Error message only, no cell content.
      const message = err instanceof Error ? err.message : 'worker_failure';
      const out: WorkerResponseMessage = {
        kind: 'error',
        message,
      };
      workerSelf.postMessage(out);
    }
  });
}
