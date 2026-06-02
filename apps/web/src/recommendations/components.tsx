// Small primitives shared by the recommendations list, detail, drafting,
// and dialog surfaces.
//
// CLAUDE.md §"Status semantics": red = open/danger, amber = pending,
// green = resolved, blue = informational, zinc = neutral/archived.
// Pair color with label — never color alone. Aria labels included on
// every badge.
//
// Status palette (ADR-0008 §3.1):
//   draft               → zinc       (neutral / pre-bridge)
//   submitted           → blue       (informational — clock running)
//   response_received   → amber      (pending — needs resolution decision)
//   resolved            → emerald    (resolved)
//   withdrawn           → zinc-muted (closed without resolution)

import { cn } from '@/lib/utils';
import type {
  RecommendationDeadlineState,
  RecommendationJurisdiction,
  RecommendationStatus,
} from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

interface StatusStyle {
  readonly label: string;
  readonly chip: string;
}

const STATUS_STYLES: Record<RecommendationStatus, StatusStyle> = {
  draft: {
    label: 'Draft',
    chip: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  },
  submitted: {
    label: 'Submitted',
    chip: 'bg-blue-50 text-blue-700 border-blue-100',
  },
  response_received: {
    label: 'Response received',
    chip: 'bg-amber-50 text-amber-700 border-amber-100',
  },
  resolved: {
    label: 'Resolved',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  },
  withdrawn: {
    label: 'Withdrawn',
    chip: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  },
};

export const STATUS_LABELS: Readonly<Record<RecommendationStatus, string>> = Object.fromEntries(
  (Object.entries(STATUS_STYLES) as Array<[RecommendationStatus, StatusStyle]>).map(([k, v]) => [
    k,
    v.label,
  ]),
) as Record<RecommendationStatus, string>;

export function RecommendationStatusBadge({
  status,
}: {
  status: RecommendationStatus;
}): JSX.Element {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        s.chip,
      )}
      aria-label={`Status: ${s.label}`}
    >
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Jurisdiction badge — ON vs CA-FED.
// ---------------------------------------------------------------------------

const JURISDICTION_STYLES: Record<RecommendationJurisdiction, StatusStyle> = {
  ON: {
    label: 'ON',
    chip: 'bg-slate-100 text-slate-700 border-slate-200',
  },
  'CA-FED': {
    label: 'CA-FED',
    chip: 'bg-slate-100 text-slate-700 border-slate-200',
  },
};

export const JURISDICTION_LABELS: Readonly<Record<RecommendationJurisdiction, string>> =
  Object.fromEntries(
    (Object.entries(JURISDICTION_STYLES) as Array<[RecommendationJurisdiction, StatusStyle]>).map(
      ([k, v]) => [k, v.label],
    ),
  ) as Record<RecommendationJurisdiction, string>;

export function JurisdictionBadge({
  jurisdiction,
}: {
  jurisdiction: RecommendationJurisdiction;
}): JSX.Element {
  const s = JURISDICTION_STYLES[jurisdiction];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        s.chip,
      )}
      aria-label={`Jurisdiction: ${s.label}`}
    >
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Deadline countdown badge — only meaningful when status='submitted' (or
// 'response_received' before resolution). Uses recommendationDeadlineState
// from shared-types as the source of truth.
//
// Renders:
//   - 'no_deadline'  → "No fixed clock (CLC s.135(6))"
//   - 'on_time'      → "Due in N day(s) (OHSA s.9(21))"  (or hours when ≤24h)
//   - 'overdue'      → "Overdue by N day(s)"             — red, alert role.
// ---------------------------------------------------------------------------

export function DeadlineBadge({
  state,
  deadline,
  jurisdiction,
  now,
}: {
  state: RecommendationDeadlineState;
  deadline: Date | null;
  jurisdiction: RecommendationJurisdiction;
  /** Override `now` for deterministic snapshot/tests. */
  now?: Date;
}): JSX.Element {
  if (state === 'no_deadline') {
    return (
      <span
        className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700"
        aria-label="No fixed deadline (CLC s.135(6))"
      >
        No fixed clock · CLC s.135(6)
      </span>
    );
  }
  const ref = now ?? new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffMs = (deadline?.getTime() ?? 0) - ref.getTime();
  const days = Math.ceil(diffMs / msPerDay);
  if (state === 'overdue') {
    const overdueDays = Math.max(1, Math.abs(days));
    return (
      <span
        role="alert"
        aria-label={`Overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'}`}
        className="inline-flex items-center rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-700"
      >
        Overdue · {overdueDays} day{overdueDays === 1 ? '' : 's'}
      </span>
    );
  }
  // on_time
  const remaining = Math.max(0, days);
  const anchor = jurisdiction === 'ON' ? 'OHSA s.9(21)' : 'CLC s.135(6)';
  return (
    <span
      aria-label={`Due in ${remaining} day${remaining === 1 ? '' : 's'} (${anchor})`}
      className="inline-flex items-center rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700"
    >
      Due in {remaining} day{remaining === 1 ? '' : 's'} · {anchor}
    </span>
  );
}
