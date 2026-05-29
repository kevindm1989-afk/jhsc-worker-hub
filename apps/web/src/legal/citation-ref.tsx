// <CitationRef statute="OHSA" citation="s.9(20)" /> — inline citation that
// expands into a clause preview on click. Used by markdown renderers in
// the recommendation / minutes / hazards surfaces.
//
// Resolution rule (ADR-0003 T-LC7): query is keyed on (statute, citation)
// against the active corpus version. On 404 the component renders a
// <MissingCitation /> marker rather than silently falling back to a
// different version_date.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { legalApi, type LegalClause } from './api';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; clause: LegalClause }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export interface CitationRefProps {
  readonly statute: string;
  readonly citation: string;
  /** Optional label override; defaults to "{statute} {citation}". */
  readonly children?: React.ReactNode;
}

export function CitationRef({ statute, citation, children }: CitationRefProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const ref = useRef<HTMLSpanElement | null>(null);
  const loadedRef = useRef(false);

  // Lazy load on first open. We use a ref instead of state.kind in the deps
  // array because reading state inside the effect would re-trigger it on
  // every setState (idle → loading → loaded), and the cleanup of the prior
  // invocation would cancel the in-flight fetch before it resolves.
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    setState({ kind: 'loading' });
    legalApi
      .listClauses(statute, citation)
      .then((r) => {
        if (cancelled) return;
        if (r.items.length === 0) setState({ kind: 'missing' });
        else setState({ kind: 'loaded', clause: r.items[0]! });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, statute, citation]);

  // Close on Escape / outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const label = children ?? `${statute} ${citation}`;
  const onToggle = useCallback(() => setOpen((v) => !v), []);
  const deepLink = `/legal?statute=${encodeURIComponent(statute)}&citation=${encodeURIComponent(citation)}`;

  return (
    <span ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center rounded border-b border-dotted border-primary/60 px-0.5 text-primary underline-offset-2 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Citation: ${statute} ${citation}`}
      >
        {label}
      </button>
      {open ? (
        <span
          role="dialog"
          aria-modal="false"
          aria-label={`${statute} ${citation} preview`}
          className="absolute left-0 top-full z-40 mt-1 w-80 max-w-[90vw] rounded-md border border-border bg-card p-3 text-left text-sm shadow-lg"
        >
          <CitationBody state={state} statute={statute} citation={citation} />
          <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
            <span>
              {statute} {citation}
            </span>
            <Link
              to={deepLink}
              className="text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
            >
              Open in Legal Reference
            </Link>
          </div>
        </span>
      ) : null}
    </span>
  );
}

function CitationBody({
  state,
  statute,
  citation,
}: {
  state: State;
  statute: string;
  citation: string;
}): JSX.Element {
  if (state.kind === 'loading') return <div className="text-muted-foreground">Loading…</div>;
  if (state.kind === 'missing') {
    return <MissingCitation statute={statute} citation={citation} />;
  }
  if (state.kind === 'error') {
    return <div className="text-status-rejected">Failed to load: {state.message}</div>;
  }
  if (state.kind === 'loaded') {
    const { clause } = state;
    return (
      <div>
        {clause.heading ? (
          <div className="mb-1 font-medium text-foreground">{clause.heading}</div>
        ) : null}
        {clause.bodyKind === 'full_text' && clause.body ? (
          <p className="whitespace-pre-wrap leading-snug text-foreground">{clause.body}</p>
        ) : null}
        {clause.bodyKind === 'summary' && clause.bodySummary ? (
          <>
            <p className="whitespace-pre-wrap italic leading-snug text-foreground">
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
          </>
        ) : null}
        {clause.supersededBy ? (
          <div className="mt-1 text-xs text-status-pending">
            Note: this version has been superseded by a later amendment.
          </div>
        ) : null}
      </div>
    );
  }
  return <></>;
}

export function MissingCitation({
  statute,
  citation,
}: {
  statute: string;
  citation: string;
}): JSX.Element {
  return (
    <div className="text-status-rejected">
      No clause matches {statute} {citation} in the active corpus.{' '}
      <Link to="/legal" className="text-primary hover:underline">
        Search Legal Reference
      </Link>
    </div>
  );
}
