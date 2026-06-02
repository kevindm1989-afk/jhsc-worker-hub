// Excel-import schema detector + per-sheet parsers (Milestone 1.11 S2).
//
// S1 landed the TypeScript shapes that the parsers + reconciler + commit
// builder consume. S2 (this file) lands the runtime behavior: the
// `detectSchema()` discriminator that walks a parsed workbook and either
// classifies it as `meeting_minutes_v1` or returns the precise reason
// the workbook does not match the schema (ADR-0010 §3.3); the per-sheet
// parsers that translate each row into a typed `ParsedMeetingMetadata`
// / `ParsedActionItem` / `ParsedInspectionReview` shape; the cell-type
// validation that enforces SECURITY T-X12 / T-X13 / T-X14 close-outs.
//
// Load-bearing invariants:
//
//   - The detector is fail-closed. A workbook missing ANY required
//     sheet or ANY required column returns `unrecognized` with a
//     specific reason; there is NO partial-recognized variant.
//   - Row-level validation errors do NOT throw — they are collected
//     into `validationErrors` so the preview UI can surface them and
//     the rep can decide whether to fix the source workbook or
//     proceed with the recognized rows.
//   - Cell-level coercion is conservative + documented. Unknown
//     `Status` values fall back to `'Not Started'`; unknown `Type`
//     values fall back to `'OTHER'`; unknown `Risk` values reject
//     the row (Risk is not optional per docs/excel-import-format.md).
//   - No formula evaluation. SheetJS's `cellFormula:false` parser
//     option is set at the worker boundary (parser.worker.ts).
//
// SECURITY mapping (SECURITY.md §2.11):
//   T-X8  — fail-closed detector (no partial recognized variant)
//   T-X10 — unknown enum values collected as warnings, not silently
//           dropped
//   T-X11 — per-cell length caps enforced at row parse time
//   T-X12 — cell-type confusion rejected (Date NaN, etc.)
//   T-X13 — empty required cells reject the row
//   T-X14 — long-cell flag (>2000 char description warning, >8 KB
//           hard reject)

import {
  actionItemRisk,
  actionItemSection,
  actionItemStatus,
  actionItemType,
  type ActionItemRisk,
  type ActionItemSection,
  type ActionItemStatus,
} from '@jhsc/shared-types';
import { computeContentHash, contentHashHex } from './canonical';

// ---------------------------------------------------------------------------
// Public types (mirrored from S1's schema.ts type-only file)
// ---------------------------------------------------------------------------

export type ExcelImportSchemaVersion = 'meeting_minutes_v1';

export interface ParsedMeetingMetadata {
  readonly meetingDate: string; // YYYY-MM-DD
  readonly quorum: boolean | null;
  readonly attendance: string | null;
  readonly workbookVersionString: string | null;
}

export interface ParsedActionItem {
  readonly sourceSheet: string;
  readonly sourceRowIndex: number;
  readonly section: ActionItemSection;
  readonly type: string;
  readonly typeSubtype: string | null;
  readonly description: string;
  readonly recommendedAction: string | null;
  readonly raisedBy: string | null;
  readonly followUpOwner: string | null;
  readonly department: string | null;
  readonly status: ActionItemStatus;
  readonly risk: ActionItemRisk;
  readonly startDate: string;
  readonly targetDate: string | null;
  readonly closedDate: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly contentHashHex: string;
  readonly contentHash: Uint8Array;
  readonly importWarnings: Readonly<Record<string, string>>;
  /** Client-allocated row identifier (uuid v4). Set by the per-row parser. */
  readonly localId: string;
}

