// Excel-import parser fuzzing corpus (Milestone 1.12 S2, ADR-0011 §3.5,
// SECURITY §2.12 T-HD16..T-HD20).
//
// Deterministic-seed generator that produces N adversarial cases per
// run across 8 scenario classes. The seed is taken from the
// `FUZZ_SEED` env var (default `0xJHSC`); each case has a stable id
// derived from `(seed, class, index)` so a failure reproduces.
//
// Per ADR-0011 §3.5 the harness asserts the no-uncaught-throw
// invariant; this file is the input side (the generator). The
// assertion side lives in `fuzz.test.ts`.
//
// Hardening targets (per CLAUDE.md non-negotiable #11 + SECURITY §2.11
// T-X3 through T-X12 + §2.12 T-HD16..T-HD20):
//   1. Empty / zero-byte files
//   2. Truncated xlsx — valid ZIP magic then cut off
//   3. Files exceeding the 10 MB worker cap (cap enforcement)
//   4. Prototype-pollution sentinel keys in cells / sheet names /
//      defined names (`__proto__`, `constructor`, `prototype`)
//   5. ReDoS-bait strings (long runs + nested-quantifier traps from
//      GHSA-XXX advisories against SheetJS pre-0.20.x)
//   6. Unicode edge cases — bidi overrides, ZWJ, RTL/LTR marks,
//      surrogate pairs, NULs, control chars
//   7. Schema-mismatch — valid xlsx, missing required sheets/columns;
//      must produce the documented "unrecognized format" error, not a
//      partial import
//   8. Malformed-but-not-truncated xlsx — bad central directory,
//      mismatched CRC, deflate-stream noise
//
// PI-clean: the generator emits no real worker / workplace / person
// identifiers. Every adversarial payload is a synthetic test
// sentinel.

