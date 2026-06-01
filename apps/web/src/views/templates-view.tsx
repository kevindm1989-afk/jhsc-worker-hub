// /inspection-templates — browse active template versions.
//
// Seeded templates (zone_monthly, rack_inspection) are read-only:
// "View structure" opens a modal with the sections snapshot. Custom
// templates link to /inspection-templates/new for new-version
// authoring (the API enforces template_code='custom' at the route
// layer; the UI only renders the authoring affordance for that code).
//
// Rack template "View structure" carries a CSA-copyright footnote
// reminding the rep that items reference CSA A344.1/A344.2 by clause
// number only — full text lives in the standard, not in this app
// (CLAUDE.md "Legal Reference Module Rules" §5).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ClipboardList, FileText, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  InspectionApiError,
  inspectionsApi,
  type TemplateDetail,
  type TemplateSummary,
} from '@/inspections/api';
import { STATUS_VOCAB_LABELS, TEMPLATE_CODE_LABELS } from '@/inspections/components';

export function TemplatesView(): JSX.Element {
  const [templates, setTemplates] = useState<ReadonlyArray<TemplateSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTemplateId, setOpenTemplateId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    inspectionsApi
      .listTemplates()
      .then((r) => {
        if (!cancelled) setTemplates(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-start justify-between gap-3 md:mb-6">
        <div>
          <Link
            to="/inspections"
            className="mb-2 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Back to inspections
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Inspection templates
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Active versions. Seeded templates are read-only; custom templates can be revised by
            creating a new version.
          </p>
        </div>
        <Button asChild size="sm" className="h-9">
          <Link to="/inspection-templates/new">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            New custom
          </Link>
        </Button>
      </header>

      {error ? (
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
          {error}
        </div>
      ) : !templates ? (
        <ul className="space-y-2" aria-busy="true">
          {[0, 1].map((i) => (
            <li
              key={i}
              className="h-20 animate-pulse rounded-md border border-border bg-muted/40"
            />
          ))}
        </ul>
      ) : templates.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          No active templates. The workplace defaults (Zone Monthly + Rack Inspection) should be
          seeded at first deploy — see the runbook.
        </div>
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li key={t.id}>
              <TemplateRow template={t} onViewStructure={() => setOpenTemplateId(t.id)} />
            </li>
          ))}
        </ul>
      )}

      {openTemplateId ? (
        <TemplateStructureModal
          templateId={openTemplateId}
          onClose={() => setOpenTemplateId(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-template row
// ---------------------------------------------------------------------------

function TemplateRow({
  template,
  onViewStructure,
}: {
  template: TemplateSummary;
  onViewStructure: () => void;
}): JSX.Element {
  const isCustom = template.templateCode === 'custom';
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        <ClipboardList
          className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                'border-zinc-200 bg-zinc-50 text-zinc-700',
              )}
            >
              {TEMPLATE_CODE_LABELS[template.templateCode]} · v{template.versionNumber}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {STATUS_VOCAB_LABELS[template.statusVocab]}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {template.cadence.replace(/_/g, ' ')}
            </span>
            {template.requiresThreeSignatures ? (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                3-sig
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">{template.displayName}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={onViewStructure}
          >
            <FileText className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            View structure
          </Button>
          {isCustom ? (
            <Button asChild variant="default" size="sm" className="h-8 px-3 text-xs">
              <Link to={`/inspection-templates/new?from=${encodeURIComponent(template.id)}`}>
                New version
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structure modal — fetches the template detail on open and renders the
// sections + items as a read-only outline.
// ---------------------------------------------------------------------------

function TemplateStructureModal({
  templateId,
  onClose,
}: {
  templateId: string;
  onClose: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    inspectionsApi
      .getTemplate(templateId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof InspectionApiError && e.status === 404) {
          setError('Template not found.');
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-modal-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-t-2xl bg-card shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <h2
            id="template-modal-title"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            {detail ? detail.displayName : 'Template structure'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {error ? (
            <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected">
              {error}
            </div>
          ) : !detail ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="mb-3 text-xs text-muted-foreground">
                {TEMPLATE_CODE_LABELS[detail.templateCode]} · v{detail.versionNumber} ·{' '}
                {STATUS_VOCAB_LABELS[detail.statusVocab]} · {detail.cadence.replace(/_/g, ' ')} ·{' '}
                {detail.requiresThreeSignatures ? 'three signatures' : 'one signature'}
              </div>
              <ol className="space-y-3">
                {detail.sections.map((s, idx) => (
                  <li key={s.key} className="rounded-md border border-border bg-background p-3">
                    <div className="text-sm font-medium text-foreground">
                      {idx + 1}. {s.label}
                    </div>
                    <ul className="mt-2 space-y-1.5 pl-4 text-sm text-foreground">
                      {s.items.map((it) => (
                        <li key={it.key} className="list-disc">
                          <span>{it.label}</span>
                          {it.helpText ? (
                            <div className="text-xs text-muted-foreground">{it.helpText}</div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              {detail.templateCode === 'rack_inspection' ? (
                <p className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-muted-foreground">
                  Inspection items reference CSA A344.1/A344.2 by clause number only. Consult the
                  standard for full text — the app stores summaries and clause references, not
                  verbatim CSA prose.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
