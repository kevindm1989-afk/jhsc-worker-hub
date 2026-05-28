// /hazards — list with filters + search.
//
// Empty state directs to /hazards/new. Filter chips for status + severity
// stack on mobile and inline on desktop. Title-only ILIKE search via the
// API (description is encrypted; FTS over the body is not server-side
// possible — by design, ADR-0004).

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { hazardsApi, type HazardListItem } from '@/hazards/api';
import {
  HazardStatusBadge,
  SEVERITY_LABELS,
  STATUS_LABELS,
  SeverityDot,
} from '@/hazards/components';
import {
  hazardSeverity,
  hazardStatus,
  type HazardSeverity,
  type HazardStatus,
} from '@jhsc/shared-types';

export function HazardsView(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const status = params.getAll('status') as HazardStatus[];
  const severity = params.getAll('severity') as HazardSeverity[];
  const q = params.get('q') ?? '';

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-start justify-between gap-3 md:mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Hazards
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Encrypted hazard records linked to the audit chain.
          </p>
        </div>
        <Button asChild size="sm" className="h-9">
          <Link to="/hazards/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            New
          </Link>
        </Button>
      </header>

      <SearchBar
        value={q}
        onSubmit={(v) =>
          setParams(
            (prev) => {
              if (v) prev.set('q', v);
              else prev.delete('q');
              return prev;
            },
            { replace: true },
          )
        }
      />

      <FilterChips
        label="Status"
        all={hazardStatus}
        labels={STATUS_LABELS}
        selected={status}
        onToggle={(s) =>
          setParams(
            (prev) => {
              const cur = prev.getAll('status');
              prev.delete('status');
              const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
              for (const v of next) prev.append('status', v);
              return prev;
            },
            { replace: true },
          )
        }
      />
      <FilterChips
        label="Severity"
        all={hazardSeverity}
        labels={SEVERITY_LABELS}
        selected={severity}
        onToggle={(s) =>
          setParams(
            (prev) => {
              const cur = prev.getAll('severity');
              prev.delete('severity');
              const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
              for (const v of next) prev.append('severity', v);
              return prev;
            },
            { replace: true },
          )
        }
      />

      <HazardListInner key={params.toString()} status={status} severity={severity} q={q} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// List body — re-mounted on each filter change (avoids the synchronous-
// setState-in-effect lint rule).
// ---------------------------------------------------------------------------

function HazardListInner({
  status,
  severity,
  q,
}: {
  status: HazardStatus[];
  severity: HazardSeverity[];
  q: string;
}): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<HazardListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    hazardsApi
      .list({
        status: status.length > 0 ? status : undefined,
        severity: severity.length > 0 ? severity : undefined,
        q: q || undefined,
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
  }, [status, severity, q]);

  if (error) {
    return (
      <div className="mt-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
        {error}
      </div>
    );
  }
  if (!items) {
    return <div className="mt-4 text-sm text-muted-foreground">Loading…</div>;
  }
  if (items.length === 0) {
    return <HazardEmptyState filtersApplied={status.length + severity.length + (q ? 1 : 0) > 0} />;
  }
  return (
    <ul className="mt-4 space-y-2">
      {items.map((h) => (
        <li key={h.id}>
          <HazardCard hazard={h} />
        </li>
      ))}
    </ul>
  );
}

function HazardCard({ hazard }: { hazard: HazardListItem }): JSX.Element {
  return (
    <Link
      to={`/hazards/${encodeURIComponent(hazard.id)}`}
      className="block rounded-md border border-border bg-card p-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <div className="flex items-start gap-2.5">
        <SeverityDot severity={hazard.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {hazard.hazardCode}
            </span>
            <HazardStatusBadge status={hazard.status} />
            {hazard.locationZone ? (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {hazard.locationZone}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground">{hazard.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{hazard.summary}</div>
        </div>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function HazardEmptyState({ filtersApplied }: { filtersApplied: boolean }): JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center justify-center px-6 py-12 text-center md:py-16">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
        <AlertTriangle
          className="h-6 w-6 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
      <div className="mb-1 text-base font-medium text-foreground">
        {filtersApplied ? 'No hazards match the current filters.' : 'No hazards logged yet.'}
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">
        Every hazard record is encrypted at rest and entered into the tamper-evident audit chain on
        creation.
      </p>
      <div className="mt-4">
        <Button asChild size="sm" className="h-9">
          <Link to="/hazards/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Log a hazard
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search + filter chips
// ---------------------------------------------------------------------------

function SearchBar({
  value,
  onSubmit,
}: {
  value: string;
  onSubmit: (v: string) => void;
}): JSX.Element {
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
      className="mb-3 flex items-center gap-2"
    >
      <label htmlFor="hazards-search" className="sr-only">
        Search hazards by title
      </label>
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          id="hazards-search"
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search title (e.g. slip, lockout)"
          className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <Button type="submit" size="sm" className="h-9">
        Search
      </Button>
    </form>
  );
}

function FilterChips<T extends string>({
  label,
  all,
  labels,
  selected,
  onToggle,
}: {
  label: string;
  all: ReadonlyArray<T>;
  labels: Readonly<Record<T, string>>;
  selected: ReadonlyArray<T>;
  onToggle: (v: T) => void;
}): JSX.Element {
  const labelId = useMemo(() => `filter-${label.toLowerCase().replace(/\s+/g, '-')}`, [label]);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {all.map((v) => {
        const active = selected.includes(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => onToggle(v)}
            aria-pressed={active}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:bg-muted',
            )}
          >
            {labels[v]}
          </button>
        );
      })}
    </div>
  );
}
