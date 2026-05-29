import { beforeAll, describe, expect, it } from 'vitest';
import {
  blake2bKeyed,
  blake2bUnkeyed,
  constantTimeEqual,
  CryptoOpenError,
  initCrypto,
  KEY_BYTES,
  keyedLookupHash,
  open,
  openString,
  openWithEnvelope,
  randomBytes,
  rewrap,
  rewrapEnvelopeDek,
  seal,
  sealString,
  sealWithEnvelope,
  VERSION_CURRENT,
  VERSION_LEGACY,
  wireVersion,
} from './index';
import sodiumDefault from 'libsodium-wrappers-sumo';
import type sodiumType from 'libsodium-wrappers-sumo';
const sodium = sodiumDefault as typeof sodiumType;

beforeAll(async () => {
  await initCrypto();
});

const KEK = new Uint8Array(KEY_BYTES).fill(0x42);
const KEK2 = new Uint8Array(KEY_BYTES).fill(0x77);

describe('seal / open (v=0x02)', () => {
  it('round-trips arbitrary bytes', () => {
    const pt = new Uint8Array([1, 2, 3, 0xff, 0x00, 0xaa, 0x55]);
    const sealed = seal(pt, KEK);
    expect(sealed[0]).toBe(VERSION_CURRENT);
    expect(open(sealed, KEK)).toEqual(pt);
  });

  it('round-trips UTF-8 strings via sealString / openString', () => {
    const s = 'JHSC — élève — 🔒';
    expect(openString(sealString(s, KEK), KEK)).toBe(s);
  });

  it('produces different ciphertexts for the same plaintext (random nonce)', () => {
    const pt = new Uint8Array([1, 2, 3]);
    const a = seal(pt, KEK);
    const b = seal(pt, KEK);
    expect(a).not.toEqual(b);
    expect(open(a, KEK)).toEqual(pt);
    expect(open(b, KEK)).toEqual(pt);
  });

  it('rejects tampered ciphertext (mac_failed)', () => {
    const pt = new Uint8Array([1, 2, 3, 4]);
    const sealed = seal(pt, KEK);
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x01;
    expect(() => open(sealed, KEK)).toThrow(CryptoOpenError);
    try {
      open(sealed, KEK);
    } catch (e) {
      expect((e as CryptoOpenError).reason).toBe('mac_failed');
    }
  });

  it('rejects wrong key (mac_failed)', () => {
    const sealed = seal(new Uint8Array([7, 7, 7]), KEK);
    expect(() => open(sealed, KEK2)).toThrow(/mac_failed/);
  });

  it('rejects unknown version byte', () => {
    const sealed = seal(new Uint8Array([1]), KEK);
    sealed[0] = 0x09;
    try {
      open(sealed, KEK);
      expect.fail('expected throw');
    } catch (e) {
      expect((e as CryptoOpenError).reason).toBe('unsupported_version');
    }
  });

  it('rejects truncated input', () => {
    try {
      open(new Uint8Array([0x02, 0x00]), KEK);
      expect.fail('expected throw');
    } catch (e) {
      expect((e as CryptoOpenError).reason).toBe('too_short');
    }
  });

  it('rejects wrong-length key', () => {
    expect(() => seal(new Uint8Array([1]), new Uint8Array(16))).toThrow(/invalid_key_length/);
  });
});

describe('backward compatibility — v=0x01 (XSalsa20-Poly1305, 1.2 stub)', () => {
  function craftV1(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(plaintext, nonce, key);
    const out = new Uint8Array(1 + nonce.length + ct.length);
    out[0] = VERSION_LEGACY;
    out.set(nonce, 1);
    out.set(ct, 1 + nonce.length);
    return out;
  }

  it('opens a v=0x01 blob produced by the 1.2 wire format', () => {
    const pt = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const v1 = craftV1(pt, KEK);
    expect(open(v1, KEK)).toEqual(pt);
  });

  it('rewrap converts v=0x01 to v=0x02 under the same key', () => {
    const pt = new TextEncoder().encode('migrate me');
    const v1 = craftV1(pt, KEK);
    const v2 = rewrap(v1, KEK);
    expect(v2[0]).toBe(VERSION_CURRENT);
    expect(open(v2, KEK)).toEqual(pt);
  });
});

describe('wireVersion', () => {
  it('reports 0x02 for fresh writes', () => {
    expect(wireVersion(seal(new Uint8Array([1]), KEK))).toBe(VERSION_CURRENT);
  });

  it('throws on unknown versions', () => {
    expect(() => wireVersion(new Uint8Array([0x99]))).toThrow(CryptoOpenError);
  });
});

describe('envelope encryption', () => {
  it('round-trips through DEK + KEK', () => {
    const pt = new TextEncoder().encode('witness statement body — keep encrypted');
    const env = sealWithEnvelope(pt, KEK);
    expect(env.ciphertext[0]).toBe(VERSION_CURRENT);
    expect(env.dekSealed[0]).toBe(VERSION_CURRENT);
    expect(openWithEnvelope(env, KEK)).toEqual(pt);
  });

  it('rewrap-DEK rotates the KEK without touching the ciphertext', () => {
    const pt = new TextEncoder().encode('rotate the kek');
    const env = sealWithEnvelope(pt, KEK);
    const newDekSealed = rewrapEnvelopeDek(env, KEK, KEK2);
    const rotated = { ciphertext: env.ciphertext, dekSealed: newDekSealed };
    expect(openWithEnvelope(rotated, KEK2)).toEqual(pt);
    // Old KEK no longer opens the rotated record.
    expect(() => openWithEnvelope(rotated, KEK)).toThrow(/mac_failed/);
  });
});

describe('hashes + helpers', () => {
  it('blake2bKeyed is deterministic and key-dependent', () => {
    const a = blake2bKeyed(new TextEncoder().encode('hi'), KEK);
    const b = blake2bKeyed(new TextEncoder().encode('hi'), KEK);
    expect(a).toEqual(b);
    expect(blake2bKeyed(new TextEncoder().encode('hi'), KEK2)).not.toEqual(a);
  });

  it('blake2bUnkeyed is 32 bytes by default', () => {
    expect(blake2bUnkeyed(new TextEncoder().encode('hi')).length).toBe(32);
  });

  it('keyedLookupHash accepts string and bytes equivalently', () => {
    const a = keyedLookupHash('alice@example.invalid', KEK);
    const b = keyedLookupHash(new TextEncoder().encode('alice@example.invalid'), KEK);
    expect(a).toEqual(b);
  });

  it('randomBytes returns the requested length', () => {
    expect(randomBytes(7).length).toBe(7);
  });

  it('constantTimeEqual', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
