// Small primitives shared by the list, detail, and intake surfaces.
// Living here in apps/web; lifts to packages/ui when a second consumer
// shows up (same rationale as the 1.4 CitationRef).

import { cn } from '@/lib/utils';
import type { HazardSeverity, HazardStatus } from '@jhsc/shared-types';

// CLAUDE.md §"Status semantics": red = open/danger, amber = pending,
// green = resolved, blue = informational, zinc = neutral/archived.
// Pair each color with a label — never color alone.

const STATUS_STYLES: Record<HazardStatus, { label: string; chip: string }> = {
  open: { label: 'Open', chip: 'bg-red-50 text-red-700 border-red-100' },
  assessing: { label: 'Assessing', chip: 'bg-amber-50 text-amber-700 border-amber-100' },
  assigned: { label: 'Assigned', chip: 'bg-blue-50 text-blue-700 border-blue-100' },
  resolved: { label: 'Resolved', chip: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  archived: { label: 'Archived', chip: 'bg-zinc-100 text-zinc-700 border-zinc-200' },
  withdrawn: { label: 'Withdrawn', chip: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
};

export function HazardStatusBadge({ status }: { status: HazardStatus }): JSX.Element {
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

const SEVERITY_STYLES: Record<HazardSeverity, { label: string; dot: string }> = {
  critical: { label: 'Critical', dot: 'bg-red-500' },
  high: { label: 'High', dot: 'bg-orange-500' },
  medium: { label: 'Medium', dot: 'bg-amber-500' },
  low: { label: 'Low', dot: 'bg-zinc-400' },
};

export function SeverityDot({ severity }: { severity: HazardSeverity }): JSX.Element {
  const s = SEVERITY_STYLES[severity];
  return (
    <span
      className={cn('block h-1.5 w-1.5 shrink-0 rounded-full', s.dot)}
      role="img"
      aria-label={`Severity: ${s.label}`}
    />
  );
}

export const STATUS_LABELS: Readonly<Record<HazardStatus, string>> = Object.fromEntries(
  (Object.entries(STATUS_STYLES) as Array<[HazardStatus, { label: string; chip: string }]>).map(
    ([k, v]) => [k, v.label],
  ),
) as Record<HazardStatus, string>;

export const SEVERITY_LABELS: Readonly<Record<HazardSeverity, string>> = Object.fromEntries(
  (Object.entries(SEVERITY_STYLES) as Array<[HazardSeverity, { label: string; dot: string }]>).map(
    ([k, v]) => [k, v.label],
  ),
) as Record<HazardSeverity, string>;
