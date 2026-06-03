#!/usr/bin/env bun
// Milestone 2.1 S4 (ADR-0012 §3.3) — agenda template v1 seed.
//
// Seeds the canonical "JHSC Standing Agenda v1" row for the workplace's
// configured jurisdiction (ON or CA-FED, read from
// `config/workplace.ts` which itself reads `WORKPLACE_JURISDICTION` at
// runtime). The v1 row materializes 10 sections from the closed 12-value
// `meeting_section_type` enum:
//
//   order_idx  section_type          default_time_alloc_minutes
//   --------   ------------------    --------------------------
//   0          call_to_order         5
//   1          roll_call_quorum      5
//   2          minutes_review        10
//   3          old_business          20
//   4          new_business          20
//   5          inspections_review    15
//   6          incident_review       10
//   7          recommendations       15
//   8          other_business        10
//   9          next_meeting          5
//   10         adjournment           5
//
// Total scheduled minutes: 120.
//
// `complaints_review` is the 12th enum slot deliberately NOT instantiated
// in v1 — kept as a forward seam for v2 templates so a workplace that
// wants formal complaints handling can land a v2 without an enum
// migration (per ADR-0012 §3.1 reconciliation + S0 user-decision: the
// 12-value enum is CLOSED for all of Release 2).
//
// Per CLAUDE.md non-negotiable #13 (extended to meetings per ADR-0012
// §3.3): a v1 template stays v1 for v1 meetings forever; a v2 template
// lands as a new row with its own version_number; the v1 row's
// retired_at is set so new meetings get v2 but historical v1 meetings
// keep their pinned reference. This script never UPDATEs an existing
// version row; the idempotency guard is a SELECT-first on
// (template_code, version_number) per the inspection-template seed
// precedent.
//
// Schema-gap note (per S4 boundaries): the meeting_templates table from
// S1 does NOT carry a CHECK constraint enforcing that the seeded
// sections_json shape matches the meetingTemplateSectionsSchema Zod
// shape from packages/shared-types — the column is jsonb. The seed
// validates the array client-side before INSERT so a schema-drifted
// seed cannot succeed. The route handler (S2) trusts the column shape
// and casts; the Zod gate at seed time is the load-bearing structural
// backstop.
//
// Usage:
//   DATABASE_URL=... bun apps/api/scripts/seed-meeting-template.ts
//   DATABASE_URL=... WORKPLACE_JURISDICTION=CA-FED bun apps/api/scripts/seed-meeting-template.ts
//
// Idempotency: re-running prints "skipped" and exits 0. The chain
// anchor (`audit.meeting_template.seeded`) is emitted ONLY on the
// INSERT path; re-runs do not emit duplicate anchors.

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { append, canonicalJsonStringify, type DrizzlePg } from '@jhsc/audit';
import { meetingTemplateSectionsSchema, type MeetingTemplateSection } from '@jhsc/shared-types';
import { getDb } from '../src/db/client';
import { loadWorkplaceConfig, type Jurisdiction } from '../../../config/workplace';

// ---------------------------------------------------------------------------
// v1 template definition
// ---------------------------------------------------------------------------

export const MEETING_TEMPLATE_V1_VERSION = 1;
export const MEETING_TEMPLATE_V1_NAME = 'JHSC Standing Agenda v1';
export const MEETING_TEMPLATE_CODE = 'jhsc_standard';

/**
 * Canonical v1 section list. Order is `order_idx` ASC; this is the
 * SOURCE OF TRUTH for the deterministic hash that lands in the chain
 * anchor payload. Reordering the entries WILL change the
 * template_hash — only do so for an intentional v2.
 *
 * Time allocations rationale (per ADR-0012 §3.3 + the user's brief):
 *   - call_to_order / roll_call_quorum: 5 min each — procedural
 *     bookends; the rep moves through them quickly.
 *   - minutes_review: 10 min — re-reading prior minutes is usually
 *     short but occasionally surfaces a correction.
 *   - old_business / new_business: 20 min each — the action-item
 *     discussion volume is the meeting's real work; balanced equally
 *     since carried items often outnumber new ones early in a quarter
 *     but flip late in a quarter.
 *   - inspections_review: 15 min — a typical monthly inspection
 *     produces 1-3 findings to discuss.
 *   - incident_review: 10 min — incident review is binary (none
 *     happened, or one happened and dominates). Allocation reflects
 *     the mean.
 *   - recommendations: 15 min — drafting an s.9(20) Notice in-meeting
 *     is rare but high-stakes; allocation reserves space without
 *     forcing it.
 *   - other_business: 10 min — catches anything not covered.
 *   - next_meeting / adjournment: 5 min each — procedural closers.
 *
 * Total: 120 minutes. A typical JHSC quarterly meeting runs 90-120;
 * the template defaults to the upper bound and lets the rep close any
 * section early in the live view (the `time_allocation_minutes`
 * column on `meeting_sections` is per-row mutable in 2.1 even though
 * the template default is fixed — the rep can edit at conduct time).
 */
