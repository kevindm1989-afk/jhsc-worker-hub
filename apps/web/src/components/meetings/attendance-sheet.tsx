// Attendance capture sheet (Milestone 2.1 S3, ADR-0012 §3.6).
//
// Bottom-sheet on mobile / dialog on desktop. Captures a single
// attendee at a time. Display name is sealed CLIENT-SIDE under the
// workplace public key before POST per non-negotiable #1 + #4 — the
// server never sees plaintext attendee names; the wire carries only
// the v=0x02 sealed envelope ciphertext + sealed DEK.
//
// Rights-protective copy (non-negotiable #7 + ADR §3.6): no shaming
// of guests, no implications about who "should" be there. The rep
// records who attended. The route enforces structural co-chair
// uniqueness; the UI surfaces the 409 verbatim so the rep can
// correct.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MeetingApiError, meetingsApi } from '@/meetings/api';
import { sealMeetingField, WorkplaceKeyMissingError } from '@/meetings/crypto';
import {
  meetingAttendanceParty,
  meetingAttendanceRole,
  meetingPresentStatus,
  type MeetingAttendanceParty,
  type MeetingAttendanceRole,
  type MeetingPresentStatus,
} from '@jhsc/shared-types';

interface AttendanceSheetProps {
  readonly open: boolean;
  readonly meetingId: string;
  readonly onClose: () => void;
  readonly onCaptured: () => void;
}

/** Map a role to the implied party — the rep can override via the
 * party select but the defaults follow the OHSA s.9 role taxonomy. */
function partyFromRole(role: MeetingAttendanceRole): MeetingAttendanceParty {
  switch (role) {
    case 'worker_co_chair':
    case 'worker_rep':
      return 'union';
    case 'mgmt_co_chair':
    case 'mgmt_rep':
      return 'management';
    case 'guest':
      return 'guest';
  }
}

const ROLE_LABELS: Readonly<Record<MeetingAttendanceRole, string>> = {
  worker_co_chair: 'Worker Co-Chair',
  mgmt_co_chair: 'Management Co-Chair',
  worker_rep: 'Worker Rep',
  mgmt_rep: 'Management Rep',
  guest: 'Guest',
};

const PARTY_LABELS: Readonly<Record<MeetingAttendanceParty, string>> = {
  union: 'Worker side',
  management: 'Management side',
  guest: 'Guest',
};

const PRESENT_LABELS: Readonly<Record<MeetingPresentStatus, string>> = {
  present: 'Present',
  regrets: 'Regrets',
  absent_unexcused: 'Absent',
  late_arrival: 'Late arrival',
  early_departure: 'Early departure',
};

export function AttendanceSheet(props: AttendanceSheetProps): JSX.Element | null {
  const { open, meetingId, onClose, onCaptured } = props;
  const nameId = useId();
  const roleId = useId();
  const partyId = useId();
  const presentId = useId();

  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<MeetingAttendanceRole>('worker_rep');
  const [presentStatus, setPresentStatus] = useState<MeetingPresentStatus>('present');
  const [partyOverride, setPartyOverride] = useState<MeetingAttendanceParty | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const party = useMemo<MeetingAttendanceParty>(
    () => partyOverride ?? partyFromRole(role),
    [partyOverride, role],
  );

  // M2.1 S5 M-4 (F-P4) close-out: Escape closes + focus returns to the
  // previously focused trigger element. The trigger is captured at
  // open-time. Focus return matches the modal-dialog WCAG 2.2 contract.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    // Autofocus the first input for keyboard reps.
    firstFieldRef.current?.focus();
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
    const name = displayName.trim();
    if (name.length === 0) {
      setError('Display name is required.');
      return;
    }
    if (name.length > 200) {
      setError('Display name must be 200 characters or fewer.');
      return;
    }
    setSubmitting(true);
    try {
      const sealed = await sealMeetingField(name);
      await meetingsApi.addAttendee(meetingId, {
        role,
        party,
        presentStatus,
        displayNameCt: sealed.ctB64,
        displayNameDekCt: sealed.dekCtB64,
      });
      // Reset for the next attendee but keep the role selection for
      // bulk adds.
      setDisplayName('');
      onCaptured();
    } catch (e) {
      if (e instanceof WorkplaceKeyMissingError) {
        setError(
          'Workplace key not available yet. Reload the page after first-run setup completes.',
        );
      } else if (e instanceof MeetingApiError) {
        if (e.status === 409) {
          const errBody = e.body as { error?: string } | undefined;
          if (errBody?.error === 'co_chair_already_assigned') {
            setError(
              `A ${ROLE_LABELS[role]} is already on the roster for this meeting. Edit or remove that row to change it.`,
            );
          } else {
            setError('Could not save attendee — a conflicting row already exists.');
          }
        } else if (e.status === 422) {
          const errBody = e.body as { error?: string } | undefined;
          setError(`Could not save attendee (${errBody?.error ?? 'rejected'}).`);
        } else if (e.status === 401) {
          setError('Sign-in expired. Reload the page and try again.');
        } else {
          setError(`Could not save attendee (HTTP ${e.status}).`);
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
      aria-labelledby="attendance-sheet-title"
      data-print="hide"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            <Users
              className="mt-0.5 h-5 w-5 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div>
              <h2
                id="attendance-sheet-title"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                Add attendee
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Names are encrypted before they leave this device. The server never sees the
                plaintext.
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
            <label
              htmlFor={nameId}
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Display name
            </label>
            <input
              id={nameId}
              ref={firstFieldRef}
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={200}
              autoComplete="off"
              placeholder="Name as it appears in the roster"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label
                htmlFor={roleId}
                className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                Role
              </label>
              <select
                id={roleId}
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as MeetingAttendanceRole);
                  setPartyOverride(null);
                }}
                className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
              >
                {meetingAttendanceRole.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor={partyId}
                className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                Party
              </label>
              <select
                id={partyId}
                value={party}
                onChange={(e) => setPartyOverride(e.target.value as MeetingAttendanceParty)}
                className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
              >
                {meetingAttendanceParty.map((p) => (
                  <option key={p} value={p}>
                    {PARTY_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label
              htmlFor={presentId}
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Status
            </label>
            <select
              id={presentId}
              value={presentStatus}
              onChange={(e) => setPresentStatus(e.target.value as MeetingPresentStatus)}
              className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
            >
              {meetingPresentStatus.map((s) => (
                <option key={s} value={s}>
                  {PRESENT_LABELS[s]}
                </option>
              ))}
            </select>
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
            data-testid="attendance-submit"
          >
            {submitting ? 'Encrypting…' : 'Add attendee'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { ROLE_LABELS as ATTENDANCE_ROLE_LABELS };
export { PARTY_LABELS as ATTENDANCE_PARTY_LABELS };
export { PRESENT_LABELS as ATTENDANCE_PRESENT_LABELS };
