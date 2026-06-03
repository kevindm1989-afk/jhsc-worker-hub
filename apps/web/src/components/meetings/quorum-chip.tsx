// Quorum chip (Milestone 2.1 S3, ADR-0012 §3.6).
//
// Renders the live quorum compliance chip on the meeting top bar.
// Reads from the client-side computeQuorum() helper so the chip is
// available BEFORE adjournment (the server adjourn route computes
// the canonical value into the chain payload). Citations come from
// the function's ruleCitation field (OHSA s.9(8) or CLC s.135.1(8))
// rendered via the existing CitationRef component.
//
// Status semantics per CLAUDE.md:
//   - amber + AlertTriangle  → quorum not met (informational, not
//     blocking — the rep can still record discussion).
//   - green + ShieldCheck    → quorum met.
// Color is always paired with icon + label per "never color alone".

import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { CitationRef } from '@/legal/citation-ref';
import {
  computeQuorum,
  type QuorumAttendanceRow,
  type QuorumJurisdiction,
} from '@/meetings/quorum';

interface QuorumChipProps {
  readonly attendance: ReadonlyArray<QuorumAttendanceRow>;
  readonly jurisdiction: QuorumJurisdiction;
}

export function QuorumChip({ attendance, jurisdiction }: QuorumChipProps): JSX.Element {
  const result = computeQuorum(attendance, jurisdiction);
  const [statute, citation] = result.ruleCitation.split(/\s+/, 2);
  return (
    <div
      // M2.1 S5 M-5 (F-P5) close-out: aria-live="polite" so screen-
      // reader users hear the compliance flip when attendance changes
      // mid-meeting. role="status" pairs with the existing aria-label
      // text so the announcement is the threshold + worker rep count.
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={
        result.compliant
          ? 'inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800'
          : 'inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800'
      }
      aria-label={
        result.compliant
          ? `Quorum met: ${result.details.presentMembers} of ${result.details.thresholdMembers} required, ${result.details.workerRepsPresent} worker reps`
          : `Quorum not yet met: ${result.details.presentMembers} of ${result.details.thresholdMembers} required, ${result.details.workerRepsPresent} worker reps`
      }
    >
      {result.compliant ? (
        <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      )}
      <span>
        Quorum {result.compliant ? 'met' : 'pending'} · {result.details.presentMembers}/
        {result.details.thresholdMembers}
      </span>
      <span className="ml-1">
        {statute && citation ? (
          <CitationRef statute={statute} citation={citation} />
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-wide">
            {result.ruleCitation}
          </span>
        )}
      </span>
    </div>
  );
}
