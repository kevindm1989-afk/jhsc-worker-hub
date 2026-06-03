// /action-items/new — mobile-first intake.

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ActionItemsApiError, actionItemsApi } from '@/action-items/api';
import { RISK_LABELS, STATUS_LABELS, TYPE_LABELS } from '@/action-items/components';
import {
  actionItemRisk,
  actionItemSection,
  actionItemStatus,
  actionItemType,
  type ActionItemRisk,
  type ActionItemSection,
  type ActionItemStatus,
  type ActionItemType,
} from '@jhsc/shared-types';

interface FormState {
  type: ActionItemType;
  typeSubtype: string;
  description: string;
  recommendedAction: string;
  raisedBy: string;
  department: string;
  status: ActionItemStatus;
  risk: ActionItemRisk;
  section: ActionItemSection;
  startDate: string;
  targetDate: string;
}

const INITIAL: FormState = {
  type: 'INSIGHT',
  typeSubtype: '',
  description: '',
  recommendedAction: '',
  raisedBy: '',
  department: '',
  status: 'Not Started',
  risk: 'Medium',
  section: 'new_business',
  startDate: new Date().toISOString().slice(0, 10),
  targetDate: '',
};

interface FormErrors {
  description?: string;
  typeSubtype?: string;
  submit?: string;
}

export function ActionItemNewView(): JSX.Element {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (form.description.trim().length === 0) next.description = 'Required';
    else if (form.description.length > 8000) next.description = '8000 characters max';
    if (form.type === 'OTHER' && form.typeSubtype.trim().length === 0) {
      next.typeSubtype = "Required when type is 'Other'";
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
      const created = await actionItemsApi.create({
        type: form.type,
        typeSubtype: form.type === 'OTHER' ? form.typeSubtype.trim() : undefined,
        description: form.description.trim(),
        recommendedAction: form.recommendedAction.trim() || undefined,
        raisedBy: form.raisedBy.trim() || undefined,
        department: form.department.trim() || undefined,
        status: form.status,
        risk: form.risk,
        section: form.section,
        startDate: form.startDate,
        targetDate: form.targetDate || undefined,
      });
      navigate(`/action-items/${encodeURIComponent(created.id)}`);
    } catch (e) {
      if (e instanceof ActionItemsApiError) {
        setErrors({
          submit:
            e.status === 401
              ? 'Sign in expired. Reload the page and try again.'
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
          to="/action-items"
          className="mb-2 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to action items
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Raise an action item
        </h1>
        <p className="mt-1 flex items-start gap-1 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>
            Description, recommended action, and the &ldquo;raised by&rdquo; name travel to the
            server over HTTPS, and are encrypted at rest with a key held by the workplace before
            they are written to the database.
          </span>
        </p>
      </header>

      <div className="space-y-4 pb-24 md:pb-0">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="type" label="Type" required>
            <select
              id="type"
              value={form.type}
              onChange={(e) => update('type', e.target.value as ActionItemType)}
              className={fieldInputClass(false)}
            >
              {actionItemType.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id="typeSubtype"
            label="Type subtype"
            required={form.type === 'OTHER'}
            error={errors.typeSubtype}
            hint={form.type === 'OTHER' ? 'Required for OTHER' : 'Optional'}
          >
            <input
              id="typeSubtype"
              type="text"
              value={form.typeSubtype}
              maxLength={64}
              onChange={(e) => update('typeSubtype', e.target.value)}
              className={fieldInputClass(!!errors.typeSubtype)}
            />
          </Field>
        </div>

        <Field
          id="description"
          label="Description"
          required
          error={errors.description}
          hint="What was raised? Who's affected?"
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

        <Field id="recommendedAction" label="Recommended action" hint="Optional, encrypted">
          <textarea
            id="recommendedAction"
            value={form.recommendedAction}
            maxLength={8000}
            rows={3}
            onChange={(e) => update('recommendedAction', e.target.value)}
            className={cn(fieldInputClass(false), 'resize-y leading-relaxed')}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field id="section" label="Section" required>
            <select
              id="section"
              value={form.section}
              onChange={(e) => update('section', e.target.value as ActionItemSection)}
              className={fieldInputClass(false)}
            >
              {actionItemSection.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field id="status" label="Status" required>
            <select
              id="status"
              value={form.status}
              onChange={(e) => update('status', e.target.value as ActionItemStatus)}
              className={fieldInputClass(false)}
            >
              {actionItemStatus.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field id="risk" label="Risk" required>
            <select
              id="risk"
              value={form.risk}
              onChange={(e) => update('risk', e.target.value as ActionItemRisk)}
              className={fieldInputClass(false)}
            >
              {actionItemRisk.map((r) => (
                <option key={r} value={r}>
                  {RISK_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="startDate" label="Start date" required>
            <input
              id="startDate"
              type="date"
              value={form.startDate}
              onChange={(e) => update('startDate', e.target.value)}
              className={fieldInputClass(false)}
              required
            />
          </Field>
          <Field id="targetDate" label="Target date" hint="Optional">
            <input
              id="targetDate"
              type="date"
              value={form.targetDate}
              onChange={(e) => update('targetDate', e.target.value)}
              className={fieldInputClass(false)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            id="raisedBy"
            label="Raised by"
            hint="Optional, encrypted; name of external person"
          >
            <input
              id="raisedBy"
              type="text"
              value={form.raisedBy}
              maxLength={200}
              onChange={(e) => update('raisedBy', e.target.value)}
              className={fieldInputClass(false)}
            />
          </Field>
          <Field id="department" label="Department" hint="Optional, non-PI">
            <input
              id="department"
              type="text"
              value={form.department}
              maxLength={120}
              onChange={(e) => update('department', e.target.value)}
              className={fieldInputClass(false)}
              placeholder="Operations"
            />
          </Field>
        </div>

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
            <Link to="/action-items">Cancel</Link>
          </Button>
          <Button type="submit" size="default" className="h-10 md:h-9" disabled={submitting}>
            {submitting ? 'Saving…' : 'Raise action item'}
          </Button>
        </div>
      </div>
    </form>
  );
}

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
  // Per S5 F-P3: text-base (16px) on mobile prevents iOS Safari auto-
  // zoom on focus; text-sm (14px) at md+ preserves desktop density.
  return cn(
    'w-full rounded-md border bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:text-sm',
    invalid ? 'border-status-rejected' : 'border-input',
  );
}
