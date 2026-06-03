// /recommendations/:id — decrypted reveal + lifecycle controls.
//
// IMPORTANT:
//   - Does NOT auto-fetch the reveal endpoint on mount. The user must tap
//     "Reveal" — step-up is intentional friction (mirror of T-I12 from
//     1.8 finding-detail). The detail metadata IS fetched on mount
//     because it's PI-clean (presence flags + counts + timestamps only).
//   - On 401 step_up_required the API client dispatches the
//     stepUpEmitter; the global modal opens and the caller re-clicks
//     Reveal after the modal closes.
//   - Lifecycle controls render conditionally on status — draft shows
//     edit + submit + withdraw; submitted shows capture-response +
//     withdraw; response_received shows resolve + withdraw + more
//     responses; resolved + withdrawn are read-only.
//
// Statutory anchor copy (ADR-0008 §3.6):
//   - ON jurisdiction: "OHSA s.9(21) — written response required within
//     21 days." Days remaining badge derives from the server-computed
//     deadline.
//   - CA-FED jurisdiction: "CLC s.135(6) — no fixed clock; written
//     response required 'as soon as possible.'" No countdown.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CalendarClock,
  ChevronLeft,
  Download,
  Edit3,
  Eye,
  FileSignature,
  Link2,
  Lock,
  MessageSquarePlus,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RecommendationResolveDialog } from '@/components/recommendation-resolve-dialog';
import { RecommendationResponseSheet } from '@/components/recommendation-response-sheet';
import {
  REASON_LABELS as WITHDRAW_REASON_LABELS,
  RecommendationWithdrawDialog,
} from '@/components/recommendation-withdraw-dialog';
import { legalApi, type LegalClause } from '@/legal/api';
import {
  isStepUpRequired,
  RecommendationApiError,
  recommendationsApi,
  type CreateRecommendationExportResponse,
  type RecommendationCitation,
  type RecommendationDetail,
  type RecommendationReveal,
} from '@/recommendations/api';
import {
  DeadlineBadge,
  JurisdictionBadge,
  RecommendationStatusBadge,
} from '@/recommendations/components';
import { recommendationDeadlineState } from '@jhsc/shared-types';
import { NetworkRequiredError } from '@/sync/typed-client';
import { NetworkRequiredBanner } from '@/sync/components/network-required-banner';
import { db } from '@/sync/db';

export function RecommendationDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return <div className="p-4 text-sm text-status-rejected">Invalid recommendation id.</div>;
  }
  return <RecommendationDetailInner key={id} id={id} />;
}

