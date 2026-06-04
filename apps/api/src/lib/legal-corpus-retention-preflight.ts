// Legal-corpus retention pre-flight for minutes-document generation
// (Milestone 2.3, ADR-0014 TM-fold-5 — T-MD26 / T-MD27).
//
// The generation route MUST resolve the jurisdiction-appropriate
// retention citation entries BEFORE rendering the PDF. Missing entries
// fail-closed with a typed error; the rep cannot generate without the
// citations resolving. The retention statement embeds the corpus entry
// hashes (not just citations) so a verifier can confirm the cited body
// matches what was rendered.
//
// Jurisdiction mapping:
//   - ON (Ontario): OHSA s.9(28) — "the records of a committee shall
//     be retained by the employer..." (per CLAUDE.md non-negotiable #5
//     + ADR §3.4; the canonical Ontario JHSC minutes retention duty).
//   - CA-FED (federal): CLC s.135.2 — committee records retention
//     under the Canada Labour Code Part II / COHSR equivalent.
//
// Pure-ish: depends on a query callback so the route can pass in its
// already-bound DB handle (Drizzle / postgres-js); no global I/O.
// The callback shape lets tests mock the corpus without a live DB.
//
// Fail-closed: if either expected citation does not resolve to an
// active (non-retired) corpus_versions row, throws RetentionCorpusMissingError
// which the route translates to a 500 `retention_corpus_missing` envelope.

import type { Jurisdiction } from '../../../../config/workplace';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RetentionCorpusEntry {
  /** Statute short code (e.g., 'OHSA', 'CLC'). */
  readonly statuteCode: string;
  /** Citation string (e.g., 's.9(28)', 's.135.2'). */
  readonly citation: string;
  /** ISO date string (YYYY-MM-DD) the corpus entry was last verified. */
  readonly versionDate: string;
  /** Hex SHA-256 of the corpus body (per `bodyHash` from @jhsc/legal-corpus). */
  readonly bodyHash: string;
}

export interface RetentionCorpusResolved {
  readonly entries: ReadonlyArray<RetentionCorpusEntry>;
  /** Sorted list of `bodyHash` values for the canonical attestation. */
  readonly canonicalHashes: ReadonlyArray<string>;
}

/**
 * Per-jurisdiction expected citation tuple (statute code + citation
 * string). The pre-flight asserts every tuple resolves; partial
 * resolution is a fail-closed error.
 */
export interface ExpectedRetentionCitation {
  readonly statuteCode: string;
  readonly citation: string;
}

export const RETENTION_CITATIONS_BY_JURISDICTION: Readonly<
  Record<Jurisdiction, ReadonlyArray<ExpectedRetentionCitation>>
> = {
  // Ontario OHSA — committee records retention duty.
  ON: [{ statuteCode: 'OHSA', citation: 's.9(28)' }],
  // Canada Labour Code Part II — federal committee records.
  'CA-FED': [{ statuteCode: 'CLC', citation: 's.135.2' }],
};

/**
 * Fail-closed error raised when one or more expected corpus entries
 * are missing. The route layer translates this to a 500
 * `retention_corpus_missing` envelope; the rep sees a generic "the
 * legal corpus is not seeded for this jurisdiction" message.
 */
export class RetentionCorpusMissingError extends Error {
  readonly jurisdiction: Jurisdiction;
  readonly missing: ReadonlyArray<ExpectedRetentionCitation>;
  constructor(jurisdiction: Jurisdiction, missing: ReadonlyArray<ExpectedRetentionCitation>) {
    super(
      `RetentionCorpusMissingError: jurisdiction=${jurisdiction}, missing ${missing.length} entries (${missing
        .map((m) => `${m.statuteCode} ${m.citation}`)
        .join(
          ', ',
        )}). The legal corpus must be seeded with the retention citation entries before minutes documents can be generated.`,
    );
    this.name = 'RetentionCorpusMissingError';
    this.jurisdiction = jurisdiction;
    this.missing = missing;
  }
}

// ---------------------------------------------------------------------------
// Corpus query callback
// ---------------------------------------------------------------------------

/**
 * Callback the caller (route layer) provides. Given a (statuteCode,
 * citation) tuple, returns the most-recent non-superseded corpus row
 * matching it (latest version_date wins; ties broken by created_at
 * desc) or null if no row matches.
 *
 * Tests stub this; the route layer uses a Drizzle-backed query that
 * joins `clauses` to `statutes` and filters `superseded_by IS NULL`.
 */
export type CorpusEntryLookup = (
  expected: ExpectedRetentionCitation,
) => Promise<RetentionCorpusEntry | null>;

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/**
 * Resolve every expected retention citation for the workplace
 * jurisdiction. Fail-closed: any missing entry throws
 * RetentionCorpusMissingError.
 *
 * Returns the resolved entries + a sorted list of bodyHashes suitable
 * for the minutes_documents.retention_corpus_entry_hashes JSONB column
 * AND the canonical attestation signature (see
 * compute-minutes-document-canonical.ts which expects sorted hashes).
 */
export async function resolveRetentionCorpus(
  jurisdiction: Jurisdiction,
  lookup: CorpusEntryLookup,
): Promise<RetentionCorpusResolved> {
  const expected = RETENTION_CITATIONS_BY_JURISDICTION[jurisdiction];
  const entries: RetentionCorpusEntry[] = [];
  const missing: ExpectedRetentionCitation[] = [];
  for (const e of expected) {
    const row = await lookup(e);
    if (row === null) {
      missing.push(e);
    } else {
      entries.push(row);
    }
  }
  if (missing.length > 0) {
    throw new RetentionCorpusMissingError(jurisdiction, missing);
  }
  const canonicalHashes = [...entries.map((e) => e.bodyHash)].sort();
  return { entries, canonicalHashes };
}
