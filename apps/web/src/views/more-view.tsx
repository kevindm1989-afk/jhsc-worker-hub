import {
  BarChart3,
  BookOpen,
  Calculator,
  Calendar,
  ChevronRight,
  FileText,
  Settings,
  type LucideIcon,
} from 'lucide-react';

// Secondary-nav list mirroring app-shell.tsx:698-735 (MoreView). Each item
// previews a surface that lands in a later milestone. Items are visually
// styled per the prototype but marked aria-disabled="true" so assistive
// tech announces their non-actionable state; the title attribute documents
// the target milestone.

interface MoreItem {
  readonly id: string;
  readonly label: string;
  readonly desc: string;
  readonly icon: LucideIcon;
  readonly milestone: string;
}

const ITEMS: readonly MoreItem[] = [
  {
    id: 'documents',
    label: 'Documents',
    desc: 'Evidence vault & generated PDFs',
    icon: FileText,
    milestone: 'Lands across Milestones 1.7, 1.8, 1.9',
  },
  {
    id: 'legal',
    label: 'Legal Reference',
    desc: 'OHSA, CLC Part II, CSA standards',
    icon: BookOpen,
    milestone: 'Lands in Milestone 1.4',
  },
  {
    id: 'calculators',
    label: 'Calculators',
    desc: 'ISO 2631, NIOSH, ACGIH TLV',
    icon: Calculator,
    milestone: 'Lands in Milestone 3.5',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    desc: 'Hazard trends & outcomes',
    icon: BarChart3,
    milestone: 'Lands in Milestone 3.7',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    desc: 'Meetings, inspections, deadlines',
    icon: Calendar,
    milestone: 'Lands in Milestone 2.9',
  },
  {
    id: 'settings',
    label: 'Settings',
    desc: 'Account, security, preferences',
    icon: Settings,
    milestone: 'Settings UI lands progressively from Milestone 1.2 onward',
  },
];

export function MoreView(): JSX.Element {
  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 md:mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">More</h1>
      </header>

      <div className="space-y-2">
        {ITEMS.map((item) => (
          <MoreRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function MoreRow({ item }: { item: MoreItem }): JSX.Element {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-disabled="true"
      title={item.milestone}
      className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
        <Icon className="h-[18px] w-[18px] text-foreground/70" strokeWidth={2} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{item.label}</div>
        <div className="truncate text-xs text-muted-foreground">{item.desc}</div>
      </div>
      <ChevronRight
        className="h-4 w-4 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        strokeWidth={2}
        aria-hidden="true"
      />
    </button>
  );
}
