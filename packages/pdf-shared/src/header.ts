// Document header primitive (ADR-0014 §3.2.5 / inspections + recommendations).
//
// Renders the canonical document header band: workplace display name
// (env-driven per non-negotiable #1 — passed in by the caller, never
// hardcoded), document title, generated_at timestamp. Used by all three
// PDF surfaces (inspections / recommendations / minutes-documents).
//
// Pure-ish: mutates the passed PDFDocument; takes no other side effects.
// Caller controls the document's cursor position before invoking.

import { PDF_TYPOGRAPHY, applyFont } from './fonts';

export interface HeaderMeta {
  /** Workplace display name from `config/workplace.ts` (env-driven). */
  readonly workplaceDisplayName: string;
  /** Document title (e.g., "JHSC Meeting Minutes — 2026-09-15"). */
  readonly documentTitle: string;
  /** ISO 8601 generated_at timestamp string. */
  readonly generatedAt: string;
}

/**
 * Paint the header band starting at the document's current y position.
 * Advances the cursor below the header so the caller can continue
 * rendering body content beneath.
 *
 * Conventional vertical layout:
 *   - Workplace display name (Inter 9pt, muted color)
 *   - Document title (Source Serif 4 Bold 14pt)
 *   - Generated at (JetBrains Mono 8pt, muted)
 *   - 12pt of trailing whitespace
 */
export function renderHeader(doc: PDFKit.PDFDocument, meta: HeaderMeta): void {
  const left = doc.page.margins.left;
  const top = doc.y;

  // Workplace name — muted, small Inter.
  applyFont(doc, 'sans');
  doc.fontSize(PDF_TYPOGRAPHY.labelSize).fillColor('#52525b');
  doc.text(meta.workplaceDisplayName || ' ', left, top);

  // Document title — Source Serif Bold.
  applyFont(doc, 'serif-bold');
  doc.fontSize(PDF_TYPOGRAPHY.headerSize).fillColor('#18181b');
  doc.text(meta.documentTitle, left, doc.y + 2);

  // Generated-at — JetBrains Mono small.
  applyFont(doc, 'mono');
  doc.fontSize(PDF_TYPOGRAPHY.monoSize).fillColor('#71717a');
  doc.text(`Generated: ${meta.generatedAt}`, left, doc.y + 2);

  // Trailing whitespace.
  doc.moveDown(0.5);

  // Reset to default body font/size for caller convenience.
  applyFont(doc, 'serif');
  doc.fontSize(PDF_TYPOGRAPHY.bodySize).fillColor('#18181b');
}
