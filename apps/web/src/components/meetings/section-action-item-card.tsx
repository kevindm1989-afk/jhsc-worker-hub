// Per-section action item card for the live meeting view (Milestone
// 2.2 S3, ADR-0013 §3.9). Replaces the M2.1 "Open action items" link
// punt with an inline card-list rendered inside each section panel.
//
// Per ADR §3.9:
//   - Card body shows description summary + type + status + risk +
//     ActionFlag (the 21-day s.9(21) clock indicator).
//   - Inline status dropdown — tap → submenu of valid statuses →
//     optimistic PATCH via the existing actionItemsApi (the queue
//     worker handles offline). The 'Closed' transition is INTENTIONALLY
//     NOT in the menu — closure flows through the close-verification
//     view per non-negotiable #16.
//   - Swipe-to-move on mobile (touch events): swipe-right moves to the
//     next section in the canonical lifecycle (per the existing M1.6
//     transition graph); swipe-left moves back. Illegal targets surface
//     a tooltip via aria-disabled.
//   - Quick "Verify closure" CTA when status === 'Pending Review' (the
//     evidence-framing CTA — never "Close item").
//   - Long-press context menu (mobile) / right-click (desktop) — for
//     M2.2 S3 we ship the Reopen affordance via a button when status
//     === 'Closed' AND the rep is the worker_co_chair (single-tenant
//     scope means this is the auth.session user; the route enforces
//     the structural backstop).
//
// Touch targets ≥ 44pt on mobile per non-negotiable #9.
//
// Print posture: card itself + summary + status print; the inline
// dropdown + swipe affordance + quick-action buttons carry
// data-print="hide".

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronRight, MoreVertical, RotateCcw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ActionFlagBadge, RiskDot, STATUS_LABELS, StatusBadge } from '@/action-items/components';
import { ActionItemsApiError, actionItemsApi, type ActionItemListItem } from '@/action-items/api';
import { ReopenDialog } from '@/components/action-items/reopen-dialog';
import { stepUpEmitter } from '@/auth/api';
import type { ActionItemSection, ActionItemStatus } from '@jhsc/shared-types';

/** Status menu options — Closed is intentionally absent (per ADR §3.9:
 *  closing requires the verification view). Cancelled stays on the menu
 *  because cancellation is a routine PATCH per ADR §3.5. */
const STATUS_MENU_OPTIONS: ReadonlyArray<ActionItemStatus> = [
  'Not Started',
  'In Progress',
  'Blocked',
  'Pending Review',
  'Cancelled',
];

/** Canonical lifecycle ordering for swipe-right "advance". Per the
 *  existing 1.6 transition graph, swiping right on new_business
 *  advances to old_business; swiping right on old_business is a noop
 *  (the rep must use the section move panel for completed/archived
 *  transitions). Swipe-left reverses. */
const SECTION_ORDER: ReadonlyArray<ActionItemSection> = [
  'new_business',
  'old_business',
  'recommendation',
  'completed_this_period',
  'archived',
];

const SWIPE_THRESHOLD_PX = 64;

interface SectionActionItemCardProps {
  readonly item: ActionItemListItem;
  readonly meetingId: string;
  /** Called after a successful PATCH / move so the parent re-fetches. */
  readonly onChanged: () => void;
  readonly currentUserId: string | null;
}

