// /excel-imports/:id — post-commit detail surface (Milestone 1.11 S3).
//
// Renders the import header (id + sourceFilename + sha + status),
// per-item paginated list, the reverse affordance (visible only when
// status='committed' AND committed_at within 30 days), and read-only
// banners for cancelled / reversed states.
//
// CLAUDE.md non-negotiables honored:
//   #2  — every sensitive state (commit / reverse) is anchored in the
//         chain.
//   #7  — rights-protective tone (no anxiety language on reverse).
//   #16 — exports require step-up; reverse is the audit-aware
//         destructive action that mirrors the export step-up pattern.

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  CircleSlash,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Hash,
  Lock,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ExcelImportApiError,
  excelImportsApi,
  type ExcelImportDetail,
  type ExcelImportItem,
  type ExcelImportItemsPage,
  type ReverseResponse,
} from '@/excel-imports/api';
import {
  ImportStatusBadge,
  isWithinReverseWindow,
  REVERSE_WINDOW_DAYS,
  reverseWindowDaysRemaining,
} from '@/excel-imports/components';
import { ReverseConfirmDialog } from '@/excel-imports/reverse-confirm-dialog';
import { NetworkRequiredError } from '@/sync/typed-client';
import { NetworkRequiredBanner } from '@/sync/components/network-required-banner';

export function ExcelImportDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid import id.</div>;
  }
  return <ExcelImportDetailInner key={id} id={id} />;
}

