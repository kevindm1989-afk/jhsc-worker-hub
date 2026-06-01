#!/usr/bin/env node
// Seed the inspection templates (Zone Monthly v1 + Rack Inspection v1).
//
// SLICE 1 STATUS: skeleton only. The runnable seeder + the audit-chain
// anchor emission live in `apps/api/scripts/seed-inspection-templates.ts`
// (Bun + Drizzle + @jhsc/audit). This root-level entry exists for parity
// with `scripts/seed-legal-corpus.ts` and points operators at the real
// script. The S2 milestone will land the worker-authored Zone Monthly
// section content + the CSA-safe rack inspection structure (clause
// numbers + headings + original-language summaries — NEVER verbatim
// CSA text per CLAUDE.md §"Legal Reference Module Rules" §5).

function main(): void {
  console.warn(
    '[seed-inspection-templates] Run apps/api/scripts/seed-inspection-templates.ts via `bun run`. S2 lands the section content; S1 ships the schema + skeleton.',
  );
}

main();

export {};
