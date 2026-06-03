// Acceptance-fixture workbook builders for Milestone 1.11 S4.
//
// Strategy: synthesize the canonical Meeting Minutes v1 workbook at test
// time via SheetJS's `book_new()` + `aoa_to_sheet()` helpers. We do NOT
// ship a binary .xlsx in the repo — CLAUDE.md non-negotiable #11 + the
// reviewability of a plain-text-diff-only PR both pull in the same
// direction.
//
// The builders are pure (no IO, no randomness). They return a fresh
// `ArrayBuffer` on every call so test runs do not share buffer state.
//
// Three builders are exported:
//
//   - `buildAcceptanceWorkbookBuffer()` — the canonical "happy path"
//     workbook. Covers all seven sheets per ADR-0010 §3.3:
//     Minutes / NEW BUSINESS / OLD BUSINESS / NOTICE OF RECOMMENDATION /
//     COMPLETED / Closed Items History / Inspection Review. Populated
//     with representative rows: three NEW BUSINESS items covering
//     different action_item types + the four Risk levels; two
//     OLD BUSINESS items (used in the reconciliation tests as the
//     "already-existing" pool); one NOTICE OF RECOMMENDATION row;
//     two COMPLETED rows with closed_date; one Closed Items History
//     row (section='archived'); one Inspection Review snapshot row.
//
//   - `buildUnrecognizedWorkbookBuffer()` — drops the required
//     `NEW BUSINESS` sheet so the detector returns
//     `kind: 'unrecognized'` with a reason mentioning the missing
//     sheet. Used by the detector's fail-closed-branch tests in
//     schema.test.ts.
//
//   - `buildAcceptanceWorkbookSheets()` — returns the underlying
//     `SheetSpec[]` so tests that want to mutate a single sheet (e.g.
//     remove a column to exercise the missing-required-column branch)
//     can do so without rebuilding the whole spec.
//
// Naming + content conventions (CLAUDE.md non-negotiable #1):
//   - No real workplace names. Role labels only — "Worker Co-Chair
//     Role", "Management Rep Role", "Health & Safety Lead Role".
//   - No real people. Where the spec wants a "Raised By" or "Follow Up"
//     field, we use the same role labels.
//   - Descriptions are generic worker-safety language ("Floor near
//     loading dock 4 needs grip-mat reinforcement"); no industry-
//     specific tells, no proprietary equipment names.

import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Sheet-spec helper types
// ---------------------------------------------------------------------------

export type FixtureRow = ReadonlyArray<string | number | boolean | Date | null>;

export interface SheetSpec {
  readonly name: string;
  readonly rows: ReadonlyArray<FixtureRow>;
}

// ---------------------------------------------------------------------------
// Canonical header rows
// ---------------------------------------------------------------------------

/**
 * Twelve-column action-item header row, in the canonical order the
 * detector + per-sheet parsers walk. Mirrors the constant in
 * `schema.ts: ACTION_ITEM_HEADERS`. Keep these in lockstep — when a
 * new column lands in the spec, both the detector's required-column
 * list and this fixture header row update together.
 */
