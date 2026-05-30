import { describe, expect, it } from 'vitest';
import { safeSummary } from './crypto';

// safeSummary unit tests — priv-review F4 (1.5).
// Encryption-round-trip tests live in the integration suite because they
// require the KEK; this file exercises the deterministic projection
// logic against worst-case inputs.

describe('safeSummary', () => {
  it('returns the input unchanged when shorter than the cap', () => {
    expect(safeSummary('short body')).toBe('short body');
  });

  it('trims at the last word boundary when the cap falls mid-token', () => {
    const body = 'a'.repeat(70) + ' bcdefghij klmnop';
    // cap=80 falls in "klmnop"; last space is at index 80.
    const result = safeSummary(body, 80);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toContain('klmnop');
  });

  it('never returns more than max+1 characters (cap + ellipsis)', () => {
    const longBody = 'word '.repeat(200);
    const result = safeSummary(longBody, 80);
    // Ellipsis is one codepoint; total length <= 81.
    expect(result.length).toBeLessThanOrEqual(81);
  });

  it('sheds a trailing partial token when no word boundary exists in the first 80 chars', () => {
    // Worst case: name jammed against description with no space.
    // "JohnDoeIsTheReporter..." -- the legacy trim-at-cap would return
    // the first 80 chars intact. New behavior: fall back to (cap - 10)
    // so the trailing partial token loses 10 chars.
    const body = 'JohnDoeIsTheReporter' + 'X'.repeat(100);
    const result = safeSummary(body, 80);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThan(80);
    // The output should be SHORTER than the input's first 80 chars
    // (the legacy behavior would have returned the first 80).
    expect(result.replace('…', '').length).toBeLessThanOrEqual(70);
  });

  it('handles a single very long word longer than the cap', () => {
    const body = 'a'.repeat(200);
    const result = safeSummary(body, 80);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThan(80);
  });

  it('handles multi-byte unicode without splitting graphemes badly', () => {
    // Roughly 80 chars of 2-byte unicode + a long-run no-space tail.
    const body = '日本語'.repeat(30) + 'tail-no-space';
    const result = safeSummary(body, 80);
    expect(result.endsWith('…')).toBe(true);
    // Should still be bounded.
    expect(result.length).toBeLessThanOrEqual(81);
  });

  it('respects a custom cap', () => {
    const body = 'one two three four five six seven eight nine';
    const result = safeSummary(body, 20);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(21);
  });
});
