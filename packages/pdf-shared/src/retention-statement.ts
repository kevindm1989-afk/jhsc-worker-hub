// Retention statement primitive (ADR-0014 §3.4 / non-negotiable #5).
//
// Renders the jurisdiction-appropriate retention statement using
// legal-corpus-resolved citations (NEVER invented citations per #5).
// The corpus entries are passed in by the caller (resolved via
// apps/api/src/lib/legal-corpus-retention-preflight.ts).
//
// The full statement runs in Source Serif 4 italic per the design
// system; the citation labels render in JetBrains Mono. Caller
// controls cursor; primitive advances past the rendered statement.

import { PDF_TYPOGRAPHY, applyFont } from './fonts';

export type Jurisdiction = 'ON' | 'CA-FED';

export interface RetentionCorpusEntry {
  readonly statuteCode: string;
  readonly citation: string;
  readonly versionDate: string;
}

export interface RetentionStatementMeta {
  readonly jurisdiction: Jurisdiction;
  readonly corpusEntries: ReadonlyArray<RetentionCorpusEntry>;
}

/**
 * Return the canonical retention statement body for a jurisdiction.
 * The body intentionally embeds NO workplace-specific text — workplace
 * identity is rendered in the document header (env-driven) per #1.
 *
 * The body text is hand-authored per ADR §3.4 to surface the worker-
 * side independence framing ("This worker-side copy is the JHSC
 * worker co-chair's independent record under OHSA s.9(20-21) and is
 * not employer infrastructure.").
 */
function bodyFor(jurisdiction: Jurisdiction): string {
  if (jurisdiction === 'ON') {
    return (
      'These minutes are an evidentiary record of the Joint Health & Safety Committee ' +
      'meeting recorded above. Per OHSA s.9(28), workplace records of JHSC meetings must ' +
      'be retained for not less than two years and made available for inspection by an ' +
      'Ontario Ministry of Labour, Immigration, Training and Skills Development ' +
      'inspector. This worker-side copy is the JHSC worker co-chair’s independent ' +
      'record under OHSA s.9(20-21) and is not employer infrastructure.'
    );
  }
  // CA-FED
  return (
    'These minutes are an evidentiary record of the workplace committee meeting recorded ' +
    'above. Per Canada Labour Code Part II s.135.2 and the Canada Occupational Health ' +
    'and Safety Regulations, records of committee meetings must be retained and made ' +
    'available for inspection by a health and safety officer. This worker-side copy is ' +
    'the worker co-chair’s independent record under CLC Part II and is not ' +
    'employer infrastructure.'
  );
}

/**
 * Paint the retention statement panel.
 */
export function renderRetentionStatement(
  doc: PDFKit.PDFDocument,
  meta: RetentionStatementMeta,
): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableWidth = right - left;

  // Section heading.
  applyFont(doc, 'sans-bold');
  doc.fontSize(PDF_TYPOGRAPHY.labelSize).fillColor('#18181b');
  doc.text('Retention', left, doc.y);
  doc.moveDown(0.2);

  // Body — Source Serif 4 italic.
  applyFont(doc, 'serif');
  doc.fontSize(PDF_TYPOGRAPHY.bodySize).fillColor('#3f3f46');
  doc.text(bodyFor(meta.jurisdiction), left, doc.y, { width: usableWidth, align: 'left' });
  doc.moveDown(0.3);

  // Corpus citation list — JetBrains Mono.
  applyFont(doc, 'mono');
  doc.fontSize(PDF_TYPOGRAPHY.monoSize).fillColor('#52525b');
  for (const entry of meta.corpusEntries) {
    doc.text(
      `${entry.statuteCode} ${entry.citation}  [version ${entry.versionDate}]`,
      left,
      doc.y,
      { width: usableWidth },
    );
  }
  doc.moveDown(0.4);

  // Reset.
  applyFont(doc, 'serif');
  doc.fontSize(PDF_TYPOGRAPHY.bodySize).fillColor('#18181b');
}
