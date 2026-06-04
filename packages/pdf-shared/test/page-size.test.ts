// Unit test for page-size constants + pdfkit named-size helper.

import { describe, expect, it } from 'vitest';
import { PAGE_DIMENSIONS, pdfkitSizeFor } from '../src/page-size';

describe('page-size constants', () => {
  it('letter is 612 × 792 pt (8.5" × 11" at 72dpi)', () => {
    expect(PAGE_DIMENSIONS.letter.widthPt).toBe(612);
    expect(PAGE_DIMENSIONS.letter.heightPt).toBe(792);
  });

  it('a4 is the canonical pdfkit value (~595.28 × ~841.89 pt)', () => {
    expect(PAGE_DIMENSIONS.a4.widthPt).toBeCloseTo(595.28, 2);
    expect(PAGE_DIMENSIONS.a4.heightPt).toBeCloseTo(841.89, 2);
  });

  it('default margins are 0.75" / 54pt on all four sides', () => {
    expect(PAGE_DIMENSIONS.letter.marginPt).toBe(54);
    expect(PAGE_DIMENSIONS.a4.marginPt).toBe(54);
  });
});

describe('pdfkitSizeFor', () => {
  it('maps letter to "LETTER"', () => {
    expect(pdfkitSizeFor('letter')).toBe('LETTER');
  });

  it('maps a4 to "A4"', () => {
    expect(pdfkitSizeFor('a4')).toBe('A4');
  });
});
