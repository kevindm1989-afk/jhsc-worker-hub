// /inspections/new — template picker → zone + schedule → submit.
//
// Mobile: single column, sticky bottom CTA. Desktop: same, inline CTA.
// The flow is two-step (template, then zone) so the user sees the
// status_vocab + cadence + three-sig flags before committing — the
// pinned template version is immutable for the lifetime of the
// inspection (non-negotiable #13).

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { InspectionApiError, inspectionsApi, type TemplateSummary } from '@/inspections/api';
import {
  STATUS_VOCAB_LABELS,
  TEMPLATE_CODE_LABELS,
  ZONE_IDS,
  resolveZoneLabel,
  type ZoneId,
} from '@/inspections/components';

interface FormState {
  templateVersionId: string;
  zoneId: ZoneId | '';
  scheduledFor: string;
}

const INITIAL: FormState = {
  templateVersionId: '',
  zoneId: '',
  scheduledFor: '',
};

interface FormErrors {
  templateVersionId?: string;
  zoneId?: string;
  submit?: string;
}

export function NewInspectionView(): JSX.Element {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<ReadonlyArray<TemplateSummary> | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    inspectionsApi
      .listTemplates()
      .then((r) => {
        if (!cancelled) setTemplates(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setTemplatesError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (form.templateVersionId.length === 0) next.templateVersionId = 'Required';
    if (form.zoneId.length === 0) next.zoneId = 'Required';
    return next;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    if (form.zoneId === '') return; // narrows the type
    setSubmitting(true);
    try {
      const scheduledFor =
        form.scheduledFor.length > 0 ? new Date(form.scheduledFor).toISOString() : undefined;
      const created = await inspectionsApi.createInspection({
        templateVersionId: form.templateVersionId,
        zoneId: form.zoneId,
        ...(scheduledFor ? { scheduledFor } : {}),
      });
      navigate(`/inspections/${encodeURIComponent(created.id)}`);
    } catch (e) {
      if (e instanceof InspectionApiError) {
        setErrors({
          submit:
            e.status === 401
              ? 'Sign in expired. Reload the page and try again.'
              : e.status === 422
                ? 'That template is no longer active. Pick a different one.'
                : e.status === 400
                  ? 'The server rejected the form. Check the field rules.'
                  : `Could not save (HTTP ${e.status}).`,
        });
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
          to="/inspections"
          className="mb-2 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to inspections
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          New inspection
        </h1>
        <p className="mt-1 flex items-start gap-1 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>
            The template version is pinned at creation time. Once you save, this inspection stays
            bound to the template version even if the template is later updated.
          </span>
        </p>
      </header>

      <div className="space-y-6 pb-24 md:pb-0">
        <section aria-labelledby="step-template-heading">
          <h2
            id="step-template-heading"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Step 1 — pick a template
          </h2>
          {templatesError ? (
            <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
              {templatesError}
            </div>
          ) : !templates ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="h-16 animate-pulse rounded-md border border-border bg-muted/40"
                />
              ))}
            </div>
          ) : templates.length === 0 ? (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
              No active templates. Seed the workplace templates first (see runbook), or author a
              custom template from{' '}
              <Link to="/inspection-templates/new" className="text-primary underline">
                /inspection-templates/new
              </Link>
              .
            </div>
          ) : (
            <ul className="space-y-2">
              {templates.map((t) => (
                <li key={t.id}>
                  <TemplateOption
                    template={t}
                    selected={form.templateVersionId === t.id}
                    onSelect={() => update('templateVersionId', t.id)}
                  />
                </li>
              ))}
            </ul>
          )}
          {errors.templateVersionId ? (
            <div role="alert" className="mt-1 text-xs text-status-rejected">
              {errors.templateVersionId}
            </div>
          ) : null}
        </section>

        <section aria-labelledby="step-zone-heading">
          <h2
            id="step-zone-heading"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Step 2 — pick a zone and (optional) schedule
          </h2>
          <Field id="zoneId" label="Zone" required error={errors.zoneId}>
            <select
              id="zoneId"
              value={form.zoneId}
              onChange={(e) => update('zoneId', e.target.value as ZoneId)}
              className={fieldInputClass(!!errors.zoneId)}
              aria-invalid={!!errors.zoneId}
            >
              <option value="">Select a zone…</option>
              {ZONE_IDS.map((z) => (
                <option key={z} value={z}>
                  {resolveZoneLabel(z)} ({z})
                </option>
              ))}
            </select>
          </Field>

          <div className="mt-4">
            <Field
              id="scheduledFor"
              label="Scheduled for"
              hint="Optional. Use today's date to start an ad-hoc walk-through."
            >
              <input
                id="scheduledFor"
                type="datetime-local"
                value={form.scheduledFor}
                onChange={(e) => update('scheduledFor', e.target.value)}
                className={fieldInputClass(false)}
              />
            </Field>
          </div>
        </section>

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
            <Link to="/inspections">Cancel</Link>
          </Button>
          <Button type="submit" size="default" className="h-10 md:h-9" disabled={submitting}>
            {submitting ? 'Saving…' : 'Schedule inspection'}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Template option card — radio-style selectable card.
// ---------------------------------------------------------------------------

function TemplateOption({
  template,
  selected,
  onSelect,
}: {
  template: TemplateSummary;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'block w-full rounded-md border p-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
        selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-secondary/40',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{template.displayName}</span>
        <span
          className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            'border-zinc-200 bg-zinc-50 text-zinc-700',
          )}
        >
          {TEMPLATE_CODE_LABELS[template.templateCode]} · v{template.versionNumber}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>Cadence: {template.cadence.replace(/_/g, ' ')}</span>
        <span>Status vocab: {STATUS_VOCAB_LABELS[template.statusVocab]}</span>
        {template.requiresThreeSignatures ? (
          <span className="font-medium text-foreground">Three-signature template</span>
        ) : (
          <span>Single-signature template</span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form primitives — matched to hazard-new-view's so the UX is consistent.
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
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
        {label}
        {required ? <span className="ml-0.5 text-status-rejected">*</span> : null}
      </label>
      {children}
      {error ? (
        <div role="alert" aria-live="polite" className="mt-1 text-xs text-status-rejected">
          {error}
        </div>
      ) : hint ? (
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
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
