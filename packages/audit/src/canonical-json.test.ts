import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from './canonical-json';

describe('canonicalJsonStringify', () => {
  it('serializes primitives', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify(-0.5)).toBe('-0.5');
    expect(canonicalJsonStringify('hello')).toBe('"hello"');
  });

  it('escapes strings via JSON rules', () => {
    expect(canonicalJsonStringify('a"b')).toBe('"a\\"b"');
    expect(canonicalJsonStringify('a\nb')).toBe('"a\\nb"');
  });

  it('sorts object keys lexicographically by codepoint', () => {
    // Plain ASCII order — z before a fails.
    expect(canonicalJsonStringify({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    // Mixed case: capital before lowercase.
    expect(canonicalJsonStringify({ b: 1, B: 2 })).toBe('{"B":2,"b":1}');
  });

  it('serializes nested objects with recursive sort', () => {
    expect(canonicalJsonStringify({ z: { b: 1, a: 2 }, a: [3, 2, 1] })).toBe(
      '{"a":[3,2,1],"z":{"a":2,"b":1}}',
    );
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJsonStringify(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify(Infinity)).toThrow(/non-finite/);
  });

  it('rejects undefined values', () => {
    expect(() => canonicalJsonStringify({ a: undefined })).toThrow(/undefined/);
  });

  it('is byte-equal for two semantically-identical inputs with different key order', () => {
    const a = canonicalJsonStringify({ a: 1, b: 2, c: { y: 9, x: 8 } });
    const b = canonicalJsonStringify({ c: { x: 8, y: 9 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });
});
