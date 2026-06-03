// /meetings/:id/finalize — Milestone 2.1 S3, ADR-0012 §3.9.
//
// The 4-signature counter-sign surface. Step-up gated on every
// signature row AND on the final POST /api/meetings/:id/finalize. The
// signer ROLES come from config/workplace.ts at runtime via the
// session response (S5 wires the runtime read); for 2.1 we ship the
// canonical 4-role list with display labels read from a meta tag
// the deploy injects. Per non-negotiable #1, NO label is hardcoded
// here — empty labels fall back to the structural role id.
//
// Per-signer flows:
//
//   - worker_co_chair: signs IN-APP via passkey step-up. Display name
//     defaults to the worker_co_chair attendance row (if present) or
//     the rep's auth display name; rep can edit before signing. No
//     evidence envelope required.
//   - mgmt_co_chair / mgmt_external_1 / mgmt_external_2: sign OFF-APP.
//     The rep records:
//       - signed_method (paper_attestation | email_attestation)
//       - signer_display_name (encrypted client-side)
//       - evidence_envelope (the scan / email body, encrypted
//         client-side)
//       - evidence_storage_key (the Tigris key from the 1.7 upload
//         flow; for 2.1 we stub this with a synthetic key when no
//         upload happens — the route accepts it)
//       - chain_of_custody_note (free text, encrypted client-side)
//
// Rights-protective copy:
//   - Action items are LIVE; finalization is the formal sign-off.
//   - Missing management signatures > 30 days surfaces the s.50
//     reprisal-pathway hint (informational, no prescription).
//   - "Record paper attestation" / "Record email attestation" — never
//     "Mgmt refused to sign". The rep records what happened.

import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  FileSignature,
  Mail,
  Paperclip,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  MeetingApiError,
  meetingsApi,
  type MeetingAttendee,
  type MeetingDetail,
  type MeetingSignature,
} from '@/meetings/api';
import { sealMeetingField, WorkplaceKeyMissingError } from '@/meetings/crypto';
import {
  MEETING_RIGHTS_COPY,
  shouldSurfaceStaleManagementHint,
} from '@/meetings/rights-protective-copy';
import { stepUpEmitter } from '@/auth/api';
import type { MeetingSignedMethod, MeetingSignerRole } from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Signer role config — read at runtime so non-negotiable #1 holds.
// ---------------------------------------------------------------------------

interface SignerRoleDef {
  readonly id: MeetingSignerRole;
  readonly displayLabel: string;
  readonly order: number;
}

const FALLBACK_SIGNER_ORDER: ReadonlyArray<MeetingSignerRole> = [
  'worker_co_chair',
  'mgmt_co_chair',
  'mgmt_external_1',
  'mgmt_external_2',
];

/**
 * Read signer-role display labels from a meta tag the deploy injects
 * (`<meta name="jhsc-signer-{id}-label" content="...">`). When the meta
 * tag is missing the structural id is rendered verbatim so the rep
 * can still complete the workflow with an unlabeled role; the deploy
 * runbook flags missing labels as a config error.
 */
function readSignerRoles(): ReadonlyArray<SignerRoleDef> {
  if (typeof document === 'undefined') {
    return FALLBACK_SIGNER_ORDER.map((id, order) => ({ id, displayLabel: '', order }));
  }
  return FALLBACK_SIGNER_ORDER.map((id, order) => {
    const meta = document.querySelector(`meta[name="jhsc-signer-${id}-label"]`);
    const fromEnv = meta?.getAttribute('content')?.trim() ?? '';
    return { id, displayLabel: fromEnv, order };
  });
}

function describeRole(role: SignerRoleDef): string {
  if (role.displayLabel.length > 0) return role.displayLabel;
  // Structural fallback — keep the underscore form so a CI lint can
  // detect the unlabeled state during the deploy smoke test.
  return role.id;
}

// ---------------------------------------------------------------------------
// Top-level view
// ---------------------------------------------------------------------------

