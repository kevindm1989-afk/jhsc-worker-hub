// /action-items/:id — detail + section-move drawer + undo.
//
// Milestone 2.2 S3 extensions (ADR-0013 §3.7 + §3.9):
//   - "Closure verification" panel surfaces when the item is Closed
//     (decoder of the closed_at + counter_signer + chain anchor +
//     attestation hash from the cached Dexie row). The closure-reason
//     PLAINTEXT requires a step-up-gated reveal endpoint that the
//     1.5+ workplace-private-key flow does NOT yet extend to closure
//     rows — documented as the S5 forward-seam.
//   - "Verify closure" sticky bottom CTA when status === 'Pending
//     Review' — opens the close-verification view.
//   - Reopen dialog when status === 'Closed' AND the rep is the
//     worker_co_chair (single-tenant scope per S0 Q1).
//   - "Meeting history" timeline rendered from the existing
//     history payload (no new server endpoint per the S3 boundary —
//     client-computed from the move history meetingId + the per-meeting
//     state already in the action item detail response).

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CalendarRange,
  ChevronLeft,
  Hash,
  Lock,
  RotateCcw,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ActionItemsApiError,
  actionItemsApi,
  type ActionItemDetail,
  type ActionItemMeetingHistoryResponse,
} from '@/action-items/api';
import { ActionFlagBadge, RiskDot, SectionBadge, StatusBadge } from '@/action-items/components';
import { ReopenDialog } from '@/components/action-items/reopen-dialog';
import { stepUpEmitter } from '@/auth/api';
import { useOptionalAuthSession } from '@/auth/use-optional-auth-session';
import { CaptureFab, EvidenceList } from '@/evidence/components';
import { db, type ActionItemClosureRow } from '@/sync/db';
import type { ActionItemSection } from '@jhsc/shared-types';
import { actionItemTransitionRequiresStepUp } from '@jhsc/shared-types/action-item-transitions';

export function ActionItemDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) return <div className="p-4 text-sm text-status-rejected">Invalid action item id.</div>;
  return <DetailInner key={id} id={id} />;
}

