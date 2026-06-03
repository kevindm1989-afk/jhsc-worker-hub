// ReconciliationSummary — the "X new / Y updated / Z conflicts / W
// skipped" header card on the preview step.
//
// Per ADR-0010 §3.7 / SECURITY T-X22 (conflict diff display): the summary
// is the rep's at-a-glance read of the import. The conflict count is
// the load-bearing number — commits with conflict_pending > 0 are
// blocked server-side (T-X22 + the route's 422 'conflicts_unresolved'
// response).
//
// PII rollup is the §3.5 nudge: it counts rows where the heuristic
// flagged name-shape / email / phone / SIN. The fields are encrypted
// regardless; this is documentary so the rep can scrub egregious cases
// (a typo'd SIN, a witness name in a Description) before commit.
//
// CLAUDE.md "Status semantics" pairing: each count cell carries the
// color band AND an icon AND a textual label. The conflict cell is red
// only when > 0; otherwise zinc — never color alone.

import { AlertTriangle, FilePlus2, Files, ShieldAlert, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PiiFlags, ReconciliationPlan } from '@jhsc/excel-import';

export interface PiiRollup {
  readonly nameShape: number;
  readonly emailShape: number;
  readonly phoneShape: number;
  readonly sinShape: number;
  // S5 priv-F5 close-out: extended-surface flags. The four classes
  // also run against the filename, the Minutes attendance, and the
  // joined Inspection Review snapshot. The rep sees a documentary
  // nudge per extra surface; the fields are sealed-box-encrypted
  // before upload regardless of the flag.
  readonly filenameHasAny?: boolean;
  readonly attendanceHasAny?: boolean;
  readonly snapshotHasAny?: boolean;
}

export function computePiiRollup(
  perRowFlags: ReadonlyArray<PiiFlags>,
  extras?: {
    filename?: PiiFlags | null;
    attendance?: PiiFlags | null;
    snapshot?: PiiFlags | null;
  },
): PiiRollup {
  let nameShape = 0;
  let emailShape = 0;
  let phoneShape = 0;
  let sinShape = 0;
  for (const f of perRowFlags) {
    if (f.nameShape) nameShape++;
    if (f.emailShape) emailShape++;
    if (f.phoneShape) phoneShape++;
    if (f.sinShape) sinShape++;
  }
  return {
    nameShape,
    emailShape,
    phoneShape,
    sinShape,
    filenameHasAny: extras?.filename ? hasAnyFlag(extras.filename) : false,
    attendanceHasAny: extras?.attendance ? hasAnyFlag(extras.attendance) : false,
    snapshotHasAny: extras?.snapshot ? hasAnyFlag(extras.snapshot) : false,
  };
}

function hasAnyFlag(f: PiiFlags): boolean {
  return f.nameShape || f.emailShape || f.phoneShape || f.sinShape;
}

export interface ReconciliationSummaryProps {
  readonly plan: ReconciliationPlan;
  readonly piiRollup: PiiRollup;
  readonly validationErrorCount: number;
}

export function ReconciliationSummary({
  plan,
  piiRollup,
  validationErrorCount,
}: ReconciliationSummaryProps): JSX.Element {
  const { summary } = plan;
  const hasConflicts = summary.conflictCount > 0;
  return (
    <section
      aria-labelledby="reconciliation-summary-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2
        id="reconciliation-summary-heading"
        className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Files className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Import preview · reconciliation
      </h2>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Cell
          label="New"
          count={summary.createCount}
          icon={FilePlus2}
          tone={summary.createCount > 0 ? 'info' : 'neutral'}
          aria-label-suffix="action items will be created"
        />
        <Cell
          label="Updated"
          count={summary.updateCount}
          icon={Files}
          tone={summary.updateCount > 0 ? 'pending' : 'neutral'}
          aria-label-suffix="existing action items will be patched"
        />
        <Cell
          label="Conflicts"
          count={summary.conflictCount}
          icon={ShieldAlert}
          tone={hasConflicts ? 'rejected' : 'neutral'}
          aria-label-suffix="rows the rep must resolve before commit"
        />
        <Cell
          label="Skipped"
          count={summary.skipCount}
          icon={SkipForward}
          tone="neutral"
          aria-label-suffix="rows already match the app's data"
        />
      </div>

      {hasConflicts ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 flex items-start gap-2 rounded-md border border-status-rejected/40 bg-status-rejected/5 p-2 text-xs text-status-rejected"
        >
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
          <span>
            Resolve every conflict-flagged row before committing — the server refuses commits with
            unresolved conflicts (422).
          </span>
        </div>
      ) : null}

      {validationErrorCount > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
        >
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
          <span>
            {validationErrorCount} row-level validation error{validationErrorCount === 1 ? '' : 's'}
            . Those rows are skipped — fix the workbook and re-upload if you need them in this
            import.
          </span>
        </div>
      ) : null}

      <PiiRollupRow rollup={piiRollup} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Count cell — single load-bearing card.
