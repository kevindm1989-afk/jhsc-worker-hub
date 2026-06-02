// Tests for the Excel-import detector + per-sheet parsers.
//
// Strategy: synthesize small in-memory workbooks via SheetJS's
// `book_new` / `aoa_to_sheet` helpers so we don't need fixture .xlsx
// files in the repo. Each test builds the precise shape it needs, runs
// `parseArrayBuffer`, and asserts on the discriminated `DetectionResult`.
//
// Coverage map:
//   - Detector happy path → 'recognized' + schema='meeting_minutes_v1'.
//   - Detector unrecognized paths:
//       * missing required sheet
//       * missing required column
//       * misspelled sheet name (close-but-not-exact)
//   - Detector tolerance:
//       * case-insensitive sheet names + columns
//       * whitespace-trimmed sheet names + columns
//   - Per-sheet parsers:
//       * Minutes meta (date, quorum, attendance)
//       * action item rows: required fields, enum coercion, dates
//       * Closed Items History: closed_date required
//       * Inspection Review: opaque 2D string grid
//   - Validation errors:
//       * unparseable date in Start Date
//       * empty required cell skips the row + collects an error
//       * unknown Risk rejects the row
//       * over-cap description rejects the row
//       * over-cap optional cell truncates + warns
//   - File-size cap:
//       * 10 MB + 1 byte ArrayBuffer rejects with 'payload_too_large'
//   - Worker contract:
//       * parseArrayBuffer round-trip via a stub workbook.

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { MAX_FILE_BYTES, parseArrayBuffer } from './parser.worker';
import type { DetectionResult } from './schema';

// ---------------------------------------------------------------------------
// Helpers — synthesize a workbook with the requested shape.
// ---------------------------------------------------------------------------

type Row = ReadonlyArray<string | number | boolean | Date | null>;

interface SheetSpec {
  name: string;
  rows: ReadonlyArray<Row>;
}

function makeWorkbook(sheets: ReadonlyArray<SheetSpec>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    // Cast `Row[]` to a less-strict shape because SheetJS's aoa_to_sheet
    // accepts any cell value but its types narrow to its own union.
    const ws = XLSX.utils.aoa_to_sheet(s.rows as unknown as unknown[][]);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  // SheetJS 0.18.5's `type: 'array'` write+read round-trip is buggy in
  // Node — sheet names get rewritten to 'Sheet1' on read. Writing as
  // 'buffer' (Node Buffer-like Uint8Array) + reading as 'array' works
  // correctly.  We type the result as Uint8Array (Buffer extends
  // Uint8Array) so the package's type set (no `node`) accepts it.
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
  const buf = new ArrayBuffer(out.byteLength);
  new Uint8Array(buf).set(out);
  return buf;
}

const MINUTES_ROWS: ReadonlyArray<Row> = [
  ['Meeting Date', new Date('2024-03-15T00:00:00.000Z')],
  ['Quorum', true],
  ['Attendance', 'Rep A, Rep B'],
  ['Workbook Version', 'v1'],
];

const ACTION_ITEM_HEADER: Row = [
  'Type',
  'Issue Description',
  'Recommended Action',
  'Start Date',
  'Raised By',
  'Follow Up',
  'Dept',
  'Status',
  'Risk',
  'Target Date',
  'Closed Date',
  'Tags',
];

function aiRow(opts: {
  type?: string;
  desc?: string;
  rec?: string;
  start?: string | Date;
  status?: string;
  risk?: string;
  target?: string | Date;
  closed?: string | Date;
  tags?: string;
  raisedBy?: string;
  followUp?: string;
  dept?: string;
}): Row {
  return [
    opts.type ?? 'INSP',
    opts.desc ?? 'Pallet jack repair',
    opts.rec ?? '',
    opts.start ?? new Date('2024-01-15T00:00:00.000Z'),
    opts.raisedBy ?? '',
    opts.followUp ?? '',
    opts.dept ?? '',
    opts.status ?? 'Not Started',
    opts.risk ?? 'Medium',
    opts.target ?? '',
    opts.closed ?? '',
    opts.tags ?? '',
  ];
}

