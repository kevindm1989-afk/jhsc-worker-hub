// /inspection-templates/new — author a custom inspection template.
//
// Server enforces `template_code='custom'` at the route layer; this UI
// only renders the authoring affordance for custom templates. The
// seeded codes (zone_monthly, rack_inspection) are read-only.
//
// Zod-validated shape mirrors the server's `customTemplateBody`. The
// route also refuses HTML/markdown characters (`<` / `>`) in any string
// field; we mirror that here so the error surfaces immediately.
//
// Repeatable sections + repeatable items per section. Each item has a
// stable `key` (snake_case), a `label`, and an optional `helpText`. A
// future version can prefill from an existing template (the optional
// `?from=<id>` query string in the link from /inspection-templates).

import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  InspectionApiError,
  inspectionsApi,
  type CustomTemplateBody,
  type InspectionCadence,
} from '@/inspections/api';
import { STATUS_VOCAB_LABELS } from '@/inspections/components';
import { inspectionStatusVocabKind, type InspectionStatusVocabKind } from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Validation — structural twin of the server's createTemplateBody Zod
// schema in apps/api/src/routes/inspections/index.ts. Hand-rolled here so
// apps/web doesn't have to take a hard dep on the zod runtime (apps/web
// already pulls in plenty of JS — every kilobyte we don't ship is bytes
// the on-the-floor mobile build doesn't have to parse). The error
// strings + bounds MUST match the server's so the user sees the same
// rules either way.
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const NO_HTML = /[<>]/;

interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

function validateString(
  value: string,
  opts: { min?: number; max: number; label: string },
): string | null {
  if (opts.min !== undefined && value.length < opts.min) return `${opts.label}: required`;
  if (value.length > opts.max) return `${opts.label}: max ${opts.max} chars`;
  if (NO_HTML.test(value)) return `${opts.label}: no \`<\` or \`>\` allowed`;
  return null;
}

function validateKey(value: string, label: string): string | null {
  if (!KEY_PATTERN.test(value)) {
    return `${label}: must be snake_case (lowercase, ≤64 chars, start with a letter)`;
  }
  return null;
}

