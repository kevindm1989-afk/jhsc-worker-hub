// /minutes — Milestone 2.1 S3, ADR-0012 §3.5.
//
// Replaces the 1.1 placeholder. The Minutes tab is the operational hub
// per CLAUDE.md "Minutes-centric." This view is the meetings list +
// "Start new meeting" CTA + filter chips. Card-list density per
// CLAUDE.md UI conventions; status color paired with icon + label
// (never color alone).
//
// Mobile-primary per non-negotiable #9: cards render single-column at
// 390px with a sticky bottom CTA; desktop gets a top-right CTA and a
// max-width container. The filter row scrolls horizontally on mobile.
//
// Empty state cites the statutory anchor (OHSA s.9 / CLC s.135) so the
// rep knows where the affordance comes from. No marketing flourishes.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CalendarClock,
  CheckCircle2,
  ClockArrowUp,
  Hourglass,
  Pause,
  Plus,
  ScrollText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MeetingApiError, meetingsApi, type MeetingListItem } from '@/meetings/api';
import { meetingStatus, type MeetingStatus } from '@jhsc/shared-types';

const STATUS_LABELS: Readonly<Record<MeetingStatus, string>> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  adjourned: 'Adjourned',
  pending_finalization: 'Pending finalization',
  finalized: 'Finalized',
  archived: 'Archived',
};

const STATUS_ICONS: Readonly<Record<MeetingStatus, typeof CalendarClock>> = {
  scheduled: CalendarClock,
  in_progress: ClockArrowUp,
  adjourned: Pause,
  pending_finalization: Hourglass,
  finalized: CheckCircle2,
  archived: ScrollText,
};

const STATUS_COLOR: Readonly<Record<MeetingStatus, string>> = {
  scheduled: 'border-blue-300 bg-blue-50 text-blue-800',
  in_progress: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  adjourned: 'border-amber-300 bg-amber-50 text-amber-800',
  pending_finalization: 'border-amber-300 bg-amber-50 text-amber-800',
  finalized: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  archived: 'border-zinc-300 bg-zinc-50 text-zinc-700',
};

export function MinutesView(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const statusFilter = (params.get('status') as MeetingStatus | null) ?? null;

  const setStatus = (s: MeetingStatus | null): void => {
    setParams(
      (prev) => {
        if (s === null) prev.delete('status');
        else prev.set('status', s);
        return prev;
      },
      { replace: true },
    );
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-6">
      <header className="mb-4 flex items-start justify-between gap-3 md:mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Minutes
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            JHSC meetings and the 21-day s.9(21) clock.
          </p>
        </div>
        <Button asChild size="sm" className="hidden h-9 md:inline-flex" data-print="hide">
          <Link to="/meetings/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Start new meeting
          </Link>
        </Button>
      </header>

      <StatusFilterChips selected={statusFilter} onSelect={setStatus} />

      <MeetingListInner key={statusFilter ?? '__all__'} statusFilter={statusFilter} />

      {/* Sticky bottom CTA on mobile (md:hidden). */}
      <div
        data-print="hide"
        className="fixed inset-x-0 bottom-16 z-40 mx-auto flex max-w-5xl items-center justify-center px-4 md:hidden"
      >
        <Button asChild className="h-12 w-full shadow-lg">
          <Link to="/meetings/new">
            <Plus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            Start new meeting
          </Link>
        </Button>
      </div>
    </div>
  );
}

function StatusFilterChips({
  selected,
  onSelect,
}: {
  selected: MeetingStatus | null;
  onSelect: (s: MeetingStatus | null) => void;
}): JSX.Element {
  const labelId = useMemo(() => 'filter-meeting-status', []);
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-print="hide"
      className="mb-3 -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1"
    >
      <span id={labelId} className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        Status
      </span>
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-pressed={selected === null}
        className={cn(
          'shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
          selected === null
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border bg-card text-muted-foreground hover:bg-muted',
        )}
      >
        All
      </button>
      {meetingStatus.map((s) => {
        const active = selected === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onSelect(active ? null : s)}
            aria-pressed={active}
            className={cn(
              'shrink-0 rounded-full border px-2.5 py-0.5 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:bg-muted',
            )}
          >
            {STATUS_LABELS[s]}
          </button>
        );
      })}
    </div>
  );
}

function MeetingListInner({ statusFilter }: { statusFilter: MeetingStatus | null }): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<MeetingListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    meetingsApi
      .list({ status: statusFilter ?? undefined })
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof MeetingApiError) {
          setError(`Could not load meetings (HTTP ${e.status}).`);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter]);

  if (error) {
    return (
      <div className="mt-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
        {error}
      </div>
    );
  }
  if (!items) return <MeetingListSkeleton />;
  if (items.length === 0) {
    return <MeetingEmptyState filtersApplied={statusFilter !== null} />;
  }
  return (
    <ul className="mt-4 space-y-2" data-testid="meetings-list">
      {items.map((m) => (
        <li key={m.id}>
          <MeetingCard meeting={m} />
        </li>
      ))}
    </ul>
  );
}

function MeetingCard({ meeting }: { meeting: MeetingListItem }): JSX.Element {
  const Icon = STATUS_ICONS[meeting.status];
  return (
    <Link
      to={`/meetings/${encodeURIComponent(meeting.id)}`}
      className="block rounded-md border border-border bg-card p-3 hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-ring"
      data-print="card"
    >
      <div className="flex items-start gap-2.5">
        <ScrollText
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">
              {meeting.meetingDate}
            </span>
            <StatusBadge status={meeting.status} icon={Icon} />
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              agenda v{meeting.agendaTemplateVersion}
            </span>
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {meeting.location ?? 'Location TBD'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{meeting.id.slice(0, 8)}</span>
            <span>·</span>
            <span>
              {new Date(meeting.scheduledStartAt).toLocaleString(undefined, {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
            {meeting.actualEndAt ? (
              <>
                <span>·</span>
                <span>adjourned {new Date(meeting.actualEndAt).toLocaleDateString()}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </Link>
  );
}

function StatusBadge({
  status,
  icon: Icon,
}: {
  status: MeetingStatus;
  icon: typeof CalendarClock;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        STATUS_COLOR[status],
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function MeetingListSkeleton(): JSX.Element {
  return (
    <ul className="mt-4 space-y-2" aria-busy="true" aria-label="Loading meetings">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-20 animate-pulse rounded-md border border-border bg-muted/40" />
      ))}
    </ul>
  );
}

function MeetingEmptyState({ filtersApplied }: { filtersApplied: boolean }): JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center justify-center px-6 py-12 text-center md:py-16">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
        <ScrollText
          className="h-6 w-6 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
      <div className="mb-1 text-base font-medium text-foreground">
        {filtersApplied ? 'No meetings match the current filter.' : 'No meetings yet.'}
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filtersApplied
          ? 'Clear the filter or start a new meeting.'
          : 'Start your first meeting to begin tracking action items, attendance, and recommendations under OHSA s.9 / CLC s.135.'}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button asChild size="sm" className="h-9">
          <Link to="/meetings/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Start new meeting
          </Link>
        </Button>
      </div>
    </div>
  );
}

export { STATUS_LABELS as MEETING_STATUS_LABELS };
