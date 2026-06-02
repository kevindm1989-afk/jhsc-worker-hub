// /inspections/exports — recent PDF exports (Milestone 1.8 S4).
//
// Minimal list surface: one row per export with id-prefix, kind,
// inspection count, byte size, sha-prefix, expiry, and a Download
// affordance. The receipt panel on /inspections/:id is the primary
// UX surface; this view is the "where do my exports live?" answer.
//
// Same step-up + 5s-revoke pattern as the panel.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InspectionApiError, inspectionsApi, type ExportSummary } from '@/inspections/api';
import { NetworkRequiredError } from '@/sync/typed-client';
import { NetworkRequiredBanner } from '@/sync/components/network-required-banner';

export function InspectionsExportsView(): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<ExportSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [networkRequired, setNetworkRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    inspectionsApi.exports
      .list()
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function download(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    setNetworkRequired(false);
    try {
      const blob = await inspectionsApi.exports.download(id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setNetworkRequired(true);
      } else if (e instanceof InspectionApiError && e.status === 401) {
        setError('Re-authenticate to download. The step-up dialog should be open.');
      } else if (e instanceof InspectionApiError && e.status === 410) {
        setError('This export has expired (30-day TTL).');
      } else if (e instanceof InspectionApiError && e.status === 503) {
        setNetworkRequired(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusyId(null);
    }
  }

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
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Inspection exports
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Recently generated PDF exports. Each export is anchored in the audit chain by document
          SHA-256. Files age out of storage after 30 days; the receipt row remains for verification.
        </p>
      </header>

      {networkRequired ? (
        <div className="mb-4">
          <NetworkRequiredBanner action="Download" onDismiss={() => setNetworkRequired(false)} />
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="mb-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
        >
          {error}
        </div>
      ) : null}

      {items === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          <FileText
            className="mx-auto mb-2 h-6 w-6 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          No exports yet. Generate one from a completed inspection.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card p-3"
            >
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {item.kind}
                </div>
                <div className="font-mono text-sm tabular-nums text-foreground">
                  {item.id.slice(0, 8)}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {item.inspectionCount} inspection{item.inspectionCount === 1 ? '' : 's'} ·{' '}
                  {(item.byteSize / 1024).toFixed(1)} KB · sha{' '}
                  <span className="font-mono tabular-nums">{item.outputSha256.slice(0, 12)}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  requested {new Date(item.requestedAt).toLocaleString()} · expires{' '}
                  {new Date(item.expiresAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyId === item.id}
                onClick={() => {
                  void download(item.id);
                }}
              >
                <Download className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                {busyId === item.id ? 'Opening…' : 'Download'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
