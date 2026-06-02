// Recommendation citation helpers — Milestone 1.9 S5.
//
// `computeCitationsHash` (in `pdf-renderer.ts`) hashes the resolved-
// against-corpus citation set: each row carries `clauseLabel` +
// `clauseBodyHash` from the JOIN against `clauses`. That's the right
// hash for the `recommendation.exported` chain anchor's `citationsHash`
// field — it binds the export to the exact corpus state.
//
// The PATCH chain anchor (sec-F4 close-out / T-R44) needs a CHEAPER
// hash: just the raw (statute_code, clause_id, version_date, position)
// triples on `recommendation_citations`. The route doesn't need to
// JOIN against `clauses` just to compute the hash, and the chain
// anchor's purpose is to detect citation-set churn between PATCHes —
// the corpus-bound hash is a different concern (computed only at
// export time).
//
// This module exports the pure, JOIN-free citation-row hash used by
// the PATCH handler's `recommendation.draft_patched` anchor.

import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '@jhsc/audit';

export interface CitationRowForHash {
  readonly statuteCode: string;
  readonly clauseId: string;
  readonly versionDate: string;
  readonly position: number;
}

/**
 * Hex SHA-256 of the canonical-JSON of the raw citation triples,
 * sorted by position. Pure function — no DB, no corpus.
 *
 * Empty input is hashed as the canonical JSON of an empty array,
 * which gives a deterministic non-empty digest. Two distinct empty
 * citation sets produce the same hash (correctly — the chain anchor
 * just records "no citations").
 */
export function computeCitationRowsHash(citations: ReadonlyArray<CitationRowForHash>): string {
  const sorted = [...citations].sort((a, b) => a.position - b.position);
  const canon = canonicalJsonStringify(
    sorted.map((c) => ({
      position: c.position,
      statuteCode: c.statuteCode,
      clauseId: c.clauseId,
      versionDate: c.versionDate,
    })),
  );
  return createHash('sha256').update(canon).digest('hex');
}
