// /inspections/:id/findings/:findingId — full decrypted finding view.
//
// IMPORTANT:
//   - Does NOT auto-fetch on mount. The user must tap "Reveal" — step-up
//     is intentional friction (T-I12 mirror of T-H4 from 1.5).
//   - On 401 step_up_required the API client dispatches the
//     stepUpEmitter; the global modal opens and the caller re-clicks
//     Reveal after the modal closes. Same UX as EvidenceList onReveal
//     and HazardDetailView ReporterRevealPanel.
//   - Below the decrypted text we embed <EvidenceList linkedType=
//     'inspection_finding' .../> + <CaptureFab/>. 1.7 S2 ratcheted the
//     evidence linked-type allow-list to include 'inspection_finding';
//     S2 confirmed the route layer accepts it.

import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Eye, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CaptureFab, EvidenceList } from '@/evidence/components';
import { FindingStatusBadge } from '@/inspections/components';
import { InspectionPromoteDialog } from '@/components/inspection-promote-dialog';
import {
  InspectionApiError,
  inspectionsApi,
  isStepUpRequired,
  type FindingDetail,
  type ResponsibleParty,
} from '@/inspections/api';
import { inspectionPromotability } from '@jhsc/shared-types';

export function FindingDetailView(): JSX.Element {
  const { id: inspectionId, findingId } = useParams<{ id: string; findingId: string }>();
  if (!findingId || !inspectionId) {
    return <div className="p-4 text-sm text-status-rejected">Invalid finding id.</div>;
  }
  return <FindingDetailInner key={findingId} inspectionId={inspectionId} findingId={findingId} />;
}

