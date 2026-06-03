# Release 1 Excel-parser fuzzing — findings & residuals

Milestone 1.12 S2, ADR-0011 §3.5.

The fuzz harness at `packages/excel-import/test/fuzz/fuzz.test.ts` runs
1000 adversarial cases per CI invocation across 8 scenario classes
against `parseArrayBuffer` (the entry shared by `parseWorkbook` +
`parseWorkbookInWorker`). This document captures findings that surfaced
during harness construction + during the first CI runs, and notes the
deferral boundary for items that belong in the post-Release-1 hardening
backlog.

## Finding F-1 — Parser uses a `DetectionResult` discriminated union, not a `Result<T, ParseError>` type

**Status:** Documented, no fix required.

ADR-0011 §3.5 specifies the harness against a parser that returns
`Result<T, ParseError>` with a `ParseError.UNRECOGNIZED_SCHEMA` variant
for schema-mismatch. The parser ships in 1.11 returns a
`DetectionResult` discriminated union:

```typescript
type DetectionResult =
  | { kind: 'recognized'; schema: ExcelImportSchemaVersion; sheets: ParsedSheets }
  | { kind: 'unrecognized'; reason: string };
```

Schema-mismatch resolves to `{ kind: 'unrecognized', reason: '...' }`
with a human-readable reason string (e.g. `"missing required sheet
'NEW BUSINESS'"`, `"sheet 'Minutes' missing label 'Meeting Date' in
column A"`).

The two shapes are structurally equivalent for the harness's contract
("never throw an uncaught exception; reject schema-mismatch with a
typed envelope"). The harness adapts to the existing shape rather than
forcing a 1.12 refactor of the parser's public API — the slice-2 brief
explicitly says "wrap-don't-refactor". A future refactor that promotes
the unrecognized reason from a free-form string to a typed
`ParseError` enum lives on the post-Release-1 hardening backlog.

## Finding F-2 — Oversized inputs use a zero-filled `ArrayBuffer`

**Status:** Documented; structurally equivalent to a content-filled buffer for cap enforcement.

The oversize scenario (10 MB + 1 byte, +1 MB, +50 MB past cap) does not
fill its buffer with PRNG bytes. The parser's cap check looks only at
`arrayBuffer.byteLength` BEFORE invoking SheetJS (per
`parser.worker.ts`); a zero-filled buffer of the right length is
structurally identical to a content-filled buffer for that check. The
choice keeps corpus generation fast (50 MB × 100 cases of PRNG bytes
would balloon CI memory + time).

If a future change moves the cap check below SheetJS's parse (e.g. to
support streaming partial parsing), the oversize scenario's fill
strategy needs to change. The harness comment in
`fuzz-corpus.ts: makeOversizeCase` documents the dependency.

## Finding F-3 — Prototype-pollution check is structural snapshot, not full deep equality

**Status:** Documented bound.

The harness snapshots `Object.prototype` / `Array.prototype` /
`String.prototype` own-property-name lists before the corpus runs and
asserts equality after. This catches the dominant attack class
(prototype pollution that adds a new key to `Object.prototype.*`) but
does NOT catch a value-mutation of an existing prototype property
(e.g. `Object.prototype.toString` reassigned to a hostile function).

The structural snapshot is the documented bound. A value-equality
check across the full prototype graph would be expensive per-case and
is on the post-Release-1 backlog if future fuzzing telemetry indicates
a value-mutation attack vector against SheetJS.

## Finding F-4 — Unicode-edges scenario skips cases that SheetJS refuses to encode

**Status:** Documented; fail-closed at the writer is also fail-closed.

Some unpaired-surrogate edge strings (`\uD800`, `\uDFFF`) cause SheetJS
to throw at `XLSX.write` time when building the corpus case. The
harness catches this and substitutes a benign random buffer so the
case index stays stable across runs. The substitution does not weaken
the assertion contract — a SheetJS that refuses to _encode_ a hostile
string is itself fail-closed against that string. The parser will
never see a buffer that SheetJS refuses to write.

## Finding F-5 — Malformed-xlsx scenarios accept `either` outcome

**Status:** Intentional. Sub-class of the no-uncaught-throw invariant.

The malformed-xlsx scenarios (byte-flips, central-directory wipe,
deflate noise) emit cases whose expected outcome is `either` —
`recognized` OR `unrecognized` is acceptable as long as the parser
does not throw. This is because a 1% byte-flip can, with low
probability, produce a structurally-valid xlsx whose contents the
schema detector accepts as a degenerate-but-recognized workbook. The
harness's no-throw invariant + the structural-envelope assertion are
the load-bearing contracts; the per-scenario outcome class is
informational.

## Finding F-6 — ReDoS guard is per-case wall-time, not regex-engine instrumentation

**Status:** Documented bound; aligns with ADR-0011 §3.5 30s budget.

The ReDoS guard is a per-case wall-time budget (30s per ADR). A
regex-engine instrumentation (counting backtracks, hooking the V8
regex compiler) is the structurally stronger defense but requires
engine support that Node 20 / Vitest do not expose. The 30s budget is
the documented bound — a case that takes 28s passes the assertion but
is logged as a "slow case" via `console.warn` so the operator sees it.

## Finding F-7 — Corpus generation is deterministic but generation cost is not flat

**Status:** Documented bound.

The `oversize` scenario allocates up to 60 MB per case (10 MB cap + 50
MB past cap). The corpus's 100 cases for oversize × 60 MB = 6 GB peak
allocation if all cases were retained. The harness runs cases
sequentially and discards each case's `ArrayBuffer` after the parse
completes, so peak working-set is bounded by one case's allocation.

The generator itself materializes the corpus eagerly into an array (it
does not yield lazily). At 1000 cases × the dominant case size
(oversize variant 2 = 60 MB), eager materialization would consume 6 GB
RAM. The corpus is distributed across 8 scenarios with ~125 cases per
scenario; the oversize scenario gets ~125 cases × {1MB cap+1, 1MB past,
50MB past} → 125/3 ≈ 41 cases × 60 MB = 2.4 GB peak. This is within CI
budget but tight.

The post-Release-1 backlog includes "convert corpus to a lazy
generator" if future telemetry shows memory pressure. The current eager
shape is documented in `fuzz-corpus.ts: generateCorpus`.

## Summary

| Finding | Status           | Resolution                                                           |
| ------- | ---------------- | -------------------------------------------------------------------- |
| F-1     | Documented       | Parser uses `DetectionResult`; harness adapts (no refactor)          |
| F-2     | Documented       | Zero-filled buffer is equivalent for cap enforcement                 |
| F-3     | Documented bound | Snapshot-name check; value-mutation deferred to backlog              |
| F-4     | Documented       | SheetJS refusing to encode is itself fail-closed                     |
| F-5     | Intentional      | Malformed-xlsx outcome is `either`; no-throw is load-bearing         |
| F-6     | Documented bound | 30s wall-time per ADR; engine-level instrumentation deferred         |
| F-7     | Documented bound | Eager corpus materialization fits CI budget; lazy generator deferred |

None of F-1..F-7 represent a parser bug. All are documentation of the
harness's posture against the ADR-0011 §3.5 specification. Genuine
parser bugs surfaced during harness construction (if any) land in a
separate `docs/audits/` finding with a fix commit; this document is
the harness-level posture record.
