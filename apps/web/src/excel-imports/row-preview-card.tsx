// RowPreviewCard — per-row affordance in the preview step.
//
// Per ADR-0010 §3.7 the row card shows: decision badge (create / update /
// skip / conflict), description (truncated), risk, dates, section, PII
// flag chips. Affordances: Edit (inline editor for description, risk,
// target_date), Skip (flips to skipped), per-row conflict decision via
// the ConflictDiffRow child (when decisionKind=='conflict_pending').
//
// XSS posture (SECURITY T-X26): every cell value is rendered via React's
// text-content path. No `dangerouslySetInnerHTML` anywhere. The
// description is rendered through a `<p>` text node so any embedded
// HTML markers stay as literal characters.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Edit3, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ParsedActionItem, PiiFlags, ReconcileDecision } from '@jhsc/excel-import';
import { actionItemRisk, type ActionItemRisk } from '@jhsc/shared-types';
import { ConflictDiffRow, type FieldResolution } from './conflict-diff-row';
import { DecisionBadge, type DecisionKind, PiiFlagChip, type PiiClass } from './components';

// ---------------------------------------------------------------------------
// Editable overrides — what the rep can change from the inline editor.
// ---------------------------------------------------------------------------

export interface RowEdits {
  readonly risk?: ActionItemRisk;
  readonly targetDate?: string | null;
  /** User-facing description override (very rare); kept optional. */
  readonly description?: string;
}

export interface RowPreviewCardProps {
  readonly decision: ReconcileDecision;
  readonly piiFlags: PiiFlags;
  readonly edits: RowEdits;
  readonly skipped: boolean;
  readonly conflictResolutions: Readonly<Record<string, FieldResolution>>;
  readonly onEditChange: (edits: RowEdits) => void;
  readonly onToggleSkip: () => void;
  readonly onConflictResolutionChange: (field: string, resolution: FieldResolution) => void;
}

export function RowPreviewCard({
  decision,
  piiFlags,
  edits,
  skipped,
  conflictResolutions,
  onEditChange,
  onToggleSkip,
  onConflictResolutionChange,
}: RowPreviewCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(decision.decisionKind === 'conflict_pending');
  const row = decision.parsed;

  // Effective decision kind: 'skip' overrides anything else.
  const effectiveKind: DecisionKind = skipped ? 'skip' : decision.decisionKind;
  const effectiveDescription = edits.description ?? row.description;
  const effectiveRisk = edits.risk ?? row.risk;
  const effectiveTargetDate = edits.targetDate !== undefined ? edits.targetDate : row.targetDate;

  return (
    <li
      className={cn(
        'rounded-md border bg-card p-3',
        effectiveKind === 'conflict_pending'
          ? 'border-red-200'
          : skipped
            ? 'border-zinc-200 opacity-70'
            : 'border-border',
      )}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse row details' : 'Expand row details'}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 shrink-0 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <DecisionBadge kind={effectiveKind} />
            <span className="font-mono text-[11px] text-muted-foreground">
              row {row.sourceRowIndex} · {row.sourceSheet}
            </span>
            <RiskBadge risk={effectiveRisk} />
            <PiiFlagChips flags={piiFlags} />
          </div>
          <p className="mt-1.5 line-clamp-2 break-words text-sm text-foreground">
            {effectiveDescription}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>start {row.startDate}</span>
            {effectiveTargetDate ? (
              <>
                <span>·</span>
                <span>target {effectiveTargetDate}</span>
              </>
            ) : null}
            {row.closedDate ? (
              <>
                <span>·</span>
                <span>closed {row.closedDate}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{row.section.replace(/_/g, ' ')}</span>
            {row.type !== 'OTHER' ? (
              <>
                <span>·</span>
                <span className="font-mono">{row.type}</span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleSkip}
            aria-pressed={skipped}
            title={skipped ? 'Restore row' : 'Skip row'}
          >
            {skipped ? (
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 rotate-180" strokeWidth={2} aria-hidden="true" />
            )}
            <span className="sr-only">{skipped ? 'Restore' : 'Skip'}</span>
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 border-t border-border pt-3">
          {decision.decisionKind === 'conflict_pending' && !skipped ? (
            <ConflictDiffRow
              decision={decision}
              resolutions={conflictResolutions}
              onResolutionChange={onConflictResolutionChange}
            />
          ) : null}
          <InlineEditor row={row} edits={edits} onChange={onEditChange} disabled={skipped} />
          {Object.keys(row.importWarnings).length > 0 ? (
            <ImportWarnings warnings={row.importWarnings} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Inline editor — small risk / targetDate override surface.
// ---------------------------------------------------------------------------

function InlineEditor({
  row,
  edits,
  onChange,
  disabled,
}: {
  row: ParsedActionItem;
  edits: RowEdits;
  onChange: (edits: RowEdits) => void;
  disabled: boolean;
}): JSX.Element {
  const effectiveRisk = edits.risk ?? row.risk;
  const effectiveTarget =
    edits.targetDate !== undefined ? (edits.targetDate ?? '') : (row.targetDate ?? '');
  return (
    <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
      <label className="flex flex-col gap-1 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Edit3 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Risk
        </span>
        <select
          value={effectiveRisk}
          disabled={disabled}
          onChange={(e) => onChange({ ...edits, risk: e.target.value as ActionItemRisk })}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        >
          {actionItemRisk.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Edit3 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Target date
        </span>
        <input
          type="date"
          value={effectiveTarget}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...edits, targetDate: e.target.value === '' ? null : e.target.value })
          }
          className="rounded border border-border bg-background px-2 py-1 text-xs"
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk badge
// ---------------------------------------------------------------------------

const RISK_STYLES: Record<ActionItemRisk, string> = {
  Low: 'border-emerald-100 bg-emerald-50 text-emerald-900',
  Medium: 'border-blue-100 bg-blue-50 text-blue-900',
  High: 'border-amber-100 bg-amber-50 text-amber-900',
  Critical: 'border-red-200 bg-red-50 text-red-800',
};

function RiskBadge({ risk }: { risk: ActionItemRisk }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        RISK_STYLES[risk],
      )}
      aria-label={`Risk: ${risk}`}
    >
      {risk}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PII flag chips
// ---------------------------------------------------------------------------

function PiiFlagChips({ flags }: { flags: PiiFlags }): JSX.Element | null {
  const present: PiiClass[] = [];
  if (flags.nameShape) present.push('nameShape');
  if (flags.emailShape) present.push('emailShape');
  if (flags.phoneShape) present.push('phoneShape');
  if (flags.sinShape) present.push('sinShape');
  if (present.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {present.map((c) => (
        <PiiFlagChip key={c} kind={c} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Import warnings — surfaced from the parser
// ---------------------------------------------------------------------------

function ImportWarnings({ warnings }: { warnings: Readonly<Record<string, string>> }): JSX.Element {
  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide">Parser warnings</div>
      <ul className="ml-4 list-disc space-y-0.5">
        {Object.entries(warnings).map(([k, v]) => (
          <li key={k}>
            <span className="font-mono">{k}</span>: {v}
          </li>
        ))}
      </ul>
    </div>
  );
}
