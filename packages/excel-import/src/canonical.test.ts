import { describe, expect, it } from 'vitest';
import {
  canonicalizeDescription,
  canonicalizeStartDate,
  computeContentHash,
  contentHashHex,
} from './canonical';

describe('canonicalizeDescription — NFC + trim + collapse + lowercase', () => {
  it('NFC: composed and decomposed forms canonicalize identically', () => {
    // 'café' as composed (U+00E9) vs decomposed (U+0065 + U+0301).
    const composed = 'café spill';
    const decomposed = 'café spill';
    expect(canonicalizeDescription(composed)).toBe(canonicalizeDescription(decomposed));
  });

  it('trim: leading + trailing whitespace removed', () => {
    expect(canonicalizeDescription('   pallet jack repair   ')).toBe('pallet jack repair');
  });

  it('collapse: multi-internal whitespace becomes single space', () => {
    expect(canonicalizeDescription('pallet  jack    repair')).toBe('pallet jack repair');
    expect(canonicalizeDescription('pallet\tjack\nrepair')).toBe('pallet jack repair');
  });

  it('lowercase: case-insensitive', () => {
    expect(canonicalizeDescription('Pallet Jack Repair')).toBe('pallet jack repair');
    expect(canonicalizeDescription('PALLET JACK REPAIR')).toBe('pallet jack repair');
  });

  it('combination: NFC + trim + collapse + lowercase together', () => {
    expect(canonicalizeDescription('  Café   Spill  ON  Floor  ')).toBe('café spill on floor');
  });

  it('empty input returns empty string (canonicalization itself does not throw)', () => {
    expect(canonicalizeDescription('')).toBe('');
    expect(canonicalizeDescription('   ')).toBe('');
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — defensive guard against a buggy caller passing wrong type — runtime guard against a buggy caller.
    expect(() => canonicalizeDescription(null)).toThrow(/expected string/);
    // @ts-expect-error — defensive guard against a buggy caller passing wrong type
    expect(() => canonicalizeDescription(42)).toThrow(/expected string/);
  });

  it('does not mutate its input', () => {
    const input = '  Foo Bar  ';
    canonicalizeDescription(input);
    expect(input).toBe('  Foo Bar  ');
  });
});

describe('canonicalizeStartDate — coerce to ISO YYYY-MM-DD', () => {
  it('accepts a YYYY-MM-DD string verbatim', () => {
    expect(canonicalizeStartDate('2024-01-15')).toBe('2024-01-15');
  });

  it('accepts a Date object and formats as UTC YYYY-MM-DD', () => {
    const d = new Date('2024-01-15T12:34:56.000Z');
    expect(canonicalizeStartDate(d)).toBe('2024-01-15');
  });

  it('accepts a full ISO timestamp string and strips the time component', () => {
    expect(canonicalizeStartDate('2024-01-15T08:00:00.000Z')).toBe('2024-01-15');
  });

  it('rejects calendar-invalid YYYY-MM-DD strings (month 13)', () => {
    expect(() => canonicalizeStartDate('2024-13-45')).toThrow(/out-of-range|invalid/);
  });

  it('rejects calendar-invalid YYYY-MM-DD strings (Feb 30)', () => {
    expect(() => canonicalizeStartDate('2024-02-30')).toThrow(/out-of-range|invalid/);
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(() => canonicalizeStartDate('')).toThrow(/empty string/);
    expect(() => canonicalizeStartDate('   ')).toThrow(/empty string/);
  });

  it('rejects invalid Date objects (NaN)', () => {
    expect(() => canonicalizeStartDate(new Date('not-a-date'))).toThrow(/invalid Date/);
  });

  it('rejects unparseable strings', () => {
    expect(() => canonicalizeStartDate('definitely not a date')).toThrow(/unparseable/);
  });

  it('rejects non-string-non-Date inputs', () => {
    // @ts-expect-error — defensive guard against a buggy caller passing wrong type
    expect(() => canonicalizeStartDate(123456)).toThrow(/expected string or Date/);
    // @ts-expect-error — defensive guard against a buggy caller passing wrong type
    expect(() => canonicalizeStartDate(null)).toThrow(/expected string or Date/);
  });
});

