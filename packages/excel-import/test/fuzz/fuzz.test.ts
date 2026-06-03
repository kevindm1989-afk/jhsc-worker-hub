// Excel-import parser fuzz test (Milestone 1.12 S2, ADR-0011 §3.5,
// SECURITY §2.12 T-HD16..T-HD20).
//
// Runs the deterministic corpus from `fuzz-corpus.ts` through
// `parseArrayBuffer` and asserts the no-uncaught-throw + side-effect
// invariants.
//
// The parser entry returns the existing `DetectionResult` discriminated
// union (`{kind:'recognized'} | {kind:'unrecognized'}`). The ADR-0011
// §3.5 contract was originally specified against a `Result<T,
// ParseError>` shape, but the 1.11 parser ships the discriminated-union
// shape. We do NOT refactor the parser here — the harness adapts to the
// existing shape; the divergence is logged as a finding in
// `docs/release-1-fuzzing-findings.md` per the slice-2 brief.
//
// Per-case assertions (each MUST hold for every case in the corpus):
//   1. The parser MUST NOT throw an uncaught exception. A throw fails
//      the test with the case id + scenario + hex preview.
//   2. The parser MUST NOT mutate `Object.prototype`. We snapshot the
//      prototype's own-property names before the corpus runs and assert
//      equal after.
//   3. Each individual case MUST complete within 30s wall time (ReDoS
//      guard).
//   4. Files past the 10 MB cap MUST be rejected with the documented
//      `payload_too_large` reason BEFORE SheetJS is invoked.
//   5. Schema-mismatch cases MUST resolve to `kind: 'unrecognized'` —
//      never to `{kind:'recognized'}` with partial / invalid sheets.
//   6. No sensitive field is emitted outside the parser's result
//      envelope. The corpus generator emits no real PI; the structural
//      check is that the result is a plain JSON-serializable value.
//
// Configuration:
//   FUZZ_SEED   default 0x4A485343 ("JHSC") — set to a hex/dec number
//               to override.
//   FUZZ_CASES  default 1000 — set to a smaller number for local dev
//               iteration. CI runs the full 1000.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArrayBuffer } from '../../src/parser.worker';
import type { DetectionResult } from '../../src/schema';
import {
  generateCorpus,
  hexPreview,
  DEFAULT_FUZZ_SEED,
  PARSER_MAX_FILE_BYTES,
} from './fuzz-corpus';
import type { FuzzCase } from './fuzz-corpus';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readSeed(): number {
  const env = process.env.FUZZ_SEED;
  if (!env) return DEFAULT_FUZZ_SEED;
  // Accept both 0x-prefixed hex and plain decimal.
  if (env.startsWith('0x') || env.startsWith('0X')) {
    const n = Number.parseInt(env.slice(2), 16);
    return Number.isFinite(n) ? n >>> 0 : DEFAULT_FUZZ_SEED;
  }
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) ? n >>> 0 : DEFAULT_FUZZ_SEED;
}

