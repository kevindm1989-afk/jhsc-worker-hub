// Inspection signature sheet — rendered inside InspectionDetailView when
// the inspection's state is 'awaiting_signatures' (or, for rack
// templates, also during 'in_progress' once the first signature lands;
// the server auto-bumps the state).
//
// Per ADR-0007 §3.8:
//   - zone_monthly: one signature, role='inspector'. Auto-completes.
//   - rack_inspection: three signatures, roles='inspector' + 'supervisor'
//     + 'jhsc_worker_co_chair'. Auto-completes when all three land.
//
// SINGLE-TENANT SIMPLIFICATION: any authenticated rep can sign as any
// role — the role label tracks WHO they sign AS. A workplace-roles table
// lands in a future release. The audit-chain row records the user id +
// the role they signed as; arbitration can reconcile.
//
// Rights-protective copy (T-I20): the signature attests the inspection
// was conducted under the pinned template version. It does NOT authorize
// the workplace to alter, re-interpret, or omit findings; the audit
// chain records the snapshot.

import { useEffect, useState } from 'react';
import { CalendarClock, CheckCircle2, Clock, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  inspectionsApi,
  InspectionApiError,
  type InspectionSignatureSummary,
} from '@/inspections/api';
import { SIGNATURE_ROLE_LABELS, requiredRolesForTemplate } from '@/inspections/components';
import { stepUpEmitter } from '@/auth/api';
import { db } from '@/sync/db';
import type { InspectionConductState, InspectionSignatureRole } from '@jhsc/shared-types';

interface InspectionSignatureSheetProps {
  readonly inspectionId: string;
  readonly state: InspectionConductState;
  readonly requiresThreeSignatures: boolean;
  readonly templateDisplayName: string;
  readonly templateVersionNote: string;
  readonly signatures: ReadonlyArray<InspectionSignatureSummary>;
  readonly onSigned: () => void;
}

