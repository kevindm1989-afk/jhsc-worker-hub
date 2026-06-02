// Tests for the Excel-import reconciliation engine.
//
// Coverage:
//   - create path (no existing match)
//   - skip path (existing + every field matches)
//   - update path (single-field difference, multiple-field difference)
//   - conflict_pending path (editedSinceLastImport=true)
//   - section-transition update (T-X22: same content_hash, different
//     section → diff lists 'section')
//   - cross-section duplicate detection (T-X25: same content_hash
//     appears in two sheets → second classified as skip with diff
//     pointing back at the duplicate)
//   - empty parsed → empty plan
//   - empty existing → all creates
//   - summary counts match decisions array
//
// Pure-function contract: `reconcile()` does not mutate either input,
// does not throw on edge cases (empty arrays), is deterministic.

import { describe, expect, it } from 'vitest';
import { reconcile } from './reconciliation';
import type { ExistingActionItemView, ParsedActionItem, ParsedSheets } from './schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeParsedItem(opts: {
  contentHashHex: string;
  description?: string;
  section?: ParsedActionItem['section'];
  status?: ParsedActionItem['status'];
  risk?: ParsedActionItem['risk'];
  startDate?: string;
  targetDate?: string | null;
  closedDate?: string | null;
  tags?: ReadonlyArray<string>;
  localId?: string;
  sourceSheet?: string;
  sourceRowIndex?: number;
}): ParsedActionItem {
  return {
    sourceSheet: opts.sourceSheet ?? 'NEW BUSINESS',
    sourceRowIndex: opts.sourceRowIndex ?? 1,
    section: opts.section ?? 'new_business',
    type: 'INSP',
    typeSubtype: null,
    description: opts.description ?? 'Pallet jack repair',
    recommendedAction: null,
    raisedBy: null,
    followUpOwner: null,
    department: null,
    status: opts.status ?? 'Not Started',
    risk: opts.risk ?? 'Medium',
    startDate: opts.startDate ?? '2024-01-15',
    targetDate: opts.targetDate ?? null,
    closedDate: opts.closedDate ?? null,
    tags: opts.tags ?? [],
    contentHashHex: opts.contentHashHex,
    contentHash: new Uint8Array(32),
    importWarnings: {},
    localId: opts.localId ?? `local-${opts.contentHashHex.slice(0, 8)}`,
  };
}

function makeExistingItem(opts: {
  contentHashHex: string;
  id?: string;
  section?: ExistingActionItemView['section'];
  status?: ExistingActionItemView['status'];
  risk?: ExistingActionItemView['risk'];
  startDate?: string;
  targetDate?: string | null;
  closedDate?: string | null;
  tags?: ReadonlyArray<string>;
  version?: number;
  editedSinceLastImport?: boolean;
}): ExistingActionItemView {
  return {
    id: opts.id ?? `existing-${opts.contentHashHex.slice(0, 8)}`,
    contentHashHex: opts.contentHashHex,
    section: opts.section ?? 'new_business',
    status: opts.status ?? 'Not Started',
    risk: opts.risk ?? 'Medium',
    startDate: opts.startDate ?? '2024-01-15',
    targetDate: opts.targetDate ?? null,
    closedDate: opts.closedDate ?? null,
    tags: opts.tags ?? [],
    version: opts.version ?? 1,
    editedSinceLastImport: opts.editedSinceLastImport ?? false,
  };
}

function makeParsedSheets(items: {
  newBusiness?: ReadonlyArray<ParsedActionItem>;
  oldBusiness?: ReadonlyArray<ParsedActionItem>;
  recommendations?: ReadonlyArray<ParsedActionItem>;
  completed?: ReadonlyArray<ParsedActionItem>;
  closedHistory?: ReadonlyArray<ParsedActionItem>;
}): ParsedSheets {
  return {
    metadata: {
      meetingDate: '2024-03-15',
      quorum: true,
      attendance: null,
      workbookVersionString: null,
    },
    newBusiness: items.newBusiness ?? [],
    oldBusiness: items.oldBusiness ?? [],
    recommendations: items.recommendations ?? [],
    completed: items.completed ?? [],
    closedHistory: items.closedHistory ?? [],
    inspectionReview: null,
    sourceSha256Hex: '0'.repeat(64),
    rowCount:
      (items.newBusiness?.length ?? 0) +
      (items.oldBusiness?.length ?? 0) +
      (items.recommendations?.length ?? 0) +
      (items.completed?.length ?? 0) +
      (items.closedHistory?.length ?? 0),
    validationErrors: [],
  };
}

