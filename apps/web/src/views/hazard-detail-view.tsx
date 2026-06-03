// /hazards/:id — detail view + status workflow.
//
// Mobile: full-screen detail (default page). Desktop: same view; the
// list ↔ detail slide-over split lands in 1.10 once the layout has a
// second pane to coordinate against. For 1.5 a single column is fine.
//
// Status transition UI: render one button per entry in `allowedTransitions`
// from the API; clicking opens a small reason prompt (required for the
// destructive →withdrawn transition, optional otherwise), then PATCHes
// /api/hazards/:id/status. On 401 step_up_required we surface the
// stepUpEmitter event so the global modal opens (same pattern as the
// existing 1.2 step-up flows).

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Lock, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HazardsApiError, hazardsApi, type HazardDetail } from '@/hazards/api';
import {
  HazardStatusBadge,
  SEVERITY_LABELS,
  STATUS_LABELS,
  SeverityDot,
} from '@/hazards/components';
import { stepUpEmitter } from '@/auth/api';
import { CaptureFab, EvidenceList } from '@/evidence/components';
import type { HazardStatus } from '@jhsc/shared-types';
import { requiresStepUp } from '@jhsc/shared-types/hazard-transitions';

export function HazardDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) return <div className="p-4 text-sm text-status-rejected">Invalid hazard id.</div>;
  return <HazardDetailInner key={id} id={id} />;
}

