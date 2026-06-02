// Browser-side envelope encryption for the Excel-import action_item
// fields (Milestone 1.11 S3, ADR-0010 §3.5 / §3.10).
//
// Per CLAUDE.md non-negotiable #11 + the ADR contract: every sensitive
// action_item column (description, recommended_action, raised_by_text,
// follow_up_owner_text) is envelope-encrypted in the browser BEFORE the
// payload reaches the API.
//
// Wire format mirrors apps/web/src/evidence/crypto.ts:sealEvidence:
//
//   ciphertext = v=0x02 (1 byte) || nonce (24 bytes) || ciphertext+tag
//                  encrypted under a per-field random DEK with
//                  XChaCha20-Poly1305 (libsodium AEAD).
//
//   sealedDek  = crypto_box_seal(DEK, workplacePublicKey)
//                  anonymous sender; only the workplace private key
//                  (held in Fly Secrets, never on this device) can open.
//
// The route handler base64-encodes both bytes before send; the server
// stores the raw bytes in `action_items.description_ct` /
// `description_dek_ct`. Future decryption goes through the workplace
// private key reveal path.
//
// NOTE: this is a SEPARATE envelope shape from `@jhsc/crypto`'s
// `sealWithEnvelope` (which uses the symmetric KEK for server-side
// seals). The browser can't see the KEK; it uses the workplace public
// key for sealed-box. Both shapes coexist in the system.

import sodium from 'libsodium-wrappers';

let sodiumReady: Promise<void> | null = null;
async function ready(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready;
  await sodiumReady;
}

const WIRE_VERSION = 0x02;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export interface SealedField {
  /** Base64 of `v=0x02 || nonce || ciphertext+tag` */
  readonly ctB64: string;
  /** Base64 of `crypto_box_seal(DEK, workplacePublicKey)` */
  readonly dekCtB64: string;
}

/**
 * Seal a single UTF-8 plaintext field for upload via the excel-imports
 * batch-items endpoint. Returns base64 strings ready to drop into the
 * request body.
 *
 * `workplacePublicKey` is the 32-byte X25519 public key shipped by
 * `GET /api/auth/session` (base64-decoded by the caller).
 */
export async function sealActionItemField(
  plaintext: string,
  workplacePublicKey: Uint8Array,
): Promise<SealedField> {
  await ready();
  if (workplacePublicKey.length !== KEY_BYTES) {
    throw new Error(`workplacePublicKey must be ${KEY_BYTES} bytes`);
  }
  const dek = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(dek);
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);

  // libsodium-wrappers checks input identity via `instanceof Uint8Array`.
  // The TextEncoder().encode result is a Uint8Array<ArrayBufferLike> which
  // can fail the check in jsdom; re-wrap to normalize without copying.
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const plaintextForSodium =
    plaintextBytes instanceof Uint8Array && plaintextBytes.constructor === Uint8Array
      ? plaintextBytes
      : new Uint8Array(plaintextBytes);
  const body = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintextForSodium,
    null,
    null,
    nonce,
    dek,
  );
  // v=0x02 wire format: 1 byte version || 24 bytes nonce || ciphertext.
  const ct = new Uint8Array(1 + nonce.length + body.length);
  ct[0] = WIRE_VERSION;
  ct.set(nonce, 1);
  ct.set(body, 1 + nonce.length);

  const dekCt = sodium.crypto_box_seal(dek, workplacePublicKey);
  // Best-effort zero the DEK; GC will reclaim eventually.
  sodium.memzero(dek);

  return {
    ctB64: bytesToB64(ct),
    dekCtB64: bytesToB64(dekCt),
  };
}

/**
 * Seal an optional plaintext — returns null on empty / null / undefined
 * input. Used for the recommendedAction / raisedBy / followUpOwner
 * fields which are nullable on action_items.
 */
export async function sealOptionalActionItemField(
  plaintext: string | null | undefined,
  workplacePublicKey: Uint8Array,
): Promise<SealedField | null> {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return sealActionItemField(plaintext, workplacePublicKey);
}

// ---------------------------------------------------------------------------
// SHA-256 of an ArrayBuffer (used by the upload flow for the source-
// file integrity anchor that pins the chain payload).
// ---------------------------------------------------------------------------

/**
 * Hex SHA-256 of an ArrayBuffer, using Web Crypto. Used by the upload
 * step to compute `source_sha256` BEFORE handing the buffer to the
 * worker. The worker computes its own hash too; the two must match —
 * the route handler accepts whichever; the chain payload pins the
 * value the route received.
 */
export async function sha256HexOfArrayBuffer(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// base64 helpers (DOM-safe, no Node Buffer dependency)
// ---------------------------------------------------------------------------

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