export const ACCEPTANCE_ACTION_ITEM_HEADER: FixtureRow = [
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

// ---------------------------------------------------------------------------
// Per-section row data
// ---------------------------------------------------------------------------
//
// We deliberately keep the row count small (≤ 3 per section) so the
// acceptance suite stays fast + readable. The threat model's volume
// concerns (T-X9 — 10 MB / 50 000 row cap) are exercised by the worker-
// boundary test in `schema.test.ts: file-size cap`; this fixture
// covers SHAPE conformance, not volume.

/** Three NEW BUSINESS rows covering different Type values + four
 * Risk levels. The descriptions are deliberately generic; the dates
 * are recent enough to be plausible 2024 entries but old enough that
 * the 21-day clock has surfaced status drift. */
const NEW_BUSINESS_ROWS: ReadonlyArray<FixtureRow> = [
  [
    'INSP',
    'Floor near loading dock 4 needs grip-mat reinforcement',
    'Install textured grip mats along the 6m approach',
    new Date(Date.UTC(2024, 7, 1)),
    'Worker Co-Chair Role',
    'Health & Safety Lead Role',
    'Operations',
    'Not Started',
    'Medium',
    new Date(Date.UTC(2024, 8, 15)),
    '',
    'floor,traction',
  ],
  [
    'FLI',
    'Emergency lighting fixture in the freezer corridor flickers intermittently',
    'Replace fixture and audit adjacent units',
    new Date(Date.UTC(2024, 7, 5)),
    'Management Rep Role',
    'Health & Safety Lead Role',
    'Facilities',
    'In Progress',
    'High',
    new Date(Date.UTC(2024, 8, 30)),
    '',
    'lighting,cold-warehouse',
  ],
  [
    'TRAIN',
    'Operator refresher on lockout for the compactor is overdue',
    'Schedule three sessions across shifts',
    new Date(Date.UTC(2024, 7, 10)),
    'Worker Co-Chair Role',
    'Worker Co-Chair Role',
    'Operations',
    'Not Started',
    'Critical',
    new Date(Date.UTC(2024, 8, 22)),
    '',
    'lockout,training',
  ],
];

/** Two OLD BUSINESS rows. The reconciliation tests use these to seed
 * the "existing pool" and assert update/skip behavior on re-import. */
const OLD_BUSINESS_ROWS: ReadonlyArray<FixtureRow> = [
  [
    'PROC',
    'Ergonomic assessment requested for the inbound dock packing benches',
    'Engage external assessor; report by quarter end',
    new Date(Date.UTC(2024, 5, 1)),
    'Worker Co-Chair Role',
    'Health & Safety Lead Role',
    'Operations',
    'In Progress',
    'Medium',
    new Date(Date.UTC(2024, 9, 1)),
    '',
    'ergonomics',
  ],
  [
    'INC',
    'Near-miss involving forklift turning radius at aisle 7',
    'Repaint floor markings, install warning beacons',
    new Date(Date.UTC(2024, 5, 12)),
    'Management Rep Role',
    'Management Rep Role',
    'Operations',
    'Blocked',
    'High',
    new Date(Date.UTC(2024, 8, 30)),
    '',
    'forklift,traffic-control',
  ],
];

/** One NOTICE OF RECOMMENDATION row — exercises section='recommendation'
 * parsing. The 21-day clock under s.9(20) is enforced at the recommendations
 * route layer (1.9), not in the Excel-import parsers, so this row's
 * dates are aligned but not load-bearing. */
const RECOMMENDATION_ROWS: ReadonlyArray<FixtureRow> = [
  [
    'REC',
    'Recommend annual third-party audit of the lockout/tagout program',
    'Engage external OHS auditor; tabled for next meeting',
    new Date(Date.UTC(2024, 6, 1)),
    'Worker Co-Chair Role',
    'Management Rep Role',
    'Operations',
    'Pending Review',
    'High',
    new Date(Date.UTC(2024, 6, 22)),
    '',
    's.9(20),lockout',
  ],
];

/** Two COMPLETED rows. Both have closed_date populated because the
 * detector requires it on the COMPLETED sheet (see schema.ts:
 * sectionSheets COMPLETED.closedRequired=true). */
const COMPLETED_ROWS: ReadonlyArray<FixtureRow> = [
  [
    'INSP',
    'Repaired guarding on the conveyor at the secondary sort line',
    'Verified by operator + supervisor sign-off',
    new Date(Date.UTC(2024, 4, 5)),
    'Worker Co-Chair Role',
    'Health & Safety Lead Role',
    'Operations',
    'Closed',
    'Medium',
    new Date(Date.UTC(2024, 5, 1)),
    new Date(Date.UTC(2024, 6, 10)),
    'guarding,conveyor',
  ],
  [
    'PROC',
    'Updated emergency evacuation map for the mezzanine office area',
    'Posted in three locations; reviewed at all-hands',
    new Date(Date.UTC(2024, 4, 20)),
    'Health & Safety Lead Role',
    'Worker Co-Chair Role',
    'Administration',
    'Closed',
    'Low',
    new Date(Date.UTC(2024, 5, 15)),
    new Date(Date.UTC(2024, 6, 5)),
    'evacuation,signage',
  ],
];

/** One Closed Items History row — carries a prior-period section in
 * the spec's section vocabulary. The detector clamps section='archived'
 * for every row in this sheet regardless of any value present. */
const CLOSED_HISTORY_ROWS: ReadonlyArray<FixtureRow> = [
  [
    'INSP',
    'Replaced damaged guardrail on stairwell B',
    'Vendor invoice attached to prior minutes',
    new Date(Date.UTC(2023, 9, 1)),
    'Worker Co-Chair Role',
    'Management Rep Role',
    'Facilities',
    'Closed',
    'Medium',
    new Date(Date.UTC(2023, 10, 1)),
    new Date(Date.UTC(2023, 10, 15)),
    'fall-protection',
  ],
];

/** Single Inspection Review snapshot row. The detector captures the
 * sheet verbatim as a 2D string grid (no header validation); this is
 * intentional per ADR-0010 §3.4 — the snapshot is opaque to the parser
 * and only the rep + auditor read it. */
const INSPECTION_REVIEW_ROWS: ReadonlyArray<FixtureRow> = [
  ['Date', 'Zone', 'Status', 'Notes'],
  ['2024-08-01', 'zone_3', 'A', 'Routine walk-through; no findings'],
];

/** Meeting metadata for the Minutes sheet. The detector reads the
 * column-A label + column-B value layout; ordering within the sheet
 * is not load-bearing (the parser walks every row + matches labels). */
const MINUTES_ROWS: ReadonlyArray<FixtureRow> = [
  ['Meeting Date', new Date(Date.UTC(2024, 8, 15))],
  ['Quorum', true],
  ['Attendance', 'Worker Co-Chair Role, Management Rep Role, Health & Safety Lead Role'],
  ['Workbook Version', 'meeting_minutes_v1'],
];

// ---------------------------------------------------------------------------
// Sheet-spec builders
// ---------------------------------------------------------------------------

/**
 * Per-section row counts that test bodies assert against. Kept as a
 * frozen object so a single source of truth lives next to the rows
 * themselves — when a row is added or removed above, the count updates
 * in lockstep here, and the schema.test.ts + reconciliation.test.ts
 * suites pick the new value up without churn.
 */
export const ACCEPTANCE_FIXTURE_COUNTS = Object.freeze({
  newBusiness: NEW_BUSINESS_ROWS.length,
  oldBusiness: OLD_BUSINESS_ROWS.length,
  recommendations: RECOMMENDATION_ROWS.length,
  completed: COMPLETED_ROWS.length,
  closedHistory: CLOSED_HISTORY_ROWS.length,
  inspectionReviewRows: INSPECTION_REVIEW_ROWS.length,
  totalActionItems:
    NEW_BUSINESS_ROWS.length +
    OLD_BUSINESS_ROWS.length +
    RECOMMENDATION_ROWS.length +
    COMPLETED_ROWS.length +
    CLOSED_HISTORY_ROWS.length,
});

/**
 * Meeting metadata the tests assert against. Read this from the
 * exports so the test bodies do not duplicate the literal date string.
 */
export const ACCEPTANCE_FIXTURE_METADATA = Object.freeze({
  meetingDate: '2024-09-15',
  quorum: true,
  attendance: 'Worker Co-Chair Role, Management Rep Role, Health & Safety Lead Role',
  workbookVersionString: 'meeting_minutes_v1',
});

/**
 * Return the canonical SheetSpec[] for the acceptance workbook. Tests
 * that want to mutate a single sheet (drop a column, rename, etc.)
 * call this + transform the array; tests that want a ready-made buffer
 * call `buildAcceptanceWorkbookBuffer()` instead.
 */
export function buildAcceptanceWorkbookSheets(): ReadonlyArray<SheetSpec> {
  return [
    { name: 'Minutes', rows: MINUTES_ROWS },
    {
      name: 'NEW BUSINESS',
      rows: [ACCEPTANCE_ACTION_ITEM_HEADER, ...NEW_BUSINESS_ROWS],
    },
    {
      name: 'OLD BUSINESS',
      rows: [ACCEPTANCE_ACTION_ITEM_HEADER, ...OLD_BUSINESS_ROWS],
    },
    {
      name: 'NOTICE OF RECOMMENDATION',
      rows: [ACCEPTANCE_ACTION_ITEM_HEADER, ...RECOMMENDATION_ROWS],
    },
    {
      name: 'COMPLETED',
      rows: [ACCEPTANCE_ACTION_ITEM_HEADER, ...COMPLETED_ROWS],
    },
    {
      name: 'Closed Items History',
      rows: [ACCEPTANCE_ACTION_ITEM_HEADER, ...CLOSED_HISTORY_ROWS],
    },
    {
      name: 'Inspection Review',
      rows: INSPECTION_REVIEW_ROWS,
    },
  ];
}

// ---------------------------------------------------------------------------
// Buffer builders
// ---------------------------------------------------------------------------

/**
 * Internal: walk a SheetSpec[] and emit an .xlsx ArrayBuffer via
 * SheetJS's `write()` helper. Matches the pattern in schema.test.ts'
 * `makeWorkbook` helper so the fixture-builders and the inline test
 * builders produce byte-identical buffers when given the same input.
 *
 * SheetJS 0.18.5's `type: 'array'` write+read round-trip is buggy in
 * Node — sheet names get rewritten to 'Sheet1' on read. Writing as
 * `type: 'buffer'` (Node-Buffer-like Uint8Array) + reading as 'array'
 * works correctly. We type the result as Uint8Array (Buffer extends
 * Uint8Array) so the package's `types: []` posture accepts it without
 * pulling in @types/node.
 */
function specsToArrayBuffer(sheets: ReadonlyArray<SheetSpec>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows as unknown as unknown[][]);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
  const buf = new ArrayBuffer(out.byteLength);
  new Uint8Array(buf).set(out);
  return buf;
}

/**
 * Build the canonical acceptance workbook as an .xlsx ArrayBuffer.
 *
 * The buffer is a freshly-allocated copy on every call; callers may
 * transfer it to a Worker via `postMessage(buf, [buf])` without
 * affecting subsequent test runs.
 */
export function buildAcceptanceWorkbookBuffer(): ArrayBuffer {
  return specsToArrayBuffer(buildAcceptanceWorkbookSheets());
}

/**
 * Build an "unrecognized" variant — the canonical sheets minus the
 * required `NEW BUSINESS` sheet. The detector should reject this with
 * a `kind: 'unrecognized'` reason mentioning the missing sheet.
 *
 * Used by the detector's fail-closed-branch coverage in
 * `schema.test.ts: acceptance workbook → unrecognized`.
 */
export function buildUnrecognizedWorkbookBuffer(): ArrayBuffer {
  const sheets = buildAcceptanceWorkbookSheets().filter((s) => s.name !== 'NEW BUSINESS');
  return specsToArrayBuffer(sheets);
}
