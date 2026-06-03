// Live meeting metrics dashboard (Milestone 2.2 S3, ADR-0013 §3.4).
//
// SWR-style poll on GET /api/meetings/:id/metrics:
//   - 5s refresh interval while the meeting is `in_progress`.
//   - Poll suspends when the document is hidden (per ADR §3.4 +
//     visibility hint).
//   - Poll stops once the meeting status moves to
//     `pending_finalization` / `finalized` (the metrics are then
//     static — the canonical adjournment-payload metrics are the
//     evidentiary record).
//
// Offline fallback (ADR §3.8):
//   - On fetch failure, falls back to the Dexie cache
//     (`meeting_live_metrics`) and surfaces a "Cached from <T>" badge.
//   - The mutation surface for closure-verification is require-online
//     (separately gated); the dashboard READ is best-effort.
//
// Rights-protective copy posture (T-IM27):
//   - The chip-bar surfaces AGGREGATE metrics only — no per-rep
//     attribution. The legend strip is the verbatim
//     MEETING_RIGHTS_COPY.liveMetricsLegend so the surveillance
//     posture stays explicit on screen.
//
// Print posture:
//   - The panel renders with data-print="card" so it surfaces on the
//     printed minutes. Evidentiary numbers (counts + duration +
//     citation hash) carry data-print="evidentiary" so the print
//     stylesheet applies the JetBrains-Mono bordered-divider styling.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileText,
  Gauge,
  Lock,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { db } from '@/sync/db';
import { MeetingApiError, meetingsApi, type MeetingLiveMetricsResponse } from '@/meetings/api';
import { MEETING_RIGHTS_COPY } from '@/meetings/rights-protective-copy';
import type { MeetingStatus } from '@jhsc/shared-types';

/** Poll interval while the meeting is in_progress. */
export const LIVE_METRICS_POLL_MS = 5_000;

interface LiveMetricsPanelProps {
  readonly meetingId: string;
  readonly meetingStatus: MeetingStatus;
}

type FetchState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly metrics: MeetingLiveMetricsResponse;
      readonly source: 'live' | 'cache';
      readonly fetchedAt: string;
    }
  | { readonly kind: 'error'; readonly message: string };

export function LiveMetricsPanel({ meetingId, meetingStatus }: LiveMetricsPanelProps): JSX.Element {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const mountedRef = useRef(true);

  const shouldPoll = meetingStatus === 'in_progress' || meetingStatus === 'scheduled';

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const metrics = await meetingsApi.metrics(meetingId);
      if (!mountedRef.current) return;
      setState({
        kind: 'ready',
        metrics,
        source: 'live',
        fetchedAt: new Date().toISOString(),
      });
      // Best-effort cache write — never blocks the UI. The Dexie
      // schema v3 holds one row per meeting.
      try {
        await db.meeting_live_metrics.put({
          meetingId,
          responseJson: JSON.stringify(metrics),
          cachedAt: new Date().toISOString(),
        });
      } catch {
        // Cache failure is non-fatal — the live read still rendered.
      }
    } catch (e) {
      // Offline fallback: read the most recent cached snapshot.
      try {
        const cached = await db.meeting_live_metrics.get(meetingId);
        if (cached) {
          const parsed = JSON.parse(cached.responseJson) as MeetingLiveMetricsResponse;
          if (mountedRef.current) {
            setState({
              kind: 'ready',
              metrics: parsed,
              source: 'cache',
              fetchedAt: cached.cachedAt,
            });
          }
          return;
        }
      } catch {
        // Cache lookup failed — fall through to error state.
      }
      if (!mountedRef.current) return;
      const msg =
        e instanceof MeetingApiError
          ? `Could not load metrics (HTTP ${e.status}).`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message: msg });
    }
  }, [meetingId]);

  useEffect(() => {
    mountedRef.current = true;
    // Kick off the initial refresh in a microtask so setState lands
    // outside the effect's synchronous body (react-hooks/set-state-in-
    // effect compliance).
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      void refresh();
    }, 0);
    const tick = (): void => {
      // ADR §3.4 — suspend the poll while the tab is hidden.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(tick, LIVE_METRICS_POLL_MS);
        return;
      }
      void refresh().finally(() => {
        if (mountedRef.current && shouldPoll) {
          timer = setTimeout(tick, LIVE_METRICS_POLL_MS);
        }
      });
    };
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    if (shouldPoll) {
      pollTimer = setTimeout(tick, LIVE_METRICS_POLL_MS);
    }
    const visibilityHandler = (): void => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        mountedRef.current
      ) {
        void refresh();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', visibilityHandler);
    }
    return () => {
      mountedRef.current = false;
      if (timer !== null) clearTimeout(timer);
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibilityHandler);
      }
    };
  }, [refresh, shouldPoll]);

  return (
    <section
      aria-labelledby="live-metrics-heading"
      className="rounded-md border border-border bg-card p-3 md:p-4"
      data-print="card"
      data-testid="live-metrics-panel"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2
          id="live-metrics-heading"
          className="inline-flex items-center gap-1.5 text-sm font-medium uppercase tracking-wide text-muted-foreground"
        >
          <Gauge className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Live metrics
        </h2>
        <SourceChip state={state} />
      </div>

      <p className="mb-3 text-[11px] text-muted-foreground" data-print="hide">
        {MEETING_RIGHTS_COPY.liveMetricsLegend}
      </p>

      {state.kind === 'loading' ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-live="polite" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-md border border-border bg-muted/40"
            />
          ))}
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
        >
          <AlertTriangle className="mr-1 inline h-3 w-3" strokeWidth={2} aria-hidden="true" />
          {state.message}
        </div>
      ) : null}

      {state.kind === 'ready' ? <MetricsGrid metrics={state.metrics} /> : null}
    </section>
  );
}

