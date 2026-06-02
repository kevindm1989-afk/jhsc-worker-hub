// Bottom-sheet for capturing a management response to a submitted
// recommendation (ADR-0008 §3.4 append-only responses).
//
// Rights-protective copy (§2.9 T-R35 mitigation): emphasises accurate
// transcription. The rep is transcribing what management actually said,
// not editorialising. Both fields are encrypted server-side; the body is
// position-allocated under an advisory lock (T-R10).
//
// authorRole: ≤120 chars, e.g. "VP Operations" / "Plant Manager".
// body:       ≤8000 chars; long-form transcription of the written response.

import { useState } from 'react';
import { ScrollText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecommendationApiError, recommendationsApi } from '@/recommendations/api';

interface ResponseSheetProps {
  readonly open: boolean;
  readonly recommendationId: string;
  readonly onClose: () => void;
  readonly onCaptured: () => void;
}

export function RecommendationResponseSheet(props: ResponseSheetProps): JSX.Element | null {
  const { open, recommendationId, onClose, onCaptured } = props;
  const [authorRole, setAuthorRole] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function onSubmit(): Promise<void> {
    setError(null);
    if (authorRole.trim().length === 0) {
      setError('Author role is required.');
      return;
    }
    if (authorRole.length > 120) {
      setError('Author role must be 120 characters or fewer.');
      return;
    }
    if (body.trim().length === 0) {
      setError('Response body is required.');
      return;
    }
    if (body.length > 8000) {
      setError('Response body must be 8,000 characters or fewer.');
      return;
    }
    setSubmitting(true);
    try {
      await recommendationsApi.addResponse(recommendationId, {
        authorRole: authorRole.trim(),
        body,
      });
      onCaptured();
    } catch (e) {
      if (e instanceof RecommendationApiError) {
        if (e.status === 401) {
          setError('Sign-in expired. Reload the page and try again.');
        } else if (e.status === 422) {
          const errBody = e.body as { error?: string } | undefined;
          if (errBody?.error === 'cannot_capture_response_in_state') {
            setError('The recommendation is no longer accepting responses (status changed).');
          } else if (errBody?.error === 'response_cap_exceeded') {
            setError('Response cap of 50 reached on this recommendation.');
          } else {
            setError(`Could not save response (${errBody?.error ?? 'rejected'}).`);
          }
        } else {
          setError(`Could not save response (HTTP ${e.status}).`);
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="response-sheet-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-t-2xl bg-card p-6 pb-8 shadow-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            <ScrollText
              className="mt-0.5 h-5 w-5 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div>
              <h2
                id="response-sheet-title"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                Capture management response
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                You are transcribing management&apos;s written response <em>verbatim</em>. The chain
                of custody binds what you enter to this recommendation — accuracy matters.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="response-author-role"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Author role
            </label>
            <input
              id="response-author-role"
              type="text"
              value={authorRole}
              onChange={(e) => setAuthorRole(e.target.value)}
              maxLength={120}
              placeholder="e.g. VP Operations, Plant Manager"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Role title only. Encrypted at rest.
            </div>
          </div>

          <div>
            <label
              htmlFor="response-body"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Response body
            </label>
            <textarea
              id="response-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={8000}
              rows={8}
              placeholder="Paste or transcribe management's written response verbatim."
              className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {body.length} / 8,000 · Encrypted at rest.
            </div>
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
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void onSubmit();
            }}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Capture response'}
          </Button>
        </div>
      </div>
    </div>
  );
}
