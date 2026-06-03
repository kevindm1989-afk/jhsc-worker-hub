// /legal — Legal Reference screen (Milestone 1.4).
//
// Two modes:
//   - Browse: shown when there is no `?q=` and no `?statute=` query.
//     Lists all statutes in the active corpus. Click → statute drill-in
//     with its clauses.
//   - Deep link: `?statute=OHSA&citation=s.9(20)` jumps straight to a
//     specific clause (used by <CitationRef />'s "Open in Legal
//     Reference" link and by older audit-trail rows that cite a
//     superseded version_date).
//   - Search: `?q=...` runs an FTS query and renders matches with
//     mark-highlighted snippets.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { legalApi, type LegalClause, type LegalSearchHit, type LegalStatute } from '@/legal/api';
import { MissingCitation } from '@/legal/citation-ref';

export function LegalView(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const statute = params.get('statute') ?? '';
  const citation = params.get('citation') ?? '';

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 md:mb-6">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Legal Reference
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          OHSA, O.&nbsp;Reg.&nbsp;851, Canada Labour Code Part II, and COHSR. Search the full text
          or open a citation directly.
        </p>
      </header>

      <SearchBar
        value={q}
        onSubmit={(v) =>
          setParams(
            (prev) => {
              if (v) prev.set('q', v);
              else prev.delete('q');
              prev.delete('statute');
              prev.delete('citation');
              return prev;
            },
            { replace: true },
          )
        }
      />

      {q ? (
        <SearchResults query={q} />
      ) : statute && citation ? (
        <ClauseDetail statute={statute} citation={citation} />
      ) : statute ? (
        <StatuteDetail code={statute} />
      ) : (
        <StatuteIndex />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search bar
// ---------------------------------------------------------------------------

function SearchBar({
  value,
  onSubmit,
}: {
  value: string;
  onSubmit: (v: string) => void;
}): JSX.Element {
  // Key on `value` so each new query string re-mounts the input with the
  // right initial draft. Avoids the setState-in-effect lint rule.
  return <SearchBarInner key={value} value={value} onSubmit={onSubmit} />;
}

function SearchBarInner({
  value,
  onSubmit,
}: {
  value: string;
  onSubmit: (v: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft.trim());
      }}
      className="mb-4 flex items-center gap-2"
    >
      <label htmlFor="legal-search" className="sr-only">
        Search the legal corpus
      </label>
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          id="legal-search"
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search clauses (e.g. recommendations, lockout)"
          className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>
      <Button type="submit" size="sm" className="h-9">
        Search
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Statute index (browse)
// ---------------------------------------------------------------------------

function StatuteIndex(): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<LegalStatute> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    legalApi
      .listStatutes()
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <ErrorBox message={error} />;
  if (!items) return <LoadingBox />;
  if (items.length === 0) return <EmptyBox />;
  return (
    <ul className="space-y-2">
      {items.map((s) => (
        <li key={s.id}>
          <Link
            to={`/legal?statute=${encodeURIComponent(s.code)}`}
            className="block rounded-md border border-border bg-card px-4 py-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">{s.code}</div>
                <div className="text-xs text-muted-foreground">{s.title}</div>
              </div>
              <span className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                {s.jurisdiction}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Statute detail
// ---------------------------------------------------------------------------

function StatuteDetail({ code }: { code: string }): JSX.Element {
  // Key on code so a new statute remounts with empty state instead of
  // calling setState synchronously inside useEffect.
  return <StatuteDetailInner key={code} code={code} />;
}

function StatuteDetailInner({ code }: { code: string }): JSX.Element {
  const [clauses, setClauses] = useState<ReadonlyArray<LegalClause> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    legalApi
      .listClauses(code)
      .then((r) => {
        if (!cancelled) setClauses(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (error) return <ErrorBox message={error} />;
  if (!clauses) return <LoadingBox />;
  if (clauses.length === 0) return <EmptyBox />;
  const statute = clauses[0]!.statute;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{statute.code}</h2>
          <div className="text-xs text-muted-foreground">{statute.title}</div>
        </div>
        <Link
          to="/legal"
          className="text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          ← All statutes
        </Link>
      </div>
      <ul className="space-y-3">
        {clauses.map((c) => (
          <li key={c.id}>
            <ClauseCard clause={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single clause (deep link)
// ---------------------------------------------------------------------------

function ClauseDetail({ statute, citation }: { statute: string; citation: string }): JSX.Element {
  return (
    <ClauseDetailInner key={`${statute}::${citation}`} statute={statute} citation={citation} />
  );
}

function ClauseDetailInner({
  statute,
  citation,
}: {
  statute: string;
  citation: string;
}): JSX.Element {
  const [clause, setClause] = useState<LegalClause | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    legalApi
      .listClauses(statute, citation)
      .then((r) => {
        if (cancelled) return;
        if (r.items.length === 0) setMissing(true);
        else setClause(r.items[0]!);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [statute, citation]);
  if (error) return <ErrorBox message={error} />;
  if (missing) {
    return (
      <div className="rounded-md border border-border bg-card p-4">
        <MissingCitation statute={statute} citation={citation} />
      </div>
    );
  }
  if (!clause) return <LoadingBox />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <Link
          to={`/legal?statute=${encodeURIComponent(statute)}`}
          className="text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          ← {clause.statute.code} clauses
        </Link>
      </div>
      <ClauseCard clause={clause} expanded />
    </div>
  );
}

function ClauseCard({
  clause,
  expanded,
}: {
  clause: LegalClause;
  expanded?: boolean;
}): JSX.Element {
  return (
    <article className="rounded-md border border-border bg-card p-4">
      <header className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            {clause.statute.code} {clause.citation}
          </div>
          {clause.heading ? (
            <div className="text-xs text-muted-foreground">{clause.heading}</div>
          ) : null}
        </div>
        <div className="text-right text-[10px] uppercase tracking-wide text-muted-foreground">
          {clause.versionDate}
        </div>
      </header>
      {clause.bodyKind === 'full_text' && clause.body ? (
        <p
          className={`whitespace-pre-wrap text-sm leading-relaxed text-foreground ${expanded ? '' : 'line-clamp-4'}`}
        >
          {clause.body}
        </p>
      ) : null}
      {clause.bodyKind === 'summary' && clause.bodySummary ? (
        <div>
          <p className="whitespace-pre-wrap text-sm italic leading-relaxed text-foreground">
            {clause.bodySummary}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Summary only — see{' '}
            <a
              href={clause.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              source
            </a>{' '}
            for verbatim text.
          </p>
        </div>
      ) : null}
      <footer className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Verified by{' '}
          {clause.statute.licence === 'crown_copyright_open' ? 'Crown licence' : 'JHSC paraphrase'}
        </span>
        <a
          href={clause.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Source ↗
        </a>
      </footer>
      {clause.supersededBy ? (
        <div className="mt-2 rounded bg-status-pending/10 px-2 py-1 text-xs text-status-pending">
          Superseded by a later amendment.
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

function SearchResults({ query }: { query: string }): JSX.Element {
  return <SearchResultsInner key={query} query={query} />;
}

function SearchResultsInner({ query }: { query: string }): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<LegalSearchHit> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    legalApi
      .search(query)
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [query]);
  const total = items?.length ?? 0;
  const label = useMemo(() => (total === 1 ? '1 match' : `${total} matches`), [total]);
  if (error) return <ErrorBox message={error} />;
  if (!items) return <LoadingBox />;
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        No matches for <span className="font-medium text-foreground">{query}</span>.
      </div>
    );
  }
  return (
    <div>
      <div className="mb-2 text-xs text-muted-foreground">
        {label} for “{query}”
      </div>
      <ul className="space-y-3">
        {items.map((hit) => (
          <li key={hit.id}>
            <Link
              to={`/legal?statute=${encodeURIComponent(hit.statuteCode)}&citation=${encodeURIComponent(hit.citation)}`}
              className="block rounded-md border border-border bg-card p-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <div className="mb-1 flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-foreground">
                  {hit.statuteCode} {hit.citation}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {hit.versionDate}
                </div>
              </div>
              {hit.heading ? (
                <div className="mb-1 text-xs text-muted-foreground">{hit.heading}</div>
              ) : null}
              <div className="text-sm leading-relaxed text-foreground">
                <SnippetRenderer snippet={hit.snippet} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snippet renderer — safe replacement for dangerouslySetInnerHTML.
// ---------------------------------------------------------------------------
//
// ts_headline produces snippets like
//   "An employer shall <mark>take</mark> every <mark>precaution</mark>."
// We split on the literal <mark>...</mark> markers and emit text nodes for
// the surrounding spans + a <mark> React element for the highlighted runs.
// Any other tag in the input is treated as text. This closes sec-review F1
// (XSS via fixture-author-controlled body text), because nothing in the
// snippet path can construct a DOM node we did not authorize.

const MARK_SEGMENT = /<mark>([\s\S]*?)<\/mark>/g;

function SnippetRenderer({ snippet }: { snippet: string }): JSX.Element {
  const segments: Array<{ kind: 'text' | 'mark'; value: string }> = [];
  let cursor = 0;
  for (const match of snippet.matchAll(MARK_SEGMENT)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) {
      segments.push({ kind: 'text', value: snippet.slice(cursor, match.index) });
    }
    segments.push({ kind: 'mark', value: match[1] ?? '' });
    cursor = match.index + match[0].length;
  }
  if (cursor < snippet.length) {
    segments.push({ kind: 'text', value: snippet.slice(cursor) });
  }
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'mark' ? <mark key={i}>{s.value}</mark> : <span key={i}>{s.value}</span>,
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared status boxes
// ---------------------------------------------------------------------------

function LoadingBox(): JSX.Element {
  return <div className="text-sm text-muted-foreground">Loading…</div>;
}

function EmptyBox(): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
      The corpus is empty. Seed it with{' '}
      <code className="rounded bg-secondary px-1 py-0.5 text-xs">
        bun run apps/api/scripts/seed-legal-corpus.ts
      </code>
      .
    </div>
  );
}

function ErrorBox({ message }: { message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
      {message}
    </div>
  );
}