function FindingDetailInner({
  inspectionId,
  findingId,
}: {
  inspectionId: string;
  findingId: string;
}): JSX.Element {
  const [meta, setMeta] = useState<FindingDetail | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);

  const fetchMeta = useCallback(async (): Promise<void> => {
    setRevealing(true);
    setError(null);
    setNeedsStepUp(false);
    try {
      const r = await inspectionsApi.getFinding(findingId);
      if (isStepUpRequired(r)) {
        // Global modal already opened by the API client. Surface the
        // "needs step-up" CTA so the user can re-tap after closing.
        setNeedsStepUp(true);
        return;
      }
      setMeta(r);
      setRevealed(true);
    } catch (e) {
      if (e instanceof InspectionApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevealing(false);
    }
  }, [findingId]);

  // Intentional: DO NOT call fetchMeta on mount. Step-up gating means
  // the user has to tap the Reveal button. The wrapper component uses
  // `key={findingId}` so a new finding remounts this surface with
  // clean state — no useEffect-driven reset needed (and the
  // setState-in-effect lint rule would flag it anyway).

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <Link
          to={`/inspections/${encodeURIComponent(inspectionId)}`}
          className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to inspection
        </Link>
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          That finding does not exist.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <Link
        to={`/inspections/${encodeURIComponent(inspectionId)}`}
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to inspection
      </Link>

      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
          Finding
        </h1>
        <div className="mt-1 text-xs text-muted-foreground">
          <span>Finding ID </span>
          <span className="font-mono tabular-nums">{findingId.slice(0, 8)}</span>
          <span> · part of inspection </span>
          <Link
            to={`/inspections/${encodeURIComponent(inspectionId)}`}
            className="font-mono tabular-nums text-primary hover:underline"
          >
            {inspectionId.slice(0, 8)}
          </Link>
        </div>
      </header>

      {revealed && meta ? (
        <RevealedFinding finding={meta} onPromote={() => setPromoteOpen(true)} />
      ) : (
        <MaskedFinding
          needsStepUp={needsStepUp}
          revealing={revealing}
          error={error}
          onReveal={fetchMeta}
        />
      )}

      {/* Evidence — accepted for linkedType='inspection_finding' since 1.8 S2. */}
      <section
        aria-labelledby="finding-evidence-heading"
        className="mt-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="finding-evidence-heading"
          className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Evidence
        </h2>
        <EvidenceList linkedType="inspection_finding" linkedId={findingId} />
      </section>

      <CaptureFab linkedType="inspection_finding" linkedId={findingId} />

      {meta && promoteOpen ? (
        <InspectionPromoteDialog
          open
          findingId={meta.id}
          statusVocab={meta.statusVocab}
          statusValue={meta.statusValue}
          sectionLabel={meta.sectionLabel}
          itemLabel={meta.itemLabel}
          onClose={() => setPromoteOpen(false)}
          onPromoted={() => {
            setPromoteOpen(false);
            void fetchMeta();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Masked state — default render. Reveal triggers the step-up flow.
// ---------------------------------------------------------------------------

function MaskedFinding({
  needsStepUp,
  revealing,
  error,
  onReveal,
}: {
  needsStepUp: boolean;
  revealing: boolean;
  error: string | null;
  onReveal: () => void;
}): JSX.Element {
  return (
    <section
      aria-labelledby="finding-masked-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2
        id="finding-masked-heading"
        className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Encrypted · Reveal to read
      </h2>
      <p className="text-sm text-muted-foreground">
        The observation, corrective action, and responsible party fields are encrypted at rest.
        Revealing them requires step-up authentication (passkey or TOTP, 60-second freshness
        window). Each reveal is anchored in the audit chain.
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        {needsStepUp ? (
          <span className="text-xs text-status-pending">
            Step-up authentication required. Complete the prompt, then tap Reveal again.
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No data loaded yet.</span>
        )}
        <Button type="button" variant="default" size="sm" disabled={revealing} onClick={onReveal}>
          <Eye className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          {revealing ? 'Revealing…' : 'Reveal'}
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="mt-2 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Revealed state — the decrypted finding text + promote affordance.
// ---------------------------------------------------------------------------

function RevealedFinding({
  finding,
  onPromote,
}: {
  finding: FindingDetail;
  onPromote: () => void;
}): JSX.Element {
  const isPromotable = inspectionPromotability(finding.statusVocab, finding.statusValue);
  const isPromoted = finding.promotedActionItemId !== null;
  return (
    <section
      aria-labelledby="finding-revealed-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2
        id="finding-revealed-heading"
        className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Decrypted
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <FindingStatusBadge vocab={finding.statusVocab} value={finding.statusValue} />
        <span className="text-xs text-muted-foreground">
          {finding.sectionLabel} / {finding.itemLabel}
        </span>
      </div>
      <div className="mt-3 space-y-3">
        <RevealedField label="Observation" value={finding.observation} />
        <RevealedField label="Corrective action" value={finding.correctiveAction} />
        <RevealedField
          label="Responsible party"
          value={formatResponsibleParty(finding.responsibleParty)}
        />
      </div>
      <div className="mt-3 text-[11px] text-muted-foreground">
        Created {new Date(finding.createdAt).toLocaleString()} · last updated{' '}
        {new Date(finding.updatedAt).toLocaleString()}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isPromoted && finding.promotedActionItemId !== null ? (
          <Button asChild variant="outline" size="sm">
            <Link to={`/action-items/${encodeURIComponent(finding.promotedActionItemId)}`}>
              View linked action item
            </Link>
          </Button>
        ) : isPromotable ? (
          <Button type="button" size="sm" onClick={onPromote}>
            Promote to action item
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            This finding cannot be promoted (status {finding.statusValue} in vocabulary{' '}
            {finding.statusVocab}).
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * 1.9 S5 priv-F1 close-out: project the server's responsibleParty
 * discriminated union (`{kind: 'user_ref', userId} | {kind: 'name_text',
 * nameText}`) into a single string-or-null shape suitable for the
 * RevealedField caller.
 *
 *   - `null` → null (em-dash placeholder).
 *   - `name_text` → the decrypted plaintext.
 *   - `user_ref` → an 8-char UUID prefix + `…`. Until a workplace user
 *     list with display names ships in 1.12, the prefix is the minimum
 *     identifier the rep needs to distinguish internal owners on the
 *     reveal screen without surfacing the full uuid. The runbook
 *     documents the trade-off (priv-F13).
 *
 * Exported for the test surface.
 */
export function formatResponsibleParty(rp: ResponsibleParty | null): string | null {
  if (rp === null) return null;
  if (rp.kind === 'name_text') return rp.nameText;
  // kind === 'user_ref' — render an 8-char prefix until a user-picker
  // resolution ships (1.12 follow-up).
  return `${rp.userId.slice(0, 8)}…`;
}

function RevealedField({ label, value }: { label: string; value: string | null }): JSX.Element {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {value && value.length > 0 ? value : <span className="text-muted-foreground">—</span>}
      </div>
    </div>
  );
}
