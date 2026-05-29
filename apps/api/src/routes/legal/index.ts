// /api/legal/* — read-only routes over the legal corpus (ADR-0003).
//
// Public (no auth required): the corpus is reference material. T-LC8
// bounds what each route returns — search projects only
// (id, citation, version_date, heading, body_kind, snippet); clause read
// returns body for crown_copyright_open + redirects to source_url for
// third_party_restricted summary rows.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db/client';
import { rateLimit } from '../../middleware/rate-limit';

export const legalRoute = new Hono();

// sec-F4: /api/legal/* is public — no auth, no CSRF gating on GETs.
// ts_headline on /search is the most expensive query in the API, so
// the limit is the tightest. /clauses and /statutes are cheaper but
// share the same trust posture, so they get a more generous bucket.
legalRoute.use('/search', rateLimit({ name: 'legal.search', capacity: 20, refillPerSecond: 5 }));
legalRoute.use(
  '/clauses/*',
  rateLimit({ name: 'legal.clauses', capacity: 60, refillPerSecond: 20 }),
);
legalRoute.use('/clauses', rateLimit({ name: 'legal.clauses', capacity: 60, refillPerSecond: 20 }));
legalRoute.use(
  '/statutes',
  rateLimit({ name: 'legal.statutes', capacity: 60, refillPerSecond: 20 }),
);

// ---------------------------------------------------------------------------
// Active-version resolver
// ---------------------------------------------------------------------------
// Active corpus version = MAX(activated_at) WHERE retired_at IS NULL. The
// version tag is reported in responses so clients can pin a recommendation
// against the corpus state that was current at draft time, but the
// *filtering* of clauses below is keyed on `superseded_by IS NULL` not on
// the version tag — see sec-review F5. Filtering on corpus_version turned
// a partial re-seed (operator forgets to copy CLC-II/COHSR fixtures) into
// silent invisibility of every clause under those statutes, with every
// recommendation that cites them rendering MissingCitation. Filtering on
// `superseded_by IS NULL` matches the hash-anchored historical model
// (ADR-0003): old fixtures stay readable; an amendment supersedes the
// prior row by pointer, not by version-tag aging.

