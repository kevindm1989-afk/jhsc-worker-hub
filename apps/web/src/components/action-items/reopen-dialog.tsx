// Reopen action item dialog (Milestone 2.2 S3, ADR-0013 §3.5).
//
// Closed → In Progress transition. Lighter-weight than the full
// close-verification view — a single dialog with an enum reason
// picker (rep_decision / jhsc_review / mgmt_appeal — per the S1
// shared-types enum). Require-online because the route is step-up
// gated; the global StepUpModal handles the 401 recovery.
//
// Rights-protective posture (T-IM25 / S0 Q1 forward seam):
//   - Reopen is described as a normal operational move; the
//     prior closure attestation is PRESERVED in the chain as
//     historical evidence.
//   - No destructive framing ("are you sure" / "lost work").

import { useId, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { stepUpEmitter } from '@/auth/api';
import {
  ActionItemsApiError,
  actionItemsApi,
  type ActionItemReopenResponse,
} from '@/action-items/api';
import { MEETING_RIGHTS_COPY } from '@/meetings/rights-protective-copy';
import { NetworkRequiredError, requireOnline } from '@/sync/typed-client';
import {
  actionItemReopenReason,
  type ActionItemReopenReason,
} from '@jhsc/shared-types/action-item-closure';

const REASON_LABELS: Record<ActionItemReopenReason, string> = {
  rep_decision: 'Rep decision',
  jhsc_review: 'JHSC review',
  mgmt_appeal: 'Management appeal',
};

interface ReopenDialogProps {
  readonly open: boolean;
  readonly actionItemId: string;
  readonly onClose: () => void;
  readonly onReopened: (response: ActionItemReopenResponse) => void;
}

export function ReopenDialog({
  open,
  actionItemId,
  onClose,
  onReopened,
}: ReopenDialogProps): JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState<ActionItemReopenReason>('rep_decision');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const response = await requireOnline('action_item.reopen', () =>
        actionItemsApi.reopen(actionItemId, { reason }),
      );
      onReopened(response);
      onClose();
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setError(MEETING_RIGHTS_COPY.closureOfflineHint);
      } else if (e instanceof ActionItemsApiError) {
        if (e.status === 401) {
          const body = e.body as { action?: string } | undefined;
          stepUpEmitter.dispatch(body?.action ?? 'action_item.reopen');
          setError('Step-up required. Confirm above and try reopening again.');
        } else if (e.status === 409 || e.status === 422) {
          const body = e.body as { message?: string } | undefined;
          setError(body?.message ?? `Reopen rejected (HTTP ${e.status}).`);
        } else {
          setError(`Could not reopen (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 p-0 backdrop-blur-sm md:items-center md:p-6"
      onClick={onClose}
      data-print="hide"
      data-testid="reopen-dialog"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-4 shadow-2xl md:rounded-2xl md:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-2 flex items-start justify-between gap-2">
          <div>
            <h2
              id={titleId}
              className="inline-flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              {MEETING_RIGHTS_COPY.reopenDialogTitle}
            </h2>
            <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {MEETING_RIGHTS_COPY.reopenDialogDescription}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <div className="my-3">
          <label htmlFor={reasonId} className="mb-1 block text-xs font-medium text-foreground">
            Reason
          </label>
          <select
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value as ActionItemReopenReason)}
            data-testid="reopen-reason-select"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
          >
            {actionItemReopenReason.map((r) => (
              <option key={r} value={r}>
                {REASON_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <div
            role="alert"
            aria-live="polite"
            className="mb-2 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
          >
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-2 md:flex-row md:justify-end">
          <Button type="button" variant="outline" onClick={onClose} className="h-12 md:h-9">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="h-12 md:h-9"
            data-testid="reopen-submit-cta"
          >
            {submitting ? 'Reopening…' : MEETING_RIGHTS_COPY.reopenSubmitCta}
          </Button>
        </div>
      </div>
    </div>
  );
}
