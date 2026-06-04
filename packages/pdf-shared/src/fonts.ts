// Font registration for shared PDF primitives (ADR-0008 §S4 + ADR-0014 §3.2.3).
//
// Three typefaces per the design system (CLAUDE.md):
//   - Source Serif 4 — narrative body, section notes, signer display
//   - JetBrains Mono — hashes, IDs, chain receipts, document hashes
//   - Inter           — headers, labels, table column headers
//
// Loaded from `PDF_FONT_DIR` env (per the inspections-pdf-renderer
// precedent). When the dir is unset OR a font file is missing, falls
// back to pdfkit's built-in Helvetica / Courier-Bold equivalents so
// the verification gate works in CI without the binary present
// (per ADR-0007 S4 prompt: "the renderer must NOT crash on missing
// fonts").

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type FontFamily = 'serif' | 'serif-bold' | 'mono' | 'sans' | 'sans-bold';

export interface FontRegistration {
  /** True if the requested-family TTF/OTF was loaded; false if we
   * fell back to a pdfkit built-in. */
  readonly resolved: boolean;
  /** Absolute path on disk; '' when fallback path is used. */
  readonly path: string;
  /** pdfkit font name to call doc.font() with. */
  readonly fontName: string;
}

const FONT_DIR = process.env.PDF_FONT_DIR ?? '';

interface FontDescriptor {
  readonly family: FontFamily;
  readonly filename: string;
  readonly fallback: string;
}

const FONT_DESCRIPTORS: readonly FontDescriptor[] = [
  { family: 'serif', filename: 'SourceSerif4-Regular.otf', fallback: 'Helvetica' },
  { family: 'serif-bold', filename: 'SourceSerif4-Bold.otf', fallback: 'Helvetica-Bold' },
  { family: 'mono', filename: 'JetBrainsMono-Regular.ttf', fallback: 'Courier' },
  { family: 'sans', filename: 'Inter-Regular.ttf', fallback: 'Helvetica' },
  { family: 'sans-bold', filename: 'Inter-Bold.ttf', fallback: 'Helvetica-Bold' },
];

/**
 * Resolve a font for a family. If `PDF_FONT_DIR` points to a directory
 * containing the expected filename, the returned FontRegistration
 * carries `resolved: true` and the absolute path. Otherwise falls back
 * to the pdfkit built-in.
 *
 * Pure function — no side-effects on the PDFDocument. The caller
 * either passes the path to `doc.registerFont` (for the resolved
 * variant) or passes the fallback fontName directly to `doc.font`.
 */
export function resolveFont(family: FontFamily): FontRegistration {
  const desc = FONT_DESCRIPTORS.find((d) => d.family === family);
  if (!desc) {
    return { resolved: false, path: '', fontName: 'Helvetica' };
  }
  if (FONT_DIR === '') {
    return { resolved: false, path: '', fontName: desc.fallback };
  }
  const full = join(FONT_DIR, desc.filename);
  if (!existsSync(full)) {
    return { resolved: false, path: '', fontName: desc.fallback };
  }
  return { resolved: true, path: full, fontName: desc.fallback };
}

/**
 * Register all five font families on a pdfkit document. The doc is
 * mutated; subsequent calls to `applyFont(doc, family)` will pick up
 * the registered names for the resolved variants, or fall back to
 * pdfkit built-ins for unresolved ones.
 *
 * Idempotent — safe to call multiple times per document; pdfkit
 * silently overwrites prior registrations.
 */
export function registerAllFonts(doc: PDFKit.PDFDocument): void {
  for (const desc of FONT_DESCRIPTORS) {
    const reg = resolveFont(desc.family);
    if (reg.resolved && reg.path !== '') {
      try {
        doc.registerFont(desc.family, reg.path);
      } catch {
        // pdfkit register failed; applyFont() will fall back to the
        // built-in below. Swallow per the no-crash invariant.
      }
    }
  }
}

/**
 * Switch the document to a named family. Tries the registered name
 * first, falls back to pdfkit's built-in on failure.
 */
export function applyFont(doc: PDFKit.PDFDocument, family: FontFamily): void {
  const desc = FONT_DESCRIPTORS.find((d) => d.family === family);
  const fallback = desc?.fallback ?? 'Helvetica';
  try {
    doc.font(family);
  } catch {
    doc.font(fallback);
  }
}

/** Module-level constant: typography sizes (pt) per the design system. */
export const PDF_TYPOGRAPHY = {
  /** Cover page document title. */
  titleSize: 24,
  /** Section headers within the body. */
  headerSize: 14,
  /** Body prose (Source Serif 4). */
  bodySize: 10,
  /** Table column headers + labels (Inter). */
  labelSize: 9,
  /** Monospace data — hashes, IDs (JetBrains Mono). */
  monoSize: 8,
  /** Footer chrome (page number, doc hash truncated). */
  footerSize: 7,
} as const;
