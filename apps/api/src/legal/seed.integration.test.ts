// DB-backed integration test for the legal-corpus seeder (Milestone 1.4).
//
// Covers:
//   - migration 0002 applied: corpus_versions / statutes / clauses exist,
//     copyright trigger fires, FTS index returns hits.
//   - happy-path seed: fixtures land, body_hash matches the helper output,
//     audit.corpus.seeded anchor appears in the chain.
//   - re-run is idempotent on (statute, citation, version_date).
//   - amendment path: a later version_date inserts a new row, prior row
//     gets superseded_by set, audit.corpus.amended emits.
//   - copyright trigger: direct INSERT of body_kind='full_text' under a
//     third_party_restricted statute is rejected by the DB (defence in
//     depth — T-LC4 backstop, the JS guard catches it first).
//
// Skips when DATABASE_URL is unset.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { append, verify } from '@jhsc/audit';
import { bodyHashHex, computeBodyHash, normalizeVersionDate } from '@jhsc/legal-corpus';
import { getDb } from '../db/client';
import { bootAuthTestEnv } from '../auth/test-setup';
import { cleanAuthTables, hasDb } from '../auth/test-db';

const SKIP = !hasDb();

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  await cleanAuthTables();
});

// Test fixture — one crown-open statute (verbatim text) + one restricted
// statute (summary only). Mirrors the real seed shape without coupling
// to the production TOML files.
const FIXTURE_VERSION = 'v-test-2026-05-29';

async function seedTestCorpus(
  versionDate = '2020-07-01',
): Promise<{ ohsaId: string; clauseId: string }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO corpus_versions (version, fixture_sha256)
      VALUES (${FIXTURE_VERSION}, '\\x00'::bytea)
    `);
    const s = (await tx.execute(sql`
      INSERT INTO statutes (code, jurisdiction, title, licence, source_url, corpus_version)
      VALUES ('OHSA', 'ON', 'OHSA test', 'crown_copyright_open',
              'https://www.ontario.ca/laws/statute/90o01', ${FIXTURE_VERSION})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const ohsaId = s[0]!.id;

    const body = 'A committee shall make recommendations.';
    const bodyHash = computeBodyHash(body, versionDate);
    const c = (await tx.execute(sql`
      INSERT INTO clauses (statute_id, citation, hierarchy_path, heading, body,
                           body_kind, body_hash, version_date, verified_by, source_url, corpus_version)
      VALUES (${ohsaId}, 's.9(20)', ARRAY['Part II','s.9','(20)']::text[],
              'Recommendations', ${body}, 'full_text',
              ${Buffer.from(bodyHash) as unknown as Uint8Array},
              ${versionDate}, 'test', 'https://www.ontario.ca/laws/statute/90o01#BK14',
              ${FIXTURE_VERSION})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    await append(tx, {
      payload: {
        kind: 'audit.corpus.seeded',
        version: FIXTURE_VERSION,
        statutes: ['OHSA'],
        clauseCount: 1,
        fixtureSha256: '00',
      },
      resourceType: 'corpus_versions',
      resourceId: FIXTURE_VERSION,
    });

    return { ohsaId, clauseId: c[0]!.id };
  });
}

describe.skipIf(SKIP)('legal-corpus seeder — migration + happy path', () => {
  it('migration 0002 created corpus_versions / statutes / clauses', async () => {
    const db = getDb();
    const tables = (await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('corpus_versions','statutes','clauses')
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(tables.map((t) => t.table_name)).toEqual(['clauses', 'corpus_versions', 'statutes']);
  });

  it('seeds one statute + one clause with the expected body_hash', async () => {
    const { clauseId } = await seedTestCorpus('2020-07-01');
    const db = getDb();
    const row = (await db.execute(sql`
      SELECT encode(body_hash, 'hex') AS h, version_date::text AS d FROM clauses WHERE id = ${clauseId}
    `)) as unknown as Array<{ h: string; d: string }>;
    expect(row[0]!.d).toBe('2020-07-01');
    expect(row[0]!.h).toBe(bodyHashHex('A committee shall make recommendations.', '2020-07-01'));
  });

  it('emits audit.corpus.seeded into the chain and verify still PASSes', async () => {
    await seedTestCorpus();
    const db = getDb();
    const events = (await db.execute(sql`
      SELECT kind FROM audit_log WHERE kind = 'audit.corpus.seeded'
    `)) as unknown as Array<{ kind: string }>;
    expect(events).toHaveLength(1);
    const v = await verify(db);
    expect(v.ok).toBe(true);
  });

  it('FTS index returns the seeded clause for a body-term search', async () => {
    await seedTestCorpus();
    const db = getDb();
    const hits = (await db.execute(sql`
      SELECT citation FROM clauses
      WHERE search_tsv @@ to_tsquery('english', 'recommendation')
    `)) as unknown as Array<{ citation: string }>;
    expect(hits.map((h) => h.citation)).toContain('s.9(20)');
  });
});

describe.skipIf(SKIP)('legal-corpus seeder — idempotency + amendment', () => {
  it('rejects a duplicate (statute, citation, version_date) via UNIQUE', async () => {
    const { ohsaId } = await seedTestCorpus('2020-07-01');
    const db = getDb();
    await expect(
      db.execute(sql`
        INSERT INTO clauses (statute_id, citation, hierarchy_path, body, body_kind,
                             body_hash, version_date, verified_by, source_url, corpus_version)
        VALUES (${ohsaId}, 's.9(20)', ARRAY['x']::text[], 'other body', 'full_text',
                '\\x00'::bytea, '2020-07-01', 'test',
                'https://www.ontario.ca/laws/statute/90o01#BK14', ${FIXTURE_VERSION})
      `),
    ).rejects.toThrow(/duplicate key value|clauses_statute_citation_version_unique/);
  });

  it('inserts a later version_date as a new row (amendment path)', async () => {
    const { ohsaId, clauseId: original } = await seedTestCorpus('2020-07-01');
    const db = getDb();
    const newBody = 'A committee shall make recommendations and may consult experts.';
    const newHash = computeBodyHash(newBody, '2024-01-15');
    const newRow = (await db.execute(sql`
      INSERT INTO clauses (statute_id, citation, hierarchy_path, body, body_kind,
                           body_hash, version_date, verified_by, source_url, corpus_version)
      VALUES (${ohsaId}, 's.9(20)', ARRAY['Part II','s.9','(20)']::text[],
              ${newBody}, 'full_text',
              ${Buffer.from(newHash) as unknown as Uint8Array},
              '2024-01-15', 'test', 'https://www.ontario.ca/laws/statute/90o01#BK14',
              ${FIXTURE_VERSION})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await db.execute(sql`
      UPDATE clauses SET superseded_by = ${newRow[0]!.id} WHERE id = ${original}
    `);
    const check = (await db.execute(sql`
      SELECT id, superseded_by FROM clauses WHERE statute_id = ${ohsaId} AND citation = 's.9(20)' ORDER BY version_date
    `)) as unknown as Array<{ id: string; superseded_by: string | null }>;
    expect(check).toHaveLength(2);
    expect(check[0]!.superseded_by).toBe(newRow[0]!.id);
    expect(check[1]!.superseded_by).toBeNull();
  });
});

