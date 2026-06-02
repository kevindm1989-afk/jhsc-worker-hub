// Envelope helpers for the four sensitive recommendation fields
// (ADR-0008 §3.2 / §3.4):
//
//   - recommendations.title_ct           — envelope-encrypted recommendation
//                                          title.
//   - recommendations.body_ct            — envelope-encrypted long-form prose
//                                          (the body that carries [[cite:N]]
//                                          markers).
//   - recommendation_responses.body_ct   — envelope-encrypted management
//                                          response text.
//   - recommendation_responses.author_role_ct
//                                        — envelope-encrypted external author
//                                          role string ("VP Operations").
//
// Same shape as apps/api/src/inspections/crypto.ts so the route handlers
// never touch the KEK directly. Single encryption boundary for
// recommendations.
//
// The withdrawal_reason column is NOT routed through this helper — the
// route layer constrains it to a PI-clean enum (rescinded / superseded
// / addressed_pre_submission per ADR-0008 §3.1) and stores it as
// plaintext text. The encrypted-text path for the rep's free-text reason
// is documented in ADR-0008 §3.2 as a forward seam.

import { openWithEnvelope, sealWithEnvelope } from '@jhsc/crypto';
import { getMasterKey } from '../auth/crypto-stub';

export interface EncryptedField {
  readonly ct: Uint8Array;
  readonly dekCt: Uint8Array;
}

/** Seal a non-empty plaintext under the workplace KEK envelope. */
export function sealRecommendationField(plaintext: string): EncryptedField {
  const sealed = sealWithEnvelope(new TextEncoder().encode(plaintext), getMasterKey());
  return { ct: sealed.ciphertext, dekCt: sealed.dekSealed };
}

/** Open an envelope-sealed recommendation field back to its UTF-8 plaintext. */
export function openRecommendationField(field: EncryptedField): string {
  const plaintextBytes = openWithEnvelope(
    { ciphertext: field.ct, dekSealed: field.dekCt },
    getMasterKey(),
  );
  return new TextDecoder().decode(plaintextBytes);
}

/**
 * Seal an optional plaintext; returns null on empty / null / undefined.
 * Used for nullable encrypted columns (currently none on the schema; this
 * is the same shape as the inspections helper for forward-seam
 * symmetry with future nullable PI columns the runbook documents).
 */
export function sealOptionalField(plaintext: string | null | undefined): EncryptedField | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return sealRecommendationField(plaintext);
}

/** Open a nullable ciphertext pair; returns null when either column is NULL. */
export function openOptionalField(field: {
  ct: Uint8Array | null;
  dekCt: Uint8Array | null;
}): string | null {
  if (field.ct === null || field.dekCt === null) return null;
  return openRecommendationField({ ct: field.ct, dekCt: field.dekCt });
}
