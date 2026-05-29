#!/usr/bin/env bun
// Milestone 1.4 (ADR-0003) seeder for the legal corpus.
//
// Reads every *.toml under packages/legal-corpus/seed/, validates each
// fixture, runs the structural copyright + summary guards, and inserts
// rows into corpus_versions + statutes + clauses in a single transaction.
// Emits `audit.corpus.seeded` on success.
//
// Idempotent on (statute_id, citation, version_date): re-running with the
// same fixtures hits the UNIQUE constraint and aborts cleanly. To publish
// an amendment, add a clause row with a later version_date — the seeder
// inserts it, points superseded_by from the prior row to the new one, and
// emits `audit.corpus.amended`.
//
// Usage:
//   DATABASE_URL=... bun run apps/api/scripts/seed-legal-corpus.ts [--version v2026-05-29] [--note "..."]

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { parse as parseToml } from 'smol-toml';
import {
  bodyHashHex,
  checkCopyrightGuard,
  checkSummaryGuard,
  computeBodyHash,
  normalizeVersionDate,
  statuteFixtureSchema,
  type StatuteFixture,
} from '@jhsc/legal-corpus';
import { append } from '@jhsc/audit';
import { clauses, corpusVersions, statutes } from '../src/db/schema';
import { getDb } from '../src/db/client';

const FIXTURE_DIR = join(import.meta.dir, '..', '..', '..', 'packages', 'legal-corpus', 'seed');

interface CliArgs {
  readonly version: string;
  readonly note: string | null;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let version: string | null = null;
  let note: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--version') version = argv[++i] ?? null;
    else if (a === '--note') note = argv[++i] ?? null;
  }
  if (!version) {
    // Default version tag = today's ISO date prefixed with v.
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    version = `v${yyyy}-${mm}-${dd}`;
  }
  return { version, note };
}