function HazardDetailInner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const [hazard, setHazard] = useState<HazardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<HazardStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    hazardsApi
      .get(id)
      .then((h) => {
        if (!cancelled) setHazard(h);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof HazardsApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function applyTransition(to: HazardStatus, reason: string | undefined): Promise<void> {
    if (!hazard) return;
    setPendingTransition(to);
    try {
      await hazardsApi.patchStatus(hazard.id, {
        toStatus: to,
        reason: reason && reason.length > 0 ? reason : undefined,
      });
      // Re-fetch so the history list and allowedTransitions update from
      // the canonical server state.
      const fresh = await hazardsApi.get(hazard.id);
      setHazard(fresh);
    } catch (e) {
      if (e instanceof HazardsApiError && e.status === 401) {
        // Surface to the global step-up modal. The modal closes when
        // step-up succeeds; the user re-clicks the transition button.
        const body = e.body as { action?: string } | undefined;
        stepUpEmitter.dispatch(body?.action ?? `hazard.status_change.${to}`);
      } else if (e instanceof HazardsApiError && e.status === 422) {
        const body = e.body as { allowed?: ReadonlyArray<HazardStatus> } | undefined;
        setError(
          `That transition is no longer allowed (allowed now: ${(body?.allowed ?? []).join(', ') || 'none'}).`,
        );
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPendingTransition(null);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <Link
          to="/hazards"
          className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to hazards
        </Link>
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          That hazard does not exist or was withdrawn.
          <div className="mt-2">
            <Button asChild size="sm">
              <Link to="/hazards">Back to list</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (error && !hazard) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
          {error}
        </div>
      </div>
    );
  }
  if (!hazard) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <Link
        to="/hazards"
        data-print="hide"
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to hazards
      </Link>

      <header className="mb-4">
        <div className="flex items-center gap-2">
          <SeverityDot severity={hazard.severity} />
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {hazard.hazardCode}
          </span>
          <HazardStatusBadge status={hazard.status} />
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {hazard.title}
        </h1>
        <div className="mt-1 text-xs text-muted-foreground">
          Reported {new Date(hazard.reportedAt).toLocaleString()} ·{' '}
          {hazard.jurisdiction === 'ON' ? 'Ontario (OHSA)' : 'Canada (CLC Part II)'} ·{' '}
          {SEVERITY_LABELS[hazard.severity]} severity
        </div>
      </header>

      <section
        aria-labelledby="hazard-description-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="hazard-description-heading"
          className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Description (decrypted)
        </h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {hazard.description}
        </p>
        {hazard.locationZone || hazard.locationDetail ? (
          <div className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Location:</span>{' '}
            {hazard.locationZone ? <span>{hazard.locationZone}</span> : null}
            {hazard.locationZone && hazard.locationDetail ? <span> · </span> : null}
            {hazard.locationDetail ? <span>{hazard.locationDetail}</span> : null}
          </div>
        ) : null}
      </section>

      <div data-print="hide">
        <TransitionPanel
          currentStatus={hazard.status}
          allowedTransitions={hazard.allowedTransitions}
          pendingTransition={pendingTransition}
          onApply={applyTransition}
        />
      </div>

      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="mb-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
        >
          {error}
        </div>
      ) : null}

      <div data-print="hide">
        <ReporterRevealPanel hazardId={hazard.id} />
      </div>

      <section
        aria-labelledby="hazard-evidence-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="hazard-evidence-heading"
          className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Evidence
        </h2>
        <EvidenceList linkedType="hazard" linkedId={hazard.id} />
      </section>

      <HistoryPanel history={hazard.history} />
      <CaptureFab linkedType="hazard" linkedId={hazard.id} />

      <div className="mt-6 text-xs text-muted-foreground" data-print="evidentiary">
        Every status change is anchored in the audit chain — the audit row index appears next to
        each transition.
      </div>

      <div className="mt-4" data-print="hide">
        <Button variant="ghost" size="sm" onClick={() => navigate('/hazards')}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transition panel
// ---------------------------------------------------------------------------

function TransitionPanel({
  currentStatus,
  allowedTransitions,
  pendingTransition,
  onApply,
}: {
  currentStatus: HazardStatus;
  allowedTransitions: ReadonlyArray<HazardStatus>;
  pendingTransition: HazardStatus | null;
  onApply: (to: HazardStatus, reason: string | undefined) => Promise<void>;
}): JSX.Element {
  const [chosen, setChosen] = useState<HazardStatus | null>(null);
  const [reason, setReason] = useState('');
  if (allowedTransitions.length === 0) {
    return (
      <section
        aria-labelledby="hazard-transition-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="hazard-transition-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Status transitions
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This hazard is in a terminal state ({STATUS_LABELS[currentStatus]}). No further
          transitions allowed.
        </p>
      </section>
    );
  }
  const destructive = chosen ? requiresStepUp(currentStatus, chosen) : false;
  const reasonRequired = chosen === 'withdrawn';
  return (
    <section
      aria-labelledby="hazard-transition-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="hazard-transition-heading"
        className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Status transitions
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {allowedTransitions.map((to) => (
          <button
            key={to}
            type="button"
            onClick={() => setChosen((c) => (c === to ? null : to))}
            aria-pressed={chosen === to}
            className={cn(
              'rounded-md border px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
              chosen === to
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-background text-foreground hover:bg-muted',
              to === 'withdrawn' ? 'border-status-rejected/40 text-status-rejected' : '',
            )}
          >
            Move to {STATUS_LABELS[to]}
          </button>
        ))}
      </div>
      {chosen ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {destructive ? (
            <div className="flex items-start gap-2 rounded-md bg-status-pending/10 p-2 text-xs text-status-pending">
              <Shield className="mt-0.5 h-3 w-3" strokeWidth={2} aria-hidden="true" />
              <span>
                This is a destructive or re-open transition — step-up auth (passkey or TOTP) is
                required before it can be applied.
              </span>
            </div>
          ) : null}
          <label htmlFor="hazard-transition-reason" className="block text-xs text-muted-foreground">
            Reason
            {reasonRequired ? (
              <span className="ml-0.5 text-status-rejected">*</span>
            ) : (
              ' (optional)'
            )}
          </label>
          <textarea
            id="hazard-transition-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder={reasonRequired ? 'Required — why withdraw this hazard?' : 'Optional note'}
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setChosen(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                pendingTransition !== null || (reasonRequired && reason.trim().length === 0)
              }
              onClick={() => onApply(chosen, reason.trim() || undefined)}
            >
              {pendingTransition === chosen ? 'Applying…' : `Confirm ${STATUS_LABELS[chosen]}`}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reporter reveal — step-up-gated
// ---------------------------------------------------------------------------

function ReporterRevealPanel({ hazardId }: { hazardId: string }): JSX.Element {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function reveal(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/hazards/${encodeURIComponent(hazardId)}/reporter`, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'jhsc-web' },
      });
      if (res.status === 401) {
        const body = (await res.json().catch(() => null)) as { action?: string } | null;
        stepUpEmitter.dispatch(body?.action ?? 'hazard.reveal_reporter');
        return;
      }
      if (!res.ok) {
        throw new Error(`reveal failed: ${res.status}`);
      }
      const body = (await res.json()) as { reporterIdentity: string | null };
      if (body.reporterIdentity === null) setAnonymous(true);
      else setRevealed(body.reporterIdentity);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      aria-labelledby="hazard-reporter-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="hazard-reporter-heading"
        className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Reporter identity
      </h2>
      {revealed ? (
        <p className="text-sm text-foreground">{revealed}</p>
      ) : anonymous ? (
        <p className="text-sm text-muted-foreground">
          This hazard was filed anonymously — no reporter identity is recorded.
        </p>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Hidden behind step-up authentication (T-H4). Click to reveal.
          </p>
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={reveal}>
            {loading ? 'Revealing…' : 'Reveal'}
          </Button>
        </div>
      )}
      {error ? (
        <div className="mt-2 text-xs text-status-rejected" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// History panel
// ---------------------------------------------------------------------------

function HistoryPanel({ history }: { history: HazardDetail['history'] }): JSX.Element {
  return (
    <section
      aria-labelledby="hazard-history-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="hazard-history-heading"
        className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Status history
      </h2>
      <ol className="space-y-2">
        {history.map((h) => (
          <li
            key={h.id}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-foreground"
          >
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              #{h.auditIdx}
            </span>
            <span>
              {h.fromStatus ? (
                <>
                  {STATUS_LABELS[h.fromStatus]} → {STATUS_LABELS[h.toStatus]}
                </>
              ) : (
                <>Created → {STATUS_LABELS[h.toStatus]}</>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(h.occurredAt).toLocaleString()}
            </span>
            {h.reason ? <span className="block w-full text-xs italic">{h.reason}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
