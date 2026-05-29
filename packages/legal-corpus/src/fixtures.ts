// Zod schemas for the TOML fixtures consumed by the seed loader.
//
// A fixture file declares one statute plus its clauses. The loader reads
// every *.toml under seed/, validates the parsed shape against
// StatuteFixture, runs the structural copyright guard, and INSERTs.

import { z } from 'zod';
import { clauseBodyKind, statuteLicence } from './schema';

const versionDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'version_date must be YYYY-MM-DD');

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'source_url must be https://');

export const clauseFixtureSchema = z
  .object({
    citation: z.string().min(1),
    hierarchy_path: z.array(z.string().min(1)).min(1),
    heading: z.string().min(1).optional(),
    body: z.string().min(1),
    body_summary: z.string().min(1).optional(),
    body_kind: z.enum(clauseBodyKind),
    version_date: versionDateSchema,
    verified_by: z.string().min(1),
    source_url: httpsUrl,
  })
  .strict();

export const statuteFixtureSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .regex(/^[A-Z0-9._-]+$/, 'statute code must be ASCII upper / digits / . _ -'),
    jurisdiction: z.string().min(2).max(8),
    title: z.string().min(1),
    licence: z.enum(statuteLicence),
    source_url: httpsUrl,
    clauses: z.array(clauseFixtureSchema).min(1),
  })
  .strict();

export type ClauseFixture = z.infer<typeof clauseFixtureSchema>;
export type StatuteFixture = z.infer<typeof statuteFixtureSchema>;

// ---------------------------------------------------------------------------
// Structural copyright guard (T-LC4)
// ---------------------------------------------------------------------------

export type CopyrightGuardViolation = {
  readonly statute: string;
  readonly citation: string;
  readonly reason: 'full_text_under_restricted_licence';
};

/**
 * Walks a fixture and returns every clause that violates the licence
 * rule: body_kind='full_text' is only allowed under crown_copyright_open.
 *
 * The seeder MUST exit non-zero if this returns any rows. The DB-level
 * trigger from ADR-0003 is a defence-in-depth backstop; this is the
 * primary check because it fires before the seeder opens a transaction.
 */
export function checkCopyrightGuard(
  fixture: StatuteFixture,
): ReadonlyArray<CopyrightGuardViolation> {
  if (fixture.licence === 'crown_copyright_open') return [];
  const violations: CopyrightGuardViolation[] = [];
  for (const c of fixture.clauses) {
    if (c.body_kind === 'full_text') {
      violations.push({
        statute: fixture.code,
        citation: c.citation,
        reason: 'full_text_under_restricted_licence',
      });
    }
  }
  return violations;
}

/**
 * Asserts that every clause's body_summary is present when body_kind='summary',
 * and absent (or matches body) when body_kind='full_text'. body_summary is
 * what the search route projects for restricted rows (T-LC8); a missing
 * value would silently leak the (paraphrased) body instead.
 */
export type SummaryGuardViolation = {
  readonly statute: string;
  readonly citation: string;
  readonly reason: 'summary_missing' | 'summary_on_full_text';
};

export function checkSummaryGuard(fixture: StatuteFixture): ReadonlyArray<SummaryGuardViolation> {
  const violations: SummaryGuardViolation[] = [];
  for (const c of fixture.clauses) {
    if (c.body_kind === 'summary' && !c.body_summary) {
      violations.push({ statute: fixture.code, citation: c.citation, reason: 'summary_missing' });
    }
    if (c.body_kind === 'full_text' && c.body_summary !== undefined) {
      violations.push({
        statute: fixture.code,
        citation: c.citation,
        reason: 'summary_on_full_text',
      });
    }
  }
  return violations;
}
