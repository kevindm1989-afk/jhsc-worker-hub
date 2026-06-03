// /meetings/:id — Milestone 2.1 S3, ADR-0012 §3.5.
//
// The live meeting surface. Mobile-primary per non-negotiable #9:
// vertical section accordion at 390px; two-pane on ≥768px. Sticky top
// bar with date / location / current section / status pill / quorum
// chip; sticky bottom action bar with Start/End section + Add note +
// Move to next section. Sheets for attendance + section notes; print
// stylesheet expands the accordion so the rep can preview the
// finalization PDF.
//
// Chrome carries `data-print="hide"` per the 1.12 convention; the
// evidentiary metadata (meeting id, chain-anchor count, attendee
// counts) renders via `data-print="evidentiary"` on the foot block.
//
// Action items DO NOT live inside this view (per non-negotiable #12 —
// meetings reference action items; they do not own them). The 2.2
// milestone wires the in-meeting action item management; for 2.1 we
// link back to the action-items list and surface the meeting's
// raised/closed counters.

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronsRight,
  ClipboardCheck,
  ClockArrowUp,
  FileSignature,
  Hourglass,
  Lock,
  MapPin,
  Pause,
  Play,
  ScrollText,
  Square,
  StickyNote,
  UserPlus,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AttendanceSheet, ATTENDANCE_ROLE_LABELS } from '@/components/meetings/attendance-sheet';
import { QuorumChip } from '@/components/meetings/quorum-chip';
import { humaniseSectionType, SectionNotesSheet } from '@/components/meetings/section-notes-sheet';
import {
  MeetingApiError,
  meetingsApi,
  type MeetingAttendee,
  type MeetingDetail,
  type MeetingSection,
} from '@/meetings/api';
import { MEETING_RIGHTS_COPY } from '@/meetings/rights-protective-copy';
import { MEETING_STATUS_LABELS } from './minutes-view';
import type { MeetingPresentStatus, MeetingStatus } from '@jhsc/shared-types';
import type { QuorumJurisdiction } from '@/meetings/quorum';

export function MeetingDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid meeting id.</div>;
  }
  return <MeetingDetailInner key={id} id={id} />;
}

// ---------------------------------------------------------------------------
// Status pill + iconography
// ---------------------------------------------------------------------------

const STATUS_ICONS: Readonly<Record<MeetingStatus, typeof CalendarClock>> = {
  scheduled: CalendarClock,
  in_progress: ClockArrowUp,
  adjourned: Pause,
  pending_finalization: Hourglass,
  finalized: CheckCircle2,
  archived: ScrollText,
};

const STATUS_COLOR: Readonly<Record<MeetingStatus, string>> = {
  scheduled: 'border-blue-300 bg-blue-50 text-blue-800',
  in_progress: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  adjourned: 'border-amber-300 bg-amber-50 text-amber-800',
  pending_finalization: 'border-amber-300 bg-amber-50 text-amber-800',
  finalized: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  archived: 'border-zinc-300 bg-zinc-50 text-zinc-700',
};

const PRESENT_LABELS: Readonly<Record<MeetingPresentStatus, string>> = {
  present: 'Present',
  regrets: 'Regrets',
  absent_unexcused: 'Absent',
  late_arrival: 'Late arrival',
  early_departure: 'Early departure',
};

const PRESENT_COLOR: Readonly<Record<MeetingPresentStatus, string>> = {
  present: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  regrets: 'border-zinc-300 bg-zinc-50 text-zinc-700',
  absent_unexcused: 'border-red-300 bg-red-50 text-red-800',
  late_arrival: 'border-amber-300 bg-amber-50 text-amber-800',
  early_departure: 'border-amber-300 bg-amber-50 text-amber-800',
};

// Jurisdiction comes from window-level config in S5; the workplace
// config isn't directly importable client-side in 2.1 since
// config/workplace.ts is server-runtime. We default to 'ON' and read
// an optional override from a global meta tag that the app shell may
// inject. Documented gap; the chain payload (server-computed) is
// authoritative.
function readJurisdiction(): QuorumJurisdiction {
  if (typeof document === 'undefined') return 'ON';
  const meta = document.querySelector('meta[name="jhsc-jurisdiction"]');
  const value = meta?.getAttribute('content');
  if (value === 'CA-FED') return 'CA-FED';
  return 'ON';
}

// ---------------------------------------------------------------------------
// Inner component
// ---------------------------------------------------------------------------

interface InnerProps {
  readonly id: string;
}

