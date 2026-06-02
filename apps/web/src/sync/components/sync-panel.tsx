// Sync panel (Milestone 1.10 S3, ADR-0009 §3.11).
//
// Slide-over panel anchored from the SyncStatusChip. Four density-first
// subsections, all backed by live Dexie reads:
//
//   1. Status              — current SyncStatus + last-synced + "Sync now"
//   2. Pending operations  — sync_queue WHERE state IN (queued, in_flight)
//   3. Conflicts           — sync_conflicts WHERE resolved=false
//                            (each row links to the ConflictResolutionDialog)
//   4. Dead letter         — sync_queue WHERE state='failed_dead_letter'
//                            (Retry re-queues with attemptCount=0; Discard
//                             confirms then deletes the queue row + the
//                             optimistic entity row)
//
// CLAUDE.md design rules applied:
//   - mobile-primary: bottom-anchored sheet on phones, right slide-over
//     on desktop. (We render both as a CSS-positioned overlay rather
//     than introduce a new sheet primitive — the existing shadcn folder
//     only has Button + Badge.)
//   - density-first: each row is a compact 2-line card, not a paragraph.
//   - empty states do work: each subsection has constructive copy.
//   - destructive actions confirm: Discard requires a second tap.
//   - touch targets ≥ 44pt.
//
// The panel reloads its underlying rows on every open + every worker
// status push, so it doesn't grow stale while the rep is reading it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CloudCheck,
  CloudOff,
  GitMerge,
  Inbox,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { db } from '../db';
import type { SyncConflictRow, SyncQueueRow } from '../db';
import type { SyncEntityKind } from '@jhsc/shared-types';
import { useSyncStatus, getWorker } from '../worker-singleton';
import {
  PENDING_PAYLOAD_WARN_BYTES,
  computeSyncMetrics,
  formatAgeSeconds,
  formatBytes,
  formatMedianAttempts,
  type SyncMetrics,
} from '../metrics';
import { ConflictResolutionDialog } from './conflict-resolution-dialog';
import { PwaInstallPrompt } from './pwa-install-prompt';

interface SyncPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Friendly label for a sync entity kind. Used for the row identifier. */
function entityKindLabel(kind: SyncEntityKind): string {
  switch (kind) {
    case 'hazard':
      return 'Hazard';
    case 'action_item':
      return 'Action item';
    case 'action_item_move':
      return 'Action item move';
    case 'inspection':
      return 'Inspection';
    case 'inspection_finding':
      return 'Finding';
    case 'inspection_signature':
      return 'Inspection signature';
    case 'inspection_finding_promotion':
      return 'Finding promotion';
    case 'recommendation':
      return 'Recommendation';
    case 'recommendation_response':
      return 'Recommendation response';
    case 'recommendation_resolution':
      return 'Recommendation resolution';
    case 'recommendation_withdrawal':
      return 'Recommendation withdrawal';
    case 'evidence_finalize':
      return 'Evidence upload';
  }
}

/** Friendly label for an op kind on a queue row. */
function opKindLabel(kind: string): string {
  switch (kind) {
    case 'create':
      return 'Create';
    case 'update':
      return 'Update';
    case 'delete':
      return 'Delete';
    case 'transition':
      return 'Transition';
    default:
      return kind;
  }
}

/** Render a relative-time countdown for `nextAttemptAt`. The worker's
 * own polling means this doesn't need to update in real time — a static
 * "in N s/m/h" suffices for the rep skimming the queue. */
function formatRelative(toIso: string, nowMs: number): string {
  const target = Date.parse(toIso);
  const deltaSec = Math.round((target - nowMs) / 1000);
  if (deltaSec <= 0) return 'now';
  if (deltaSec < 60) return `in ${deltaSec}s`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `in ${deltaMin}m`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `in ${deltaHr}h`;
  return `in ${Math.round(deltaHr / 24)}d`;
}

/** Read the four row groups from Dexie + compute the local metrics
 * surface (S4 — CLAUDE.md #3 no-telemetry: numbers stay on device).
 * Exported as a callable so the panel + its tests can drive the same
 * query path. */