function DetailInner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  // useOptionalAuthSession so the existing 1.6 detail-view tests (which
  // mount this component without an AuthProvider in their RTL test
  // harness) keep passing. Production renders inside the AppShell's
  // AuthProvider; the session is always non-null there.
  const session = useOptionalAuthSession();
  const [item, setItem] = useState<ActionItemDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<ActionItemSection | null>(null);
  const [pendingUndo, setPendingUndo] = useState<string | null>(null);
  const [closure, setClosure] = useState<ActionItemClosureRow | null>(null);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    actionItemsApi
      .get(id)
      .then((d) => {
        if (!cancelled) setItem(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ActionItemsApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  // Load the cached closure attestation (if any) from Dexie. The M2.2
  // S3 boundary forbids new server endpoints — so the closure metadata
  // surfaces from the cache populated when the rep ran the
  // close-verification flow. If the cache is empty (the rep is viewing
  // an item that was closed on a different device), the panel renders
  // a "Refresh from server" hint pointing at the eventual cross-device
  // sync work.
  useEffect(() => {
    let cancelled = false;
    db.action_item_closures
      .where('actionItemId')
      .equals(id)
      .first()
      .then((row) => {
        if (!cancelled) setClosure(row ?? null);
      })
      .catch(() => {
        if (!cancelled) setClosure(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  const refresh = (): void => {
    setReloadKey((k) => k + 1);
  };

  async function applyMove(to: ActionItemSection, reason: string | undefined): Promise<void> {
    if (!item) return;
    setPendingMove(to);
    try {
      await actionItemsApi.move(item.id, {
        toSection: to,
        reason: reason && reason.length > 0 ? reason : undefined,
      });
      const fresh = await actionItemsApi.get(item.id);
      setItem(fresh);
    } catch (e) {
      if (e instanceof ActionItemsApiError && e.status === 401) {
        const body = e.body as { action?: string } | undefined;
        stepUpEmitter.dispatch(body?.action ?? `action_item.move.${to}`);
      } else if (e instanceof ActionItemsApiError && e.status === 422) {
        const body = e.body as { allowed?: ReadonlyArray<ActionItemSection> } | undefined;
        setError(
          `Move blocked: allowed sections are ${(body?.allowed ?? []).join(', ') || 'none'}.`,
        );
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPendingMove(null);
    }
  }

  async function applyUndo(moveId: string): Promise<void> {
    if (!item) return;
    setPendingUndo(moveId);
    try {
      await actionItemsApi.undoMove(item.id, moveId);
      const fresh = await actionItemsApi.get(item.id);
      setItem(fresh);
    } catch (e) {
      if (e instanceof ActionItemsApiError && e.status === 401) {
        const body = e.body as { action?: string } | undefined;
        stepUpEmitter.dispatch(body?.action ?? 'action_item.move.undo');
      } else if (e instanceof ActionItemsApiError && e.status === 422) {
        setError(
          'That move cannot be undone (already undone, create bootstrap, or graph-blocked).',
        );
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPendingUndo(null);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <Link
          to="/action-items"
          className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to action items
        </Link>
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          That action item does not exist.
          <div className="mt-2">
            <Button asChild size="sm">
              <Link to="/action-items">Back to list</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (error && !item) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
          {error}
        </div>
      </div>
    );
  }
  if (!item) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-muted-foreground">Loading…</div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <Link
        to="/action-items"
        data-print="hide"
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to action items
      </Link>

      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <RiskDot risk={item.risk} />
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            #{item.sequenceNumber}
          </span>
          <SectionBadge section={item.section} />
          <StatusBadge status={item.status} />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {item.type}
          </span>
          <ActionFlagBadge flag={item.flag} />
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Raised {item.startDate}
          {item.targetDate ? ` · target ${item.targetDate}` : ''}
          {item.closedDate ? ` · closed ${item.closedDate}` : ''}
        </div>
      </header>

      <section
        aria-labelledby="action-item-description-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="action-item-description-heading"
          className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Description (decrypted)
        </h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {item.description}
        </p>
        {item.recommendedAction ? (
          <div className="mt-3 border-t border-border pt-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recommended action
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {item.recommendedAction}
            </p>
          </div>
        ) : null}
        {item.raisedBy ? (
          <div className="mt-3 flex items-start gap-1.5 border-t border-border pt-2 text-xs">
            <Lock
              className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div>
              <span className="font-medium text-foreground">Raised by:</span>{' '}
              <span className="text-muted-foreground">{item.raisedBy}</span>
              <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                · encrypted at rest
              </span>
            </div>
          </div>
        ) : null}
        {item.department ? (
          <div className="mt-1 text-xs">
            <span className="font-medium text-foreground">Department:</span>{' '}
            <span className="text-muted-foreground">{item.department}</span>
          </div>
        ) : null}
      </section>

      <div data-print="hide">
        <MovePanel
          currentSection={item.section}
          allowedTransitions={item.allowedTransitions}
          pendingMove={pendingMove}
          onApply={applyMove}
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

      <section
        aria-labelledby="ai-evidence-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="ai-evidence-heading"
          className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Evidence
        </h2>
        <EvidenceList linkedType="action_item" linkedId={item.id} />
      </section>

      {item.status === 'Closed' ? (
        <ClosureVerificationPanel
          closure={closure}
          verifiedByJhscId={item.verifiedByJhscId}
          closedDate={item.closedDate}
        />
      ) : null}

      <MeetingHistoryTimeline actionItemId={item.id} firstRaisedAt={item.startDate} />

      <HistoryPanel history={item.history} onUndo={applyUndo} pendingUndo={pendingUndo} />
      <CaptureFab linkedType="action_item" linkedId={item.id} />

      {/* M2.2 §3.9 — sticky bottom CTA for Pending Review → close-verify
       *  and Closed → reopen. Renders on mobile; for desktop the buttons
       *  appear inline above. */}
      {item.status === 'Pending Review' ? (
        <div
          data-print="hide"
          className="fixed inset-x-0 bottom-16 z-30 mx-auto flex max-w-3xl gap-2 border-t border-border bg-background px-3 py-2 md:static md:mt-4 md:max-w-none md:border-none md:bg-transparent md:px-0 md:py-0"
        >
          <Button
            asChild
            size="sm"
            className="h-12 flex-1 md:h-9 md:flex-initial"
            data-testid="action-item-detail-verify-closure-cta"
          >
            <Link to={`/action-items/${encodeURIComponent(item.id)}/close-verify`}>
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Verify closure
            </Link>
          </Button>
        </div>
      ) : null}

      {/* M2.2 S5 F-P1 fix: gate the Reopen CTA on the actual
       * worker_co_chair role (read from the session). The route
       * is the structural backstop; the UI gate prevents a non-
       * co-chair from seeing a CTA that will 403 on click. Falls
       * back to "session present" when roles aren't yet on the
       * session (test harness compatibility). */}
      {item.status === 'Closed' &&
      session !== null &&
      (session.roles === undefined || session.roles.includes('worker_co_chair')) ? (
        <div
          data-print="hide"
          className="fixed inset-x-0 bottom-16 z-30 mx-auto flex max-w-3xl gap-2 border-t border-border bg-background px-3 py-2 md:static md:mt-4 md:max-w-none md:border-none md:bg-transparent md:px-0 md:py-0"
        >
          <Button
            size="sm"
            variant="outline"
            className="h-12 flex-1 md:h-9 md:flex-initial"
            onClick={() => setReopenOpen(true)}
            data-testid="action-item-detail-reopen-cta"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Reopen
          </Button>
        </div>
      ) : null}

      <ReopenDialog
        open={reopenOpen}
        actionItemId={item.id}
        onClose={() => setReopenOpen(false)}
        onReopened={() => {
          setReopenOpen(false);
          refresh();
        }}
      />

      <div className="mt-6 text-xs text-muted-foreground" data-print="evidentiary">
        Every section move is anchored in the audit chain — the audit row index appears next to each
        entry.
      </div>

      <div className="mt-4" data-print="hide">
        <Button variant="ghost" size="sm" onClick={() => navigate('/action-items')}>
          Done
        </Button>
      </div>
    </div>
  );
}

function MovePanel({
  currentSection,
  allowedTransitions,
  pendingMove,
  onApply,
}: {
  currentSection: ActionItemSection;
  allowedTransitions: ReadonlyArray<ActionItemSection>;
  pendingMove: ActionItemSection | null;
  onApply: (to: ActionItemSection, reason: string | undefined) => Promise<void>;
}): JSX.Element {
  const [chosen, setChosen] = useState<ActionItemSection | null>(null);
  const [reason, setReason] = useState('');
  if (allowedTransitions.length === 0) {
    return (
      <section
        aria-labelledby="action-item-move-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="action-item-move-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Section moves
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No moves available from {currentSection.replace(/_/g, ' ')}.
        </p>
      </section>
    );
  }
  const destructive = chosen ? actionItemTransitionRequiresStepUp(currentSection, chosen) : false;
  return (
    <section
      aria-labelledby="action-item-move-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="action-item-move-heading"
        className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Section moves
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
              to === 'archived' ? 'border-status-rejected/40 text-status-rejected' : '',
            )}
          >
            Move to {to.replace(/_/g, ' ')}
          </button>
        ))}
      </div>
      {chosen ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {destructive ? (
            <div className="flex items-start gap-2 rounded-md bg-status-pending/10 p-2 text-xs text-status-pending">
              <Shield className="mt-0.5 h-3 w-3" strokeWidth={2} aria-hidden="true" />
              <span>
                This is a destructive or re-open move — step-up auth (passkey or TOTP) is required
                before it can be applied.
              </span>
            </div>
          ) : null}
          <label htmlFor="action-item-move-reason" className="block text-xs text-muted-foreground">
            Reason (optional, encrypted)
          </label>
          <textarea
            id="action-item-move-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setChosen(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pendingMove !== null}
              onClick={() => onApply(chosen, reason.trim() || undefined)}
            >
              {pendingMove === chosen
                ? 'Applying…'
                : `Confirm move to ${chosen.replace(/_/g, ' ')}`}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Closure verification panel — Milestone 2.2 §3.9
// ---------------------------------------------------------------------------

function ClosureVerificationPanel({
  closure,
  verifiedByJhscId,
  closedDate,
}: {
  closure: ActionItemClosureRow | null;
  verifiedByJhscId: string | null;
  closedDate: string | null;
}): JSX.Element {
  return (
    <section
      aria-labelledby="closure-verification-heading"
      className="mb-4 rounded-md border border-emerald-300 bg-emerald-50/50 p-4"
      data-print="card"
      data-testid="closure-verification-panel"
    >
      <h2
        id="closure-verification-heading"
        className="mb-2 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-emerald-800"
      >
        <ShieldCheck className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        Closure verification
      </h2>

      {closure ? (
        <>
          <dl className="space-y-1.5 text-xs">
            <DetailRow label="Closed at" value={new Date(closure.closedAt).toLocaleString()} />
            <DetailRow
              label="Counter-signed at"
              value={new Date(closure.counterSignedAt).toLocaleString()}
            />
            <DetailRow label="Closer" value={closure.closedByActorId} mono />
            <DetailRow label="Counter-signer" value={closure.counterSignerActorId} mono />
            {closure.selfAttestation ? (
              <div
                className="rounded-md border border-blue-200 bg-blue-50 p-2 text-[11px] text-blue-900"
                data-testid="closure-self-attestation-detail"
              >
                Self-attestation: closer and counter-signer are the same user. The chain records
                this distinction.
              </div>
            ) : null}
          </dl>
          <div
            className="mt-3 space-y-1 border-t border-emerald-200 pt-2 text-[11px]"
            data-print="evidentiary"
          >
            {closure.chainAnchorHash ? (
              <DetailRow label="Chain anchor" value={closure.chainAnchorHash} mono break />
            ) : null}
            <DetailRow label="Attestation sig" value={closure.attestationSigHash} mono break />
            {closure.evidenceStorageKey ? (
              <DetailRow label="Evidence key" value={closure.evidenceStorageKey} mono break />
            ) : null}
          </div>
          <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-[11px] text-zinc-700">
            <Lock className="mr-1 inline h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
            Closure reason is encrypted at rest. The decrypt path is the workplace private-key
            reveal flow — extending that flow to closure rows is an S5 forward seam (the M2.2 S3
            client does not surface the reveal CTA).
          </div>
        </>
      ) : (
        <div className="rounded-md border border-zinc-200 bg-card p-3 text-xs text-muted-foreground">
          This item is closed{closedDate ? ` (${closedDate})` : ''}
          {verifiedByJhscId ? ` and verified by user ${verifiedByJhscId.slice(0, 8)}…` : ''}.
          Closure attestation metadata is not cached on this device. Run the close-verification flow
          on the device of record, or wait for cross-device sync (S5 forward seam).
        </div>
      )}
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
  break: breakValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  break?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="uppercase tracking-wide text-emerald-800/70">{label}</dt>
      <dd
        className={cn(
          'text-foreground',
          mono ? 'font-mono tabular-nums' : '',
          breakValue ? 'break-all' : '',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meeting history timeline — Milestone 2.2 §3.7
// ---------------------------------------------------------------------------
//
// M2.2 S5 F-L3 + M-3 (F-P6) fixes: the timeline now reads the real
// per-meeting touch history from GET /api/action-items/:id/meeting-
// history. Pre-fix the timeline was "faked" client-side from moves
// alone — items raised in A, status-changed twice in B without a
// section move, then closed in C would surface only A and C. The
// endpoint joins moves ∪ snapshots ∪ closures so the timeline now
// surfaces every meeting the item touched + the closure entries
// where applicable. Meeting labels lead with date · location
// instead of raw UUID prefixes (F-P6).

function MeetingHistoryTimeline({
  actionItemId,
  firstRaisedAt,
}: {
  actionItemId: string;
  firstRaisedAt: string;
}): JSX.Element {
  const [history, setHistory] = useState<ActionItemMeetingHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    actionItemsApi
      .meetingHistory(actionItemId)
      .then((res) => {
        if (!cancelled) {
          setHistory(res);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ActionItemsApiError) {
          setError(`Could not load meeting history (HTTP ${e.status}).`);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [actionItemId]);

  return (
    <section
      aria-labelledby="meeting-history-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
      data-print="card"
      data-testid="meeting-history-timeline"
    >
      <h2
        id="meeting-history-heading"
        className="mb-2 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <CalendarRange className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        Meeting history
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Cross-meeting touch history. First raised{' '}
        <span className="font-mono tabular-nums">{firstRaisedAt}</span>.
      </p>
      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
        >
          {error}
        </div>
      ) : null}
      {history === null && !error ? (
        <div className="h-12 animate-pulse rounded-md border border-border bg-muted/40" />
      ) : null}
      {history !== null && history.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This item has not been touched in a meeting yet. Status changes and section moves recorded
          during a meeting will appear here, alongside the meeting&apos;s closure verification when
          applicable.
        </p>
      ) : null}
      {history !== null && history.items.length > 0 ? (
        <ol className="space-y-3 border-l-2 border-border pl-3">
          {history.items.map((entry) => {
            const dateLabel = entry.meetingDate
              ? new Date(entry.meetingDate).toLocaleDateString()
              : null;
            const totalTouches =
              entry.snapshotsThisMeeting.length +
              entry.movesThisMeeting.length +
              entry.closuresThisMeeting.length;
            const closureCount = entry.closuresThisMeeting.length;
            return (
              <li key={entry.meetingId} className="relative">
                <span
                  className="absolute -left-[7px] top-1 inline-block h-2 w-2 rounded-full bg-primary"
                  aria-hidden="true"
                />
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <Link
                    to={`/meetings/${encodeURIComponent(entry.meetingId)}`}
                    className="text-primary hover:underline"
                  >
                    {/* M-3 (F-P6) fix: lead with the meeting
                     * date · location instead of the raw UUID
                     * prefix. The UUID still ships in the
                     * data-print="evidentiary" row below for
                     * the printed chain-traceable identifier. */}
                    {dateLabel ?? 'unscheduled meeting'}
                    {entry.meetingLocation ? ` · ${entry.meetingLocation}` : ''}
                  </Link>
                  <span className="text-muted-foreground">·</span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Hash className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                    {totalTouches} {totalTouches === 1 ? 'touch' : 'touches'}
                  </span>
                  {entry.movesThisMeeting.length > 0 ? (
                    <span className="text-muted-foreground">
                      · {entry.movesThisMeeting.length}{' '}
                      {entry.movesThisMeeting.length === 1 ? 'move' : 'moves'}
                    </span>
                  ) : null}
                  {closureCount > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                      <ShieldCheck className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                      {closureCount === 1 ? 'closure verified' : `${closureCount} closures`}
                    </span>
                  ) : null}
                </div>
                <span
                  className="mt-0.5 block font-mono text-[10px] text-muted-foreground"
                  data-print="evidentiary"
                >
                  {entry.meetingId}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function HistoryPanel({
  history,
  onUndo,
  pendingUndo,
}: {
  history: ActionItemDetail['history'];
  onUndo: (moveId: string) => Promise<void>;
  pendingUndo: string | null;
}): JSX.Element {
  return (
    <section
      aria-labelledby="action-item-history-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="action-item-history-heading"
        className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Move history
      </h2>
      <ol className="space-y-2">
        {history.map((h) => (
          <li
            key={h.id}
            className={cn(
              'flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm',
              h.undone ? 'text-muted-foreground line-through' : 'text-foreground',
            )}
          >
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              #{h.auditIdx}
            </span>
            <span>
              {h.fromSection ? (
                <>
                  {h.fromSection.replace(/_/g, ' ')} → {h.toSection.replace(/_/g, ' ')}
                </>
              ) : (
                <>Created → {h.toSection.replace(/_/g, ' ')}</>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(h.movedAt).toLocaleString()}
            </span>
            {h.fromSection !== null && !h.undone ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2 text-xs"
                disabled={pendingUndo === h.id}
                onClick={() => onUndo(h.id)}
                title="Undo this move (step-up required)"
              >
                <RotateCcw className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                {pendingUndo === h.id ? 'Undoing…' : 'Undo'}
              </Button>
            ) : null}
            {h.reason ? <span className="block w-full text-xs italic">{h.reason}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
