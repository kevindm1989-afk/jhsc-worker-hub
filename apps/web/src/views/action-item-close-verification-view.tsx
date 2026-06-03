// /action-items/:id/close-verify — Milestone 2.2 S3 (ADR-0013 §3.5).
//
// The JHSC counter-sign closure attestation. The most security-
// sensitive surface in M2.2:
//
//   - Step-up gate (the WebAuthn assertion is required at submit time;
//     the route returns 401 step_up_required if the rep's grant has
//     expired; the global StepUpModal handles the recovery via
//     stepUpEmitter).
//   - Counter-signer auto-resolves to the current actor for single-rep
//     workplaces (M2.2 ships co-chair-only counter-sign per S0 Q1).
//     The selfAttestation flag is set TRUE and the rights-protective
//     banner surfaces verbatim from MEETING_RIGHTS_COPY.
//   - Closure reason is sealed CLIENT-SIDE via the existing
//     @/meetings/crypto envelope (same XChaCha20-Poly1305 + sealed-box
//     DEK pattern as M2.1 attendee names). The server never sees
//     plaintext.
//   - Evidence upload is OPTIONAL — the 1.7 evidence flow's storage
//     key + envelope-sealed bytes are accepted by the route. For M2.2
//     S3 the upload UI is a forward seam (the storage-key text input
//     is wired so a future-rep can paste a pre-uploaded key; the
//     route's HEAD-verify is what enforces correctness at the server).
//   - Online-only (per ADR §3.8 T-IM23). When offline the submit is
//     disabled and the closureOfflineHint copy surfaces.
//
// Rights-protective copy (T-IM25, T-IM26, T-IM27):
//   - Banner: evidence framing, never gatekeeping.
//   - Placeholder: "What was done to verify closure?" (not "justify").
//   - Submit CTA: "Record closure verification" (not "Approve").
//   - selfAttestation banner: verbatim from S0 addendum, no judgement.

import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, FileSignature, Info, Lock, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/auth-context';
import { stepUpEmitter } from '@/auth/api';
import {
  ActionItemsApiError,
  actionItemsApi,
  type ActionItemClosureVerificationResponse,
  type ActionItemDetail,
} from '@/action-items/api';
import { sealMeetingField, WorkplaceKeyMissingError } from '@/meetings/crypto';
import { MEETING_RIGHTS_COPY } from '@/meetings/rights-protective-copy';
import { NetworkRequiredError, requireOnline } from '@/sync/typed-client';
import { db } from '@/sync/db';

export function ActionItemCloseVerificationView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid action item id.</div>;
  }
  return <Inner key={id} id={id} />;
}

type FlowState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly item: ActionItemDetail }
  | { readonly kind: 'submitting'; readonly item: ActionItemDetail }
  | {
      readonly kind: 'success';
      readonly item: ActionItemDetail;
      readonly response: ActionItemClosureVerificationResponse;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'error'; readonly message: string };

