// Small primitives shared by the inspection list, detail, finding-card,
// promote dialog, signature sheet, template-browser, and authoring
// surfaces.
//
// CLAUDE.md §"Status semantics": red = open/danger, amber = pending,
// green = resolved, blue = informational, zinc = neutral/archived.
// Pair color with label — never color alone. Aria labels included on
// every badge.

import { cn } from '@/lib/utils';
import type {
  InspectionConductState,
  InspectionSignatureRole,
  InspectionStatusVocabKind,
  InspectionTemplateCode,
} from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Conduct-state badge
// ---------------------------------------------------------------------------

const STATE_STYLES: Record<InspectionConductState, { label: string; chip: string }> = {
  scheduled: {
    label: 'Scheduled',
    chip: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  },
  in_progress: {
    label: 'In progress',
    chip: 'bg-blue-50 text-blue-700 border-blue-100',
  },
  awaiting_signatures: {
    label: 'Awaiting signatures',
    chip: 'bg-amber-50 text-amber-700 border-amber-100',
  },
  complete: {
    label: 'Complete',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  },
  archived: {
    label: 'Archived',
    chip: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  },
};

export function InspectionStateBadge({ state }: { state: InspectionConductState }): JSX.Element {
  const s = STATE_STYLES[state];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        s.chip,
      )}
      aria-label={`State: ${s.label}`}
    >
      {s.label}
    </span>
  );
}

export const STATE_LABELS: Readonly<Record<InspectionConductState, string>> = Object.fromEntries(
  (
    Object.entries(STATE_STYLES) as Array<[InspectionConductState, { label: string; chip: string }]>
  ).map(([k, v]) => [k, v.label]),
) as Record<InspectionConductState, string>;

// ---------------------------------------------------------------------------
// Finding-status badge
//
// ABC+X (Zone Monthly):
//   A = severe / urgent      → red
//   B = moderate             → amber
//   C = informational        → blue
//   X = no issue (not promotable) → zinc
//
// GAR (Rack):
//   G = green / pass (not promotable) → emerald
//   A = amber / attention             → amber
//   R = red / fail                    → red
// ---------------------------------------------------------------------------

interface StatusStyle {
  readonly label: string;
  readonly chip: string;
  readonly description: string;
}

const ABCX_STATUS_STYLES: Record<string, StatusStyle> = {
  A: {
    label: 'A',
    chip: 'bg-red-50 text-red-700 border-red-100',
    description: 'A — urgent / severe',
  },
  B: {
    label: 'B',
    chip: 'bg-amber-50 text-amber-700 border-amber-100',
    description: 'B — attention',
  },
  C: {
    label: 'C',
    chip: 'bg-blue-50 text-blue-700 border-blue-100',
    description: 'C — informational',
  },
  X: {
    label: 'X',
    chip: 'bg-zinc-100 text-zinc-700 border-zinc-200',
    description: 'X — no issue / N/A',
  },
};

const GAR_STATUS_STYLES: Record<string, StatusStyle> = {
  G: {
    label: 'G',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    description: 'G — green / pass',
  },
  A: {
    label: 'A',
    chip: 'bg-amber-50 text-amber-700 border-amber-100',
    description: 'A — attention',
  },
  R: {
    label: 'R',
    chip: 'bg-red-50 text-red-700 border-red-100',
    description: 'R — red / fail',
  },
};

export function statusStyle(
  vocab: InspectionStatusVocabKind,
  value: string,
): StatusStyle | undefined {
  if (vocab === 'ABC_X') return ABCX_STATUS_STYLES[value];
  if (vocab === 'GAR') return GAR_STATUS_STYLES[value];
  return undefined;
}

export function FindingStatusBadge({
  vocab,
  value,
}: {
  vocab: InspectionStatusVocabKind;
  value: string;
}): JSX.Element {
  const s = statusStyle(vocab, value);
  if (!s) {
    return (
      <span
        className="inline-flex items-center rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500"
        aria-label={`Status: ${value} (out of vocab)`}
      >
        {value}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        s.chip,
      )}
      aria-label={s.description}
      title={s.description}
    >
      {s.label}
    </span>
  );
}

/** Returns the in-vocab status values in their canonical order. */
export function statusValuesForVocab(vocab: InspectionStatusVocabKind): ReadonlyArray<string> {
  if (vocab === 'ABC_X') return ['A', 'B', 'C', 'X'];
  if (vocab === 'GAR') return ['G', 'A', 'R'];
  return [];
}

// ---------------------------------------------------------------------------
// Signature-role label / order
// ---------------------------------------------------------------------------

export const SIGNATURE_ROLE_LABELS: Readonly<Record<InspectionSignatureRole, string>> = {
  inspector: 'Inspector',
  supervisor: 'Supervisor',
  jhsc_worker_co_chair: 'JHSC worker co-chair',
};

/**
 * Canonical signature ordering. For zone_monthly (one signature), the
 * UI only renders `inspector`. For rack_inspection (three signatures),
 * all three are required in the order below.
 */
export function requiredRolesForTemplate(
  requiresThreeSignatures: boolean,
): ReadonlyArray<InspectionSignatureRole> {
  if (requiresThreeSignatures) {
    return ['inspector', 'supervisor', 'jhsc_worker_co_chair'];
  }
  return ['inspector'];
}

// ---------------------------------------------------------------------------
// Template-code label
// ---------------------------------------------------------------------------

export const TEMPLATE_CODE_LABELS: Readonly<Record<InspectionTemplateCode, string>> = {
  zone_monthly: 'Zone Monthly',
  rack_inspection: 'Rack Inspection',
  custom: 'Custom',
};

export const STATUS_VOCAB_LABELS: Readonly<Record<InspectionStatusVocabKind, string>> = {
  ABC_X: 'ABC + X',
  GAR: 'G / A / R',
};

// ---------------------------------------------------------------------------
// Zone display labels — client-side resolver.
//
// Mirrors config/workplace.ts:resolveZoneLabel() but stays self-contained
// in the browser bundle (the server-side helper reads process.env which
// doesn't exist in jsdom / vite). At workplace deployment time the
// display names can be wired through a future client-config endpoint;
// for 1.8 the default "Zone N" labels are correct in every workplace.
// Non-negotiable #14: IDs are stable; display names are configurable.
// ---------------------------------------------------------------------------

export type ZoneId =
  | 'zone_1'
  | 'zone_2'
  | 'zone_3'
  | 'zone_4'
  | 'zone_5'
  | 'zone_6'
  | 'zone_7'
  | 'zone_8'
  | 'zone_9'
  | 'zone_10';

export const ZONE_IDS: ReadonlyArray<ZoneId> = [
  'zone_1',
  'zone_2',
  'zone_3',
  'zone_4',
  'zone_5',
  'zone_6',
  'zone_7',
  'zone_8',
  'zone_9',
  'zone_10',
];

export function resolveZoneLabel(zoneId: string): string {
  const match = /^zone_(\d{1,2})$/.exec(zoneId);
  if (!match) return zoneId;
  return `Zone ${match[1]}`;
}