function MeetingDetailInner({ id }: InnerProps): JSX.Element {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [expandedSectionId, setExpandedSectionId] = useState<string | null>(null);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [notesSection, setNotesSection] = useState<MeetingSection | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<MeetingDetail | null> => {
    try {
      const fresh = await meetingsApi.get(id);
      setDetail(fresh);
      return fresh;
    } catch (e) {
      if (e instanceof MeetingApiError && e.status === 404) {
        setNotFound(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      return null;
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    meetingsApi
      .get(id)
      .then((fresh) => {
        if (cancelled) return;
        setDetail(fresh);
        if (fresh.currentSectionId) setExpandedSectionId(fresh.currentSectionId);
        else if (fresh.sections.length > 0) setExpandedSectionId(fresh.sections[0]!.id);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof MeetingApiError && e.status === 404) {
          setNotFound(true);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const jurisdiction = readJurisdiction();

  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-muted-foreground">
        Meeting not found.{' '}
        <Link to="/minutes" className="text-primary underline">
          Back to Minutes
        </Link>
        .
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
          {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="h-32 animate-pulse rounded-md border border-border bg-muted/40" />
      </div>
    );
  }

  const StatusIcon = STATUS_ICONS[detail.status];
  const currentSection = detail.sections.find((s) => s.id === detail.currentSectionId) ?? null;

  const startMeeting = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await meetingsApi.start(detail.id, detail.version);
      await refresh();
    } catch (e) {
      setActionError(formatError(e, 'start meeting'));
    } finally {
      setBusy(false);
    }
  };

  const startSection = async (sectionId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await meetingsApi.startSection(detail.id, sectionId);
      await refresh();
    } catch (e) {
      setActionError(formatError(e, 'start section'));
    } finally {
      setBusy(false);
    }
  };

  const endSection = async (sectionId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await meetingsApi.endSection(detail.id, sectionId);
      await refresh();
    } catch (e) {
      setActionError(formatError(e, 'end section'));
    } finally {
      setBusy(false);
    }
  };

  const nextSection = async (): Promise<void> => {
    if (!currentSection) return;
    const nextIdx = currentSection.orderIdx + 1;
    const next = detail.sections.find((s) => s.orderIdx === nextIdx);
    if (!next) return;
    if (!currentSection.endedAt) {
      await endSection(currentSection.id);
    }
    await startSection(next.id);
    setExpandedSectionId(next.id);
  };

  const banner =
    detail.status === 'scheduled'
      ? MEETING_RIGHTS_COPY.scheduledBanner
      : detail.status === 'in_progress'
        ? MEETING_RIGHTS_COPY.inProgressBanner
        : detail.status === 'adjourned' || detail.status === 'pending_finalization'
          ? MEETING_RIGHTS_COPY.adjournmentBanner
          : null;

  return (
    <div className="mx-auto max-w-5xl pb-32 md:pb-6">
      {/* Top sticky bar */}
      <div
        data-print="hide"
        className="sticky top-0 z-30 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6"
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <Link
            to="/minutes"
            className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Minutes
          </Link>
          <StatusPill status={detail.status} Icon={StatusIcon} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono text-sm font-semibold text-foreground">
            {detail.meetingDate}
          </span>
          <span className="hidden md:inline">·</span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {detail.location ?? 'Location TBD'}
          </span>
          {currentSection ? (
            <>
              <span>·</span>
              <span>
                Section:{' '}
                <strong className="text-foreground">
                  {humaniseSectionType(currentSection.sectionType)}
                </strong>
              </span>
            </>
          ) : null}
          <span className="ml-auto">
            <QuorumChip
              attendance={detail.attendance.map((a) => ({
                role: a.role,
                presentStatus: a.presentStatus,
              }))}
              jurisdiction={jurisdiction}
            />
          </span>
        </div>
      </div>

      {banner ? (
        <div
          className="mx-4 mt-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-900 md:mx-6"
          data-print="evidentiary"
        >
          {banner}
        </div>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          aria-live="polite"
          data-print="hide"
          className="mx-4 mt-2 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected md:mx-6"
        >
          {actionError}
        </div>
      ) : null}

      {/* Body: section accordion + attendance summary */}
      <div className="grid grid-cols-1 gap-4 px-4 py-4 md:grid-cols-3 md:px-6 md:py-6">
        <div className="md:col-span-2">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Sections
          </h2>
          <ul className="space-y-2">
            {detail.sections.map((s) => (
              <li key={s.id}>
                <SectionAccordion
                  section={s}
                  expanded={expandedSectionId === s.id}
                  onToggle={() => setExpandedSectionId((prev) => (prev === s.id ? null : s.id))}
                  onStart={() => void startSection(s.id)}
                  onEnd={() => void endSection(s.id)}
                  onEditNotes={() => setNotesSection(s)}
                  status={detail.status}
                  attendance={detail.attendance}
                  jurisdiction={jurisdiction}
                  meetingId={detail.id}
                />
              </li>
            ))}
          </ul>
        </div>

        <aside className="space-y-3">
          <div className="rounded-md border border-border bg-card p-3" data-print="card">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                Attendance
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAttendanceOpen(true)}
                data-print="hide"
                disabled={detail.status === 'finalized' || detail.status === 'archived'}
              >
                <UserPlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Add
              </Button>
            </div>
            {detail.attendance.length === 0 ? (
              <div className="text-xs text-muted-foreground">No attendees recorded yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {detail.attendance.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Users className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                      {ATTENDANCE_ROLE_LABELS[a.role]}
                    </span>
                    <PresentBadge status={a.presentStatus} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-md border border-border bg-card p-3" data-print="card">
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Lifecycle
            </h3>
            <dl className="space-y-1.5 text-xs">
              <DRow label="Status" value={MEETING_STATUS_LABELS[detail.status]} />
              <DRow label="Agenda" value={`v${detail.agendaTemplateVersion}`} />
              <DRow label="Scheduled" value={new Date(detail.scheduledStartAt).toLocaleString()} />
              {detail.actualStartAt ? (
                <DRow label="Started" value={new Date(detail.actualStartAt).toLocaleString()} />
              ) : null}
              {detail.actualEndAt ? (
                <DRow label="Adjourned" value={new Date(detail.actualEndAt).toLocaleString()} />
              ) : null}
              <DRow label="Signatures" value={`${detail.signatures.length} / 4`} />
            </dl>
            <div className="mt-3 flex flex-col gap-1.5" data-print="hide">
              {detail.status === 'scheduled' ? (
                <Button size="sm" onClick={() => void startMeeting()} disabled={busy}>
                  <Play className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  Start meeting
                </Button>
              ) : null}
              {detail.status === 'in_progress' ? (
                <Button asChild size="sm">
                  <Link to={`/meetings/${encodeURIComponent(detail.id)}/adjourn`}>
                    <Pause className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                    Adjourn
                  </Link>
                </Button>
              ) : null}
              {detail.status === 'adjourned' || detail.status === 'pending_finalization' ? (
                <Button asChild size="sm">
                  <Link to={`/meetings/${encodeURIComponent(detail.id)}/finalize`}>
                    <FileSignature className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                    Record signatures
                  </Link>
                </Button>
              ) : null}
              {detail.status === 'finalized' ? (
                <div className="inline-flex items-center gap-1 text-xs text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  Finalized
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card p-3" data-print="card">
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Action items
            </h3>
            <p className="text-xs text-muted-foreground">
              Action items live in the dedicated tab. They are not owned by this meeting — meetings
              reference them.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link to={`/action-items?meetingId=${encodeURIComponent(detail.id)}`}>
                <ClipboardCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Open action items
              </Link>
            </Button>
          </div>
        </aside>
      </div>

      {/* Evidentiary footer (visible only on print). */}
      <div className="mx-4 mt-6 hidden text-xs md:mx-6 print:block" data-print="evidentiary">
        <div>Meeting ID: {detail.id}</div>
        <div>Agenda template version: {detail.agendaTemplateVersion}</div>
        <div>Sections: {detail.sections.length}</div>
        <div>Attendance rows: {detail.attendance.length}</div>
        <div>Signatures recorded: {detail.signatures.length}</div>
        <div>Server row version: {detail.version}</div>
      </div>

      {/* Sticky bottom action bar (mobile + when in_progress). */}
      {detail.status === 'in_progress' && currentSection ? (
        <div
          data-print="hide"
          className="fixed inset-x-0 bottom-16 z-40 mx-auto flex max-w-5xl items-center justify-between gap-2 border-t border-border bg-background px-3 py-2 md:hidden"
        >
          {currentSection.endedAt ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void startSection(currentSection.id)}
              disabled={busy}
              className="h-12 flex-1"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Restart
            </Button>
          ) : currentSection.startedAt ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void endSection(currentSection.id)}
              disabled={busy}
              className="h-12 flex-1"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              End
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void startSection(currentSection.id)}
              disabled={busy}
              className="h-12 flex-1"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Start
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNotesSection(currentSection)}
            className="h-12 flex-1"
          >
            <StickyNote className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Notes
          </Button>
          <Button
            size="sm"
            onClick={() => void nextSection()}
            disabled={busy}
            className="h-12 flex-1"
          >
            <ChevronsRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Next
          </Button>
        </div>
      ) : null}

      <AttendanceSheet
        open={attendanceOpen}
        meetingId={detail.id}
        onClose={() => setAttendanceOpen(false)}
        onCaptured={() => {
          setAttendanceOpen(false);
          void refresh();
        }}
      />

      {notesSection ? (
        <SectionNotesSheet
          open={notesSection !== null}
          meetingId={detail.id}
          sectionId={notesSection.id}
          sectionType={notesSection.sectionType}
          onClose={() => setNotesSection(null)}
          onSaved={() => {
            setNotesSection(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function StatusPill({
  status,
  Icon,
}: {
  status: MeetingStatus;
  Icon: typeof CalendarClock;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        STATUS_COLOR[status],
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
      {MEETING_STATUS_LABELS[status]}
    </span>
  );
}

function PresentBadge({ status }: { status: MeetingPresentStatus }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        PRESENT_COLOR[status],
      )}
    >
      {PRESENT_LABELS[status]}
    </span>
  );
}

function DRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section accordion row
// ---------------------------------------------------------------------------

interface SectionAccordionProps {
  readonly section: MeetingSection;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onStart: () => void;
  readonly onEnd: () => void;
  readonly onEditNotes: () => void;
  readonly status: MeetingStatus;
  readonly attendance: ReadonlyArray<MeetingAttendee>;
  readonly jurisdiction: QuorumJurisdiction;
  readonly meetingId: string;
}

function SectionAccordion(props: SectionAccordionProps): JSX.Element {
  const {
    section,
    expanded,
    onToggle,
    onStart,
    onEnd,
    onEditNotes,
    status,
    attendance,
    jurisdiction,
  } = props;
  const isMutable = status === 'scheduled' || status === 'in_progress' || status === 'adjourned';
  const isCoChairOnly = section.visibility === 'co_chair_only';

  return (
    <div
      className={cn('rounded-md border bg-card', expanded ? 'border-primary/40' : 'border-border')}
      data-print="card"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 px-3 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {section.orderIdx + 1}. {humaniseSectionType(section.sectionType)}
            </span>
            {isCoChairOnly ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-700"
                title="Co-chair only deliberation (locked in 2.1; lands in 2.5+)"
              >
                <Lock className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                Co-chair only
              </span>
            ) : null}
            {section.startedAt && !section.endedAt ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                <ClockArrowUp className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                Running
              </span>
            ) : null}
            {section.endedAt ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-700">
                <CheckCircle2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                Done
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {section.startedAt ? (
              <span>started {new Date(section.startedAt).toLocaleTimeString()}</span>
            ) : (
              <span>not started</span>
            )}
            {section.endedAt ? (
              <span> · ended {new Date(section.endedAt).toLocaleTimeString()}</span>
            ) : null}
            {section.notesEnvelopeCt ? <span> · notes saved</span> : null}
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border px-3 py-3">
          {section.sectionType === 'roll_call_quorum' ? (
            <div className="mb-3">
              <QuorumChip
                attendance={attendance.map((a) => ({
                  role: a.role,
                  presentStatus: a.presentStatus,
                }))}
                jurisdiction={jurisdiction}
              />
            </div>
          ) : null}

          {isCoChairOnly ? (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
              In-camera notes for co-chair-only sections land in a future milestone (TM-fold-2
              forward seam). This section is read-only in 2.1.
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {section.notesEnvelopeCt
                ? 'Notes are encrypted at rest. Open the notes sheet to revise.'
                : 'No notes captured for this section yet.'}
            </div>
          )}

          {isMutable && !isCoChairOnly ? (
            <div className="mt-3 flex flex-wrap gap-2" data-print="hide">
              {!section.startedAt ? (
                <Button size="sm" variant="outline" onClick={onStart}>
                  <Play className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  Start section
                </Button>
              ) : !section.endedAt ? (
                <Button size="sm" variant="outline" onClick={onEnd}>
                  <Square className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  End section
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={onEditNotes}>
                <StickyNote className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                {section.notesEnvelopeCt ? 'Edit notes' : 'Add notes'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatError(e: unknown, verb: string): string {
  if (e instanceof MeetingApiError) {
    if (e.status === 401) return `Sign-in expired; could not ${verb}.`;
    if (e.status === 409) return `Could not ${verb} — version conflict; reload the meeting.`;
    if (e.status === 422) {
      const errBody = e.body as { error?: string } | undefined;
      return `Could not ${verb} (${errBody?.error ?? 'rejected'}).`;
    }
    return `Could not ${verb} (HTTP ${e.status}).`;
  }
  return e instanceof Error ? e.message : String(e);
}
