// Envelope helpers for the five sensitive action-item fields
// (description, recommended_action, raised_by external, follow_up_owner
// external, move reason). Reuses @jhsc/crypto sealWithEnvelope under
// the master KEK. Same shape as apps/api/src/hazards/crypto.ts.
//
// Single encryption boundary for action items -- the route handlers
// never touch the KEK directly.

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
 * Safe summary for the list projection (T-AI1 mitigation, same shape
 * as hazards safeSummary). Trims at the last word boundary; falls back
 * to (cap - 10) when no usable boundary exists. The list route uses
 * this; detail route returns the full body.
 */
export function safeSummary(decrypted: string, max = 80): string {
  if (decrypted.length <= max) return decrypted;
  const slice = decrypted.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const SAFETY_MARGIN = 10;
  const trimAt = lastSpace > max - 20 ? lastSpace : Math.max(0, max - SAFETY_MARGIN);
  return `${slice.slice(0, trimAt).trimEnd()}…`;
}