async function loadPanelData(): Promise<{
  pending: ReadonlyArray<SyncQueueRow>;
  conflicts: ReadonlyArray<SyncConflictRow>;
  deadLetter: ReadonlyArray<SyncQueueRow>;
  lastSyncedAt: string | null;
  metrics: SyncMetrics;
}> {
  const [pending, conflicts, deadLetter, baseStates, metrics] = await Promise.all([
    db.sync_queue.where('state').anyOf(['queued', 'in_flight']).toArray(),
    db.sync_conflicts.where('resolved').equals(0).toArray(),
    db.sync_queue.where('state').equals('failed_dead_letter').toArray(),
    db._base_state.toArray(),
    computeSyncMetrics(),
  ]);
  // Most-recent base-state cachedAt = the proxy for last-synced. Skip
  // the heartbeat row (its key is `__heartbeat__:...`).
  let last: string | null = null;
  for (const b of baseStates) {
    if (b.key.startsWith('__heartbeat__')) continue;
    if (last === null || b.cachedAt > last) last = b.cachedAt;
  }
  return { pending, conflicts, deadLetter, lastSyncedAt: last, metrics };
}

/** Map an entity kind to the table name so we can clear an optimistic
 * row when a dead-letter op is discarded. Mirrors `entityKindToTable` in
 * queue-worker.ts; kept private here so the worker's surface stays
 * focused on dispatching. */
function entityKindToTable(kind: SyncEntityKind): string | null {
  switch (kind) {
    case 'hazard':
      return 'hazards';
    case 'action_item':
      return 'action_items';
    case 'action_item_move':
      return 'action_item_moves';
    case 'inspection':
      return 'inspections';
    case 'inspection_finding':
    case 'inspection_finding_promotion':
      return 'inspection_findings';
    case 'inspection_signature':
      return 'inspection_signatures';
    case 'recommendation':
    case 'recommendation_resolution':
    case 'recommendation_withdrawal':
      return 'recommendations';
    case 'recommendation_response':
      return 'recommendation_responses';
    case 'evidence_finalize':
      return 'evidence_files';
  }
}

