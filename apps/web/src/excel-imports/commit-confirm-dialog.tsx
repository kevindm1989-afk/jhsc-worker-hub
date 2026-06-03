// CommitConfirmDialog — step-up + final-review surface for the Excel
// import commit step (Milestone 1.11 S3, ADR-0010 §3.10).
//
// Per CLAUDE.md "destructive actions confirm" + rights-protective tone,
// the copy:
//
//   - Names the import (id prefix + filename).
//   - States the totals (N created / M updated / K skipped).
//   - Documents the encryption posture ("each row's description is
//     encrypted on this device before upload").
//   - Documents the chain anchor ("the chain anchors the import to your
//     workplace's signing identity").
//   - States that step-up authentication is required (60-second
//     freshness window).
//   - Disables the Commit button when there are unresolved conflicts —
//     the parent view already enforces this; the dialog never opens with
//     unresolved conflicts, but the button stays disabled defensively.

import { useState } from 'react';
import { Lock, Send, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface CommitConfirmDialogProps {
  readonly open: boolean;
  readonly importId: string;
  readonly sourceFilename: string;
  readonly createCount: number;
  readonly updateCount: number;
  readonly skipCount: number;
  readonly conflictCount: number;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void> | void;
}

export function CommitConfirmDialog({
  open,
  importId,
  sourceFilename,
  createCount,
  updateCount,
  skipCount,
  conflictCount,
  onClose,
  onConfirm,
}: CommitConfirmDialogProps): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const blocked = conflictCount > 0;

  async function handleConfirm(): Promise<void> {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="commit-confirm-title"
      aria-describedby="commit-confirm-desc"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50">
              <ShieldCheck
                className="h-4.5 w-4.5 text-emerald-700"
                strokeWidth={2}
                aria-hidden="true"
              />
            </div>
            <h2
              id="commit-confirm-title"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              Commit this import?
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="mb-3 rounded-md border border-border bg-background p-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>
              import{' '}
              <span className="font-mono tabular-nums text-foreground">{importId.slice(0, 8)}</span>
            </span>
            <span>·</span>
            <span className="font-mono text-foreground">{sourceFilename}</span>
          </div>
        </div>

        <p id="commit-confirm-desc" className="text-sm text-foreground">
          Commit will create <strong>{createCount}</strong> new action item
          {createCount === 1 ? '' : 's'}, update <strong>{updateCount}</strong> existing row
          {updateCount === 1 ? '' : 's'}, and skip <strong>{skipCount}</strong> row
          {skipCount === 1 ? '' : 's'} that already match the app&apos;s data.
        </p>

        <div className="mt-3 rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
          <div className="mb-1 flex items-center gap-1.5 text-foreground">
            <Lock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            <span className="font-medium">Encryption posture</span>
          </div>
          <p>
            Each row&apos;s description, recommended action, raised-by, and follow-up-owner are
            envelope-encrypted on this device before upload. The server stores ciphertext; the
            workplace private key in Fly Secrets is required to decrypt.
          </p>
          <div className="mt-2 mb-1 flex items-center gap-1.5 text-foreground">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            <span className="font-medium">Audit chain</span>
          </div>
          <p>
            The commit emits per-row <span className="font-mono">action_item.created</span> /{' '}
            <span className="font-mono">action_item.updated</span> anchors plus a batch{' '}
            <span className="font-mono">excel_import.committed</span> anchor. Each anchor binds to
            the source file&apos;s SHA-256 and to your workplace&apos;s signing identity.
          </p>
        </div>

        {blocked ? (
          <div
            role="alert"
            className="mt-3 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
          >
            {conflictCount} unresolved conflict{conflictCount === 1 ? '' : 's'}. Resolve every
            conflict row in the preview before commit.
          </div>
        ) : null}

        <p className="mt-3 text-[11px] text-muted-foreground">
          Step-up authentication is required (60-second freshness window).
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || blocked}
            onClick={() => {
              void handleConfirm();
            }}
          >
            <Send className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {busy ? 'Committing…' : 'Commit'}
          </Button>
        </div>
      </div>
    </div>
  );
}
