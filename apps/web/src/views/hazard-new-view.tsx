// /hazards/new — mobile-first single-column intake form.
//
// Sticky bottom submit button on mobile (CLAUDE.md "sticky bottom primary
// action"); inline on desktop. Form errors announced via aria-live; field
// labels are explicit and pointer-target-sized for thumb tap.
//
// Sensitive fields (description, reporter identity, location detail) are
// posted to /api/hazards in cleartext over HTTPS; the API seals them with
// the workplace KEK before writing. Server is the encryption boundary --
// the browser does NOT hold the KEK in 1.5.

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HazardsApiError, hazardsApi } from '@/hazards/api';
import { SEVERITY_LABELS } from '@/hazards/components';
import {
  hazardJurisdiction,
  hazardSeverity,
  type HazardJurisdiction,
  type HazardSeverity,
} from '@jhsc/shared-types';

interface FormState {
  title: string;
  description: string;
  severity: HazardSeverity;
  jurisdiction: HazardJurisdiction;
  locationZone: string;
  locationDetail: string;
  reporterIdentity: string;
  anonymous: boolean;
}

const INITIAL: FormState = {
  title: '',
  description: '',
  severity: 'medium',
  jurisdiction: 'ON',
  locationZone: '',
  locationDetail: '',
  reporterIdentity: '',
  anonymous: false,
};

interface FormErrors {
  title?: string;
  description?: string;
  reporterIdentity?: string;
  submit?: string;
}

