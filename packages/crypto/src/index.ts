// @jhsc/crypto — production wire-format + envelope helpers.
//
// Wire format (ADR-0002):
//   v=0x02 || nonce(24) || ciphertext_with_mac     XChaCha20-Poly1305 (writer)
//   v=0x01 || nonce(24) || ciphertext_with_mac     XSalsa20-Poly1305 (legacy read)
//
// Callers pass keys explicitly through a KeyProvider. No process.env
// reads inside this package — keeps the surface unit-testable and
// reusable from the ai-proxy worker (Milestone 3.2).
//
// Argon2id wrappers + BLAKE2b helpers preserved at parity with the
// 1.2 crypto-stub so the apps/api shim is a one-line re-export.

import sodium from 'libsodium-wrappers-sumo';

// ---------------------------------------------------------------------------
// Wire-format constants
// ---------------------------------------------------------------------------

export const VERSION_LEGACY = 0x01 as const;
export const VERSION_CURRENT = 0x02 as const;
export type WireVersion = typeof VERSION_LEGACY | typeof VERSION_CURRENT;

export const KEY_BYTES = 32;
export const NONCE_BYTES_V2 = 24; // crypto_aead_xchacha20poly1305_ietf_npubbytes
export const NONCE_BYTES_V1 = 24; // crypto_secretbox_NONCEBYTES (XSalsa20)
export const MAC_BYTES_V2 = 16;
export const MAC_BYTES_V1 = 16; // crypto_secretbox_MACBYTES

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let ready = false;

export async function initCrypto(): Promise<void> {
  if (ready) return;
  await sodium.ready;
  ready = true;
}

function assertReady(): void {
  if (!ready) {
    throw new Error('@jhsc/crypto used before initCrypto(); call await initCrypto() at boot');
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CryptoOpenReason =
  | 'too_short'
  | 'unsupported_version'
  | 'mac_failed'
  | 'invalid_key_length';

export class CryptoOpenError extends Error {
  readonly reason: CryptoOpenReason;
  constructor(reason: CryptoOpenReason, detail?: string) {
    super(detail ? `@jhsc/crypto: ${reason} (${detail})` : `@jhsc/crypto: ${reason}`);
    this.name = 'CryptoOpenError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// seal / open / rewrap
// ---------------------------------------------------------------------------

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new CryptoOpenError('invalid_key_length', `${key.length}`);
  }
}

/**
 * Seal a plaintext under `key`. Writes the production wire format
 * (v=0x02, XChaCha20-Poly1305).
 */
export function seal(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  assertReady();
  checkKey(key);
  const nonce = sodium.randombytes_buf(NONCE_BYTES_V2);
  // additional data (ad) is empty by design — the wire format prefix
  // bytes are implicit context, not chosen-ad
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, key);
  const out = new Uint8Array(1 + nonce.length + ct.length);
  out[0] = VERSION_CURRENT;
  out.set(nonce, 1);
  out.set(ct, 1 + nonce.length);
  return out;
}

/**
 * Open a sealed blob. Accepts both v=0x02 (XChaCha20-Poly1305) and
 * v=0x01 (XSalsa20-Poly1305, the 1.2 stub format). Throws
 * CryptoOpenError on every failure mode — never returns garbage.
 */
export function open(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  assertReady();
  checkKey(key);
  if (sealed.length < 1) {
    throw new CryptoOpenError('too_short');
  }
  const version = sealed[0] as number;
  if (version === VERSION_CURRENT) {
    if (sealed.length < 1 + NONCE_BYTES_V2 + MAC_BYTES_V2) {
      throw new CryptoOpenError('too_short');
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES_V2);
    const ct = sealed.subarray(1 + NONCE_BYTES_V2);
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
    } catch {
      throw new CryptoOpenError('mac_failed');
    }
  }
  if (version === VERSION_LEGACY) {
    if (sealed.length < 1 + NONCE_BYTES_V1 + MAC_BYTES_V1) {
      throw new CryptoOpenError('too_short');
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES_V1);
    const ct = sealed.subarray(1 + NONCE_BYTES_V1);
    try {
      return sodium.crypto_secretbox_open_easy(ct, nonce, key);
    } catch {
      throw new CryptoOpenError('mac_failed');
    }
  }
  throw new CryptoOpenError('unsupported_version', `0x${version.toString(16).padStart(2, '0')}`);
}

/**
 * Open a v=0x01 blob and re-seal as v=0x02. Returns the new blob.
 * Caller is responsible for the UPDATE that swaps the column.
 *
 * Idempotent: a v=0x02 input is opened and resealed under a fresh
 * nonce, which is still useful (it advances the per-row nonce
 * without changing the key) — but the common case is the lazy-
 * migration path documented in ADR-0002.
 */
export function rewrap(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  const plaintext = open(sealed, key);
  return seal(plaintext, key);
}

