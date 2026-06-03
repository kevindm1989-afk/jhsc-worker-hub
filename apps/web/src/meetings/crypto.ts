// Browser-side envelope encryption for meeting-lifecycle sensitive
// fields (Milestone 2.1 S3, ADR-0012 §3.6 + §3.7 + §3.9).
//
// Per CLAUDE.md non-negotiable #1 + #4 + the ADR contract: every
// sensitive meeting field is envelope-encrypted in the browser BEFORE
// the payload reaches the API. The server NEVER decrypts these fields;
// they go straight to Postgres as ciphertext and are revealed only at
// PDF-generation time under the workplace private key.
//
// Sensitive meeting fields (per ADR-0012):
//   - meeting_attendance.display_name          (attendee name)
//   - meeting_sections.notes_envelope          (section notes prose)
//   - meeting_signatures.signer_display_name   (signer name)
//   - meeting_signatures.chain_of_custody_note (TM-fold-4)
//   - meeting_signatures.evidence_envelope     (paper scan / email body)
//   - meeting_inspection_review.notes_envelope (review notes)
//
// Wire format mirrors apps/web/src/excel-imports/crypto.ts (v=0x02
// envelope; sealed-box DEK under the workplace public key). We re-use
// the workplace key cache from `@/excel-imports/crypto` so the seam
// stays singular per-tab; the 2.1 surface does not introduce a second
// cache.

import sodium from 'libsodium-wrappers';
import { getOrRefreshWorkplaceKey, type CachedWorkplaceKey } from '@/excel-imports/crypto';

let sodiumReady: Promise<void> | null = null;
async function ready(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready;
  await sodiumReady;
}

const WIRE_VERSION = 0x02;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export interface MeetingSealedField {
  /** Base64 of `v=0x02 || nonce || ciphertext+tag`. */
  readonly ctB64: string;
  /** Base64 of `crypto_box_seal(DEK, workplacePublicKey)`. */
  readonly dekCtB64: string;
}

export class WorkplaceKeyMissingError extends Error {
  constructor() {
    super(
      'workplace_key_missing: the workplace public key is not available; ' +
        'first-run setup must be complete before sealing meeting fields',
    );
    this.name = 'WorkplaceKeyMissingError';
  }
}

/**
 * Seal a single UTF-8 plaintext field for a meeting endpoint. Refuses
 * to seal an empty string — call `sealOptionalMeetingField` for the
 * nullable fields.
 */
export async function sealMeetingField(plaintext: string): Promise<MeetingSealedField> {
  if (plaintext.length === 0) {
    throw new Error('sealMeetingField: plaintext is empty');
  }
  const key = await getOrRefreshWorkplaceKey();
  if (!key) throw new WorkplaceKeyMissingError();
  return sealWithKey(plaintext, key);
}

/** Optional variant — returns null when plaintext is null/undefined/empty. */
export async function sealOptionalMeetingField(
  plaintext: string | null | undefined,
): Promise<MeetingSealedField | null> {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return sealMeetingField(plaintext);
}

async function sealWithKey(
  plaintext: string,
  key: CachedWorkplaceKey,
): Promise<MeetingSealedField> {
  await ready();
  if (key.publicKey.length !== KEY_BYTES) {
    throw new Error(`workplace public key must be ${KEY_BYTES} bytes`);
  }
  const dek = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(dek);
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);

  // Normalise the TextEncoder output for libsodium's instanceof check
  // (same pattern as excel-imports/crypto.ts).
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
  const ct = new Uint8Array(1 + nonce.length + body.length);
  ct[0] = WIRE_VERSION;
  ct.set(nonce, 1);
  ct.set(body, 1 + nonce.length);

  const dekCt = sodium.crypto_box_seal(dek, key.publicKey);
  sodium.memzero(dek);

  return { ctB64: bytesToB64(ct), dekCtB64: bytesToB64(dekCt) };
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