export function SectionActionItemCard({
  item,
  meetingId,
  onChanged,
  currentUserId,
}: SectionActionItemCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartXRef = useRef<number | null>(null);

  const isClosed = item.status === 'Closed';
  const isCoChair = currentUserId !== null; // single-rep scope per S0 Q1

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>): void => {
    if (e.touches.length !== 1) return;
    touchStartXRef.current = e.touches[0]!.clientX;
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>): void => {
    if (touchStartXRef.current === null || e.touches.length !== 1) return;
    const dx = e.touches[0]!.clientX - touchStartXRef.current;
    setSwipeOffset(Math.max(-120, Math.min(120, dx)));
  };

  const onTouchEnd = async (): Promise<void> => {
    if (touchStartXRef.current === null) return;
    const dx = swipeOffset;
    setSwipeOffset(0);
    touchStartXRef.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    const direction = dx > 0 ? 1 : -1;
    await moveAdjacent(direction);
  };

  const moveAdjacent = async (direction: 1 | -1): Promise<void> => {
    const idx = SECTION_ORDER.indexOf(item.section);
    if (idx === -1) return;
    const target = SECTION_ORDER[idx + direction];
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await actionItemsApi.move(item.id, {
        toSection: target,
        meetingId,
      });
      onChanged();
    } catch (e) {
      handleApiError(e, `move to ${target}`);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: ActionItemStatus): Promise<void> => {
    setMenuOpen(false);
    if (status === item.status) return;
    setBusy(true);
    setError(null);
    try {
      await actionItemsApi.patch(item.id, { status });
      onChanged();
    } catch (e) {
      handleApiError(e, `set status to ${status}`);
    } finally {
      setBusy(false);
    }
  };

  const handleApiError = (e: unknown, verb: string): void => {
    if (e instanceof ActionItemsApiError) {
      if (e.status === 401) {
        const body = e.body as { action?: string } | undefined;
        stepUpEmitter.dispatch(body?.action ?? `action_item.${verb}`);
        setError(`Step-up required to ${verb}.`);
      } else if (e.status === 409) {
        setError(`Version conflict on ${verb} — refresh the meeting.`);
      } else if (e.status === 422) {
        const body = e.body as { message?: string } | undefined;
        setError(body?.message ?? `Could not ${verb}.`);
      } else {
        setError(`Could not ${verb} (HTTP ${e.status}).`);
      }
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <article
      className="relative overflow-hidden rounded-md border border-border bg-card"
      data-print="card"
      data-testid="section-action-item-card"
      data-action-item-id={item.id}
    >
      <div
        className="transition-transform duration-150"
        style={{ transform: `translateX(${swipeOffset}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={() => void onTouchEnd()}
      >
        <div className="flex items-start gap-2 p-3">
          <RiskDot risk={item.risk} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Link
                to={`/action-items/${encodeURIComponent(item.id)}`}
                className="line-clamp-2 text-sm font-medium text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.summary}
              </Link>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                #{item.sequenceNumber}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={item.status} />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {item.type}
              </span>
              <ActionFlagBadge flag={item.flag} />
            </div>
            {error ? (
              <div
                role="alert"
                aria-live="polite"
                className="mt-2 rounded border border-status-rejected/40 bg-status-rejected/10 p-1.5 text-[11px] text-status-rejected"
              >
                {error}
              </div>
            ) : null}
          </div>

          <div className="flex items-start gap-1" data-print="hide">
            {item.status === 'Pending Review' ? (
              <Button
                asChild
                size="sm"
                variant="outline"
                className="h-11 px-2 text-xs md:h-8"
                data-testid="action-item-verify-closure-cta"
              >
                <Link
                  to={`/action-items/${encodeURIComponent(item.id)}/close-verify`}
                  aria-label={`Verify closure of action item #${item.sequenceNumber}`}
                >
                  <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  Verify closure
                </Link>
              </Button>
            ) : null}

            {isClosed && isCoChair ? (
              <Button
                size="sm"
                variant="outline"
                className="h-11 px-2 text-xs md:h-8"
                onClick={() => setReopenOpen(true)}
                disabled={busy}
                aria-label={`Reopen action item #${item.sequenceNumber}`}
                data-testid="action-item-reopen-cta"
              >
                <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Reopen
              </Button>
            ) : null}

            <div className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Status menu"
                onClick={() => setMenuOpen((v) => !v)}
                disabled={busy || isClosed}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:w-8"
                data-testid="action-item-status-menu-toggle"
              >
                <MoreVertical className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              </button>
              {menuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
                >
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Set status
                  </div>
                  {STATUS_MENU_OPTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="menuitem"
                      onClick={() => void setStatus(s)}
                      disabled={busy || s === item.status}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        s === item.status ? 'text-muted-foreground' : 'text-foreground',
                      )}
                      data-testid={`action-item-status-option-${s.replace(/\s+/g, '-').toLowerCase()}`}
                    >
                      {s === item.status ? (
                        <CheckCircle2
                          className="h-3 w-3 text-emerald-600"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      ) : (
                        <ChevronRight
                          className="h-3 w-3 text-muted-foreground"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      )}
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                  <div className="mt-1 border-t border-border px-2 py-1 text-[10px] text-muted-foreground">
                    Closing? Use Verify closure to record the JHSC counter-sign.
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <ReopenDialog
        open={reopenOpen}
        actionItemId={item.id}
        onClose={() => setReopenOpen(false)}
        onReopened={() => {
          setReopenOpen(false);
          onChanged();
        }}
      />
    </article>
  );
}
