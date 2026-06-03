// In-meeting section move history (Milestone 2.2 S3, ADR-0013 §3.6).
//
// Scoped per S0 user-decision Q5: this surface renders ONLY the moves
// that happened in the current meeting. Cross-meeting move history
// lives in the action-item detail view (one tap away).
//
// Data source: GET /api/action-items?meetingId=<id> + the per-item
// move history is fetched per-row from the detail endpoint when the
// rep expands the collapsible. The cheap initial render uses the
// move metadata already cached client-side via the per-item Dexie
// rows (the queue-worker writes action_item_moves on each successful
// move drain).
//
// Print posture (data-print="card"):
//   - The list renders in the printed minutes per ADR §3.6.
//   - Chrome (collapse affordance) carries data-print="hide".
//   - Timestamps render as JetBrains-Mono via the
//     data-print="evidentiary" rule in @media print.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SectionMoveHistoryEntry {
  readonly id: string;
  readonly actionItemId: string;
  readonly fromSection: string | null;
  readonly toSection: string;
  readonly movedAt: string;
  readonly actorDisplay: string | null;
  readonly sequenceNumber?: number | null;
}

interface SectionMoveHistoryProps {
  readonly moves: ReadonlyArray<SectionMoveHistoryEntry>;
  /** When set, restricts to moves that touched this section (either
   *  from or to). Used when the component renders inside a specific
   *  section panel. */
  readonly section?: string;
  /** Default collapsed-on-mount when true (mobile default). */
  readonly defaultCollapsed?: boolean;
}

export function SectionMoveHistory({
  moves,
  section,
  defaultCollapsed = true,
}: SectionMoveHistoryProps): JSX.Element {
  const filtered = useMemo(() => {
    if (!section) return moves;
    return moves.filter((m) => m.toSection === section || m.fromSection === section);
  }, [moves, section]);
  const [open, setOpen] = useState(!defaultCollapsed);

  return (
    <div className="mt-3 rounded-md border border-border bg-background/50" data-print="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-print="hide"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="inline-flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Move history this meeting
          <span className="ml-1 inline-flex items-center justify-center rounded-full border border-border bg-card px-1.5 font-mono text-[10px] tabular-nums text-foreground">
            {filtered.length}
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        )}
      </button>

      <div className={cn('border-t border-border px-3 py-2', open ? '' : 'hidden print:block')}>
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">No moves in this meeting yet.</p>
        ) : (
          <ol className="space-y-2">
            {filtered.map((m) => (
              <li key={m.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span
                  className="font-mono text-[11px] tabular-nums text-muted-foreground"
                  data-print="evidentiary"
                >
                  {new Date(m.movedAt).toLocaleTimeString()}
                </span>
                <span className="text-foreground">
                  {m.fromSection ? (
                    <>
                      {humanise(m.fromSection)} → {humanise(m.toSection)}
                    </>
                  ) : (
                    <>Created → {humanise(m.toSection)}</>
                  )}
                </span>
                {m.actorDisplay ? (
                  <span className="text-muted-foreground">· {m.actorDisplay}</span>
                ) : null}
                {typeof m.sequenceNumber === 'number' ? (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    #{m.sequenceNumber}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function humanise(section: string): string {
  return section.replace(/_/g, ' ');
}