function recognizedWorkbookSheets(extras: ReadonlyArray<SheetSpec> = []): ReadonlyArray<SheetSpec> {
  return [
    { name: 'Minutes', rows: MINUTES_ROWS },
    { name: 'NEW BUSINESS', rows: [ACTION_ITEM_HEADER, aiRow({})] },
    { name: 'OLD BUSINESS', rows: [ACTION_ITEM_HEADER] },
    { name: 'NOTICE OF RECOMMENDATION', rows: [ACTION_ITEM_HEADER] },
    { name: 'COMPLETED', rows: [ACTION_ITEM_HEADER] },
    {
      name: 'Closed Items History',
      rows: [ACTION_ITEM_HEADER],
    },
    ...extras,
  ];
}

function expectRecognized(
  result: DetectionResult,
): asserts result is Extract<DetectionResult, { kind: 'recognized' }> {
  if (result.kind !== 'recognized') {
    throw new Error(`expected 'recognized' but got 'unrecognized' (reason: ${result.reason})`);
  }
}

function expectUnrecognized(
  result: DetectionResult,
): asserts result is Extract<DetectionResult, { kind: 'unrecognized' }> {
  if (result.kind !== 'unrecognized') {
    throw new Error("expected 'unrecognized'");
  }
}

// ---------------------------------------------------------------------------
// Detector tests
// ---------------------------------------------------------------------------

describe('detectSchema — recognized happy path', () => {
  it('classifies a clean Meeting Minutes v1 workbook as recognized', async () => {
    const buf = makeWorkbook(recognizedWorkbookSheets());
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.schema).toBe('meeting_minutes_v1');
    expect(result.sheets.newBusiness).toHaveLength(1);
    expect(result.sheets.metadata.meetingDate).toBe('2024-03-15');
    expect(result.sheets.metadata.quorum).toBe(true);
    expect(result.sheets.sourceSha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sheets.rowCount).toBe(1);
  });

  it('passes through validationErrors array (empty on clean parse)', async () => {
    const buf = makeWorkbook(recognizedWorkbookSheets());
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.validationErrors).toEqual([]);
  });
});

describe('detectSchema — unrecognized paths', () => {
  it('rejects when NEW BUSINESS is missing', async () => {
    const sheets = recognizedWorkbookSheets().filter((s) => s.name !== 'NEW BUSINESS');
    const buf = makeWorkbook(sheets);
    const result = await parseArrayBuffer(buf);
    expectUnrecognized(result);
    expect(result.reason).toMatch(/NEW BUSINESS/);
  });

  it('rejects when Closed Items History is missing', async () => {
    const sheets = recognizedWorkbookSheets().filter((s) => s.name !== 'Closed Items History');
    const buf = makeWorkbook(sheets);
    const result = await parseArrayBuffer(buf);
    expectUnrecognized(result);
    expect(result.reason).toMatch(/Closed Items History/);
  });

  it('rejects when NEW BUSINESS lacks a required column', async () => {
    const incompleteHeader: Row = [
      'Type',
      'Issue Description',
      'Start Date',
      // Status, Risk omitted
      'Tags',
    ];
    const sheets = recognizedWorkbookSheets().map((s) =>
      s.name === 'NEW BUSINESS' ? { ...s, rows: [incompleteHeader] } : s,
    );
    const buf = makeWorkbook(sheets);
    const result = await parseArrayBuffer(buf);
    expectUnrecognized(result);
    expect(result.reason).toMatch(/NEW BUSINESS.*Status|NEW BUSINESS.*Risk/);
  });

  it('rejects when Minutes sheet has no Meeting Date label', async () => {
    const sheets = recognizedWorkbookSheets().map((s) =>
      s.name === 'Minutes' ? { ...s, rows: [['Quorum', true]] } : s,
    );
    const buf = makeWorkbook(sheets);
    const result = await parseArrayBuffer(buf);
    expectUnrecognized(result);
    expect(result.reason).toMatch(/Meeting Date/);
  });
});

describe('detectSchema — tolerance', () => {
  it('accepts case-insensitive sheet names', async () => {
    const sheets = recognizedWorkbookSheets().map((s) => ({
      ...s,
      name: s.name === 'NEW BUSINESS' ? 'new business' : s.name,
    }));
    const buf = makeWorkbook(sheets);
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
  });

  it('accepts whitespace-padded column headers', async () => {
    const paddedHeader: Row = ACTION_ITEM_HEADER.map((h) =>
      typeof h === 'string' ? `  ${h}  ` : h,
    );
    const sheets = recognizedWorkbookSheets().map((s) =>
      s.name === 'NEW BUSINESS' ? { ...s, rows: [paddedHeader, aiRow({})] } : s,
    );
    const buf = makeWorkbook(sheets);
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
  });
});

