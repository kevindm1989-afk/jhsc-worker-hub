// /recommendations/new — Drafting form (the densest 1.9 surface).
//
// The form composes:
//   - Title input (≤200 chars).
//   - Jurisdiction radio (ON / CA-FED) — anchored with the deliberate
//     "Determines the statutory clock" copy. Per S2, jurisdiction is
//     immutable after first save; the edit view hides this control.
//   - Body textarea (≤16000 chars) where [[cite:N]] markers live as
//     literal text.
//   - "Insert citation" button (CitationRefButton) that opens the corpus
//     picker. On insert: appends a [[cite:N]] marker at the cursor AND
//     adds a row to the citations table with a dense position.
//   - Citations table with per-row "Jump to marker" + "Remove" actions.
//     Removing a row also strips the corresponding [[cite:N]] markers
//     and densely renumbers remaining positions.
//
// Live validator (client-side, permissive):
//   - Every [[cite:N]] in the body must have a citation row with that
//     position; every citation row must have at least one marker.
//   - Mismatches surface as inline warnings — they do NOT block save.
//     The server is the strict gate at submit (T-R7 / T-R8). Draft save
//     is permissive so the rep can save a half-cited draft and come
//     back to it.
//
// Save behavior:
//   - new-recommendation-view POSTs and navigates to /:id.
//   - edit-recommendation-view reuses this form via the
//     RecommendationForm primitive and PATCHes instead. Jurisdiction is
//     immutable on the edit path.

import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, MapPin, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CitationRefButton, type InsertableCitation } from '@/components/citation-ref';
import {
  RecommendationApiError,
  recommendationsApi,
  type CreateRecommendationBody,
  type PatchRecommendationBody,
  type RecommendationCitation,
} from '@/recommendations/api';
import { recommendationJurisdiction, type RecommendationJurisdiction } from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Local citation row — extends the API DTO with optional preview metadata
// for the table label (heading + citation). The preview fields are NOT
// sent to the server; only {statuteCode, clauseId, versionDate, position}
// rides the POST/PATCH body.
// ---------------------------------------------------------------------------

interface DraftCitation {
  readonly statuteCode: string;
  readonly clauseId: string;
  readonly versionDate: string;
  readonly position: number;
  readonly heading: string | null;
  readonly citation: string;
}

// ---------------------------------------------------------------------------
// Marker parsing — extracted so the validator + renumber pass share one
// regex.
// ---------------------------------------------------------------------------

const MARKER_RE = /\[\[cite:(\d+)\]\]/g;

function parseMarkerPositions(body: string): ReadonlyArray<number> {
  const positions: number[] = [];
  for (const match of body.matchAll(MARKER_RE)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1) positions.push(n);
  }
  return positions;
}

interface ValidationIssue {
  readonly kind:
    | 'marker_without_citation'
    | 'citation_without_marker'
    | 'duplicate_position'
    | 'non_dense_positions';
  readonly position?: number;
  readonly message: string;
}

