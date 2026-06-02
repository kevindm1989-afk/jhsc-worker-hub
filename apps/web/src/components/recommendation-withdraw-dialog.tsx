// Confirm dialog for withdrawing a recommendation.
//
// Copy rules (SECURITY.md §2.9 T-R35 mitigation + CLAUDE.md #7):
//   - No "are you sure?" / "give up?" framing — that discourages reps
//     from exercising their s.9(20) authority.
//   - Neutral, record-keeping voice: "Withdrawing closes this
//     recommendation without resolution. The chain of custody preserves
//     the withdrawal record."
//   - Cancel is the default focus (destructive-action confirmation).
//
// Reason enum (PI-clean) matches the S2 route exactly:
//   - rescinded                  (rep changed their mind / withdrew the
//                                  recommendation outright)
//   - superseded                 (replaced by a later recommendation)
//   - addressed_pre_submission   (issue resolved before management
//                                  needed to respond)

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  RecommendationApiError,
  recommendationsApi,
  withdrawReason,
  type WithdrawReason,
} from '@/recommendations/api';

interface WithdrawDialogProps {
  readonly open: boolean;
  readonly recommendationId: string;
  readonly hasLinkedActionItem: boolean;
  readonly onClose: () => void;
  readonly onWithdrawn: () => void;
}

const REASON_LABELS: Record<WithdrawReason, { label: string; help: string }> = {
  rescinded: {
    label: 'Rescinded',
    help: 'The recommendation is being closed without further action.',
  },
  superseded: {
    label: 'Superseded',
    help: 'A later recommendation has replaced this one.',
  },
  addressed_pre_submission: {
    label: 'Addressed before submission',
    help: 'The underlying issue was resolved before management needed to respond.',
  },
};

export function RecommendationWithdrawDialog(props: WithdrawDialogProps): JSX.Element | null {
  const { open, recommendationId, hasLinkedActionItem, onClose, onWithdrawn } = props;
  const [reason, setReason] = useState<WithdrawReason>('rescinded');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Default focus on Cancel (destructive-action confirmation pattern).
  useEffect(() => {
    if (open) {
      // Defer to next frame so the ref is attached.
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  async function onConfirm(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await recommendationsApi.withdraw(recommendationId, { reason });
      onWithdrawn();
    } catch (e) {
      if (e instanceof RecommendationApiError) {
        if (e.status === 401) {
          setError('Sign-in expired. Reload the page and try again.');
        } else if (e.status === 422) {
          const errBody = e.body as { error?: string } | undefined;
          setError(`Could not withdraw (${errBody?.error ?? 'rejected'}).`);
        } else {
          setError(`Could not withdraw (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-dialog-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            id="withdraw-dialog-title"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            Withdraw recommendation
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          Withdrawing closes this recommendation without resolution. The chain of custody preserves
          the withdrawal record.
          {hasLinkedActionItem
            ? ' The linked action item will move to the archived section and be marked Cancelled.'
            : ''}
        </p>

        <fieldset className="mt-4">
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Reason
          </legend>
          <div className="mt-2 space-y-2">
            {withdrawReason.map((r) => {
              const active = reason === r;
              const meta = REASON_LABELS[r];
              return (
                <label
                  key={r}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-foreground hover:bg-muted',
                  )}
                >
                  <input
                    type="radio"
                    name="withdraw-reason"
                    value={r}
                    checked={active}
                    onChange={() => setReason(r)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">{meta.label}</span>
                    <span className="block text-xs text-muted-foreground">{meta.help}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {error ? (
          <div
            role="alert"
            aria-live="polite"
            className="mt-3 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
          >
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              void onConfirm();
            }}
            disabled={submitting}
          >
            {submitting ? 'Withdrawing…' : 'Withdraw'}
          </Button>
        </div>
      </div>
    </div>
  );
}
