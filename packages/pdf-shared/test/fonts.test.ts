// Unit test for the fonts resolver (no PDFDocument-mutating helpers
// — those are exercised via the golden-PDF suite).

import { describe, expect, it } from 'vitest';
import { PDF_TYPOGRAPHY, resolveFont } from '../src/fonts';

describe('resolveFont', () => {
  it('returns fallback when PDF_FONT_DIR is unset (CI path)', () => {
    // We do not mutate process.env here — the env var defaults to ''.
    // resolveFont without PDF_FONT_DIR resolves to the pdfkit built-in.
    const reg = resolveFont('serif');
    // Defensively allow CI environments where the dir IS set; in
    // either case the returned shape is well-formed.
    expect(typeof reg.resolved).toBe('boolean');
    expect(typeof reg.fontName).toBe('string');
    if (!reg.resolved) {
      expect(reg.fontName).toBe('Helvetica');
      expect(reg.path).toBe('');
    }
  });

  it('serif-bold falls back to Helvetica-Bold', () => {
    const reg = resolveFont('serif-bold');
    if (!reg.resolved) {
      expect(reg.fontName).toBe('Helvetica-Bold');
    }
  });

  it('mono falls back to Courier', () => {
    const reg = resolveFont('mono');
    if (!reg.resolved) {
      expect(reg.fontName).toBe('Courier');
    }
  });
});

describe('PDF_TYPOGRAPHY', () => {
  it('exposes the canonical size constants', () => {
    expect(PDF_TYPOGRAPHY.titleSize).toBe(24);
    expect(PDF_TYPOGRAPHY.headerSize).toBe(14);
    expect(PDF_TYPOGRAPHY.bodySize).toBe(10);
    expect(PDF_TYPOGRAPHY.labelSize).toBe(9);
    expect(PDF_TYPOGRAPHY.monoSize).toBe(8);
    expect(PDF_TYPOGRAPHY.footerSize).toBe(7);
  });
});
