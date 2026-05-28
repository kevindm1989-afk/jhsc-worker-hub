// Action Flag computation (ARCHITECTURE.md §5, ADR-0005).
//
// Pure function over (section, status, start_date, closed_date, today).
// Returns a tagged union so the renderer doesn't re-parse the emoji
// label. The function is the single source of truth — the API list
// projection runs it server-side, the UI renders the returned shape
// verbatim. Day boundaries are evaluated against the `today` argument
// the caller passes in; tests pass a fixed date so behavior is
// deterministic.

import type { ActionItemSection, ActionItemStatus } from './index';

export interface ActionFlagInput {
  readonly section: ActionItemSection;
  readonly status: ActionItemStatus;
  /** ISO YYYY-MM-DD. The date the item was raised. */
  readonly startDate: string;
  /** ISO YYYY-MM-DD. The date the item was closed by JHSC, if any. */
  readonly closedDate: string | null;
  /** ISO YYYY-MM-DD. The "today" date the flag is computed against. */
  readonly today: string;
  /**
   * Optional: whether management has responded to the s.9(20) recommendation.
   * Lands wired-up in Milestone 1.9 when recommendation responses ship.
   * Pre-1.9, pass false (default) — the function then renders the
   * countdown / overdue states unless the section is not 'recommendation'.
   */
  readonly hasManagementResponse?: boolean;
}

export type ActionFlagSeverity = 'open' | 'pending' | 'resolved' | 'archived';

export type ActionFlag =
  | { kind: 'recently_closed'; label: '✓ Recently Closed'; severity: 'resolved' }
  | { kind: 'aging_under_21'; label: '🟠 <21 days'; severity: 'pending' }
  | {
      kind: 'aging_over_21';
      label: '🟠 >21 days — move to Old Business';
      severity: 'pending';
    }
  | { kind: 'response_received'; label: '✓ Response received'; severity: 'resolved' }
  | { kind: 'response_overdue'; label: '🔴 s.9(21) response overdue'; severity: 'open' }
  | { kind: 'response_countdown'; daysRemaining: number; label: string; severity: 'pending' }
  | { kind: 'archive_due'; label: '⬇ Archive to Closed sheet'; severity: 'archived' };

/**
 * Days between two YYYY-MM-DD dates. Caller's responsibility to pass
 * well-formed strings; the function asserts the shape and treats either
 * one as a UTC midnight Date.
 */
function daysBetween(fromIso: string, toIso: string): number {
  const fromMs = Date.parse(`${fromIso}T00:00:00Z`);
  const toMs = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new Error(`computeActionFlag: invalid date(s) ${fromIso}, ${toIso}`);
  }
  return Math.floor((toMs - fromMs) / (24 * 60 * 60 * 1000));
}

export function computeActionFlag(input: ActionFlagInput): ActionFlag | null {
  const { section, status, startDate, closedDate, today } = input;
  const hasManagementResponse = input.hasManagementResponse ?? false;
  const ageDays = daysBetween(startDate, today);

  if (section === 'new_business') {
    if (status === 'Closed') {
      return { kind: 'recently_closed', label: '✓ Recently Closed', severity: 'resolved' };
    }
    if (ageDays <= 21) {
      return { kind: 'aging_under_21', label: '🟠 <21 days', severity: 'pending' };
    }
    return {
      kind: 'aging_over_21',
      label: '🟠 >21 days — move to Old Business',
      severity: 'pending',
    };
  }

  if (section === 'old_business') {
    if (status === 'Closed') {
      return { kind: 'recently_closed', label: '✓ Recently Closed', severity: 'resolved' };
    }
    return null;
  }

  if (section === 'recommendation') {
    if (hasManagementResponse) {
      return { kind: 'response_received', label: '✓ Response received', severity: 'resolved' };
    }
    const daysSince = ageDays;
    if (daysSince > 21) {
      return {
        kind: 'response_overdue',
        label: '🔴 s.9(21) response overdue',
        severity: 'open',
      };
    }
    const daysRemaining = 21 - daysSince;
    return {
      kind: 'response_countdown',
      daysRemaining,
      label: `🟡 ${daysRemaining} days to s.9(21) response`,
      severity: 'pending',
    };
  }

  if (section === 'completed_this_period') {
    if (closedDate === null) {
      // Status row says completed but no closed_date set — treat as
      // recently-closed-ish so the rep notices and fills it in.
      return { kind: 'recently_closed', label: '✓ Recently Closed', severity: 'resolved' };
    }
    const daysClosed = daysBetween(closedDate, today);
    if (daysClosed > 21) {
      return {
        kind: 'archive_due',
        label: '⬇ Archive to Closed sheet',
        severity: 'archived',
      };
    }
    return { kind: 'recently_closed', label: '✓ Recently Closed', severity: 'resolved' };
  }

  // archived
  return null;
}