// Stable hex hashes for the tests. Doesn't matter that they're synthetic
// — the reconciler compares them as strings.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcile — empty inputs', () => {
  it('empty parsed → empty plan', () => {
    const plan = reconcile(makeParsedSheets({}), [], 'import-1');
    expect(plan.decisions).toEqual([]);
    expect(plan.summary).toEqual({
      createCount: 0,
      updateCount: 0,
      skipCount: 0,
      conflictCount: 0,
    });
    expect(plan.importId).toBe('import-1');
  });

  it('empty existing → every parsed row becomes create', () => {
    const sheets = makeParsedSheets({
      newBusiness: [
        makeParsedItem({ contentHashHex: HASH_A }),
        makeParsedItem({ contentHashHex: HASH_B }),
      ],
    });
    const plan = reconcile(sheets, [], 'import-1');
    expect(plan.decisions).toHaveLength(2);
    expect(plan.decisions.every((d) => d.decisionKind === 'create')).toBe(true);
    expect(plan.summary.createCount).toBe(2);
  });

  it('throws on missing importId', () => {
    expect(() => reconcile(makeParsedSheets({}), [], '')).toThrow(/importId/);
  });
});

describe('reconcile — create / skip / update', () => {
  it('create when no existing match', () => {
    const sheets = makeParsedSheets({
      newBusiness: [makeParsedItem({ contentHashHex: HASH_A })],
    });
    const plan = reconcile(sheets, [makeExistingItem({ contentHashHex: HASH_B })], 'i');
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]!.decisionKind).toBe('create');
    expect(plan.summary.createCount).toBe(1);
  });

  it('skip when every field matches', () => {
    const sheets = makeParsedSheets({
      newBusiness: [
        makeParsedItem({
          contentHashHex: HASH_A,
          status: 'In Progress',
          risk: 'High',
          tags: ['x', 'y'],
        }),
      ],
    });
    const plan = reconcile(
      sheets,
      [
        makeExistingItem({
          contentHashHex: HASH_A,
          status: 'In Progress',
          risk: 'High',
          tags: ['y', 'x'], // sort-normalized comparison
        }),
      ],
      'i',
    );
    expect(plan.decisions[0]!.decisionKind).toBe('skip');
    expect(plan.decisions[0]!.diff).toEqual([]);
    expect(plan.summary.skipCount).toBe(1);
  });

  it('update when one field differs', () => {
    const sheets = makeParsedSheets({
      newBusiness: [makeParsedItem({ contentHashHex: HASH_A, status: 'Closed', risk: 'High' })],
    });
    const plan = reconcile(
      sheets,
      [makeExistingItem({ contentHashHex: HASH_A, status: 'In Progress', risk: 'High' })],
      'i',
    );
    expect(plan.decisions[0]!.decisionKind).toBe('update');
    expect(plan.decisions[0]!.diff).toHaveLength(1);
    expect(plan.decisions[0]!.diff[0]!.field).toBe('status');
    expect(plan.decisions[0]!.diff[0]!.current).toBe('In Progress');
    expect(plan.decisions[0]!.diff[0]!.incoming).toBe('Closed');
    expect(plan.summary.updateCount).toBe(1);
  });

  it('update with multiple fields differing', () => {
    const sheets = makeParsedSheets({
      newBusiness: [
        makeParsedItem({
          contentHashHex: HASH_A,
          status: 'Closed',
          risk: 'Critical',
          targetDate: '2024-05-01',
          tags: ['urgent'],
        }),
      ],
    });
    const plan = reconcile(
      sheets,
      [
        makeExistingItem({
          contentHashHex: HASH_A,
          status: 'In Progress',
          risk: 'Medium',
          targetDate: null,
          tags: [],
        }),
      ],
      'i',
    );
    expect(plan.decisions[0]!.decisionKind).toBe('update');
    expect(plan.decisions[0]!.diff.map((d) => d.field).sort()).toEqual(
      ['risk', 'status', 'tags', 'targetDate'].sort(),
    );
  });
});