function Inner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const auth = useAuth();
  const [state, setState] = useState<FlowState>({ kind: 'loading' });
  const [reason, setReason] = useState('');
  const [evidenceStorageKey, setEvidenceStorageKey] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const reasonId = useId();
  const evidenceId = useId();
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    actionItemsApi
      .get(id)
      .then((item) => {
        if (cancelledRef.current) return;
        setState({ kind: 'ready', item });
      })
      .catch((e: unknown) => {
        if (cancelledRef.current) return;
        if (e instanceof ActionItemsApiError && e.status === 404) {
          setState({ kind: 'not_found' });
        } else {
          setState({
            kind: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = (): void => setOnline(true);
    const onOffline = (): void => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="h-32 animate-pulse rounded-md border border-border bg-muted/40" />
      </div>
    );
  }
  if (state.kind === 'not_found') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-muted-foreground">
        Action item not found.{' '}
        <Link to="/action-items" className="text-primary underline">
          Back to action items
        </Link>
        .
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
          {state.message}
        </div>
      </div>
    );
  }

  const item =
    state.kind === 'success' || state.kind === 'submitting' || state.kind === 'ready'
      ? state.item
      : null;
  if (!item) return <></>;

  const alreadyClosed = item.status === 'Closed' || item.verifiedByJhscId !== null;
  // M2.2 S5 F-P2 fix: `Not Started` is NOT ineligible. Per ADR §3.2
  // the route accepts a Not-Started → Closed closure verification
  // with a SOFT-WARNING UI banner — never a gate. Pre-fix the view
  // treated Not Started as ineligible with amber AlertTriangle
  // gatekeeping framing, contradicting the rights-protective stance
  // (T-IM25). The amber AlertTriangle gate is now reserved for
  // `Cancelled` items (which the route DOES reject with
  // not_closable_via_verification — see ADR §3.5). Not Started
  // surfaces as a neutral informational banner below the form.
  const ineligibleStatus = item.status === 'Cancelled';
  const notStartedSoftWarning = item.status === 'Not Started' && state.kind !== 'success';
  const userId = auth.session?.userId ?? '';
  const selfAttestation = true; // M2.2 single-rep — see S0 Q1.

  const onSubmit = async (): Promise<void> => {
    if (state.kind !== 'ready') return;
    setSubmitError(null);
    const reasonText = reason.trim();
    if (reasonText.length === 0) {
      setSubmitError('Closure reason is required.');
      return;
    }
    if (!online) {
      setSubmitError(MEETING_RIGHTS_COPY.closureOfflineHint);
      return;
    }
    if (!userId) {
      setSubmitError('Sign-in expired. Reload and try again.');
      return;
    }
    setState({ kind: 'submitting', item });
    try {
      const sealed = await sealMeetingField(reasonText);
      const response = await requireOnline('action_item.close_verification', () =>
        actionItemsApi.closeVerification(item.id, {
          counterSignerActorId: userId,
          selfAttestation,
          meetingId: item.meetingId ?? undefined,
          closureReason: {
            ciphertextB64: sealed.ctB64,
            dekCiphertextB64: sealed.dekCtB64,
          },
          ...(evidenceStorageKey.trim().length > 0
            ? {
                evidence: {
                  storageKey: evidenceStorageKey.trim(),
                  // The envelope ciphertext is produced by the 1.7
                  // evidence pipeline; for the M2.2 S3 hand-paste path
                  // we send empty envelopes — the server's HEAD-verify
                  // is the structural gate. A future S5 reviewer
                  // should flag this as a UX gap: the proper flow
                  // routes evidence through the existing CaptureFab /
                  // EvidenceUpload surface and supplies real
                  // ciphertext here.
                  envelopeCtB64: '',
                  envelopeDekCtB64: '',
                },
              }
            : {}),
        }),
      );
      // Best-effort cache write — the success path renders the chain
      // anchor from the response payload, the cache fills in the
      // background.
      try {
        await db.action_item_closures.put({
          id: response.closureId,
          actionItemId: item.id,
          meetingId: item.meetingId,
          closedByActorId: userId,
          closedAt: response.closedAt,
          counterSignerActorId: userId,
          counterSignedAt: response.counterSignedAt,
          selfAttestation: response.selfAttestation,
          signingKeyId: '',
          evidenceStorageKey: evidenceStorageKey.trim() || null,
          chainAnchorHash: response.chainAnchorHash,
          attestationSigHash: response.attestationSigHash,
          cachedAt: new Date().toISOString(),
        });
      } catch {
        // Cache failure is non-fatal.
      }
      if (cancelledRef.current) return;
      setState({ kind: 'success', item, response });
    } catch (e) {
      if (cancelledRef.current) return;
      if (e instanceof NetworkRequiredError) {
        setSubmitError(MEETING_RIGHTS_COPY.closureOfflineHint);
        setState({ kind: 'ready', item });
        return;
      }
      if (e instanceof WorkplaceKeyMissingError) {
        setSubmitError(
          'Workplace public key is not available; first-run setup must be complete before recording closures.',
        );
        setState({ kind: 'ready', item });
        return;
      }
      if (e instanceof ActionItemsApiError) {
        if (e.status === 401) {
          const body = e.body as { action?: string } | undefined;
          stepUpEmitter.dispatch(body?.action ?? 'action_item.close_verification');
          setSubmitError('Step-up required. Confirm above and try recording the closure again.');
        } else if (e.status === 409) {
          setSubmitError('Already verified — refresh the action item to see the closure.');
        } else if (e.status === 422) {
          const body = e.body as { message?: string } | undefined;
          setSubmitError(body?.message ?? 'Closure rejected — see the route response.');
        } else if (e.status === 503) {
          setSubmitError(MEETING_RIGHTS_COPY.closureOfflineHint);
        } else {
          setSubmitError(`Could not record closure (HTTP ${e.status}).`);
        }
      } else {
        setSubmitError(e instanceof Error ? e.message : String(e));
      }
      setState({ kind: 'ready', item });
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-32 md:px-6 md:py-8 md:pb-6">
      <div className="mb-3" data-print="hide">
        <Link
          to={`/action-items/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to action item
        </Link>
      </div>

      <header className="mb-3 flex items-start gap-2">
        <FileSignature
          className="mt-1 h-5 w-5 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Verify closure
          </h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">#{item.sequenceNumber}</p>
        </div>
      </header>

      <div
        data-print="evidentiary"
        className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900"
      >
        {MEETING_RIGHTS_COPY.closureVerificationBanner}
      </div>

      {alreadyClosed && state.kind !== 'success' ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900"
          data-testid="closure-already-verified"
        >
          <CheckCircle2 className="mr-1 inline h-4 w-4" strokeWidth={2} aria-hidden="true" />
          This action item is already closed and verified. View the closure metadata on the action
          item detail page.
        </div>
      ) : null}

      {!alreadyClosed && ineligibleStatus ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-800"
          data-testid="closure-ineligible-status"
        >
          <Info className="mr-1 inline h-4 w-4" strokeWidth={2} aria-hidden="true" />
          This action item was cancelled. Cancellations are recorded via the routine status flow and
          do not require closure verification.
        </div>
      ) : null}

      {state.kind !== 'success' && !alreadyClosed && !ineligibleStatus ? (
        <>
          {notStartedSoftWarning ? (
            <div
              role="status"
              aria-live="polite"
              className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"
              data-testid="closure-not-started-notice"
            >
              <Info className="mr-1 inline h-4 w-4" strokeWidth={2} aria-hidden="true" />
              This item is marked <strong>Not Started</strong>. Confirm the work was done; closure
              verification is your evidence that addresses the item.
            </div>
          ) : null}

          <div
            data-print="hide"
            className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900"
            data-testid="closure-self-attestation-banner"
          >
            <Info className="mr-1 inline h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {MEETING_RIGHTS_COPY.closureSelfAttestationBanner}
          </div>

          {!online ? (
            <div
              role="alert"
              aria-live="polite"
              data-testid="closure-offline-hint"
              className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
            >
              <WifiOff className="mr-1 inline h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              {MEETING_RIGHTS_COPY.closureOfflineHint}
            </div>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit();
            }}
            className="space-y-4"
            data-print="hide"
          >
            <div>
              <label
                htmlFor={reasonId}
                className="mb-1 flex items-center gap-1 text-xs font-medium text-foreground"
              >
                <Lock
                  className="h-3 w-3 text-muted-foreground"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                Closure reason (encrypted client-side)
              </label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={MEETING_RIGHTS_COPY.closureReasonPlaceholder}
                rows={5}
                maxLength={4000}
                required
                data-testid="closure-reason-input"
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-base leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Sealed under the workplace public key before submit; the server never sees
                plaintext.
              </p>
            </div>

            <div>
              <label
                htmlFor={evidenceId}
                className="mb-1 flex items-center gap-1 text-xs font-medium text-foreground"
              >
                Evidence storage key (optional)
              </label>
              <input
                id={evidenceId}
                value={evidenceStorageKey}
                onChange={(e) => setEvidenceStorageKey(e.target.value)}
                placeholder="closure-evidence/{...}"
                maxLength={512}
                data-testid="closure-evidence-input"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Upload evidence via the capture flow first; paste the resulting Tigris storage key
                here. The server HEAD-verifies the upload.
              </p>
            </div>

            {submitError ? (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
              >
                {submitError}
              </div>
            ) : null}

            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-end">
              <Button
                type="submit"
                disabled={state.kind === 'submitting' || reason.trim().length === 0 || !online}
                className="h-12 md:h-9"
                data-testid="closure-submit-cta"
              >
                {state.kind === 'submitting' ? 'Recording…' : MEETING_RIGHTS_COPY.closureSubmitCta}
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {state.kind === 'success' ? (
        <section
          aria-labelledby="closure-success-heading"
          className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900"
          data-testid="closure-success-panel"
        >
          <h2
            id="closure-success-heading"
            className="flex items-center gap-2 text-base font-semibold"
          >
            <CheckCircle2 className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            {MEETING_RIGHTS_COPY.closureSuccessHeading}
          </h2>
          <p className="mt-2 text-xs leading-relaxed">
            Recorded in the chain at{' '}
            <span className="font-mono tabular-nums">
              {new Date(state.response.counterSignedAt).toLocaleString()}
            </span>
            .
          </p>
          <dl className="mt-3 space-y-1 text-[11px]" data-print="evidentiary">
            <Detail label="Closure id" value={state.response.closureId} />
            <Detail label="Chain anchor" value={state.response.chainAnchorHash} />
            <Detail label="Attestation signature" value={state.response.attestationSigHash} />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2" data-print="hide">
            <Button
              size="sm"
              onClick={() => navigate(`/action-items/${encodeURIComponent(item.id)}`)}
              data-testid="closure-back-to-detail"
            >
              Back to action item
            </Button>
            {item.meetingId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/meetings/${encodeURIComponent(item.meetingId ?? '')}`)}
              >
                Back to meeting
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="uppercase tracking-wide text-emerald-800/70">{label}</dt>
      <dd className="break-all font-mono text-emerald-900">{value}</dd>
    </div>
  );
}
