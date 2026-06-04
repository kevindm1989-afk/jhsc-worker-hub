// Per-page footer primitive (ADR-0014 §3.2.5 / ADR-0007 §3.9).
//
// Three-zone footer:
//   Left:   document title or meeting date (caller chooses)
//   Center: "page N of M"
//   Right:  truncated document hash + retention statement reminder
//
// The full document hash + chain receipt panel lives on the final
// page via the chain-receipt primitive (per ADR §3.3.7). The footer's
// truncated hash is the at-a-glance proof for any page.
//
// Pure-ish: mutates the passed PDFDocument; takes no other side effects.

import { PDF_TYPOGRAPHY, applyFont } from './fonts';

export interface FooterMeta {
  /** Hex SHA-256 of the rendered PDF bytes (64 chars). */
  readonly documentHash: string;
  /** 1-indexed current page. */
  readonly pageNumber: number;
  /** Total pages in the document (post-render). */
  readonly totalPages: number;
  /**
   * Short retention statement to surface on every page (e.g.,
   * "Retain 2 yrs · OHSA s.9(28)"). The full retention statement
   * with corpus citations renders on the final page via the
   * retention-statement primitive.
   */
  readonly retentionStatement: string;
  /** Optional left-zone label (e.g., meeting date or document title). */
  readonly leftLabel?: string;
}

/**
 * Paint the footer band at the bottom of the current page. Does NOT
 * advance the document's y cursor — the caller may continue body
 * rendering above the footer band on the same page.
 */
export function renderFooter(doc: PDFKit.PDFDocument, meta: FooterMeta): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  // Footer band sits ~24pt above the bottom edge.
  const footerY = doc.page.height - doc.page.margins.bottom + 12;
  const usableWidth = right - left;

  // Truncate document hash to 8 chars for the at-a-glance proof.
  const truncatedHash =
    meta.documentHash.length >= 8 ? meta.documentHash.slice(0, 8) : meta.documentHash;

  applyFont(doc, 'sans');
  doc.fontSize(PDF_TYPOGRAPHY.footerSize).fillColor('#71717a');

  // Left zone — caller's label (or empty).
  const leftLabel = meta.leftLabel ?? '';
  doc.text(leftLabel, left, footerY, { width: usableWidth / 3, align: 'left' });

  // Center zone — page N of M.
  doc.text(`page ${meta.pageNumber} of ${meta.totalPages}`, left + usableWidth / 3, footerY, {
    width: usableWidth / 3,
    align: 'center',
  });

  // Right zone — truncated doc hash + retention reminder.
  applyFont(doc, 'mono');
  doc.text(`doc ${truncatedHash}…`, left + (usableWidth * 2) / 3, footerY, {
    width: usableWidth / 3,
    align: 'right',
  });

  // Second-line retention reminder (right-aligned, below the hash).
  applyFont(doc, 'sans');
  doc.fontSize(PDF_TYPOGRAPHY.footerSize - 1).fillColor('#a1a1aa');
  doc.text(meta.retentionStatement, left + (usableWidth * 2) / 3, footerY + 9, {
    width: usableWidth / 3,
    align: 'right',
  });

  // Reset.
  applyFont(doc, 'serif');
  doc.fillColor('#18181b');
}
