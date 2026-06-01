// /inspections — list with filter chips for state / zone / template.
//
// Empty state directs to /inspections/new. Filter chips for state, zone,
// and template_code stack on mobile and inline on desktop. Card-list
// density per CLAUDE.md.
//
// No PI on the list endpoint — finding observations and reporter
// identities live on the detail surface and are step-up gated there.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { inspectionsApi, type InspectionSummary } from '@/inspections/api';
import {
  InspectionStateBadge,
  STATE_LABELS,
  TEMPLATE_CODE_LABELS,
  ZONE_IDS,
  resolveZoneLabel,
} from '@/inspections/components';
import {
  inspectionConductState,
  inspectionTemplateCode,
  type InspectionConductState,
  type InspectionTemplateCode,
} from '@jhsc/shared-types';

export function InspectionsView(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const stateFilter = (params.get('state') as InspectionConductState | null) ?? null;
  const zoneFilter = params.get('zoneId') ?? null;
  const templateFilter = (params.get('templateCode') as InspectionTemplateCode | null) ?? null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-start justify-between gap-3 md:mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Inspections
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Template-driven workplace inspections with photo evidence and findings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-9">
            <Link to="/inspection-templates">Templates</Link>
          </Button>
          <Button asChild size="sm" className="h-9">
            <Link to="/inspections/new">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              New
            </Link>
          </Button>
        </div>
      </header>

      <SingleSelectChips
        label="State"
        all={inspectionConductState}
        labels={STATE_LABELS}
        selected={stateFilter}
        onSelect={(s) =>
          setParams(
            (prev) => {
              if (s === null) prev.delete('state');
              else prev.set('state', s);
              return prev;
            },
            { replace: true },
          )
        }
      />
      <SingleSelectChips
        label="Template"
        all={inspectionTemplateCode}
        labels={TEMPLATE_CODE_LABELS}
        selected={templateFilter}
        onSelect={(s) =>
          setParams(
            (prev) => {
              if (s === null) prev.delete('templateCode');
              else prev.set('templateCode', s);
              return prev;
            },
            { replace: true },
          )
        }
      />
      <SingleSelectChips
        label="Zone"
        all={ZONE_IDS}
        labels={
          Object.fromEntries(ZONE_IDS.map((z) => [z, resolveZoneLabel(z)])) as Record<
            string,
            string
          >
        }
        selected={zoneFilter}
        onSelect={(s) =>
          setParams(
            (prev) => {
              if (s === null) prev.delete('zoneId');
              else prev.set('zoneId', s);
              return prev;
            },
            { replace: true },
          )
        }
      />

      <InspectionListInner
        key={params.toString()}
        stateFilter={stateFilter}
        zoneFilter={zoneFilter}
        templateFilter={templateFilter}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// List body — re-mounted on each filter change (same pattern as
// HazardsView so we avoid the setState-in-effect lint rule).
// ---------------------------------------------------------------------------

function InspectionListInner({
  stateFilter,
  zoneFilter,
  templateFilter,
}: {
  stateFilter: InspectionConductState | null;
  zoneFilter: string | null;
  templateFilter: InspectionTemplateCode | null;
}): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<InspectionSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    inspectionsApi
      .listInspections({
        state: stateFilter ?? undefined,
        zoneId: zoneFilter ?? undefined,
        templateCode: templateFilter ?? undefined,
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
  }, [stateFilter, zoneFilter, templateFilter]);

  if (error) {
    return (
      <div className="mt-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
        {error}
      </div>
    );
  }
  if (!items) return <InspectionListSkeleton />;
  if (items.length === 0) {
    return (
      <InspectionEmptyState
        filtersApplied={(stateFilter ? 1 : 0) + (zoneFilter ? 1 : 0) + (templateFilter ? 1 : 0) > 0}
      />
    );
  }
  return (
    <ul className="mt-4 space-y-2">
      {items.map((i) => (
        <li key={i.id}>
          <InspectionCard inspection={i} />
        </li>
      ))}
    </ul>
  );
}

function InspectionCard({ inspection }: { inspection: InspectionSummary }): JSX.Element {
  const when = inspection.scheduledFor ?? inspection.startedAt ?? inspection.createdAt;
  return (
    <Link
      to={`/inspections/${encodeURIComponent(inspection.id)}`}
      className="block rounded-md border border-border bg-card p-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <div className="flex items-start gap-2.5">
        <ClipboardList
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <InspectionStateBadge state={inspection.state} />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {TEMPLATE_CODE_LABELS[inspection.templateCode]}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {resolveZoneLabel(inspection.zoneId)}
            </span>
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {TEMPLATE_CODE_LABELS[inspection.templateCode]} · {resolveZoneLabel(inspection.zoneId)}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{inspection.id.slice(0, 8)}</span>
            <span>·</span>
            <span>{new Date(when).toLocaleString()}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function InspectionListSkeleton(): JSX.Element {
  return (
    <ul className="mt-4 space-y-2" aria-busy="true" aria-label="Loading inspections">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-16 animate-pulse rounded-md border border-border bg-muted/40" />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Empty state — does work (CLAUDE.md "empty states do work")
// ---------------------------------------------------------------------------

function InspectionEmptyState({ filtersApplied }: { filtersApplied: boolean }): JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center justify-center px-6 py-12 text-center md:py-16">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
        <ClipboardList
          className="h-6 w-6 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
      <div className="mb-1 text-base font-medium text-foreground">
        {filtersApplied ? 'No inspections match the current filters.' : 'No inspections yet.'}
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filtersApplied
          ? 'Clear a filter or schedule a new inspection from one of the seeded templates.'
          : 'Schedule the first Zone Monthly walk-through, or start a Rack Inspection. Both templates ship with the workplace defaults.'}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button asChild size="sm" className="h-9">
          <Link to="/inspections/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            New inspection
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="h-9">
          <Link to="/inspection-templates">Browse templates</Link>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-select filter chips — one value at a time, since the API only
// accepts a single state/zone/templateCode filter per call.
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
