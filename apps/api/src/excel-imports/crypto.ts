// Envelope helpers for the three sensitive excel_imports columns
// (ADR-0010 §3.8 + SECURITY T-X13 / T-X19 + the S5 sec-F1 / sec-F2 /
// priv-F1 / priv-F2 / priv-F6 close-outs):
//
//   - excel_imports.source_filename_ct — filename (T-X19 — filenames
//     frequently leak workplace identity).
//   - excel_imports.inspection_review_snapshot_ct — Inspection Review
//     JSONB snapshot (T-X13 — may carry supervisor + witness names).
//   - excel_imports.meeting_metadata_ct — Meeting metadata blob (S5
//     priv-F6 close-out — attendance carries meeting attendee names).
//
// S5 SHIFT: prior to S5 the route encrypted these fields server-side
// using the master KEK (sealWithEnvelope). Per CLAUDE.md non-negotiable
// #11 + ADR-0010 §3, the fields are now sealed-box-encrypted in the
// BROWSER before any API call, using the workplace public key. The
// server stores the raw bytes as-is and decrypts via the workplace
// private key (held under the master KEK, opened one-shot for each
// reveal — same pattern as 1.7 evidence decrypt at apps/api/src/
// routes/evidence/index.ts).
//
// The opener (openExcelImportField) is the only place the workplace
// private key briefly enters process memory; it zeros immediately
// after use.

import sodium from 'libsodium-wrappers-sumo';
import type { DrizzlePg } from '@jhsc/audit';
import { openWorkplacePrivateKey } from '../evidence/workplace-key';

const WIRE_VERSION = 0x02;
const NONCE_BYTES = 24;

export interface SealedExcelImportField {
  /** v=0x02 envelope ciphertext (sealed-box DEK encrypts; XChaCha20-Poly1305 body). */
  readonly ct: Uint8Array;
  /** crypto_box_seal(DEK, workplace_public_key). */
  readonly dekCt: Uint8Array;
}

/**
 * Open a sealed-box-encrypted excel-imports field back to its UTF-8
 * plaintext. The caller passes the workplace_key_id (from the active
 * workplace_keys row) so the function can open the private key once,
 * decrypt, then zero.
 *
 * Mirrors the 1.7 evidence decrypt path. The workplace private key
 * NEVER persists in memory beyond this function's stack.
 */
export async function openExcelImportField(
  db: DrizzlePg,
  workplaceKeyId: string,
  field: SealedExcelImportField,
): Promise<string> {
  await sodium.ready;
  const privateKey = await openWorkplacePrivateKey(db, workplaceKeyId);
  let dek: Uint8Array;
  try {
    const publicKey = sodium.crypto_scalarmult_base(privateKey);
    dek = sodium.crypto_box_seal_open(Uint8Array.from(field.dekCt), publicKey, privateKey);
  } finally {
    sodium.memzero(privateKey);
  }

  let plaintext: Uint8Array;
  try {
    // v=0x02 wire format: 1 byte version || 24 bytes nonce || ciphertext+tag.
    if (field.ct.length < 1 + NONCE_BYTES || field.ct[0] !== WIRE_VERSION) {
      throw new Error('unexpected excel-import ciphertext format');
    }
    const nonce = field.ct.slice(1, 1 + NONCE_BYTES);
    const body = field.ct.slice(1 + NONCE_BYTES);
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, null, nonce, dek);
  } finally {
    sodium.memzero(dek);
  }

  const out = new TextDecoder().decode(plaintext);
  // Best-effort zero of the plaintext byte buffer; the returned string
  // already lives in the V8 heap as an immutable copy.
  sodium.memzero(plaintext);
  return out;
}

/**
 * Open a nullable ciphertext pair; returns null when either column is
 * NULL on the DB row (e.g. the inspection_review_snapshot pair was
 * never populated because the workbook had no Inspection Review sheet).
 */
export async function openOptionalExcelImportField(
  db: DrizzlePg,
  workplaceKeyId: string,
  field: { ct: Uint8Array | null; dekCt: Uint8Array | null },
): Promise<string | null> {
  if (field.ct === null || field.dekCt === null) return null;
  return openExcelImportField(db, workplaceKeyId, { ct: field.ct, dekCt: field.dekCt });
}
