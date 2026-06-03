// Small shared primitives for the excel-imports surface — status badges,
// PII flag chips, decision badges, the 30-day reverse-window helper.
//
// Per CLAUDE.md "Status semantics" pairing color + icon + label:
//   pending   → zinc        (neutral / pre-bridge)
//   preview   → blue        (informational — work in progress)
//   committed → green       (verified, anchored)
//   cancelled → zinc-muted  (closed, no commit)
//   reversed  → amber       (pending — undone, but the original anchor stays)
//
// Decision-kind badges (per-row in preview):
//   create            → blue   (new row will be created)
//   update            → amber  (existing row will be patched)
//   skip              → zinc   (no-op; same content already in app)
//   conflict_pending  → red    (rep must resolve before commit)

import { CheckCircle2, FileWarning, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ExcelImportStatus } from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Import-status badge
// ---------------------------------------------------------------------------

interface BadgeStyle {
  readonly label: string;
  readonly chip: string;
}

const STATUS_STYLES: Record<ExcelImportStatus, BadgeStyle> = {
  pending: {
    label: 'Pending',
    chip: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  },
  preview: {
    label: 'Preview',
    chip: 'bg-blue-50 text-blue-700 border-blue-100',
  },
  committed: {
    label: 'Committed',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  },
  cancelled: {
    label: 'Cancelled',
    chip: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  },
  reversed: {
    label: 'Reversed',
    chip: 'bg-amber-50 text-amber-700 border-amber-100',
  },
};

export const IMPORT_STATUS_LABELS: Readonly<Record<ExcelImportStatus, string>> = Object.fromEntries(
  (Object.entries(STATUS_STYLES) as Array<[ExcelImportStatus, BadgeStyle]>).map(([k, v]) => [
    k,
    v.label,
  ]),
) as Record<ExcelImportStatus, string>;

export function ImportStatusBadge({ status }: { status: ExcelImportStatus }): JSX.Element {
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
// Decision-kind badge — per-row in the preview
// ---------------------------------------------------------------------------

export type DecisionKind = 'create' | 'update' | 'skip' | 'conflict_pending';

const DECISION_STYLES: Record<DecisionKind, BadgeStyle> = {
  create: {
    label: 'Create',
    chip: 'bg-blue-50 text-blue-700 border-blue-100',
  },
  update: {
    label: 'Update',
    chip: 'bg-amber-50 text-amber-800 border-amber-100',
  },
  skip: {
    label: 'Skip',
    chip: 'bg-zinc-100 text-zinc-600 border-zinc-200',
  },
  conflict_pending: {
    label: 'Conflict',
    chip: 'bg-red-50 text-red-700 border-red-100',
  },
};

export function DecisionBadge({ kind }: { kind: DecisionKind }): JSX.Element {
  const s = DECISION_STYLES[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        s.chip,
      )}
      aria-label={`Decision: ${s.label}`}
    >
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PII flag chip — small badge for each detected class.
// ---------------------------------------------------------------------------

export type PiiClass = 'nameShape' | 'emailShape' | 'phoneShape' | 'sinShape';

const PII_LABELS: Record<PiiClass, string> = {
  nameShape: 'name',
  emailShape: 'email',
  phoneShape: 'phone',
  sinShape: 'SIN',
};

/**
 * Small inline PII flag chip. Amber-toned to signal "rep should review";
 * never red — the field is encrypted regardless of flag (ADR-0010 §3.5),
 * so the badge is a UX nudge, not a data gate.
 */
export function PiiFlagChip({ kind }: { kind: PiiClass }): JSX.Element {
  return (
    <span
      className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800"
      aria-label={`Detected ${PII_LABELS[kind]}-shape data`}
      title={`Looks like ${PII_LABELS[kind]} — encrypted before upload regardless.`}
    >
      {PII_LABELS[kind]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Reverse-window helper — central source of truth for the 30-day rule.
// ---------------------------------------------------------------------------

export const REVERSE_WINDOW_DAYS = 30;

/** Returns true when `committedAt` is within `REVERSE_WINDOW_DAYS` of `now`. */
export function isWithinReverseWindow(committedAt: string | null, now: Date = new Date()): boolean {
  if (!committedAt) return false;
  const committed = new Date(committedAt);
  if (Number.isNaN(committed.getTime())) return false;
  const ms = now.getTime() - committed.getTime();
  const days = ms / (24 * 60 * 60 * 1000);
  return days >= 0 && days < REVERSE_WINDOW_DAYS;
}

/** Days remaining in the reverse window — clamped to [0, REVERSE_WINDOW_DAYS]. */
export function reverseWindowDaysRemaining(
  committedAt: string | null,
  now: Date = new Date(),
): number {
  if (!committedAt) return 0;
  const committed = new Date(committedAt);
  if (Number.isNaN(committed.getTime())) return 0;
  const elapsedMs = now.getTime() - committed.getTime();
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  const remaining = REVERSE_WINDOW_DAYS - elapsedDays;
  if (remaining < 0) return 0;
  if (remaining > REVERSE_WINDOW_DAYS) return REVERSE_WINDOW_DAYS;
  return Math.ceil(remaining);
}

/** ISO-formatted moment when the reverse window expires for `committedAt`. */
export function reverseWindowExpiresAt(committedAt: string): string {
  const committed = new Date(committedAt);
  const expires = new Date(committed.getTime() + REVERSE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}

// ---------------------------------------------------------------------------
// Small inline state icons re-exported so the views import once.
// ---------------------------------------------------------------------------

export const ImportStatusIcons = {
  /** Anchored — the import is committed; chain row stamped. */
  Committed: ShieldCheck,
  /** Reversed — the commit's effects were rolled back inside the 30-day window. */
  Reversed: Undo2,
  /** Cancelled — pending/preview import was abandoned. */
  Cancelled: XCircle,
  /** Issue (validation error, conflict). */
  Issue: FileWarning,
  /** Resolved (a single conflict the rep cleared). */
  Resolved: CheckCircle2,
};
