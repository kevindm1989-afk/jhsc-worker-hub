// Crypto stub for Milestone 1.2 (ADR-0001).
//
// This file is a deliberate, temporary bridge: it provides authenticated
// symmetric encryption for sensitive auth-surface fields (user email,
// display name, TOTP secret) BEFORE `packages/crypto` lands in 1.3.
//
// Wire format: version_byte || nonce || ciphertext_with_mac.
//   - version_byte = 0x01 — recognized by 1.3's real packages/crypto so
//     it can migrate on read.
//   - nonce = crypto_secretbox_NONCEBYTES (24 bytes for XSalsa20-Poly1305).
//   - ciphertext_with_mac = crypto_secretbox_easy(plaintext, nonce, key).
//
// CLAUDE.md and SECURITY.md §3 lock the production algorithm as
// XChaCha20-Poly1305. crypto_secretbox is XSalsa20-Poly1305 — same
// security level (256-bit, AEAD-equivalent via Poly1305), short of
// XChaCha20's extended-nonce. The version byte makes the 1.3 migration
// a 1-byte sniff, not a schema change.
//
// All keys are 32 raw bytes (libsodium `crypto_secretbox_KEYBYTES`).

import sodium from 'libsodium-wrappers';
import { requireAuthEnv } from '../env';

let ready = false;

export async function initCrypto(): Promise<void> {
  if (ready) return;
  await sodium.ready;
  ready = true;
}

function assertReady(): void {
  if (!ready) {
    throw new Error(
      'crypto-stub used before initCrypto(); call await initCrypto() during app boot',
    );
  }
}

const VERSION_STUB = 0x01;

let masterKeyCache: Uint8Array | null = null;

export function getMasterKey(): Uint8Array {
  if (masterKeyCache) return masterKeyCache;
  const env = requireAuthEnv();
  assertReady();
  const decoded = sodium.from_base64(env.MASTER_KEY, sodium.base64_variants.ORIGINAL);
  if (decoded.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `MASTER_KEY decodes to ${decoded.length} bytes; expected ${sodium.crypto_secretbox_KEYBYTES}`,
    );
  }
  masterKeyCache = decoded;
  return decoded;
}

// Test-only escape hatch — lets unit tests pin a fixed key without
// touching process.env. Production code MUST go through getMasterKey().
export function _setMasterKeyForTests(raw: Uint8Array): void {
  assertReady();
  if (raw.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `test master key length ${raw.length}; expected ${sodium.crypto_secretbox_KEYBYTES}`,
    );
  }
  masterKeyCache = raw;
}

export function seal(plaintext: Uint8Array, keyOverride?: Uint8Array): Uint8Array {
  assertReady();
  const key = keyOverride ?? getMasterKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  const out = new Uint8Array(1 + nonce.length + ct.length);
  out[0] = VERSION_STUB;
  out.set(nonce, 1);
  out.set(ct, 1 + nonce.length);
  return out;
}

export class CryptoOpenError extends Error {
  constructor(reason: string) {
    super(`crypto-stub: ${reason}`);
    this.name = 'CryptoOpenError';
  }
}

export function open(sealed: Uint8Array, keyOverride?: Uint8Array): Uint8Array {
  assertReady();
  if (sealed.length < 1 + sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
    throw new CryptoOpenError('sealed bytes too short');
  }
  const version = sealed[0];
  if (version !== VERSION_STUB) {
    throw new CryptoOpenError(`unsupported version byte 0x${version?.toString(16)}`);
  }
  const nonce = sealed.subarray(1, 1 + sodium.crypto_secretbox_NONCEBYTES);
  const ct = sealed.subarray(1 + sodium.crypto_secretbox_NONCEBYTES);
  const key = keyOverride ?? getMasterKey();
  try {
    return sodium.crypto_secretbox_open_easy(ct, nonce, key);
  } catch {
    throw new CryptoOpenError('MAC verification failed');
  }
}

// String helpers — the common case in this codebase.
export function sealString(plaintext: string, keyOverride?: Uint8Array): Uint8Array {
  return seal(new TextEncoder().encode(plaintext), keyOverride);
}

export function openString(sealed: Uint8Array, keyOverride?: Uint8Array): string {
  return new TextDecoder().decode(open(sealed, keyOverride));
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

// Pseudonymized email lookup hash — keyed with the master key so a DB
// leak does not enable offline email enumeration.
export function emailLookupHash(emailLowercased: string): Uint8Array {
  const key = getMasterKey();
  return blake2bKeyed(new TextEncoder().encode(emailLowercased), key);
}

export function blake2bUnkeyed(
  input: Uint8Array,
  outLen: number = BLAKE2B_DEFAULT_LEN,
): Uint8Array {
  assertReady();
  return sodium.crypto_generichash(outLen, input);
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
// Argon2id password hashing (delegated to libsodium crypto_pwhash_str)
// ---------------------------------------------------------------------------

// SECURITY.md §3 — 64 MB memory, 3 ops.
const PWHASH_OPSLIMIT = 3;
const PWHASH_MEMLIMIT = 64 * 1024 * 1024;

export async function pwhashStr(password: string): Promise<string> {
  assertReady();
  // libsodium-wrappers's crypto_pwhash_str does not block the event
  // loop catastrophically at these params (~50 ms per hash on commodity
  // hardware). Acceptable for a single-tenant login surface. If profiling
  // ever shows otherwise, move to a worker thread.
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

// crypto_pwhash_str_needs_rehash returns true when the algorithm
// parameters in the stored hash are weaker than the current targets —
// triggers a re-hash on the next successful verify.
export function pwhashStrNeedsRehash(hash: string): boolean {
  assertReady();
  return sodium.crypto_pwhash_str_needs_rehash(hash, PWHASH_OPSLIMIT, PWHASH_MEMLIMIT);
}

// ---------------------------------------------------------------------------
// Reset helpers — test fixtures only.
// ---------------------------------------------------------------------------

export function _resetForTests(): void {
  masterKeyCache = null;
}