const TEMPLATE_V1_SECTIONS: ReadonlyArray<MeetingTemplateSection> = [
  {
    section_type: 'call_to_order',
    default_time_alloc_minutes: 5,
    default_visibility: 'standard',
    order_idx: 0,
  },
  {
    section_type: 'roll_call_quorum',
    default_time_alloc_minutes: 5,
    default_visibility: 'standard',
    order_idx: 1,
  },
  {
    section_type: 'minutes_review',
    default_time_alloc_minutes: 10,
    default_visibility: 'standard',
    order_idx: 2,
  },
  {
    section_type: 'old_business',
    default_time_alloc_minutes: 20,
    default_visibility: 'standard',
    order_idx: 3,
  },
  {
    section_type: 'new_business',
    default_time_alloc_minutes: 20,
    default_visibility: 'standard',
    order_idx: 4,
  },
  {
    section_type: 'inspections_review',
    default_time_alloc_minutes: 15,
    default_visibility: 'standard',
    order_idx: 5,
  },
  {
    section_type: 'incident_review',
    default_time_alloc_minutes: 10,
    default_visibility: 'standard',
    order_idx: 6,
  },
  {
    section_type: 'recommendations',
    default_time_alloc_minutes: 15,
    default_visibility: 'standard',
    order_idx: 7,
  },
  {
    section_type: 'other_business',
    default_time_alloc_minutes: 10,
    default_visibility: 'standard',
    order_idx: 8,
  },
  {
    section_type: 'next_meeting',
    default_time_alloc_minutes: 5,
    default_visibility: 'standard',
    order_idx: 9,
  },
  {
    section_type: 'adjournment',
    default_time_alloc_minutes: 5,
    default_visibility: 'standard',
    order_idx: 10,
  },
];

/**
 * Build + validate the canonical v1 sections array. Pure: same input →
 * same output, byte-stable across runs (the deterministic basis for
 * the chain anchor's `templateHash`).
 *
 * Validates against the meetingTemplateSectionsSchema Zod schema from
 * @jhsc/shared-types so a drifted constant fails at seed time, not at
 * route-handler runtime.
 */
export function buildTemplateV1Sections(): ReadonlyArray<MeetingTemplateSection> {
  const parsed = meetingTemplateSectionsSchema.parse(TEMPLATE_V1_SECTIONS);
  return parsed;
}

/**
 * Hex SHA-256 of canonical JSON of the v1 sections array. PI-free,
 * deterministic, stable across seed runs. The chain payload carries
 * this hash so an offline verifier can confirm the template content
 * was not tampered with after seed-time.
 */
export function templateV1Hash(): string {
  const sections = buildTemplateV1Sections();
  const canonical = canonicalJsonStringify(sections);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export interface SeedMeetingTemplateResult {
  readonly inserted: number;
  readonly skipped: number;
  readonly jurisdiction: Jurisdiction;
  readonly templateHash: string;
}

/**
 * Idempotent seed of the v1 agenda template for the workplace's
 * jurisdiction. Returns a structured summary; the calling main()
 * renders it to stdout.
 *
 * Audit chain anchor: `audit.meeting_template.seeded` with payload
 * `{ templateVersion, jurisdiction, templateHash }`. PI-clean by
 * construction (the discriminated union in @jhsc/shared-types rejects
 * any name field at the type level).
 */
export async function seedMeetingTemplate(
  db: DrizzlePg,
  jurisdiction: Jurisdiction,
): Promise<SeedMeetingTemplateResult> {
  const sections = buildTemplateV1Sections();
  const templateHash = templateV1Hash();

  const inserted = await db.transaction(async (tx) => {
    // Idempotency guard — SELECT-first on (template_code, version_number).
    const existing = (await tx.execute(sql`
      SELECT id FROM meeting_templates
      WHERE template_code = ${MEETING_TEMPLATE_CODE}
        AND version_number = ${MEETING_TEMPLATE_V1_VERSION}
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (existing[0]) return false;

    // sections_json: jsonb column. We pass the canonical JSON form so
    // the stored representation is byte-identical to the hashed form
    // (a downstream verifier that re-canonicalizes the column value
    // recovers the same templateHash).
    const sectionsJson = canonicalJsonStringify(sections);
    await tx.execute(sql`
      INSERT INTO meeting_templates (
        template_code, version_number, name, jurisdiction, sections_json
      )
      VALUES (
        ${MEETING_TEMPLATE_CODE},
        ${MEETING_TEMPLATE_V1_VERSION},
        ${MEETING_TEMPLATE_V1_NAME},
        ${jurisdiction},
        ${sectionsJson}::jsonb
      )
    `);

    await append(tx, {
      payload: {
        kind: 'audit.meeting_template.seeded',
        templateVersion: MEETING_TEMPLATE_V1_VERSION,
        jurisdiction,
        templateHash,
      },
      resourceType: 'meeting_templates',
      // resourceId left unset — the v1 row's id is gen_random_uuid() and
      // not load-bearing for the chain (the (template_code, version)
      // pair is the natural key). The audit row binds via the
      // resourceType + payload's templateVersion + jurisdiction.
    });
    return true;
  });

  return {
    inserted: inserted ? 1 : 0,
    skipped: inserted ? 0 : 1,
    jurisdiction,
    templateHash,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const workplace = loadWorkplaceConfig();
  const db = getDb() as unknown as DrizzlePg;
  const result = await seedMeetingTemplate(db, workplace.jurisdiction);
  process.stdout.write(
    `seed-meeting-template: inserted=${result.inserted} skipped=${result.skipped} jurisdiction=${result.jurisdiction} templateHash=${result.templateHash}\n`,
  );
}

// Only run when invoked directly; the seedMeetingTemplate export is the
// test/route-side entrypoint and must not boot the DB or chain on
// module import.
if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `seed-meeting-template failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
