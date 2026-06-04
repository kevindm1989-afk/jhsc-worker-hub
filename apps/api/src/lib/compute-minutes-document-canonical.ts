// Pure canonicalization for a minutes_documents row's Ed25519
// attestation signature (Milestone 2.3, ADR-0014 §3.1.1).
//
// Parallels M2.1 meeting-crypto (meeting_signatures attestation) and
// M2.2 compute-action-item-closure-canonical. The row's
// attestation_signed_ct carries an Ed25519 detached signature over
// SHA-256(canonical(row)); a verifier re-hashes the canonical row and
// verifies against the workplace signing key's public key.
//
// What enters the canonical JSON:
//   - meetingId
//   - documentId
//   - formatVersion (enum-stringified)
//   - renderAudience (enum-stringified per TM-fold-2)
//   - documentHash (sha256 hex of the rendered bytes — the canonical
//     bind between the row and the PDF bytes)
//   - documentSizeBytes
//   - tigrisStorageKey
//   - priorDocumentId | null
//   - generatedAt (ISO 8601 string)
//   - generatedByActorId
//   - signingKeyId
//   - retentionCorpusEntryHashes (sorted; TM-fold-5)
//
// What does NOT enter:
//   - hold_state / hold_reason / hold_placed_at / hold_released_at —
//     these mutate via the hold lifecycle (TM-fold-6); including them
//     would defeat post-sign immutability of the attestation
//   - regeneration_reason — informational; not load-bearing
//   - version / created_at / updated_at — server-controlled mutable
//   - attestation_signed_ct — the output of THIS signature
//
// This is a pure function; no I/O. Callers pass timestamps as strings
// and the canonicalization re-emits them verbatim. The
// retentionCorpusEntryHashes input is sorted defensively (a caller
// passing them in arbitrary order produces the same bytes).

import { createHash } from 'node:crypto';
import type {
  MinutesDocumentFormatVersion,
  MinutesDocumentRenderAudience,
} from '@jhsc/shared-types';

export interface MinutesDocumentCanonical {
  readonly meetingId: string;
  readonly documentId: string;
  readonly formatVersion: MinutesDocumentFormatVersion;
  readonly renderAudience: MinutesDocumentRenderAudience;
  readonly documentHash: string;
  readonly documentSizeBytes: number;
  readonly tigrisStorageKey: string;
  readonly priorDocumentId: string | null;
  readonly generatedAt: string;
  readonly generatedByActorId: string;
  readonly signingKeyId: string;
  /** Hex SHA-256 hashes of pinned legal-corpus retention entries. */
  readonly retentionCorpusEntryHashes: ReadonlyArray<string>;
}

/**
 * Stable stringifier — alphabetically-sorted top-level keys + array
 * fields stringified in ascending lexicographic order so caller-input
 * ordering doesn't change the signed bytes.
 */
export function canonicalizeMinutesDocument(row: MinutesDocumentCanonical): string {
  const sortedHashes = [...row.retentionCorpusEntryHashes].sort();
  const ordered: Record<string, unknown> = {
    documentHash: row.documentHash,
    documentId: row.documentId,
    documentSizeBytes: row.documentSizeBytes,
    formatVersion: row.formatVersion,
    generatedAt: row.generatedAt,
    generatedByActorId: row.generatedByActorId,
    meetingId: row.meetingId,
    priorDocumentId: row.priorDocumentId,
    renderAudience: row.renderAudience,
    retentionCorpusEntryHashes: sortedHashes,
    signingKeyId: row.signingKeyId,
    tigrisStorageKey: row.tigrisStorageKey,
  };
  return JSON.stringify(ordered);
}

/**
 * Returns the SHA-256 digest (32 bytes) of the canonical JSON. This is
 * the input the route's signAttestation() call signs with the workplace
 * signing key's secret key (Ed25519 detached signature).
 */
export function minutesDocumentCanonicalDigest(row: MinutesDocumentCanonical): Uint8Array {
  const canonical = canonicalizeMinutesDocument(row);
  return new Uint8Array(createHash('sha256').update(canonical, 'utf8').digest());
}
