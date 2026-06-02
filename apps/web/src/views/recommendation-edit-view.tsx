// /recommendations/:id/edit — Edit a draft-state recommendation.
//
// Reuses the RecommendationForm primitive from new-recommendation-view.
// The flow:
//   1) GET /:id to learn the jurisdiction + citation list (PI-clean).
//   2) Reveal /:id/reveal to fetch the decrypted title + body (step-up).
//   3) Hydrate the form initial state from both.
//   4) PATCH /:id on save.
//
// Jurisdiction radio is hidden — jurisdiction is immutable after first
// save per S2's jurisdiction_immutable_after_draft_save reject. The form
// displays an immutable-note banner instead.
//
// Step-up gating mirrors the detail view: the reveal is NOT auto-fetched;
// the user taps a Reveal button to surface the form. This is intentional
// friction (T-I12 mirror) — editing requires the same step-up freshness
// as reading.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Eye, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  isStepUpRequired,
  RecommendationApiError,
  recommendationsApi,
  type RecommendationDetail,
  type RecommendationReveal,
} from '@/recommendations/api';
import {
  RecommendationForm,
  type DraftCitation,
  type RecommendationFormInitial,
} from './new-recommendation-view';

export function RecommendationEditView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid recommendation id.</div>;
  }
  return <RecommendationEditInner key={id} id={id} />;
}

function RecommendationEditInner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RecommendationDetail | null>(null);
  const [reveal, setReveal] = useState<RecommendationReveal | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [notDraft, setNotDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    recommendationsApi
      .get(id)
      .then((fresh) => {
        if (cancelled) return;
        if (fresh.status !== 'draft') {
          setNotDraft(true);
        }
        setDetail(fresh);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof RecommendationApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onReveal = useCallback(async (): Promise<void> => {
    setRevealing(true);
    setError(null);
    setNeedsStepUp(false);
    try {
      const r = await recommendationsApi.reveal(id);
      if (isStepUpRequired(r)) {
        setNeedsStepUp(true);
        return;
      }
      setReveal(r);
    } catch (e) {
      if (e instanceof RecommendationApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevealing(false);
    }
  }, [id]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <BackLink id={id} />
        <div className="mt-3 rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          That recommendation does not exist.
        </div>
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <BackLink id={id} />
        <div className="mt-3 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
          {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (notDraft) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <BackLink id={id} />
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          This recommendation is in <strong>{detail.status}</strong> state and is no longer
          editable. Use the detail view to capture a response, resolve, or withdraw.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <BackLink id={id} />
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Edit recommendation #{detail.recommendationNumber}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Draft-state edits only. Jurisdiction is immutable; submitting is done from the detail
          view.
        </p>
      </header>

      {reveal ? (
        <RecommendationForm
          mode={{ kind: 'edit', id }}
          initial={hydrateInitial(detail, reveal)}
          onSaved={(savedId) => navigate(`/recommendations/${encodeURIComponent(savedId)}`)}
          onCancel={() => navigate(`/recommendations/${encodeURIComponent(id)}`)}
        />
      ) : (
        <RevealGate
          revealing={revealing}
          needsStepUp={needsStepUp}
          error={error}
          onReveal={() => {
            void onReveal();
          }}
        />
      )}
    </div>
  );
}

function BackLink({ id }: { id: string }): JSX.Element {
  return (
    <Link
      to={`/recommendations/${encodeURIComponent(id)}`}
      className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      Back to recommendation
    </Link>
  );
}

function RevealGate({
  revealing,
  needsStepUp,
  error,
  onReveal,
}: {
  revealing: boolean;
  needsStepUp: boolean;
  error: string | null;
  onReveal: () => void;
}): JSX.Element {
  return (
    <section className="rounded-md border border-border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Reveal to edit
      </h2>
      <p className="text-sm text-muted-foreground">
        Editing requires decrypting the existing title + body, which requires step-up authentication
        (60-second freshness window). After revealing, the form populates with the current values
        for editing.
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        {needsStepUp ? (
          <span className="text-xs text-status-pending">
            Step-up authentication required. Complete the prompt, then tap Reveal again.
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No decrypted text loaded yet.</span>
        )}
        <Button type="button" variant="default" size="sm" disabled={revealing} onClick={onReveal}>
          <Eye className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          {revealing ? 'Revealing…' : 'Reveal'}
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="mt-2 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}

function hydrateInitial(
  detail: RecommendationDetail,
  reveal: RecommendationReveal,
): RecommendationFormInitial {
  // The corpus picker side-channel data (heading / citation) is not on
  // the API DTO — we render rows with the raw clauseId-prefix label as a
  // graceful fallback. The detail view's reveal flow shows the rich
  // footnote rendering; the editor is a working surface.
  const citations: ReadonlyArray<DraftCitation> = detail.citations.map((c) => ({
    statuteCode: c.statuteCode,
    clauseId: c.clauseId,
    versionDate: c.versionDate,
    position: c.position,
    heading: null,
    citation: '',
  }));
  return {
    title: reveal.title,
    body: reveal.body,
    jurisdiction: detail.jurisdiction,
    citations,
  };
}