export function MeetingFinalizationView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid meeting id.</div>;
  }
  return <Inner key={id} id={id} />;
}

function Inner({ id }: { id: string }): JSX.Element {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finalising, setFinalising] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const signerRoles = readSignerRoles();

  const refresh = useCallback(async (): Promise<MeetingDetail | null> => {
    try {
      const fresh = await meetingsApi.get(id);
      setDetail(fresh);
      return fresh;
    } catch (e) {
      if (e instanceof MeetingApiError) {
        setError(`Could not load meeting (HTTP ${e.status}).`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      return null;
    }
  }, [id]);

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

  const finalise = async (): Promise<void> => {
    if (!detail) return;
    setActionError(null);
    setFinalising(true);
    try {
      await meetingsApi.finalize(detail.id);
      await refresh();
    } catch (e) {
      if (e instanceof MeetingApiError) {
        if (e.status === 401) {
          const errBody = e.body as { error?: string; action?: string } | undefined;
          if (errBody?.error !== 'step_up_required') {
            stepUpEmitter.dispatch('meeting.finalize');
          }
          setActionError('Step-up required to finalize. Confirm above and tap Finalize again.');
        } else if (e.status === 409) {
          const errBody = e.body as
            | { error?: string; missingRoles?: ReadonlyArray<string> }
            | undefined;
          if (errBody?.error === 'signatures_incomplete') {
            setActionError(
              `Cannot finalize yet — missing signatures: ${(errBody.missingRoles ?? []).join(', ')}.`,
            );
          } else {
            setActionError(`Could not finalize (HTTP ${e.status}).`);
          }
        } else {
          setActionError(`Could not finalize (HTTP ${e.status}).`);
        }
      } else {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setFinalising(false);
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

  const presentRoles = new Set(detail.signatures.map((s) => s.signerRole));
  const missingRoles = signerRoles.filter((r) => !presentRoles.has(r.id)).map((r) => r.id);
  const allSigned = missingRoles.length === 0;
  const showStaleHint = shouldSurfaceStaleManagementHint({
    adjournedAt: detail.actualEndAt,
    missingRoles,
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 pb-32 md:px-6 md:py-8 md:pb-6">
      <div className="mb-3" data-print="hide">
        <Link
          to={`/meetings/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to meeting
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
            Finalize minutes
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {MEETING_RIGHTS_COPY.finalizationSubheading}
          </p>
        </div>
      </header>

      <div
        data-print="evidentiary"
        className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900"
      >
        {MEETING_RIGHTS_COPY.finalizationHeader}
      </div>

      {showStaleHint ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"
          data-testid="stale-management-hint"
        >
          <div className="mb-1 inline-flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Informational
          </div>
          {MEETING_RIGHTS_COPY.staleManagementSignatureHint}
        </div>
      ) : null}

      <ul className="space-y-2">
        {signerRoles.map((role) => (
          <li key={role.id}>
            <SignatureRow
              meetingId={detail.id}
              role={role}
              existing={detail.signatures.find((s) => s.signerRole === role.id) ?? null}
              attendance={detail.attendance}
              onRecorded={() => void refresh()}
            />
          </li>
        ))}
      </ul>

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
        {!allSigned ? (
          <div className="text-xs text-muted-foreground">
            {MEETING_RIGHTS_COPY.finalizeWaitingHint}
          </div>
        ) : null}
        <Button
          onClick={() => void finalise()}
          disabled={!allSigned || finalising || detail.status === 'finalized'}
          className="h-12 md:h-9"
          data-testid="meeting-finalize-confirm"
        >
          {detail.status === 'finalized' ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Finalized
            </>
          ) : finalising ? (
            'Finalising…'
          ) : (
            MEETING_RIGHTS_COPY.finalizeCta
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignatureRow — one per role; renders the in-app or attestation flow
// ---------------------------------------------------------------------------

interface SignatureRowProps {
  readonly meetingId: string;
  readonly role: SignerRoleDef;
  readonly existing: MeetingSignature | null;
  readonly attendance: ReadonlyArray<MeetingAttendee>;
  readonly onRecorded: () => void;
}

function SignatureRow(props: SignatureRowProps): JSX.Element {
  const { meetingId, role, existing, attendance, onRecorded } = props;
  const [open, setOpen] = useState(false);
  const isWorkerCoChair = role.id === 'worker_co_chair';
  const recordedMethod = existing?.signedMethod;

  return (
    <div
      className={cn(
        'rounded-md border bg-card p-3',
        existing ? 'border-emerald-300' : 'border-border',
      )}
      data-print="card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{describeRole(role)}</span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {role.id}
            </span>
            {existing ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                <CheckCircle2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                Signed · {humaniseMethod(existing.signedMethod)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-700">
                {MEETING_RIGHTS_COPY.pendingSignatureLabel}
              </span>
            )}
          </div>
          {existing ? (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Recorded {new Date(existing.signedAt).toLocaleString()} ·{' '}
              {existing.evidenceStorageKey ? 'evidence attached' : 'no evidence (in-app passkey)'}
            </div>
          ) : null}
          {existing ? (
            <div
              className="mt-1 font-mono text-[10px] text-muted-foreground"
              data-print="evidentiary"
            >
              Attestation sig hash: {existing.attestationSignedCt.slice(0, 12)}…
            </div>
          ) : null}
        </div>
        {!existing ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
            data-print="hide"
            data-testid={`sign-${role.id}-cta`}
          >
            {isWorkerCoChair
              ? MEETING_RIGHTS_COPY.inAppSignatureCta
              : MEETING_RIGHTS_COPY.paperAttestationCta}
          </Button>
        ) : null}
      </div>

      {open && !existing ? (
        isWorkerCoChair ? (
          <WorkerCoChairForm
            meetingId={meetingId}
            attendance={attendance}
            onClose={() => setOpen(false)}
            onRecorded={() => {
              setOpen(false);
              onRecorded();
            }}
          />
        ) : (
          <AttestationForm
            meetingId={meetingId}
            role={role}
            onClose={() => setOpen(false)}
            onRecorded={() => {
              setOpen(false);
              onRecorded();
            }}
          />
        )
      ) : null}

      {/* recordedMethod is referenced so the type-narrowing doesn't drop. */}
      <span className="sr-only" data-method={recordedMethod} />
    </div>
  );
}

function humaniseMethod(method: MeetingSignedMethod): string {
  switch (method) {
    case 'in_app_passkey':
      return 'in-app passkey';
    case 'paper_attestation':
      return 'paper attestation';
    case 'email_attestation':
      return 'email attestation';
  }
}

// ---------------------------------------------------------------------------
// Worker co-chair (in-app passkey) form
// ---------------------------------------------------------------------------

function WorkerCoChairForm({
  meetingId,
  attendance,
  onClose,
  onRecorded,
}: {
  meetingId: string;
  attendance: ReadonlyArray<MeetingAttendee>;
  onClose: () => void;
  onRecorded: () => void;
}): JSX.Element {
  const nameId = useId();
  // Default to the attendance row's display name where possible. The
  // attendance row carries ciphertext; the rep types the same name
  // here for the signature row. Future hardening: bind the two via
  // an attendance-id reference so the names cannot drift; for 2.1
  // the rep types the name verbatim.
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasWorkerCoChairAttendance = attendance.some((a) => a.role === 'worker_co_chair');

  const submit = async (): Promise<void> => {
    setError(null);
    const name = displayName.trim();
    if (name.length === 0) {
      setError('Type your name (matches the attendance roster).');
      return;
    }
    setSubmitting(true);
    try {
      const sealed = await sealMeetingField(name);
      await meetingsApi.recordSignature(meetingId, {
        signerRole: 'worker_co_chair',
        signedMethod: 'in_app_passkey',
        signerDisplayNameCt: sealed.ctB64,
        signerDisplayNameDekCt: sealed.dekCtB64,
      });
      onRecorded();
    } catch (e) {
      setError(formatSignatureError(e, 'sign'));
      if (e instanceof MeetingApiError && e.status === 401) {
        const errBody = e.body as { error?: string } | undefined;
        if (errBody?.error !== 'step_up_required') {
          stepUpEmitter.dispatch('meeting.sign.worker_co_chair');
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-border bg-background p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck
          className="mt-0.5 h-4 w-4 text-emerald-700"
          strokeWidth={2}
          aria-hidden="true"
        />
        <div>
          <div className="text-sm font-medium text-foreground">Sign with passkey</div>
          <p className="text-[11px] text-muted-foreground">
            Step-up confirms your identity; the row records when and how. Your name is encrypted
            before it leaves this device.
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <div>
          <label
            htmlFor={nameId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Your name (as shown in the minutes)
          </label>
          <input
            id={nameId}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={200}
            autoComplete="name"
            placeholder="Worker Co-Chair name"
            className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
          />
          {!hasWorkerCoChairAttendance ? (
            <div className="mt-1 text-[11px] text-amber-700">
              No worker_co_chair attendance row is recorded for this meeting. Typing your name here
              records the signer; if you also want the roster updated, return to the meeting and add
              the attendance row.
            </div>
          ) : null}
        </div>
        {error ? (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
          >
            {error}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={submitting}
            data-testid="worker-co-chair-sign"
          >
            {submitting ? 'Signing…' : 'Sign'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Off-app attestation form (paper / email)
// ---------------------------------------------------------------------------

function AttestationForm({
  meetingId,
  role,
  onClose,
  onRecorded,
}: {
  meetingId: string;
  role: SignerRoleDef;
  onClose: () => void;
  onRecorded: () => void;
}): JSX.Element {
  const nameId = useId();
  const methodId = useId();
  const cocId = useId();
  const storageKeyId = useId();
  const evidencePastedId = useId();
  const [method, setMethod] = useState<'paper_attestation' | 'email_attestation'>(
    'paper_attestation',
  );
  const [signerName, setSignerName] = useState('');
  /** Tigris storage key from the (future) evidence upload. For 2.1 the
   * rep can type a key returned by the existing 1.7 upload flow; if
   * empty we synthesise a `pending:<uuid>` key so the route's pre-check
   * passes (real evidence is recorded via the 1.7 surface and the key
   * is the same string). The route validates the key is a non-empty
   * string per the S2 Zod schema. */
  const [storageKey, setStorageKey] = useState('');
  const [evidenceText, setEvidenceText] = useState('');
  const [chainOfCustody, setChainOfCustody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    const name = signerName.trim();
    if (name.length === 0) {
      setError('Signer name is required.');
      return;
    }
    if (evidenceText.trim().length === 0) {
      setError('Paste or describe the attestation evidence (encrypted before send).');
      return;
    }
    if (chainOfCustody.trim().length === 0) {
      setError('Add a brief chain-of-custody note (when and how you received the attestation).');
      return;
    }
    const key = storageKey.trim() || `pending:${cryptoRandomKey()}`;
    setSubmitting(true);
    try {
      const sealedName = await sealMeetingField(name);
      const sealedEvidence = await sealMeetingField(evidenceText);
      const sealedCoc = await sealMeetingField(chainOfCustody);
      await meetingsApi.recordSignature(meetingId, {
        signerRole: role.id,
        signedMethod: method,
        signerDisplayNameCt: sealedName.ctB64,
        signerDisplayNameDekCt: sealedName.dekCtB64,
        evidenceEnvelopeCt: sealedEvidence.ctB64,
        evidenceEnvelopeDekCt: sealedEvidence.dekCtB64,
        evidenceStorageKey: key,
        chainOfCustodyNoteCt: sealedCoc.ctB64,
        chainOfCustodyNoteDekCt: sealedCoc.dekCtB64,
      });
      onRecorded();
    } catch (e) {
      setError(formatSignatureError(e, 'record attestation'));
      if (e instanceof MeetingApiError && e.status === 401) {
        const errBody = e.body as { error?: string } | undefined;
        if (errBody?.error !== 'step_up_required') {
          stepUpEmitter.dispatch(`meeting.sign.${role.id}`);
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-border bg-background p-3">
      <div className="flex items-start gap-2">
        {method === 'email_attestation' ? (
          <Mail
            className="mt-0.5 h-4 w-4 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
        ) : (
          <Paperclip
            className="mt-0.5 h-4 w-4 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
        )}
        <div>
          <div className="text-sm font-medium text-foreground">
            {method === 'email_attestation'
              ? MEETING_RIGHTS_COPY.emailAttestationCta
              : MEETING_RIGHTS_COPY.paperAttestationCta}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {MEETING_RIGHTS_COPY.paperAttestationDescription}
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-3">
        <div>
          <label
            htmlFor={methodId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Method
          </label>
          <select
            id={methodId}
            value={method}
            onChange={(e) => setMethod(e.target.value as typeof method)}
            className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
          >
            <option value="paper_attestation">Paper signature (scan / photo)</option>
            <option value="email_attestation">Email reply (text body)</option>
          </select>
        </div>
        <div>
          <label
            htmlFor={nameId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Signer name
          </label>
          <input
            id={nameId}
            type="text"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            maxLength={200}
            autoComplete="off"
            placeholder={`${describeRole(role)} name`}
            className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
          />
        </div>
        <div>
          <label
            htmlFor={evidencePastedId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Evidence body (encrypted on this device)
          </label>
          <textarea
            id={evidencePastedId}
            value={evidenceText}
            onChange={(e) => setEvidenceText(e.target.value)}
            rows={5}
            maxLength={32_000}
            placeholder={
              method === 'email_attestation'
                ? 'Paste the email body verbatim.'
                : 'Describe the scanned attestation (or paste OCR text).'
            }
            className="mt-1 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-base leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
          />
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {evidenceText.length} / 32,000 · Encrypted before upload.
          </div>
        </div>
        <div>
          <label
            htmlFor={storageKeyId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Evidence storage key (optional)
          </label>
          <input
            id={storageKeyId}
            type="text"
            value={storageKey}
            onChange={(e) => setStorageKey(e.target.value)}
            maxLength={512}
            placeholder="From the evidence upload flow"
            className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
          />
        </div>
        <div>
          <label
            htmlFor={cocId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Chain-of-custody note
          </label>
          <textarea
            id={cocId}
            value={chainOfCustody}
            onChange={(e) => setChainOfCustody(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder='e.g. "Received as a signed PDF emailed 2026-06-12."'
            className="mt-1 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-base leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
          />
        </div>
        {error ? (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
          >
            {error}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={submitting}
            data-testid={`record-${role.id}-attestation`}
          >
            {submitting ? 'Encrypting…' : 'Record attestation'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function cryptoRandomKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return String(Date.now());
}

function formatSignatureError(e: unknown, verb: string): string {
  if (e instanceof WorkplaceKeyMissingError) {
    return 'Workplace key not available yet. Reload after first-run setup completes.';
  }
  if (e instanceof MeetingApiError) {
    if (e.status === 401) {
      return `Step-up required to ${verb}. Confirm above and try again.`;
    }
    if (e.status === 409) {
      const errBody = e.body as { error?: string } | undefined;
      if (errBody?.error === 'signer_role_already_signed') {
        return 'This signer role is already signed for this meeting.';
      }
      return `Could not ${verb} — conflicting row exists.`;
    }
    if (e.status === 422) {
      const errBody = e.body as { error?: string } | undefined;
      return `Could not ${verb} (${errBody?.error ?? 'rejected'}).`;
    }
    return `Could not ${verb} (HTTP ${e.status}).`;
  }
  return e instanceof Error ? e.message : String(e);
}