function validateBody(body: CustomTemplateBody): ReadonlyArray<ValidationIssue> {
  const issues: ValidationIssue[] = [];
  const push = (path: ReadonlyArray<string | number>, msg: string | null): void => {
    if (msg) issues.push({ path, message: msg });
  };

  push(
    ['displayName'],
    validateString(body.displayName, { min: 1, max: 120, label: 'displayName' }),
  );
  if (!(inspectionStatusVocabKind as ReadonlyArray<string>).includes(body.statusVocab)) {
    issues.push({ path: ['statusVocab'], message: 'invalid status vocab' });
  }
  if (!['monthly', 'quarterly', 'annual', 'ad_hoc'].includes(body.cadence)) {
    issues.push({ path: ['cadence'], message: 'invalid cadence' });
  }
  if (body.sections.length < 1) {
    issues.push({ path: ['sections'], message: 'at least one section' });
  }
  if (body.sections.length > 30) {
    issues.push({ path: ['sections'], message: 'max 30 sections' });
  }
  body.sections.forEach((s, i) => {
    push(['sections', i, 'key'], validateKey(s.key, 'section key'));
    push(
      ['sections', i, 'label'],
      validateString(s.label, { min: 1, max: 240, label: 'section label' }),
    );
    if (s.items.length < 1) {
      issues.push({ path: ['sections', i, 'items'], message: 'at least one item' });
    }
    if (s.items.length > 30) {
      issues.push({ path: ['sections', i, 'items'], message: 'max 30 items' });
    }
    s.items.forEach((it, j) => {
      push(['sections', i, 'items', j, 'key'], validateKey(it.key, 'item key'));
      push(
        ['sections', i, 'items', j, 'label'],
        validateString(it.label, { min: 1, max: 240, label: 'item label' }),
      );
      if (it.helpText !== undefined) {
        push(
          ['sections', i, 'items', j, 'helpText'],
          validateString(it.helpText, { max: 480, label: 'helpText' }),
        );
      }
    });
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Local form state
// ---------------------------------------------------------------------------

interface SectionDraft {
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<ItemDraft>;
}

interface ItemDraft {
  readonly key: string;
  readonly label: string;
  readonly helpText: string;
}

interface FormState {
  readonly displayName: string;
  readonly statusVocab: InspectionStatusVocabKind;
  readonly cadence: InspectionCadence;
  readonly requiresThreeSignatures: boolean;
  readonly sections: ReadonlyArray<SectionDraft>;
}

const EMPTY_ITEM: ItemDraft = { key: '', label: '', helpText: '' };
const EMPTY_SECTION: SectionDraft = { key: '', label: '', items: [EMPTY_ITEM] };

const INITIAL: FormState = {
  displayName: '',
  statusVocab: 'ABC_X',
  cadence: 'monthly',
  requiresThreeSignatures: false,
  sections: [EMPTY_SECTION],
};

export function NewTemplateView(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const from = params.get('from');
  const [form, setForm] = useState<FormState>(INITIAL);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReadonlyArray<string>>([]);
  const [submitting, setSubmitting] = useState(false);

  // Optional prefill from an existing template (typically a prior
  // version of a `custom` template).
  useEffect(() => {
    if (!from) return;
    let cancelled = false;
    inspectionsApi
      .getTemplate(from)
      .then((d) => {
        if (cancelled) return;
        if (d.templateCode !== 'custom') {
          // Don't pre-fill from seeded templates — they're read-only
          // and forcing a "v2" of zone_monthly via a route-level
          // bypass is what the server's "seeded_template_immutable"
          // check is there to stop. Leave the form empty + surface a
          // hint.
          setError(
            'Cannot prefill from a seeded template. Seeded codes (zone_monthly, rack_inspection) are read-only.',
          );
          return;
        }
        setForm({
          displayName: d.displayName,
          statusVocab: d.statusVocab,
          cadence: d.cadence,
          requiresThreeSignatures: d.requiresThreeSignatures,
          sections: d.sections.map((s) => ({
            key: s.key,
            label: s.label,
            items: s.items.map((it) => ({
              key: it.key,
              label: it.label,
              helpText: it.helpText ?? '',
            })),
          })),
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [from]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function addSection(): void {
    setForm((prev) => ({ ...prev, sections: [...prev.sections, { ...EMPTY_SECTION }] }));
  }

  function updateSection(idx: number, patch: Partial<SectionDraft>): void {
    setForm((prev) => ({
      ...prev,
      sections: prev.sections.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));
  }

  function removeSection(idx: number): void {
    setForm((prev) => ({
      ...prev,
      sections: prev.sections.filter((_, i) => i !== idx),
    }));
  }

  function addItem(sectionIdx: number): void {
    setForm((prev) => ({
      ...prev,
      sections: prev.sections.map((s, i) =>
        i === sectionIdx ? { ...s, items: [...s.items, { ...EMPTY_ITEM }] } : s,
      ),
    }));
  }

  function updateItem(sectionIdx: number, itemIdx: number, patch: Partial<ItemDraft>): void {
    setForm((prev) => ({
      ...prev,
      sections: prev.sections.map((s, i) => {
        if (i !== sectionIdx) return s;
        return {
          ...s,
          items: s.items.map((it, j) => (j === itemIdx ? { ...it, ...patch } : it)),
        };
      }),
    }));
  }

  function removeItem(sectionIdx: number, itemIdx: number): void {
    setForm((prev) => ({
      ...prev,
      sections: prev.sections.map((s, i) => {
        if (i !== sectionIdx) return s;
        return { ...s, items: s.items.filter((_, j) => j !== itemIdx) };
      }),
    }));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setFieldErrors([]);
    // Build the canonical body the server expects.
    const body: CustomTemplateBody = {
      templateCode: 'custom',
      displayName: form.displayName.trim(),
      statusVocab: form.statusVocab,
      cadence: form.cadence,
      requiresThreeSignatures: form.requiresThreeSignatures,
      sections: form.sections.map((s) => ({
        key: s.key.trim(),
        label: s.label.trim(),
        items: s.items.map((it) => {
          const helpTextTrimmed = it.helpText.trim();
          return helpTextTrimmed.length > 0
            ? { key: it.key.trim(), label: it.label.trim(), helpText: helpTextTrimmed }
            : { key: it.key.trim(), label: it.label.trim() };
        }),
      })),
    };
    const issues = validateBody(body);
    if (issues.length > 0) {
      setFieldErrors(issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`));
      return;
    }

    setSubmitting(true);
    try {
      await inspectionsApi.createCustomTemplate(body);
      navigate('/inspection-templates');
    } catch (e) {
      if (e instanceof InspectionApiError) {
        const body = e.body as { error?: string } | undefined;
        if (body?.error === 'seeded_template_immutable') {
          setError(
            'The server rejected this template because the code is reserved for a seeded template. Use template_code="custom" — the form is already wired for that.',
          );
        } else {
          setError(`Could not save (HTTP ${e.status} ${body?.error ?? ''}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6" noValidate>
      <header className="mb-4 md:mb-6">
        <Link
          to="/inspection-templates"
          className="mb-2 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to templates
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {from ? 'New version of custom template' : 'New custom template'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Author a workplace-specific inspection structure. Seeded templates (Zone Monthly, Rack
          Inspection) are read-only — they ship with the workplace defaults.
        </p>
      </header>

      <div className="space-y-6 pb-32 md:pb-0">
        <section
          aria-labelledby="meta-heading"
          className="rounded-md border border-border bg-card p-4"
        >
          <h2
            id="meta-heading"
            className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Template metadata
          </h2>
          <Field id="displayName" label="Display name" required>
            <input
              id="displayName"
              type="text"
              value={form.displayName}
              maxLength={120}
              onChange={(e) => update('displayName', e.target.value)}
              className={fieldInputClass(false)}
              placeholder="Forklift Pre-shift Walk-through"
            />
          </Field>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field id="statusVocab" label="Status vocabulary" required>
              <div className="flex flex-wrap gap-2">
                {inspectionStatusVocabKind.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => update('statusVocab', v)}
                    aria-pressed={form.statusVocab === v}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
                      form.statusVocab === v
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-foreground hover:bg-muted',
                    )}
                  >
                    {STATUS_VOCAB_LABELS[v]}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                ABC + X: A urgent, B attention, C info, X no-issue (not promotable). G / A / R: G
                pass (not promotable), A attention, R fail.
              </p>
            </Field>

            <Field id="cadence" label="Cadence" required>
              <select
                id="cadence"
                value={form.cadence}
                onChange={(e) => update('cadence', e.target.value as InspectionCadence)}
                className={fieldInputClass(false)}
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="ad_hoc">Ad-hoc</option>
              </select>
            </Field>
          </div>

          <div className="mt-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.requiresThreeSignatures}
                onChange={(e) => update('requiresThreeSignatures', e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              <span>Requires three signatures (inspector + supervisor + JHSC worker co-chair)</span>
            </label>
          </div>
        </section>

        <section aria-labelledby="sections-heading">
          <div className="mb-2 flex items-center justify-between">
            <h2
              id="sections-heading"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Sections
            </h2>
            <Button type="button" variant="outline" size="sm" onClick={addSection}>
              <Plus className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              Add section
            </Button>
          </div>
          {/*
            priv-F11 close-out: anti-name nudge near the section/item
            authoring inputs. Template labels are SNAPSHOTTED onto
            findings as plaintext (migrations/0007:105-108); a label
            with embedded names propagates to every finding's metadata.
          */}
          <p className="mb-2 text-xs text-muted-foreground">
            Templates are static structure — avoid naming individual workers or supervisors in
            section/item labels. Use roles (e.g. &lsquo;Shift Lead&rsquo;) instead.
          </p>
          <ul className="space-y-3">
            {form.sections.map((section, idx) => (
              <li key={idx}>
                <SectionEditor
                  index={idx}
                  section={section}
                  onPatch={(patch) => updateSection(idx, patch)}
                  onRemove={() => removeSection(idx)}
                  onAddItem={() => addItem(idx)}
                  onUpdateItem={(j, patch) => updateItem(idx, j, patch)}
                  onRemoveItem={(j) => removeItem(idx, j)}
                  removable={form.sections.length > 1}
                />
              </li>
            ))}
          </ul>
        </section>

        {fieldErrors.length > 0 ? (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
          >
            <div className="mb-1 font-medium">Field errors</div>
            <ul className="list-disc space-y-0.5 pl-4">
              {fieldErrors.map((e, i) => (
                <li key={i} className="text-xs">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            aria-live="polite"
            className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
          >
            {error}
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 p-3 backdrop-blur md:static md:mt-6 md:border-t-0 md:bg-transparent md:p-0">
        <div className="mx-auto flex max-w-3xl items-center justify-end gap-2">
          <Button asChild type="button" variant="outline" size="default" className="h-10 md:h-9">
            <Link to="/inspection-templates">Cancel</Link>
          </Button>
          <Button type="submit" size="default" className="h-10 md:h-9" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save template'}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-section editor
// ---------------------------------------------------------------------------

function SectionEditor({
  index,
  section,
  onPatch,
  onRemove,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
  removable,
}: {
  index: number;
  section: SectionDraft;
  onPatch: (patch: Partial<SectionDraft>) => void;
  onRemove: () => void;
  onAddItem: () => void;
  onUpdateItem: (itemIdx: number, patch: Partial<ItemDraft>) => void;
  onRemoveItem: (itemIdx: number) => void;
  removable: boolean;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Section {index + 1}
        </span>
        {removable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-status-rejected"
            onClick={onRemove}
          >
            <Trash2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            Remove
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field id={`sec-${index}-key`} label="Key (snake_case)" required>
          <input
            id={`sec-${index}-key`}
            type="text"
            value={section.key}
            maxLength={64}
            onChange={(e) => onPatch({ key: e.target.value })}
            className={fieldInputClass(false)}
            placeholder="walk_through"
          />
        </Field>
        <Field id={`sec-${index}-label`} label="Label" required>
          <input
            id={`sec-${index}-label`}
            type="text"
            value={section.label}
            maxLength={240}
            onChange={(e) => onPatch({ label: e.target.value })}
            className={fieldInputClass(false)}
            placeholder="Walk-through"
          />
        </Field>
      </div>

      <div className="mt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Items
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
            <Plus className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            Add item
          </Button>
        </div>
        <ul className="space-y-2">
          {section.items.map((item, j) => (
            <li key={j}>
              <ItemEditor
                sectionIndex={index}
                itemIndex={j}
                item={item}
                onPatch={(patch) => onUpdateItem(j, patch)}
                onRemove={() => onRemoveItem(j)}
                removable={section.items.length > 1}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ItemEditor({
  sectionIndex,
  itemIndex,
  item,
  onPatch,
  onRemove,
  removable,
}: {
  sectionIndex: number;
  itemIndex: number;
  item: ItemDraft;
  onPatch: (patch: Partial<ItemDraft>) => void;
  onRemove: () => void;
  removable: boolean;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Field id={`item-${sectionIndex}-${itemIndex}-key`} label="Item key" required>
          <input
            id={`item-${sectionIndex}-${itemIndex}-key`}
            type="text"
            value={item.key}
            maxLength={64}
            onChange={(e) => onPatch({ key: e.target.value })}
            className={fieldInputClass(false)}
            placeholder="floor_clear"
          />
        </Field>
        <Field id={`item-${sectionIndex}-${itemIndex}-label`} label="Item label" required>
          <input
            id={`item-${sectionIndex}-${itemIndex}-label`}
            type="text"
            value={item.label}
            maxLength={240}
            onChange={(e) => onPatch({ label: e.target.value })}
            className={fieldInputClass(false)}
            placeholder="Floor clear of trip hazards"
          />
        </Field>
      </div>
      <div className="mt-2">
        <Field
          id={`item-${sectionIndex}-${itemIndex}-help`}
          label="Help text (optional)"
          hint="Plain prose, ≤480 chars. No verbatim CSA text — clause refs in your own words only."
        >
          <input
            id={`item-${sectionIndex}-${itemIndex}-help`}
            type="text"
            value={item.helpText}
            maxLength={480}
            onChange={(e) => onPatch({ helpText: e.target.value })}
            className={fieldInputClass(false)}
          />
        </Field>
      </div>
      {removable ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-status-rejected"
            onClick={onRemove}
          >
            <Trash2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            Remove item
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

function Field({
  id,
  label,
  required,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  // Wire hint to the labelled input via aria-describedby so screen readers
  // announce the descriptive hint per CLAUDE.md WCAG Phase 1.
  const hintId = hint ? `${id}-hint` : undefined;
  const child = children as React.ReactElement<{
    'aria-describedby'?: string;
    'aria-required'?: boolean;
  }> | null;
  const wired =
    child && React.isValidElement(child)
      ? React.cloneElement(child, {
          'aria-describedby': hintId,
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
      {hint ? (
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