async function loadFixtures(): Promise<ReadonlyArray<StatuteFixture>> {
  const entries = await readdir(FIXTURE_DIR);
  const tomlFiles = entries.filter((f) => f.endsWith('.toml')).sort();
  const fixtures: StatuteFixture[] = [];
  for (const f of tomlFiles) {
    const path = join(FIXTURE_DIR, f);
    const raw = await readFile(path, 'utf8');
    const parsed = parseToml(raw);
    const result = statuteFixtureSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `fixture ${f} failed validation: ${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    fixtures.push(result.data);
  }
  return fixtures;
}

function fixtureSha256(fixtures: ReadonlyArray<StatuteFixture>): string {
  // Stable hash over the validated fixtures so the chain anchor pins the
  // exact text we loaded. We serialize via JSON with sorted keys.
  const stableKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stableKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = stableKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const canonical = JSON.stringify(stableKeys(fixtures));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const fixtures = await loadFixtures();

  // Guards before any DB work.
  for (const f of fixtures) {
    const copyright = checkCopyrightGuard(f);
    if (copyright.length > 0) {
      throw new Error(
        `copyright guard rejected ${f.code}: ${copyright
          .map((v) => `${v.citation} (${v.reason})`)
          .join(', ')}`,
      );
    }
    const summary = checkSummaryGuard(f);
    if (summary.length > 0) {
      throw new Error(
        `summary guard rejected ${f.code}: ${summary
          .map((v) => `${v.citation} (${v.reason})`)
          .join(', ')}`,
      );
    }
  }

  const fxSha = fixtureSha256(fixtures);
  const totalClauseCount = fixtures.reduce((n, f) => n + f.clauses.length, 0);
  const statuteCodes = fixtures.map((f) => f.code);

  const db = getDb();
  await db.transaction(async (tx) => {
    // Insert (or skip) corpus_versions row.
    const existing = (await tx.execute(sql`
      SELECT version FROM ${corpusVersions} WHERE version = ${args.version}
    `)) as unknown as Array<{ version: string }>;
    if (existing.length > 0) {
      throw new Error(
        `corpus_versions already has version ${args.version}; pass --version with a new tag`,
      );
    }
    await tx.insert(corpusVersions).values({
      version: args.version,
      fixtureSha256: Buffer.from(fxSha, 'hex') as unknown as Uint8Array,
      note: args.note,
    });

    for (const f of fixtures) {
      // Upsert statute by code; new corpus_version replaces the pointer
      // so <CitationRef /> resolves against the active version.
      const existingStatute = (await tx.execute(sql`
        SELECT id FROM ${statutes} WHERE code = ${f.code}
      `)) as unknown as Array<{ id: string }>;
      let statuteId: string;
      if (existingStatute[0]) {
        statuteId = existingStatute[0].id;
        await tx.execute(sql`
          UPDATE ${statutes}
          SET title = ${f.title},
              jurisdiction = ${f.jurisdiction},
              licence = ${f.licence},
              source_url = ${f.source_url},
              corpus_version = ${args.version}
          WHERE id = ${statuteId}
        `);
      } else {
        const inserted = (await tx.execute(sql`
          INSERT INTO ${statutes} (code, jurisdiction, title, licence, source_url, corpus_version)
          VALUES (${f.code}, ${f.jurisdiction}, ${f.title}, ${f.licence}, ${f.source_url}, ${args.version})
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        statuteId = inserted[0]!.id;
      }

      for (const c of f.clauses) {
        const versionDate = normalizeVersionDate(c.version_date);
        const bodyHash = computeBodyHash(c.body, versionDate);
        // Check whether (statute_id, citation, version_date) already exists.
        // If yes — skip (idempotent re-seed). If a row exists for the same
        // (statute_id, citation) at an earlier version_date and not yet
        // superseded, set superseded_by + emit audit.corpus.amended.
        const dupe = (await tx.execute(sql`
          SELECT id FROM ${clauses}
          WHERE statute_id = ${statuteId} AND citation = ${c.citation} AND version_date = ${versionDate}
        `)) as unknown as Array<{ id: string }>;
        if (dupe[0]) {
          continue;
        }

        const prior = (await tx.execute(sql`
          SELECT id, version_date::text AS version_date FROM ${clauses}
          WHERE statute_id = ${statuteId} AND citation = ${c.citation}
            AND superseded_by IS NULL
          ORDER BY version_date DESC LIMIT 1
        `)) as unknown as Array<{ id: string; version_date: string }>;

        const inserted = (await tx.execute(sql`
          INSERT INTO ${clauses} (
            statute_id, citation, hierarchy_path, heading, body, body_summary,
            body_kind, body_hash, version_date, verified_by, source_url, corpus_version
          )
          VALUES (
            ${statuteId}, ${c.citation}, ${sql.raw(`ARRAY[${c.hierarchy_path.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')}]::text[]`)},
            ${c.heading ?? null}, ${c.body}, ${c.body_summary ?? null},
            ${c.body_kind}, ${Buffer.from(bodyHash) as unknown as Uint8Array},
            ${versionDate}, ${c.verified_by}, ${c.source_url}, ${args.version}
          )
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        const newClauseId = inserted[0]!.id;

        if (prior[0]) {
          await tx.execute(sql`
            UPDATE ${clauses} SET superseded_by = ${newClauseId} WHERE id = ${prior[0].id}
          `);
          await append(tx, {
            payload: {
              kind: 'audit.corpus.amended',
              version: args.version,
              statuteCode: f.code,
              citation: c.citation,
              priorVersionDate: prior[0].version_date,
              newVersionDate: versionDate,
            },
            resourceType: 'clauses',
            resourceId: newClauseId,
          });
        }

        // Sanity: hash we just stored matches recomputation. Cheap defence
        // against a future column-default bug.
        const stored = (await tx.execute(sql`
          SELECT encode(body_hash, 'hex') AS h FROM ${clauses} WHERE id = ${newClauseId}
        `)) as unknown as Array<{ h: string }>;
        if (stored[0]!.h !== bodyHashHex(c.body, versionDate)) {
          throw new Error(`body_hash mismatch for ${f.code} ${c.citation}`);
        }
      }
    }

    // One chain anchor per seed run.
    await append(tx, {
      payload: {
        kind: 'audit.corpus.seeded',
        version: args.version,
        statutes: statuteCodes,
        clauseCount: totalClauseCount,
        fixtureSha256: fxSha,
      },
      resourceType: 'corpus_versions',
      resourceId: args.version,
    });
  });

  process.stdout.write(
    `seeded corpus ${args.version}: ${statuteCodes.length} statutes, ${totalClauseCount} clauses, fixture_sha256=${fxSha}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`seed-legal-corpus failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
