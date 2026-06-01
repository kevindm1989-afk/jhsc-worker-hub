// /inspections/:id — template-driven conduct flow (the centerpiece).
//
// Reads the pinned `template_version_id` from the inspection row and
// renders its sections (non-negotiable #13 — inspections preserve their
// template version at conduct time). The UI never falls back to a
// "latest" template; the audit chain anchors the version pin.
//
// State-aware affordances:
//   - scheduled:           [Start inspection] button. No findings shown.
//   - in_progress:         Per-section "Add finding" inline forms +
//                          [Finish capture] button. Disabled with zero
//                          findings; the API also enforces this.
//   - awaiting_signatures: Read-only findings + signature sheet.
//   - complete / archived: Read-only.
//
// Per-finding card:
//   - Status badge (vocab-aware).
//   - "Reveal" affordance (links to /inspections/:id/findings/:findingId).
//   - "Promote to action item" affordance (#15 fail-closed via the
//     shared-types helper).
//
// CSRF / 401: identical posture to hazards / action-items — surfaces to
// the global step-up modal via stepUpEmitter.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Lock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  InspectionApiError,
  inspectionsApi,
  type CreateExportResponse,
  type CreateFindingBody,
  type InspectionDetail,
  type InspectionFindingSummary,
  type TemplateItem,
  type TemplateSection,
} from '@/inspections/api';
import {
  FindingStatusBadge,
  InspectionStateBadge,
  STATUS_VOCAB_LABELS,
  TEMPLATE_CODE_LABELS,
  resolveZoneLabel,
  statusValuesForVocab,
} from '@/inspections/components';
import { InspectionPromoteDialog } from '@/components/inspection-promote-dialog';
import { InspectionSignatureSheet } from '@/components/inspection-signature-sheet';
import {
  inspectionPromotability,
  type InspectionConductState,
  type InspectionStatusVocabKind,
} from '@jhsc/shared-types';

export function InspectionDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid inspection id.</div>;
  }
  return <InspectionDetailInner key={id} id={id} />;
}