import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — small, fast, reproducible.
// We do not use Math.random / Date.now / crypto.randomBytes because the
// harness must reproduce a failure exactly from a (seed, class, index)
// triple alone.
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return function rng(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function rngBytes(rng: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rngInt(rng, 256);
  return out;
}

// ---------------------------------------------------------------------------
// Scenario taxonomy
// ---------------------------------------------------------------------------

export const FUZZ_SCENARIOS = [
  'empty',
  'truncated_xlsx',
  'oversize',
  'prototype_pollution',
  'redos_bait',
  'unicode_edges',
  'schema_mismatch',
  'malformed_xlsx',
] as const;

export type FuzzScenario = (typeof FUZZ_SCENARIOS)[number];

export interface FuzzCase {
  /** Stable id: derived from (seed, scenario, index). Reproduces the
   *  exact bytes when fed back through the generator with the same
   *  seed + scenario + index. */
  readonly id: string;
  readonly scenario: FuzzScenario;
  readonly index: number;
  readonly seed: number;
  /** Raw input bytes posted to the parser. */
  readonly bytes: ArrayBuffer;
  /** Expected outcome class — `unrecognized` if the parser must reject
   *  with a documented unrecognized reason; `either` if either
   *  `recognized` (rare, but the random bytes happen to align) or
   *  `unrecognized` is acceptable as long as no uncaught throw occurs. */
  readonly expectedOutcome: 'unrecognized' | 'either';
  /** Whether the parser must reject before invoking SheetJS — true for
   *  oversized inputs (cap enforcement). */
  readonly mustRejectBeforeSheetJs: boolean;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/** The default seed when FUZZ_SEED is unset. 0x4A485343 = "JHSC". */
export const DEFAULT_FUZZ_SEED = 0x4a485343;

/** Cap-enforcement check: 10 MB on-disk per packages/excel-import/parser.worker.ts. */
export const PARSER_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface CorpusConfig {
  readonly seed: number;
  /** Total cases across all scenarios. Distributed evenly across the 8
   *  scenario classes; remainder cases land in the first scenarios. */
  readonly cases: number;
}

export function generateCorpus(config: CorpusConfig): FuzzCase[] {
  const { seed, cases } = config;
  if (cases <= 0) return [];
  const perScenario = Math.floor(cases / FUZZ_SCENARIOS.length);
  const remainder = cases % FUZZ_SCENARIOS.length;
  const out: FuzzCase[] = [];
  for (let s = 0; s < FUZZ_SCENARIOS.length; s++) {
    const scenario = FUZZ_SCENARIOS[s] as FuzzScenario;
    const count = perScenario + (s < remainder ? 1 : 0);
    for (let i = 0; i < count; i++) {
      out.push(generateCase(seed, scenario, i));
    }
  }
  return out;
}

export function generateCase(seed: number, scenario: FuzzScenario, index: number): FuzzCase {
  // Derive a per-case sub-seed so cases within a scenario are
  // deterministic but independent.
  const subSeed = mixSeed(seed, scenario, index);
  const rng = makeRng(subSeed);
  const id = `${seed.toString(16)}:${scenario}:${index}`;
  switch (scenario) {
    case 'empty':
      return makeEmptyCase(id, scenario, index, seed, rng);
    case 'truncated_xlsx':
      return makeTruncatedCase(id, scenario, index, seed, rng);
    case 'oversize':
      return makeOversizeCase(id, scenario, index, seed, rng);
    case 'prototype_pollution':
      return makePrototypePollutionCase(id, scenario, index, seed, rng);
    case 'redos_bait':
      return makeRedosBaitCase(id, scenario, index, seed, rng);
    case 'unicode_edges':
      return makeUnicodeEdgesCase(id, scenario, index, seed, rng);
    case 'schema_mismatch':
      return makeSchemaMismatchCase(id, scenario, index, seed, rng);
    case 'malformed_xlsx':
      return makeMalformedXlsxCase(id, scenario, index, seed, rng);
  }
}

function mixSeed(seed: number, scenario: FuzzScenario, index: number): number {
  // Hash (seed, scenarioIndex, caseIndex) to a 32-bit subseed.
  const scenarioIdx = FUZZ_SCENARIOS.indexOf(scenario);
  let h = seed >>> 0;
  h = Math.imul(h ^ scenarioIdx, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ index, 0xc2b2ae35) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Empty / zero-byte
// ---------------------------------------------------------------------------

function makeEmptyCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  rng: () => number,
): FuzzCase {
  // Variants: 0 bytes; a single 0x00; a single 0xFF; a few-byte garbage.
  const variant = index % 4;
  let bytes: Uint8Array;
  if (variant === 0) {
    bytes = new Uint8Array(0);
  } else if (variant === 1) {
    bytes = new Uint8Array([0x00]);
  } else if (variant === 2) {
    bytes = new Uint8Array([0xff]);
  } else {
    bytes = rngBytes(rng, 4 + rngInt(rng, 8));
  }
  return {
    id,
    scenario,
    index,
    seed,
    bytes: bytes.buffer.slice(0) as ArrayBuffer,
    expectedOutcome: 'unrecognized',
    mustRejectBeforeSheetJs: false,
  };
}

// ---------------------------------------------------------------------------
// Scenario 2 — Truncated xlsx (valid PK\x03\x04 ZIP magic + tail cut)
// ---------------------------------------------------------------------------

function makeTruncatedCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  rng: () => number,
): FuzzCase {
  // Start with a small valid-looking ZIP header; then either just the
  // header, or header + partial body. The result is structurally
  // unparseable.
  const ZIP_HEADER = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  const tailLen = rngInt(rng, 256);
  const tail = rngBytes(rng, tailLen);
  const buf = new Uint8Array(ZIP_HEADER.length + tailLen);
  buf.set(ZIP_HEADER, 0);
  buf.set(tail, ZIP_HEADER.length);
  return {
    id,
    scenario,
    index,
    seed,
    bytes: buf.buffer.slice(0) as ArrayBuffer,
    expectedOutcome: 'unrecognized',
    mustRejectBeforeSheetJs: false,
  };
}

// ---------------------------------------------------------------------------
// Scenario 3 — Oversize (cap enforcement)
// ---------------------------------------------------------------------------

function makeOversizeCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  _rng: () => number,
): FuzzCase {
  // Three variants: just past cap (cap + 1B), 1MB past cap, 50MB past cap.
  const variant = index % 3;
  let len: number;
  if (variant === 0) {
    len = PARSER_MAX_FILE_BYTES + 1;
  } else if (variant === 1) {
    len = PARSER_MAX_FILE_BYTES + 1024 * 1024;
  } else {
    len = PARSER_MAX_FILE_BYTES + 50 * 1024 * 1024;
  }
  // We do NOT fill the entire 50MB with PRNG bytes per case — that
  // would balloon corpus generation time. The parser rejects on
  // `byteLength` BEFORE looking at content (T-X9). A zero-filled
  // ArrayBuffer of the same byteLength is structurally identical for
  // cap-enforcement.
  const buf = new ArrayBuffer(len);
  return {
    id,
    scenario,
    index,
    seed,
    bytes: buf,
    expectedOutcome: 'unrecognized',
    mustRejectBeforeSheetJs: true,
  };
}

// ---------------------------------------------------------------------------
// Scenario 4 — Prototype-pollution sentinel keys
// ---------------------------------------------------------------------------

const PROTO_SENTINELS = ['__proto__', 'constructor', 'prototype'] as const;

function makePrototypePollutionCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  rng: () => number,
): FuzzCase {
  // Build a valid xlsx whose cell values + sheet names + defined names
  // contain prototype-pollution sentinels. SheetJS should not interpret
  // these as object keys (it stores cell values as strings); the test
  // asserts `Object.prototype` is unchanged after parse.
  const sentinel = PROTO_SENTINELS[index % PROTO_SENTINELS.length] as string;
  const wb = XLSX.utils.book_new();
  // Sheet name = sentinel (length-bound to 31 chars per Excel rule;
  // SheetJS normalizes internally).
  const sheetName = `${sentinel}`.slice(0, 31);
  const ws = XLSX.utils.aoa_to_sheet([
    [sentinel, `__proto__.polluted=${rngInt(rng, 1000)}`],
    ['constructor', 'prototype'],
    [`${sentinel}.${sentinel}`, `{"__proto__":{"polluted":true}}`],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return {
    id,
    scenario,
    index,
    seed,
    bytes: out,
    // The schema detector rejects on missing required sheets;
    // sentinel-only workbooks are unrecognized.
    expectedOutcome: 'unrecognized',
    mustRejectBeforeSheetJs: false,
  };
}

// ---------------------------------------------------------------------------
// Scenario 5 — ReDoS bait
// ---------------------------------------------------------------------------

function makeRedosBaitCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  rng: () => number,
): FuzzCase {
  // Bait strings target nested-quantifier traps documented in the
  // GHSA-w7vf-rrwx-432r / GHSA-5pgg-2g8v-p4x9 advisories against
  // pre-0.20.x SheetJS. They are bounded in length so corpus
  // generation stays fast, but long enough to trip a naive regex.
  const baitVariants = [
    'a'.repeat(2048) + '!', // long-run + boundary
    '(' + 'a'.repeat(1024) + ')*b', // group-quantifier
    'a'.repeat(512) + '\\b' + 'a'.repeat(512),
    '/'.repeat(2048),
    'ab'.repeat(1024) + 'c',
    '\\' + 'x'.repeat(2048),
  ];
  const bait = baitVariants[index % baitVariants.length] as string;
  const wb = XLSX.utils.book_new();
  // Single sheet with the bait in one cell + a few smaller fields.
  const ws = XLSX.utils.aoa_to_sheet([
    ['Meeting Date', '2026-01-01'],
    [bait, bait],
    [`row${rngInt(rng, 100)}`, bait.slice(0, 256)],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Minutes');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return {
    id,
    scenario,
    index,
    seed,
    bytes: out,
    expectedOutcome: 'unrecognized',
    mustRejectBeforeSheetJs: false,
  };
}

// ---------------------------------------------------------------------------
// Scenario 6 — Unicode edges
// ---------------------------------------------------------------------------

const UNICODE_EDGE_STRINGS = [
  '‮‭', // RLO + LRO bidi override
  '⁦⁧⁨⁩', // LRI / RLI / FSI / PDI
  '‍'.repeat(50), // ZWJ runs
  '‎‏', // LRM / RLM
  '👨👩', // surrogate pair (👨👩)
  ' ', // NUL + low controls
  '�￾￿', // replacement + noncharacters
  '\uD800', // unpaired high surrogate — INVALID
  '\uDFFF', // unpaired low surrogate — INVALID
  '؜', // arabic letter mark
  '  ', // line/paragraph separators
];

function makeUnicodeEdgesCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  rng: () => number,
): FuzzCase {
  const edge = UNICODE_EDGE_STRINGS[index % UNICODE_EDGE_STRINGS.length] as string;
  const wb = XLSX.utils.book_new();
  // Embed the edge string into header cells + body cells + sheet names.
  // SheetJS may reject the unpaired-surrogate forms at write time;
  // catch + try the next variant if so.
  try {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Meeting Date', edge],
      [edge, edge + '!' + edge],
      [`row${rngInt(rng, 100)}`, edge.repeat(8)],
    ]);
    const safeSheetName = `Minutes${edge.codePointAt(0)?.toString(16) ?? 'x'}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName);
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    return {
      id,
      scenario,
      index,
      seed,
      bytes: out,
      expectedOutcome: 'unrecognized',
      mustRejectBeforeSheetJs: false,
    };
  } catch {
    // SheetJS refused to encode the edge string — that itself is
    // fail-closed; the parser will never see this case. Emit a
    // benign random buffer so the case index stays stable.
    const buf = rngBytes(rng, 256);
    return {
      id,
      scenario,
      index,
      seed,
      bytes: buf.buffer.slice(0) as ArrayBuffer,
      expectedOutcome: 'unrecognized',
      mustRejectBeforeSheetJs: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Scenario 7 — Schema mismatch (valid xlsx, missing required sheets)
// ---------------------------------------------------------------------------

function makeSchemaMismatchCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  _rng: () => number,
): FuzzCase {
  // Valid xlsx with structurally correct content but the wrong sheet
  // names. Per docs/excel-import-format.md the required sheets are
  // Minutes / NEW BUSINESS / OLD BUSINESS / NOTICE OF RECOMMENDATION
  // / COMPLETED.
  const wb = XLSX.utils.book_new();
  const variant = index % 5;
  // Variant 0: zero sheets matching the required set.
  // Variant 1: only Minutes (missing the four business sheets).
  // Variant 2: required sheets present but Minutes is missing the
  //            "Meeting Date" label.
  // Variant 3: required sheets present but column headers are wrong.
  // Variant 4: completely unrelated sheet names.
  if (variant === 0) {
    const ws = XLSX.utils.aoa_to_sheet([['Hello', 'World']]);
    XLSX.utils.book_append_sheet(wb, ws, 'NotRecognized');
  } else if (variant === 1) {
    const ws = XLSX.utils.aoa_to_sheet([['Meeting Date', '2026-01-01']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Minutes');
  } else if (variant === 2) {
    const minutes = XLSX.utils.aoa_to_sheet([['NotMeetingDate', '2026-01-01']]);
    XLSX.utils.book_append_sheet(wb, minutes, 'Minutes');
    for (const s of ['NEW BUSINESS', 'OLD BUSINESS', 'NOTICE OF RECOMMENDATION', 'COMPLETED']) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), s);
    }
  } else if (variant === 3) {
    const minutes = XLSX.utils.aoa_to_sheet([['Meeting Date', '2026-01-01']]);
    XLSX.utils.book_append_sheet(wb, minutes, 'Minutes');
    for (const s of ['NEW BUSINESS', 'OLD BUSINESS', 'NOTICE OF RECOMMENDATION', 'COMPLETED']) {
      // Wrong column headers.
      const ws = XLSX.utils.aoa_to_sheet([['NotADescription', 'NotADate']]);
      XLSX.utils.book_append_sheet(wb, ws, s);
    }
  } else {
    for (const s of ['Sheet1', 'Sheet2', 'Sheet3']) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), s);
    }
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return {
    id,
    scenario,
    index,
    seed,
    bytes: out,
    expectedOutcome: 'unrecognized',
    mustRejectBeforeSheetJs: false,
  };
}

// ---------------------------------------------------------------------------
// Scenario 8 — Malformed-but-not-truncated xlsx (corrupted ZIP body)
// ---------------------------------------------------------------------------

function makeMalformedXlsxCase(
  id: string,
  scenario: FuzzScenario,
  index: number,
  seed: number,
  rng: () => number,
): FuzzCase {
  // Start with a valid xlsx, then corrupt it. Three flavours:
  //   - flip 1% of bytes
  //   - zero out the central-directory region (last 22 bytes)
  //   - append deflate-stream noise after the EOCD
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['Meeting Date', '2026-01-01']]),
    'Minutes',
  );
  const baseBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const variant = index % 3;
  const view = new Uint8Array(baseBuf.slice(0));
  if (variant === 0) {
    // Flip 1% of bytes.
    const flipCount = Math.max(1, Math.floor(view.length * 0.01));
    for (let i = 0; i < flipCount; i++) {
      const idx = rngInt(rng, view.length);
      view[idx] = (view[idx]! ^ rngInt(rng, 256)) & 0xff;
    }
  } else if (variant === 1) {
    // Zero out tail (where central directory ends).
    const wipeStart = Math.max(0, view.length - 22);
    for (let i = wipeStart; i < view.length; i++) view[i] = 0;
  } else {
    // Append deflate noise.
    const noise = rngBytes(rng, 128);
    const combined = new Uint8Array(view.length + noise.length);
    combined.set(view, 0);
    combined.set(noise, view.length);
    return {
      id,
      scenario,
      index,
      seed,
      bytes: combined.buffer.slice(0) as ArrayBuffer,
      expectedOutcome: 'either',
      mustRejectBeforeSheetJs: false,
    };
  }
  return {
    id,
    scenario,
    index,
    seed,
    bytes: view.buffer.slice(0) as ArrayBuffer,
    expectedOutcome: 'either',
    mustRejectBeforeSheetJs: false,
  };
}

// ---------------------------------------------------------------------------
// Failure-dump helpers
// ---------------------------------------------------------------------------

/** Truncate a buffer to a short hex string for failure-dump output. */
export function hexPreview(buf: ArrayBuffer, maxBytes = 64): string {
  const view = new Uint8Array(buf, 0, Math.min(buf.byteLength, maxBytes));
  let s = '';
  for (let i = 0; i < view.length; i++) s += view[i]!.toString(16).padStart(2, '0');
  if (buf.byteLength > maxBytes) s += `...(+${buf.byteLength - maxBytes}B)`;
  return s;
}
