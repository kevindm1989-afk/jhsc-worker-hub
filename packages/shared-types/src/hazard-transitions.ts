// Hazard status transition graph (ADR-0004 §"Status workflow").
//
// Single source of truth for what status moves are legal. The PATCH
// /api/hazards/:id/status handler consults this; UI gates the transition
// buttons against this; an integration test asserts every legal/illegal
// pair so a future schema change cannot silently widen the graph.
//
// Pure function. No I/O. Lives in shared-types so the web app and the
// API agree on the same graph.

import type { HazardStatus } from './index';

/**
 * Outgoing edges per status. A transition (from, to) is legal iff
 * `to in ALLOWED_TRANSITIONS[from]`. Reading the table top-to-bottom:
 *
 *   open       → assessing | withdrawn
 *   assessing  → open      | assigned  | withdrawn
 *   assigned   → assessing | resolved  | withdrawn
 *   resolved   → archived  | assessing                 (re-open if regression)
 *   archived   → assessing                              (re-open if regression)
 *   withdrawn  → (terminal)
 *
 * Re-open paths (resolved→assessing, archived→assessing) intentionally
 * land in `assessing`, not `open` — the JHSC has already triaged this
 * hazard at least once; the re-open is "look at it again," not "fresh
 * report." Step-up auth is required (route layer) for re-opens.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<HazardStatus, ReadonlyArray<HazardStatus>>> = {
  open: ['assessing', 'withdrawn'],
  assessing: ['open', 'assigned', 'withdrawn'],
  assigned: ['assessing', 'resolved', 'withdrawn'],
  resolved: ['archived', 'assessing'],
  archived: ['assessing'],
  withdrawn: [],
};

/**
 * Status transitions that require step-up auth at the route layer.
 *
 *   →withdrawn         — destructive escape valve (T-H3).
 *   resolved→assessing — re-open a closed hazard.
 *   archived→assessing — re-open an archived hazard.
 *
 * Step-up does NOT replace the transition-graph check; both apply.
 */
export const STEP_UP_TRANSITIONS: ReadonlyArray<[HazardStatus, HazardStatus]> = [
  ['open', 'withdrawn'],
  ['assessing', 'withdrawn'],
  ['assigned', 'withdrawn'],
  ['resolved', 'assessing'],
  ['archived', 'assessing'],
];

export function isAllowedTransition(from: HazardStatus, to: HazardStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function requiresStepUp(from: HazardStatus, to: HazardStatus): boolean {
  return STEP_UP_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Terminal statuses produce no outgoing edges. */
export function isTerminal(s: HazardStatus): boolean {
  return ALLOWED_TRANSITIONS[s].length === 0;
}