function RecommendationDetailInner({ id }: { id: string }): JSX.Element {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RecommendationDetail | null>(null);
  const [reveal, setReveal] = useState<RecommendationReveal | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    'submit' | 'withdraw' | 'resolve' | 'response' | null
  >(null);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [responseSheetOpen, setResponseSheetOpen] = useState(false);
  const [networkRequired, setNetworkRequired] = useState(false);
  // ADR §3.12 offline-submit clock notice: true when a submit op is
  // enqueued (sync_queue row present for this recommendation) but the
  // server hasn't yet recorded the submission (status still 'draft').
  const [submitEnqueued, setSubmitEnqueued] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const fresh = await recommendationsApi.get(id);
      setDetail(fresh);
    } catch (e) {
      if (e instanceof RecommendationApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    recommendationsApi
      .get(id)
      .then((fresh) => {
        if (!cancelled) setDetail(fresh);
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

  // Reveal handler — intentionally NOT called on mount.
  const onReveal = useCallback(async (): Promise<void> => {
    setRevealing(true);
    setError(null);
    setNeedsStepUp(false);
    setNetworkRequired(false);
    try {
      const r = await recommendationsApi.reveal(id);
      if (isStepUpRequired(r)) {
        setNeedsStepUp(true);
        return;
      }
      setReveal(r);
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setNetworkRequired(true);
      } else if (e instanceof RecommendationApiError && e.status === 404) {
        setNotFound(true);
      } else if (e instanceof RecommendationApiError && e.status === 503) {
        setNetworkRequired(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRevealing(false);
    }
  }, [id]);

  // ADR §3.12 — refresh the "submit enqueued?" flag whenever the detail
  // refreshes. We check Dexie for a sync_queue row with entityKind
  // 'recommendation' and an op kind that maps to submit (the typed-
  // client wraps submit as a transition; we look for ANY pending op for
  // this entityLocalId while status is still draft).
  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      try {
        const rows = await db.sync_queue.where('entityLocalId').equals(id).toArray();
        const pending = rows.some(
          (r) =>
            r.entityKind === 'recommendation' &&
            (r.state === 'queued' || r.state === 'in_flight') &&
            r.endpoint.endsWith('/submit'),
        );
        if (!cancelled) setSubmitEnqueued(pending);
      } catch {
        if (!cancelled) setSubmitEnqueued(false);
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [id, detail?.status]);

  async function onSubmit(): Promise<void> {
    setSubmitConfirmOpen(false);
    setPendingAction('submit');
    setActionError(null);
    try {
      await recommendationsApi.submit(id);
      await refresh();
    } catch (e) {
      if (e instanceof RecommendationApiError) {
        if (e.status === 422) {
          const errBody = e.body as { error?: string } | undefined;
          if (errBody?.error === 'citation_corpus_drift') {
            setActionError(
              'A cited clause is no longer in the active corpus. Edit the recommendation and update the citation, then try again.',
            );
          } else if (errBody?.error === 'citation_marker_mismatch') {
            setActionError(
              'A [[cite:N]] marker does not match the citation rows. Edit the recommendation to align them.',
            );
          } else if (errBody?.error === 'not_draft_state') {
            setActionError('This recommendation is no longer in draft state.');
          } else {
            setActionError(`Could not submit (${errBody?.error ?? 'rejected'}).`);
          }
        } else if (e.status === 401) {
          setActionError('Sign-in expired. Reload the page and try again.');
        } else {
          setActionError(`Could not submit (HTTP ${e.status}).`);
        }
      } else {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPendingAction(null);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8">
        <Link
          to="/recommendations"
          className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          Back to recommendations
        </Link>
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          That recommendation does not exist.
        </div>
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-md border border-status-rejected/40 bg-status-rejected/10 p-4 text-sm text-status-rejected">
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

  const deadline = detail.deadline ? new Date(detail.deadline) : null;
  const dlState = recommendationDeadlineState(new Date(), deadline);

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 md:px-6 md:py-6">
      <Link
        to="/recommendations"
        data-print="hide"
        className="mb-3 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Back to recommendations
      </Link>

      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-foreground">
            #{detail.recommendationNumber}
          </span>
          <JurisdictionBadge jurisdiction={detail.jurisdiction} />
          <RecommendationStatusBadge status={detail.status} />
          {detail.status === 'submitted' || detail.status === 'response_received' ? (
            <DeadlineBadge state={dlState} deadline={deadline} jurisdiction={detail.jurisdiction} />
          ) : null}
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Recommendation #{detail.recommendationNumber}
        </h1>
        <Timeline detail={detail} />
      </header>

      {/* Statutory anchor / 21-day clock visualization */}
      <StatutoryAnchor detail={detail} deadline={deadline} dlState={dlState} />

      {/* ADR §3.12 offline-submit clock copy — only when a submit op is
       * enqueued but not yet drained. Rights-protective tone: legally
       * accurate, not anxiety-inducing. */}
      {submitEnqueued && detail.status === 'draft' ? (
        <OfflineSubmitClockNotice jurisdiction={detail.jurisdiction} />
      ) : null}

      {/* Network-required banner — surfaced when reveal/export hits a
       * 503 network_required (T-S26: encrypted reveal is online-only). */}
      {networkRequired ? (
        <div className="mb-3">
          <NetworkRequiredBanner action="This action" onDismiss={() => setNetworkRequired(false)} />
        </div>
      ) : null}

      {/* Action / state error surface */}
      {actionError ? (
        <div
          role="alert"
          aria-live="polite"
          className="mb-4 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-3 text-sm text-status-rejected"
        >
          {actionError}
        </div>
      ) : null}

      {/* Reveal / decrypted body */}
      {reveal ? (
        <RevealedSection
          reveal={reveal}
          citationRows={detail.citations}
          linkedActionItemId={detail.linkedActionItemId}
        />
      ) : (
        <MaskedSection
          needsStepUp={needsStepUp}
          revealing={revealing}
          error={error}
          onReveal={() => {
            void onReveal();
          }}
        />
      )}

      {/* Linked action item (always render when present) */}
      {detail.linkedActionItemId ? (
        <LinkedActionItem actionItemId={detail.linkedActionItemId} />
      ) : null}

      {/* Signed-bundle export — shown for any state past draft. */}
      {detail.status !== 'draft' ? <ExportPanel recommendationId={detail.id} /> : null}

      {/* Lifecycle controls */}
      <LifecycleControls
        detail={detail}
        pendingAction={pendingAction}
        onEdit={() => navigate(`/recommendations/${encodeURIComponent(detail.id)}/edit`)}
        onSubmit={() => setSubmitConfirmOpen(true)}
        onResponse={() => setResponseSheetOpen(true)}
        onResolve={() => setResolveOpen(true)}
        onWithdraw={() => setWithdrawOpen(true)}
      />

      {/* Responses summary (presence + counts only — body lives in reveal) */}
      <ResponsesSummary detail={detail} reveal={reveal} />

      <div className="mt-6 text-xs text-muted-foreground">
        Recommendation drafting, submission, response capture, resolution, and withdrawal are all
        anchored in the audit chain. Decrypted reveal requires step-up authentication with a
        60-second freshness window.
      </div>

      <div className="mt-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/recommendations')}>
          Done
        </Button>
      </div>

      {/* Confirm dialogs / sheets */}
      <SubmitConfirmDialog
        open={submitConfirmOpen}
        detail={detail}
        onClose={() => setSubmitConfirmOpen(false)}
        onConfirm={() => {
          void onSubmit();
        }}
      />
      <RecommendationResponseSheet
        open={responseSheetOpen}
        recommendationId={detail.id}
        onClose={() => setResponseSheetOpen(false)}
        onCaptured={() => {
          setResponseSheetOpen(false);
          void refresh();
        }}
      />
      <RecommendationWithdrawDialog
        open={withdrawOpen}
        recommendationId={detail.id}
        hasLinkedActionItem={detail.linkedActionItemId !== null}
        onClose={() => setWithdrawOpen(false)}
        onWithdrawn={() => {
          setWithdrawOpen(false);
          void refresh();
        }}
      />
      <RecommendationResolveDialog
        open={resolveOpen}
        recommendationId={detail.id}
        linkedActionItemId={detail.linkedActionItemId}
        onClose={() => setResolveOpen(false)}
        onResolved={() => {
          setResolveOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline — drafted_at → submitted_at → resolved/withdrawn_at
// ---------------------------------------------------------------------------

function Timeline({ detail }: { detail: RecommendationDetail }): JSX.Element {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>drafted {new Date(detail.draftedAt).toLocaleString()}</span>
      <span>·</span>
      <span>
        by <span className="font-mono tabular-nums">{detail.draftedByUserId.slice(0, 8)}</span>
      </span>
      {detail.submittedAt ? (
        <>
          <span>·</span>
          <span>submitted {new Date(detail.submittedAt).toLocaleString()}</span>
        </>
      ) : null}
      {detail.resolvedAt ? (
        <>
          <span>·</span>
          <span>resolved {new Date(detail.resolvedAt).toLocaleString()}</span>
        </>
      ) : null}
      {detail.withdrawnAt ? (
        <>
          <span>·</span>
          <span>withdrawn {new Date(detail.withdrawnAt).toLocaleString()}</span>
          {detail.withdrawnReason ? (
            <>
              <span>·</span>
              {/*
                1.9 S5 priv-F4 close-out: translate the enum into the
                friendly label that the withdraw dialog already uses.
                The PI-clean enum (`addressed_pre_submission`) is what
                the chain payload would surface — but the timeline is
                rep-facing UI, so use the human label here. Fall back
                to the raw enum value if a future enum addition lands
                without a label entry (defensive).
              */}
              <span>
                reason:{' '}
                {WITHDRAW_REASON_LABELS[
                  detail.withdrawnReason as keyof typeof WITHDRAW_REASON_LABELS
                ]?.label ?? detail.withdrawnReason}
              </span>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statutory anchor — the 21-day clock visualization for ON, the
// informational copy for CA-FED.
// ---------------------------------------------------------------------------

function StatutoryAnchor({
  detail,
  deadline,
  dlState,
}: {
  detail: RecommendationDetail;
  deadline: Date | null;
  dlState: ReturnType<typeof recommendationDeadlineState>;
}): JSX.Element | null {
  // Only meaningful once the recommendation has been submitted.
  if (detail.status !== 'submitted' && detail.status !== 'response_received') {
    return null;
  }
  const overdue = dlState === 'overdue';
  return (
    <section
      aria-labelledby="statutory-anchor-heading"
      className={cn(
        'mb-4 rounded-md border bg-card p-4',
        overdue ? 'border-red-300' : 'border-border',
      )}
    >
      <h2
        id="statutory-anchor-heading"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <CalendarClock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Statutory clock
      </h2>
      {detail.jurisdiction === 'ON' ? (
        <div className="text-sm text-foreground">
          <span className="font-mono">OHSA s.9(21)</span> — written response required within 21
          days.
          {deadline ? (
            <>
              {' '}
              Due by <strong>{deadline.toLocaleDateString()}</strong>{' '}
              <span className="text-xs text-muted-foreground">({deadline.toLocaleString()})</span>.
            </>
          ) : null}
          {overdue ? (
            <span className="ml-2 inline-flex items-center gap-1 text-red-700">
              <ShieldAlert className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              Overdue.
            </span>
          ) : null}
        </div>
      ) : (
        <div className="text-sm text-foreground">
          <span className="font-mono">CLC s.135(6)</span> — written response required &ldquo;as soon
          as possible.&rdquo; No fixed clock.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Masked + Revealed body sections
// ---------------------------------------------------------------------------

function MaskedSection({
  needsStepUp,
  revealing,
  error,
  onReveal,
}: {
  needsStepUp: boolean;
  revealing: boolean;
  error: string | null;
  onReveal: () => void;
}): JSX.Element {
  return (
    <section
      aria-labelledby="recommendation-masked-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="recommendation-masked-heading"
        className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Title encrypted · Reveal to read
      </h2>
      <p className="text-sm text-muted-foreground">
        The title, body, and management responses are encrypted at rest. Revealing them requires
        step-up authentication (passkey or TOTP, 60-second freshness window). The decrypted text is
        rendered with citation markers replaced by footnote links.
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

function RevealedSection({
  reveal,
  citationRows,
  linkedActionItemId,
}: {
  reveal: RecommendationReveal;
  citationRows: ReadonlyArray<RecommendationCitation>;
  linkedActionItemId: string | null;
}): JSX.Element {
  return (
    <section
      aria-labelledby="recommendation-revealed-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="recommendation-revealed-heading"
        className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Decrypted
      </h2>
      <h3 className="text-base font-semibold text-foreground">{reveal.title}</h3>
      <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        <BodyWithFootnotes body={reveal.body} citations={citationRows} />
      </div>
      {citationRows.length > 0 ? <CitationsFootnoteList citations={citationRows} /> : null}
      {linkedActionItemId ? (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Link2 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Linked to action item{' '}
          <span className="font-mono tabular-nums">{linkedActionItemId.slice(0, 8)}</span>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Body with footnotes — replace [[cite:N]] markers with clickable [N] links
// that scroll to the citations footnote list below.
// ---------------------------------------------------------------------------

const BODY_MARKER_RE = /\[\[cite:(\d+)\]\]/g;

function BodyWithFootnotes({
  body,
  citations,
}: {
  body: string;
  citations: ReadonlyArray<RecommendationCitation>;
}): JSX.Element {
  const positions = new Set(citations.map((c) => c.position));
  const parts: Array<JSX.Element | string> = [];
  let cursor = 0;
  let keyCounter = 0;
  for (const match of body.matchAll(BODY_MARKER_RE)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) {
      parts.push(body.slice(cursor, match.index));
    }
    const n = Number(match[1]);
    if (positions.has(n)) {
      parts.push(
        <a
          key={`m-${keyCounter++}`}
          href={`#citation-${n}`}
          className="mx-0.5 inline-flex items-baseline rounded bg-primary/10 px-1 text-[11px] font-mono font-semibold text-primary no-underline hover:bg-primary/20 focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label={`Footnote ${n}`}
          onClick={(e) => {
            e.preventDefault();
            const target = document.getElementById(`citation-${n}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
        >
          [{n}]
        </a>,
      );
    } else {
      // Orphan marker — render the literal text so the rep sees the
      // problem when re-reading the decrypted body.
      parts.push(
        <span
          key={`o-${keyCounter++}`}
          className="rounded bg-amber-50 px-0.5 font-mono text-[11px] text-amber-800"
          title={`No citation row for marker [${n}]`}
        >
          [[cite:{n}]]
        </span>,
      );
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));
  return <>{parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : p))}</>;
}

// ---------------------------------------------------------------------------
// Citation footnote list — resolves each (statuteCode, clauseId,
// versionDate) triple via the legal-corpus API client and renders the
// entry's heading + body text. This is the read-time equivalent of the
// CitationCard hover pattern (CLAUDE.md "Citation Hover" signature
// interaction).
// ---------------------------------------------------------------------------

function CitationsFootnoteList({
  citations,
}: {
  citations: ReadonlyArray<RecommendationCitation>;
}): JSX.Element {
  return (
    <ol className="mt-4 list-none space-y-2 border-t border-border pt-3 text-xs">
      {[...citations]
        .sort((a, b) => a.position - b.position)
        .map((c) => (
          <li key={c.position} id={`citation-${c.position}`}>
            <CitationFootnote citation={c} />
          </li>
        ))}
    </ol>
  );
}

function CitationFootnote({ citation }: { citation: RecommendationCitation }): JSX.Element {
  const [clause, setClause] = useState<LegalClause | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    legalApi
      .getClause(citation.clauseId)
      .then((c) => {
        if (!cancelled) setClause(c);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [citation.clauseId]);
  return (
    <div className="flex gap-2">
      <span className="font-mono font-semibold text-primary">[{citation.position}]</span>
      <div className="flex-1">
        <div className="font-medium text-foreground">
          {citation.statuteCode}
          {clause ? ` ${clause.citation}` : ''} ·{' '}
          <span className="text-muted-foreground">{citation.versionDate}</span>
        </div>
        {missing ? (
          <div className="text-status-rejected">
            Clause no longer in the active corpus. The historical record remains queryable via the
            (statute, clause id, version date) triple above.
          </div>
        ) : !clause ? (
          <div className="text-muted-foreground">Loading clause…</div>
        ) : (
          <>
            {clause.heading ? <div className="text-muted-foreground">{clause.heading}</div> : null}
            {clause.bodyKind === 'full_text' && clause.body ? (
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-foreground">{clause.body}</p>
            ) : clause.bodyKind === 'summary' && clause.bodySummary ? (
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap italic text-foreground">
                {clause.bodySummary}
              </p>
            ) : null}
            <div className="mt-1">
              <a
                href={clause.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Source ↗
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linked action item card
// ---------------------------------------------------------------------------

function LinkedActionItem({ actionItemId }: { actionItemId: string }): JSX.Element {
  return (
    <section
      aria-labelledby="linked-action-item-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="linked-action-item-heading"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Link2 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Linked action item
      </h2>
      <p className="text-sm text-muted-foreground">
        The bridge action item lives in the minutes&apos; <strong>recommendation</strong> section
        and tracks management&apos;s response.
      </p>
      <div className="mt-2">
        <Button asChild variant="outline" size="sm">
          <Link to={`/action-items/${encodeURIComponent(actionItemId)}`}>
            Open action item{' '}
            <span className="font-mono tabular-nums">{actionItemId.slice(0, 8)}</span>
          </Link>
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle controls — render conditionally on status.
// ---------------------------------------------------------------------------

function LifecycleControls({
  detail,
  pendingAction,
  onEdit,
  onSubmit,
  onResponse,
  onResolve,
  onWithdraw,
}: {
  detail: RecommendationDetail;
  pendingAction: 'submit' | 'withdraw' | 'resolve' | 'response' | null;
  onEdit: () => void;
  onSubmit: () => void;
  onResponse: () => void;
  onResolve: () => void;
  onWithdraw: () => void;
}): JSX.Element | null {
  if (detail.status === 'resolved' || detail.status === 'withdrawn') {
    return (
      <section
        aria-labelledby="lifecycle-readonly-heading"
        className="mb-4 rounded-md border border-border bg-secondary/30 p-4 text-xs text-muted-foreground"
      >
        <h2 id="lifecycle-readonly-heading" className="sr-only">
          Lifecycle controls
        </h2>
        Read-only — this recommendation has been{' '}
        {detail.status === 'resolved' ? 'resolved' : 'withdrawn'}.
      </section>
    );
  }
  const submitting = pendingAction === 'submit';
  return (
    <section
      aria-labelledby="lifecycle-heading"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-4"
    >
      <h2 id="lifecycle-heading" className="sr-only">
        Lifecycle controls
      </h2>
      {detail.status === 'draft' ? (
        <>
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Edit3 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Edit
          </Button>
          <Button type="button" size="sm" disabled={submitting} onClick={onSubmit}>
            <Send className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {submitting ? 'Submitting…' : 'Submit'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onWithdraw}>
            <XCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Withdraw
          </Button>
        </>
      ) : detail.status === 'submitted' ? (
        <>
          <Button type="button" size="sm" onClick={onResponse}>
            <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Capture response
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onWithdraw}>
            <XCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Withdraw
          </Button>
        </>
      ) : detail.status === 'response_received' ? (
        <>
          <Button type="button" size="sm" onClick={onResolve}>
            <FileSignature className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Resolve
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onResponse}>
            <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Capture additional response
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onWithdraw}>
            <XCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Withdraw
          </Button>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Responses summary — presence + counts; the decrypted bodies come from
// the reveal endpoint and render below when available.
// ---------------------------------------------------------------------------

function ResponsesSummary({
  detail,
  reveal,
}: {
  detail: RecommendationDetail;
  reveal: RecommendationReveal | null;
}): JSX.Element | null {
  if (detail.responses.length === 0) return null;
  return (
    <section
      aria-labelledby="responses-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="responses-heading"
        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <ScrollText className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Responses ({detail.responses.length})
      </h2>
      <ul className="space-y-2">
        {detail.responses.map((r) => {
          const revealed = reveal?.responses.find((rr) => rr.id === r.id) ?? null;
          return (
            <li key={r.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">#{r.position}</span>
                <span>·</span>
                <span>{new Date(r.receivedAt).toLocaleString()}</span>
                <span>·</span>
                <span>
                  captured by{' '}
                  <span className="font-mono tabular-nums">{r.receivedByUserId.slice(0, 8)}</span>
                </span>
              </div>
              {revealed ? (
                <div className="mt-2">
                  <div className="text-xs font-medium text-foreground">{revealed.authorRole}</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {revealed.body}
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  Author role + body encrypted · use Reveal above to decrypt all responses at once.
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Submit confirm dialog — rights-protective copy that explains downstream
// consequences without discouraging submission.
// ---------------------------------------------------------------------------

function SubmitConfirmDialog({
  open,
  detail,
  onClose,
  onConfirm,
}: {
  open: boolean;
  detail: RecommendationDetail;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="submit-confirm-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="submit-confirm-title"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          Submit recommendation #{detail.recommendationNumber}?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Submitting creates a tracked Action Item in the next meeting&apos;s{' '}
          <strong>recommendation</strong> section.
          {detail.jurisdiction === 'ON'
            ? ' The 21-day s.9(21) clock starts now.'
            : ' Under CLC s.135(6) the response is required “as soon as possible.”'}{' '}
          The chain of custody captures the submission timestamp, citation snapshot, and linked
          action item id.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            <Send className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExportPanel — signed-bundle export (ADR-0008 §3.8 / §3.9).
//
// Click "Export signed bundle" -> POST /api/recommendations/:id/exports.
// On 401 the API wrapper dispatches stepUpEmitter(recommendation.export.<id>)
// so the global modal opens; the rep retries after the modal closes.
//
// On success the panel surfaces a receipt (export id + sha-prefixes +
// signing key id + citations hash + byte size + expiry) plus a
// Download button that opens the ZIP blob in a new tab (5s revoke +
// noopener,noreferrer; mirror of 1.7 evidence reveal sec-F10 +
// 1.8 inspections download).
//
// The receipt copy is rights-protective: the panel explains WHAT is
// in the bundle (signed PDF + manifest + signature) and HOW the
// recipient verifies it. The actual chain anchor + signature scope
// is documented inline so the rep can reason about the artifact.
// ---------------------------------------------------------------------------

function ExportPanel({ recommendationId }: { recommendationId: string }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<CreateRecommendationExportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [networkRequired, setNetworkRequired] = useState(false);

  async function startExport(): Promise<void> {
    setBusy(true);
    setError(null);
    setNetworkRequired(false);
    try {
      const r = await recommendationsApi.exports.create(recommendationId);
      setReceipt(r);
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setNetworkRequired(true);
        return;
      }
      if (e instanceof RecommendationApiError) {
        if (e.status === 503) {
          setNetworkRequired(true);
          return;
        }
        if (e.status === 401) {
          setError('Re-authenticate to export. The step-up dialog should be open.');
        } else if (e.status === 422) {
          const body = e.body as { error?: string } | undefined;
          if (body?.error === 'cannot_export_draft') {
            setError(
              'Draft recommendations cannot be exported. Submit it first, then export the signed bundle.',
            );
          } else {
            setError(`Could not export (${body?.error ?? 'rejected'}).`);
          }
        } else if (e.status === 429) {
          setError('Export rate limit reached. Try again in an hour.');
        } else if (e.status === 500) {
          const body = e.body as { error?: string } | undefined;
          if (body?.error === 'workplace_signing_key_missing') {
            setError(
              'The workplace signing key has not been seeded. Complete first-run setup, then retry.',
            );
          } else if (body?.error === 'citation_corpus_missing') {
            setError(
              'A cited corpus row could not be resolved. This usually means a re-seed occurred between submit and export; contact ops.',
            );
          } else {
            setError(`Could not export (HTTP ${e.status}).`);
          }
        } else {
          setError(`Could not export (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport(): Promise<void> {
    if (!receipt) return;
    setBusy(true);
    setError(null);
    setNetworkRequired(false);
    try {
      const blob = await recommendationsApi.exports.download(receipt.exportId);
      const url = URL.createObjectURL(blob);
      // sec-F10 mirror: noopener,noreferrer + revoke after 5s. The
      // server's Content-Disposition: attachment is the primary
      // mechanism; this is belt-and-suspenders.
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      if (e instanceof NetworkRequiredError) {
        setNetworkRequired(true);
      } else if (e instanceof RecommendationApiError && e.status === 401) {
        setError('Re-authenticate to download. The step-up dialog should be open.');
      } else if (e instanceof RecommendationApiError && e.status === 503) {
        setNetworkRequired(true);
      } else if (e instanceof RecommendationApiError && e.status === 410) {
        setError('This export has expired (30-day TTL). Generate a new one.');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="export-panel-heading"
      className="mb-4 rounded-md border border-border bg-card p-4"
    >
      <h2
        id="export-panel-heading"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <ShieldCheck className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        Signed export bundle
      </h2>
      <p className="text-xs text-muted-foreground">
        The bundle is signed with the workplace signing key. The chain anchor records the SHA-256 of
        the PDF and the signature. Verification instructions live in the bundle&apos;s README.txt.
      </p>
      {networkRequired ? (
        <div className="mt-3">
          <NetworkRequiredBanner action="Export" onDismiss={() => setNetworkRequired(false)} />
        </div>
      ) : null}
      {receipt ? (
        <div className="mt-3 rounded-md border border-border bg-background p-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>
              Export{' '}
              <span className="font-mono tabular-nums text-foreground">
                {receipt.exportId.slice(0, 8)}
              </span>
            </span>
            <span>·</span>
            <span>
              pdf sha{' '}
              <span className="font-mono tabular-nums">{receipt.outputSha256.slice(0, 12)}</span>
            </span>
            <span>·</span>
            <span>
              sig sha{' '}
              <span className="font-mono tabular-nums">{receipt.signatureSha256.slice(0, 12)}</span>
            </span>
            <span>·</span>
            <span>
              signing key{' '}
              <span className="font-mono tabular-nums">{receipt.signingKeyId.slice(0, 8)}</span>
            </span>
            <span>·</span>
            <span>
              citations hash{' '}
              <span className="font-mono tabular-nums">{receipt.citationsHash.slice(0, 12)}</span>
            </span>
            <span>·</span>
            <span>{(receipt.byteSize / 1024).toFixed(1)} KB</span>
            <span>·</span>
            <span>expires {new Date(receipt.expiresAt).toLocaleDateString()}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void downloadExport();
              }}
            >
              <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              {busy ? 'Opening…' : 'Download bundle'}
            </Button>
            <Link
              to="/recommendations/exports"
              className="text-[11px] text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring"
            >
              All exports →
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            Step-up authentication required (60-second freshness window).
          </span>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => {
              void startExport();
            }}
          >
            <FileSignature className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {busy ? 'Exporting…' : 'Export signed bundle'}
          </Button>
        </div>
      )}
      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="mt-3 rounded-md border border-status-rejected/40 bg-status-rejected/10 p-2 text-xs text-status-rejected"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// OfflineSubmitClockNotice — ADR §3.12. Surfaces ONLY while a submit op
// is enqueued but not yet drained. Carries the explicit rights-protective
// 21-day clock copy: the s.9(21) clock starts when the SERVER records
// the submission, NOT when the rep typed it locally.
//
// Tone: legally accurate, not anxiety-inducing. Pairs amber + CalendarClock
// icon + textual label so it reads at a glance without color alone.
// ---------------------------------------------------------------------------

function OfflineSubmitClockNotice({ jurisdiction }: { jurisdiction: string }): JSX.Element {
  return (
    <section
      aria-labelledby="offline-submit-clock-heading"
      className="mb-4 rounded-md border border-status-pending/40 bg-status-pending/5 p-3 text-sm"
    >
      <h2
        id="offline-submit-clock-heading"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-status-pending"
      >
        <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        Submit queued — clock starts at server
      </h2>
      <p className="text-sm text-foreground">
        This submit will reach the server when you&apos;re back online.{' '}
        {jurisdiction === 'ON' ? (
          <>
            <strong>
              The 21-day s.9(21) clock starts when the server records the submission, NOT when you
              typed it.
            </strong>
          </>
        ) : (
          <>
            <strong>
              The CLC s.135(6) &ldquo;as soon as possible&rdquo; clock starts when the server
              records the submission, NOT when you typed it.
            </strong>
          </>
        )}{' '}
        If you&apos;re submitting time-sensitive content, sync when you can.
      </p>
    </section>
  );
}
