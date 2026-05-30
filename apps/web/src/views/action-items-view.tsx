// /action-items — list with section / status / risk / type filters.
//
// Mobile: card list. Desktop: same card list (kanban-per-section is the
// 1.10 polish; for 1.6 the card list with section badges is enough).
// Title-equivalent search is server-side via ?q (post-decrypt match on
// the safeSummary preview; description is encrypted at rest).

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardList, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { actionItemsApi, type ActionItemListItem } from '@/action-items/api';
import {
  ActionFlagBadge,
  RiskDot,
  SectionBadge,
  STATUS_LABELS,
  StatusBadge,
} from '@/action-items/components';
import {
  actionItemRisk,
  actionItemSection,
  actionItemStatus,
  actionItemType,
  type ActionItemRisk,
  type ActionItemSection,
  type ActionItemStatus,
  type ActionItemType,
} from '@jhsc/shared-types';

export function ActionItemsView(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const section = params.getAll('section') as ActionItemSection[];
  const status = params.getAll('status') as ActionItemStatus[];
  const risk = params.getAll('risk') as ActionItemRisk[];
  const type = params.getAll('type') as ActionItemType[];
  const q = params.get('q') ?? '';

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-start justify-between gap-3 md:mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Action items
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational entity — every section move is anchored in the audit chain.
          </p>
        </div>
        <Button asChild size="sm" className="h-9">
          <Link to="/action-items/new">
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

      <ChipGroup
        label="Section"
        all={actionItemSection}
        selected={section}
        labelFor={(s) => SECTION_LABEL_INLINE[s]}
        onToggle={(s) => setParams((prev) => toggleParam(prev, 'section', s), { replace: true })}
      />
      <ChipGroup
        label="Status"
        all={actionItemStatus}
        selected={status}
        labelFor={(s) => STATUS_LABELS[s]}
        onToggle={(s) => setParams((prev) => toggleParam(prev, 'status', s), { replace: true })}
      />
      <ChipGroup
        label="Risk"
        all={actionItemRisk}
        selected={risk}
        labelFor={(s) => s}
        onToggle={(s) => setParams((prev) => toggleParam(prev, 'risk', s), { replace: true })}
      />
      <ChipGroup
        label="Type"
        all={actionItemType}
        selected={type}
        labelFor={(s) => s}
        onToggle={(s) => setParams((prev) => toggleParam(prev, 'type', s), { replace: true })}
      />

      <ListInner
        key={params.toString()}
        section={section}
        status={status}
        risk={risk}
        type={type}
        q={q}
      />
    </div>
  );
}

const SECTION_LABEL_INLINE: Record<ActionItemSection, string> = {
  new_business: 'New',
  old_business: 'Old',
  recommendation: 'Recommendation',
  completed_this_period: 'Completed',
  archived: 'Archived',
};

function toggleParam(prev: URLSearchParams, key: string, value: string): URLSearchParams {
  const cur = prev.getAll(key);
  prev.delete(key);
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  for (const v of next) prev.append(key, v);
  return prev;
}

function ListInner({
  section,
  status,
  risk,
  type,
  q,
}: {
  section: ActionItemSection[];
  status: ActionItemStatus[];
  risk: ActionItemRisk[];
  type: ActionItemType[];
  q: string;
}): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<ActionItemListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    actionItemsApi
      .list({
        section: section.length > 0 ? section : undefined,
        status: status.length > 0 ? status : undefined,
        risk: risk.length > 0 ? risk : undefined,
        type: type.length > 0 ? type : undefined,
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
  }, [section, status, risk, type, q]);

  if (error) {
    return (
      <div className="mt-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
        {error}
      </div>
    );
  }
  if (!items) return <div className="mt-4 text-sm text-muted-foreground">Loading…</div>;
  if (items.length === 0) {
    const filtersApplied =
      section.length + status.length + risk.length + type.length + (q ? 1 : 0) > 0;
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
          {filtersApplied ? 'No action items match the current filters.' : 'No action items yet.'}
        </div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Raise an action item from a hazard, a meeting insight, or directly from the form. Every
          section move is anchored in the audit chain.
        </p>
        <div className="mt-4">
          <Button asChild size="sm" className="h-9">
            <Link to="/action-items/new">
              <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Raise an action item
            </Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <ul className="mt-4 space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <ActionItemCard item={item} />
        </li>
      ))}
    </ul>
  );
}

function ActionItemCard({ item }: { item: ActionItemListItem }): JSX.Element {
  return (
    <Link
      to={`/action-items/${encodeURIComponent(item.id)}`}
      className="block rounded-md border border-border bg-card p-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <div className="flex items-start gap-2.5">
        <RiskDot risk={item.risk} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              #{item.sequenceNumber}
            </span>
            <SectionBadge section={item.section} />
            <StatusBadge status={item.status} />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {item.type}
            </span>
            <ActionFlagBadge flag={item.flag} />
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground">{item.summary}</div>
        </div>
      </div>
    </Link>
  );
}

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
      <label htmlFor="action-items-search" className="sr-only">
        Search action items by description preview
      </label>
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          id="action-items-search"
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search description"
          className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <Button type="submit" size="sm" className="h-9">
        Search
      </Button>
    </form>
  );
}

function ChipGroup<T extends string>({
  label,
  all,
  selected,
  labelFor,
  onToggle,
}: {
  label: string;
  all: ReadonlyArray<T>;
  selected: ReadonlyArray<T>;
  labelFor: (v: T) => string;
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
            {labelFor(v)}
          </button>
        );
      })}
    </div>
  );
}