function SourceChip({ state }: { state: FetchState }): JSX.Element | null {
  if (state.kind !== 'ready') return null;
  // Stale-vs-fresh is determined by the source field (set in refresh()
  // at fetch time). Computing stale at render time would require a
  // tick clock — left as a forward seam; the cache fallback path
  // already paints the Cached chip explicitly.
  if (state.source === 'live') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800"
        data-print="hide"
      >
        <CheckCircle2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        Live
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800"
      data-print="hide"
      title={`Cached from ${new Date(state.fetchedAt).toLocaleTimeString()}`}
    >
      <Lock className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
      Cached
    </span>
  );
}

function MetricsGrid({ metrics }: { metrics: MeetingLiveMetricsResponse }): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile icon={Sparkles} label="Raised" value={metrics.itemsRaised} hint="this meeting" />
        <StatTile
          icon={CheckCircle2}
          label="Closed"
          value={metrics.itemsClosed}
          hint="this meeting"
        />
        <StatTile icon={FileText} label="Recs drafted" value={metrics.recommendationsDrafted} />
        <StatTile
          icon={ClipboardCheck}
          label="Inspections reviewed"
          value={metrics.inspectionsReviewed}
        />
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <div className="rounded-md border border-border bg-background p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Closure verifications
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs">
            <span className="font-mono tabular-nums text-foreground">
              total {metrics.closureVerifications.total}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              self {metrics.closureVerifications.selfAttestation}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              peer {metrics.closureVerifications.peerVerified}
            </span>
          </div>
        </div>

        <div className="rounded-md border border-border bg-background p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Quorum</div>
          <div
            className={cn(
              'mt-1 inline-flex items-center gap-1 text-xs font-medium',
              metrics.quorumCompliance.currentlyMet ? 'text-emerald-700' : 'text-amber-700',
            )}
          >
            {metrics.quorumCompliance.currentlyMet ? (
              <ShieldCheck className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            )}
            {metrics.quorumCompliance.currentlyMet ? 'Met' : 'Pending'}
            <span className="ml-1 font-mono text-[10px] text-muted-foreground">
              {metrics.quorumCompliance.ruleCitation}
            </span>
          </div>
        </div>

        <div className="rounded-md border border-border bg-background p-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Duration</div>
          <div className="mt-1 inline-flex items-center gap-1 text-xs">
            <Clock className="h-3 w-3 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
            <span className="font-mono tabular-nums text-foreground">
              {formatDuration(metrics.durationSeconds)}
            </span>
          </div>
        </div>
      </div>

      <div
        className="hidden border-t border-border pt-2 text-[11px] text-muted-foreground print:block"
        data-print="evidentiary"
      >
        Meeting metrics as of {metrics.asOf}. Items raised: {metrics.itemsRaised} · closed:{' '}
        {metrics.itemsClosed} · recs drafted: {metrics.recommendationsDrafted} · inspections
        reviewed: {metrics.inspectionsReviewed} · closure verifications total{' '}
        {metrics.closureVerifications.total} (self {metrics.closureVerifications.selfAttestation} /
        peer {metrics.closureVerifications.peerVerified}).
      </div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Sparkles;
  label: string;
  value: number;
  hint?: string;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        {label}
      </div>
      <div className="mt-1 font-mono text-xl tabular-nums text-foreground">{value}</div>
      {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** Format seconds as `h:mm:ss` (or `m:ss` under one hour). Exported for
 *  unit tests. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}