export function HazardNewView(): JSX.Element {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (form.title.trim().length === 0) next.title = 'Required';
    else if (form.title.length > 120) next.title = '120 characters max';
    if (form.description.trim().length === 0) next.description = 'Required';
    else if (form.description.length > 8000) next.description = '8000 characters max';
    if (!form.anonymous && form.reporterIdentity.length > 200) {
      next.reporterIdentity = '200 characters max';
    }
    return next;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setSubmitting(true);
    try {
      const created = await hazardsApi.create({
        title: form.title.trim(),
        description: form.description.trim(),
        severity: form.severity,
        jurisdiction: form.jurisdiction,
        locationZone: form.locationZone.trim() || undefined,
        locationDetail: form.locationDetail.trim() || undefined,
        reporterIdentity: form.anonymous ? undefined : form.reporterIdentity.trim() || undefined,
      });
      navigate(`/hazards/${encodeURIComponent(created.id)}`);
    } catch (e) {
      if (e instanceof HazardsApiError) {
        if (e.status === 401) {
          setErrors({ submit: 'Sign in expired. Reload the page and try again.' });
        } else if (e.status === 400) {
          setErrors({ submit: 'The server rejected the form. Check the field rules and retry.' });
        } else {
          setErrors({ submit: `Could not save (HTTP ${e.status}).` });
        }
      } else {
        setErrors({ submit: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-2xl px-4 py-4 md:px-6 md:py-6" noValidate>
      <header className="mb-4 md:mb-6">
        <Link
          to="/hazards"
          className="mb-2 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to hazards
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Log a hazard
        </h1>
        <p className="mt-1 flex items-start gap-1 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>
            Description, reporter identity, and location detail travel to the server over HTTPS, and
            are encrypted at rest with a key held by the workplace before they are written to the
            database.
          </span>
        </p>
      </header>

      <div className="space-y-4 pb-24 md:pb-0">
        <Field id="title" label="Title" required error={errors.title} hint="≤120 chars, no PI">
          <input
            id="title"
            type="text"
            value={form.title}
            maxLength={120}
            onChange={(e) => update('title', e.target.value)}
            className={fieldInputClass(!!errors.title)}
            aria-invalid={!!errors.title}
            placeholder="Slip hazard — cooler floor"
          />
        </Field>

        <Field
          id="description"
          label="Description"
          required
          error={errors.description}
          hint="What is the condition? Who's affected? What's the immediate risk?"
        >
          <textarea
            id="description"
            value={form.description}
            maxLength={8000}
            rows={6}
            onChange={(e) => update('description', e.target.value)}
            className={cn(fieldInputClass(!!errors.description), 'resize-y leading-relaxed')}
            aria-invalid={!!errors.description}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="severity" label="Severity" required>
            <select
              id="severity"
              value={form.severity}
              onChange={(e) => update('severity', e.target.value as HazardSeverity)}
              className={fieldInputClass(false)}
            >
              {hazardSeverity.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field id="jurisdiction" label="Jurisdiction" required>
            <select
              id="jurisdiction"
              value={form.jurisdiction}
              onChange={(e) => update('jurisdiction', e.target.value as HazardJurisdiction)}
              className={fieldInputClass(false)}
            >
              {hazardJurisdiction.map((j) => (
                <option key={j} value={j}>
                  {j === 'ON' ? 'Ontario (OHSA)' : 'Canada (CLC Part II)'}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="locationZone" label="Zone" hint="e.g. zone_3">
            <input
              id="locationZone"
              type="text"
              value={form.locationZone}
              maxLength={64}
              onChange={(e) => update('locationZone', e.target.value)}
              className={fieldInputClass(false)}
              placeholder="zone_3"
            />
          </Field>
          <Field id="locationDetail" label="Location detail" hint="Optional, encrypted on save">
            <input
              id="locationDetail"
              type="text"
              value={form.locationDetail}
              maxLength={2000}
              onChange={(e) => update('locationDetail', e.target.value)}
              className={fieldInputClass(false)}
              placeholder="South of bay 3, under the conveyor"
            />
          </Field>
        </div>

        <Field
          id="reporterIdentity"
          label="Reporter identity"
          error={errors.reporterIdentity}
          hint="Optional. Encrypted; reveal requires step-up auth."
        >
          <input
            id="reporterIdentity"
            type="text"
            value={form.reporterIdentity}
            maxLength={200}
            disabled={form.anonymous}
            onChange={(e) => update('reporterIdentity', e.target.value)}
            className={fieldInputClass(!!errors.reporterIdentity)}
            placeholder="Worker name or pseudonym"
            aria-invalid={!!errors.reporterIdentity}
          />
          <label className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={form.anonymous}
              onChange={(e) => update('anonymous', e.target.checked)}
              className="h-3.5 w-3.5 rounded border-input"
            />
            Report anonymously
          </label>
        </Field>

        {errors.submit ? (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
          >
            {errors.submit}
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 p-3 backdrop-blur md:static md:mt-6 md:border-t-0 md:bg-transparent md:p-0">
        <div className="mx-auto flex max-w-2xl items-center justify-end gap-2">
          <Button asChild type="button" variant="outline" size="default" className="h-10 md:h-9">
            <Link to="/hazards">Cancel</Link>
          </Button>
          <Button type="submit" size="default" className="h-10 md:h-9" disabled={submitting}>
            {submitting ? 'Saving…' : 'Log hazard'}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

function Field({
  id,
  label,
  required,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  // Wire hint/error to the labelled input via aria-describedby so screen
  // readers announce both the descriptive hint AND validation errors per
  // CLAUDE.md WCAG Phase 1 ("Form errors announced to screen readers").
  // The input itself is rendered by the caller; we clone children to inject
  // the linking attribute.
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  const child = children as React.ReactElement<{
    'aria-describedby'?: string;
    'aria-required'?: boolean;
  }> | null;
  const wired =
    child && React.isValidElement(child)
      ? React.cloneElement(child, {
          'aria-describedby': describedBy,
          'aria-required': required || undefined,
        })
      : children;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
        {label}
        {required ? <span className="ml-0.5 text-status-rejected">*</span> : null}
      </label>
      {wired}
      {error ? (
        <div
          id={errorId}
          role="alert"
          aria-live="polite"
          className="mt-1 text-xs text-status-rejected"
        >
          {error}
        </div>
      ) : hint ? (
        <div id={hintId} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function fieldInputClass(invalid: boolean): string {
  return cn(
    'w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring',
    invalid ? 'border-status-rejected' : 'border-input',
  );
}