describe('computeContentHash — sha256(canonical(desc)||"|"||canonical(date))', () => {
  it('returns a 32-byte Uint8Array', async () => {
    const h = await computeContentHash('Pallet jack repair', '2024-01-15');
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h.length).toBe(32);
  });

  it('stability: same input → same hash', async () => {
    const a = await computeContentHash('Pallet jack repair', '2024-01-15');
    const b = await computeContentHash('Pallet jack repair', '2024-01-15');
    expect(contentHashHex(a)).toBe(contentHashHex(b));
  });

  it('case-insensitivity flows through to the hash', async () => {
    const a = await computeContentHash('PALLET JACK REPAIR', '2024-01-15');
    const b = await computeContentHash('pallet jack repair', '2024-01-15');
    expect(contentHashHex(a)).toBe(contentHashHex(b));
  });

  it('whitespace-collapse flows through to the hash', async () => {
    const a = await computeContentHash('  Pallet jack repair  ', '2024-01-15');
    const b = await computeContentHash('Pallet  jack    repair', '2024-01-15');
    const c = await computeContentHash('pallet jack repair', '2024-01-15');
    expect(contentHashHex(a)).toBe(contentHashHex(c));
    expect(contentHashHex(b)).toBe(contentHashHex(c));
  });

  it('NFC normalization flows through to the hash', async () => {
    const composed = await computeContentHash('café spill', '2024-01-15');
    const decomposed = await computeContentHash('café spill', '2024-01-15');
    expect(contentHashHex(composed)).toBe(contentHashHex(decomposed));
  });

  it('Date object vs ISO date string produce the same hash', async () => {
    const dateObj = new Date('2024-01-15T08:00:00.000Z');
    const a = await computeContentHash('Pallet jack repair', dateObj);
    const b = await computeContentHash('Pallet jack repair', '2024-01-15');
    expect(contentHashHex(a)).toBe(contentHashHex(b));
  });

  it('different description → different hash', async () => {
    const a = await computeContentHash('Pallet jack repair', '2024-01-15');
    const b = await computeContentHash('Pallet jack broken', '2024-01-15');
    expect(contentHashHex(a)).not.toBe(contentHashHex(b));
  });

  it('different date → different hash', async () => {
    const a = await computeContentHash('Pallet jack repair', '2024-01-15');
    const b = await computeContentHash('Pallet jack repair', '2024-02-15');
    expect(contentHashHex(a)).not.toBe(contentHashHex(b));
  });

  it('separator prevents naive concatenation collision', async () => {
    // Without a separator, ('foo bar', '...') could collide with
    // ('foo', 'bar...'). The '|' separator structurally prevents this
    // because '|' cannot appear in a canonicalized ISO date.
    const a = await computeContentHash('foo bar', '2024-01-15');
    const b = await computeContentHash('foo', '2024-01-15');
    expect(contentHashHex(a)).not.toBe(contentHashHex(b));
  });

  it('rejects empty canonical description (T-X12)', async () => {
    await expect(computeContentHash('   ', '2024-01-15')).rejects.toThrow(
      /canonicalized description is empty/,
    );
  });

  it('rejects invalid start_date', async () => {
    await expect(computeContentHash('Pallet jack repair', '2024-13-45')).rejects.toThrow(
      /out-of-range|invalid/,
    );
  });
});

describe('contentHashHex — 32 bytes → 64-char lowercase hex', () => {
  it('round-trip stability: hex is the canonical wire form', async () => {
    const h = await computeContentHash('Pallet jack repair', '2024-01-15');
    const hex = contentHashHex(h);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex.length).toBe(64);
  });

  it('all-zero hash renders as 64 zeros', () => {
    const zero = new Uint8Array(32);
    expect(contentHashHex(zero)).toBe('0'.repeat(64));
  });

  it('all-0xff hash renders as 64 f-chars', () => {
    const ff = new Uint8Array(32).fill(0xff);
    expect(contentHashHex(ff)).toBe('f'.repeat(64));
  });

  it('rejects wrong-length input', () => {
    expect(() => contentHashHex(new Uint8Array(31))).toThrow(/expected 32 bytes/);
    expect(() => contentHashHex(new Uint8Array(33))).toThrow(/expected 32 bytes/);
  });
});