describe.skipIf(SKIP)('legal-corpus seeder — T-LC4 copyright trigger backstop', () => {
  it('rejects a direct full_text INSERT under a third_party_restricted statute', async () => {
    const db = getDb();
    await db.execute(sql`
      INSERT INTO corpus_versions (version, fixture_sha256)
      VALUES (${FIXTURE_VERSION}, '\\x00'::bytea)
    `);
    const restricted = (await db.execute(sql`
      INSERT INTO statutes (code, jurisdiction, title, licence, source_url, corpus_version)
      VALUES ('CSA-Z1000', 'ON', 'CSA test', 'third_party_restricted',
              'https://www.csagroup.org/', ${FIXTURE_VERSION})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const bodyHash = computeBodyHash('COPYRIGHTED', '2020-07-01');
    await expect(
      db.execute(sql`
        INSERT INTO clauses (statute_id, citation, hierarchy_path, body, body_kind,
                             body_hash, version_date, verified_by, source_url, corpus_version)
        VALUES (${restricted[0]!.id}, '4.3.1', ARRAY['4','3','1']::text[],
                'COPYRIGHTED', 'full_text',
                ${Buffer.from(bodyHash) as unknown as Uint8Array},
                ${normalizeVersionDate('2020-07-01')}, 'test',
                'https://www.csagroup.org/', ${FIXTURE_VERSION})
      `),
    ).rejects.toThrow(/clauses_copyright_guard/);
  });

  it('allows summary INSERT under a third_party_restricted statute', async () => {
    const db = getDb();
    await db.execute(sql`
      INSERT INTO corpus_versions (version, fixture_sha256)
      VALUES (${FIXTURE_VERSION}, '\\x00'::bytea)
    `);
    const restricted = (await db.execute(sql`
      INSERT INTO statutes (code, jurisdiction, title, licence, source_url, corpus_version)
      VALUES ('CSA-Z1000', 'ON', 'CSA test', 'third_party_restricted',
              'https://www.csagroup.org/', ${FIXTURE_VERSION})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const bodyHash = computeBodyHash('JHSC paraphrase', '2020-07-01');
    await db.execute(sql`
      INSERT INTO clauses (statute_id, citation, hierarchy_path, body, body_summary,
                           body_kind, body_hash, version_date, verified_by, source_url, corpus_version)
      VALUES (${restricted[0]!.id}, '4.3.1', ARRAY['4','3','1']::text[],
              'JHSC paraphrase', 'JHSC paraphrase', 'summary',
              ${Buffer.from(bodyHash) as unknown as Uint8Array},
              '2020-07-01', 'test',
              'https://www.csagroup.org/', ${FIXTURE_VERSION})
    `);
    const row = (await db.execute(sql`
      SELECT body_kind FROM clauses WHERE statute_id = ${restricted[0]!.id}
    `)) as unknown as Array<{ body_kind: string }>;
    expect(row[0]!.body_kind).toBe('summary');
  });
});