function InspectionDetailInner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const [inspection, setInspection] = useState<InspectionDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingState, setPendingState] = useState<InspectionConductState | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<InspectionFindingSummary | null>(null);

  const refresh = useCallback((): Promise<void> => {
    return inspectionsApi
      .getInspection(id)
      .then((fresh) => {
        setInspection(fresh);
      })
      .catch((e: unknown) => {
        if (e instanceof InspectionApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    inspectionsApi
      .getInspection(id)
      .then((fresh) => {
        if (!cancelled) setInspection(fresh);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof InspectionApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function applyStateTransition(to: InspectionConductState): Promise<void> {
    if (!inspection) return;
    setPendingState(to);
    setError(null);
    try {
      await inspectionsApi.patchInspection(inspection.id, { state: to });
      await refresh();
    } catch (e) {
      if (e instanceof InspectionApiError && e.status === 422) {
        const body = e.body as { error?: string } | undefined;
        setError(
          body?.error === 'no_findings_to_advance'
            ? 'Add at least one finding before finishing capture.'
            : `State transition rejected (${body?.error ?? 'illegal'}).`,
        );
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPendingState(null);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <Link
          to="/inspections"
          className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to inspections
        </Link>
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          That inspection does not exist or was archived.
          <div className="mt-2">
            <Button asChild size="sm">
              <Link to="/inspections">Back to list</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (error && !inspection) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
          {error}
        </div>
      </div>
    );
  }
  if (!inspection) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-muted-foreground">Loading…</div>
    );
  }

  const findingsBySection = groupFindingsBySection(inspection.findings);
  const isOpenForFindings = inspection.state === 'in_progress';
  const isAwaitingSignatures = inspection.state === 'awaiting_signatures';
  const isReadOnly = inspection.state === 'complete' || inspection.state === 'archived';

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <Link
        to="/inspections"
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to inspections
      </Link>

      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <InspectionStateBadge state={inspection.state} />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {TEMPLATE_CODE_LABELS[inspection.templateCode]}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {STATUS_VOCAB_LABELS[inspection.statusVocab]}
          </span>
          {inspection.requiresThreeSignatures ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">3-sig</span>
          ) : null}
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {inspection.templateDisplayName}
        </h1>
        <div className="mt-1 text-xs text-muted-foreground">
          <span>{resolveZoneLabel(inspection.zoneId)}</span>
          <span> · conducted by </span>
          <span className="font-mono tabular-nums">{inspection.conductedByUserId.slice(0, 8)}</span>
          {inspection.scheduledFor ? (
            <span> · scheduled {new Date(inspection.scheduledFor).toLocaleString()}</span>
          ) : null}
          {inspection.startedAt ? (
            <span> · started {new Date(inspection.startedAt).toLocaleString()}</span>
          ) : null}
          {inspection.completedAt ? (
            <span> · completed {new Date(inspection.completedAt).toLocaleString()}</span>
          ) : null}
        </div>
      </header>

      {/* State-aware primary CTAs */}
      <StateControls
        inspection={inspection}
        pending={pendingState}
        onTransition={applyStateTransition}
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

      {/* Sections + per-item add-finding affordances */}
      <section
        aria-labelledby="inspection-sections-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="inspection-sections-heading"
          className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Sections
        </h2>
        <ul className="space-y-3">
          {inspection.sections.map((section) => (
            <li key={section.key}>
              <SectionGroup
                section={section}
                vocab={inspection.statusVocab}
                isOpenForFindings={isOpenForFindings}
                findings={findingsBySection.get(section.key) ?? []}
                onAddFinding={async (body) => {
                  await inspectionsApi.createFinding(inspection.id, body);
                  await refresh();
                }}
                onPromote={(f) => setPromoteTarget(f)}
              />
            </li>
          ))}
        </ul>
      </section>

      {/* Signature sheet — visible during awaiting_signatures, complete,
          and archived. Becomes read-only after complete. For rack
          templates the sheet may also show pending roles during the
          tail of in_progress (the API auto-bumps state to
          awaiting_signatures after the first signature). */}
      {isAwaitingSignatures || isReadOnly ? (
        <InspectionSignatureSheet
          inspectionId={inspection.id}
          state={inspection.state}
          requiresThreeSignatures={inspection.requiresThreeSignatures}
          templateDisplayName={inspection.templateDisplayName}
          templateVersionNote={`pinned template version`}
          signatures={inspection.signatures}
          onSigned={() => {
            void refresh();
          }}
        />
      ) : null}

      <div className="mt-6 text-xs text-muted-foreground">
        Inspection conduct, findings, and signatures are anchored in the audit chain. The pinned
        template version makes this inspection immutable even if the template is later updated.
      </div>

      <div className="mt-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/inspections')}>
          Done
        </Button>
      </div>

      {promoteTarget ? (
        <InspectionPromoteDialog
          open
          findingId={promoteTarget.id}
          statusVocab={promoteTarget.statusVocab}
          statusValue={promoteTarget.statusValue}
          sectionLabel={promoteTarget.sectionLabel}
          itemLabel={promoteTarget.itemLabel}
          onClose={() => setPromoteTarget(null)}
          onPromoted={() => {
            setPromoteTarget(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// State-aware control row
// ---------------------------------------------------------------------------

function StateControls({
  inspection,
  pending,
  onTransition,
}: {
  inspection: InspectionDetail;
  pending: InspectionConductState | null;
  onTransition: (to: InspectionConductState) => void;
}): JSX.Element | null {
  if (inspection.state === 'scheduled') {
    return (
      <div className="mb-4 rounded-md border border-border bg-card p-4">
        <p className="mb-2 text-sm text-muted-foreground">
          Start the inspection to begin recording findings. The template version is already pinned;
          findings carry section + item snapshots so the inspection stays valid even if the template
          is later updated.
        </p>
        <Button
          type="button"
          size="sm"
          disabled={pending !== null}
          onClick={() => onTransition('in_progress')}
        >
          {pending === 'in_progress' ? 'Starting…' : 'Start inspection'}
        </Button>
      </div>
    );
  }
  if (inspection.state === 'in_progress') {
    const findingCount = inspection.findings.length;
    return (
      <div className="mb-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-foreground">Capture in progress</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {findingCount === 0
                ? 'Add at least one finding before finishing capture.'
                : `${findingCount} finding${findingCount === 1 ? '' : 's'} recorded so far.`}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={pending !== null || findingCount === 0}
            onClick={() => onTransition('awaiting_signatures')}
          >
            {pending === 'awaiting_signatures' ? 'Finishing…' : 'Finish capture'}
          </Button>
        </div>
      </div>
    );
  }
  if (inspection.state === 'complete') {
    return (
      <div className="mb-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Inspection complete. You can archive it once it has been included in a meeting export.
          </p>
          <div className="flex items-center gap-2">
            <ExportPanel inspectionId={inspection.id} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending !== null}
              onClick={() => onTransition('archived')}
            >
              {pending === 'archived' ? 'Archiving…' : 'Archive'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Export panel — visible only when state='complete'. CLAUDE.md #16:
// every export carries step-up + audit. The button click POSTs to
// /api/inspections/exports; on 401 the api wrapper dispatches the
// global step-up modal. On success the panel shows a receipt (export
// id, sha-prefix, byte size, expiry) plus a Download button that opens
// the blob in a new tab with the 5s revoke + noopener,noreferrer dance
// (mirror of the 1.7 evidence reveal sec-F10 close-out).
// ---------------------------------------------------------------------------

function ExportPanel({ inspectionId }: { inspectionId: string }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<CreateExportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startExport(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await inspectionsApi.exports.create({
        kind: 'single',
        inspectionIds: [inspectionId],
      });
      setReceipt(r);
    } catch (e) {
      if (e instanceof InspectionApiError) {
        if (e.status === 401) {
          // Step-up already dispatched by the API wrapper; tell the user.
          setError('Re-authenticate to export. The step-up dialog should be open.');
        } else if (e.status === 429) {
          setError('Export rate limit reached. Try again in an hour.');
        } else {
          setError(`Could not export (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport(): Promise<void> {
    if (!receipt) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await inspectionsApi.exports.download(receipt.exportId);
      const url = URL.createObjectURL(blob);
      // sec-F10 close-out: noopener,noreferrer and revoke the blob URL
      // after 5s. The server-set Content-Disposition: attachment is the
      // primary mechanism; this is the belt-and-suspenders pass.
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      if (e instanceof InspectionApiError && e.status === 401) {
        setError('Re-authenticate to download. The step-up dialog should be open.');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (receipt === null) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={busy}
          onClick={() => {
            void startExport();
          }}
        >
          {busy ? 'Exporting…' : 'Export PDF'}
        </Button>
        {error ? <span className="text-[11px] text-status-rejected">{error}</span> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1 rounded-md border border-border bg-background p-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          Export <span className="font-mono tabular-nums">{receipt.exportId.slice(0, 8)}</span>
        </span>
        <span>·</span>
        <span>
          sha <span className="font-mono tabular-nums">{receipt.outputSha256.slice(0, 12)}</span>
        </span>
        <span>·</span>
        <span>{(receipt.byteSize / 1024).toFixed(1)} KB</span>
        <span>·</span>
        <span>expires {new Date(receipt.expiresAt).toLocaleDateString()}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          void downloadExport();
        }}
      >
        {busy ? 'Opening…' : 'Download PDF'}
      </Button>
      {error ? <span className="text-[11px] text-status-rejected">{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-section collapsible group
// ---------------------------------------------------------------------------

function SectionGroup({
  section,
  vocab,
  isOpenForFindings,
  findings,
  onAddFinding,
  onPromote,
}: {
  section: TemplateSection;
  vocab: InspectionStatusVocabKind;
  isOpenForFindings: boolean;
  findings: ReadonlyArray<InspectionFindingSummary>;
  onAddFinding: (body: CreateFindingBody) => Promise<void>;
  onPromote: (f: InspectionFindingSummary) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="rounded-md border border-border bg-background">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          )}
          <span className="text-sm font-medium text-foreground">{section.label}</span>
          <span className="text-[11px] text-muted-foreground">
            {section.items.length} item{section.items.length === 1 ? '' : 's'}
          </span>
        </div>
        {findings.length > 0 ? (
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {findings.length} finding{findings.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <ul className="space-y-3 border-t border-border px-3 py-3">
          {section.items.map((item) => (
            <li key={item.key}>
              <ItemRow
                section={section}
                item={item}
                vocab={vocab}
                isOpenForFindings={isOpenForFindings}
                findings={findings.filter((f) => f.itemKey === item.key)}
                onAddFinding={onAddFinding}
                onPromote={onPromote}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-item row — item label + helpText + existing findings + add-finding
// inline form.
// ---------------------------------------------------------------------------

function ItemRow({
  section,
  item,
  vocab,
  isOpenForFindings,
  findings,
  onAddFinding,
  onPromote,
}: {
  section: TemplateSection;
  item: TemplateItem;
  vocab: InspectionStatusVocabKind;
  isOpenForFindings: boolean;
  findings: ReadonlyArray<InspectionFindingSummary>;
  onAddFinding: (body: CreateFindingBody) => Promise<void>;
  onPromote: (f: InspectionFindingSummary) => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{item.label}</div>
          {item.helpText ? (
            <div className="mt-0.5 text-xs text-muted-foreground">{item.helpText}</div>
          ) : null}
        </div>
        {isOpenForFindings ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setAdding((a) => !a)}
            aria-expanded={adding}
          >
            <Plus className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            {adding ? 'Cancel' : 'Add finding'}
          </Button>
        ) : null}
      </div>
      {findings.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {findings.map((f) => (
            <li key={f.id}>
              <FindingCard finding={f} onPromote={onPromote} />
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <AddFindingForm
          sectionKey={section.key}
          itemKey={item.key}
          vocab={vocab}
          onCancel={() => setAdding(false)}
          onSubmit={async (body) => {
            await onAddFinding(body);
            setAdding(false);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-finding inline form
// ---------------------------------------------------------------------------

function AddFindingForm({
  sectionKey,
  itemKey,
  vocab,
  onCancel,
  onSubmit,
}: {
  sectionKey: string;
  itemKey: string;
  vocab: InspectionStatusVocabKind;
  onCancel: () => void;
  onSubmit: (body: CreateFindingBody) => Promise<void>;
}): JSX.Element {
  const validValues = statusValuesForVocab(vocab);
  const [statusValue, setStatusValue] = useState<string>(validValues[0] ?? 'A');
  const [observation, setObservation] = useState('');
  const [correctiveAction, setCorrectiveAction] = useState('');
  const [responsibleParty, setResponsibleParty] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    // Local guard — server enforces the same vocab check, but a
    // mid-flight DOM mutation would otherwise let an out-of-vocab value
    // slip through to a 422 with no UX recovery.
    if (!validValues.includes(statusValue)) {
      setError(`Status value ${statusValue} is not valid for vocabulary ${vocab}.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        sectionKey,
        itemKey,
        statusVocab: vocab,
        statusValue,
        ...(observation.trim() ? { observation: observation.trim() } : {}),
        ...(correctiveAction.trim() ? { correctiveAction: correctiveAction.trim() } : {}),
        ...(responsibleParty.trim() ? { responsibleParty: responsibleParty.trim() } : {}),
      });
    } catch (e) {
      if (e instanceof InspectionApiError) {
        setError(`Could not save finding (HTTP ${e.status}).`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-primary/40 bg-primary/5 p-3">
      <div className="mb-2">
        <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Status
        </label>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {validValues.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setStatusValue(v)}
              aria-pressed={statusValue === v}
              className={cn(
                'inline-flex items-center justify-center rounded border px-2 py-0.5 text-xs font-bold uppercase transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                statusValue === v
                  ? 'border-primary bg-primary/20 text-primary'
                  : 'border-border bg-card text-foreground hover:bg-muted',
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <FindingTextInput
        id={`obs-${sectionKey}-${itemKey}`}
        label="Observation"
        value={observation}
        onChange={setObservation}
        rows={3}
        maxLength={8000}
        placeholder="What did you see? Where? Conditions?"
      />
      <FindingTextInput
        id={`cor-${sectionKey}-${itemKey}`}
        label="Corrective action"
        value={correctiveAction}
        onChange={setCorrectiveAction}
        rows={2}
        maxLength={8000}
        placeholder="What needs to happen to resolve this?"
      />
      <FindingTextInput
        id={`resp-${sectionKey}-${itemKey}`}
        label="Responsible party"
        value={responsibleParty}
        onChange={setResponsibleParty}
        rows={1}
        maxLength={200}
        placeholder="Role or name (encrypted on save)"
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
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={submitting} onClick={submit}>
          {submitting ? 'Saving…' : 'Save finding'}
        </Button>
      </div>
    </div>
  );
}

function FindingTextInput({
  id,
  label,
  value,
  onChange,
  rows,
  maxLength,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  maxLength: number;
  placeholder?: string;
}): JSX.Element {
  return (
    <div className="mt-2">
      <label
        htmlFor={id}
        className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finding card — shown in conduct-flow surface AND in
// awaiting_signatures / complete read-only states.
// ---------------------------------------------------------------------------

function FindingCard({
  finding,
  onPromote,
}: {
  finding: InspectionFindingSummary;
  onPromote: (f: InspectionFindingSummary) => void;
}): JSX.Element {
  const isPromotable = inspectionPromotability(finding.statusVocab, finding.statusValue);
  const isPromoted = finding.promotedActionItemId !== null;
  const hasEncryptedText =
    finding.hasObservation || finding.hasCorrectiveAction || finding.hasResponsibleParty;
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-start gap-2">
        <FindingStatusBadge vocab={finding.statusVocab} value={finding.statusValue} />
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {finding.sectionLabel} / {finding.itemLabel}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono tabular-nums">{finding.id.slice(0, 8)}</span>
            <span>·</span>
            <span>{new Date(finding.createdAt).toLocaleString()}</span>
          </div>
        </div>
      </div>
      {hasEncryptedText ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          <span>
            Encrypted ·{' '}
            {[
              finding.hasObservation ? 'observation' : null,
              finding.hasCorrectiveAction ? 'corrective action' : null,
              finding.hasResponsibleParty ? 'responsible party' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
          <Link to={`./findings/${encodeURIComponent(finding.id)}`}>Reveal</Link>
        </Button>
        {isPromoted && finding.promotedActionItemId !== null ? (
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <Link to={`/action-items/${encodeURIComponent(finding.promotedActionItemId)}`}>
              View linked action item
            </Link>
          </Button>
        ) : isPromotable ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onPromote(finding)}
          >
            Promote to action item
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupFindingsBySection(
  findings: ReadonlyArray<InspectionFindingSummary>,
): Map<string, ReadonlyArray<InspectionFindingSummary>> {
  const out = new Map<string, InspectionFindingSummary[]>();
  for (const f of findings) {
    const list = out.get(f.sectionKey);
    if (list) list.push(f);
    else out.set(f.sectionKey, [f]);
  }
  return out;
}
