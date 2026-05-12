#!/usr/bin/env node
// Seed the legal corpus (OHSA, O. Reg. 851, CLC Part II, COHSR subset).
//
// Placeholder for Milestone 1.4. Real implementation will read versioned
// corpus entries from packages/legal-corpus and upsert into the database.
// Every entry must carry source_url, version_date, and verified_by per
// CLAUDE.md § Legal Reference Module Rules.

function main(): void {
  console.warn('[seed-legal-corpus] Not yet implemented. See ROADMAP.md Milestone 1.4.');
}

main();

export {};
