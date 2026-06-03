// Sealed-box wrappers for Excel-import sensitive fields.
//
// Milestone 1.11 S5 sec-F1 + sec-F2 + priv-F1 + priv-F2 + priv-F6
// close-outs. Per CLAUDE.md non-negotiable #11 + ADR-0010 §3, the source
// filename, the Inspection Review snapshot, and the Meeting metadata
// blob are all sealed-box-encrypted in the BROWSER before any API call.
//
// The wire format is the same v=0x02 envelope shape used by 1.7
// evidence (apps/web/src/evidence/crypto.ts:sealEvidence) and the
// per-row action_item fields (apps/web/src/excel-imports/crypto.ts:
// sealActionItemField):
//
//   ciphertext = v=0x02 (1 byte) || nonce (24 bytes) || ciphertext+tag
//                  encrypted under a per-field random DEK with
//                  XChaCha20-Poly1305 (libsodium AEAD).
//
//   sealedDek  = crypto_box_seal(DEK, workplacePublicKey)
//                  anonymous sender; only the workplace private key
//                  (held in Fly Secrets under the master KEK, never on
//                  this device) can open.
//
// The DEK is generated per field via crypto.getRandomValues, encrypted
// with XChaCha20-Poly1305, then sealed with the workplace public key
// via libsodium's crypto_box_seal (anonymous sender). The browser never
// holds a key that can decrypt later; only the server (after opening
// the workplace private key via the workplace KEK) can decrypt.
//
// IMPORTANT: this module is browser-only by design. It depends on
// libsodium-wrappers + Web Crypto's getRandomValues. The api/server
// has its own opener (apps/api/src/excel-imports/crypto.ts:
// openExcelImportField) that runs against the workplace KEK.

import sodium from 'libsodium-wrappers';

let sodiumReady: Promise<void> | null = null;
async function ready(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready;
  await sodiumReady;
}

const WIRE_VERSION = 0x02;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export interface SealedExcelField {
  /** `v=0x02 || nonce || ciphertext+tag`, encrypted under a per-field DEK. */
  readonly ciphertext: Uint8Array;
  /** `crypto_box_seal(DEK, workplacePublicKey)`. */
  readonly sealedDek: Uint8Array;
}

/**
 * Seal a UTF-8 plaintext string for upload via the excel-imports
 * routes. The browser generates a per-field 32-byte DEK, encrypts the
 * plaintext with XChaCha20-Poly1305, then seals the DEK with the
 * workplace public key via libsodium's crypto_box_seal.
 *
 * `workplacePublicKey` is the 32-byte X25519 public key shipped by
 * `GET /api/auth/session` (base64-decoded by the caller).
 *
 * Returns the raw bytes; the caller base64-encodes for transit.
 *
 * Pure-ish: deterministic on (plaintext, workplacePublicKey) modulo
 * the random DEK + nonce. Same input does NOT produce the same output
 * because the DEK is freshly random per call (T-X33 rotation race is
 * the caller's concern — the runbook documents the workplace-key-
 * rotation-during-preview surface).
 */
export async function sealStringForWorkplaceKey(
  plaintext: string,
  workplacePublicKey: Uint8Array,
): Promise<SealedExcelField> {
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

  const ciphertext = new Uint8Array(1 + nonce.length + body.length);
  ciphertext[0] = WIRE_VERSION;
  ciphertext.set(nonce, 1);
  ciphertext.set(body, 1 + nonce.length);

  const sealedDek = sodium.crypto_box_seal(dek, workplacePublicKey);
  // Best-effort zero the DEK; GC will reclaim eventually.
  sodium.memzero(dek);

  return { ciphertext, sealedDek };
}

/**
 * Canonical-JSON-stringify a value for stable hashing / sealing. Object
 * keys are sorted recursively so the produced bytes are deterministic
 * across runtimes (matches the api's `canonicalJson` helper).
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return v;
  });
}
