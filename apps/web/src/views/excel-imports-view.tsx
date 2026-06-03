// /excel-imports — list of Excel-import bundles the actor has uploaded.
//
// Per CLAUDE.md UI/Design conventions: card-list density, status filter
// chips, sticky "+ New" CTA on mobile, empty state with onboarding copy.
// Per CLAUDE.md non-negotiable #11: the rep can see every import they
// kicked off, including pending / preview drafts that never committed.
//
// Note: this surface does NOT show decrypted descriptions — the list
// projection from the server is PI-clean by construction (counts +
// timestamps + status + sha256 prefix only). The decrypted source
// filename is the only sensitive field on the row, and it's fetched
// on the detail surface, not here.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ExcelImportApiError,
  excelImportsApi,
  type ExcelImportListItem,
} from '@/excel-imports/api';
import { IMPORT_STATUS_LABELS, ImportStatusBadge } from '@/excel-imports/components';
import { excelImportStatus, type ExcelImportStatus } from '@jhsc/shared-types';

export function ExcelImportsView(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const statusFilter = (params.get('status') as ExcelImportStatus | null) ?? null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-start justify-between gap-3 md:mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Excel imports
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Migrate your existing meeting-minutes workbook into the app. Parsing happens on this
            device; the file never leaves your browser.
          </p>
        </div>
        <Button asChild size="sm" className="h-9">
          <Link to="/excel-imports/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            New
          </Link>
        </Button>
      </header>

      <StatusChips
        all={excelImportStatus}
        labels={IMPORT_STATUS_LABELS}
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

      <ImportsListInner key={params.toString()} statusFilter={statusFilter} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// List body — fetches once per mount; mounts via key={params} on filter change.
// ---------------------------------------------------------------------------

function ImportsListInner({
  statusFilter,
}: {
  statusFilter: ExcelImportStatus | null;
}): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<ExcelImportListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    excelImportsApi
      .list()
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ExcelImportApiError) {
          setError(`Could not load imports (HTTP ${e.status}).`);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!items) return null;
    if (!statusFilter) return items;
    return items.filter((i) => i.status === statusFilter);
  }, [items, statusFilter]);

  if (error) {
    return (
      <div className="mt-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
        {error}
      </div>
    );
  }
  if (!filtered) return <ImportsListSkeleton />;
  if (filtered.length === 0) {
    return <ImportsEmptyState filtersApplied={statusFilter !== null} />;
  }
  return (
    <ul className="mt-4 space-y-2">
      {filtered.map((r) => (
        <li key={r.id}>
          <ImportCard item={r} />
        </li>
      ))}
    </ul>
  );
}

function ImportCard({ item }: { item: ExcelImportListItem }): JSX.Element {
  return (
    <Link
      to={`/excel-imports/${encodeURIComponent(item.id)}`}
      className="block rounded-md border border-border bg-card p-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <div className="flex items-start gap-2.5">
        <FileSpreadsheet
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">
              {item.id.slice(0, 8)}
            </span>
            <ImportStatusBadge status={item.status} />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {item.rowCount} row{item.rowCount === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            Import {item.id.slice(0, 8)} ·{' '}
            <span className="text-xs font-normal text-muted-foreground">
              sha {item.sourceSha256.slice(0, 12)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>created {new Date(item.createdAt).toLocaleString()}</span>
            {item.committedAt ? (
              <>
                <span>·</span>
                <span>committed {new Date(item.committedAt).toLocaleString()}</span>
              </>
            ) : null}
            {item.reversedAt ? (
              <>
                <span>·</span>
                <span>reversed {new Date(item.reversedAt).toLocaleString()}</span>
              </>
            ) : null}
            {item.cancelledAt ? (
              <>
                <span>·</span>
                <span>cancelled {new Date(item.cancelledAt).toLocaleString()}</span>
              </>
            ) : null}
          </div>
          <CountsRow item={item} />
        </div>
      </div>
    </Link>
  );
}

function CountsRow({ item }: { item: ExcelImportListItem }): JSX.Element {
  const c = item.counts;
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]"
      aria-label={`Created ${c.created}, updated ${c.updated}, skipped ${c.skipped}, conflicts pending ${c.conflictPending}`}
    >
      <span className="rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 font-mono text-blue-800">
        +{c.created} new
      </span>
      <span className="rounded border border-amber-100 bg-amber-50 px-1.5 py-0.5 font-mono text-amber-900">
        ~{c.updated} upd
      </span>
      <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-zinc-700">
        {c.skipped} skip
      </span>
      {c.conflictPending > 0 ? (
        <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-mono text-red-800">
          !{c.conflictPending} conflict
        </span>
      ) : null}
    </div>
  );
}

function ImportsListSkeleton(): JSX.Element {
  return (
    <ul className="mt-4 space-y-2" aria-busy="true" aria-label="Loading imports">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-20 animate-pulse rounded-md border border-border bg-muted/40" />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Empty state — rights-protective + actionable per CLAUDE.md.
// ---------------------------------------------------------------------------

function ImportsEmptyState({ filtersApplied }: { filtersApplied: boolean }): JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center justify-center px-6 py-12 text-center md:py-16">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
        <FileSpreadsheet
          className="h-6 w-6 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
      <div className="mb-1 text-base font-medium text-foreground">
        {filtersApplied ? 'No imports match the current filter.' : 'No Excel imports yet.'}
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filtersApplied
          ? 'Clear the filter or upload a new workbook.'
          : 'Upload your meeting-minutes workbook to migrate your existing action items into the app. The file is parsed on this device — it never leaves your browser.'}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button asChild size="sm" className="h-9">
          <Link to="/excel-imports/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            New import
          </Link>
        </Button>
        <a
          href="/docs/excel-import-format.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Format spec →
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-select status filter chips — matches InspectionsView / RecommendationsView.
// ---------------------------------------------------------------------------

function StatusChips({
  all,
  labels,
  selected,
  onSelect,
}: {
  all: ReadonlyArray<ExcelImportStatus>;
  labels: Readonly<Record<string, string>>;
  selected: ExcelImportStatus | null;
  onSelect: (v: ExcelImportStatus | null) => void;
}): JSX.Element {
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2"
      role="group"
      aria-labelledby="filter-status"
    >
      <span id="filter-status" className="text-xs uppercase tracking-wide text-muted-foreground">
        Status
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
