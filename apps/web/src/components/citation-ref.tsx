// Citation picker modal — opened from the recommendation drafting form to
// insert a `[[cite:N]]` marker + citation row.
//
// The picker walks the legal corpus via the 1.4 legalApi:
//   - Browse: list statutes (the active corpus version). On select, drill
//     into the statute's clauses.
//   - Clause list: shows each clause's citation + heading + body preview.
//     "Insert" picks the (statuteCode, clauseId, versionDate) triple.
//   - Search: full-text search across the corpus when the rep types a
//     keyword. Hits are clickable — selecting a hit jumps straight to the
//     clause picker for that statute filtered to the matching citation.
//
// On insert, the parent's onInsert(citation) callback receives:
//   { statuteCode, clauseId, versionDate }
//
// The parent owns position allocation (dense 1..N) + marker placement at
// the textarea cursor (see new-recommendation-view.tsx).
//
// CLAUDE.md "Citation Hover" is the surface this is anchored on — the
// modal is the signature interaction expressed as a picker (rather than
// hover) because the drafting flow needs decisive "use this one"
// affordances. The hover surface remains the reading-time pattern.

import { useEffect, useRef, useState } from 'react';
import { BookOpen, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { legalApi, type LegalClause, type LegalSearchHit, type LegalStatute } from '@/legal/api';

export interface InsertableCitation {
  readonly statuteCode: string;
  readonly clauseId: string;
  readonly versionDate: string;
  /** Optional preview metadata (heading + citation) for the parent
   *  citations-table label. The parent does not need these to submit,
   *  but rendering "OHSA s.9(20) — Recommendations" beats raw UUIDs. */
  readonly heading: string | null;
  readonly citation: string;
}

interface CitationPickerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onInsert: (citation: InsertableCitation) => void;
}

type View = { kind: 'statutes' } | { kind: 'clauses'; statute: LegalStatute } | { kind: 'search' };

export function CitationPicker(props: CitationPickerProps): JSX.Element | null {
  if (!props.open) return null;
  // Keying on `open` (via the early-return above + Inner mount) gives us
  // a fresh state tree each time the modal opens — same posture as
  // FindingDetailView / LegalView (avoids the set-state-in-effect lint
  // rule).
  return <CitationPickerInner {...props} />;
}