function ExcelImportDetailInner({ id }: { id: string }): JSX.Element {
  const [detail, setDetail] = useState<ExcelImportDetail | null>(null);
  const [items, setItems] = useState<ExcelImportItemsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseResult, setReverseResult] = useState<ReverseResponse | null>(null);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [networkRequired, setNetworkRequired] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [d, i] = await Promise.all([
        excelImportsApi.get(id),
        excelImportsApi.getItems(id, { limit: 200 }),
      ]);
      setDetail(d);
      setItems(i);
    } catch (e) {
      if (e instanceof ExcelImportApiError && e.status === 404) {
        setNotFound(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, i] = await Promise.all([
          excelImportsApi.get(id),
          excelImportsApi.getItems(id, { limit: 200 }),
        ]);
        if (cancelled) return;
        setDetail(d);
        setItems(i);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ExcelImportApiError && e.status === 404) {
          setNotFound(true);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onReverse = useCallback(async (): Promise<void> => {
    setReverseBusy(true);
    setReverseError(null);
    setNetworkRequired(false);
    try {
      const r = await excelImportsApi.reverse(id);
      setReverseResult(r);
      setReverseOpen(false);
      await refresh();
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setNetworkRequired(true);
      } else if (e instanceof ExcelImportApiError) {
        if (e.status === 401) {
          setReverseError(
            'Step-up authentication required. Complete the prompt and tap Reverse again.',
          );
        } else if (e.status === 410) {
          setReverseError('This import is past the 30-day reverse window.');
        } else if (e.status === 429) {
          setReverseError('Reverse rate limit reached (3/hour). Try again in an hour.');
        } else if (e.status === 422) {
          setReverseError('Reverse rejected — the import is not in a reversible state.');
        } else {
          setReverseError(`Could not reverse (HTTP ${e.status}).`);
        }
      } else {
        setReverseError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setReverseBusy(false);
    }
  }, [id, refresh]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <BackLink />
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          That Excel import does not exist.
        </div>
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <BackLink />
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
          {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-muted-foreground">Loading…</div>
    );
  }

  const counts = computeCountsFromItems(items?.items ?? []);
  const inReverseWindow = isWithinReverseWindow(detail.committedAt);

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <BackLink />

      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <FileSpreadsheet
            className="h-4 w-4 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="font-mono text-sm font-semibold text-foreground">
            {detail.id.slice(0, 8)}
          </span>
          <ImportStatusBadge status={detail.status} />
        </div>
        {/* S5 priv-F10 close-out: h1 carries import id + status; the
            source filename was the headline previously, which leaks
            workplace identity in print + screenshots + screen-shares.
            The filename lives as a smaller secondary line below + is
            masked-by-default until the rep explicitly reveals (S5
            sec-F7 / priv-F11). */}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Excel import {detail.id.slice(0, 8)}
        </h1>
        <FilenameRevealLine
          sourceFilename={detail.sourceFilename}
          sourceFilenameMasked={detail.sourceFilenameMasked}
        />
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Hash className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
            <span className="font-mono">{detail.sourceSha256.slice(0, 16)}</span>
          </span>
          <span>·</span>
          <span>
            {detail.rowCount} parsed row{detail.rowCount === 1 ? '' : 's'}
          </span>
          <span>·</span>
          <span>schema {detail.schemaVersion}</span>
          <span>·</span>
          <span>created {new Date(detail.createdAt).toLocaleString()}</span>
          {detail.committedAt ? (
            <>
              <span>·</span>
              <span>committed {new Date(detail.committedAt).toLocaleString()}</span>
            </>
          ) : null}
          {detail.reversedAt ? (
            <>
              <span>·</span>
              <span>reversed {new Date(detail.reversedAt).toLocaleString()}</span>
            </>
          ) : null}
          {detail.cancelledAt ? (
            <>
              <span>·</span>
              <span>cancelled {new Date(detail.cancelledAt).toLocaleString()}</span>
            </>
          ) : null}
        </div>
      </header>

      {detail.status === 'cancelled' ? <CancelledBanner /> : null}
      {detail.status === 'reversed' ? (
        <ReversedBanner reversedAt={detail.reversedAt} result={reverseResult} />
      ) : null}

      {/* Counts grid — committed imports show the per-status rollup. */}
      <section
        aria-labelledby="counts-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="counts-heading"
          className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          <ShieldCheck className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Items
        </h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Cell label="Created" count={counts.created} tone="info" />
          <Cell label="Updated" count={counts.updated} tone="pending" />
          <Cell label="Skipped" count={counts.skipped} tone="neutral" />
          <Cell label="Conflict" count={counts.conflict_pending} tone="rejected" />
        </div>
      </section>

      {/* Reverse panel — visible only on committed status. */}
      {detail.status === 'committed' ? (
        <ReversePanel
          inWindow={inReverseWindow}
          committedAt={detail.committedAt!}
          createdCount={counts.created}
          updatedCount={counts.updated}
          onOpen={() => setReverseOpen(true)}
        />
      ) : null}

      {networkRequired ? (
        <div className="mb-3">
          <NetworkRequiredBanner action="Reverse" onDismiss={() => setNetworkRequired(false)} />
        </div>
      ) : null}

      {reverseError ? (
        <div
          role="alert"
          aria-live="polite"
          className="mb-3 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
        >
          {reverseError}
        </div>
      ) : null}

      {/* Items list — paginated via the API. */}
      <section
        aria-labelledby="items-heading"
        className="mb-4 rounded-md border border-border bg-card p-4"
      >
        <h2
          id="items-heading"
          className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Items ({items?.total ?? 0})
        </h2>
        {items === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items recorded.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.items.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
                <span className="font-mono tabular-nums text-muted-foreground">
                  row {it.sourceRowIndex}
                </span>
                <span className="font-mono uppercase tracking-wide text-muted-foreground">
                  {it.section.replace(/_/g, ' ')}
                </span>
                <ItemStatusChip status={it.status} />
                <span className="font-mono text-[10px] text-muted-foreground">
                  hash {it.contentHash.slice(0, 12)}
                </span>
                {it.actionItemId ? (
                  <Link
                    to={`/action-items/${encodeURIComponent(it.actionItemId)}`}
                    className="ml-auto text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    Open action item{' '}
                    <span className="font-mono tabular-nums">{it.actionItemId.slice(0, 8)}</span>
                  </Link>
                ) : (
                  <span className="ml-auto text-muted-foreground">—</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ReverseConfirmDialog
        open={reverseOpen}
        importId={detail.id}
        // S5 priv-F10 close-out: pass the hash-prefix when the filename
        // is masked. The reverse-confirm dialog is itself a print /
        // screenshot surface; the filename should not appear unless
        // the rep has reveal-cleared (and even then, only if they
        // explicitly opened the reveal-line above).
        sourceFilename={
          detail.sourceFilename ?? `import ${detail.id.slice(0, 8)} (filename hidden)`
        }
        committedAt={detail.committedAt ?? new Date().toISOString()}
        createdCount={counts.created}
        updatedCount={counts.updated}
        onClose={() => setReverseOpen(false)}
        onConfirm={() => onReverse()}
      />

      <div className="mt-3 text-[11px] text-muted-foreground">
        Every commit + reverse anchors in the audit chain. The reverse window is{' '}
        {REVERSE_WINDOW_DAYS} days from commit; past the window the import is permanent + each
        affected action item must be edited individually.
        {reverseBusy ? ' Reversing…' : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Render the source filename on a secondary line below the h1.
 *
 * Three states:
 *   1. The server returned `sourceFilenameMasked: true` (no fresh
 *      step-up) — render a "tap to reveal" affordance + a step-up
 *      dispatch on click.
 *   2. The server returned the decrypted filename — render it INLINE
 *      but hidden-by-default; the rep taps "Show" to expand.
 *   3. The filename is absent (e.g. pending import without a sealed
 *      filename column populated yet) — render nothing.
 *
 * S5 priv-F10 close-out: a print / screenshot / screen-share never
 * captures the filename unless the rep explicitly opened the reveal +
 * cleared step-up. This is the documentary mirror of the 1.7 evidence
 * reveal pattern.
 */
function FilenameRevealLine({
  sourceFilename,
  sourceFilenameMasked,
}: {
  sourceFilename: string | null;
  sourceFilenameMasked: boolean;
}): JSX.Element | null {
  const [revealed, setRevealed] = useState(false);
  if (sourceFilenameMasked) {
    // The server didn't return the plaintext (step-up not fresh).
    // Render the "tap to reveal" affordance; the rep has to dispatch
    // a step-up via the existing modal (the API returns 401 with
    // WWW-Authenticate, which the typed client already routes through
    // stepUpEmitter).
    return (
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        <span>Filename hidden — step-up required to reveal.</span>
      </div>
    );
  }
  if (!sourceFilename) return null;
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
        aria-pressed={revealed}
        aria-label={revealed ? 'Hide source filename' : 'Show source filename'}
      >
        {revealed ? (
          <EyeOff className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Eye className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        )}
        <span>{revealed ? 'Hide filename' : 'Show filename'}</span>
      </button>
      {revealed ? (
        <code className="font-mono text-foreground">{sourceFilename}</code>
      ) : (
        <span className="font-mono italic">workbook.xlsx</span>
      )}
    </div>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link
      to="/excel-imports"
      data-print="hide"
      className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      Back to imports
    </Link>
  );
}

interface CountsByStatus {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly conflict_pending: number;
}

function computeCountsFromItems(items: ReadonlyArray<ExcelImportItem>): CountsByStatus {
  const c = { created: 0, updated: 0, skipped: 0, conflict_pending: 0 };
  for (const it of items) {
    if (it.status === 'created') c.created++;
    else if (it.status === 'updated') c.updated++;
    else if (it.status === 'skipped') c.skipped++;
    else if (it.status === 'conflict_pending') c.conflict_pending++;
  }
  return c;
}

function Cell({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'info' | 'pending' | 'neutral' | 'rejected';
}): JSX.Element {
  const TONE_STYLES: Record<typeof tone, string> = {
    info: 'border-blue-100 bg-blue-50 text-blue-800',
    pending: 'border-amber-100 bg-amber-50 text-amber-900',
    neutral: 'border-border bg-background text-foreground',
    rejected: 'border-red-200 bg-red-50 text-red-800',
  };
  return (
    <div
      className={`flex items-center justify-between rounded border px-3 py-2 text-sm ${TONE_STYLES[tone]}`}
      aria-label={`${count} ${label}`}
    >
      <span className="text-xs uppercase tracking-wide">{label}</span>
      <span className="font-mono text-base font-semibold tabular-nums">{count}</span>
    </div>
  );
}

function ItemStatusChip({ status }: { status: ExcelImportItem['status'] }): JSX.Element {
  const STYLES: Record<ExcelImportItem['status'], { label: string; chip: string }> = {
    created: { label: 'Created', chip: 'border-blue-100 bg-blue-50 text-blue-800' },
    updated: { label: 'Updated', chip: 'border-amber-100 bg-amber-50 text-amber-900' },
    skipped: { label: 'Skipped', chip: 'border-zinc-200 bg-zinc-50 text-zinc-700' },
    conflict_pending: { label: 'Conflict', chip: 'border-red-200 bg-red-50 text-red-800' },
  };
  const s = STYLES[status];
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.chip}`}
      aria-label={`Status: ${s.label}`}
    >
      {s.label}
    </span>
  );
}

function ReversePanel({
  inWindow,
  committedAt,
  createdCount,
  updatedCount,
  onOpen,
}: {
  inWindow: boolean;
  committedAt: string;
  createdCount: number;
  updatedCount: number;
  onOpen: () => void;
}): JSX.Element {
  const daysRemaining = reverseWindowDaysRemaining(committedAt);
  if (!inWindow) {
    return (
      <section
        aria-labelledby="reverse-expired-heading"
        className="mb-4 rounded-md border border-border bg-secondary/30 p-4 text-xs text-muted-foreground"
        title={`Reverse window closed (${REVERSE_WINDOW_DAYS}-day TTL).`}
      >
        <h2
          id="reverse-expired-heading"
          className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          <Undo2 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Reverse window closed
        </h2>
        The 30-day reverse window has expired. Affected action items must be edited individually
        from this point on.
      </section>
    );
  }
  return (
    <section
      aria-labelledby="reverse-panel-heading"
      className="mb-4 rounded-md border border-amber-200 bg-amber-50/40 p-4"
    >
      <h2
        id="reverse-panel-heading"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-amber-900"
      >
        <Undo2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        Reverse this import · {daysRemaining} day{daysRemaining === 1 ? '' : 's'} left
      </h2>
      <p className="text-xs text-amber-900">
        Reversing undoes {createdCount} created action item{createdCount === 1 ? '' : 's'} and
        reverts {updatedCount} update{updatedCount === 1 ? '' : 's'}. Rows edited after the import
        will refuse to reverse (chain-of-custody preservation). The original commit anchor stays in
        the chain; the reverse fires its own anchor.
      </p>
      <div className="mt-2">
        <Button type="button" size="sm" variant="outline" onClick={onOpen}>
          <Undo2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Reverse import
        </Button>
      </div>
    </section>
  );
}

function CancelledBanner(): JSX.Element {
  return (
    <section
      aria-labelledby="cancelled-heading"
      className="mb-4 rounded-md border border-border bg-secondary/30 p-4 text-xs"
    >
      <h2
        id="cancelled-heading"
        className="mb-1 flex items-center gap-1.5 font-medium uppercase tracking-wide text-muted-foreground"
      >
        <CircleSlash className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Cancelled
      </h2>
      <p className="text-muted-foreground">
        This import was cancelled before commit. No action items were created or updated.
      </p>
    </section>
  );
}

function ReversedBanner({
  reversedAt,
  result,
}: {
  reversedAt: string | null;
  result: ReverseResponse | null;
}): JSX.Element {
  return (
    <section
      aria-labelledby="reversed-heading"
      className="mb-4 rounded-md border border-amber-200 bg-amber-50/40 p-4 text-xs"
    >
      <h2
        id="reversed-heading"
        className="mb-1 flex items-center gap-1.5 font-medium uppercase tracking-wide text-amber-900"
      >
        <Undo2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        Reversed{reversedAt ? ` ${new Date(reversedAt).toLocaleString()}` : ''}
      </h2>
      <p className="text-amber-900">
        The commit&apos;s effects were rolled back. The original{' '}
        <span className="font-mono">excel_import.committed</span> anchor stays in the chain; the
        reverse fired its own <span className="font-mono">excel_import.reversed</span> anchor.
        {result ? (
          <>
            {' '}
            Deleted {result.deletedCount}, reverted {result.revertedCount}, refused{' '}
            {result.refusedCount}.
          </>
        ) : null}
      </p>
    </section>
  );
}
