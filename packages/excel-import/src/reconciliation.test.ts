// Skeleton tests for the reconciliation engine. S2 fleshes out the
// behavioral assertions once the engine body lands. S1 keeps the suite
// non-empty so `pnpm test --filter @jhsc/excel-import` does not regress
// to "0 tests" when the package is added.

import { describe, expect, it } from 'vitest';
import { reconcile } from './reconciliation';
import type { ParsedSheets } from './schema';

describe('reconcile — S1 stub', () => {
  it('throws "not implemented (S2)" so callers know the seam is reserved', () => {
    const emptyParsed: ParsedSheets = {
      metadata: {
        meetingDate: '2024-01-01',
        quorum: null,
        attendance: null,
        workbookVersionString: null,
      },
      newBusiness: [],
      oldBusiness: [],
      recommendations: [],
      completed: [],
      closedHistory: [],
      inspectionReview: null,
      sourceSha256Hex: '0'.repeat(64),
      rowCount: 0,
    };
    expect(() => reconcile(emptyParsed, [], 'import-1')).toThrow(/not implemented \(S2\)/);
  });
});
