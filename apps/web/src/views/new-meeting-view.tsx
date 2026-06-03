// /meetings/new — Milestone 2.1 S3, ADR-0012 §3.4.
//
// Mobile-primary single-column form. Step-up is REQUIRED at submit per
// ADR §3.10 (creating a meeting is a high-value, chain-anchored
// operation). On 401 step_up_required the API client dispatches the
// global step-up modal; the rep re-taps Submit after the modal closes.
//
// Idempotency-Key + clientId are both client-generated. The server
// uses clientId for replay short-circuit (ADR-0009 §3.3) so a
// re-submit after a network hiccup returns the existing meeting
// envelope at 200 rather than 201 — same shape for the success
// branch.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MeetingApiError, meetingsApi } from '@/meetings/api';
import { stepUpEmitter } from '@/auth/api';

// Default to the agenda template version 1 (S4 seeds it). Future
// multi-version workplaces could surface a picker; the v1 of this
// view ships the version inline.
const DEFAULT_AGENDA_TEMPLATE_VERSION = 1;

interface FormState {
  meetingDate: string;
  location: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
}

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function defaultStart(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.toISOString().slice(0, 16);
}

function defaultEnd(): string {
  const d = new Date();
  d.setHours(d.getHours() + 2, 30, 0, 0);
  return d.toISOString().slice(0, 16);
}

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback v4. Never reached on real browsers; defensive parity with
  // sync/typed-client.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function NewMeetingView(): JSX.Element {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>({
    meetingDate: todayISO(),
    location: '',
    scheduledStartAt: defaultStart(),
    scheduledEndAt: defaultEnd(),
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChange = <K extends keyof FormState>(field: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const submit = async (): Promise<void> => {
    setError(null);
    const date = form.meetingDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('Meeting date must be YYYY-MM-DD.');
      return;
    }
    const start = form.scheduledStartAt;
    const end = form.scheduledEndAt;
    if (!start || !end) {
      setError('Scheduled start and end are required.');
      return;
    }
    const startISO = new Date(start).toISOString();
    const endISO = new Date(end).toISOString();
    if (Date.parse(endISO) <= Date.parse(startISO)) {
      setError('Scheduled end must be after scheduled start.');
      return;
    }

    setSubmitting(true);
    const clientId = newClientId();
    try {
      const r = await meetingsApi.create({
        clientId,
        meetingDate: date,
        location: form.location.trim() || undefined,
        scheduledStartAt: startISO,
        scheduledEndAt: endISO,
        agendaTemplateVersion: DEFAULT_AGENDA_TEMPLATE_VERSION,
      });
      navigate(`/meetings/${encodeURIComponent(r.id)}`);
    } catch (e) {
      if (e instanceof MeetingApiError) {
        if (e.status === 401) {
          const errBody = e.body as { error?: string; action?: string } | undefined;
          if (errBody?.error === 'step_up_required') {
            // The api client already dispatched stepUpEmitter; the
            // global modal opened. Re-prompt the rep to tap submit
            // after stepping up.
            setError(
              'Step-up required to create a meeting. After confirming your identity above, tap Submit again.',
            );
          } else {
            stepUpEmitter.dispatch('meeting.create');
            setError('Sign-in expired. Confirm above and tap Submit again.');
          }
        } else if (e.status === 409) {
          const errBody = e.body as { error?: string } | undefined;
          if (errBody?.error === 'meeting_already_in_progress') {
            setError(
              'A meeting is already in progress. Adjourn that meeting before starting a new one.',
            );
          } else if (errBody?.error === 'client_id_conflict') {
            setError('A different actor created this meeting. Reload the meetings list.');
          } else {
            setError('Could not create the meeting — a conflicting row already exists.');
          }
        } else if (e.status === 422) {
          const errBody = e.body as { error?: string } | undefined;
          setError(`Could not create the meeting (${errBody?.error ?? 'rejected'}).`);
        } else if (e.status === 400) {
          setError('Invalid input. Check the fields and try again.');
        } else {
          setError(`Could not create the meeting (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-6">
      <div className="mb-4" data-print="hide">
        <Link
          to="/minutes"
          className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to Minutes
        </Link>
      </div>

      <header className="mb-4">
        <div className="flex items-start gap-2">
          <CalendarClock
            className="mt-1 h-5 w-5 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
              Start new meeting
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Materializes the v{DEFAULT_AGENDA_TEMPLATE_VERSION} agenda template. Creating a
              meeting records a chain anchor; step-up is required.
            </p>
          </div>
        </div>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <div>
          <label
            htmlFor="meeting-date"
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Meeting date
          </label>
          <input
            id="meeting-date"
            type="date"
            required
            value={form.meetingDate}
            onChange={(e) => onChange('meetingDate', e.target.value)}
            className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="meeting-location"
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Location
          </label>
          <input
            id="meeting-location"
            type="text"
            value={form.location}
            onChange={(e) => onChange('location', e.target.value)}
            maxLength={200}
            placeholder="Boardroom, Teams link, etc."
            className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
          />
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Non-sensitive label; visible to anyone with access to the meeting envelope.
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label
              htmlFor="meeting-start"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Scheduled start
            </label>
            <input
              id="meeting-start"
              type="datetime-local"
              required
              value={form.scheduledStartAt}
              onChange={(e) => onChange('scheduledStartAt', e.target.value)}
              className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
            />
          </div>
          <div>
            <label
              htmlFor="meeting-end"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Scheduled end
            </label>
            <input
              id="meeting-end"
              type="datetime-local"
              required
              value={form.scheduledEndAt}
              onChange={(e) => onChange('scheduledEndAt', e.target.value)}
              className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:h-9 md:text-sm"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span className="font-mono uppercase tracking-wide">
            agenda v{DEFAULT_AGENDA_TEMPLATE_VERSION}
          </span>
          <span>
            The standard JHSC agenda template will be materialized at this version. Future versions
            do not retro-affect this meeting (ADR-0012 §3.3).
          </span>
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

        <div className="hidden items-center justify-end gap-2 md:flex">
          <Button asChild type="button" variant="outline">
            <Link to="/minutes">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting} data-testid="new-meeting-submit">
            {submitting ? 'Creating…' : 'Create meeting'}
          </Button>
        </div>

        {/* Sticky bottom submit on mobile. */}
        <div
          data-print="hide"
          className="fixed inset-x-0 bottom-16 z-40 mx-auto flex max-w-2xl items-center justify-center gap-2 border-t border-border bg-background px-4 py-3 md:hidden"
        >
          <Button asChild type="button" variant="outline" className="h-12 flex-1">
            <Link to="/minutes">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting} className="h-12 flex-1">
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </div>
  );
}