// ---------------------------------------------------------------------------

interface CellProps {
  readonly label: string;
  readonly count: number;
  readonly icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  readonly tone: 'info' | 'pending' | 'rejected' | 'resolved' | 'neutral';
  readonly 'aria-label-suffix': string;
}

const TONE_STYLES: Record<CellProps['tone'], string> = {
  info: 'border-blue-100 bg-blue-50 text-blue-800',
  pending: 'border-amber-100 bg-amber-50 text-amber-900',
  rejected: 'border-red-200 bg-red-50 text-red-800',
  resolved: 'border-emerald-100 bg-emerald-50 text-emerald-900',
  neutral: 'border-border bg-background text-foreground',
};

function Cell({ label, count, icon: Icon, tone, ...rest }: CellProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded border px-3 py-2 text-sm',
        TONE_STYLES[tone],
      )}
      aria-label={`${count} ${rest['aria-label-suffix']}`}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        <span className="text-xs uppercase tracking-wide">{label}</span>
      </div>
      <span className="font-mono text-base font-semibold tabular-nums">{count}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PII rollup — small documentary row below the counts.
// ---------------------------------------------------------------------------

function PiiRollupRow({ rollup }: { rollup: PiiRollup }): JSX.Element | null {
  const total = rollup.nameShape + rollup.emailShape + rollup.phoneShape + rollup.sinShape;
  const extraHits =
    (rollup.filenameHasAny ? 1 : 0) +
    (rollup.attendanceHasAny ? 1 : 0) +
    (rollup.snapshotHasAny ? 1 : 0);
  if (total === 0 && extraHits === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-border bg-background p-2 text-xs text-muted-foreground">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        PII heuristic
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {rollup.nameShape > 0 ? (
          <span>
            <span className="font-semibold text-amber-800">{rollup.nameShape}</span> row
            {rollup.nameShape === 1 ? '' : 's'} with name-shape
          </span>
        ) : null}
        {rollup.emailShape > 0 ? (
          <span>
            <span className="font-semibold text-amber-800">{rollup.emailShape}</span> with
            email-shape
          </span>
        ) : null}
        {rollup.phoneShape > 0 ? (
          <span>
            <span className="font-semibold text-amber-800">{rollup.phoneShape}</span> with
            phone-shape
          </span>
        ) : null}
        {rollup.sinShape > 0 ? (
          <span>
            <span className="font-semibold text-amber-800">{rollup.sinShape}</span> with SIN-shape
          </span>
        ) : null}
      </div>
      {/* S5 priv-F5 close-out: extended-surface flags. The four classes
          now run against the filename, the Minutes attendance, and the
          joined Inspection Review snapshot. These nudges surface the
          documentary risk to the rep BEFORE the sealed-box upload (the
          fields are sealed-box-encrypted regardless of the flag). */}
      {extraHits > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {rollup.filenameHasAny ? (
            <span>
              <span className="font-semibold text-amber-800">filename</span> may carry name / email
              / phone shape — consider renaming before upload
            </span>
          ) : null}
          {rollup.attendanceHasAny ? (
            <span>
              <span className="font-semibold text-amber-800">attendance</span> list contains
              name-shape entries
            </span>
          ) : null}
          {rollup.snapshotHasAny ? (
            <span>
              <span className="font-semibold text-amber-800">inspection-review snapshot</span>{' '}
              contains name / phone / SIN shape
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="mt-1 text-[11px] text-muted-foreground">
        The heuristic over-flags on purpose. These fields are sealed-box-encrypted in your browser
        before upload regardless. The flag is a chance to scrub before commit.
      </p>
    </div>
  );
}
