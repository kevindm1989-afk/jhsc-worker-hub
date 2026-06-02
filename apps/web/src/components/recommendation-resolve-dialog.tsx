// Confirm dialog for resolving a recommendation.
//
// The S2 route requires status='response_received' to resolve; the linked
// action item moves to completed_this_period + Closed, and the
// recommendation flips to resolved with resolved_at stamped.
//
// Copy: "Resolving this recommendation moves the linked Action Item to
// completed_this_period. The 21-day clock stops." Neutral, record-keeping
// voice — same posture as the withdraw dialog (T-R35 mitigation).

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecommendationApiError, recommendationsApi } from '@/recommendations/api';

interface ResolveDialogProps {
  readonly open: boolean;
  readonly recommendationId: string;
  readonly linkedActionItemId: string | null;
  readonly onClose: () => void;
  readonly onResolved: () => void;
}

export function RecommendationResolveDialog(props: ResolveDialogProps): JSX.Element | null {
  const { open, recommendationId, linkedActionItemId, onClose, onResolved } = props;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => confirmRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  async function onConfirm(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await recommendationsApi.resolve(recommendationId);
      onResolved();
    } catch (e) {
      if (e instanceof RecommendationApiError) {
        if (e.status === 401) {
          setError('Sign-in expired. Reload the page and try again.');
        } else if (e.status === 422) {
          const errBody = e.body as { error?: string } | undefined;
          if (errBody?.error === 'requires_response') {
            setError(
              'Resolution requires at least one captured response. Capture the management response first.',
            );
          } else {
            setError(`Could not resolve (${errBody?.error ?? 'rejected'}).`);
          }
        } else {
          setError(`Could not resolve (HTTP ${e.status}).`);
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
      aria-labelledby="resolve-dialog-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            id="resolve-dialog-title"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            Resolve recommendation
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
          Resolving this recommendation moves the linked Action Item
          {linkedActionItemId ? (
            <>
              {' '}
              (<span className="font-mono tabular-nums">{linkedActionItemId.slice(0, 8)}</span>)
            </>
          ) : null}{' '}
          to <strong>completed_this_period</strong> and marks it <strong>Closed</strong>. The 21-day
          clock stops.
        </p>

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
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            onClick={() => {
              void onConfirm();
            }}
            disabled={submitting}
          >
            {submitting ? 'Resolving…' : 'Resolve'}
          </Button>
        </div>
      </div>
    </div>
  );
}
