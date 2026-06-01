#!/usr/bin/env bun
// Milestone 1.8 (ADR-0007 §3.4) seeder for the inspection templates.
//
// SLICE 1 STATUS: SKELETON ONLY.
//
// This file pins the shape S2 will land. S1 (this slice) ships the schema
// + types + migration only; the canonical template content (Zone Monthly
// v1 sections + Rack Inspection v1 sections) is authored in S2 alongside
// the Zod-validated `sections` JSONB schema. The two TODO blocks below
// are where S2 plugs that content in.
//
// CSA COPYRIGHT CAUTION (CLAUDE.md §"Legal Reference Module Rules" §5,
// SECURITY.md T-I8 / T-I9 / T-I10, ADR-0007 §3.4):
//   - The rack_inspection template MUST store clause numbers + section
//     headings + our-own-words summaries ONLY.
//   - NEVER store verbatim CSA A344 text, exemplar diagrams, or
//     transcribed prescriptive tolerance values.
//   - The seeded chain anchor payload carries `structureSha256` and
//     `sectionCount` ONLY — never section text, item text, or criteria
//     (T-I10).
//   - Two-person review gate on any change to either seeded template,
//     same posture as legal-corpus priv-F3 close-out from 1.4.
//
// Usage (S2+ once content lands):
//   DATABASE_URL=... bun run apps/api/scripts/seed-inspection-templates.ts

import { sql } from 'drizzle-orm';
import { append } from '@jhsc/audit';
import type { InspectionStatusVocabKind, InspectionTemplateCode } from '@jhsc/shared-types';
import { getDb } from '../src/db/client';

// All-zero UUID. The seeder is the only emitter of
// `audit.inspection_template.seeded` and runs without an authenticated
// actor (deploy-time seed, not a user action). The route layer will
// reject any external request whose `actorId` matches this constant —
// mirrors the legal-corpus seed posture in apps/api/scripts/seed-legal-
// corpus.ts (priv-F3 forward defense; see T-I9 / T-I33 in SECURITY.md
// §2.8 for the runbook cross-check this constant supports).
// S2 will move this to a shared constants module and ratchet the route
// layer's actor allow-list against it.
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

interface SeedTemplateInput {
  readonly templateCode: InspectionTemplateCode;
  readonly versionNumber: number;
  readonly displayName: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly cadence: 'monthly' | 'quarterly' | 'annual' | 'ad_hoc';
  readonly requiresThreeSignatures: boolean;
  // S2: this becomes the Zod-validated `InspectionTemplateSections`
  // shape. Stays `unknown[]` here so the SQL CHECK
  // (jsonb_typeof = 'array' AND jsonb_array_length > 0) is the only
  // structural assertion in S1.
  readonly sections: ReadonlyArray<unknown>;
  /** Hex-encoded SHA-256 of the canonical-JSON form of `sections`. */
  readonly structureSha256: string;
}

/**
 * Idempotent: SELECT first on (template_code, version_number); INSERT +
 * audit anchor only when missing. The seeded payload (PI-clean per
 * T-I10) carries `templateVersionId + templateCode + version +
 * statusVocab + sectionCount + structureSha256`. NEVER section text.
 */
export async function seedInspectionTemplates(
  db: ReturnType<typeof getDb>,
): Promise<{ inserted: number; skipped: number }> {
  const inputs = collectSeedInputs();
  let inserted = 0;
  let skipped = 0;
  for (const input of inputs) {
    const written = await db.transaction(async (tx) => {
      const existing = (await tx.execute(sql`
        SELECT id FROM inspection_templates
        WHERE template_code = ${input.templateCode}
          AND version_number = ${input.versionNumber}
        LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      if (existing[0]) return null;

      const row = (await tx.execute(sql`
        INSERT INTO inspection_templates (
          template_code, version_number, status_vocab, display_name,
          cadence, sections, requires_three_signatures, created_by_user_id
        )
        VALUES (
          ${input.templateCode}, ${input.versionNumber}, ${input.statusVocab},
          ${input.displayName}, ${input.cadence},
          ${JSON.stringify(input.sections)}::jsonb,
          ${input.requiresThreeSignatures}, NULL
        )
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      const templateVersionId = row[0]!.id;

      await append(tx, {
        actorId: SYSTEM_ACTOR_ID,
        payload: {
          kind: 'audit.inspection_template.seeded',
          templateCode: input.templateCode,
          templateVersionId,
          version: input.versionNumber,
          statusVocab: input.statusVocab,
          sectionCount: input.sections.length,
          structureSha256: input.structureSha256,
        },
        resourceType: 'inspection_templates',
        resourceId: templateVersionId,
      });
      return templateVersionId;
    });
    if (written) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}

/**
 * S1 SKELETON: returns the two seeded-template stubs with a non-empty
 * `sections` payload so the SQL CHECK passes when the seeder runs
 * against a real DB. The placeholder section keeps the shape obvious
 * to readers (single section, single item, no real content) and is
 * replaced wholesale in S2 with the worker-authored Zone Monthly
 * checklist and the CSA-safe rack inspection structure.
 */
function collectSeedInputs(): ReadonlyArray<SeedTemplateInput> {
  // TODO(S2): replace placeholder sections with the authored Zone
  // Monthly v1 structure (14 sections + Employee Interview closer,
  // ABC_X vocab) — see ADR-0007 §3.4 + templates/inspection-zone-
  // monthly.md (to be created).
  const zoneMonthly: SeedTemplateInput = {
    templateCode: 'zone_monthly',
    versionNumber: 1,
    displayName: 'Zone Monthly',
    statusVocab: 'ABC_X',
    cadence: 'monthly',
    requiresThreeSignatures: false,
    sections: [{ key: '__placeholder__', label: 'placeholder', items: [] }],
    structureSha256: 'PLACEHOLDER_STRUCTURE_SHA_FILLED_IN_S2',
  };

  // TODO(S2): replace placeholder sections with the CSA-safe rack
  // inspection structure (4 sections, GAR vocab) — clause numbers +
  // commonplace section headings + ORIGINAL-LANGUAGE summaries
  // authored by the project. NO verbatim CSA A344 text. See ADR-0007
  // §3.4 and SECURITY.md T-I8 / T-I9 / T-I10 for the copyright posture
  // this seed enforces — a two-person review gate covers any change.
  const rackInspection: SeedTemplateInput = {
    templateCode: 'rack_inspection',
    versionNumber: 1,
    displayName: 'Rack Inspection',
    statusVocab: 'GAR',
    cadence: 'annual',
    requiresThreeSignatures: true,
    sections: [{ key: '__placeholder__', label: 'placeholder', items: [] }],
    structureSha256: 'PLACEHOLDER_STRUCTURE_SHA_FILLED_IN_S2',
  };

  return [zoneMonthly, rackInspection];
}

async function main(): Promise<void> {
  const db = getDb();
  const { inserted, skipped } = await seedInspectionTemplates(db);
  process.stdout.write(`seed-inspection-templates: inserted=${inserted} skipped=${skipped}\n`);
}

// Only run when invoked directly, not when imported by tests / S2 routes.
if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `seed-inspection-templates failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