async function activeVersion(): Promise<string | null> {
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT version FROM corpus_versions
    WHERE retired_at IS NULL
    ORDER BY activated_at DESC LIMIT 1
  `)) as unknown as Array<{ version: string }>;
  return rows[0]?.version ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/legal/statutes
// ---------------------------------------------------------------------------

legalRoute.get('/statutes', async (c) => {
  const version = await activeVersion();
  const db = getDb();
  // List every statute that has at least one non-superseded clause. This
  // is the correct "active" definition under the hash-anchored model
  // (sec-F5) — statutes whose corpus_version tag aged out but whose
  // clauses are still current stay visible.
  const rows = (await db.execute(sql`
    SELECT s.id, s.code, s.jurisdiction, s.title, s.licence, s.source_url
    FROM statutes s
    WHERE EXISTS (
      SELECT 1 FROM clauses c
      WHERE c.statute_id = s.id AND c.superseded_by IS NULL
    )
    ORDER BY s.jurisdiction, s.code
  `)) as unknown as Array<{
    id: string;
    code: string;
    jurisdiction: string;
    title: string;
    licence: string;
    source_url: string;
  }>;
  return c.json({
    activeVersion: version,
    items: rows.map((r) => ({
      id: r.id,
      code: r.code,
      jurisdiction: r.jurisdiction,
      title: r.title,
      licence: r.licence,
      sourceUrl: r.source_url,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/legal/clauses
//   ?statute=OHSA&citation=s.9(20)        — by (code, citation) at active version
//   ?statute=OHSA                          — list one statute's clauses
// ---------------------------------------------------------------------------

const clausesQuery = z.object({
  statute: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9._-]+$/, 'invalid statute code'),
  citation: z.string().min(1).max(128).optional(),
});

legalRoute.get('/clauses', async (c) => {
  const parsed = clausesQuery.safeParse({
    statute: c.req.query('statute'),
    citation: c.req.query('citation'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const { statute, citation } = parsed.data;
  const db = getDb();
  // Filter on superseded_by IS NULL rather than corpus_version = active
  // tag — sec-review F5. A re-seed that drops a fixture file leaves its
  // clauses alive (no superseded_by pointer) so /api/legal stays
  // consistent across partial re-seeds.
  const rows = citation
    ? ((await db.execute(sql`
        SELECT c.id, c.citation, c.hierarchy_path, c.heading, c.body, c.body_summary,
               c.body_kind, c.version_date::text AS version_date,
               encode(c.body_hash, 'hex') AS body_hash, c.source_url,
               s.code AS statute_code, s.licence AS statute_licence, s.title AS statute_title,
               c.superseded_by
        FROM clauses c
        JOIN statutes s ON s.id = c.statute_id
        WHERE s.code = ${statute}
          AND c.citation = ${citation}
          AND c.superseded_by IS NULL
        LIMIT 1
      `)) as unknown as Array<RawClauseRow>)
    : ((await db.execute(sql`
        SELECT c.id, c.citation, c.hierarchy_path, c.heading, c.body, c.body_summary,
               c.body_kind, c.version_date::text AS version_date,
               encode(c.body_hash, 'hex') AS body_hash, c.source_url,
               s.code AS statute_code, s.licence AS statute_licence, s.title AS statute_title,
               c.superseded_by
        FROM clauses c
        JOIN statutes s ON s.id = c.statute_id
        WHERE s.code = ${statute}
          AND c.superseded_by IS NULL
        ORDER BY c.citation
      `)) as unknown as Array<RawClauseRow>);
  return c.json({ items: rows.map(projectClause) });
});

// ---------------------------------------------------------------------------
// GET /api/legal/clauses/:id — single clause by UUID
// ---------------------------------------------------------------------------

const uuidParam = z
  .string()
  .uuid('invalid clause id')
  .transform((s) => s.toLowerCase());

legalRoute.get('/clauses/:id', async (c) => {
  const parsed = uuidParam.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'invalid_id' }, 400);
  }
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT c.id, c.citation, c.hierarchy_path, c.heading, c.body, c.body_summary,
           c.body_kind, c.version_date::text AS version_date,
           encode(c.body_hash, 'hex') AS body_hash, c.source_url,
           s.code AS statute_code, s.licence AS statute_licence, s.title AS statute_title,
           c.superseded_by
    FROM clauses c
    JOIN statutes s ON s.id = c.statute_id
    WHERE c.id = ${parsed.data}
    LIMIT 1
  `)) as unknown as Array<RawClauseRow>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  return c.json(projectClause(rows[0]!));
});

// ---------------------------------------------------------------------------
// GET /api/legal/search?q=...
// ---------------------------------------------------------------------------

const searchQuery = z.object({
  q: z.string().min(2, 'query must be at least 2 chars').max(128),
  statute: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9._-]+$/, 'invalid statute code')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

