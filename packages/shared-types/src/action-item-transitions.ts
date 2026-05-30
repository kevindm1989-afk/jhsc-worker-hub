// Action-item section transition graph (ADR-0005 §"Section workflow").
//
// Single source of truth for what section moves are legal. The POST
// /api/action-items/:id/moves handler consults this; the UI gates the
// section-move targets against it; integration tests assert legal/
// illegal pairs exhaustively.
//
// Pure function. No I/O. Lives in shared-types so the web app and the
// API agree on the same graph.

import type { ActionItemSection } from './index';

/**
 * Outgoing edges per section. A transition (from, to) is legal iff
 * `to in ALLOWED_TRANSITIONS[from]`. Reading the table top-to-bottom:
 *
 *   new_business           → old_business | recommendation
 *                          | completed_this_period | archived
 *   old_business           → completed_this_period | archived
 *                          | recommendation
 *   recommendation         → completed_this_period | archived
 *   completed_this_period  → archived | old_business
 *                          (reopen path: rep undoes a premature close)
 *   archived               → old_business
 *                          (reopen path: rep revives an archived item)
 *
 * Notes:
 *   - `archived` is NOT terminal — reopen-to-old_business handles the
 *     "we archived too soon; the condition came back" case. Step-up
 *     is required for `archived → old_business` (route layer).
 *   - The `→ completed_this_period` move requires the item's status to
 *     be 'Closed' or 'Cancelled' — that's a route-level guard, not a
 *     graph rule, because status/section are independent dimensions.
 *   - There is no edge BACK to `new_business`. An item raised becomes
 *     either part of old_business, gets formally escalated to a s.9(20)
 *     recommendation, or closes out. "New business" means "first raised
 *     this meeting" — by definition that is a write-once entry point.
 */
export const ACTION_ITEM_ALLOWED_TRANSITIONS: Readonly<
  Record<ActionItemSection, ReadonlyArray<ActionItemSection>>
> = {
  new_business: ['old_business', 'recommendation', 'completed_this_period', 'archived'],
  old_business: ['completed_this_period', 'archived', 'recommendation'],
  recommendation: ['completed_this_period', 'archived'],
  completed_this_period: ['archived', 'old_business'],
  archived: ['old_business'],
};

/**
 * Transitions that require step-up auth at the route layer:
 *   - any move TO `archived` (destructive cleanup)
 *   - `archived → old_business` (revive an archived item)
 *   - `completed_this_period → old_business` (premature-close undo)
 *
 * Step-up does NOT replace the transition-graph check; both apply.
 */
export const ACTION_ITEM_STEP_UP_TRANSITIONS: ReadonlyArray<
  [ActionItemSection, ActionItemSection]
> = [
  ['new_business', 'archived'],
  ['old_business', 'archived'],
  ['recommendation', 'archived'],
  ['completed_this_period', 'archived'],
  ['archived', 'old_business'],
  ['completed_this_period', 'old_business'],
];

export function isAllowedActionItemTransition(
  from: ActionItemSection,
  to: ActionItemSection,
): boolean {
  return ACTION_ITEM_ALLOWED_TRANSITIONS[from].includes(to);
}

export function actionItemTransitionRequiresStepUp(
  from: ActionItemSection,
  to: ActionItemSection,
): boolean {
  return ACTION_ITEM_STEP_UP_TRANSITIONS.some(([f, t]) => f === from && t === to);
}
