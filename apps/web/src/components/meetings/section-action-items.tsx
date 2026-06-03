// Per-section action items list, embedded inside the meeting detail
// view's section accordion (Milestone 2.2 S3, ADR-0013 §3.9).
//
// Fetch path: GET /api/action-items?meetingId=<id>. The route returns
// the flat list (per the existing M1.6 surface); this component
// filters per-section client-side so a single network call hydrates
// every section in the meeting view. The list refreshes on each
// onChanged callback fired by a card mutation.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActionItemsApiError, actionItemsApi, type ActionItemListItem } from '@/action-items/api';
import { SectionActionItemCard } from './section-action-item-card';
import type { ActionItemSection } from '@jhsc/shared-types';

interface SectionActionItemsProps {
  readonly meetingId: string;
  readonly section: ActionItemSection;
  readonly currentUserId: string | null;
}

export function SectionActionItems({
  meetingId,
  section,
  currentUserId,
}: SectionActionItemsProps): JSX.Element {
  const [items, setItems] = useState<ReadonlyArray<ActionItemListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback((): void => {
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    actionItemsApi
      .list({ meetingId, section: [section] })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ActionItemsApiError) {
          setError(`Could not load action items (HTTP ${e.status}).`);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId, section, reloadKey]);

  return (
    <div className="mt-3" data-testid={`section-action-items-${section}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Action items{' '}
          {items ? (
            <span className="ml-1 font-mono text-[10px] tabular-nums text-muted-foreground">
              ({items.length})
            </span>
          ) : null}
        </h3>
        <Button asChild size="sm" variant="outline" className="h-9 text-xs" data-print="hide">
          <Link
            to={`/action-items/new?meetingId=${encodeURIComponent(meetingId)}&section=${section}`}
          >
            <Plus className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            Add
          </Link>
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
        >
          {error}
        </div>
      ) : null}

      {items === null ? (
        <div className="h-12 animate-pulse rounded-md border border-border bg-muted/40" />
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background/50 p-3 text-xs text-muted-foreground">
          No action items in this section yet.{' '}
          <Link
            to={`/action-items/new?meetingId=${encodeURIComponent(meetingId)}&section=${section}`}
            className="text-primary underline"
          >
            Add one
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li key={it.id}>
              <SectionActionItemCard
                item={it}
                meetingId={meetingId}
                onChanged={refresh}
                currentUserId={currentUserId}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