export function InspectionSignatureSheet(props: InspectionSignatureSheetProps): JSX.Element {
  const {
    inspectionId,
    state,
    requiresThreeSignatures,
    templateDisplayName,
    templateVersionNote,
    signatures,
    onSigned,
  } = props;

  const requiredRoles = requiredRolesForTemplate(requiresThreeSignatures);
  const signedRoles = new Set(signatures.map((s) => s.role));

  const readOnly = state === 'complete' || state === 'archived';

  return (
    <section
      aria-labelledby="inspection-signatures-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="inspection-signatures-heading"
        className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Signatures
      </h2>

      <p className="mb-3 text-xs text-muted-foreground">
        Your signature attests that this inspection was conducted per{' '}
        <span className="font-medium text-foreground">{templateDisplayName}</span> (
        {templateVersionNote}). The audit chain records your signature timestamp and the section
        snapshots — your signature does NOT authorize the workplace to alter or interpret your
        findings.
      </p>

      {/* priv-F3 close-out (T-S54): offline-signature clock notice. Mirrors
          the recommendation OfflineSubmitClockNotice but framed for the
          signature flow (signatures are MORE evidentially weighty than
          recommendation submits — a recommendation can be re-submitted; a
          signature is a one-shot legal act tied to identity + role +
          immutable template version pin). Renders ONLY when the rep has a
          pending inspection_signature op for the current inspection in
          sync_queue. Rights-protective tone (CLAUDE.md #7): no shame, no
          anxiety-induce. */}
      <OfflineSignatureTimestampNotice inspectionId={inspectionId} />

      {/* Existing signatures */}
      {signatures.length > 0 ? (
        <ul className="mb-3 space-y-1.5">
          {signatures.map((sig) => (
            <li
              key={sig.id}
              className="flex items-start gap-2 rounded-md border border-emerald-100 bg-emerald-50/50 p-2"
            >
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                strokeWidth={2}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {SIGNATURE_ROLE_LABELS[sig.role]}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  <span className="font-mono tabular-nums">{sig.signedByUserId.slice(0, 8)}</span>
                  <span> · </span>
                  <span>{new Date(sig.signedAt).toLocaleString()}</span>
                  {sig.hasNote ? (
                    <span className="ml-1 inline-flex items-center gap-0.5">
                      <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                      encrypted note
                    </span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Pending signature affordances */}
      {!readOnly ? (
        <div className="space-y-2">
          {requiredRoles.map((role) => {
            if (signedRoles.has(role)) return null;
            return (
              <SignAsRoleControl
                key={role}
                inspectionId={inspectionId}
                role={role}
                onSigned={onSigned}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-emerald-100 bg-emerald-50/50 p-3 text-xs text-emerald-700">
          All required signatures collected. The inspection is{' '}
          {state === 'archived' ? 'archived' : 'complete'} and now immutable.
        </div>
      )}

      {/* Pending hint */}
      {!readOnly && requiredRoles.every((r) => signedRoles.has(r)) ? (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-status-pending/10 p-2 text-xs text-status-pending">
          <Clock className="mt-0.5 h-3 w-3" strokeWidth={2} aria-hidden="true" />
          <span>
            All required roles signed. The inspection should auto-advance to complete on the next
            refresh.
          </span>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-role sign affordance — opens an inline confirmation sheet with an
// optional encrypted note.
// ---------------------------------------------------------------------------

function SignAsRoleControl({
  inspectionId,
  role,
  onSigned,
}: {
  inspectionId: string;
  role: InspectionSignatureRole;
  onSigned: () => void;
}): JSX.Element {
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSign(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await inspectionsApi.signInspection(inspectionId, {
        role,
        note: note.trim() || undefined,
      });
      setOpened(false);
      setNote('');
      onSigned();
    } catch (e) {
      if (e instanceof InspectionApiError && e.status === 401) {
        const body = e.body as { action?: string } | undefined;
        stepUpEmitter.dispatch(body?.action ?? `inspection.sign.${role}`);
        setError('Step-up authentication required. Complete the prompt and re-sign.');
      } else if (e instanceof InspectionApiError && e.status === 409) {
        setError('That role was already signed by someone else. Refresh to update.');
      } else if (e instanceof InspectionApiError && e.status === 422) {
        const body = e.body as { error?: string } | undefined;
        setError(`Cannot sign in the current inspection state (${body?.error ?? 'rejected'}).`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!opened) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background p-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{SIGNATURE_ROLE_LABELS[role]}</div>
          <div className="text-[11px] text-muted-foreground">Not yet signed</div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpened(true)}>
          Sign as {SIGNATURE_ROLE_LABELS[role]}
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
      <div className="mb-2 text-sm font-medium text-foreground" data-testid="sign-as-role-form">
        Sign as {SIGNATURE_ROLE_LABELS[role]}
      </div>
      <label htmlFor={`sig-note-${role}`} className={cn('block text-xs text-muted-foreground')}>
        Note (optional, encrypted)
      </label>
      <textarea
        id={`sig-note-${role}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        rows={2}
        className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder="e.g. signed off after walk-through with crew lead"
      />
      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="mt-2 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
        >
          {error}
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setOpened(false);
            setNote('');
            setError(null);
          }}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={submitting} onClick={onSign}>
          {submitting ? 'Signing…' : 'Sign'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OfflineSignatureTimestampNotice — priv-F3 close-out (T-S54).
//
// Mirrors the recommendation OfflineSubmitClockNotice (defined inline in
// recommendation-detail-view.tsx) but framed for the inspection signature
// flow. Renders ONLY when there's a pending inspection_signature op for
// this inspection in the sync_queue. The rep needs to know at sign-time
// that the chain anchor will record the SERVER's receive time, not the
// moment they tapped Sign — without this affordance the rep is ambushed
// in arbitration when the chain row shows a timestamp hours later than
// their pen-touched-screen reality (SECURITY.md T-S21).
//
// Rights-protective tone (CLAUDE.md #7): legally accurate, not anxiety-
// inducing. The pairing of CalendarClock + amber + textual label reads
// at a glance without color alone (CLAUDE.md design rule).
// ---------------------------------------------------------------------------

function OfflineSignatureTimestampNotice({
  inspectionId,
}: {
  inspectionId: string;
}): JSX.Element | null {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      try {
        // sync_queue rows for inspection_signature ops do NOT carry the
        // inspection id as entityLocalId — entityLocalId is the
        // signature's own UUID. We match by entityKind +
        // endpoint-suffix which embeds the inspection id.
        // (The signature endpoint is /api/inspections/:id/signatures.)
        const rows = await db.sync_queue.toArray();
        const hasPending = rows.some(
          (r) =>
            r.entityKind === 'inspection_signature' &&
            (r.state === 'queued' || r.state === 'in_flight') &&
            r.endpoint.includes(`/inspections/${inspectionId}/signatures`),
        );
        if (!cancelled) setPending(hasPending);
      } catch {
        if (!cancelled) setPending(false);
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [inspectionId]);

  if (!pending) return null;

  return (
    <section
      aria-labelledby="offline-signature-clock-heading"
      data-testid="offline-signature-timestamp-notice"
      className="mb-3 rounded-md border border-status-pending/40 bg-status-pending/5 p-3 text-sm"
    >
      <h3
        id="offline-signature-clock-heading"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-status-pending"
      >
        <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Signature queued — chain timestamp at server
      </h3>
      <p className="text-sm text-foreground">
        This signature will be recorded on the server when you&apos;re back online.{' '}
        <strong>
          The chain of custody timestamp will be the SERVER&apos;s receive time, NOT the moment you
          signed.
        </strong>{' '}
        For arbitration purposes, your device&apos;s clock-time is your record; the chain proves
        server-receipt.
      </p>
    </section>
  );
}
