// Pure canonicalization for an action_item_closures row's Ed25519
// attestation signature (Milestone 2.2, ADR-0013 TM-fold-5 / T-IM33).
//
// Parallels the M2.1 meeting-crypto pattern (apps/api/src/lib/meeting-
// crypto.ts: AttestationRowCanonical + canonicalize() + signAttestation).
// The row's attestation_signed_ct column carries an Ed25519 detached
// signature over SHA-256(canonical(row)); a verifier re-hashes the
// canonical row and verifies against the workplace signing key's public
// key.
//
// What enters the canonical JSON:
//   - actionItemId, closureId (identity)
//   - meetingId | null (context, when set)
//   - closerActorId, counterSignerActorId (the two parties)
//   - closedAt, counterSignedAt (timestamps as ISO 8601)
//   - selfAttestation (boolean — the chain payload carries the same)
//   - signingKeyId (key rotation pinning)
//   - closureReasonHash (sha256 hex of the envelope ciphertext bytes)
//   - evidenceHash | null (sha256 hex of the evidence ciphertext bytes,
//     null when no evidence is attached)
//
// What does NOT enter:
//   - The closure_reason_envelope_ct / evidence_envelope_ct bytes
//     themselves (random nonces in the envelope encryption would
//     defeat canonicalization — we sign over their hashes instead).
//   - version (mutates on UPDATE — but the row is append-only so this
//     is defense in depth).
//   - created_at (server-controlled; not part of the attestation).
//   - attestation_signed_ct (the output of this signature).
//
// This is a pure function; no I/O, no Date.now-style instability —
// callers pass timestamps as strings and the canonicalization re-emits
// them verbatim.

import { createHash } from 'node:crypto';

/**
 * Canonical shape of an action_item_closures row for attestation.
 *
 * Field order in the interface is documentary; the canonicalize()
 * function below re-emits via an alphabetically-sorted object literal
 * so the signed bytes are stable regardless of input ordering.
 */
export interface ActionItemClosureCanonical {
  readonly actionItemId: string;
  readonly closureId: string;
  readonly meetingId: string | null;
  readonly closerActorId: string;
  readonly counterSignerActorId: string;
  readonly closedAt: string;
  readonly counterSignedAt: string;
  readonly selfAttestation: boolean;
  readonly signingKeyId: string;
  /** Hex SHA-256 of the closure_reason_envelope_ct bytes. */
  readonly closureReasonHash: string;
  /** Hex SHA-256 of the evidence_envelope_ct bytes; null when absent. */
  readonly evidenceHash: string | null;
}

/**
 * Stable stringifier — JSON.stringify with alphabetically-sorted keys.
 * Same recipe as meeting-crypto canonicalize(): pin the key order so
 * the signed bytes are reproducible no matter what order the caller
 * builds the object in.
 */
export function canonicalizeActionItemClosure(row: ActionItemClosureCanonical): string {
  const ordered: Record<string, unknown> = {
    actionItemId: row.actionItemId,
    closedAt: row.closedAt,
    closerActorId: row.closerActorId,
    closureId: row.closureId,
    closureReasonHash: row.closureReasonHash,
    counterSignedAt: row.counterSignedAt,
    counterSignerActorId: row.counterSignerActorId,
    evidenceHash: row.evidenceHash,
    meetingId: row.meetingId,
    selfAttestation: row.selfAttestation,
    signingKeyId: row.signingKeyId,
  };
  return JSON.stringify(ordered);
}

/**
 * Returns the SHA-256 digest of the canonical JSON. This is the input
 * the route's signAttestation() call would sign with the workplace
 * signing key's secret key.
 */
export function actionItemClosureCanonicalDigest(row: ActionItemClosureCanonical): Uint8Array {
  const canonical = canonicalizeActionItemClosure(row);
  return new Uint8Array(createHash('sha256').update(canonical, 'utf8').digest());
}
