// apps/api/src/auth/crypto-stub.ts
//
// Milestone 1.3: this file is a thin shim that re-exports the production
// surface from `@jhsc/crypto`. The historical name lives on for the
// transition window — every internal caller continues to `import from
// '../auth/crypto-stub'` while we migrate import paths over a follow-up
// commit. New code should import directly from `@jhsc/crypto`.
//
// The 1.2 `0x01` wire format (XSalsa20-Poly1305) is still readable —
// `@jhsc/crypto`'s open() accepts it and rewrap() migrates it forward.
// New writes go out as `0x02` (XChaCha20-Poly1305) per ADR-0002.

import {
  CryptoOpenError,
  blake2bKeyed as cryptoBlake2bKeyed,
  blake2bUnkeyed as cryptoBlake2bUnkeyed,
  constantTimeEqual as cryptoConstantTimeEqual,
  initCrypto as cryptoInit,
  keyedLookupHash,
  open as cryptoOpen,
  openString as cryptoOpenString,
  pwhashStr as cryptoPwhashStr,
  pwhashStrNeedsRehash as cryptoPwhashStrNeedsRehash,
  pwhashStrVerify as cryptoPwhashStrVerify,
  randomBytes as cryptoRandomBytes,
  seal as cryptoSeal,
  sealString as cryptoSealString,
  KEY_BYTES,
} from '@jhsc/crypto';
import sodium from 'libsodium-wrappers-sumo';
import { requireAuthEnv } from '../env';

export { CryptoOpenError };

export async function initCrypto(): Promise<void> {
  await cryptoInit();
}

// ---------------------------------------------------------------------------
// Master-key resolution — process-env-backed singleton.
// ---------------------------------------------------------------------------

let masterKeyCache: Uint8Array | null = null;

export function getMasterKey(): Uint8Array {
  if (masterKeyCache) return masterKeyCache;
  const env = requireAuthEnv();
  const decoded = sodium.from_base64(env.MASTER_KEY, sodium.base64_variants.ORIGINAL);
  if (decoded.length !== KEY_BYTES) {
    throw new Error(`MASTER_KEY decodes to ${decoded.length} bytes; expected ${KEY_BYTES}`);
  }
  masterKeyCache = decoded;
  return decoded;
}

export function _setMasterKeyForTests(raw: Uint8Array): void {
  if (raw.length !== KEY_BYTES) {
    throw new Error(`test master key length ${raw.length}; expected ${KEY_BYTES}`);
  }
  masterKeyCache = raw;
}

export function _resetForTests(): void {
  masterKeyCache = null;
}

// ---------------------------------------------------------------------------
// Seal / open — thin wrappers that default to the master key.
// ---------------------------------------------------------------------------

export function seal(plaintext: Uint8Array, keyOverride?: Uint8Array): Uint8Array {
  return cryptoSeal(plaintext, keyOverride ?? getMasterKey());
}

export function open(sealed: Uint8Array, keyOverride?: Uint8Array): Uint8Array {
  return cryptoOpen(sealed, keyOverride ?? getMasterKey());
}

export function sealString(plaintext: string, keyOverride?: Uint8Array): Uint8Array {
  return cryptoSealString(plaintext, keyOverride ?? getMasterKey());
}

export function openString(sealed: Uint8Array, keyOverride?: Uint8Array): string {
  return cryptoOpenString(sealed, keyOverride ?? getMasterKey());
}

// ---------------------------------------------------------------------------
// Hash helpers — defaulting to the master key.
// ---------------------------------------------------------------------------

export function blake2bKeyed(input: Uint8Array, key: Uint8Array, outLen?: number): Uint8Array {
  return cryptoBlake2bKeyed(input, key, outLen);
}

export function blake2bUnkeyed(input: Uint8Array, outLen?: number): Uint8Array {
  return cryptoBlake2bUnkeyed(input, outLen);
}

export function emailLookupHash(emailLowercased: string): Uint8Array {
  return keyedLookupHash(emailLowercased, getMasterKey());
}

// ---------------------------------------------------------------------------
// Random + constant-time compare.
// ---------------------------------------------------------------------------

export function randomBytes(n: number): Uint8Array {
  return cryptoRandomBytes(n);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return cryptoConstantTimeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Argon2id.
// ---------------------------------------------------------------------------

export async function pwhashStr(password: string): Promise<string> {
  return cryptoPwhashStr(password);
}

export async function pwhashStrVerify(hash: string, password: string): Promise<boolean> {
  return cryptoPwhashStrVerify(hash, password);
}

export function pwhashStrNeedsRehash(hash: string): boolean {
  return cryptoPwhashStrNeedsRehash(hash);
}
