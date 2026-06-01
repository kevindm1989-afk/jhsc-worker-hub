// Browser-side sealed-box encryption for evidence files (ADR-0006).
//
// Per-file DEK generated via Web Crypto's getRandomValues. File
// encrypted with XChaCha20-Poly1305 (matches @jhsc/crypto's v=0x02
// wire format: 1 version byte + 24-byte nonce + ciphertext+tag). DEK
// sealed with the workplace public key via libsodium's crypto_box_seal
// — anonymous sender, recipient-only open.
//
// The browser NEVER holds a key that can decrypt. The workplace
// private key stays sealed under the KEK on the server side and is
// only opened inside the API's /api/evidence/:id/decrypt handler.

import sodium from 'libsodium-wrappers';

let sodiumReady: Promise<void> | null = null;
async function ready(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready;
  await sodiumReady;
}

const WIRE_VERSION = 0x02;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export interface SealedEvidence {
  /** XChaCha20-Poly1305 ciphertext (v=0x02 wire format). */
  readonly ciphertext: Uint8Array;
  /** Per-file DEK sealed for the workplace public key. */
  readonly sealedDek: Uint8Array;
  /** Hex SHA-256 of `ciphertext`. */
  readonly ciphertextSha256: string;
  /** Hex SHA-256 of the original plaintext. */
  readonly plaintextSha256: string;
}

/**
 * Encrypt a file/blob for upload to Tigris.
 *
 * `workplacePublicKey` is the X25519 public key shipped by
 * GET /api/auth/session (base64-decoded by the caller).
 */
export async function sealEvidence(
  plaintext: Uint8Array,
  workplacePublicKey: Uint8Array,
): Promise<SealedEvidence> {
  await ready();
  if (workplacePublicKey.length !== KEY_BYTES) {
    throw new Error(`workplacePublicKey must be ${KEY_BYTES} bytes`);
  }
  // Per-file DEK. Web Crypto's getRandomValues is required by spec to
  // be cryptographically secure. libsodium's randombytes_buf is also
  // fine but adds an awaited path; getRandomValues is sync.
  const dek = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(dek);

  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);

  // libsodium-wrappers checks input identity via `instanceof Uint8Array`.
  // Inputs from TextEncoder().encode() / fetch().arrayBuffer() are
  // sometimes typed as Uint8Array<ArrayBufferLike> which the check
  // misclassifies in jsdom. A `new Uint8Array(...)` re-wrap normalizes
  // the buffer reference without copying for the common case.
  const plaintextForSodium =
    plaintext instanceof Uint8Array && plaintext.constructor === Uint8Array
      ? plaintext
      : new Uint8Array(plaintext);
  const body = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintextForSodium,
    null,
    null,
    nonce,
    dek,
  );
  // v=0x02 wire format: 1 byte version || 24 bytes nonce || ciphertext.
  const ciphertext = new Uint8Array(1 + nonce.length + body.length);
  ciphertext[0] = WIRE_VERSION;
  ciphertext.set(nonce, 1);
  ciphertext.set(body, 1 + nonce.length);

  // Seal the DEK with the workplace public key.
  const sealedDek = sodium.crypto_box_seal(dek, workplacePublicKey);
  // Best-effort zero the in-process DEK.
  sodium.memzero(dek);

  const [plaintextSha256, ciphertextSha256] = await Promise.all([
    sha256Hex(plaintext),
    sha256Hex(ciphertext),
  ]);

  return { ciphertext, sealedDek, ciphertextSha256, plaintextSha256 };
}

/** Hex SHA-256 of a Uint8Array using Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Detach the libsodium-owned buffer into a plain ArrayBuffer so the
  // TS lib types accept it as BufferSource (SharedArrayBuffer is not
  // assignable to ArrayBuffer in newer @types/dom).
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const buf = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