function validateLocal(
  body: string,
  citations: ReadonlyArray<DraftCitation>,
): ReadonlyArray<ValidationIssue> {
  const issues: ValidationIssue[] = [];
  const markerPositions = new Set(parseMarkerPositions(body));
  const citationPositions = new Set<number>();
  for (const c of citations) {
    if (citationPositions.has(c.position)) {
      issues.push({
        kind: 'duplicate_position',
        position: c.position,
        message: `Citation position ${c.position} is duplicated. Remove the older row.`,
      });
    } else {
      citationPositions.add(c.position);
    }
  }
  // Dense 1..N positions check.
  const sorted = [...citationPositions].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) {
      issues.push({
        kind: 'non_dense_positions',
        message: `Citation positions are not dense (expected ${i + 1}, got ${sorted[i] ?? 'none'}). Save will be rejected until citations are renumbered 1..N.`,
      });
      break;
    }
  }
  // Marker / citation cross-check.
  for (const m of markerPositions) {
    if (!citationPositions.has(m)) {
      issues.push({
        kind: 'marker_without_citation',
        position: m,
        message: `Marker [[cite:${m}]] has no citation row. Insert citation ${m} or remove the marker.`,
      });
    }
  }
  for (const p of citationPositions) {
    if (!markerPositions.has(p)) {
      issues.push({
        kind: 'citation_without_marker',
        position: p,
        message: `Citation ${p} has no [[cite:${p}]] marker in the body. Insert a marker or remove the citation row.`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Top-level view — new-recommendation
// ---------------------------------------------------------------------------

export function NewRecommendationView(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <Link
        to="/recommendations"
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to recommendations
      </Link>

      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Draft recommendation
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A written Notice of Recommendation under OHSA s.9(20) or CLC s.135(5). Save a draft now;
          submitting later starts the statutory clock and creates a tracked action item.
        </p>
      </header>

      <RecommendationForm
        mode="create"
        initial={{ title: '', body: '', jurisdiction: 'ON', citations: [] }}
        onSaved={(id) => navigate(`/recommendations/${encodeURIComponent(id)}`)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RecommendationForm — the shared primitive. Exported so the edit view
// can reuse it with a different `mode` + initial values.
// ---------------------------------------------------------------------------

export interface RecommendationFormInitial {
  readonly title: string;
  readonly body: string;
  readonly jurisdiction: RecommendationJurisdiction;
  readonly citations: ReadonlyArray<DraftCitation>;
}

export interface RecommendationFormProps {
  /** create: POST /api/recommendations. edit: PATCH /api/recommendations/:id. */
  readonly mode: 'create' | { kind: 'edit'; id: string };
  readonly initial: RecommendationFormInitial;
  readonly onSaved: (id: string) => void;
  readonly onCancel?: () => void;
}

export function RecommendationForm(props: RecommendationFormProps): JSX.Element {
  const { mode, initial, onSaved, onCancel } = props;
  const isEdit = typeof mode === 'object' && mode.kind === 'edit';

  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [jurisdiction, setJurisdiction] = useState<RecommendationJurisdiction>(
    initial.jurisdiction,
  );
  const [citations, setCitations] = useState<ReadonlyArray<DraftCitation>>(initial.citations);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Live validation runs every render (cheap — body capped at 16KB).
  const issues = useMemo(() => validateLocal(body, citations), [body, citations]);

  // ---------------------------------------------------------------------------
  // Citation insert: append marker at cursor + add citation row.
  // ---------------------------------------------------------------------------

  const onInsertCitation = useCallback(
    (citation: InsertableCitation): void => {
      // Reject duplicate (statuteCode, clauseId, versionDate) — the
      // server treats positions as unique but a rep inserting the same
      // clause twice probably wants a single citation cited at two
      // marker positions, not two separate rows. The simpler 1.9
      // behavior is: dedupe rows by clauseId; if the rep wants the same
      // clause cited at marker positions [1] and [2], they re-insert
      // the existing position's marker text manually.
      const existing = citations.find((c) => c.clauseId === citation.clauseId);
      let position: number;
      let nextCitations: ReadonlyArray<DraftCitation> = citations;
      if (existing) {
        position = existing.position;
      } else {
        position = citations.length + 1;
        nextCitations = [
          ...citations,
          {
            statuteCode: citation.statuteCode,
            clauseId: citation.clauseId,
            versionDate: citation.versionDate,
            position,
            heading: citation.heading,
            citation: citation.citation,
          },
        ];
        setCitations(nextCitations);
      }

      // Insert the marker text at the current textarea cursor.
      const ta = bodyRef.current;
      const marker = `[[cite:${position}]]`;
      if (ta) {
        const start = ta.selectionStart ?? body.length;
        const end = ta.selectionEnd ?? body.length;
        const next = body.slice(0, start) + marker + body.slice(end);
        setBody(next);
        // Restore the caret after the inserted marker. Defer to next
        // frame so the textarea has re-rendered with the new value.
        requestAnimationFrame(() => {
          if (bodyRef.current) {
            const caret = start + marker.length;
            bodyRef.current.selectionStart = caret;
            bodyRef.current.selectionEnd = caret;
            bodyRef.current.focus();
          }
        });
      } else {
        setBody((prev) => prev + marker);
      }
    },
    [body, citations],
  );

  // ---------------------------------------------------------------------------
  // Remove a citation row: strip matching markers + renumber dense.
  // ---------------------------------------------------------------------------

  const onRemoveCitation = useCallback(
    (position: number): void => {
      // Build the renumber map: keep all positions except the removed
      // one, then assign new dense positions in original order.
      const kept = citations
        .filter((c) => c.position !== position)
        .sort((a, b) => a.position - b.position);
      const renumber = new Map<number, number>();
      kept.forEach((c, i) => renumber.set(c.position, i + 1));
      const nextCitations: ReadonlyArray<DraftCitation> = kept.map((c, i) => ({
        ...c,
        position: i + 1,
      }));
      // Rewrite the body: replace every [[cite:N]] marker.
      //   - If N is the removed position, strip it.
      //   - Otherwise, rewrite to the renumbered position.
      const nextBody = body.replaceAll(MARKER_RE, (match, nStr) => {
        const n = Number(nStr);
        if (n === position) return '';
        const newN = renumber.get(n);
        if (newN === undefined) return match;
        return `[[cite:${newN}]]`;
      });
      setCitations(nextCitations);
      setBody(nextBody);
    },
    [body, citations],
  );

  // ---------------------------------------------------------------------------
  // Jump to marker — scrolls + selects the first [[cite:N]] occurrence
  // in the body textarea.
  // ---------------------------------------------------------------------------

  const jumpToMarker = useCallback(
    (position: number): void => {
      const ta = bodyRef.current;
      if (!ta) return;
      const marker = `[[cite:${position}]]`;
      const idx = body.indexOf(marker);
      if (idx < 0) {
        ta.focus();
        return;
      }
      ta.focus();
      ta.selectionStart = idx;
      ta.selectionEnd = idx + marker.length;
      // Crude scroll: jump the caret into view by approximating line
      // height. The textarea handles the rest.
      const lineHeight = 20;
      const lineNumber = (body.slice(0, idx).match(/\n/g) ?? []).length;
      ta.scrollTop = Math.max(0, lineNumber * lineHeight - 80);
    },
    [body],
  );

  // ---------------------------------------------------------------------------
  // Save (draft) — POST or PATCH depending on mode.
  // ---------------------------------------------------------------------------

  async function onSave(): Promise<void> {
    setError(null);
    if (title.trim().length === 0) {
      setError('Title is required.');
      return;
    }
    if (title.length > 200) {
      setError('Title must be 200 characters or fewer.');
      return;
    }
    if (body.trim().length === 0) {
      setError('Body is required.');
      return;
    }
    if (body.length > 16000) {
      setError('Body must be 16,000 characters or fewer.');
      return;
    }
    // Client-side hard reject for the structural gates the server will
    // also enforce. Marker/citation mismatches are surfaced as warnings
    // (permissive draft save) but a non-dense position set blocks save
    // because the server rejects it deterministically with 422 — the rep
    // should fix it before the round-trip.
    const hardIssues = issues.filter(
      (i) => i.kind === 'duplicate_position' || i.kind === 'non_dense_positions',
    );
    if (hardIssues.length > 0) {
      setError(hardIssues[0]!.message);
      return;
    }

    setSaving(true);
    try {
      const apiCitations: ReadonlyArray<RecommendationCitation> = citations
        .map((c) => ({
          statuteCode: c.statuteCode,
          clauseId: c.clauseId,
          versionDate: c.versionDate,
          position: c.position,
        }))
        .sort((a, b) => a.position - b.position);

      if (typeof mode === 'object' && mode.kind === 'edit') {
        const patchBody: PatchRecommendationBody = {
          title: title.trim(),
          body,
          citations: apiCitations,
        };
        await recommendationsApi.patch(mode.id, patchBody);
        onSaved(mode.id);
      } else {
        const createBody: CreateRecommendationBody = {
          title: title.trim(),
          body,
          jurisdiction,
          ...(apiCitations.length > 0 ? { citations: apiCitations } : {}),
        };
        const created = await recommendationsApi.create(createBody);
        onSaved(created.id);
      }
    } catch (e) {
      if (e instanceof RecommendationApiError) {
        if (e.status === 422) {
          const body = e.body as { error?: string } | undefined;
          // Surface the server's specific rejection so the rep knows
          // what to fix (the marker / corpus drift cases are the
          // common ones at draft save).
          setError(
            body?.error
              ? `Server rejected the draft (${body.error}). Recheck citations.`
              : 'The server rejected the draft. Recheck citations and try again.',
          );
        } else if (e.status === 400) {
          setError('The form did not validate on the server. Check field lengths and try again.');
        } else if (e.status === 401) {
          setError('Sign-in expired. Reload the page and try again.');
        } else {
          setError(`Could not save draft (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
      className="space-y-4"
      noValidate
    >
      {/* Title */}
      <FormSection label="Title" htmlFor="rec-title" hint={`${title.length} / 200`}>
        <input
          id="rec-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          aria-required="true"
          placeholder="One-line summary (e.g. 'Install secondary guard on shrink-wrap rollers')"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </FormSection>

      {/* Jurisdiction (only on the create path; the edit view hides this) */}
      {!isEdit ? (
        <JurisdictionRadio value={jurisdiction} onChange={(j) => setJurisdiction(j)} />
      ) : (
        <JurisdictionImmutableNote jurisdiction={jurisdiction} />
      )}

      {/* Body + citation insertion */}
      <FormSection label="Body" htmlFor="rec-body" hint={`${body.length} / 16,000`}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Use the <span className="font-mono">[[cite:N]]</span> markers to anchor citations. The
            picker inserts the marker at your cursor and adds the citation row below.
          </p>
          <CitationRefButton onInsert={onInsertCitation} disabled={saving} />
        </div>
        <textarea
          ref={bodyRef}
          id="rec-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={16000}
          rows={14}
          required
          aria-required="true"
          placeholder="Describe the recommended action, the hazard or condition it addresses, and the statutory anchor."
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <BodyMarkerPreview body={body} />
      </FormSection>

      {/* Citations table */}
      <CitationsTable citations={citations} onJump={jumpToMarker} onRemove={onRemoveCitation} />

      {/* Inline validator warnings (do not block save unless they're the
          structural hard-rejects already trapped above). */}
      {issues.length > 0 ? <ValidatorWarnings issues={issues} /> : null}

      {/* Save error */}
      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
        >
          {error}
        </div>
      ) : null}

      {/* Action row */}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={saving}>
          <Save className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save draft'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Saving a draft does NOT submit the recommendation. Submission (from the detail view) starts
        the statutory clock and creates the linked action item.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FormSection({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-end justify-between gap-2">
        <label
          htmlFor={htmlFor}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {label}
        </label>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function JurisdictionRadio({
  value,
  onChange,
}: {
  value: RecommendationJurisdiction;
  onChange: (j: RecommendationJurisdiction) => void;
}): JSX.Element {
  return (
    <fieldset className="rounded-md border border-border bg-card p-3">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Jurisdiction
      </legend>
      <p className="mb-2 text-xs text-muted-foreground">
        Determines the statutory clock: <strong>ON</strong> = 21 days under{' '}
        <span className="font-mono">OHSA s.9(21)</span>; <strong>CA-FED</strong> = &ldquo;as soon as
        possible&rdquo; under <span className="font-mono">CLC s.135(6)</span>. This choice is{' '}
        <em>immutable</em> after first save.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {recommendationJurisdiction.map((j) => {
          const active = value === j;
          return (
            <label
              key={j}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-foreground hover:bg-muted',
              )}
            >
              <input
                type="radio"
                name="jurisdiction"
                value={j}
                checked={active}
                onChange={() => onChange(j)}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{j}</span>
                <span className="block text-xs text-muted-foreground">
                  {j === 'ON'
                    ? 'Ontario OHSA — 21-day hard clock at submit.'
                    : 'Canada Labour Code Part II — informational, no fixed clock.'}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function JurisdictionImmutableNote({
  jurisdiction,
}: {
  jurisdiction: RecommendationJurisdiction;
}): JSX.Element {
  return (
    <div
      data-testid="jurisdiction-immutable-note"
      className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground"
    >
      <span className="font-medium text-foreground">Jurisdiction: {jurisdiction}</span> — immutable
      after first save. The per-jurisdiction recommendation number is already allocated under this
      sequence.
    </div>
  );
}

function BodyMarkerPreview({ body }: { body: string }): JSX.Element | null {
  const positions = parseMarkerPositions(body);
  if (positions.length === 0) return null;
  const counts = new Map<number, number>();
  for (const p of positions) counts.set(p, (counts.get(p) ?? 0) + 1);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <span className="uppercase tracking-wide">Markers in body:</span>
      {[...counts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([pos, count]) => (
          <span
            key={pos}
            className="inline-flex items-center rounded border border-border bg-background px-1.5 py-0.5 font-mono text-foreground"
          >
            [{pos}]{count > 1 ? <span className="ml-1">×{count}</span> : null}
          </span>
        ))}
    </div>
  );
}

function CitationsTable({
  citations,
  onJump,
  onRemove,
}: {
  citations: ReadonlyArray<DraftCitation>;
  onJump: (position: number) => void;
  onRemove: (position: number) => void;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card">
      <header className="border-b border-border p-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Citations ({citations.length})
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Each row pins to the (statute, clause, version date) triple. Removing a row also strips
          its <span className="font-mono">[[cite:N]]</span> marker from the body and renumbers
          remaining citations.
        </p>
      </header>
      {citations.length === 0 ? (
        <div className="p-4 text-center text-sm text-muted-foreground">
          No citations yet. Use <strong>Insert citation</strong> to pin a clause from the legal
          corpus.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {[...citations]
            .sort((a, b) => a.position - b.position)
            .map((c) => (
              <li
                key={`${c.position}-${c.clauseId}`}
                className="flex flex-wrap items-start gap-3 p-3"
              >
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-secondary text-xs font-mono font-semibold text-secondary-foreground">
                  {c.position}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">
                    {c.statuteCode} {c.citation}
                  </div>
                  {c.heading ? (
                    <div className="text-xs text-muted-foreground">{c.heading}</div>
                  ) : null}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Version <span className="font-mono tabular-nums">{c.versionDate}</span> · Clause{' '}
                    <span className="font-mono tabular-nums">{c.clauseId.slice(0, 8)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => onJump(c.position)}
                  >
                    <MapPin className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                    Jump
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-status-rejected"
                    onClick={() => onRemove(c.position)}
                    aria-label={`Remove citation ${c.position}`}
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function ValidatorWarnings({ issues }: { issues: ReadonlyArray<ValidationIssue> }): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
    >
      <div className="mb-1 font-medium">Citation / marker mismatches</div>
      <ul className="space-y-1">
        {issues.map((i, idx) => (
          <li key={idx}>{i.message}</li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-amber-700">
        Draft save is permissive — these warnings are surfaced but do not block saving. The server
        enforces the strict gate at submit (every marker must have a citation row in the live
        corpus, and vice versa).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-export the DraftCitation interface so the edit view can hydrate
// initial state with citation rows pulled from GET /:id + reveal.
// ---------------------------------------------------------------------------

export type { DraftCitation };
