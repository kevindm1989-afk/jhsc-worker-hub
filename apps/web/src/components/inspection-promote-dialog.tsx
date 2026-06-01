// Inspection finding → action item promote modal.
//
// The #15 CLIENT-SIDE FAIL-CLOSED GATE (T-I15).
//
// The server's inspectionPromotability() helper is the source of truth;
// this modal is the belt-and-suspenders so the user never sees a dead
// promote button. The Promote button itself is hidden when the helper
// returns false — this modal also fails closed if state drifts mid-
// render. Without this defence, a quick edit of statusValue from 'A' to
// 'X' between render and click would land a 422 with no UX recovery.
//
// Rights-protective copy: the modal makes clear that promotion converts
// a finding (which lives inside the inspection's audit-chain anchor)
// into a tracked action item; the action item has its own audit chain
// and risk discipline. The inspector is choosing the Risk level at
// promotion (CLAUDE.md #15).

import { useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  actionItemRisk,
  inspectionPromotability,
  type ActionItemRisk,
  type InspectionStatusVocabKind,
} from '@jhsc/shared-types';
import { InspectionApiError, inspectionsApi, type PromoteFindingResponse } from '@/inspections/api';
import { stepUpEmitter } from '@/auth/api';

interface InspectionPromoteDialogProps {
  readonly open: boolean;
  readonly findingId: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly statusValue: string;
  readonly sectionLabel: string;
  readonly itemLabel: string;
  readonly onClose: () => void;
  readonly onPromoted: (resp: PromoteFindingResponse) => void;
}

const RISK_HINTS: Record<ActionItemRisk, string> = {
  Low: 'Low — minor, monitor at the next inspection.',
  Medium: 'Medium — fix in a normal work order, prioritize before next cycle.',
  High: 'High — likely-injury condition; schedule in-week.',
  Critical: 'Critical — stop-work / immediate hazard; engage the JHSC and management at once.',
};

export function InspectionPromoteDialog(props: InspectionPromoteDialogProps): JSX.Element | null {
  const {
    open,
    findingId,
    statusVocab,
    statusValue,
    sectionLabel,
    itemLabel,
    onClose,
    onPromoted,
  } = props;

  const [risk, setRisk] = useState<ActionItemRisk>('Medium');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  // T-I15 fail-closed gate. Runs before the modal renders its form, so
  // even a state drift after the parent showed the dialog still
  // refuses. The server enforces this; we duplicate it here to keep
  // the worker rep from ever submitting a doomed POST.
  const promotable = inspectionPromotability(statusVocab, statusValue);

  function explainBlockedStatus(): string {
    if (statusVocab === 'ABC_X' && statusValue === 'X') {
      return "Status X findings cannot be promoted — 'X' is the not-promotable marker (no issue / N/A) and does not carry tracking work.";
    }
    if (statusVocab === 'GAR' && statusValue === 'G') {
      return "Status G findings cannot be promoted — 'G' is the green / pass marker and does not carry tracking work.";
    }
    return `Status ${statusValue} cannot be promoted under vocabulary ${statusVocab}.`;
  }

  async function onSubmit(): Promise<void> {
    if (!promotable || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await inspectionsApi.promoteFinding(findingId, { risk });
      onPromoted(resp);
    } catch (e) {
      if (e instanceof InspectionApiError && e.status === 401) {
        const body = e.body as { action?: string } | undefined;
        stepUpEmitter.dispatch(body?.action ?? 'inspection.finding.promote');
        setError('Step-up authentication required. Complete the prompt and re-submit.');
      } else if (e instanceof InspectionApiError && e.status === 422) {
        const body = e.body as { error?: string } | undefined;
        if (body?.error === 'already_promoted') {
          setError('This finding is already linked to an action item — refresh to see it.');
        } else if (body?.error === 'not_promotable_status') {
          setError(
            'The server rejected this status as non-promotable. The finding may have been edited; refresh and try again.',
          );
        } else {
          setError(`Could not promote (${body?.error ?? 'server rejected the request'}).`);
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
      aria-labelledby="promote-dialog-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            id="promote-dialog-title"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            Promote to action item
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

        <div className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Finding:</span> {sectionLabel} / {itemLabel}
        </div>

        {!promotable ? (
          <PromoteBlocked reason={explainBlockedStatus()} onClose={onClose} />
        ) : (
          <PromoteForm
            risk={risk}
            onRiskChange={setRisk}
            error={error}
            submitting={submitting}
            onCancel={onClose}
            onSubmit={onSubmit}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fail-closed sub-panel — rendered when the status is X (ABC_X) or G
// (GAR). No risk picker, no submit. The copy explains why.
// ---------------------------------------------------------------------------

function PromoteBlocked({ reason, onClose }: { reason: string; onClose: () => void }): JSX.Element {
  return (
    <div className="mt-4">
      <div
        role="alert"
        aria-live="polite"
        className="flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-foreground"
      >
        <ShieldAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div>
          <div className="font-medium">Cannot promote this finding</div>
          <p className="mt-1 text-xs text-muted-foreground">{reason}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            If the finding warrants tracking, re-open it in the inspection (while still in progress)
            and change the status before promoting. If this inspection is already past &lsquo;in
            progress&rsquo;, the finding is immutable — raise a separate hazard or action item to
            track the issue.
          </p>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form sub-panel — rendered when the finding IS promotable.
// ---------------------------------------------------------------------------

function PromoteForm({
  risk,
  onRiskChange,
  error,
  submitting,
  onCancel,
  onSubmit,
}: {
  risk: ActionItemRisk;
  onRiskChange: (r: ActionItemRisk) => void;
  error: string | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <div className="mt-4">
      <p className="text-sm text-muted-foreground">
        Promoting creates an action item linked to this finding. The action item carries its own
        audit-chain entries, status lifecycle, and section moves. The original finding remains
        immutable inside the inspection record.
      </p>

      <fieldset className="mt-4">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Risk
        </legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {actionItemRisk.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRiskChange(r)}
              aria-pressed={risk === r}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                risk === r
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-foreground hover:bg-muted',
              )}
            >
              <span className="font-medium">{r}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{RISK_HINTS[risk]}</p>
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
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={submitting} onClick={onSubmit}>
          {submitting ? 'Promoting…' : `Promote as ${risk}`}
        </Button>
      </div>
    </div>
  );
}