function CitationPickerInner(props: CitationPickerProps): JSX.Element {
  const { onClose, onInsert } = props;
  const [view, setView] = useState<View>({ kind: 'statutes' });
  const [searchTerm, setSearchTerm] = useState('');

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="citation-picker-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col rounded-t-2xl bg-card shadow-lg md:max-h-[80vh] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-2 border-b border-border p-4">
          <div>
            <h2
              id="citation-picker-title"
              className="text-base font-semibold tracking-tight text-foreground"
            >
              Insert citation
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pick a clause from the legal corpus. The (statute, clause, version date) triple is
              pinned to the recommendation at submit time.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <SearchBar
          value={searchTerm}
          onChange={setSearchTerm}
          onSubmit={(v) => {
            if (v) setView({ kind: 'search' });
            else setView({ kind: 'statutes' });
          }}
        />

        <div className="flex-1 overflow-y-auto p-4">
          {view.kind === 'statutes' ? (
            <StatuteList onSelect={(s) => setView({ kind: 'clauses', statute: s })} />
          ) : view.kind === 'clauses' ? (
            <ClauseList
              statute={view.statute}
              onBack={() => setView({ kind: 'statutes' })}
              onInsert={onInsert}
            />
          ) : (
            <SearchResults
              query={searchTerm}
              onInsert={onInsert}
              onOpenStatute={(code) => {
                // Fetch the statute row + jump into its clauses.
                void legalApi.listStatutes().then((r) => {
                  const s = r.items.find((it) => it.code === code);
                  if (s) setView({ kind: 'clauses', statute: s });
                });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search bar
// ---------------------------------------------------------------------------

function SearchBar({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}): JSX.Element {
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
      className="flex items-center gap-2 border-b border-border p-3"
    >
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Search the legal corpus"
          placeholder="Search clauses (e.g. recommendations, lockout, refusal)"
          className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <Button type="submit" size="sm" className="h-9">
        Search
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Statute index
// ---------------------------------------------------------------------------

function StatuteList({ onSelect }: { onSelect: (s: LegalStatute) => void }): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<LegalStatute> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    legalApi
      .listStatutes()
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (error) return <ErrorBox message={error} />;
  if (!items) return <LoadingBox />;
  if (items.length === 0) return <CorpusEmptyBox />;
  return (
    <ul className="space-y-2">
      {items.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => onSelect(s)}
            className="block w-full rounded-md border border-border bg-background px-4 py-3 text-left hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
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
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Clause list
// ---------------------------------------------------------------------------

function ClauseList({
  statute,
  onBack,
  onInsert,
}: {
  statute: LegalStatute;
  onBack: () => void;
  onInsert: (citation: InsertableCitation) => void;
}): JSX.Element {
  return (
    <ClauseListInner key={statute.code} statute={statute} onBack={onBack} onInsert={onInsert} />
  );
}

function ClauseListInner({
  statute,
  onBack,
  onInsert,
}: {
  statute: LegalStatute;
  onBack: () => void;
  onInsert: (citation: InsertableCitation) => void;
}): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<LegalClause> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    legalApi
      .listClauses(statute.code)
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [statute.code]);
  if (error) return <ErrorBox message={error} />;
  if (!items) return <LoadingBox />;
  if (items.length === 0) return <CorpusEmptyBox />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          ← All statutes
        </button>
        <div className="text-right">
          <div className="text-sm font-medium text-foreground">{statute.code}</div>
          <div className="text-xs text-muted-foreground">{statute.title}</div>
        </div>
      </div>
      <ul className="space-y-2">
        {items.map((c) => (
          <li key={c.id}>
            <ClauseRow clause={c} onInsert={onInsert} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClauseRow({
  clause,
  onInsert,
}: {
  clause: LegalClause;
  onInsert: (citation: InsertableCitation) => void;
}): JSX.Element {
  // CLAUDE.md #5 / Legal Reference Module Rules: corpus body text is the
  // source of truth. We render it for preview but the clause picker only
  // captures the (statute, clause, version_date) triple — the rep cannot
  // edit the corpus text from this surface.
  const preview = clause.body ?? clause.bodySummary ?? '';
  return (
    <article className="rounded-md border border-border bg-background p-3">
      <header className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            {clause.statute.code} {clause.citation}
          </div>
          {clause.heading ? (
            <div className="text-xs text-muted-foreground">{clause.heading}</div>
          ) : null}
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {clause.versionDate}
        </div>
      </header>
      {preview ? (
        <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-snug text-foreground">
          {preview}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-between">
        <a
          href={clause.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Source ↗
        </a>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() =>
            onInsert({
              statuteCode: clause.statute.code,
              clauseId: clause.id,
              versionDate: clause.versionDate,
              heading: clause.heading,
              citation: clause.citation,
            })
          }
        >
          Insert
        </Button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

function SearchResults({
  query,
  onInsert,
  onOpenStatute,
}: {
  query: string;
  onInsert: (citation: InsertableCitation) => void;
  onOpenStatute: (statuteCode: string) => void;
}): JSX.Element {
  return (
    <SearchResultsInner
      key={query}
      query={query}
      onInsert={onInsert}
      onOpenStatute={onOpenStatute}
    />
  );
}

function SearchResultsInner({
  query,
  onInsert,
  onOpenStatute,
}: {
  query: string;
  onInsert: (citation: InsertableCitation) => void;
  onOpenStatute: (statuteCode: string) => void;
}): JSX.Element {
  // Empty-query short-circuit lives outside the effect so we don't
  // trigger the set-state-in-effect lint rule. The Inner component is
  // already keyed on `query` (see SearchResults wrapper) so a blank
  // query mounts a clean tree.
  const initial: ReadonlyArray<LegalSearchHit> | null = query ? null : [];
  const [items, setItems] = useState<ReadonlyArray<LegalSearchHit> | null>(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!query) return;
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
  if (error) return <ErrorBox message={error} />;
  if (!items) return <LoadingBox />;
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background p-4 text-center text-sm text-muted-foreground">
        No matches for <span className="font-medium text-foreground">{query}</span>.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((hit) => (
        <li key={hit.id}>
          <SearchHitRow hit={hit} onInsert={onInsert} onOpenStatute={onOpenStatute} />
        </li>
      ))}
    </ul>
  );
}

function SearchHitRow({
  hit,
  onInsert,
  onOpenStatute,
}: {
  hit: LegalSearchHit;
  onInsert: (citation: InsertableCitation) => void;
  onOpenStatute: (statuteCode: string) => void;
}): JSX.Element {
  // The search projection carries enough to build an InsertableCitation
  // immediately (statuteCode + id + versionDate). No second corpus fetch
  // required for the happy path.
  return (
    <article className="rounded-md border border-border bg-background p-3">
      <header className="mb-1 flex items-start justify-between gap-3">
        <button type="button" onClick={() => onOpenStatute(hit.statuteCode)} className="text-left">
          <div className="text-sm font-medium text-foreground hover:underline">
            {hit.statuteCode} {hit.citation}
          </div>
          {hit.heading ? <div className="text-xs text-muted-foreground">{hit.heading}</div> : null}
        </button>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {hit.versionDate}
        </div>
      </header>
      <p className="line-clamp-3 text-xs leading-snug text-foreground">
        <SnippetText snippet={hit.snippet} />
      </p>
      <div className="mt-2 flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() =>
            onInsert({
              statuteCode: hit.statuteCode,
              clauseId: hit.id,
              versionDate: hit.versionDate,
              heading: hit.heading,
              citation: hit.citation,
            })
          }
        >
          Insert
        </Button>
      </div>
    </article>
  );
}

// Same XSS-safe snippet renderer as legal-view.tsx — splits on
// <mark>...</mark> and emits text + <mark> React elements without ever
// touching dangerouslySetInnerHTML (sec-review F1 close-out).
const MARK_SEGMENT = /<mark>([\s\S]*?)<\/mark>/g;

function SnippetText({ snippet }: { snippet: string }): JSX.Element {
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

function CorpusEmptyBox(): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background p-4 text-center text-sm text-muted-foreground">
      <BookOpen
        className="mx-auto mb-1 h-5 w-5 text-muted-foreground"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      The corpus is empty. Seed it before drafting a recommendation that cites a clause.
    </div>
  );
}

function ErrorBox({ message }: { message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CitationRefButton — a small button used by the drafting form to open
// the picker. Co-located here so callers import a single surface.
// ---------------------------------------------------------------------------

export function CitationRefButton({
  onInsert,
  disabled,
}: {
  onInsert: (citation: InsertableCitation) => void;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn('h-8 px-3 text-xs')}
      >
        <BookOpen className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Insert citation
      </Button>
      <CitationPicker
        open={open}
        onClose={() => {
          setOpen(false);
          // Restore focus to the button for keyboard nav.
          buttonRef.current?.focus();
        }}
        onInsert={(c) => {
          onInsert(c);
          setOpen(false);
          buttonRef.current?.focus();
        }}
      />
    </>
  );
}