export interface ParsedInspectionReview {
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

export interface ValidationError {
  readonly sheet: string;
  readonly rowIndex: number;
  readonly column: string;
  readonly reason: string;
}

export interface ParsedSheets {
  readonly metadata: ParsedMeetingMetadata;
  readonly newBusiness: ReadonlyArray<ParsedActionItem>;
  readonly oldBusiness: ReadonlyArray<ParsedActionItem>;
  readonly recommendations: ReadonlyArray<ParsedActionItem>;
  readonly completed: ReadonlyArray<ParsedActionItem>;
  readonly closedHistory: ReadonlyArray<ParsedActionItem>;
  readonly inspectionReview: ParsedInspectionReview | null;
  readonly sourceSha256Hex: string;
  readonly rowCount: number;
  /** Row-level validation errors. Empty array on a clean parse. */
  readonly validationErrors: ReadonlyArray<ValidationError>;
}

export type DetectionResult =
  | {
      readonly kind: 'recognized';
      readonly schema: ExcelImportSchemaVersion;
      readonly sheets: ParsedSheets;
    }
  | {
      readonly kind: 'unrecognized';
      readonly reason: string;
    };

// Re-exported reconciliation types live in reconciliation.ts; these are
// the shapes the rest of the package and the consumer apps depend on.
export type ReconcileDecisionKind = 'create' | 'update' | 'skip' | 'conflict_pending';

export interface ReconcileDecision {
  readonly parsed: ParsedActionItem;
  readonly decisionKind: ReconcileDecisionKind;
  readonly existingActionItemId: string | null;
  readonly diff: ReadonlyArray<{ field: string; current: string; incoming: string }>;
}

export interface ReconciliationPlan {
  readonly importId: string;
  readonly decisions: ReadonlyArray<ReconcileDecision>;
  readonly summary: {
    readonly createCount: number;
    readonly updateCount: number;
    readonly skipCount: number;
    readonly conflictCount: number;
  };
}

export interface CommitOperations {
  readonly importId: string;
  readonly operations: ReadonlyArray<CommitOperation>;
}

export type CommitOperation =
  | {
      readonly kind: 'create';
      readonly clientId: string;
      readonly section: ActionItemSection;
      readonly descriptionCt: string;
      readonly descriptionDekCt: string;
      readonly importItemId: string;
      readonly sourceExcelHashHex: string;
    }
  | {
      readonly kind: 'update';
      readonly actionItemId: string;
      readonly ifMatchVersion: number;
      readonly importItemId: string;
    }
  | {
      readonly kind: 'skip';
      readonly importItemId: string;
      readonly existingActionItemId: string;
    };

export interface ExistingActionItemView {
  readonly id: string;
  readonly contentHashHex: string;
  readonly section: ActionItemSection;
  readonly status: ActionItemStatus;
  readonly risk: ActionItemRisk;
  readonly startDate: string;
  readonly targetDate: string | null;
  readonly closedDate: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly version: number;
  readonly editedSinceLastImport: boolean;
}

// ---------------------------------------------------------------------------
// SheetJS workbook shape (structural — we don't import xlsx's types here
// because the worker boundary is where the dependency lives; this lets
// the unit tests stub the workbook directly without spinning SheetJS up.)
// ---------------------------------------------------------------------------

export interface WorkbookLike {
  readonly SheetNames: ReadonlyArray<string>;
  readonly Sheets: Record<string, WorksheetLike>;
}

export interface WorksheetLike {
  readonly [cellAddress: string]: CellLike | unknown;
}

export interface CellLike {
  /** Raw value — string, number, boolean, Date, or null. */
  readonly v?: unknown;
  /** Formatted text (SheetJS's `w` field with `cellText:true`). */
  readonly w?: string;
  /** Cell type — 's' string, 'n' number, 'b' boolean, 'd' date. */
  readonly t?: string;
}

// ---------------------------------------------------------------------------
// Sheet-name canonicalization
// ---------------------------------------------------------------------------

const REQUIRED_SHEETS = [
  'Minutes',
  'NEW BUSINESS',
  'OLD BUSINESS',
  'NOTICE OF RECOMMENDATION',
  'COMPLETED',
] as const;

const OPTIONAL_SHEETS = ['Closed Items History', 'Inspection Review'] as const;

/**
 * Sheet → section mapping per ADR §3.4 + docs/excel-import-format.md.
 * The mapping is the schema contract — a sheet's name pins the section
 * for every row in it. `Closed Items History` rows all land in
 * `archived` regardless of any column in the row.
 */
const SHEET_SECTION_MAP: Readonly<Record<string, ActionItemSection>> = {
  'new business': 'new_business',
  'old business': 'old_business',
  'notice of recommendation': 'recommendation',
  completed: 'completed_this_period',
  'closed items history': 'archived',
};

function canonicalSheetKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

function findSheet(workbook: WorkbookLike, canonicalName: string): string | null {
  const target = canonicalSheetKey(canonicalName);
  for (const name of workbook.SheetNames) {
    if (canonicalSheetKey(name) === target) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-cell helpers
// ---------------------------------------------------------------------------

const CELL_HARD_CAP = 8 * 1024; // 8 KB per T-X11
const DESCRIPTION_SOFT_CAP = 2000;
const FIELD_TEXT_CAP_200 = 200;
const TAG_HARD_CAP = 64;
const MAX_TAGS_PER_ROW = 16;

function colLetter(index: number): string {
  // A=0..Z=25, AA=26..; bounded by SheetJS-supported range (XFD = 16383).
  let n = index;
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

function cellAt(ws: WorksheetLike, row: number, col: number): CellLike | null {
  const addr = `${colLetter(col)}${row + 1}`;
  const c = ws[addr];
  if (c === undefined || c === null) return null;
  if (typeof c !== 'object') return null;
  return c as CellLike;
}

function cellText(cell: CellLike | null): string {
  if (!cell) return '';
  // Prefer SheetJS's formatted text `w` (set with `cellText: true`), fall
  // back to `v` stringification. Cells with `t: 'd'` (date) carry a Date
  // in `v`; we coerce to ISO YYYY-MM-DD here only when the consumer asks
  // for a date — the generic text path returns the formatted display
  // string SheetJS produced for the cell, which is what the rep typed.
  if (typeof cell.w === 'string') return cell.w;
  if (cell.v === null || cell.v === undefined) return '';
  if (cell.v instanceof Date) return Number.isNaN(cell.v.getTime()) ? '' : cell.v.toISOString();
  return String(cell.v);
}

function trimAndNormalize(s: string): string {
  return s.normalize('NFC').trim();
}

/**
 * Boolean coercion: SheetJS returns native booleans on `t:'b'` cells;
 * accept fallback strings (yes/no, y/n, true/false, 1/0) for legacy
 * workbooks that store the value as text. Anything else returns null.
 */
function parseBooleanCell(cell: CellLike | null): boolean | null {
  if (!cell) return null;
  if (typeof cell.v === 'boolean') return cell.v;
  const t = trimAndNormalize(cellText(cell)).toLowerCase();
  if (t === '') return null;
  if (t === 'true' || t === 'yes' || t === 'y' || t === '1') return true;
  if (t === 'false' || t === 'no' || t === 'n' || t === '0') return false;
  return null;
}

/**
 * Date coercion: SheetJS returns Date objects on `t:'d'` cells when the
 * worker passes `cellDates: true`. We accept Date instances, ISO
 * strings, and YYYY-MM-DD strings.
 *
 * Returns null on empty / unparseable / NaN-Date input. The caller
 * decides whether null is fatal (start_date) or fine (target_date).
 */
function parseDateCell(cell: CellLike | null): string | null {
  if (!cell) return null;
  if (cell.v instanceof Date) {
    const d = cell.v;
    if (Number.isNaN(d.getTime())) return null;
    return formatDateUTC(d);
  }
  const raw = trimAndNormalize(cellText(cell));
  if (raw === '') return null;
  // Fast path: already YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, day] = raw.split('-').map((n) => Number.parseInt(n, 10)) as [
      number,
      number,
      number,
    ];
    const d = new Date(Date.UTC(y, m - 1, day));
    if (Number.isNaN(d.getTime())) return null;
    const rt = formatDateUTC(d);
    return rt === raw ? raw : null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateUTC(parsed);
}

function formatDateUTC(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseStringCell(cell: CellLike | null): string {
  return trimAndNormalize(cellText(cell));
}

function parseTagsCell(cell: CellLike | null): {
  tags: ReadonlyArray<string>;
  warnings: Record<string, string>;
} {
  const warnings: Record<string, string> = {};
  const raw = parseStringCell(cell);
  if (raw === '') return { tags: [], warnings };
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length && out.length < MAX_TAGS_PER_ROW; i++) {
    const tag = parts[i]!;
    if (tag.length > TAG_HARD_CAP) {
      warnings['tags.length'] = `tag at position ${i} exceeds ${TAG_HARD_CAP} chars`;
      continue;
    }
    out.push(tag);
  }
  if (parts.length > MAX_TAGS_PER_ROW) {
    warnings['tags.count'] = `${parts.length} tags supplied; first ${MAX_TAGS_PER_ROW} kept`;
  }
  return { tags: out, warnings };
}

// ---------------------------------------------------------------------------
// Enum coercion
// ---------------------------------------------------------------------------

function coerceType(raw: string): { type: string; warning: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { type: 'OTHER', warning: 'type: empty cell defaulted to OTHER' };
  const upper = trimmed.toUpperCase();
  for (const t of actionItemType) {
    if (t === upper) return { type: t, warning: null };
  }
  return { type: 'OTHER', warning: `type: unrecognized value "${trimmed}" mapped to OTHER` };
}

function coerceStatus(raw: string): { status: ActionItemStatus; warning: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '')
    return { status: 'Not Started', warning: 'status: empty cell defaulted to Not Started' };
  const lower = trimmed.toLowerCase();
  for (const s of actionItemStatus) {
    if (s.toLowerCase() === lower) return { status: s, warning: null };
  }
  // Common legacy variants that the prior Excel workflow used.
  if (lower === 'open' || lower === 'new') return { status: 'Not Started', warning: null };
  if (lower === 'wip' || lower === 'in-progress' || lower === 'inprogress')
    return { status: 'In Progress', warning: null };
  if (lower === 'done' || lower === 'completed' || lower === 'complete')
    return { status: 'Closed', warning: null };
  return {
    status: 'Not Started',
    warning: `status: unrecognized value "${trimmed}" mapped to Not Started`,
  };
}

function coerceRisk(raw: string): { risk: ActionItemRisk | null; warning: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { risk: null, warning: null };
  const lower = trimmed.toLowerCase();
  for (const r of actionItemRisk) {
    if (r.toLowerCase() === lower) return { risk: r, warning: null };
  }
  // Loose legacy mappings — common one-letter shorthand.
  if (lower === 'l') return { risk: 'Low', warning: null };
  if (lower === 'm' || lower === 'med') return { risk: 'Medium', warning: null };
  if (lower === 'h') return { risk: 'High', warning: null };
  if (lower === 'c' || lower === 'crit') return { risk: 'Critical', warning: null };
  return { risk: null, warning: `risk: unrecognized value "${trimmed}"` };
}

// ---------------------------------------------------------------------------
// localId allocation
// ---------------------------------------------------------------------------

/** Generate a UUID v4 for a parsed-row identifier. Browser-safe + Node-safe;
 * the worker boundary uses the same `crypto` global as `canonical.ts`. */
function generateLocalId(): string {
  // Web Crypto's `randomUUID` is available in browsers + Node 19+; the
  // package's runtime contract pins both.
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Header detection per sheet
// ---------------------------------------------------------------------------

const ACTION_ITEM_HEADERS: ReadonlyArray<{ canonical: string; required: boolean }> = [
  { canonical: 'Type', required: true },
  { canonical: 'Issue Description', required: true },
  { canonical: 'Recommended Action', required: false },
  { canonical: 'Start Date', required: true },
  { canonical: 'Raised By', required: false },
  { canonical: 'Follow Up', required: false },
  { canonical: 'Dept', required: false },
  { canonical: 'Status', required: true },
  { canonical: 'Risk', required: true },
  { canonical: 'Target Date', required: false },
  { canonical: 'Closed Date', required: false },
  { canonical: 'Tags', required: false },
];

const MINUTES_HEADERS: ReadonlyArray<{ canonical: string; required: boolean }> = [
  { canonical: 'Meeting Date', required: true },
  { canonical: 'Quorum', required: false },
  { canonical: 'Attendance', required: false },
  { canonical: 'Workbook Version', required: false },
];

/**
 * Walk the first row of a worksheet and return a map of canonical-header
 * → column index. Returns the column indices of every header recognized;
 * unknown headers are ignored (the spec accepts trailing columns reps
 * may have added).
 */
function readHeaderRow(ws: WorksheetLike, maxCols: number = 64): Map<string, number> {
  const result = new Map<string, number>();
  for (let col = 0; col < maxCols; col++) {
    const cell = cellAt(ws, 0, col);
    const text = parseStringCell(cell);
    if (text === '') continue;
    result.set(text.toLowerCase(), col);
  }
  return result;
}

function findHeader(headerMap: Map<string, number>, canonical: string): number | null {
  const idx = headerMap.get(canonical.toLowerCase());
  return idx === undefined ? null : idx;
}

/**
 * Detect the last populated row index by walking the sheet's address
 * keys. SheetJS includes a `!ref` field with the range; we honor it when
 * present so we don't iterate past the populated extent.
 */
function detectMaxRow(ws: WorksheetLike): number {
  const ref = (ws as Record<string, unknown>)['!ref'];
  if (typeof ref === 'string') {
    const match = /:[A-Z]+(\d+)$/.exec(ref);
    if (match && match[1]) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // Fallback: walk cell addresses + take the max row.
  let max = 1;
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue;
    const m = /^([A-Z]+)(\d+)$/.exec(addr);
    if (m && m[2]) {
      const n = Number.parseInt(m[2], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Per-sheet parsers
// ---------------------------------------------------------------------------

function parseMinutesSheet(
  ws: WorksheetLike,
  validationErrors: ValidationError[],
): ParsedMeetingMetadata {
  // The `Minutes` sheet uses a label-in-col-A / value-in-col-B layout
  // rather than a header row. Walk rows 0..maxRow and pick the cells we
  // recognize.
  const maxRow = detectMaxRow(ws);
  let meetingDate: string | null = null;
  let quorum: boolean | null = null;
  let attendance: string | null = null;
  let workbookVersionString: string | null = null;
  for (let r = 0; r < maxRow; r++) {
    const labelCell = cellAt(ws, r, 0);
    const label = parseStringCell(labelCell).toLowerCase();
    const valueCell = cellAt(ws, r, 1);
    if (label === 'meeting date') {
      const parsed = parseDateCell(valueCell);
      if (parsed === null) {
        validationErrors.push({
          sheet: 'Minutes',
          rowIndex: r,
          column: 'Meeting Date',
          reason: 'unparseable date',
        });
      } else {
        meetingDate = parsed;
      }
    } else if (label === 'quorum') {
      quorum = parseBooleanCell(valueCell);
    } else if (label === 'attendance') {
      const raw = parseStringCell(valueCell);
      if (raw.length > CELL_HARD_CAP) {
        validationErrors.push({
          sheet: 'Minutes',
          rowIndex: r,
          column: 'Attendance',
          reason: `cell exceeds ${CELL_HARD_CAP} bytes`,
        });
      } else if (raw.length > 0) {
        attendance = raw;
      }
    } else if (label === 'workbook version') {
      const raw = parseStringCell(valueCell);
      if (raw.length > 0) workbookVersionString = raw;
    }
  }
  if (meetingDate === null) {
    // Missing meeting_date is an entire-sheet validation failure but
    // not a detector failure — the column header recognition has
    // already passed; this is row-level (a Minutes sheet with no
    // Meeting Date row is a degenerate but parseable workbook).
    validationErrors.push({
      sheet: 'Minutes',
      rowIndex: -1,
      column: 'Meeting Date',
      reason: 'meeting date label not found in column A',
    });
    return {
      meetingDate: '',
      quorum,
      attendance,
      workbookVersionString,
    };
  }
  return {
    meetingDate,
    quorum,
    attendance,
    workbookVersionString,
  };
}

async function parseActionItemRow(
  sheetName: string,
  rowIndex: number,
  ws: WorksheetLike,
  headerMap: Map<string, number>,
  section: ActionItemSection,
  closedDateRequired: boolean,
  validationErrors: ValidationError[],
): Promise<ParsedActionItem | null> {
  function colCell(canonical: string): CellLike | null {
    const idx = findHeader(headerMap, canonical);
    if (idx === null) return null;
    return cellAt(ws, rowIndex, idx);
  }

  // Skip-empty heuristic — if Type, Description, and Start Date are all
  // empty, treat the row as a blank spacer row and silently skip it.
  const descRaw = parseStringCell(colCell('Issue Description'));
  const typeRaw = parseStringCell(colCell('Type'));
  const startCell = colCell('Start Date');
  const startText = parseStringCell(startCell);
  if (descRaw === '' && typeRaw === '' && startText === '') return null;

  const warnings: Record<string, string> = {};

  // Required: description
  if (descRaw === '') {
    validationErrors.push({
      sheet: sheetName,
      rowIndex,
      column: 'Issue Description',
      reason: 'required cell is empty',
    });
    return null;
  }
  if (descRaw.length > CELL_HARD_CAP) {
    validationErrors.push({
      sheet: sheetName,
      rowIndex,
      column: 'Issue Description',
      reason: `cell exceeds hard cap ${CELL_HARD_CAP} chars (row rejected)`,
    });
    return null;
  }
  if (descRaw.length > DESCRIPTION_SOFT_CAP) {
    warnings['description.length'] =
      `description exceeds soft cap ${DESCRIPTION_SOFT_CAP} chars (${descRaw.length})`;
  }

  // Required: start date (calendar-validated by parseDateCell).
  const startDate = parseDateCell(startCell);
  if (startDate === null) {
    validationErrors.push({
      sheet: sheetName,
      rowIndex,
      column: 'Start Date',
      reason: startText === '' ? 'required cell is empty' : `unparseable date "${startText}"`,
    });
    return null;
  }

  // Type — enum with OTHER fallback.
  const typeCoerce = coerceType(typeRaw);
  if (typeCoerce.warning) warnings['type'] = typeCoerce.warning;
  // typeSubtype carries the original string when the type fell back to OTHER.
  const typeSubtype = typeCoerce.type === 'OTHER' && typeRaw !== '' ? typeRaw : null;

  // Status — enum with Not Started fallback.
  const statusRaw = parseStringCell(colCell('Status'));
  const statusCoerce = coerceStatus(statusRaw);
  if (statusCoerce.warning) warnings['status'] = statusCoerce.warning;

  // Risk — required; reject row on unknown.
  const riskRaw = parseStringCell(colCell('Risk'));
  const riskCoerce = coerceRisk(riskRaw);
  if (riskCoerce.risk === null) {
    validationErrors.push({
      sheet: sheetName,
      rowIndex,
      column: 'Risk',
      reason: riskRaw === '' ? 'required cell is empty' : `unrecognized value "${riskRaw}"`,
    });
    return null;
  }
  if (riskCoerce.warning) warnings['risk'] = riskCoerce.warning;

  // Target / Closed dates — optional.
  const targetCell = colCell('Target Date');
  const targetText = parseStringCell(targetCell);
  let targetDate: string | null = null;
  if (targetText !== '') {
    targetDate = parseDateCell(targetCell);
    if (targetDate === null) {
      warnings['target_date'] = `unparseable date "${targetText}"`;
    }
  }
  const closedCell = colCell('Closed Date');
  const closedText = parseStringCell(closedCell);
  let closedDate: string | null = null;
  if (closedText !== '') {
    closedDate = parseDateCell(closedCell);
    if (closedDate === null) {
      warnings['closed_date'] = `unparseable date "${closedText}"`;
    }
  }
  if (closedDateRequired && closedDate === null) {
    validationErrors.push({
      sheet: sheetName,
      rowIndex,
      column: 'Closed Date',
      reason: 'required cell is empty on Closed Items History sheet',
    });
    return null;
  }

  // Optional 200-char-capped text fields.
  const recommendedAction = parseStringCellWithCap(
    colCell('Recommended Action'),
    sheetName,
    rowIndex,
    'Recommended Action',
    CELL_HARD_CAP,
    validationErrors,
  );
  const raisedBy = parseStringCellWithCap(
    colCell('Raised By'),
    sheetName,
    rowIndex,
    'Raised By',
    FIELD_TEXT_CAP_200,
    validationErrors,
  );
  const followUpOwner = parseStringCellWithCap(
    colCell('Follow Up'),
    sheetName,
    rowIndex,
    'Follow Up',
    FIELD_TEXT_CAP_200,
    validationErrors,
  );
  const departmentRaw = parseStringCell(colCell('Dept'));
  const department = departmentRaw === '' ? null : departmentRaw;

  // Tags
  const tagsParsed = parseTagsCell(colCell('Tags'));
  for (const [k, v] of Object.entries(tagsParsed.warnings)) warnings[k] = v;

  // content_hash (deterministic — same description + start_date across
  // imports produces the same hash, enabling the §3.6 idempotent
  // re-import path).
  const contentHash = await computeContentHash(descRaw, startDate);
  const hex = contentHashHex(contentHash);

  return {
    sourceSheet: sheetName,
    sourceRowIndex: rowIndex,
    section,
    type: typeCoerce.type,
    typeSubtype,
    description: descRaw,
    recommendedAction,
    raisedBy,
    followUpOwner,
    department,
    status: statusCoerce.status,
    risk: riskCoerce.risk,
    startDate,
    targetDate,
    closedDate,
    tags: tagsParsed.tags,
    contentHashHex: hex,
    contentHash,
    importWarnings: warnings,
    localId: generateLocalId(),
  };
}

function parseStringCellWithCap(
  cell: CellLike | null,
  sheet: string,
  rowIndex: number,
  column: string,
  cap: number,
  validationErrors: ValidationError[],
): string | null {
  const raw = parseStringCell(cell);
  if (raw === '') return null;
  if (raw.length > cap) {
    validationErrors.push({
      sheet,
      rowIndex,
      column,
      reason: `cell exceeds cap ${cap} chars`,
    });
    // Return truncated form so the row still parses; the warning above
    // makes the truncation visible in the preview UI.
    return raw.slice(0, cap);
  }
  return raw;
}

async function parseActionItemSheet(
  sheetName: string,
  ws: WorksheetLike,
  section: ActionItemSection,
  closedDateRequired: boolean,
  validationErrors: ValidationError[],
): Promise<ReadonlyArray<ParsedActionItem>> {
  const headerMap = readHeaderRow(ws);
  const maxRow = detectMaxRow(ws);
  const out: ParsedActionItem[] = [];
  // Row 0 is the header row. Data rows are 1..maxRow-1 (SheetJS's
  // `!ref` is 1-based inclusive, so maxRow is the last 1-based row;
  // we iterate 0-based up to maxRow exclusive of the last 1-based row +1).
  for (let r = 1; r < maxRow; r++) {
    const parsed = await parseActionItemRow(
      sheetName,
      r,
      ws,
      headerMap,
      section,
      closedDateRequired,
      validationErrors,
    );
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function parseInspectionReviewSheet(ws: WorksheetLike): ParsedInspectionReview {
  // The Inspection Review sheet is parsed as a literal 2D string grid.
  // No header validation; the entire content is captured verbatim into
  // an envelope-encrypted JSONB column on commit.
  const maxRow = detectMaxRow(ws);
  const rows: string[][] = [];
  // Conservative column scan: detect the widest populated row.
  let maxCol = 0;
  for (let r = 0; r < maxRow; r++) {
    for (let c = 0; c < 64; c++) {
      const cell = cellAt(ws, r, c);
      const t = parseStringCell(cell);
      if (t !== '' && c > maxCol) maxCol = c;
    }
  }
  for (let r = 0; r < maxRow; r++) {
    const row: string[] = [];
    let nonEmpty = false;
    for (let c = 0; c <= maxCol; c++) {
      const t = parseStringCell(cellAt(ws, r, c));
      if (t !== '') nonEmpty = true;
      row.push(t);
    }
    if (nonEmpty) rows.push(row);
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Walk the workbook + verify the schema. Fail-closed: any missing
 * required sheet or column returns `unrecognized`. On success, runs
 * the per-sheet parsers and returns the assembled `ParsedSheets`.
 *
 * The caller (`parser.worker.ts` or `parseWorkbook` in `index.ts`)
 * supplies `sourceSha256Hex` — computed in the worker before parsing
 * so the chain anchor binds to the file bytes even if SheetJS rejects
 * the parse later (T-X40).
 */
export async function detectSchema(
  workbook: WorkbookLike,
  sourceSha256Hex: string,
): Promise<DetectionResult> {
  // (1) Required-sheet presence (T-X8).
  for (const required of REQUIRED_SHEETS) {
    const found = findSheet(workbook, required);
    if (found === null) {
      return {
        kind: 'unrecognized',
        reason: `missing required sheet '${required}'`,
      };
    }
  }
  // (2) `Closed Items History` is treated as required per docs/excel-
  //     import-format.md's table (one of the section sources). The ADR
  //     allows it optional in early workbooks; we land it as required
  //     for v1 and document the trade-off in the format spec. Detector
  //     surfaces a precise reason if absent.
  const closedHistorySheet = findSheet(workbook, 'Closed Items History');
  if (closedHistorySheet === null) {
    return {
      kind: 'unrecognized',
      reason: "missing required sheet 'Closed Items History'",
    };
  }

  // (3) Required columns on each section sheet.
  const sectionSheets = [
    { sheet: 'NEW BUSINESS', section: 'new_business' as ActionItemSection, closedRequired: false },
    { sheet: 'OLD BUSINESS', section: 'old_business' as ActionItemSection, closedRequired: false },
    {
      sheet: 'NOTICE OF RECOMMENDATION',
      section: 'recommendation' as ActionItemSection,
      closedRequired: false,
    },
    {
      sheet: 'COMPLETED',
      section: 'completed_this_period' as ActionItemSection,
      closedRequired: true,
    },
    {
      sheet: 'Closed Items History',
      section: 'archived' as ActionItemSection,
      closedRequired: true,
    },
  ];
  for (const s of sectionSheets) {
    const actual = findSheet(workbook, s.sheet)!;
    const headers = readHeaderRow(workbook.Sheets[actual]!);
    for (const h of ACTION_ITEM_HEADERS) {
      if (!h.required) continue;
      if (findHeader(headers, h.canonical) === null) {
        return {
          kind: 'unrecognized',
          reason: `sheet '${s.sheet}' missing column '${h.canonical}'`,
        };
      }
    }
  }
  // Minutes sheet is column-A/B label layout; check that `Meeting Date`
  // label appears somewhere in column A.
  const minutesSheetName = findSheet(workbook, 'Minutes')!;
  const minutesWs = workbook.Sheets[minutesSheetName]!;
  const minutesMaxRow = detectMaxRow(minutesWs);
  let foundMeetingDateLabel = false;
  for (let r = 0; r < minutesMaxRow; r++) {
    const label = parseStringCell(cellAt(minutesWs, r, 0)).toLowerCase();
    if (label === 'meeting date') {
      foundMeetingDateLabel = true;
      break;
    }
  }
  if (!foundMeetingDateLabel) {
    return {
      kind: 'unrecognized',
      reason: "sheet 'Minutes' missing label 'Meeting Date' in column A",
    };
  }
  // Reference MINUTES_HEADERS so the constant participates in the
  // typechecker's exhaustiveness — the label table is the contract.
  void MINUTES_HEADERS;
  void OPTIONAL_SHEETS;

  // (4) Parse each sheet. Row-level errors collect; the detector still
  //     returns `recognized` so the rep can resolve in preview.
  const validationErrors: ValidationError[] = [];
  const metadata = parseMinutesSheet(minutesWs, validationErrors);

  const sheetsParsed: Record<string, ReadonlyArray<ParsedActionItem>> = {};
  for (const s of sectionSheets) {
    const actual = findSheet(workbook, s.sheet)!;
    sheetsParsed[s.sheet] = await parseActionItemSheet(
      s.sheet,
      workbook.Sheets[actual]!,
      s.section,
      s.closedRequired,
      validationErrors,
    );
  }
  const inspectionReviewName = findSheet(workbook, 'Inspection Review');
  const inspectionReview =
    inspectionReviewName !== null
      ? parseInspectionReviewSheet(workbook.Sheets[inspectionReviewName]!)
      : null;

  const newBusiness = sheetsParsed['NEW BUSINESS']!;
  const oldBusiness = sheetsParsed['OLD BUSINESS']!;
  const recommendations = sheetsParsed['NOTICE OF RECOMMENDATION']!;
  const completed = sheetsParsed['COMPLETED']!;
  const closedHistory = sheetsParsed['Closed Items History']!;
  const rowCount =
    newBusiness.length +
    oldBusiness.length +
    recommendations.length +
    completed.length +
    closedHistory.length;

  return {
    kind: 'recognized',
    schema: 'meeting_minutes_v1',
    sheets: {
      metadata,
      newBusiness,
      oldBusiness,
      recommendations,
      completed,
      closedHistory,
      inspectionReview,
      sourceSha256Hex,
      rowCount,
      validationErrors,
    },
  };
}

// ---------------------------------------------------------------------------
// Sheet-name + section enum re-exports (the importer convenience surface)
// ---------------------------------------------------------------------------

export { actionItemSection, SHEET_SECTION_MAP };
