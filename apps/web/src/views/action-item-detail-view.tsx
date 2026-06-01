// /action-items/:id — detail + section-move drawer + undo.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Lock, RotateCcw, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ActionItemsApiError, actionItemsApi, type ActionItemDetail } from '@/action-items/api';
import { ActionFlagBadge, RiskDot, SectionBadge, StatusBadge } from '@/action-items/components';
import { stepUpEmitter } from '@/auth/api';
import { CaptureFab, EvidenceList } from '@/evidence/components';
import type { ActionItemSection } from '@jhsc/shared-types';
import { actionItemTransitionRequiresStepUp } from '@jhsc/shared-types/action-item-transitions';

export function ActionItemDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) return <div className="p-4 text-sm text-status-rejected">Invalid action item id.</div>;
  return <DetailInner key={id} id={id} />;
}

function DetailInner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const [item, setItem] = useState<ActionItemDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<ActionItemSection | null>(null);
  const [pendingUndo, setPendingUndo] = useState<string | null>(null);

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
  }, [id]);

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

      <MovePanel
        currentSection={item.section}
        allowedTransitions={item.allowedTransitions}
        pendingMove={pendingMove}
        onApply={applyMove}
      />

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

      <HistoryPanel history={item.history} onUndo={applyUndo} pendingUndo={pendingUndo} />
      <CaptureFab linkedType="action_item" linkedId={item.id} />

      <div className="mt-6 text-xs text-muted-foreground">
        Every section move is anchored in the audit chain — the audit row index appears next to each
        entry.
      </div>

      <div className="mt-4">
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
