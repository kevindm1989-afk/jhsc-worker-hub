// Envelope helpers for the four sensitive inspection-finding /
// signature-note fields (ADR-0007 §3.6 / §3.8):
//
//   - inspection_findings.observation_ct
//   - inspection_findings.corrective_action_ct
//   - inspection_findings.responsible_party_ct  (when external — internal
//     reps go in responsible_party_user_id is a future S3 ratchet; in
//     1.8 we ship only the encrypted display-name variant)
//   - inspection_signatures.note_ct
//
// Same shape as apps/api/src/hazards/crypto.ts and apps/api/src/action-
// items/crypto.ts so the route handlers never touch the KEK directly.
// Single encryption boundary for inspections.

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
