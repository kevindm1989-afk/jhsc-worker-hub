// Envelope helpers for the two sensitive excel_imports columns (ADR-0010
// §3.8 / SECURITY T-X13 / T-X19):
//
//   - excel_imports.source_filename_ct — envelope-encrypted source
//     filename (T-X19 — filenames frequently leak workplace identity).
//   - excel_imports.inspection_review_snapshot_ct — envelope-encrypted
//     JSONB snapshot of the workbook's Inspection Review sheet (T-X13
//     — the snapshot may carry supervisor / witness names).
//
// Mirrors apps/api/src/recommendations/crypto.ts (same shape as the
// other 1.6+ encryption boundaries). The route layer never touches
// the KEK directly; this file is the single encryption boundary for
// the excel-imports module.
//
// The route handler stores the canonical-JSON-stringified inspection-
// review snapshot under the same envelope pair as the source filename
// — both are short text blobs that fit comfortably inside one DEK
// envelope.

import { openWithEnvelope, sealWithEnvelope } from '@jhsc/crypto';
import { getMasterKey } from '../auth/crypto-stub';

export interface EncryptedField {
  readonly ct: Uint8Array;
  readonly dekCt: Uint8Array;
}

/** Seal a non-empty plaintext under the workplace KEK envelope. */
export function sealExcelImportField(plaintext: string): EncryptedField {
  const sealed = sealWithEnvelope(new TextEncoder().encode(plaintext), getMasterKey());
  return { ct: sealed.ciphertext, dekCt: sealed.dekSealed };
}

/** Open an envelope-sealed excel-import field back to its UTF-8 plaintext. */
export function openExcelImportField(field: EncryptedField): string {
  const plaintextBytes = openWithEnvelope(
    { ciphertext: field.ct, dekSealed: field.dekCt },
    getMasterKey(),
  );
  return new TextDecoder().decode(plaintextBytes);
}

/**
 * Seal an optional plaintext; returns null on empty / null / undefined.
 * Used for the inspection_review_snapshot pair which is nullable
 * (workbooks without the snapshot sheet land NULL on both columns).
 */
export function sealOptionalExcelImportField(
  plaintext: string | null | undefined,
): EncryptedField | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return sealExcelImportField(plaintext);
}

/** Open a nullable ciphertext pair; returns null when either column is NULL. */
export function openOptionalExcelImportField(field: {
  ct: Uint8Array | null;
  dekCt: Uint8Array | null;
}): string | null {
  if (field.ct === null || field.dekCt === null) return null;
  return openExcelImportField({ ct: field.ct, dekCt: field.dekCt });
}