describe('reconcile — section transition (T-X22)', () => {
  it('treats section drift as an update + lists section in the diff', () => {
    const sheets = makeParsedSheets({
      oldBusiness: [
        makeParsedItem({
          contentHashHex: HASH_A,
          section: 'old_business',
          sourceSheet: 'OLD BUSINESS',
        }),
      ],
    });
    const plan = reconcile(
      sheets,
      [makeExistingItem({ contentHashHex: HASH_A, section: 'new_business' })],
      'i',
    );
    expect(plan.decisions[0]!.decisionKind).toBe('update');
    const sectionDiff = plan.decisions[0]!.diff.find((d) => d.field === 'section');
    expect(sectionDiff).toBeDefined();
    expect(sectionDiff!.current).toBe('new_business');
    expect(sectionDiff!.incoming).toBe('old_business');
  });
});

describe('reconcile — conflict_pending', () => {
  it('classifies match as conflict_pending when editedSinceLastImport=true', () => {
    const sheets = makeParsedSheets({
      newBusiness: [makeParsedItem({ contentHashHex: HASH_A, status: 'Closed' })],
    });
    const plan = reconcile(
      sheets,
      [
        makeExistingItem({
          contentHashHex: HASH_A,
          status: 'In Progress',
          editedSinceLastImport: true,
          version: 3,
        }),
      ],
      'i',
    );
    expect(plan.decisions[0]!.decisionKind).toBe('conflict_pending');
    expect(plan.decisions[0]!.diff).toHaveLength(1);
    expect(plan.summary.conflictCount).toBe(1);
    expect(plan.summary.updateCount).toBe(0);
  });
});

describe('reconcile — cross-section duplicate (T-X25)', () => {
  it('classifies the second occurrence as skip with a duplicate marker', () => {
    const dup = makeParsedItem({
      contentHashHex: HASH_A,
      sourceSheet: 'OLD BUSINESS',
      section: 'old_business',
    });
    const first = makeParsedItem({
      contentHashHex: HASH_A,
      sourceSheet: 'NEW BUSINESS',
      section: 'new_business',
    });
    const sheets = makeParsedSheets({
      newBusiness: [first],
      oldBusiness: [dup],
    });
    const plan = reconcile(sheets, [], 'i');
    expect(plan.decisions).toHaveLength(2);
    expect(plan.decisions[0]!.decisionKind).toBe('create');
    expect(plan.decisions[1]!.decisionKind).toBe('skip');
    expect(plan.decisions[1]!.diff[0]!.field).toBe('duplicate');
  });
});

describe('reconcile — multiple rows', () => {
  it('classifies a mix of create / update / skip / conflict correctly', () => {
    const sheets = makeParsedSheets({
      newBusiness: [
        makeParsedItem({ contentHashHex: HASH_A }), // create
        makeParsedItem({ contentHashHex: HASH_B, status: 'Closed' }), // update
        makeParsedItem({ contentHashHex: HASH_C }), // skip
      ],
    });
    const plan = reconcile(
      sheets,
      [
        makeExistingItem({ contentHashHex: HASH_B, status: 'In Progress' }), // update target
        makeExistingItem({ contentHashHex: HASH_C }), // skip target (matches default)
      ],
      'i',
    );
    expect(plan.summary).toEqual({
      createCount: 1,
      updateCount: 1,
      skipCount: 1,
      conflictCount: 0,
    });
  });
});

describe('reconcile — purity', () => {
  it('does not mutate the parsed sheets', () => {
    const sheets = makeParsedSheets({
      newBusiness: [makeParsedItem({ contentHashHex: HASH_A })],
    });
    const before = JSON.stringify(sheets);
    reconcile(sheets, [], 'i');
    expect(JSON.stringify(sheets)).toBe(before);
  });

  it('does not mutate the existing array', () => {
    const existing = [makeExistingItem({ contentHashHex: HASH_A })];
    const before = JSON.stringify(existing);
    reconcile(makeParsedSheets({}), existing, 'i');
    expect(JSON.stringify(existing)).toBe(before);
  });
});
