// /recommendations/exports — recent signed-bundle exports (Milestone 1.9 S4).
//
// Minimal list surface: one row per export with id-prefix, pdf-sha
// prefix, sig-sha prefix, byte size, expiry, and a Download
// affordance. The receipt panel on /recommendations/:id is the
// primary UX surface; this view is the "where do my exports live?"
// answer (mirror of /inspections/exports).
//
// Same step-up + 5s-revoke + noopener,noreferrer pattern as the
// receipt panel + the 1.7 evidence reveal flow.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, Download, FileSignature } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  RecommendationApiError,
  recommendationsApi,
  type RecommendationExportSummary,
} from '@/recommendations/api';

export function RecommendationsExportsView(): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<RecommendationExportSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    recommendationsApi.exports
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
    try {
      const blob = await recommendationsApi.exports.download(id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      if (e instanceof RecommendationApiError && e.status === 401) {
        setError('Re-authenticate to download. The step-up dialog should be open.');
      } else if (e instanceof RecommendationApiError && e.status === 410) {
        setError('This export has expired (30-day TTL).');
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
        to="/recommendations"
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to recommendations
      </Link>
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Signed recommendation exports
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Recently generated signed bundles. Each bundle is anchored in the audit chain by PDF
          SHA-256 + signature SHA-256 + the signing key id. Bundles age out of storage after 30
          days; the receipt row remains for chain verification.
        </p>
      </header>

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
          <FileSignature
            className="mx-auto mb-2 h-6 w-6 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          No signed bundles yet. Generate one from a submitted, response-received, resolved, or
          withdrawn recommendation.
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
                  recommendation_single
                </div>
                <div className="font-mono text-sm tabular-nums text-foreground">
                  {item.id.slice(0, 8)}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  rec{' '}
                  <span className="font-mono tabular-nums">
                    {item.recommendationId.slice(0, 8)}
                  </span>{' '}
                  · {(item.byteSize / 1024).toFixed(1)} KB · pdf sha{' '}
                  <span className="font-mono tabular-nums">{item.outputSha256.slice(0, 12)}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  sig sha{' '}
                  <span className="font-mono tabular-nums">
                    {item.signatureSha256.slice(0, 12)}
                  </span>
                  {' · '}
                  signing key{' '}
                  <span className="font-mono tabular-nums">{item.signingKeyId.slice(0, 8)}</span>
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
