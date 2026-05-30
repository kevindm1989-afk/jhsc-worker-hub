// Small primitives shared by the list, detail, and intake surfaces.

import { cn } from '@/lib/utils';
import type {
  ActionItemRisk,
  ActionItemSection,
  ActionItemStatus,
  ActionItemType,
} from '@jhsc/shared-types';
import type { ActionFlag } from '@jhsc/shared-types/action-item-flag';

const SECTION_STYLES: Record<ActionItemSection, { label: string; chip: string }> = {
  new_business: {
    label: 'New business',
    chip: 'bg-blue-50 text-blue-700 border-blue-100',
  },
  old_business: {
    label: 'Old business',
    chip: 'bg-amber-50 text-amber-700 border-amber-100',
  },
  recommendation: {
    label: 'Recommendation',
    chip: 'bg-red-50 text-red-700 border-red-100',
  },
  completed_this_period: {
    label: 'Completed',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  },
  archived: { label: 'Archived', chip: 'bg-zinc-100 text-zinc-700 border-zinc-200' },
};

export function SectionBadge({ section }: { section: ActionItemSection }): JSX.Element {
  const s = SECTION_STYLES[section];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        s.chip,
      )}
      aria-label={`Section: ${s.label}`}
    >
      {s.label}
    </span>
  );
}

const STATUS_STYLES: Record<ActionItemStatus, { label: string; chip: string }> = {
  'Not Started': { label: 'Not started', chip: 'bg-zinc-100 text-zinc-700 border-zinc-200' },
  'In Progress': { label: 'In progress', chip: 'bg-blue-50 text-blue-700 border-blue-100' },
  Blocked: { label: 'Blocked', chip: 'bg-amber-50 text-amber-700 border-amber-100' },
  'Pending Review': {
    label: 'Pending review',
    chip: 'bg-blue-50 text-blue-700 border-blue-100',
  },
  Closed: { label: 'Closed', chip: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  Cancelled: { label: 'Cancelled', chip: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
};

export function StatusBadge({ status }: { status: ActionItemStatus }): JSX.Element {
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

const RISK_STYLES: Record<ActionItemRisk, { label: string; dot: string }> = {
  Low: { label: 'Low risk', dot: 'bg-zinc-400' },
  Medium: { label: 'Medium risk', dot: 'bg-amber-500' },
  High: { label: 'High risk', dot: 'bg-orange-500' },
  Critical: { label: 'Critical risk', dot: 'bg-red-500' },
};

export function RiskDot({ risk }: { risk: ActionItemRisk }): JSX.Element {
  const s = RISK_STYLES[risk];
  return (
    <span
      className={cn('block h-1.5 w-1.5 shrink-0 rounded-full', s.dot)}
      role="img"
      aria-label={s.label}
    />
  );
}

// Action Flag renderer. Severity → color class. Pair with the emoji-in-
// label vocabulary from ARCHITECTURE.md §5 / CLAUDE.md design rules.
const FLAG_STYLES: Record<NonNullable<ActionFlag>['severity'], string> = {
  open: 'bg-red-50 text-red-700 border-red-100',
  pending: 'bg-amber-50 text-amber-700 border-amber-100',
  resolved: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  archived: 'bg-zinc-100 text-zinc-700 border-zinc-200',
};

export function ActionFlagBadge({ flag }: { flag: ActionFlag | null }): JSX.Element | null {
  if (!flag) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium',
        FLAG_STYLES[flag.severity],
      )}
    >
      {flag.label}
    </span>
  );
}

export const SECTION_LABELS: Readonly<Record<ActionItemSection, string>> = Object.fromEntries(
  (
    Object.entries(SECTION_STYLES) as Array<[ActionItemSection, { label: string; chip: string }]>
  ).map(([k, v]) => [k, v.label]),
) as Record<ActionItemSection, string>;

export const STATUS_LABELS: Readonly<Record<ActionItemStatus, string>> = Object.fromEntries(
  (Object.entries(STATUS_STYLES) as Array<[ActionItemStatus, { label: string; chip: string }]>).map(
    ([k, v]) => [k, v.label],
  ),
) as Record<ActionItemStatus, string>;

export const TYPE_LABELS: Readonly<Record<ActionItemType, string>> = {
  INSP: 'Inspection',
  INSIGHT: 'Insight',
  FLI: 'Floor/Lighting/Infra',
  INC: 'Incident',
  REC: 'Recommendation (REC)',
  TRAIN: 'Training',
  PROC: 'Procedure/SOP',
  OTHER: 'Other',
};

export const RISK_LABELS: Readonly<Record<ActionItemRisk, string>> = {
  Low: 'Low',
  Medium: 'Medium',
  High: 'High',
  Critical: 'Critical',
};