function readCases(): number {
  const env = process.env.FUZZ_CASES;
  if (!env) return 1000;
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

const SEED = readSeed();
const CASES = readCases();
const FAILURE_DIR = join(__dirname, 'failures');

// Per-case wall-time budget (ReDoS guard). 30s per ADR-0011 §3.5.
const PER_CASE_TIMEOUT_MS = 30_000;
// Suite-wide timeout proportional to case count. Vitest defaults to
// 5s per test; we set this explicitly so the full corpus has headroom
// on slow CI runners (per SECURITY T-HD20).
const SUITE_TIMEOUT_MS = Math.max(60_000, CASES * 100);

// ---------------------------------------------------------------------------
// Prototype-pollution snapshot
// ---------------------------------------------------------------------------

let objectProtoSnapshot: ReadonlyArray<string> = [];
let arrayProtoSnapshot: ReadonlyArray<string> = [];
let stringProtoSnapshot: ReadonlyArray<string> = [];

function snapshotPrototype(p: object): string[] {
  return Object.getOwnPropertyNames(p).slice().sort();
}

beforeAll(() => {
  objectProtoSnapshot = snapshotPrototype(Object.prototype);
  arrayProtoSnapshot = snapshotPrototype(Array.prototype);
  stringProtoSnapshot = snapshotPrototype(String.prototype);
  mkdirSync(FAILURE_DIR, { recursive: true });
});

afterAll(() => {
  // Sanity — re-assert prototypes after every case has run.
  expect(snapshotPrototype(Object.prototype)).toEqual(objectProtoSnapshot);
  expect(snapshotPrototype(Array.prototype)).toEqual(arrayProtoSnapshot);
  expect(snapshotPrototype(String.prototype)).toEqual(stringProtoSnapshot);
});

// ---------------------------------------------------------------------------
// Failure dump
// ---------------------------------------------------------------------------

function dumpFailure(c: FuzzCase, reason: string, extra?: string): void {
  const safeId = c.id.replaceAll(':', '_').replaceAll('/', '_');
  // Truncate the dump body so a hostile huge case doesn't fill disk.
  const dumpLen = Math.min(c.bytes.byteLength, 4096);
  const dump = new Uint8Array(c.bytes, 0, dumpLen);
  const path = join(FAILURE_DIR, `${safeId}.bin`);
  const meta = join(FAILURE_DIR, `${safeId}.meta.txt`);
  writeFileSync(path, dump);
  writeFileSync(
    meta,
    [
      `id: ${c.id}`,
      `scenario: ${c.scenario}`,
      `index: ${c.index}`,
      `seed: 0x${c.seed.toString(16)}`,
      `byteLength: ${c.bytes.byteLength}`,
      `expectedOutcome: ${c.expectedOutcome}`,
      `mustRejectBeforeSheetJs: ${c.mustRejectBeforeSheetJs}`,
      `reason: ${reason}`,
      extra ? `extra: ${extra}` : '',
      `hexPreview: ${hexPreview(c.bytes, 256)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Per-case invariants
// ---------------------------------------------------------------------------

interface RunOutcome {
  readonly threw: boolean;
  readonly throwMessage: string | null;
  readonly result: DetectionResult | null;
  readonly durationMs: number;
}

async function runOne(c: FuzzCase): Promise<RunOutcome> {
  const t0 = Date.now();
  try {
    const result = await parseArrayBuffer(c.bytes);
    return {
      threw: false,
      throwMessage: null,
      result,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      threw: true,
      throwMessage: err instanceof Error ? err.message : String(err),
      result: null,
      durationMs: Date.now() - t0,
    };
  }
}

function isJsonSerializable(value: unknown): boolean {
  // Structural: the result envelope must round-trip through JSON. The
  // parser's result shape is a plain object with primitive leaves; a
  // function / symbol / unserializable getter would fail this check.
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Corpus run
// ---------------------------------------------------------------------------

describe(`excel-import parser fuzz (seed=0x${SEED.toString(16)}, cases=${CASES})`, () => {
  const corpus = generateCorpus({ seed: SEED, cases: CASES });

  it('corpus generation is deterministic', () => {
    const a = generateCorpus({ seed: SEED, cases: Math.min(16, CASES) });
    const b = generateCorpus({ seed: SEED, cases: Math.min(16, CASES) });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.id).toBe(b[i]!.id);
      expect(a[i]!.bytes.byteLength).toBe(b[i]!.bytes.byteLength);
    }
  });

  it(
    `runs ${CASES} adversarial cases without uncaught throws, prototype mutation, or partial schema match`,
    async () => {
      let cap_violations = 0;
      let schema_mismatch_partial = 0;
      let slow_cases = 0;

      for (const c of corpus) {
        const outcome = await runOne(c);

        // (1) No uncaught throw.
        if (outcome.threw) {
          dumpFailure(c, 'uncaught_throw', outcome.throwMessage ?? undefined);
          throw new Error(
            `FUZZ FAIL [${c.id}] uncaught throw: ${outcome.throwMessage} (preview=${hexPreview(c.bytes, 64)})`,
          );
        }

        // (2) Result is a structurally-valid DetectionResult envelope.
        if (
          !outcome.result ||
          typeof outcome.result !== 'object' ||
          !('kind' in outcome.result) ||
          (outcome.result.kind !== 'recognized' && outcome.result.kind !== 'unrecognized')
        ) {
          dumpFailure(c, 'malformed_envelope', JSON.stringify(outcome.result));
          throw new Error(
            `FUZZ FAIL [${c.id}] result envelope malformed: ${JSON.stringify(outcome.result)}`,
          );
        }

        // (3) Result is JSON-serializable (no functions, no
        // unserializable getters). The structured-clone result that
        // crosses the Worker boundary requires this.
        if (!isJsonSerializable(outcome.result)) {
          dumpFailure(c, 'non_serializable_result');
          throw new Error(`FUZZ FAIL [${c.id}] result not JSON-serializable`);
        }

        // (4) Per-case timing budget (ReDoS guard).
        if (outcome.durationMs > PER_CASE_TIMEOUT_MS) {
          dumpFailure(c, 'timeout', `durationMs=${outcome.durationMs}`);
          throw new Error(
            `FUZZ FAIL [${c.id}] exceeded ${PER_CASE_TIMEOUT_MS}ms budget: ${outcome.durationMs}ms (preview=${hexPreview(c.bytes, 64)})`,
          );
        }
        if (outcome.durationMs > 5_000) {
          // Soft signal — log but do not fail.
          slow_cases++;
        }

        // (5) Cap enforcement for oversized inputs. The cap check is
        // documented in parser.worker.ts as a `byteLength > cap →
        // {kind:'unrecognized', reason:'payload_too_large'}` return.
        if (c.mustRejectBeforeSheetJs) {
          if (c.bytes.byteLength <= PARSER_MAX_FILE_BYTES) {
            throw new Error(
              `FUZZ FAIL [${c.id}] test setup bug: mustRejectBeforeSheetJs=true but byteLength=${c.bytes.byteLength} <= cap`,
            );
          }
          if (
            outcome.result.kind !== 'unrecognized' ||
            outcome.result.reason !== 'payload_too_large'
          ) {
            cap_violations++;
            dumpFailure(
              c,
              'cap_not_enforced',
              `got kind=${outcome.result.kind} reason=${'reason' in outcome.result ? outcome.result.reason : 'N/A'}`,
            );
            throw new Error(
              `FUZZ FAIL [${c.id}] 10MB cap not enforced: byteLength=${c.bytes.byteLength}, result=${JSON.stringify(outcome.result)}`,
            );
          }
        }

        // (6) Schema-mismatch cases MUST be unrecognized — never a
        // partial 'recognized'. The parser must fail-closed per
        // CLAUDE.md non-negotiable #11.
        if (c.scenario === 'schema_mismatch' && c.expectedOutcome === 'unrecognized') {
          if (outcome.result.kind !== 'unrecognized') {
            schema_mismatch_partial++;
            dumpFailure(c, 'schema_mismatch_recognized_as_partial');
            throw new Error(
              `FUZZ FAIL [${c.id}] schema-mismatch case parsed as recognized — partial-import contract violated`,
            );
          }
        }

        // (7) Object.prototype not mutated.
        //   Snapshot check happens per-case for prototype-pollution
        //   scenario; the all-suite check runs in afterAll().
        if (c.scenario === 'prototype_pollution') {
          const live = snapshotPrototype(Object.prototype);
          if (live.length !== objectProtoSnapshot.length) {
            dumpFailure(c, 'prototype_mutation');
            throw new Error(
              `FUZZ FAIL [${c.id}] Object.prototype mutated: before=${objectProtoSnapshot.length} keys, after=${live.length}`,
            );
          }
        }
      }

      // Summary — informational only; the per-case asserts above are
      // the failure surface. Log via warn so the no-console rule is
      // satisfied (test files have no-console: off, but warn is
      // accepted everywhere).
      if (slow_cases > 0) {
        console.warn(
          `[fuzz] ${slow_cases}/${CASES} case(s) exceeded the 5s soft-budget (none exceeded the 30s hard budget)`,
        );
      }
      console.warn(
        `[fuzz] complete: seed=0x${SEED.toString(16)} cases=${CASES} cap_violations=${cap_violations} schema_mismatch_partial=${schema_mismatch_partial}`,
      );
    },
    SUITE_TIMEOUT_MS,
  );
});
