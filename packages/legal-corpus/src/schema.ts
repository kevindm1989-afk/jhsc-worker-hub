// Drizzle schema for the legal corpus (ADR-0003).
//
// Three tables:
//   - corpus_versions: ledger of seed loads (active version = MAX(activated_at)
//     where retired_at IS NULL).
//   - statutes: one row per Act / Regulation. Carries licence so the structural
//     copyright guard can refuse full_text under third_party_restricted.
//   - clauses: one row per provision per version_date. INSERT-only. Identified
//     by (statute_id, citation, version_date). superseded_by points at the
//     replacement when an amendment is published.

import { sql } from 'drizzle-orm';
import {
  customType,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// tsvector is generated in SQL via ALTER TABLE in the migration; we don't
// model the column in Drizzle so drizzle-kit doesn't try to round-trip it.

export const statuteLicence = ['crown_copyright_open', 'third_party_restricted'] as const;
export type StatuteLicence = (typeof statuteLicence)[number];

export const clauseBodyKind = ['full_text', 'summary'] as const;
export type ClauseBodyKind = (typeof clauseBodyKind)[number];

export const corpusVersions = pgTable('corpus_versions', {
  version: text('version').primaryKey(),
  activatedAt: timestamp('activated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  fixtureSha256: bytea('fixture_sha256').notNull(),
  note: text('note'),
});

export const statutes = pgTable(
  'statutes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Short stable code used by <CitationRef statute="OHSA" .../>
    code: text('code').notNull(),
    jurisdiction: text('jurisdiction').notNull(), // 'ON' | 'CA' | etc.
    title: text('title').notNull(),
    licence: text('licence').notNull(),
    sourceUrl: text('source_url').notNull(),
    corpusVersion: text('corpus_version')
      .notNull()
      .references(() => corpusVersions.version, { onUpdate: 'restrict', onDelete: 'restrict' }),
  },
  (t) => ({
    codeUnique: uniqueIndex('statutes_code_unique').on(t.code),
    jurisdictionIdx: index('statutes_jurisdiction_idx').on(t.jurisdiction),
  }),
);

export const clauses = pgTable(
  'clauses',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    statuteId: uuid('statute_id')
      .notNull()
      .references(() => statutes.id, { onUpdate: 'restrict', onDelete: 'restrict' }),
    citation: text('citation').notNull(),
    // Hierarchy path: ['Part II', 's.9', '(20)']. Stored as text[] so search
    // filters can scope to a part / section without parsing the citation string.
    hierarchyPath: text('hierarchy_path').array().notNull(),
    heading: text('heading'),
    // For body_kind='full_text', `body` is the verbatim provision text.
    // For body_kind='summary', `body` is the JHSC's own paraphrase and the
    // verbatim text lives at `source_url` (third-party copyright path).
    body: text('body').notNull(),
    bodySummary: text('body_summary'),
    bodyKind: text('body_kind').notNull(),
    // SHA-256(body || version_date.toISOString()). Recommendation rows store
    // this so a re-seed that publishes an amendment surfaces as a
    // body_hash mismatch at recommendation-read time.
    bodyHash: bytea('body_hash').notNull(),
    versionDate: date('version_date').notNull(),
    verifiedBy: text('verified_by').notNull(),
    sourceUrl: text('source_url').notNull(),
    corpusVersion: text('corpus_version')
      .notNull()
      .references(() => corpusVersions.version, { onUpdate: 'restrict', onDelete: 'restrict' }),
    supersededBy: uuid('superseded_by'),
    correctionOf: uuid('correction_of'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    statuteCitationVersionUnique: uniqueIndex('clauses_statute_citation_version_unique').on(
      t.statuteId,
      t.citation,
      t.versionDate,
    ),
    statuteIdx: index('clauses_statute_idx').on(t.statuteId),
    versionDateIdx: index('clauses_version_date_idx').on(t.versionDate),
  }),
);
