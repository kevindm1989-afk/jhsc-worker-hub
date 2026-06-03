import { Plus, ScrollText, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Empty-state pattern mirrors meeting-minutes.tsx:456-475 (EmptyState).
// CTAs are non-functional in Milestone 1.1 — visual fidelity only. The
// title attribute documents the milestone where each action lands.

export function MinutesView(): JSX.Element {
  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 md:mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Minutes
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The operational hub — action items, meetings, and the 21-day s.9(21) clock.
        </p>
      </header>

      <div className="flex flex-col items-center justify-center px-6 py-16 text-center md:py-20">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
          <ScrollText
            className="h-6 w-6 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
        <div className="mb-1 text-base font-medium text-foreground">No active meeting yet.</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Start a new meeting to begin tracking action items, attendance, and recommendations. Or
          import your existing minutes spreadsheet to load prior history.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" title="Start new meeting — lands in Milestone 2.1">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Start new meeting
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="Import Excel — lands in Milestone 1.11"
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Import Excel
          </Button>
        </div>
      </div>
    </div>
  );
}
