// Page-size constants for shared PDF primitives (ADR-0014 §3.2.4).
//
// pdfkit accepts `size: [widthPts, heightPts]` on PDFDocument
// construction. We expose both `Letter` (8.5" × 11" — North American
// default per the Ontario rep's existing Excel print workflow) and
// `A4` (210mm × 297mm — ISO standard, CA-FED-primary workplaces).
//
// Letter conversion: 8.5 × 72 = 612, 11 × 72 = 792.
// A4 conversion:     595.28, 841.89 (the pdfkit canonical values).
//
// The minutes-document route reads `WORKPLACE.documentPageSize` from
// config/workplace.ts and dispatches to the appropriate dimensions.

export type DocumentPageSize = 'letter' | 'a4';

export interface PageDimensions {
  readonly widthPt: number;
  readonly heightPt: number;
  /** Default margins (pt) — 0.75" = 54pt on all sides. */
  readonly marginPt: number;
}

export const PAGE_DIMENSIONS: Readonly<Record<DocumentPageSize, PageDimensions>> = {
  letter: { widthPt: 612, heightPt: 792, marginPt: 54 },
  a4: { widthPt: 595.28, heightPt: 841.89, marginPt: 54 },
};

/**
 * pdfkit named-size string. The pdfkit constructor accepts either a
 * named string or [w, h] array; named is the simplest path.
 */
export function pdfkitSizeFor(size: DocumentPageSize): 'LETTER' | 'A4' {
  return size === 'a4' ? 'A4' : 'LETTER';
}