legalRoute.get('/search', async (c) => {
  const parsed = searchQuery.safeParse({
    q: c.req.query('q'),
    statute: c.req.query('statute'),
    limit: c.req.query('limit'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const version = await activeVersion();
  const { q, statute, limit } = parsed.data;
  const db = getDb();
  // plainto_tsquery handles arbitrary user text safely (no injection into
  // the query language) and returns AND-ed lexemes. We use the simple
  // form rather than websearch_to_tsquery so the user input pattern
  // matches what postgres builds for the GIN-indexed `english` config.
  //
  // ts_headline echoes its input verbatim around the <mark>...</mark>
  // markers; if a fixture body ever contains `<` or `>` it would round-trip
  // into the snippet HTML. The Zod fixture schema (sec-F1) rejects those
  // chars at seed time AND the web renderer parses on the literal
  // <mark>...</mark> markers via a strict regex (not raw innerHTML), so
  // both layers have to fail for XSS to land.
  //
  // ts_headline source is licence-aware: crown_copyright_open uses
  // (heading || body), third_party_restricted uses (heading || body_summary)
  // — T-LC8. The search_tsv column itself is now licence-aware too
  // (migration 0003 / sec-F6) so the FTS index for restricted rows does
  // not embed the verbatim body lexemes.
  const rows = (await db.execute(sql`
    SELECT c.id, s.code AS statute_code, c.citation, c.heading, c.body_kind,
           c.version_date::text AS version_date,
           ts_rank(c.search_tsv, plainto_tsquery('english', ${q})) AS rank,
           CASE
             WHEN s.licence = 'crown_copyright_open' THEN
               ts_headline('english', coalesce(c.heading,'') || E'\n' || c.body,
                 plainto_tsquery('english', ${q}),
                 'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MinWords=4,MaxWords=20')
             ELSE
               ts_headline('english', coalesce(c.heading,'') || E'\n' || coalesce(c.body_summary,''),
                 plainto_tsquery('english', ${q}),
                 'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MinWords=4,MaxWords=20')
           END AS snippet
    FROM clauses c
    JOIN statutes s ON s.id = c.statute_id
    WHERE c.superseded_by IS NULL
      AND c.search_tsv @@ plainto_tsquery('english', ${q})
      ${statute ? sql`AND s.code = ${statute}` : sql``}
    ORDER BY rank DESC, s.code, c.citation
    LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    statute_code: string;
    citation: string;
    heading: string | null;
    body_kind: string;
    version_date: string;
    rank: number;
    snippet: string;
  }>;
  return c.json({
    query: q,
    activeVersion: version,
    items: rows.map((r) => ({
      id: r.id,
      statuteCode: r.statute_code,
      citation: r.citation,
      heading: r.heading,
      bodyKind: r.body_kind,
      versionDate: r.version_date,
      rank: Number(r.rank),
      snippet: r.snippet,
    })),
  });
});

// ---------------------------------------------------------------------------
// Shared row → response projection
// ---------------------------------------------------------------------------

interface RawClauseRow {
  id: string;
  citation: string;
  hierarchy_path: string[];
  heading: string | null;
  body: string;
  body_summary: string | null;
  body_kind: string;
  version_date: string;
  body_hash: string;
  source_url: string;
  statute_code: string;
  statute_licence: string;
  statute_title: string;
  superseded_by: string | null;
}

interface ClauseDto {
  readonly id: string;
  readonly statute: { readonly code: string; readonly title: string; readonly licence: string };
  readonly citation: string;
  readonly hierarchyPath: ReadonlyArray<string>;
  readonly heading: string | null;
  /** Verbatim text for body_kind='full_text'; null for body_kind='summary' (read sourceUrl). */
  readonly body: string | null;
  /** JHSC paraphrase for body_kind='summary'; null for full_text. */
  readonly bodySummary: string | null;
  readonly bodyKind: 'full_text' | 'summary';
  readonly bodyHash: string;
  readonly versionDate: string;
  readonly sourceUrl: string;
  readonly supersededBy: string | null;
}

// T-LC8 projection: for body_kind='summary', body is the paraphrase
// (stored in body and body_summary as a duplicate by convention -- we
// surface body_summary explicitly). For body_kind='full_text' we surface
// `body`. We never return the verbatim third-party text from the API,
// because the seeder refuses to write it in the first place; this
// projection is the defensive layer over future schema changes.
function projectClause(r: RawClauseRow): ClauseDto {
  const kind = r.body_kind === 'summary' ? ('summary' as const) : ('full_text' as const);
  return {
    id: r.id,
    statute: { code: r.statute_code, title: r.statute_title, licence: r.statute_licence },
    citation: r.citation,
    hierarchyPath: r.hierarchy_path,
    heading: r.heading,
    body: kind === 'full_text' ? r.body : null,
    bodySummary: kind === 'summary' ? r.body_summary : null,
    bodyKind: kind,
    bodyHash: r.body_hash,
    versionDate: r.version_date,
    sourceUrl: r.source_url,
    supersededBy: r.superseded_by,
  };
}
