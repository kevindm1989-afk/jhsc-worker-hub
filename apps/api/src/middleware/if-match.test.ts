// Unit tests for the If-Match parser (Milestone 1.10 S2 + S5 fix bundle).
//
// The parser is pure (no DB) so these are fast unit tests.

import { describe, expect, it } from 'vitest';
import { parseIfMatchVersion } from './if-match';

describe('parseIfMatchVersion', () => {
  it('accepts the canonical strong-etag form `"123"`', () => {
    expect(parseIfMatchVersion('"123"')).toBe(123);
  });

  it('accepts a bare integer (older clients without quotes)', () => {
    expect(parseIfMatchVersion('123')).toBe(123);
  });

  it('rejects a weak etag `W/"123"` per RFC 9110 §8.8.3.4', () => {
    expect(parseIfMatchVersion('W/"123"')).toBeNull();
  });

  it('rejects an empty header', () => {
    expect(parseIfMatchVersion('')).toBeNull();
    expect(parseIfMatchVersion('  ')).toBeNull();
  });

  it('rejects null / undefined', () => {
    expect(parseIfMatchVersion(null)).toBeNull();
    expect(parseIfMatchVersion(undefined)).toBeNull();
  });

  it('rejects non-numeric content', () => {
    expect(parseIfMatchVersion('"abc"')).toBeNull();
    expect(parseIfMatchVersion('123abc')).toBeNull();
    expect(parseIfMatchVersion('"12.3"')).toBeNull();
  });

  it('S5 LOW close-out: rejects `"0"` as a valid version', () => {
    // Migration 0009 sets version DEFAULT 1; the bump trigger only
    // increments. No server-side row ever holds version=0. A client
    // shipping If-Match: "0" is symptomatic of the sec-F7 / T-S55
    // gap (POST omits the version field). Reject at parse time so
    // the failure surfaces as a clean 428 rather than slipping
    // through to a misleading 409.
    expect(parseIfMatchVersion('"0"')).toBeNull();
    expect(parseIfMatchVersion('0')).toBeNull();
  });

  it('accepts large valid versions (e.g. after many PATCHes)', () => {
    expect(parseIfMatchVersion('"42"')).toBe(42);
    expect(parseIfMatchVersion('"999999"')).toBe(999999);
  });

  it('rejects negative numbers (defense-in-depth)', () => {
    expect(parseIfMatchVersion('-1')).toBeNull();
    expect(parseIfMatchVersion('"-5"')).toBeNull();
  });
});
