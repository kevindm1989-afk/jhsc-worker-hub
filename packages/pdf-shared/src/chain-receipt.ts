// Chain receipt panel primitive (ADR-0014 §3.3.7 / §3.9.2).
//
// Final-page provenance panel that an auditor / arbitrator reads to
// verify:
//   - The chain row index for the document.generated event
//   - The full document hash
//   - The chain hash binding the row to the prior chain state
//
// Renders in JetBrains Mono per design system + the data-print=
// "evidentiary" convention. Caller controls cursor; this primitive
// advances it past the panel.

import { PDF_TYPOGRAPHY, applyFont } from './fonts';

export interface ChainReceiptMeta {
  /** audit_log.idx of the generation chain anchor (numeric). */
  readonly chainRowIndex: number;
  /** Hex SHA-256 of the chain row's this_hash (binds the row to the chain). */
  readonly chainHash: string;
  /** Hex SHA-256 of the PDF bytes. */
  readonly documentHash: string;
}

/**
 * Paint the receipt panel at the current cursor. Advances cursor
 * past the panel.
 */
export function renderChainReceipt(doc: PDFKit.PDFDocument, meta: ChainReceiptMeta): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableWidth = right - left;

  // Box top — separator rule.
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#d4d4d8').lineWidth(0.5).stroke();
  doc.moveDown(0.3);

  // Heading.
  applyFont(doc, 'sans-bold');
  doc.fontSize(PDF_TYPOGRAPHY.labelSize).fillColor('#18181b');
  doc.text('Chain Receipt', left, doc.y);
  doc.moveDown(0.3);

  // Three rows of monospace data.
  applyFont(doc, 'mono');
  doc.fontSize(PDF_TYPOGRAPHY.monoSize).fillColor('#3f3f46');

  doc.text(`audit_log.idx     ${meta.chainRowIndex}`, left, doc.y, {
    width: usableWidth,
  });
  doc.text(`chain hash        ${meta.chainHash}`, left, doc.y + 2, {
    width: usableWidth,
  });
  doc.text(`document hash     ${meta.documentHash}`, left, doc.y + 2, {
    width: usableWidth,
  });

  doc.moveDown(0.5);

  // Reset.
  applyFont(doc, 'serif');
  doc.fontSize(PDF_TYPOGRAPHY.bodySize).fillColor('#18181b');
}
