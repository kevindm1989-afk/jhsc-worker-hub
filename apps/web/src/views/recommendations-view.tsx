// /recommendations — list with status + jurisdiction filter chips.
//
// Card-list density per CLAUDE.md. Each row shows recommendation_number
// prefix, jurisdiction badge, status badge, drafted_at relative date,
// and the deadline countdown when status='submitted' (overdue rows get a
// red border per the §"Status semantics" rule — red = open/overdue).
//
// No PI on the list endpoint — titles and bodies live on the detail
// surface and are step-up gated there (T-R11 close-out).
//
// Empty state copy is rights-protective and actionable per CLAUDE.md
// "empty states do work" + #7 — never discourages drafting; cites the
// statutory anchor (OHSA s.9(20) / CLC s.135(5)) so the rep knows where
// the affordance comes from.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { recommendationsApi, type RecommendationListItem } from '@/recommendations/api';
import {
  DeadlineBadge,
  JURISDICTION_LABELS,
  JurisdictionBadge,
  RecommendationStatusBadge,
  STATUS_LABELS,
} from '@/recommendations/components';
import {
  recommendationDeadlineState,
  recommendationJurisdiction,
  recommendationStatus,
  type RecommendationJurisdiction,
  type RecommendationStatus,
} from '@jhsc/shared-types';

export function RecommendationsView(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const statusFilter = (params.get('status') as RecommendationStatus | null) ?? null;
  const jurisdictionFilter =
    (params.get('jurisdiction') as RecommendationJurisdiction | null) ?? null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-start justify-between gap-3 md:mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Recommendations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Written recommendations under OHSA s.9(20) / CLC s.135(5) with response tracking and the
            21-day clock.
          </p>
        </div>
        <Button asChild size="sm" className="h-9">
          <Link to="/recommendations/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            New
          </Link>
        </Button>
      </header>

      <SingleSelectChips
        label="Status"
        all={recommendationStatus}
        labels={STATUS_LABELS}
        selected={statusFilter}
        onSelect={(s) =>
          setParams(
            (prev) => {
              if (s === null) prev.delete('status');
              else prev.set('status', s);
              return prev;
            },
            { replace: true },
          )
        }
      />
      <SingleSelectChips
        label="Jurisdiction"
        all={recommendationJurisdiction}
        labels={JURISDICTION_LABELS}
        selected={jurisdictionFilter}
        onSelect={(s) =>
          setParams(
            (prev) => {
              if (s === null) prev.delete('jurisdiction');
              else prev.set('jurisdiction', s);
              return prev;
            },
            { replace: true },
          )
        }
      />

      <RecommendationListInner
        key={params.toString()}
        statusFilter={statusFilter}
        jurisdictionFilter={jurisdictionFilter}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// List body — re-mounted on each filter change (mirrors the InspectionsView
// pattern so we avoid the setState-in-effect lint rule).
// ---------------------------------------------------------------------------

function RecommendationListInner({
  statusFilter,
  jurisdictionFilter,
}: {
  statusFilter: RecommendationStatus | null;
  jurisdictionFilter: RecommendationJurisdiction | null;
}): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<RecommendationListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    recommendationsApi
      .list({
        status: statusFilter ?? undefined,
        jurisdiction: jurisdictionFilter ?? undefined,
      })
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, jurisdictionFilter]);

  if (error) {
    return (
      <div className="mt-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
        {error}
      </div>
    );
  }
  if (!items) return <RecommendationListSkeleton />;
  if (items.length === 0) {
    return (
      <RecommendationEmptyState
        filtersApplied={(statusFilter ? 1 : 0) + (jurisdictionFilter ? 1 : 0) > 0}
      />
    );
  }
  return (
    <ul className="mt-4 space-y-2">
      {items.map((r) => (
        <li key={r.id}>
          <RecommendationCard recommendation={r} />
        </li>
      ))}
    </ul>
  );
}

function RecommendationCard({
  recommendation,
}: {
  recommendation: RecommendationListItem;
}): JSX.Element {
  const deadline = recommendation.deadline ? new Date(recommendation.deadline) : null;
  const state = recommendationDeadlineState(new Date(), deadline);
  const overdue = state === 'overdue';
  return (
    <Link
      to={`/recommendations/${encodeURIComponent(recommendation.id)}`}
      className={cn(
        'block rounded-md border bg-card p-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring',
        overdue ? 'border-red-300' : 'border-border',
      )}
    >
      <div className="flex items-start gap-2.5">
        <Scale
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">
              #{recommendation.recommendationNumber}
            </span>
            <JurisdictionBadge jurisdiction={recommendation.jurisdiction} />
            <RecommendationStatusBadge status={recommendation.status} />
            {recommendation.status === 'submitted' ||
            recommendation.status === 'response_received' ? (
              <DeadlineBadge
                state={state}
                deadline={deadline}
                jurisdiction={recommendation.jurisdiction}
              />
            ) : null}
            {recommendation.hasResponse ? (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {recommendation.citationCount > 0
                  ? `${recommendation.citationCount} citation${recommendation.citationCount === 1 ? '' : 's'} · response captured`
                  : 'response captured'}
              </span>
            ) : recommendation.citationCount > 0 ? (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {recommendation.citationCount} citation
                {recommendation.citationCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            Recommendation #{recommendation.recommendationNumber} · {recommendation.jurisdiction}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{recommendation.id.slice(0, 8)}</span>
            <span>·</span>
            <span>drafted {new Date(recommendation.draftedAt).toLocaleString()}</span>
            {recommendation.submittedAt ? (
              <>
                <span>·</span>
                <span>submitted {new Date(recommendation.submittedAt).toLocaleDateString()}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </Link>
  );
}

function RecommendationListSkeleton(): JSX.Element {
  return (
    <ul className="mt-4 space-y-2" aria-busy="true" aria-label="Loading recommendations">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-16 animate-pulse rounded-md border border-border bg-muted/40" />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Empty state — rights-protective + actionable. Cites the statutory
// anchor so the rep knows where the affordance comes from.
// ---------------------------------------------------------------------------

function RecommendationEmptyState({ filtersApplied }: { filtersApplied: boolean }): JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center justify-center px-6 py-12 text-center md:py-16">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
        <Scale className="h-6 w-6 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      </div>
      <div className="mb-1 text-base font-medium text-foreground">
        {filtersApplied
          ? 'No recommendations match the current filters.'
          : 'No recommendations yet.'}
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filtersApplied
          ? 'Clear a filter or draft a new Notice of Recommendation.'
          : 'Draft your first Notice of Recommendation under OHSA s.9(20) or CLC s.135(5). Submission starts the 21-day response clock and creates a tracked action item in the next meeting.'}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button asChild size="sm" className="h-9">
          <Link to="/recommendations/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Draft recommendation
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-select filter chips — mirrors the InspectionsView pattern. The
// API accepts a single status / jurisdiction filter per call.
// ---------------------------------------------------------------------------

function SingleSelectChips<T extends string>({
  label,
  all,
  labels,
  selected,
  onSelect,
}: {
  label: string;
  all: ReadonlyArray<T>;
  labels: Readonly<Record<string, string>>;
  selected: T | string | null;
  onSelect: (v: T | null) => void;
}): JSX.Element {
  const labelId = useMemo(() => `filter-${label.toLowerCase()}`, [label]);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {all.map((v) => {
        const active = selected === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onSelect(active ? null : v)}
            aria-pressed={active}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:bg-muted',
            )}
          >
            {labels[v] ?? v}
          </button>
        );
      })}
    </div>
  );
}
