// Typed client for /api/legal/*. Public endpoints — no
// credentials/CSRF header needed.

const BASE = '/api/legal';

export interface LegalStatute {
  readonly id: string;
  readonly code: string;
  readonly jurisdiction: string;
  readonly title: string;
  readonly licence: 'crown_copyright_open' | 'third_party_restricted';
  readonly sourceUrl: string;
}

export interface LegalClause {
  readonly id: string;
  readonly statute: { readonly code: string; readonly title: string; readonly licence: string };
  readonly citation: string;
  readonly hierarchyPath: ReadonlyArray<string>;
  readonly heading: string | null;
  readonly body: string | null;
  readonly bodySummary: string | null;
  readonly bodyKind: 'full_text' | 'summary';
  readonly bodyHash: string;
  readonly versionDate: string;
  readonly sourceUrl: string;
  readonly supersededBy: string | null;
}

export interface LegalSearchHit {
  readonly id: string;
  readonly statuteCode: string;
  readonly citation: string;
  readonly heading: string | null;
  readonly bodyKind: 'full_text' | 'summary';
  readonly versionDate: string;
  readonly rank: number;
  readonly snippet: string;
}

async function json<T>(path: string): Promise<T> {
  // priv-F6: /api/legal is intentionally public; we don't want the auth
  // cookies riding these requests where they have no effect but show up
  // in any header capture downstream of the request pipeline.
  const res = await fetch(`${BASE}${path}`, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`legal api ${res.status}: ${path}`);
  }
  return (await res.json()) as T;
}

export const legalApi = {
  listStatutes: () =>
    json<{ activeVersion: string | null; items: ReadonlyArray<LegalStatute> }>('/statutes'),
  listClauses: (statute: string, citation?: string) => {
    const q = new URLSearchParams({ statute });
    if (citation) q.set('citation', citation);
    return json<{ items: ReadonlyArray<LegalClause> }>(`/clauses?${q.toString()}`);
  },
  getClause: (id: string) => json<LegalClause>(`/clauses/${encodeURIComponent(id)}`),
  search: (q: string, opts: { statute?: string; limit?: number } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.statute) params.set('statute', opts.statute);
    if (opts.limit) params.set('limit', String(opts.limit));
    return json<{
      query: string;
      activeVersion: string | null;
      items: ReadonlyArray<LegalSearchHit>;
    }>(`/search?${params.toString()}`);
  },
};
