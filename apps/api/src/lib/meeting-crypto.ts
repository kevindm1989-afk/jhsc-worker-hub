// Envelope helpers for the meeting-lifecycle sensitive fields (ADR-0012).
//
// Same shape as apps/api/src/inspections/crypto.ts and apps/api/src/
// recommendations/crypto.ts so the route handlers (S2) never touch the
// KEK directly. Single encryption boundary for the meeting surface.
//
// Sensitive fields covered:
//   - meetings.encrypted_notes_envelope_ct (co-chair private notes)
//   - meeting_sections.notes_envelope_ct
//   - meeting_attendance.display_name_ct (T-ML1)
//   - meeting_inspection_review.notes_envelope_ct
//   - meeting_signatures.signer_display_name_ct (#1)
//   - meeting_signatures.evidence_envelope_ct (off-app evidence body)
//   - meeting_signatures.chain_of_custody_note_ct (TM-fold-4)
//   - meeting_action_item_state.snapshot_assignee_ct
//
// Plus TM-fold-4 attestation signing: a 64-byte Ed25519 detached
// signature over SHA-256(canonical JSON of the row) using the active
// workplace signing key. The verifier later re-hashes the canonical row
// and verifies against the signing key's public key.

import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { openWithEnvelope, sealWithEnvelope } from '@jhsc/crypto';
import { getMasterKey } from '../auth/crypto-stub';

export interface EncryptedField {
  readonly ct: Uint8Array;
  readonly dekCt: Uint8Array;
}

export function sealMeetingField(plaintext: string): EncryptedField {
  const sealed = sealWithEnvelope(new TextEncoder().encode(plaintext), getMasterKey());
  return { ct: sealed.ciphertext, dekCt: sealed.dekSealed };
}

export function openMeetingField(field: EncryptedField): string {
  const plaintextBytes = openWithEnvelope(
    { ciphertext: field.ct, dekSealed: field.dekCt },
    getMasterKey(),
  );
  return new TextDecoder().decode(plaintextBytes);
}

export function sealOptionalMeetingField(
  plaintext: string | null | undefined,
): EncryptedField | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return sealMeetingField(plaintext);
}

export function openOptionalMeetingField(field: {
  ct: Uint8Array | null;
  dekCt: Uint8Array | null;
}): string | null {
  if (field.ct === null || field.dekCt === null) return null;
  return openMeetingField({ ct: field.ct, dekCt: field.dekCt });
}

// ---------------------------------------------------------------------------
// Meeting notes envelope helpers (alias names per S1 brief)
// ---------------------------------------------------------------------------
//
// The brief calls for `sealMeetingNotes(plaintext, workplaceKek)` /
// `unsealMeetingNotes(envelope, workplaceKek)` with an explicit KEK
// argument. We implement those as the explicit-KEK forms; the
// route-layer path will typically use sealMeetingField above which
// reads the KEK from the cached MASTER_KEY.

export function sealMeetingNotes(plaintext: string, kek: Uint8Array): EncryptedField {
  const sealed = sealWithEnvelope(new TextEncoder().encode(plaintext), kek);
  return { ct: sealed.ciphertext, dekCt: sealed.dekSealed };
}

export function unsealMeetingNotes(envelope: EncryptedField, kek: Uint8Array): string {
  const plaintextBytes = openWithEnvelope(
    { ciphertext: envelope.ct, dekSealed: envelope.dekCt },
    kek,
  );
  return new TextDecoder().decode(plaintextBytes);
}

// ---------------------------------------------------------------------------
// TM-fold-4 (T-ML5 / T-ML23) — Ed25519 attestation signing
// ---------------------------------------------------------------------------
//
// The meeting_signatures.attestation_signed_ct column carries a 64-byte
// Ed25519 detached signature over SHA-256 of the canonical JSON of the
// row's load-bearing fields. The signature is produced INSIDE the same
// transaction that inserts the row; the workplace signing key is the
// existing 1.9 workplace_signing_keys keypair.
//
// Defense-in-depth: a malicious DB-direct UPDATE that does not go
// through the audit chain still produces a row whose attestation
// signature no longer matches the rest of the row. A verifier walks
// the meeting_signatures table and re-checks each row's signature.
//
// We sign the SHA-256 of the canonical JSON (not the raw JSON) so
// the signed bytes are fixed-size (32 bytes) regardless of how many
// fields the row carries. Symmetric to the recommendation signing
// pattern in apps/api/src/recommendations/signing.ts.