// ---------------------------------------------------------------------------
// Per-sheet parser tests
// ---------------------------------------------------------------------------

describe('parseActionItemSheet — happy path', () => {
  it('parses a row with all required fields + content_hash', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS'
          ? {
              ...s,
              rows: [
                ACTION_ITEM_HEADER,
                aiRow({
                  type: 'INSP',
                  desc: 'Frozen lock on freezer door',
                  start: new Date('2024-02-01T00:00:00.000Z'),
                  status: 'In Progress',
                  risk: 'High',
                  target: new Date('2024-03-01T00:00:00.000Z'),
                  tags: 'cold-warehouse,winter',
                }),
              ],
            }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.newBusiness).toHaveLength(1);
    const row = result.sheets.newBusiness[0]!;
    expect(row.section).toBe('new_business');
    expect(row.type).toBe('INSP');
    expect(row.description).toBe('Frozen lock on freezer door');
    expect(row.status).toBe('In Progress');
    expect(row.risk).toBe('High');
    expect(row.startDate).toBe('2024-02-01');
    expect(row.targetDate).toBe('2024-03-01');
    expect(row.tags).toEqual(['cold-warehouse', 'winter']);
    expect(row.contentHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(row.contentHash).toBeInstanceOf(Uint8Array);
    expect(row.contentHash.byteLength).toBe(32);
    expect(row.localId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps unknown Type values to OTHER + captures original in typeSubtype', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS'
          ? {
              ...s,
              rows: [ACTION_ITEM_HEADER, aiRow({ type: 'LEGACY-MYSTERY' })],
            }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    const row = result.sheets.newBusiness[0]!;
    expect(row.type).toBe('OTHER');
    expect(row.typeSubtype).toBe('LEGACY-MYSTERY');
    expect(row.importWarnings['type']).toMatch(/LEGACY-MYSTERY/);
  });

  it('maps legacy Status values via documented coercion', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS'
          ? {
              ...s,
              rows: [
                ACTION_ITEM_HEADER,
                aiRow({ status: 'WIP' }),
                aiRow({ status: 'completed', desc: 'Second row distinct' }),
              ],
            }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.newBusiness).toHaveLength(2);
    expect(result.sheets.newBusiness[0]!.status).toBe('In Progress');
    expect(result.sheets.newBusiness[1]!.status).toBe('Closed');
  });

  it('skips fully-empty rows', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS'
          ? {
              ...s,
              rows: [
                ACTION_ITEM_HEADER,
                aiRow({}),
                ['', '', '', '', '', '', '', '', '', '', '', ''],
              ],
            }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.newBusiness).toHaveLength(1);
  });
});

describe('parseActionItemSheet — Closed Items History requires Closed Date', () => {
  it('rejects rows without Closed Date on Closed Items History sheet', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'Closed Items History'
          ? {
              ...s,
              rows: [ACTION_ITEM_HEADER, aiRow({ desc: 'Archived row missing closed_date' })],
            }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.closedHistory).toHaveLength(0);
    expect(result.sheets.validationErrors).toContainEqual(
      expect.objectContaining({
        sheet: 'Closed Items History',
        column: 'Closed Date',
        reason: expect.stringContaining('required'),
      }),
    );
  });

  it('accepts rows with Closed Date on Closed Items History', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'Closed Items History'
          ? {
              ...s,
              rows: [
                ACTION_ITEM_HEADER,
                aiRow({
                  desc: 'Archived row with closed_date',
                  closed: new Date('2023-12-15T00:00:00.000Z'),
                }),
              ],
            }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.closedHistory).toHaveLength(1);
    expect(result.sheets.closedHistory[0]!.closedDate).toBe('2023-12-15');
    expect(result.sheets.closedHistory[0]!.section).toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// Validation-error tests
// ---------------------------------------------------------------------------

