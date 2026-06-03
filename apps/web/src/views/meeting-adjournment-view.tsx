// /meetings/:id/adjourn — Milestone 2.1 S3, ADR-0012 §3.8.
//
// Step-up gated CTA that fires POST /api/meetings/:id/adjourn. The
// route returns the auto-generated metrics dict (items raised /
// closed, recommendations drafted, inspections reviewed, quorum
// compliance at adjournment + duration). The metrics are rendered as
// a dashboard before the rep confirms; once they confirm, the
// transition is anchored in the chain.
//
// Rights-protective copy (T-ML20 / T-ML26): adjournment is
// operationally distinct from finalization. Action items go LIVE on
// adjourn; finalization (the 4 signatures) is the formal sign-off
// that produces the PDF. The CTA copy makes this distinction
// explicit.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CalendarClock, ChevronLeft, Hourglass, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  MeetingApiError,
  meetingsApi,
  type AdjournResponse,
  type MeetingDetail,
} from '@/meetings/api';
import { MEETING_RIGHTS_COPY } from '@/meetings/rights-protective-copy';
import { stepUpEmitter } from '@/auth/api';

export function MeetingAdjournmentView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid meeting id.</div>;
  }
  return <Inner key={id} id={id} />;
}

function Inner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjourning, setAdjourning] = useState(false);
  const [result, setResult] = useState<AdjournResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    meetingsApi
      .get(id)
      .then((fresh) => {
        if (!cancelled) setDetail(fresh);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof MeetingApiError) {
          setError(`Could not load meeting (HTTP ${e.status}).`);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const confirmAdjourn = async (): Promise<void> => {
    setActionError(null);
    setAdjourning(true);
    try {
      const r = await meetingsApi.adjourn(id);
      setResult(r);
    } catch (e) {
      if (e instanceof MeetingApiError) {
        if (e.status === 401) {
          const errBody = e.body as { error?: string; action?: string } | undefined;
          if (errBody?.error !== 'step_up_required') {
            stepUpEmitter.dispatch('meeting.adjourn');
          }
          setActionError('Step-up required to adjourn. Confirm above and tap Adjourn again.');
        } else if (e.status === 422) {
          const errBody = e.body as { error?: string } | undefined;
          setActionError(
            errBody?.error === 'illegal_transition'
              ? 'The meeting is no longer in progress.'
              : `Could not adjourn (${errBody?.error ?? 'rejected'}).`,
          );
        } else {
          setActionError(`Could not adjourn (HTTP ${e.status}).`);
        }
      } else {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setAdjourning(false);
    }
  };

  if (error && !detail) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
          {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="h-32 animate-pulse rounded-md border border-border bg-muted/40" />
      </div>
    );
  }

  if (result) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 pb-24 md:px-6 md:py-8">
        <header className="mb-4 flex items-start gap-2">
          <Hourglass
            className="mt-1 h-5 w-5 text-amber-600"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
              Meeting adjourned
            </h1>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {MEETING_RIGHTS_COPY.adjournmentBanner}
            </p>
          </div>
        </header>

        <MetricsDashboard metrics={result.metrics} />

        <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-end">
          <Button asChild variant="outline" className="h-11 md:h-9">
            <Link to={`/meetings/${encodeURIComponent(id)}`}>Back to meeting</Link>
          </Button>
          <Button
            onClick={() => navigate(`/meetings/${encodeURIComponent(id)}/finalize`)}
            className="h-11 md:h-9"
          >
            Record signatures
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-24 md:px-6 md:py-8">
      <div className="mb-3" data-print="hide">
        <Link
          to={`/meetings/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to meeting
        </Link>
      </div>

      <header className="mb-4 flex items-start gap-2">
        <Pause
          className="mt-1 h-5 w-5 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Adjourn meeting
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Adjournment computes the meeting&rsquo;s key metrics into the chain payload. Step-up is
            required. Action items remain LIVE — finalization is a separate step.
          </p>
        </div>
      </header>

      <div className="rounded-md border border-border bg-card p-3 text-xs" data-print="card">
        <div className="mb-1 flex items-center gap-2">
          <CalendarClock
            className="h-3.5 w-3.5 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="font-mono text-sm font-semibold text-foreground">
            {detail.meetingDate}
          </span>
          <span className="text-muted-foreground">{detail.location ?? 'Location TBD'}</span>
        </div>
        <div className="text-muted-foreground">
          Scheduled {new Date(detail.scheduledStartAt).toLocaleString()} ·{' '}
          {detail.actualStartAt
            ? `started ${new Date(detail.actualStartAt).toLocaleString()}`
            : 'not started'}
        </div>
        <div className="mt-1 text-muted-foreground">
          {detail.attendance.length} attendees · {detail.sections.length} sections
        </div>
      </div>

      {actionError ? (
        <div
          role="alert"
          aria-live="polite"
          className="mt-3 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
        >
          {actionError}
        </div>
      ) : null}

      <div
        className="mt-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-end"
        data-print="hide"
      >
        <Button asChild variant="outline" className="h-11 md:h-9">
          <Link to={`/meetings/${encodeURIComponent(id)}`}>Cancel</Link>
        </Button>
        <Button
          onClick={() => void confirmAdjourn()}
          disabled={adjourning || detail.status !== 'in_progress'}
          className="h-11 md:h-9"
          data-testid="meeting-adjourn-confirm"
        >
          {adjourning ? 'Adjourning…' : 'Confirm adjournment'}
        </Button>
      </div>
    </div>
  );
}

function MetricsDashboard({ metrics }: { metrics: AdjournResponse['metrics'] }): JSX.Element {
  const minutes = Math.round(metrics.durationSeconds / 60);
  return (
    <div
      className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3"
      data-testid="adjournment-metrics"
    >
      <MetricCard label="Duration" value={`${minutes} min`} />
      <MetricCard label="Items raised" value={String(metrics.itemsRaised)} />
      <MetricCard label="Items closed" value={String(metrics.itemsClosed)} />
      <MetricCard label="Recommendations" value={String(metrics.recommendationsDrafted)} />
      <MetricCard label="Inspections reviewed" value={String(metrics.inspectionsReviewed)} />
      <MetricCard
        label="Quorum"
        value={metrics.quorumCompliance.metAtCallToOrder ? 'Met' : 'Not met'}
        sub={metrics.quorumCompliance.ruleCitation}
      />
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card p-3" data-print="card">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-lg tabular-nums text-foreground">{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
