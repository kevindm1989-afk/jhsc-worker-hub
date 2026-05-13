import { FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RecommendationsView(): JSX.Element {
  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 md:mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Recommendations
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Written recommendations under OHSA s.9(20) with 21-day response tracking.
        </p>
      </header>

      <div className="flex flex-col items-center justify-center px-6 py-16 text-center md:py-20">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
          <FileText
            className="h-6 w-6 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
        <div className="mb-1 text-base font-medium text-foreground">
          No recommendations drafted.
        </div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Draft a written recommendation under OHSA s.9(20). Management has 21 days to respond per
          s.9(21) — the clock starts at submission.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-9"
            title="Draft recommendation — lands in Milestone 1.9"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Draft recommendation
          </Button>
        </div>
      </div>
    </div>
  );
}
