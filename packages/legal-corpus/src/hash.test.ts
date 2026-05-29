import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bodyHashHex, computeBodyHash, normalizeVersionDate } from './hash';

describe('normalizeVersionDate', () => {
  it('passes through a valid YYYY-MM-DD string', () => {
    expect(normalizeVersionDate('2020-07-01')).toBe('2020-07-01');
  });

  it('rejects a non-ISO string', () => {
    expect(() => normalizeVersionDate('07/01/2020')).toThrow(/YYYY-MM-DD/);
  });

  it('rejects an empty string', () => {
    expect(() => normalizeVersionDate('')).toThrow(/YYYY-MM-DD/);
  });

  it('formats a Date to UTC YYYY-MM-DD', () => {
    expect(normalizeVersionDate(new Date(Date.UTC(2020, 6, 1)))).toBe('2020-07-01');
    expect(normalizeVersionDate(new Date(Date.UTC(1999, 0, 5)))).toBe('1999-01-05');
  });
});

describe('computeBodyHash', () => {
  it('is byte-identical for the same body+date whether date is Date or string', () => {
    const body = 'An employer shall do everything reasonable in the circumstances.';
    const fromString = computeBodyHash(body, '2020-07-01');
    const fromDate = computeBodyHash(body, new Date(Date.UTC(2020, 6, 1)));
    expect(Buffer.from(fromString).equals(Buffer.from(fromDate))).toBe(true);
  });

  it('changes when the body changes', () => {
    const a = bodyHashHex('original', '2020-07-01');
    const b = bodyHashHex('amended', '2020-07-01');
    expect(a).not.toBe(b);
  });

  it('changes when the version_date changes', () => {
    const a = bodyHashHex('same body', '2020-07-01');
    const b = bodyHashHex('same body', '2021-07-01');
    expect(a).not.toBe(b);
  });

  it('matches an independent SHA-256(body||date) computation', () => {
    const body = 'check anchor';
    const date = '2024-01-15';
    const expected = createHash('sha256').update(body, 'utf8').update(date, 'utf8').digest('hex');
    expect(bodyHashHex(body, date)).toBe(expected);
  });
});