export function wireVersion(sealed: Uint8Array): WireVersion {
  if (sealed.length < 1) throw new CryptoOpenError('too_short');
  const v = sealed[0];
  if (v !== VERSION_CURRENT && v !== VERSION_LEGACY) {
    throw new CryptoOpenError(
      'unsupported_version',
      `0x${(v as number).toString(16).padStart(2, '0')}`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

export function sealString(plaintext: string, key: Uint8Array): Uint8Array {
  return seal(new TextEncoder().encode(plaintext), key);
}

export function openString(sealed: Uint8Array, key: Uint8Array): string {
  return new TextDecoder().decode(open(sealed, key));
}

// ---------------------------------------------------------------------------
// Envelope encryption (heavyweight tables — 1.5+)
// ---------------------------------------------------------------------------

export interface EnvelopeRecord {
  /** Sealed plaintext under a per-record DEK. */
  readonly ciphertext: Uint8Array;
  /** Sealed DEK under the workplace KEK. */
  readonly dekSealed: Uint8Array;
}

export function sealWithEnvelope(plaintext: Uint8Array, kek: Uint8Array): EnvelopeRecord {
  assertReady();
  checkKey(kek);
  const dek = sodium.randombytes_buf(KEY_BYTES);
  const ciphertext = seal(plaintext, dek);
  const dekSealed = seal(dek, kek);
  // wipe the DEK after use — best-effort; the GC will reclaim it
  // eventually but explicit zeroing reduces the heap-disclosure window
  sodium.memzero(dek);
  return { ciphertext, dekSealed };
}

export function openWithEnvelope(record: EnvelopeRecord, kek: Uint8Array): Uint8Array {
  assertReady();
  checkKey(kek);
  const dek = open(record.dekSealed, kek);
  try {
    return open(record.ciphertext, dek);
  } finally {
    sodium.memzero(dek);
  }
}

/** Re-seal only the DEK under a new KEK — for KEK rotation without touching ciphertexts. */
export function rewrapEnvelopeDek(
  record: EnvelopeRecord,
  oldKek: Uint8Array,
  newKek: Uint8Array,
): Uint8Array {
  assertReady();
  checkKey(oldKek);
  checkKey(newKek);
  const dek = open(record.dekSealed, oldKek);
  try {
    return seal(dek, newKek);
  } finally {
    sodium.memzero(dek);
  }
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

const BLAKE2B_DEFAULT_LEN = 32;

export function blake2bKeyed(
  input: Uint8Array,
  key: Uint8Array,
  outLen: number = BLAKE2B_DEFAULT_LEN,
): Uint8Array {
  assertReady();
  return sodium.crypto_generichash(outLen, input, key);
}

export function blake2bUnkeyed(
  input: Uint8Array,
  outLen: number = BLAKE2B_DEFAULT_LEN,
): Uint8Array {
  assertReady();
  return sodium.crypto_generichash(outLen, input);
}

/**
 * Domain-agnostic keyed lookup hash. Used by the auth surface for
 * email-lookup pseudonymization, and by future modules for any
 * leak-resistant indexed lookup pattern.
 */
export function keyedLookupHash(input: string | Uint8Array, key: Uint8Array): Uint8Array {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return blake2bKeyed(bytes, key);
}

// ---------------------------------------------------------------------------
// Random + constant-time compare
// ---------------------------------------------------------------------------

export function randomBytes(n: number): Uint8Array {
  assertReady();
  return sodium.randombytes_buf(n);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  assertReady();
  if (a.length !== b.length) return false;
  return sodium.memcmp(a, b);
}

// ---------------------------------------------------------------------------
// Argon2id password hashing (SECURITY.md §3 params: 64 MB / 3 ops)
// ---------------------------------------------------------------------------

export const PWHASH_OPSLIMIT = 3;
export const PWHASH_MEMLIMIT = 64 * 1024 * 1024;

export async function pwhashStr(password: string): Promise<string> {
  assertReady();
  return sodium.crypto_pwhash_str(password, PWHASH_OPSLIMIT, PWHASH_MEMLIMIT);
}

export async function pwhashStrVerify(hash: string, password: string): Promise<boolean> {
  assertReady();
  try {
    return sodium.crypto_pwhash_str_verify(hash, password);
  } catch {
    return false;
  }
}

export function pwhashStrNeedsRehash(hash: string): boolean {
  assertReady();
  return sodium.crypto_pwhash_str_needs_rehash(hash, PWHASH_OPSLIMIT, PWHASH_MEMLIMIT);
}

// ---------------------------------------------------------------------------
// KeyProvider — DI abstraction for KEK/MASTER_KEY resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the workplace KEK on demand. Implementations decide where
 * the bytes come from (Fly Secrets via process.env, a Vault sidecar,
 * a test fixture). The bytes returned must satisfy KEY_BYTES.
 */
export interface KeyProvider {
  /** Returns the workplace KEK (`MASTER_KEY`). 32 bytes. */
  getKek(): Uint8Array;
}

/** Adapter — wrap a Uint8Array as a KeyProvider. Tests + scripts use this. */
export function staticKeyProvider(kek: Uint8Array): KeyProvider {
  return { getKek: () => kek };
}
