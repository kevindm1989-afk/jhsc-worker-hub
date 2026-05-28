// Envelope helpers for the four sensitive hazard fields (ADR-0004).
//
// Wraps @jhsc/crypto's sealWithEnvelope / openWithEnvelope so the
// route handler doesn't have to thread the KEK or worry about
// (ct, dek_ct) pair packaging. Encryption boundary lives here only.

import { openWithEnvelope, sealWithEnvelope } from '@jhsc/crypto';
import { getMasterKey } from '../auth/crypto-stub';

export interface EncryptedField {
  readonly ct: Uint8Array;
  readonly dekCt: Uint8Array;
}

export function sealField(plaintext: string): EncryptedField {
  const sealed = sealWithEnvelope(new TextEncoder().encode(plaintext), getMasterKey());
  return { ct: sealed.ciphertext, dekCt: sealed.dekSealed };
}

export function openField(field: EncryptedField): string {
  const plaintextBytes = openWithEnvelope(
    { ciphertext: field.ct, dekSealed: field.dekCt },
    getMasterKey(),
  );
  return new TextDecoder().decode(plaintextBytes);
}

/** Optional variant — returns null when both halves are null (anonymous reporter / no detail). */
export function sealOptionalField(plaintext: string | null | undefined): EncryptedField | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return sealField(plaintext);
}

export function openOptionalField(field: {
  ct: Uint8Array | null;
  dekCt: Uint8Array | null;
}): string | null {
  if (field.ct === null || field.dekCt === null) return null;
  return openField({ ct: field.ct, dekCt: field.dekCt });
}

/**
 * Safe summary for list-view projection (T-H1/T-H4 mitigation).
 * Returns the first `max` chars of the decrypted description, trimmed
 * at a word boundary, with an ellipsis if truncated. Never returns
 * reporter identity. List route uses this; detail route returns the
 * full body.
 *
 * Priv-review F4 (1.5): when the first `max` chars contain no space
 * (e.g. a rep types a single-token name jammed together with the
 * hazard description), we fall back from "trim at word boundary" to
 * "trim at the codepoint cap minus a safety margin." That sheds the
 * trailing partial token instead of returning the maximal name prefix.
 * Defense-in-depth against rep-discipline failure, not a primary
 * mitigation.
 */
export function safeSummary(decrypted: string, max = 80): string {
  if (decrypted.length <= max) return decrypted;
  const slice = decrypted.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const SAFETY_MARGIN = 10;
  const trimAt =
    lastSpace > max - 20
      ? lastSpace
      : // No usable word boundary — shed the trailing partial token.
        Math.max(0, max - SAFETY_MARGIN);
  return `${slice.slice(0, trimAt).trimEnd()}…`;
}
