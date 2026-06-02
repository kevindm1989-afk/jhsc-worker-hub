// /excel-imports/new — the 3-step upload + preview + commit flow.
//
// This is the centerpiece of Milestone 1.11. Per ADR-0010:
//
//   Step 1 (upload):  drop zone → File reads → sha256 → worker parse.
//                     If detection fails: render ParseErrorCard with the
//                     specific reason + format-spec link.
//   Step 2 (preview): reconciliation summary + PII rollup + per-section
//                     tabs + per-row decisions + conflict diffs.
//                     "Save preview" creates the excel_imports row +
//                     batch-inserts items + transitions to preview.
//   Step 3 (commit):  step-up gated; envelope-encrypts every row's
//                     sensitive fields; POST /api/excel-imports/:id/commit.
//                     On success navigate to the detail view.
//
// CLAUDE.md non-negotiables honored:
//   #1  — no workplace name in copy.
//   #4  — sensitive fields envelope-encrypted before sync.
//   #7  — rights-protective tone throughout.
//   #11 — parsing client-side; file never uploaded raw.
//   #12 — action items are first-class; this view emits action_items
//         via the import route.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, Loader2, Save, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { actionItemsApi, ActionItemsApiError, type ActionItemListItem } from '@/action-items/api';
import {
  ExcelImportApiError,
  excelImportsApi,
  type ExcelImportItemPayload,
} from '@/excel-imports/api';
import {
  b64ToBytes,
  sealActionItemField,
  sealOptionalActionItemField,
  sha256HexOfArrayBuffer,
} from '@/excel-imports/crypto';
import { CommitConfirmDialog } from '@/excel-imports/commit-confirm-dialog';
import { ParseErrorCard } from '@/excel-imports/parse-error-card';
import {
  computePiiRollup,
  ReconciliationSummary,
  type PiiRollup,
} from '@/excel-imports/reconciliation-summary';
import { RowPreviewCard, type RowEdits } from '@/excel-imports/row-preview-card';
import type { FieldResolution } from '@/excel-imports/conflict-diff-row';
import {
  describeUploadRejection,
  UploadDropZone,
  type UploadRejection,
} from '@/excel-imports/upload-drop-zone';
import { NetworkRequiredBanner } from '@/sync/components/network-required-banner';
import { NetworkRequiredError } from '@/sync/typed-client';
import {
  computeContentHash,
  contentHashHex,
  parseWorkbookInWorker,
  reconcile,
  scanForPii,
  type DetectionResult,
  type ExistingActionItemView,
  type ParsedActionItem,
  type ParsedSheets,
  type PiiFlags,
  type ReconcileDecision,
  type ReconciliationPlan,
  type ValidationError,
} from '@jhsc/excel-import';
import { type ActionItemRisk, type ActionItemSection } from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

type Phase = 'upload' | 'parsing' | 'preview' | 'saving_preview' | 'preview_saved' | 'committing';

interface ParsedState {
  readonly file: File;
  readonly arrayBufferByteSize: number;
  readonly sourceSha256: string;
  readonly sheets: ParsedSheets;
}

interface PerRowState {
  readonly localId: string;
  readonly edits: RowEdits;
  readonly skipped: boolean;
  readonly conflictResolutions: Record<string, FieldResolution>;
}

interface WorkplaceKey {
  readonly id: string;
  readonly publicKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// View shell
// ---------------------------------------------------------------------------

export function NewExcelImportView(): JSX.Element {
  return <NewExcelImportInner />;
}

function NewExcelImportInner(): JSX.Element {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('upload');
  const [parseError, setParseError] = useState<{ reason: string; sourceFilename: string } | null>(
    null,
  );
  const [uploadRejection, setUploadRejection] = useState<UploadRejection | null>(null);
  const [parsed, setParsed] = useState<ParsedState | null>(null);
  const [existing, setExisting] = useState<ReadonlyArray<ExistingActionItemView> | null>(null);
  const [plan, setPlan] = useState<ReconciliationPlan | null>(null);
  const [perRow, setPerRow] = useState<Record<string, PerRowState>>({});
  const [piiFlagsByLocalId, setPiiFlagsByLocalId] = useState<Record<string, PiiFlags>>({});
  const [activeSection, setActiveSection] = useState<ActionItemSection>('new_business');
  const [importId, setImportId] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkRequired, setNetworkRequired] = useState(false);
  const [workplaceKey, setWorkplaceKey] = useState<WorkplaceKey | null>(null);
  const sessionFetched = useRef(false);

