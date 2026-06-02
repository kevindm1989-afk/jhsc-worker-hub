import {
  AlertTriangle,
  ClipboardList,
  MoreHorizontal,
  Scale,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';

// Single source of truth for the five primary tabs.
//
// Minutes is first because ARCHITECTURE.md §3 makes it the canonical
// open-the-app landing surface on mobile, replacing the prototype's
// "Dashboard" tab. Order is preserved across the bottom tab bar (mobile)
// and the desktop sidebar so the spatial mapping stays consistent.
//
// Icon choices match the prototypes in design/prototypes/ verbatim per
// PROTOTYPES.md Rule 1. ScrollText for Minutes mirrors the import in
// meeting-minutes.tsx and recommendation-drafting.tsx.

export type TabId = 'minutes' | 'hazards' | 'inspections' | 'recommendations' | 'more';

export interface TabDefinition {
  readonly id: TabId;
  readonly path: string;
  readonly label: string;
  /** Shorter label for the mobile bottom tab bar (5-column grid is tight). */
  readonly shortLabel: string;
  readonly icon: LucideIcon;
  /** When true, sits below the divider in the desktop sidebar. */
  readonly secondary?: boolean;
}

export const TABS: readonly TabDefinition[] = [
  {
    id: 'minutes',
    path: '/minutes',
    label: 'Minutes',
    shortLabel: 'Minutes',
    icon: ScrollText,
  },
  {
    id: 'hazards',
    path: '/hazards',
    label: 'Hazards',
    shortLabel: 'Hazards',
    icon: AlertTriangle,
  },
  {
    id: 'inspections',
    path: '/inspections',
    label: 'Inspections',
    shortLabel: 'Inspections',
    icon: ClipboardList,
  },
  {
    id: 'recommendations',
    path: '/recommendations',
    label: 'Recommendations',
    shortLabel: 'Recs',
    // Scale carries the legal-document semantic without union iconography
    // (CLAUDE.md non-negotiable #10). The 1.9 surface is the formal
    // Notice of Recommendation under OHSA s.9(20) / CLC s.135(5).
    icon: Scale,
  },
  {
    id: 'more',
    path: '/more',
    label: 'More',
    shortLabel: 'More',
    icon: MoreHorizontal,
    secondary: true,
  },
];
