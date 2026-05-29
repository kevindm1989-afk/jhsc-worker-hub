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

export const legalRoute = new Hono();

// ---------------------------------------------------------------------------
// Active-version resolver
// ---------------------------------------------------------------------------
// Active version = MAX(activated_at) WHERE retired_at IS NULL. Cached per
// request via Hono context; cheap enough to look up on every request and
// the only thing the cache buys us is avoiding a duplicate read inside the
// same handler that touches both statutes and clauses.

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
  if (!version) return c.json({ items: [], activeVersion: null });
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, code, jurisdiction, title, licence, source_url
    FROM statutes
    WHERE corpus_version = ${version}
    ORDER BY jurisdiction, code
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
  const version = await activeVersion();
  if (!version) return c.json({ items: [] });
  const { statute, citation } = parsed.data;
  const db = getDb();
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
          AND c.corpus_version = ${version}
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
          AND c.corpus_version = ${version}
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
  if (!version) return c.json({ items: [] });
  const { q, statute, limit } = parsed.data;
  const db = getDb();
  // plainto_tsquery handles arbitrary user text safely (no injection into
  // the query language) and returns AND-ed lexemes. We use the simple
  // form rather than websearch_to_tsquery so the user input pattern
  // matches what postgres builds for the GIN-indexed `english` config.
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
    WHERE c.corpus_version = ${version}
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
