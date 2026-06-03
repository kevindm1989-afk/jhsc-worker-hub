// ReverseConfirmDialog — destructive-action confirm for the 30-day
// reverse-an-import flow (Milestone 1.11 S3, ADR-0010 §3.11, SECURITY
// T-X38..T-X40).
//
// Per CLAUDE.md "destructive actions confirm with explicit consequence
// text" + the rights-protective tone rule, the copy:
//
//   - Names the import (id + filename).
//   - States what will happen ("undo X created action items + revert Y
//     updates").
//   - Notes the partial-success caveat (rows the rep edited after
//     import will refuse to reverse).
//   - Surfaces the 30-day window expiry timestamp so the rep can read
//     it before tapping.
//   - Notes the chain-of-custody preservation (the original commit
//     anchor stays in the chain; the reverse fires its own anchor).
//   - No shame, no anxiety. The reverse is a documented safety valve.

import { useState } from 'react';
import { AlertTriangle, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { reverseWindowDaysRemaining, reverseWindowExpiresAt } from './components';

export interface ReverseConfirmDialogProps {
  readonly open: boolean;
  readonly importId: string;
  readonly sourceFilename: string;
  readonly committedAt: string;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void> | void;
}

export function ReverseConfirmDialog({
  open,
  importId,
  sourceFilename,
  committedAt,
  createdCount,
  updatedCount,
  onClose,
  onConfirm,
}: ReverseConfirmDialogProps): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const daysRemaining = reverseWindowDaysRemaining(committedAt);
  const expiresAt = reverseWindowExpiresAt(committedAt);

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
      aria-labelledby="reverse-confirm-title"
      aria-describedby="reverse-confirm-desc"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50">
              <Undo2 className="h-4.5 w-4.5 text-amber-700" strokeWidth={2} aria-hidden="true" />
            </div>
            <h2
              id="reverse-confirm-title"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              Reverse this import?
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
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>committed {new Date(committedAt).toLocaleString()}</span>
          </div>
        </div>

        <p id="reverse-confirm-desc" className="text-sm text-foreground">
          Reversing will undo <strong>{createdCount}</strong> created action item
          {createdCount === 1 ? '' : 's'} and revert <strong>{updatedCount}</strong> update
          {updatedCount === 1 ? '' : 's'}. Rows edited after the import will refuse to reverse
          (chain-of-custody preservation). The original commit anchor stays in the chain; the
          reverse fires its own <span className="font-mono">excel_import.reversed</span> anchor.
        </p>

        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 p-2 text-xs text-amber-900">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
          <div>
            <div className="font-medium">
              {daysRemaining} day{daysRemaining === 1 ? '' : 's'} left in the reverse window.
            </div>
            <div className="text-[11px] text-amber-800">
              After {new Date(expiresAt).toLocaleString()} the reverse path is closed; the import is
              permanent and the action items must be edited individually.
            </div>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">
          Step-up authentication is required (60-second freshness window). You&apos;ll be prompted
          for your passkey or TOTP code if your session is stale.
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              void handleConfirm();
            }}
          >
            <Undo2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {busy ? 'Reversing…' : 'Reverse import'}
          </Button>
        </div>
      </div>
    </div>
  );
}