export function SyncPanel({ open, onOpenChange }: SyncPanelProps): JSX.Element | null {
  const status = useSyncStatus();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadPanelData>> | null>(null);
  const [draining, setDraining] = useState(false);
  const [activeConflict, setActiveConflict] = useState<SyncConflictRow | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<number | null>(null);
  const [busyRowId, setBusyRowId] = useState<number | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await loadPanelData();
      setData(next);
    } catch {
      // Dexie unavailable — render the empty shell. Tests using
      // fake-indexeddb resolve normally; production failures here mean
      // the user is in a bad state but the panel itself stays renderable.
      setData({
        pending: [],
        conflicts: [],
        deadLetter: [],
        lastSyncedAt: null,
        metrics: {
          opsByState: {
            queued: 0,
            in_flight: 0,
            succeeded: 0,
            conflicting: 0,
            failed_dead_letter: 0,
            paused: 0,
          },
          medianAttemptCount: 0,
          oldestQueuedAgeSeconds: null,
          unresolvedConflicts: 0,
          deadLetterCount: 0,
          pendingPayloadBytes: 0,
          hasBlockedByParent: false,
        },
      });
    }
  }, []);

  // Reload on open + on every worker status push (so a drain that lands
  // while the panel is open refreshes the lists). Defer the reload via
  // a microtask so the effect body itself doesn't synchronously trigger
  // setState (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void reload();
    });
    return () => {
      cancelled = true;
    };
  }, [open, reload, status]);

  // Capture "now" on each render via state so the render itself stays
  // pure; the worker's poll + the manual sync-now path each bump this
  // via setNowMs after their drain completes. The pending-section
  // countdown only needs second-level fidelity.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [open]);

  const onSyncNow = useCallback(async (): Promise<void> => {
    setDraining(true);
    try {
      await getWorker().drainNow();
      await reload();
    } finally {
      setDraining(false);
    }
  }, [reload]);

  const onRetry = useCallback(
    async (row: SyncQueueRow): Promise<void> => {
      if (row.id === undefined) return;
      setBusyRowId(row.id);
      try {
        await db.sync_queue.update(row.id, {
          state: 'queued',
          attemptCount: 0,
          nextAttemptAt: new Date().toISOString(),
          lastError: null,
        });
        // Kick a drain so the rep sees motion immediately.
        void getWorker().drainNow();
        await reload();
      } finally {
        setBusyRowId(null);
      }
    },
    [reload],
  );

  const onDiscard = useCallback(
    async (row: SyncQueueRow): Promise<void> => {
      if (row.id === undefined) return;
      setBusyRowId(row.id);
      try {
        // Delete the queue row.
        await db.sync_queue.delete(row.id);
        // Delete the optimistic entity row if this was a CREATE (the
        // server never accepted it; the rep is throwing it away).
        if (row.kind === 'create') {
          const table = entityKindToTable(row.entityKind);
          if (table !== null) {
            try {
              await db.table(table).delete(row.entityLocalId);
            } catch {
              // Some entity kinds (evidence_finalize) don't have a
              // 1:1 entity row — best-effort delete.
            }
          }
        }
        setConfirmDiscardId(null);
        await reload();
      } finally {
        setBusyRowId(null);
      }
    },
    [reload],
  );

  // Mobile pull-to-refresh: bind a touchstart→touchmove→touchend handler
  // that triggers `drainNow()` when the rep pulls the panel down >60px
  // from the top. Haptic feedback per CLAUDE.md mobile-primary patterns.
  const [pullStartY, setPullStartY] = useState<number | null>(null);
  const [pullDelta, setPullDelta] = useState(0);
  const onTouchStart = useCallback((e: React.TouchEvent): void => {
    const t = e.touches[0];
    if (t && (e.currentTarget as HTMLElement).scrollTop === 0) {
      setPullStartY(t.clientY);
    }
  }, []);
  const onTouchMove = useCallback(
    (e: React.TouchEvent): void => {
      if (pullStartY === null) return;
      const t = e.touches[0];
      if (!t) return;
      const delta = t.clientY - pullStartY;
      if (delta > 0) setPullDelta(Math.min(delta, 120));
    },
    [pullStartY],
  );
  const onTouchEnd = useCallback((): void => {
    if (pullDelta > 60) {
      // navigator.vibrate is best-effort; not all platforms honor it.
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(10);
      }
      void onSyncNow();
    }
    setPullStartY(null);
    setPullDelta(0);
  }, [pullDelta, onSyncNow]);

  if (!open) return null;

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-panel-title"
        className="fixed inset-0 z-40 flex items-end justify-end bg-foreground/30 backdrop-blur-sm md:items-stretch"
        onClick={() => onOpenChange(false)}
      >
        <aside
          className="flex h-[85vh] w-full flex-col rounded-t-2xl border border-border bg-card shadow-xl md:h-screen md:max-w-md md:rounded-none md:rounded-l-2xl"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {/* Header */}
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <RefreshCw
                className="h-4 w-4 text-muted-foreground"
                strokeWidth={2}
                aria-hidden="true"
              />
              <h2 id="sync-panel-title" className="text-base font-semibold tracking-tight">
                Sync
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close sync panel"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </header>

          {/* Pull-to-refresh affordance */}
          {pullDelta > 0 ? (
            <div
              className="flex items-center justify-center bg-muted text-xs text-muted-foreground"
              style={{ height: `${pullDelta}px` }}
              aria-hidden="true"
            >
              {pullDelta > 60 ? 'Release to sync' : 'Pull to sync'}
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto px-4 py-3">
            <StatusSection
              data={data}
              draining={draining}
              onSyncNow={() => {
                void onSyncNow();
              }}
            />

            <HealthSection metrics={data?.metrics ?? null} />

            <PendingSection pending={data?.pending ?? null} now={nowMs} draining={draining} />

            <ConflictsSection
              conflicts={data?.conflicts ?? null}
              onResolve={(row) => setActiveConflict(row)}
            />

            <DeadLetterSection
              rows={data?.deadLetter ?? null}
              busyRowId={busyRowId}
              confirmDiscardId={confirmDiscardId}
              onRetry={(r) => {
                void onRetry(r);
              }}
              onAskDiscard={(id) => setConfirmDiscardId(id)}
              onCancelDiscard={() => setConfirmDiscardId(null)}
              onConfirmDiscard={(r) => {
                void onDiscard(r);
              }}
            />

            {/* Bottom-of-panel install prompt slot — gated internally. */}
            <PwaInstallPrompt mode="inline" />
          </div>
        </aside>
      </div>

      {activeConflict ? (
        <ConflictResolutionDialog
          open
          conflict={activeConflict}
          onClose={() => setActiveConflict(null)}
          onResolved={() => {
            setActiveConflict(null);
            void reload();
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Subsections
// ---------------------------------------------------------------------------

function StatusSection({
  data,
  draining,
  onSyncNow,
}: {
  data: Awaited<ReturnType<typeof loadPanelData>> | null;
  draining: boolean;
  onSyncNow: () => void;
}): JSX.Element {
  const status = useSyncStatus();
  const last = data?.lastSyncedAt ?? null;
  return (
    <section
      aria-labelledby="sync-status-heading"
      className="mb-4 rounded-md border border-border bg-background p-3"
    >
      <h3
        id="sync-status-heading"
        className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Status
      </h3>
      <div className="flex items-start gap-2">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium text-foreground">{statusHeadline(status)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Last synced{' '}
            {last ? new Date(last).toLocaleString() : <span className="italic">never</span>}.
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSyncNow}
          disabled={draining}
          aria-label="Sync now"
        >
          {draining ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          )}
          Sync now
        </Button>
      </div>
    </section>
  );
}

function StatusIcon({ status }: { status: ReturnType<typeof useSyncStatus> }): JSX.Element {
  switch (status.kind) {
    case 'synced':
      return (
        <CloudCheck
          className="mt-0.5 h-5 w-5 shrink-0 text-status-resolved"
          strokeWidth={2}
          aria-hidden="true"
        />
      );
    case 'syncing':
      return (
        <RefreshCw
          className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-status-info"
          strokeWidth={2}
          aria-hidden="true"
        />
      );
    case 'offline':
      return (
        <CloudOff
          className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
          strokeWidth={2}
          aria-hidden="true"
        />
      );
    case 'paused':
      return (
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-status-pending"
          strokeWidth={2}
          aria-hidden="true"
        />
      );
  }
}

function statusHeadline(status: ReturnType<typeof useSyncStatus>): string {
  switch (status.kind) {
    case 'synced':
      return 'All caught up';
    case 'syncing':
      return `Syncing ${status.inFlight + status.queued} change${
        status.inFlight + status.queued === 1 ? '' : 's'
      }`;
    case 'offline':
      return status.queued > 0
        ? `Offline — ${status.queued} change${status.queued === 1 ? '' : 's'} waiting`
        : "You're offline";
    case 'paused':
      return status.reason === 'conflicts'
        ? 'Sync paused — a conflict needs your decision'
        : status.reason === 'dead_letter'
          ? 'Sync paused — an operation hit the retry ceiling'
          : `Sync paused — ${status.reason}`;
  }
}

/**
 * Local-only sync metrics surface (S4, ADR-0009 §3.11).
 *
 * Six numeric / boolean indicators at the top of the panel. None of
 * these values leave the device — they're pure aggregates over the
 * rep's own Dexie state. CLAUDE.md non-negotiable #3 forbids third-
 * party data flows; this surface exists precisely so the rep can see
 * what they need to see WITHOUT a telemetry pipe.
 *
 * Density-first: a 2x3 grid on phones, 3x2 on desktop. JetBrains Mono
 * for every numeric value (CLAUDE.md typography rule for data). The
 * pending-payload-bytes value warns when above 2 MB (PENDING_PAYLOAD_WARN_BYTES).
 *
 * Empty / null states: when `metrics === null` (initial load before
 * the first reload) we render dashes — never a spinner, never a blank.
 */
function HealthSection({ metrics }: { metrics: SyncMetrics | null }): JSX.Element {
  const pendingBytesWarn =
    metrics !== null && metrics.pendingPayloadBytes > PENDING_PAYLOAD_WARN_BYTES;

  return (
    <section
      aria-labelledby="sync-health-heading"
      className="mb-4 rounded-md border border-border bg-background p-3"
      data-testid="sync-health-section"
    >
      <h3
        id="sync-health-heading"
        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Activity className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Health
      </h3>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 md:grid-cols-3">
        <HealthRow
          label="Median attempts"
          value={metrics === null ? '—' : formatMedianAttempts(metrics.medianAttemptCount)}
          testId="health-median-attempts"
        />
        <HealthRow
          label="Oldest queued"
          value={metrics === null ? '—' : formatAgeSeconds(metrics.oldestQueuedAgeSeconds)}
          testId="health-oldest-queued"
        />
        <HealthRow
          label="Pending payload"
          value={metrics === null ? '—' : formatBytes(metrics.pendingPayloadBytes)}
          testId="health-pending-payload"
          warn={pendingBytesWarn}
        />
        <HealthRow
          label="Conflicts"
          value={metrics === null ? '—' : String(metrics.unresolvedConflicts)}
          testId="health-conflicts"
          warn={metrics !== null && metrics.unresolvedConflicts > 0}
        />
        <HealthRow
          label="Dead letter"
          value={metrics === null ? '—' : String(metrics.deadLetterCount)}
          testId="health-dead-letter"
          warn={metrics !== null && metrics.deadLetterCount > 0}
        />
        <HealthRow
          label="FK-blocked"
          value={metrics === null ? '—' : metrics.hasBlockedByParent ? 'yes' : 'no'}
          testId="health-fk-blocked"
          warn={metrics !== null && metrics.hasBlockedByParent}
        />
      </div>
      {pendingBytesWarn ? (
        <p
          className="mt-2 rounded border border-status-pending/30 bg-status-pending/5 px-2 py-1 text-[11px] text-status-pending"
          data-testid="health-payload-warning"
        >
          Pending payload is large. Consider syncing or discarding old dead-letter rows to free
          IndexedDB.
        </p>
      ) : null}
      {/* Footer: explicit no-telemetry reassurance. CLAUDE.md #3 is the
          contract — surfaced here so the rep knows the numbers above
          stay on their device. */}
      <p
        className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70"
        data-testid="health-no-telemetry-note"
      >
        Local-only. These numbers stay on this device.
      </p>
    </section>
  );
}

function HealthRow({
  label,
  value,
  testId,
  warn,
}: {
  label: string;
  value: string;
  testId: string;
  warn?: boolean;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className={`truncate font-mono tabular-nums text-xs ${
          warn ? 'text-status-pending' : 'text-foreground'
        }`}
        data-testid={testId}
      >
        {value}
      </span>
    </div>
  );
}

function PendingSection({
  pending,
  now,
  draining,
}: {
  pending: ReadonlyArray<SyncQueueRow> | null;
  now: number;
  draining: boolean;
}): JSX.Element {
  return (
    <section
      aria-labelledby="sync-pending-heading"
      className="mb-4 rounded-md border border-border bg-background p-3"
    >
      <h3
        id="sync-pending-heading"
        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Inbox className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Pending operations{' '}
        {pending && pending.length > 0 ? (
          <span className="font-mono tabular-nums">({pending.length})</span>
        ) : null}
      </h3>
      {pending === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : pending.length === 0 ? (
        <EmptyState label="Nothing pending. All changes are synced." Icon={CheckCircle2} />
      ) : (
        <ul className="space-y-2">
          {pending.map((row) => (
            <li
              key={row.id}
              className="rounded-md border border-border bg-card p-2 text-xs"
              data-testid={`pending-row-${row.id}`}
            >
              <div className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
                <span>{entityKindLabel(row.entityKind)}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{opKindLabel(row.kind)}</span>
                {row.state === 'in_flight' ? (
                  <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-status-info/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-status-info">
                    <Loader2
                      className="h-2.5 w-2.5 animate-spin"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    In flight
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                <span className="font-mono tabular-nums">{row.entityLocalId.slice(0, 8)}</span>
                <span>·</span>
                <span>
                  attempt {row.attemptCount + 1}
                  {row.attemptCount > 0 ? ` of up to 8` : ''}
                </span>
                <span>·</span>
                <span>next {draining ? 'now' : formatRelative(row.nextAttemptAt, now)}</span>
                {row.lastError ? (
                  <>
                    <span>·</span>
                    <span className="font-mono text-status-pending">{row.lastError}</span>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConflictsSection({
  conflicts,
  onResolve,
}: {
  conflicts: ReadonlyArray<SyncConflictRow> | null;
  onResolve: (row: SyncConflictRow) => void;
}): JSX.Element {
  return (
    <section
      aria-labelledby="sync-conflicts-heading"
      className="mb-4 rounded-md border border-border bg-background p-3"
    >
      <h3
        id="sync-conflicts-heading"
        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <GitMerge className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Conflicts{' '}
        {conflicts && conflicts.length > 0 ? (
          <span className="font-mono tabular-nums">({conflicts.length})</span>
        ) : null}
      </h3>
      {conflicts === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : conflicts.length === 0 ? (
        <EmptyState label="No conflicts." Icon={CheckCircle2} />
      ) : (
        <ul className="space-y-2">
          {conflicts.map((row) => (
            <li
              key={row.id}
              className="rounded-md border border-status-pending/30 bg-status-pending/5 p-2 text-xs"
              data-testid={`conflict-row-${row.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">
                    {entityKindLabel(row.entityKind)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    <span className="font-mono tabular-nums">{row.entityLocalId.slice(0, 8)}</span>{' '}
                    · detected {new Date(row.detectedAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onResolve(row)}
                  aria-label="Resolve conflict"
                >
                  Resolve
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeadLetterSection({
  rows,
  busyRowId,
  confirmDiscardId,
  onRetry,
  onAskDiscard,
  onCancelDiscard,
  onConfirmDiscard,
}: {
  rows: ReadonlyArray<SyncQueueRow> | null;
  busyRowId: number | null;
  confirmDiscardId: number | null;
  onRetry: (row: SyncQueueRow) => void;
  onAskDiscard: (id: number) => void;
  onCancelDiscard: () => void;
  onConfirmDiscard: (row: SyncQueueRow) => void;
}): JSX.Element {
  return (
    <section
      aria-labelledby="sync-dead-letter-heading"
      className="mb-2 rounded-md border border-border bg-background p-3"
    >
      <h3
        id="sync-dead-letter-heading"
        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <AlertOctagon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Dead letter{' '}
        {rows && rows.length > 0 ? (
          <span className="font-mono tabular-nums">({rows.length})</span>
        ) : null}
      </h3>
      {rows === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState label="No operations stuck. You're all caught up." Icon={CheckCircle2} />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-md border border-status-open/30 bg-status-open/5 p-2 text-xs"
              data-testid={`dead-letter-row-${row.id}`}
            >
              <div className="font-medium text-foreground">
                {entityKindLabel(row.entityKind)} · {opKindLabel(row.kind)}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                <span className="font-mono tabular-nums">{row.entityLocalId.slice(0, 8)}</span>
                {' · '}
                attempts: {row.attemptCount}
              </div>
              {row.lastError ? (
                <div className="mt-1 break-words font-mono text-[11px] text-status-open">
                  {row.lastError}
                </div>
              ) : null}
              {confirmDiscardId === row.id ? (
                <div className="mt-2 rounded-md border border-status-open/40 bg-status-open/10 p-2">
                  <p className="text-[11px] text-foreground">
                    Discard this operation? The optimistic row will be removed and the change will
                    not reach the server. This cannot be undone.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => onConfirmDiscard(row)}
                      disabled={busyRowId === row.id}
                    >
                      <Trash2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                      Discard
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={onCancelDiscard}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onRetry(row)}
                    disabled={busyRowId === row.id}
                  >
                    <RotateCcw className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => row.id !== undefined && onAskDiscard(row.id)}
                    disabled={busyRowId === row.id}
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                    Discard
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyState({ label, Icon }: { label: string; Icon: typeof CheckCircle2 }): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 text-status-resolved" strokeWidth={1.75} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

// Exported for tests so they can drive the same query path the panel uses.
export const _internal = {
  loadPanelData,
  entityKindToTable,
  entityKindLabel,
  formatRelative,
  statusHeadline,
};

// Keep useMemo import sane (unused export) — Vite/TSC otherwise warns.
void useMemo;
