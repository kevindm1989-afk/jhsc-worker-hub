// ParseErrorCard — surfaced when the schema detector returns
// `{kind: 'unrecognized', reason}` (Milestone 1.11 S3, ADR-0010 §3.3).
//
// The card is rights-protective + actionable per CLAUDE.md "empty states
// do work" — it tells the rep WHAT we found, WHY it didn't match, and
// HOW to fix it (a link to docs/excel-import-format.md). The "Try a
// different file" CTA is the recovery path; the format-spec link is the
// reference path. No shame, no marketing.

import { ExternalLink, FileWarning } from 'lucide-react';
import { UploadDropZone, type UploadRejection } from './upload-drop-zone';

interface ParseErrorCardProps {
  readonly reason: string;
  readonly sourceFilename: string | null;
  readonly onRetry: (file: File) => void;
  readonly onRejected: (rej: UploadRejection) => void;
}

export function ParseErrorCard({
  reason,
  sourceFilename,
  onRetry,
  onRejected,
}: ParseErrorCardProps): JSX.Element {
  return (
    <section
      aria-labelledby="parse-error-heading"
      role="alert"
      aria-live="polite"
      className="rounded-md border border-status-rejected/40 bg-status-rejected/5 p-4"
    >
      <h2
        id="parse-error-heading"
        className="mb-1 flex items-center gap-1.5 text-sm font-medium text-status-rejected"
      >
        <FileWarning className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        We don&apos;t recognize this workbook.
      </h2>
      {sourceFilename ? (
        <p className="text-xs text-muted-foreground">
          File: <span className="font-mono text-foreground">{sourceFilename}</span>
        </p>
      ) : null}
      <p className="mt-2 text-sm text-foreground">
        <span className="text-muted-foreground">Detector said:</span>{' '}
        <span className="font-mono text-xs">{reason}</span>
      </p>
      <div className="mt-3 rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        <p>
          The supported schema is documented as <strong>Meeting Minutes v1</strong>. Required
          sheets: <span className="font-mono">Minutes</span>,{' '}
          <span className="font-mono">NEW BUSINESS</span>,{' '}
          <span className="font-mono">OLD BUSINESS</span>,{' '}
          <span className="font-mono">NOTICE OF RECOMMENDATION</span>,{' '}
          <span className="font-mono">COMPLETED</span>,{' '}
          <span className="font-mono">Closed Items History</span>. Each action-item sheet needs the
          columns:{' '}
          <span className="font-mono">Type · Issue Description · Start Date · Status · Risk</span>{' '}
          (others optional).
        </p>
        <p className="mt-2">
          <a
            href="/docs/excel-import-format.md"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Read the full format spec
            <ExternalLink className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          </a>
        </p>
      </div>

      <div className="mt-3">
        <UploadDropZone compact onFileChosen={onRetry} onRejected={onRejected} />
      </div>
    </section>
  );
}
