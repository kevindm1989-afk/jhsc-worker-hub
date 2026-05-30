import { beforeAll, describe, expect, it } from 'vitest';
import {
  blake2bKeyed,
  blake2bUnkeyed,
  constantTimeEqual,
  CryptoOpenError,
  emailLookupHash,
  open,
  openString,
  randomBytes,
  seal,
  sealString,
} from './crypto-stub';
import { bootAuthTestEnv } from './test-setup';

beforeAll(async () => {
  await bootAuthTestEnv();
});

describe('seal / open', () => {
  it('round-trips arbitrary bytes', () => {
    const pt = new Uint8Array([1, 2, 3, 4, 5, 0xff, 0x00]);
    const sealed = seal(pt);
    // version byte (1) + nonce (24) + ct (pt.length + 16 MAC) = 48
    expect(sealed.length).toBe(1 + 24 + pt.length + 16);
    // Production wire format under @jhsc/crypto delegation
    // (ADR-0002 — XChaCha20-Poly1305). The 1.2 v=0x01 stub still
    // reads on `open()` but new writes are v=0x02.
    expect(sealed[0]).toBe(0x02);
    expect(open(sealed)).toEqual(pt);
  });

  it('round-trips UTF-8 strings via sealString / openString', () => {
    const s = 'hello — ‘élève’ 🔒';
    expect(openString(sealString(s))).toBe(s);
  });

  it('produces different ciphertexts for the same plaintext (random nonce)', () => {
    const pt = new Uint8Array([1, 2, 3]);
    const a = seal(pt);
    const b = seal(pt);
    expect(a).not.toEqual(b);
    // Both still open to the same plaintext.
    expect(open(a)).toEqual(pt);
    expect(open(b)).toEqual(pt);
  });

  it('rejects a tampered ciphertext byte', () => {
    const pt = new Uint8Array([1, 2, 3, 4]);
    const sealed = seal(pt);
    // Flip a bit inside the ciphertext body.
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x01;
    expect(() => open(sealed)).toThrow(CryptoOpenError);
  });

  it('rejects a tampered nonce byte', () => {
    const pt = new Uint8Array([9, 9, 9]);
    const sealed = seal(pt);
    sealed[5] = (sealed[5] ?? 0) ^ 0x80;
    expect(() => open(sealed)).toThrow(CryptoOpenError);
  });

  it('rejects an unknown version byte', () => {
    const pt = new Uint8Array([0x01]);
    const sealed = seal(pt);
    sealed[0] = 0x99; // 0x01 and 0x02 are both real now — pick something else
    expect(() => open(sealed)).toThrow(/unsupported_version/);
  });

  it('rejects truncated input', () => {
    expect(() => open(new Uint8Array([0x02, 0x00]))).toThrow(/too_short/);
  });
});

describe('blake2b', () => {
  it('keyed hash is deterministic', () => {
    const key = new Uint8Array(32).fill(7);
    const a = blake2bKeyed(new TextEncoder().encode('hello'), key);
    const b = blake2bKeyed(new TextEncoder().encode('hello'), key);
    expect(a).toEqual(b);
  });

  it('keyed hash depends on the key', () => {
    const k1 = new Uint8Array(32).fill(1);
    const k2 = new Uint8Array(32).fill(2);
    const a = blake2bKeyed(new TextEncoder().encode('x'), k1);
    const b = blake2bKeyed(new TextEncoder().encode('x'), k2);
    expect(a).not.toEqual(b);
  });

  it('unkeyed hash is deterministic and 32 bytes by default', () => {
    const h = blake2bUnkeyed(new TextEncoder().encode('hi'));
    expect(h.length).toBe(32);
    expect(blake2bUnkeyed(new TextEncoder().encode('hi'))).toEqual(h);
  });

  it('emailLookupHash binds to the master key', () => {
    const a = emailLookupHash('alice@workplace.invalid');
    const b = emailLookupHash('alice@workplace.invalid');
    expect(a).toEqual(b);
    // Different email produces a different hash.
    expect(emailLookupHash('bob@workplace.invalid')).not.toEqual(a);
  });
});

describe('randomBytes / constantTimeEqual', () => {
  it('randomBytes returns the requested length', () => {
    expect(randomBytes(7).length).toBe(7);
    expect(randomBytes(0).length).toBe(0);
  });

  it('two random samples are unequal (overwhelming probability)', () => {
    expect(randomBytes(16)).not.toEqual(randomBytes(16));
  });

  it('constantTimeEqual rejects different lengths', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('constantTimeEqual accepts equal bytes', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it('constantTimeEqual rejects single-byte differences', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});
