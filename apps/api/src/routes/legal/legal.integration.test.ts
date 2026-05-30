// Integration tests for /api/legal/{statutes,clauses,search}.
// Skips when DATABASE_URL is unset.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { append } from '@jhsc/audit';
import { computeBodyHash } from '@jhsc/legal-corpus';
import { app } from '../../index';
import { getDb } from '../../db/client';
import { bootAuthTestEnv } from '../../auth/test-setup';
import { cleanAuthTables, hasDb } from '../../auth/test-db';
import { _resetRateLimitForTests } from '../../middleware/rate-limit';

const SKIP = !hasDb();
const VERSION = 'v-legal-routes-test';

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  _resetRateLimitForTests();
  await cleanAuthTables();
  await seedThreeStatutes();
});

async function seedThreeStatutes(): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO corpus_versions (version, fixture_sha256)
      VALUES (${VERSION}, '\\x00'::bytea)
    `);

    // OHSA — crown_copyright_open, full_text
    const ohsa = (await tx.execute(sql`
      INSERT INTO statutes (code, jurisdiction, title, licence, source_url, corpus_version)
      VALUES ('OHSA', 'ON', 'Occupational Health and Safety Act',
              'crown_copyright_open', 'https://www.ontario.ca/laws/statute/90o01', ${VERSION})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const ohsaId = ohsa[0]!.id;

    const body920 = 'A committee shall make recommendations.';
    const hash920 = computeBodyHash(body920, '2020-07-01');
    await tx.execute(sql`
      INSERT INTO clauses (statute_id, citation, hierarchy_path, heading, body, body_kind,
                           body_hash, version_date, verified_by, source_url, corpus_version)
      VALUES (${ohsaId}, 's.9(20)', ARRAY['Part II','s.9','(20)']::text[],
              'Recommendations', ${body920}, 'full_text',
              ${Buffer.from(hash920) as unknown as Uint8Array},
              '2020-07-01', 'kdm', 'https://www.ontario.ca/laws/statute/90o01#BK14', ${VERSION})
    `);

    const body258h =
      'An employer shall take every precaution reasonable in the circumstances for the protection of a worker.';
    const hash258h = computeBodyHash(body258h, '2020-07-01');
    await tx.execute(sql`
      INSERT INTO clauses (statute_id, citation, hierarchy_path, heading, body, body_kind,
                           body_hash, version_date, verified_by, source_url, corpus_version)
      VALUES (${ohsaId}, 's.25(2)(h)', ARRAY['Part III','s.25','(2)','(h)']::text[],
              'Duties of employer', ${body258h}, 'full_text',
              ${Buffer.from(hash258h) as unknown as Uint8Array},
              '2020-07-01', 'kdm', 'https://www.ontario.ca/laws/statute/90o01#BK21', ${VERSION})
    `);

    // CSA-Z1000 — third_party_restricted, summary
    const csa = (await tx.execute(sql`
      INSERT INTO statutes (code, jurisdiction, title, licence, source_url, corpus_version)
      VALUES ('CSA-Z1000', 'CA', 'CSA Z1000 OHS Management',
              'third_party_restricted', 'https://www.csagroup.org/', ${VERSION})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const csaId = csa[0]!.id;

    const summary = 'Recommends a plan-do-check-act cycle for OHS management.';
    const hashSummary = computeBodyHash(summary, '2020-07-01');
    await tx.execute(sql`
      INSERT INTO clauses (statute_id, citation, hierarchy_path, heading, body, body_summary,
                           body_kind, body_hash, version_date, verified_by, source_url, corpus_version)
      VALUES (${csaId}, '4.3.1', ARRAY['4','3','1']::text[],
              'Management cycle', ${summary}, ${summary}, 'summary',
              ${Buffer.from(hashSummary) as unknown as Uint8Array},
              '2020-07-01', 'kdm', 'https://www.csagroup.org/', ${VERSION})
    `);

    await append(tx, {
      payload: {
        kind: 'audit.corpus.seeded',
        version: VERSION,
        statutes: ['OHSA', 'CSA-Z1000'],
        clauseCount: 3,
        fixtureSha256: '00',
      },
      resourceType: 'corpus_versions',
      resourceId: VERSION,
    });
  });
}

describe.skipIf(SKIP)('GET /api/legal/statutes', () => {
  it('lists active-corpus statutes', async () => {
    const res = await app.request('/api/legal/statutes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeVersion: string;
      items: Array<{ code: string; licence: string }>;
    };
    expect(body.activeVersion).toBe(VERSION);
    expect(body.items.map((i) => i.code).sort()).toEqual(['CSA-Z1000', 'OHSA']);
  });
});

describe.skipIf(SKIP)('GET /api/legal/clauses', () => {
  it('returns the clause for (statute, citation) at active version', async () => {
    const res = await app.request('/api/legal/clauses?statute=OHSA&citation=s.9%2820%29');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ citation: string; body: string | null }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.citation).toBe('s.9(20)');
    expect(body.items[0]!.body).toContain('committee');
  });

  it('lists all clauses for a statute when citation is omitted', async () => {
    const res = await app.request('/api/legal/clauses?statute=OHSA');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ citation: string }> };
    expect(body.items.map((i) => i.citation).sort()).toEqual(['s.25(2)(h)', 's.9(20)']);
  });

  it('rejects a malformed statute code with 400', async () => {
    const res = await app.request('/api/legal/clauses?statute=OHSA%20Act');
    expect(res.status).toBe(400);
  });

  it('T-LC8: redacts body and exposes bodySummary for restricted statutes', async () => {
    const res = await app.request('/api/legal/clauses?statute=CSA-Z1000&citation=4.3.1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ body: string | null; bodySummary: string | null; bodyKind: string }>;
    };
    expect(body.items[0]!.body).toBeNull();
    expect(body.items[0]!.bodySummary).toContain('plan-do-check-act');
    expect(body.items[0]!.bodyKind).toBe('summary');
  });
});

describe.skipIf(SKIP)('GET /api/legal/clauses/:id', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await app.request('/api/legal/clauses/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('rejects a non-UUID id with 400', async () => {
    const res = await app.request('/api/legal/clauses/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns the clause body for a crown_copyright_open hit', async () => {
    // First fetch the id via the by-citation route.
    const listRes = await app.request('/api/legal/clauses?statute=OHSA&citation=s.9%2820%29');
    const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
    const id = listBody.items[0]!.id;

    const res = await app.request(`/api/legal/clauses/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string | null; bodyHash: string };
    expect(body.body).toContain('committee');
    expect(body.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(SKIP)('GET /api/legal/search', () => {
  it('returns FTS hits with marked snippets', async () => {
    const res = await app.request('/api/legal/search?q=recommendations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ citation: string; snippet: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.some((i) => i.citation === 's.9(20)')).toBe(true);
    expect(body.items[0]!.snippet).toMatch(/<mark>/);
  });

  it('scopes search by statute when statute= is provided', async () => {
    const res = await app.request('/api/legal/search?q=management&statute=CSA-Z1000');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ statuteCode: string }> };
    expect(body.items.every((i) => i.statuteCode === 'CSA-Z1000')).toBe(true);
  });

  it('rejects a query shorter than 2 chars with 400', async () => {
    const res = await app.request('/api/legal/search?q=a');
    expect(res.status).toBe(400);
  });

  it('T-LC8 + sec-F6: restricted body text is neither indexed nor in the snippet', async () => {
    // Mark the restricted statute's body with a token that does NOT
    // appear in body_summary. Pre-migration-0003 the FTS index was built
    // from body, so this token was an oracle (search returns the clause
    // id; attacker confirms presence). Migration 0003 makes search_tsv
    // licence-aware: restricted rows are indexed from body_summary, so
    // the token is no longer queryable. Both defences should hold:
    //   (a) the token does not match the FTS query (sec-F6); AND
    //   (b) even if a future regression breaks (a), the snippet must
    //       still pull from body_summary, never body (T-LC8).
    const db = getDb();
    await db.execute(sql`
      UPDATE clauses
      SET body = body || ' XYZZYFORBIDDEN'
      WHERE statute_id = (SELECT id FROM statutes WHERE code = 'CSA-Z1000')
    `);
    const res = await app.request('/api/legal/search?q=XYZZYFORBIDDEN&statute=CSA-Z1000');
    const body = (await res.json()) as { items: Array<{ snippet: string }> };
    // (a) sec-F6: no FTS match because the index is built from body_summary only.
    expect(body.items).toHaveLength(0);
    // (b) T-LC8 belt-and-braces: any future match must not echo the body.
    for (const item of body.items) {
      expect(item.snippet).not.toContain('XYZZYFORBIDDEN');
    }
  });
});

describe.skipIf(SKIP)('rate limit (sec-F4)', () => {
  it('returns 429 after the /search bucket is drained', async () => {
    // The /search bucket capacity is 20; the 21st consecutive request
    // from the same IP (the test driver has no IP header, so the
    // limiter keys on the 'unknown' bucket) should be rejected.
    _resetRateLimitForTests();
    let firstRejection: Response | null = null;
    for (let i = 0; i < 25; i++) {
      const res = await app.request('/api/legal/search?q=committee');
      if (res.status === 429) {
        firstRejection = res;
        break;
      }
    }
    expect(firstRejection).not.toBeNull();
    expect(firstRejection!.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
