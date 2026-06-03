// Section notes sheet (Milestone 2.1 S3, ADR-0012 §3.7).
//
// Rights-protective copy (CLAUDE.md non-negotiable #7): there is NO
// "are you sure this is appropriate to record?" framing. The rep
// records what was discussed; the chain anchors the hash; the PDF
// renders the prose at finalization. Discouraging language would
// chill the recording of deliberation in the rep's own minutes —
// out of scope.
//
// The note prose is sealed CLIENT-SIDE under the workplace public key
// before POST per non-negotiable #4. The server stores ciphertext
// only and the chain payload carries `notesHash = sha256(ct)` per
// T-ML9 mitigation (apps/api/src/routes/meetings/index.ts §POST
// /sections/:sid/notes). The full plaintext NEVER crosses the wire.

import { useEffect, useId, useRef, useState } from 'react';
import { ScrollText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MeetingApiError, meetingsApi } from '@/meetings/api';
import { sealMeetingField, WorkplaceKeyMissingError } from '@/meetings/crypto';
import type { MeetingSectionType } from '@jhsc/shared-types';

interface SectionNotesSheetProps {
  readonly open: boolean;
  readonly meetingId: string;
  readonly sectionId: string;
  readonly sectionType: MeetingSectionType;
  /** Optional pre-fill — used when editing an existing note. The
   * server route REPLACES the section's envelope on each POST per
   * ADR §3.7; the rep edits the section's notes as a single field. */
  readonly initialPlaintext?: string;
  readonly onClose: () => void;
  readonly onSaved: (notesHash: string) => void;
}

export function SectionNotesSheet(props: SectionNotesSheetProps): JSX.Element | null {
  const { open, meetingId, sectionId, sectionType, initialPlaintext, onClose, onSaved } = props;
  const notesId = useId();
  const [notes, setNotes] = useState(initialPlaintext ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // M2.1 S5 M-4 (F-P4) close-out: Escape closes + focus returns to
  // the previously focused trigger.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    setError(null);
    const value = notes.trim();
    if (value.length === 0) {
      setError('Notes are empty — type something to save.');
      return;
    }
    if (value.length > 32_000) {
      setError('Notes must be 32,000 characters or fewer per save.');
      return;
    }
    setSubmitting(true);
    try {
      const sealed = await sealMeetingField(value);
      const result = await meetingsApi.writeSectionNotes(meetingId, sectionId, {
        notesEnvelopeCt: sealed.ctB64,
        notesEnvelopeDekCt: sealed.dekCtB64,
      });
      onSaved(result.notesHash);
    } catch (e) {
      if (e instanceof WorkplaceKeyMissingError) {
        setError(
          'Workplace key not available yet. Reload the page after first-run setup completes.',
        );
      } else if (e instanceof MeetingApiError) {
        if (e.status === 404) {
          setError('This section no longer exists. Reload the meeting view.');
        } else if (e.status === 401) {
          setError('Sign-in expired. Reload the page and try again.');
        } else {
          setError(`Could not save notes (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-notes-sheet-title"
      data-print="hide"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            <ScrollText
              className="mt-0.5 h-5 w-5 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div>
              <h2
                id="section-notes-sheet-title"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                Section notes — {humaniseSectionType(sectionType)}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Encrypted on this device before send. Saving replaces the section&rsquo;s notes.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor={notesId} className="sr-only">
              Section notes
            </label>
            <textarea
              id={notesId}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={32_000}
              rows={10}
              autoFocus
              placeholder="What was discussed in this section."
              className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-base leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
            />
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {notes.length} / 32,000 · Encrypted before upload.
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              aria-live="polite"
              className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
            >
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            data-testid="section-notes-submit"
          >
            {submitting ? 'Encrypting…' : 'Save notes'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function humaniseSectionType(t: MeetingSectionType): string {
  switch (t) {
    case 'call_to_order':
      return 'Call to order';
    case 'roll_call_quorum':
      return 'Roll call / quorum';
    case 'minutes_review':
      return 'Minutes review';
    case 'old_business':
      return 'Old business';
    case 'new_business':
      return 'New business';
    case 'inspections_review':
      return 'Inspections review';
    case 'incident_review':
      return 'Incident review';
    case 'complaints_review':
      return 'Complaints review';
    case 'recommendations':
      return 'Recommendations';
    case 'other_business':
      return 'Other business';
    case 'next_meeting':
      return 'Next meeting';
    case 'adjournment':
      return 'Adjournment';
  }
}
