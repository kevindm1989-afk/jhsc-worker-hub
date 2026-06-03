// ConflictDiffRow — field-by-field 3-way diff for conflict_pending rows
// (Milestone 1.11 S3, ADR-0010 §3.7 + SECURITY T-X22).
//
// "Conflict" means: the parsed content_hash matches an existing
// action_item AND the existing row has been actor-edited since its
// prior import (editedSinceLastImport=true). The rep must decide, per
// field, whether to keep the in-app value ("yours") or the workbook
// value ("from file"). The 3-column shape is:
//
//   Field        |  In app (yours)  |  From workbook (incoming)
//   ----------------------------------------------------------
//   status       |  In Progress     |  Closed
//   risk         |  High            |  Critical
//   targetDate   |  2026-06-10      |  2026-06-15
//
// The per-field radio is "Keep yours" / "Use from file"; the row's
// overall decision is computed by the parent (all-yours → effectively
// skip; ≥1 from-file → update). The rep cannot mix-and-match here —
// the field-level decisions are explicit; the parent maps them to the
// commit operation.
//
// Per CLAUDE.md "no information by color alone": the diff cells pair
// color (red/amber for differing) with the explicit "DIFF" label.

import { useId } from 'react';
import { cn } from '@/lib/utils';
import type { ReconcileDecision } from '@jhsc/excel-import';

export type FieldResolution = 'keep_yours' | 'use_from_file';

export interface ConflictDiffRowProps {
  readonly decision: ReconcileDecision;
  readonly resolutions: Readonly<Record<string, FieldResolution>>;
  readonly onResolutionChange: (field: string, resolution: FieldResolution) => void;
}

export function ConflictDiffRow({
  decision,
  resolutions,
  onResolutionChange,
}: ConflictDiffRowProps): JSX.Element {
  return (
    <div className="rounded-md border border-red-200 bg-red-50/40 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-red-800">
        Conflict — resolve per field
      </div>
      <table className="w-full text-xs" aria-label="Conflict diff">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-2 font-medium uppercase tracking-wide text-[10px]">
              Field
            </th>
            <th scope="col" className="py-1 pr-2 font-medium uppercase tracking-wide text-[10px]">
              In app
            </th>
            <th scope="col" className="py-1 pr-2 font-medium uppercase tracking-wide text-[10px]">
              From workbook
            </th>
            <th scope="col" className="py-1 font-medium uppercase tracking-wide text-[10px]">
              Choose
            </th>
          </tr>
        </thead>
        <tbody>
          {decision.diff.map((d) => (
            <DiffRow
              key={d.field}
              field={d.field}
              current={d.current}
              incoming={d.incoming}
              resolution={resolutions[d.field] ?? 'keep_yours'}
              onChange={(r) => onResolutionChange(d.field, r)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffRow({
  field,
  current,
  incoming,
  resolution,
  onChange,
}: {
  field: string;
  current: string;
  incoming: string;
  resolution: FieldResolution;
  onChange: (r: FieldResolution) => void;
}): JSX.Element {
  const id = useId();
  return (
    <tr className="border-t border-red-100">
      <th scope="row" className="py-2 pr-2 align-top font-mono text-[11px] text-foreground">
        {field}
      </th>
      <td className="py-2 pr-2 align-top">
        <span
          className={cn(
            'inline-flex max-w-full items-center break-words rounded border px-1.5 py-0.5 font-mono text-[11px]',
            resolution === 'keep_yours'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-border bg-background text-muted-foreground',
          )}
        >
          {current === '' ? '∅' : current}
        </span>
      </td>
      <td className="py-2 pr-2 align-top">
        <span
          className={cn(
            'inline-flex max-w-full items-center break-words rounded border px-1.5 py-0.5 font-mono text-[11px]',
            resolution === 'use_from_file'
              ? 'border-blue-200 bg-blue-50 text-blue-900'
              : 'border-border bg-background text-muted-foreground',
          )}
        >
          {incoming === '' ? '∅' : incoming}
        </span>
      </td>
      <td className="py-2 align-top">
        <fieldset className="space-y-1" aria-labelledby={`${id}-legend`}>
          <legend id={`${id}-legend`} className="sr-only">
            Resolution for field {field}
          </legend>
          <label className="flex items-center gap-1.5 text-[11px]">
            <input
              type="radio"
              name={`resolve-${id}`}
              value="keep_yours"
              checked={resolution === 'keep_yours'}
              onChange={() => onChange('keep_yours')}
              className="h-3 w-3 accent-emerald-600"
            />
            <span>Keep yours</span>
          </label>
          <label className="flex items-center gap-1.5 text-[11px]">
            <input
              type="radio"
              name={`resolve-${id}`}
              value="use_from_file"
              checked={resolution === 'use_from_file'}
              onChange={() => onChange('use_from_file')}
              className="h-3 w-3 accent-blue-600"
            />
            <span>Use from file</span>
          </label>
        </fieldset>
      </td>
    </tr>
  );
}
