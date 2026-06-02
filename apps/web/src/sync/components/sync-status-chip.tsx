// Sync status chip (Milestone 1.10 S3, ADR-0009 §3.11).
//
// Top-right (desktop) / top header (mobile) chrome chip that renders one
// of four visual states pulled live from the SyncQueueWorker singleton:
//
//   - synced    (green, CloudCheck)
//   - syncing   (blue, RefreshCw spinning, count)
//   - offline   (zinc, CloudOff)
//   - paused    (amber, AlertTriangle, count + reason tooltip)
//
// CLAUDE.md design rules (status semantics):
//   - color + icon + label, never color alone
//   - touch target ≥ 44pt on mobile
//   - mobile-primary (the chip itself is small, but the tap target is
//     padded to 44pt)
//
// SECURITY.md §2.10 T-S39 (false-Synced): the chip's state is computed
// from Dexie's queue / conflicts / dead-letter counts via
// refreshStatusFromDb on every worker pass. We never label the chip
// "Synced" if there's pending or unresolved work — the worker pushes
// status to subscribers on every drain.
//
// Clicking the chip opens the sync panel (sync-panel.tsx) — the chip
// itself is just the trigger; the panel renders the detail.

import { useState } from 'react';
import { AlertTriangle, CloudCheck, CloudOff, RefreshCw } from 'lucide-react';
import type { SyncStatus } from '../queue-worker';
import { useSyncStatus } from '../worker-singleton';
import { SyncPanel } from './sync-panel';

/** Resolved view-model for a single status. Pure function of SyncStatus. */
interface ChipVisual {
  readonly label: string;
  readonly tooltip: string;
  readonly variant: 'synced' | 'syncing' | 'offline' | 'paused';
  readonly icon: JSX.Element;
}

function resolveVisual(status: SyncStatus): ChipVisual {
  switch (status.kind) {
    case 'synced':
      return {
        label: 'Synced',
        tooltip: 'All local changes have reached the server.',
        variant: 'synced',
        icon: (
          <CloudCheck
            className="h-3.5 w-3.5 text-status-resolved"
            strokeWidth={2}
            aria-hidden="true"
          />
        ),
      };
    case 'syncing': {
      const total = status.inFlight + status.queued;
      return {
        label: total > 0 ? `Syncing ${total}…` : 'Syncing…',
        tooltip:
          total > 0
            ? `${status.inFlight} in flight, ${status.queued} queued.`
            : 'Draining the queue.',
        variant: 'syncing',
        icon: (
          <RefreshCw
            className="h-3.5 w-3.5 animate-spin text-status-info"
            strokeWidth={2}
            aria-hidden="true"
          />
        ),
      };
    }
    case 'offline':
      return {
        label: 'Offline',
        tooltip:
          status.queued > 0
            ? `${status.queued} change${status.queued === 1 ? '' : 's'} will sync when you're back online.`
            : "You're offline. Changes will sync when you're back online.",
        variant: 'offline',
        icon: (
          <CloudOff
            className="h-3.5 w-3.5 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
        ),
      };
    case 'paused': {
      const queuedNote =
        status.queued > 0
          ? `, ${status.queued} other op${status.queued === 1 ? '' : 's'} waiting`
          : '';
      const reasonLabel =
        status.reason === 'conflicts'
          ? 'A sync conflict needs your decision'
          : status.reason === 'dead_letter'
            ? 'An operation hit the retry ceiling'
            : status.reason;
      return {
        label: `Sync paused — ${status.reason === 'conflicts' ? 'conflict' : 'attention'} to resolve`,
        tooltip: `${reasonLabel}${queuedNote}.`,
        variant: 'paused',
        icon: (
          <AlertTriangle
            className="h-3.5 w-3.5 text-status-pending"
            strokeWidth={2}
            aria-hidden="true"
          />
        ),
      };
    }
  }
}

/** Tailwind class string per chip variant. Pairs the icon's accent
 * color with a low-saturation tinted background so the chip reads at a
 * glance without becoming marketing-loud. */
function variantClasses(variant: ChipVisual['variant']): string {
  switch (variant) {
    case 'synced':
      return 'border-status-resolved/30 bg-status-resolved/10 text-foreground';
    case 'syncing':
      return 'border-status-info/30 bg-status-info/10 text-foreground';
    case 'offline':
      return 'border-border bg-muted text-foreground';
    case 'paused':
      return 'border-status-pending/40 bg-status-pending/10 text-foreground';
  }
}

/**
 * The chip itself. Renders a button → opens the SyncPanel sheet on click.
 *
 * ARIA:
 *   - aria-label includes the textual state so screen readers describe
 *     the affordance fully even without expanding the panel.
 *   - title carries the longer tooltip copy for hover.
 *   - aria-haspopup="dialog" matches the panel surface kind.
 */
export function SyncStatusChip(): JSX.Element {
  const status = useSyncStatus();
  const visual = resolveVisual(status);
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        title={visual.tooltip}
        aria-label={`Sync status: ${visual.label}. Open sync panel.`}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        data-sync-state={visual.variant}
        className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:min-h-0 md:py-1 ${variantClasses(visual.variant)}`}
      >
        {visual.icon}
        <span>{visual.label}</span>
      </button>
      <SyncPanel open={panelOpen} onOpenChange={setPanelOpen} />
    </>
  );
}