/**
 * Canonical JSON shape of a meeting_signatures row for attestation.
 * Excludes the attestation_signed_ct column itself (which is the
 * output of this very signature) plus version + created_at (server
 * controlled metadata that should not enter the signed bytes — a row
 * UPDATE that touches version must NOT invalidate the attestation).
 *
 * The hashes encode the ciphertext bytes — the signed material binds
 * the row to its envelope ciphertexts (and therefore the plaintexts
 * those envelopes seal) without leaking the plaintexts.
 */
export interface AttestationRowCanonical {
  readonly meetingId: string;
  readonly signerRole: string;
  readonly signerDisplayNameHash: string;
  readonly signerUserId: string | null;
  readonly signedAt: string;
  readonly signedMethod: string;
  readonly evidenceStorageKey: string | null;
  readonly evidenceHash: string | null;
  readonly stepUpJti: string | null;
  readonly chainOfCustodyNoteHash: string | null;
  readonly signingKeyId: string;
}

/**
 * Stable stringifier — JSON.stringify with sorted keys at the top level.
 * The interface above pins the field order; we re-emit via the listed
 * keys to make the signed bytes stable regardless of input ordering.
 */
function canonicalize(row: AttestationRowCanonical): string {
  const ordered: Record<string, unknown> = {
    chainOfCustodyNoteHash: row.chainOfCustodyNoteHash,
    evidenceHash: row.evidenceHash,
    evidenceStorageKey: row.evidenceStorageKey,
    meetingId: row.meetingId,
    signedAt: row.signedAt,
    signedMethod: row.signedMethod,
    signerDisplayNameHash: row.signerDisplayNameHash,
    signerRole: row.signerRole,
    signerUserId: row.signerUserId,
    signingKeyId: row.signingKeyId,
    stepUpJti: row.stepUpJti,
  };
  return JSON.stringify(ordered);
}

/**
 * Produce the 64-byte Ed25519 detached signature over SHA-256(canonical(row)).
 *
 * Caller responsibilities:
 *   - sodium.ready awaited (the API boot path does this).
 *   - workplaceSigningPrivateKey is the 64-byte libsodium secret key
 *     (the open() of the active workplace_signing_keys row).
 *   - sodium.memzero(privateKey) immediately after this returns.
 */
export function signAttestation(
  row: AttestationRowCanonical,
  workplaceSigningPrivateKey: Uint8Array,
): Uint8Array {
  if (workplaceSigningPrivateKey.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new Error(
      `signAttestation: privateKey must be ${sodium.crypto_sign_SECRETKEYBYTES} bytes, got ${workplaceSigningPrivateKey.length}`,
    );
  }
  const canonical = canonicalize(row);
  const digest = createHash('sha256').update(canonical, 'utf8').digest();
  return sodium.crypto_sign_detached(new Uint8Array(digest), workplaceSigningPrivateKey);
}

/**
 * Verify a previously-produced attestation. Returns boolean; never
 * throws on a malformed signature.
 */
export function verifyAttestation(
  row: AttestationRowCanonical,
  signature: Uint8Array,
  workplaceSigningPublicKey: Uint8Array,
): boolean {
  if (signature.length !== sodium.crypto_sign_BYTES) return false;
  if (workplaceSigningPublicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return false;
  const canonical = canonicalize(row);
  const digest = createHash('sha256').update(canonical, 'utf8').digest();
  try {
    return sodium.crypto_sign_verify_detached(
      signature,
      new Uint8Array(digest),
      workplaceSigningPublicKey,
    );
  } catch {
    return false;
  }
}

/**
 * Helper: SHA-256 hex digest of arbitrary bytes. Used for the
 * envelope-hash fields in AttestationRowCanonical and in the audit
 * payload `nameHash` / `notesHash` / `evidenceHash` slots.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
