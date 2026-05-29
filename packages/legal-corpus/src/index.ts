// @jhsc/legal-corpus — versioned statute schema + fixture validators (ADR-0003).
//
// The package exposes:
//   - Drizzle table objects (statutes, clauses, corpus_versions) for the API
//     and any future write surface (currently only the seeder).
//   - Zod fixture schemas (StatuteFixture, ClauseFixture) for the TOML loader.
//   - Body-hash helpers used by recommendation writers + the verify script.
//   - Structural copyright guard + summary guard for the seeder.

export {
  clauseBodyKind,
  clauses,
  corpusVersions,
  statuteLicence,
  statutes,
  type ClauseBodyKind,
  type StatuteLicence,
} from './schema';

export {
  checkCopyrightGuard,
  checkSummaryGuard,
  clauseFixtureSchema,
  statuteFixtureSchema,
  type ClauseFixture,
  type CopyrightGuardViolation,
  type StatuteFixture,
  type SummaryGuardViolation,
} from './fixtures';

export { bodyHashHex, computeBodyHash, normalizeVersionDate } from './hash';
