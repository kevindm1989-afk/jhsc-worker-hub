import { AlertTriangle, Camera, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function HazardsView(): JSX.Element {
  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 md:mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Hazards
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Encrypted, GPS-stamped hazard records linked to the audit chain.
        </p>
      </header>

      <div className="flex flex-col items-center justify-center px-6 py-16 text-center md:py-20">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
          <AlertTriangle
            className="h-6 w-6 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
        <div className="mb-1 text-base font-medium text-foreground">No hazards logged.</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Capture a hazard with a photo or fill in the intake form. Every entry is encrypted at
          capture, GPS-stamped, and entered into the audit chain.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-9"
            title="Capture hazard — lands in Milestone 1.7 (Capture-to-Record)"
          >
            <Camera className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Capture hazard
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            title="New from form — lands in Milestone 1.5"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            New from form
          </Button>
        </div>
      </div>
    </div>
  );
}