  // Fetch the workplace public key from /api/auth/session at boot. The
  // 1.7 evidence capture view uses the same pattern (inline session
  // fetch rather than the typed-client). Cached for the rest of the
  // session — the key is stable across the lifetime of the page.
  useEffect(() => {
    if (sessionFetched.current) return;
    sessionFetched.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/session', {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'jhsc-web' },
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          workplaceKey?: { id: string; publicKeyB64: string } | null;
        };
        if (body.workplaceKey) {
          setWorkplaceKey({
            id: body.workplaceKey.id,
            publicKey: b64ToBytes(body.workplaceKey.publicKeyB64),
          });
        }
      } catch {
        // best-effort; the commit step surfaces the missing-key error.
      }
    })();
  }, []);

  // Phase transitions trigger row-state initialization (per parsed row).
  const initialiseRowState = useCallback(
    async (sheets: ParsedSheets, existingPool: ReadonlyArray<ExistingActionItemView>) => {
      const plan = reconcile(sheets, existingPool, crypto.randomUUID());
      setPlan(plan);
      const flags: Record<string, PiiFlags> = {};
      const state: Record<string, PerRowState> = {};
      for (const d of plan.decisions) {
        const row = d.parsed;
        const piiInput = [
          row.description,
          row.recommendedAction ?? '',
          row.raisedBy ?? '',
          row.followUpOwner ?? '',
        ].join('\n');
        flags[row.localId] = scanForPii(piiInput);
        state[row.localId] = {
          localId: row.localId,
          edits: {},
          skipped: false,
          conflictResolutions: Object.fromEntries(
            d.diff.map((f) => [f.field, 'keep_yours' as FieldResolution]),
          ),
        };
      }
      setPiiFlagsByLocalId(flags);
      setPerRow(state);
    },
    [],
  );

  const onFileChosen = useCallback(
    async (file: File) => {
      setError(null);
      setUploadRejection(null);
      setParseError(null);
      setPhase('parsing');
      try {
        const buf = await file.arrayBuffer();
        const sha256 = await sha256HexOfArrayBuffer(buf);
        // Transfer the ArrayBuffer to the worker; the main thread keeps
        // file metadata (name, size) for the preview header.
        // We need to clone before transfer because we already computed
        // SHA-256 on the original; the worker invocation consumes the
        // buffer via `transferable` so we pass a copy.
        const copyForWorker = buf.slice(0);
        const detection: DetectionResult = await parseWorkbookInWorker(copyForWorker);
        if (detection.kind === 'unrecognized') {
          setParseError({ reason: detection.reason, sourceFilename: file.name });
          setPhase('upload');
          return;
        }
        setParsed({
          file,
          arrayBufferByteSize: buf.byteLength,
          sourceSha256: sha256,
          sheets: detection.sheets,
        });
        // Reconciliation needs the existing action_items pool. We fetch
        // the entire list (the 1.6 endpoint paginates server-side; the
        // single-tenant scope makes the full sweep tractable). We
        // compute content_hash client-side for each existing row because
        // the action_items API doesn't yet surface the column.
        let existingPool: ReadonlyArray<ExistingActionItemView>;
        try {
          const r = await actionItemsApi.list();
          existingPool = await buildExistingPool(r.items);
        } catch (e) {
          if (e instanceof ActionItemsApiError && e.status === 401) {
            setError('Sign-in expired. Reload the page and try again.');
            setPhase('upload');
            return;
          }
          // If we can't fetch existing rows, fall back to an empty pool —
          // every row classifies as 'create'. The rep can re-upload after
          // network recovery.
          existingPool = [];
          setError(
            'Could not fetch existing action items. Preview shows every row as new; reconciliation may classify rows as create that should be update.',
          );
        }
        setExisting(existingPool);
        await initialiseRowState(detection.sheets, existingPool);
        setPhase('preview');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('upload');
      }
    },
    [initialiseRowState],
  );

  // ---------------------------------------------------------------------------
  // Preview row interactions
  // ---------------------------------------------------------------------------

  const setRowEdits = useCallback((localId: string, edits: RowEdits) => {
    setPerRow((prev) => {
      const cur = prev[localId];
      if (!cur) return prev;
      return { ...prev, [localId]: { ...cur, edits } };
    });
  }, []);

  const toggleSkip = useCallback((localId: string) => {
    setPerRow((prev) => {
      const cur = prev[localId];
      if (!cur) return prev;
      return { ...prev, [localId]: { ...cur, skipped: !cur.skipped } };
    });
  }, []);

  const setConflictResolution = useCallback(
    (localId: string, field: string, resolution: FieldResolution) => {
      setPerRow((prev) => {
        const cur = prev[localId];
        if (!cur) return prev;
        return {
          ...prev,
          [localId]: {
            ...cur,
            conflictResolutions: { ...cur.conflictResolutions, [field]: resolution },
          },
        };
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Decision computation — folds per-row skip overrides + conflict
  // resolutions into the canonical decision kind used by Save + Commit.
  // ---------------------------------------------------------------------------

  const effectiveDecisions = useMemo(() => {
    if (!plan) return null;
    return plan.decisions.map((d) => {
      const r = perRow[d.parsed.localId];
      if (!r) return d;
      if (r.skipped) return { ...d, decisionKind: 'skip' as const };
      if (d.decisionKind === 'conflict_pending') {
        // If every field resolution is 'keep_yours', the row is
        // effectively a skip (no change to the in-app row). Otherwise
        // it's an 'update' with the rep's chosen per-field values.
        const allKeep = d.diff.every(
          (f) => (r.conflictResolutions[f.field] ?? 'keep_yours') === 'keep_yours',
        );
        return {
          ...d,
          decisionKind: allKeep ? ('skip' as const) : ('update' as const),
        };
      }
      return d;
    });
  }, [plan, perRow]);

  const conflictsRemaining = useMemo(() => {
    if (!effectiveDecisions) return 0;
    return effectiveDecisions.filter((d) => d.decisionKind === 'conflict_pending').length;
  }, [effectiveDecisions]);

  // ---------------------------------------------------------------------------
  // Save preview — POST /api/excel-imports + addItems + transition.
  // ---------------------------------------------------------------------------

  const onSavePreview = useCallback(async () => {
    if (!parsed || !plan || !effectiveDecisions || !workplaceKey) {
      if (!workplaceKey) {
        setError(
          'Workplace key not loaded. Reload the page; the public key ships with /api/auth/session.',
        );
      }
      return;
    }
    setError(null);
    setNetworkRequired(false);
    setPhase('saving_preview');
    try {
      // Step 1: create the pending import row.
      const inspReview = parsed.sheets.inspectionReview
        ? { rows: parsed.sheets.inspectionReview.rows.map((r) => r.slice()) }
        : undefined;
      const created = await excelImportsApi.create({
        sourceFilename: parsed.file.name,
        sourceSha256: parsed.sourceSha256,
        schemaVersion: 'meeting_minutes_v1',
        rowCount: parsed.sheets.rowCount,
        inspectionReviewSnapshot: inspReview,
      });
      // Step 2: build the per-row payload (envelope-encrypts sensitive
      // fields here on the client). The wire shape mirrors the route's
      // zod schema verbatim.
      const items: ExcelImportItemPayload[] = [];
      for (const d of effectiveDecisions) {
        const row = d.parsed;
        const rowState = perRow[row.localId];
        const skipped = rowState?.skipped ?? false;
        const itemStatus: ExcelImportItemPayload['status'] = skipped
          ? 'skipped'
          : d.decisionKind === 'create'
            ? 'created'
            : d.decisionKind === 'update'
              ? 'updated'
              : d.decisionKind === 'conflict_pending'
                ? 'conflict_pending'
                : 'skipped';
        // Skip rows ship a minimal payload — no envelope encrypt cost.
        if (itemStatus === 'skipped') {
          items.push({
            sourceRowIndex: row.sourceRowIndex,
            section: row.section,
            contentHash: row.contentHashHex,
            status: 'skipped',
            clientId: row.localId,
            beforeState: d.existingActionItemId
              ? { existingActionItemId: d.existingActionItemId }
              : undefined,
            actionItemRow: buildPlaceholderActionItemRow(row, rowState),
          });
          continue;
        }
        // Encrypt sensitive fields.
        const desc = await sealActionItemField(
          rowState?.edits.description ?? row.description,
          workplaceKey.publicKey,
        );
        const recAction = await sealOptionalActionItemField(
          row.recommendedAction,
          workplaceKey.publicKey,
        );
        const raisedBy = await sealOptionalActionItemField(row.raisedBy, workplaceKey.publicKey);
        const followUp = await sealOptionalActionItemField(
          row.followUpOwner,
          workplaceKey.publicKey,
        );

        const effectiveRisk = (rowState?.edits.risk ?? row.risk) as ActionItemRisk;
        const effectiveTargetDate =
          rowState?.edits.targetDate !== undefined
            ? (rowState!.edits.targetDate ?? null)
            : row.targetDate;

        const isUpdate = d.decisionKind === 'update';
        const existingRowForUpdate = isUpdate
          ? existing?.find((e) => e.id === d.existingActionItemId)
          : null;

        items.push({
          sourceRowIndex: row.sourceRowIndex,
          section: row.section,
          contentHash: row.contentHashHex,
          status: itemStatus,
          clientId: row.localId,
          beforeState:
            existingRowForUpdate !== null && existingRowForUpdate !== undefined
              ? {
                  priorStatus: existingRowForUpdate.status,
                  priorRisk: existingRowForUpdate.risk,
                  priorTargetDate: existingRowForUpdate.targetDate,
                  priorClosedDate: existingRowForUpdate.closedDate,
                  priorTags: existingRowForUpdate.tags,
                }
              : undefined,
          actionItemRow: {
            type: row.type,
            typeSubtype: row.typeSubtype,
            descriptionCt: desc.ctB64,
            descriptionDekCt: desc.dekCtB64,
            recommendedActionCt: recAction?.ctB64 ?? null,
            recommendedActionDekCt: recAction?.dekCtB64 ?? null,
            raisedByCt: raisedBy?.ctB64 ?? null,
            raisedByDekCt: raisedBy?.dekCtB64 ?? null,
            followUpOwnerCt: followUp?.ctB64 ?? null,
            followUpOwnerDekCt: followUp?.dekCtB64 ?? null,
            department: row.department,
            status: row.status,
            risk: effectiveRisk,
            startDate: row.startDate,
            targetDate: effectiveTargetDate,
            closedDate: row.closedDate,
            tags: row.tags,
            ...(isUpdate && existingRowForUpdate
              ? {
                  actionItemId: existingRowForUpdate.id,
                  ifMatchVersion: existingRowForUpdate.version,
                }
              : {}),
          },
        });
      }
      if (items.length > 0) {
        await excelImportsApi.addItems(created.id, items);
      }
      await excelImportsApi.transitionToPreview(created.id);
      setImportId(created.id);
      setPhase('preview_saved');
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setNetworkRequired(true);
      } else if (e instanceof ExcelImportApiError) {
        setError(`Could not save preview (HTTP ${e.status}).`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setPhase('preview');
    }
  }, [parsed, plan, effectiveDecisions, perRow, workplaceKey, existing]);

  // ---------------------------------------------------------------------------
  // Commit — step-up gated, require-online.
  // ---------------------------------------------------------------------------

  const onCommit = useCallback(async () => {
    if (!importId) return;
    setError(null);
    setNetworkRequired(false);
    setCommitOpen(false);
    setPhase('committing');
    try {
      await excelImportsApi.commit(importId);
      navigate(`/excel-imports/${encodeURIComponent(importId)}`);
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setNetworkRequired(true);
      } else if (e instanceof ExcelImportApiError) {
        if (e.status === 401) {
          // step-up modal already opened; the rep retries after the
          // modal closes. Keep the dialog open-by-tap pattern.
          setError('Step-up authentication required. Complete the prompt, then retry commit.');
        } else if (e.status === 422) {
          const body = e.body as { error?: string; count?: number } | undefined;
          if (body?.error === 'conflicts_unresolved') {
            setError(
              `${body.count ?? 'Some'} unresolved conflict${body.count === 1 ? '' : 's'}. Resolve them in preview and try again.`,
            );
          } else {
            setError(`Commit rejected (${body?.error ?? 'invalid state'}).`);
          }
        } else if (e.status === 429) {
          setError('Commit rate limit reached (5/hour). Try again in an hour.');
        } else {
          setError(`Could not commit (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setPhase('preview_saved');
    }
  }, [importId, navigate]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <Link
        to="/excel-imports"
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to imports
      </Link>

      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          New Excel import
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload your meeting-minutes workbook. Parsing happens on this device; sensitive fields are
          encrypted before they reach the server.
        </p>
      </header>

      {/* Phase indicator — informational, no marketing flourish. */}
      <PhaseIndicator phase={phase} />

      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="my-3 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
        >
          {error}
        </div>
      ) : null}

      {networkRequired ? (
        <div className="my-3">
          <NetworkRequiredBanner action="This action" onDismiss={() => setNetworkRequired(false)} />
        </div>
      ) : null}

      {phase === 'upload' && parseError ? (
        <div className="my-3">
          <ParseErrorCard
            reason={parseError.reason}
            sourceFilename={parseError.sourceFilename}
            onRetry={(file) => {
              void onFileChosen(file);
            }}
            onRejected={(rej) => setUploadRejection(rej)}
          />
        </div>
      ) : null}

      {phase === 'upload' && !parseError ? (
        <div className="my-4">
          <UploadDropZone
            onFileChosen={(file) => {
              void onFileChosen(file);
            }}
            onRejected={(rej) => setUploadRejection(rej)}
          />
          {uploadRejection ? (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                strokeWidth={2}
                aria-hidden="true"
              />
              <span>{describeUploadRejection(uploadRejection)}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === 'parsing' ? (
        <div className="my-6 flex items-center justify-center gap-2 rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
          Parsing workbook on this device…
        </div>
      ) : null}

      {(phase === 'preview' ||
        phase === 'saving_preview' ||
        phase === 'preview_saved' ||
        phase === 'committing') &&
      parsed &&
      plan &&
      effectiveDecisions ? (
        <PreviewSurface
          parsed={parsed}
          plan={plan}
          effectiveDecisions={effectiveDecisions}
          piiFlagsByLocalId={piiFlagsByLocalId}
          piiRollup={computePiiRollup(Object.values(piiFlagsByLocalId))}
          validationErrorCount={parsed.sheets.validationErrors.length}
          validationErrors={parsed.sheets.validationErrors}
          perRow={perRow}
          activeSection={activeSection}
          onSectionChange={setActiveSection}
          onEditChange={setRowEdits}
          onToggleSkip={toggleSkip}
          onConflictResolutionChange={setConflictResolution}
          phase={phase}
          conflictsRemaining={conflictsRemaining}
          onSavePreview={() => {
            void onSavePreview();
          }}
          onOpenCommit={() => setCommitOpen(true)}
          importId={importId}
        />
      ) : null}

      {parsed && importId ? (
        <CommitConfirmDialog
          open={commitOpen}
          importId={importId}
          sourceFilename={parsed.file.name}
          createCount={plan ? plan.summary.createCount : 0}
          updateCount={plan ? plan.summary.updateCount : 0}
          skipCount={plan ? plan.summary.skipCount : 0}
          conflictCount={conflictsRemaining}
          onClose={() => setCommitOpen(false)}
          onConfirm={() => onCommit()}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase indicator
// ---------------------------------------------------------------------------

function PhaseIndicator({ phase }: { phase: Phase }): JSX.Element {
  const steps: Array<{ id: Phase | 'preview_or_saved'; label: string }> = [
    { id: 'upload', label: '1 — Upload' },
    { id: 'preview', label: '2 — Preview' },
    { id: 'committing', label: '3 — Commit' },
  ];
  function activeIndex(): number {
    if (phase === 'upload' || phase === 'parsing') return 0;
    if (phase === 'preview' || phase === 'saving_preview' || phase === 'preview_saved') return 1;
    return 2;
  }
  const idx = activeIndex();
  return (
    <ol className="mb-4 flex flex-wrap items-center gap-2 text-xs" aria-label="Import progress">
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={cn(
            'inline-flex items-center rounded border px-2 py-0.5 font-medium uppercase tracking-wide',
            i < idx
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : i === idx
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground',
          )}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Preview surface
// ---------------------------------------------------------------------------

interface PreviewSurfaceProps {
  readonly parsed: ParsedState;
  readonly plan: ReconciliationPlan;
  readonly effectiveDecisions: ReadonlyArray<ReconcileDecision>;
  readonly piiFlagsByLocalId: Record<string, PiiFlags>;
  readonly piiRollup: PiiRollup;
  readonly validationErrorCount: number;
  readonly validationErrors: ReadonlyArray<ValidationError>;
  readonly perRow: Record<string, PerRowState>;
  readonly activeSection: ActionItemSection;
  readonly onSectionChange: (s: ActionItemSection) => void;
  readonly onEditChange: (localId: string, edits: RowEdits) => void;
  readonly onToggleSkip: (localId: string) => void;
  readonly onConflictResolutionChange: (
    localId: string,
    field: string,
    resolution: FieldResolution,
  ) => void;
  readonly phase: Phase;
  readonly conflictsRemaining: number;
  readonly onSavePreview: () => void;
  readonly onOpenCommit: () => void;
  readonly importId: string | null;
}

const SECTION_TABS: ReadonlyArray<{ id: ActionItemSection; label: string }> = [
  { id: 'new_business', label: 'NEW BUSINESS' },
  { id: 'old_business', label: 'OLD BUSINESS' },
  { id: 'recommendation', label: 'NOTICE OF REC.' },
  { id: 'completed_this_period', label: 'COMPLETED' },
  { id: 'archived', label: 'Closed History' },
];

function PreviewSurface({
  parsed,
  plan,
  effectiveDecisions,
  piiFlagsByLocalId,
  piiRollup,
  validationErrorCount,
  validationErrors,
  perRow,
  activeSection,
  onSectionChange,
  onEditChange,
  onToggleSkip,
  onConflictResolutionChange,
  phase,
  conflictsRemaining,
  onSavePreview,
  onOpenCommit,
  importId,
}: PreviewSurfaceProps): JSX.Element {
  // Group decisions by section for the tabbed render.
  const bySection = useMemo(() => {
    const map = new Map<ActionItemSection, ReconcileDecision[]>();
    for (const d of effectiveDecisions) {
      const arr = map.get(d.parsed.section) ?? [];
      arr.push(d);
      map.set(d.parsed.section, arr);
    }
    return map;
  }, [effectiveDecisions]);

  const decisionsForSection = bySection.get(activeSection) ?? [];

  const saved = phase === 'preview_saved' || phase === 'committing';
  const saving = phase === 'saving_preview';
  const committing = phase === 'committing';

  return (
    <div>
      <section
        aria-labelledby="preview-header"
        className="mb-3 rounded-md border border-border bg-card p-3 text-sm"
      >
        <h2 id="preview-header" className="sr-only">
          Preview header
        </h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{parsed.file.name}</span>
          <span>·</span>
          <span>
            sha <span className="font-mono">{parsed.sourceSha256.slice(0, 12)}</span>
          </span>
          <span>·</span>
          <span>
            {parsed.sheets.rowCount} parsed row{parsed.sheets.rowCount === 1 ? '' : 's'}
          </span>
          {parsed.sheets.metadata.meetingDate ? (
            <>
              <span>·</span>
              <span>meeting {parsed.sheets.metadata.meetingDate}</span>
            </>
          ) : null}
          {importId ? (
            <>
              <span>·</span>
              <span>
                import{' '}
                <span className="font-mono tabular-nums text-foreground">
                  {importId.slice(0, 8)}
                </span>
              </span>
            </>
          ) : null}
        </div>
      </section>

      <div className="mb-3">
        <ReconciliationSummary
          plan={plan}
          piiRollup={piiRollup}
          validationErrorCount={validationErrorCount}
        />
      </div>

      {validationErrorCount > 0 ? <ValidationErrorsList errors={validationErrors} /> : null}

      <SectionTabs
        active={activeSection}
        onChange={onSectionChange}
        decisionsBySection={bySection}
      />

      <ul className="mt-3 space-y-2">
        {decisionsForSection.length === 0 ? (
          <li className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
            No rows in this section.
          </li>
        ) : (
          decisionsForSection.map((d) => (
            <RowPreviewCard
              key={d.parsed.localId}
              decision={d}
              piiFlags={piiFlagsByLocalId[d.parsed.localId] ?? emptyPii()}
              edits={perRow[d.parsed.localId]?.edits ?? {}}
              skipped={perRow[d.parsed.localId]?.skipped ?? false}
              conflictResolutions={perRow[d.parsed.localId]?.conflictResolutions ?? {}}
              onEditChange={(edits) => onEditChange(d.parsed.localId, edits)}
              onToggleSkip={() => onToggleSkip(d.parsed.localId)}
              onConflictResolutionChange={(field, resolution) =>
                onConflictResolutionChange(d.parsed.localId, field, resolution)
              }
            />
          ))
        )}
      </ul>

      {/* Sticky action bar — bottom on mobile, inline on desktop. */}
      <div
        className={cn(
          'sticky bottom-0 left-0 right-0 z-20 mt-4 -mx-4 border-t border-border bg-background/95 p-3 backdrop-blur md:relative md:mx-0 md:rounded-md md:border md:bg-card',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0.75rem)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {saved ? (
              <>
                Preview saved · ready to commit · {plan.summary.createCount} new ·{' '}
                {plan.summary.updateCount} updated
                {conflictsRemaining > 0
                  ? ` · ${conflictsRemaining} conflict${conflictsRemaining === 1 ? '' : 's'} blocking commit`
                  : null}
              </>
            ) : (
              <>
                {plan.summary.createCount} new · {plan.summary.updateCount} updated ·{' '}
                {plan.summary.skipCount} skipped
                {conflictsRemaining > 0
                  ? ` · ${conflictsRemaining} conflict${conflictsRemaining === 1 ? '' : 's'} unresolved`
                  : null}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!saved ? (
              <Button type="button" size="sm" disabled={saving} onClick={onSavePreview}>
                <Save className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                {saving ? 'Saving…' : 'Save preview'}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={committing || conflictsRemaining > 0}
                onClick={onOpenCommit}
              >
                <Send className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                {committing ? 'Committing…' : 'Commit'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section tabs
// ---------------------------------------------------------------------------

function SectionTabs({
  active,
  onChange,
  decisionsBySection,
}: {
  active: ActionItemSection;
  onChange: (s: ActionItemSection) => void;
  decisionsBySection: Map<ActionItemSection, ReconcileDecision[]>;
}): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border pb-2 text-xs"
      role="tablist"
      aria-label="Sections"
    >
      {SECTION_TABS.map((t) => {
        const count = decisionsBySection.get(t.id)?.length ?? 0;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={cn(
              'rounded border px-2 py-0.5 font-mono uppercase tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
              isActive
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:bg-muted',
            )}
          >
            {t.label} <span className="ml-1 tabular-nums">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation errors list — surface row-level parser failures.
// ---------------------------------------------------------------------------

function ValidationErrorsList({ errors }: { errors: ReadonlyArray<ValidationError> }): JSX.Element {
  return (
    <section
      aria-labelledby="validation-errors-heading"
      className="my-3 rounded-md border border-amber-200 bg-amber-50/60 p-3"
    >
      <h2
        id="validation-errors-heading"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-amber-900"
      >
        <AlertTriangle className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        Row-level validation errors ({errors.length})
      </h2>
      <ul className="ml-4 list-disc space-y-0.5 text-xs text-amber-900">
        {errors.slice(0, 25).map((e, i) => (
          <li key={i}>
            <span className="font-mono">{e.sheet}</span> row{' '}
            <span className="tabular-nums">{e.rowIndex}</span>: column{' '}
            <span className="font-mono">{e.column}</span> — {e.reason}
          </li>
        ))}
        {errors.length > 25 ? (
          <li className="italic">
            …and {errors.length - 25} more (preview surfaces the first 25).
          </li>
        ) : null}
      </ul>
      <p className="mt-2 text-[11px] text-amber-800">
        These rows are skipped from the import. Fix the workbook and re-upload if you need them.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the `ExistingActionItemView` projection the reconciler consumes.
 *
 * We don't have content_hash on the existing action_items API response
 * yet (the 1.6 endpoint pre-dates 1.11). For S3 we compute the hash on
 * the client from the existing row's description + start_date — but the
 * existing-row API returns a `summary` (truncated), not the full
 * description. As a result, the client-computed content_hash of an
 * existing row that has > 80 chars description will NOT match the
 * parsed-row hash (the parsed row carries the full text).
 *
 * Documented residual: in S3, reconciliation is correct only for
 * short-description rows. Long-description action_items that should
 * match an incoming row will instead surface as 'create' duplicates.
 * The rep can spot these in the preview + manually skip the duplicate
 * row. S4 / S5 surfaces this as a runbook follow-up: add
 * `contentHashHex` to the action_items list projection so reconciliation
 * is bit-exact regardless of description length.
 */
async function buildExistingPool(
  items: ReadonlyArray<ActionItemListItem>,
): Promise<ReadonlyArray<ExistingActionItemView>> {
  const out: ExistingActionItemView[] = [];
  for (const it of items) {
    try {
      const hash = await computeContentHash(it.summary, it.startDate);
      out.push({
        id: it.id,
        contentHashHex: contentHashHex(hash),
        section: it.section,
        status: it.status,
        risk: it.risk,
        startDate: it.startDate,
        targetDate: it.targetDate,
        closedDate: it.closedDate,
        tags: it.tags,
        // The list projection doesn't carry version; the typed-client's
        // snapshot path will refresh this when the rep saves preview.
        version: 1,
        editedSinceLastImport: false,
      });
    } catch {
      // Empty / invalid date → can't hash; skip the row from the
      // existing pool. The reconciler will treat the parsed row as
      // 'create' which is the safe default.
    }
  }
  return out;
}

/** Build a placeholder actionItemRow for skip-status payloads. The
 * server still requires the shape per its zod schema (every item ships
 * an actionItemRow); the encrypted-text fields go to short placeholder
 * blobs because the skip status means the server never writes them. */
function buildPlaceholderActionItemRow(
  row: ParsedActionItem,
  rowState: PerRowState | undefined,
): ExcelImportItemPayload['actionItemRow'] {
  return {
    type: row.type,
    typeSubtype: row.typeSubtype,
    descriptionCt: 'AA==',
    descriptionDekCt: 'AA==',
    recommendedActionCt: null,
    recommendedActionDekCt: null,
    raisedByCt: null,
    raisedByDekCt: null,
    followUpOwnerCt: null,
    followUpOwnerDekCt: null,
    department: row.department,
    status: row.status,
    risk: (rowState?.edits.risk ?? row.risk) as ActionItemRisk,
    startDate: row.startDate,
    targetDate:
      rowState?.edits.targetDate !== undefined
        ? (rowState.edits.targetDate ?? null)
        : row.targetDate,
    closedDate: row.closedDate,
    tags: row.tags,
  };
}

function emptyPii(): PiiFlags {
  return { nameShape: false, emailShape: false, phoneShape: false, sinShape: false, raw: [] };
}