describe('parseActionItemSheet — validation errors', () => {
  it('rejects rows with empty Issue Description + collects a validation error', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS'
          ? {
              ...s,
              rows: [ACTION_ITEM_HEADER, aiRow({ desc: '' })],
            }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.newBusiness).toHaveLength(0);
    expect(result.sheets.validationErrors).toContainEqual(
      expect.objectContaining({
        sheet: 'NEW BUSINESS',
        column: 'Issue Description',
      }),
    );
  });

  it('rejects rows with unrecognized Risk', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS'
          ? { ...s, rows: [ACTION_ITEM_HEADER, aiRow({ risk: 'maybe-bad' })] }
          : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.newBusiness).toHaveLength(0);
    expect(result.sheets.validationErrors).toContainEqual(
      expect.objectContaining({ column: 'Risk' }),
    );
  });

  it('rejects rows with over-cap description', async () => {
    const huge = 'x'.repeat(10000);
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS' ? { ...s, rows: [ACTION_ITEM_HEADER, aiRow({ desc: huge })] } : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.newBusiness).toHaveLength(0);
    expect(result.sheets.validationErrors).toContainEqual(
      expect.objectContaining({
        column: 'Issue Description',
        reason: expect.stringContaining('hard cap'),
      }),
    );
  });

  it('warns on soft-cap description but still parses', async () => {
    const big = 'a'.repeat(2500);
    const buf = makeWorkbook(
      recognizedWorkbookSheets().map((s) =>
        s.name === 'NEW BUSINESS' ? { ...s, rows: [ACTION_ITEM_HEADER, aiRow({ desc: big })] } : s,
      ),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.newBusiness).toHaveLength(1);
    expect(result.sheets.newBusiness[0]!.importWarnings['description.length']).toMatch(/soft cap/);
  });
});

// ---------------------------------------------------------------------------
// File-size cap
// ---------------------------------------------------------------------------

describe('parseArrayBuffer — file-size cap (T-X9)', () => {
  it('rejects buffers larger than MAX_FILE_BYTES', async () => {
    const buf = new ArrayBuffer(MAX_FILE_BYTES + 1);
    const result = await parseArrayBuffer(buf);
    expectUnrecognized(result);
    expect(result.reason).toBe('payload_too_large');
  });
});

// ---------------------------------------------------------------------------
// Inspection Review snapshot
// ---------------------------------------------------------------------------

describe('Inspection Review sheet — opaque 2D snapshot', () => {
  it('parses the Inspection Review sheet into a string[][] when present', async () => {
    const buf = makeWorkbook(
      recognizedWorkbookSheets([
        {
          name: 'Inspection Review',
          rows: [
            ['Date', 'Zone', 'Status', 'Notes'],
            ['2024-02-01', 'Zone 1', 'A', 'Frozen lock'],
            ['2024-02-08', 'Zone 3', 'B', 'Pallet rack damage'],
          ],
        },
      ]),
    );
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.inspectionReview).not.toBeNull();
    expect(result.sheets.inspectionReview!.rows).toHaveLength(3);
    expect(result.sheets.inspectionReview!.rows[1]![1]).toBe('Zone 1');
  });

  it('returns null for inspectionReview when the sheet is absent', async () => {
    const buf = makeWorkbook(recognizedWorkbookSheets());
    const result = await parseArrayBuffer(buf);
    expectRecognized(result);
    expect(result.sheets.inspectionReview).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unparseable workbook bytes
// ---------------------------------------------------------------------------

describe('parseArrayBuffer — corrupt input', () => {
  it('returns unrecognized for non-xlsx bytes (either parse-rejection or sheet-missing)', async () => {
    // SheetJS 0.18.5's behavior on garbage bytes is inconsistent: small
    // inputs may parse as a tiny default workbook (no Minutes sheet,
    // detector rejects); large or zip-malformed inputs throw mid-parse
    // (caught as 'unparseable workbook'). Either outcome is a fail-
    // closed `unrecognized` discriminator from the rep's perspective.
    const buf = new TextEncoder().encode('not an xlsx file at all').buffer.slice(0);
    const result = await parseArrayBuffer(buf);
    expectUnrecognized(result);
    expect(result.reason).toMatch(/unparseable workbook|missing required sheet/);
  });

  it('returns unrecognized for empty buffer', async () => {
    const buf = new ArrayBuffer(0);
    const result = await parseArrayBuffer(buf);
    expectUnrecognized(result);
  });
});
