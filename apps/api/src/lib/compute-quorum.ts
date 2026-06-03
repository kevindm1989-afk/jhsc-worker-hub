// Quorum computation (ADR-0012 §3.6).
//
// Pure function over an attendance list + jurisdiction. Returns a tagged
// result the UI renders verbatim — the chip on the live meeting top bar
// reads `result.compliant` + `result.rule_citation`; the adjournment
// metrics blob carries the same fields.
//
// Implements OHSA s.9(7-8) (Ontario) and CLC s.135.1 (federal). The two
// rules are structurally similar but worded differently; we keep them
// as separate branches so the rule_citation surfaces the right statute.
//
// Rules-as-stated:
//
//   OHSA s.9(7): "A committee that is required to have at least 4 members
//     shall consist of at least 2 worker members and at least one member
//     representing the constructor or employer." For quorum
//     interpretation purposes: at least half the members, with at least
//     one worker rep present.
//
//   OHSA s.9(8): The committee may transact business at a meeting only
//     if at least half the members are present and at least one member
//     represents the workers.
//
//   CLC s.135.1(8): A quorum at a meeting of a workplace committee
//     consists of a majority of the members, at least half of whom are
//     employees who do not exercise managerial functions.
//
// The federal rule is slightly stricter: a MAJORITY (> half), and at
// least half of those present must be worker reps. We implement both
// faithfully.
//
// PI handling: this function never touches display_name_ct — it reads
// only role + present_status. The encrypted name lives outside the
// quorum compute path.

import type { MeetingAttendanceRole, MeetingPresentStatus } from '@jhsc/shared-types';

/** Row shape consumed by computeQuorum — only the fields it actually reads. */
export interface QuorumAttendanceRow {
  readonly role: MeetingAttendanceRole;
  readonly presentStatus: MeetingPresentStatus;
}

export type QuorumJurisdiction = 'ON' | 'CA-FED';

export interface QuorumResult {
  readonly compliant: boolean;
  /** Stable citation referencing the legal corpus entry. */
  readonly ruleCitation: string;
  readonly details: {
    readonly totalMembers: number;
    readonly presentMembers: number;
    readonly workerRepsPresent: number;
    readonly mgmtRepsPresent: number;
    readonly guestsPresent: number;
    readonly thresholdMembers: number;
    readonly workerRepRequirementMet: boolean;
  };
}

const WORKER_ROLES: ReadonlySet<MeetingAttendanceRole> = new Set(['worker_co_chair', 'worker_rep']);
const MGMT_ROLES: ReadonlySet<MeetingAttendanceRole> = new Set(['mgmt_co_chair', 'mgmt_rep']);
const PRESENT_STATUSES: ReadonlySet<MeetingPresentStatus> = new Set([
  'present',
  'late_arrival',
  'early_departure',
]);

/**
 * Compute quorum compliance for a meeting's attendance roster.
 *
 * Members = non-guest roles (worker_co_chair, mgmt_co_chair, worker_rep,
 * mgmt_rep). Guests do NOT count toward the threshold and do NOT count
 * as worker reps.
 *
 * Presence:
 *   - `present`, `late_arrival`, `early_departure` all count as present.
 *     (The threat model treats a member who arrived late or left early as
 *     present for the meeting; their absence INTERVAL is tracked elsewhere
 *     via arrived_at/departed_at and rolls into the quorumLostIntervals
 *     compute at adjournment time.)
 *   - `regrets` and `absent_unexcused` do not count.
 *
 * Threshold:
 *   - ON OHSA s.9(8): at least half the members. >= ceil(total / 2)?
 *     The statute is phrased "at least half" which we read as >= half
 *     (inclusive). For an even total (e.g. 4), 2 suffices; for an odd
 *     total (e.g. 5), 3 suffices.
 *   - CA-FED CLC s.135.1(8): a MAJORITY of the members (>= floor(total/2)+1),
 *     AND at least half of those present must be employees who do not
 *     exercise managerial functions.
 *
 * Worker rep requirement:
 *   - ON: at least one worker rep present.
 *   - CA-FED: at least half of those present are worker reps (the
 *     stricter "at least half are employees" rule).
 */
export function computeQuorum(
  attendance: ReadonlyArray<QuorumAttendanceRow>,
  jurisdiction: QuorumJurisdiction,
): QuorumResult {
  const members = attendance.filter(
    (row) => WORKER_ROLES.has(row.role) || MGMT_ROLES.has(row.role),
  );
  const totalMembers = members.length;
  const presentMembers = members.filter((row) => PRESENT_STATUSES.has(row.presentStatus)).length;
  const workerRepsPresent = attendance.filter(
    (row) => WORKER_ROLES.has(row.role) && PRESENT_STATUSES.has(row.presentStatus),
  ).length;
  const mgmtRepsPresent = attendance.filter(
    (row) => MGMT_ROLES.has(row.role) && PRESENT_STATUSES.has(row.presentStatus),
  ).length;
  const guestsPresent = attendance.filter(
    (row) => row.role === 'guest' && PRESENT_STATUSES.has(row.presentStatus),
  ).length;

  if (jurisdiction === 'ON') {
    // OHSA s.9(8): at least half + at least one worker rep.
    // Edge case: totalMembers=0 → "at least half of 0" is trivially 0,
    // but the workerRepRequirement makes it un-compliant. We surface
    // threshold=1 in that degenerate case so the UI explains the rule.
    const thresholdMembers = totalMembers === 0 ? 1 : Math.ceil(totalMembers / 2);
    const workerRepRequirementMet = workerRepsPresent >= 1;
    const memberCountMet = presentMembers >= thresholdMembers && totalMembers > 0;
    return {
      compliant: memberCountMet && workerRepRequirementMet,
      ruleCitation: 'OHSA s.9(8)',
      details: {
        totalMembers,
        presentMembers,
        workerRepsPresent,
        mgmtRepsPresent,
        guestsPresent,
        thresholdMembers,
        workerRepRequirementMet,
      },
    };
  }

  // CA-FED: CLC s.135.1(8) — majority of members + at least half of
  // those present are employees (worker reps in our role taxonomy).
  const thresholdMembers = totalMembers === 0 ? 1 : Math.floor(totalMembers / 2) + 1;
  // "At least half of those present are worker reps." When 0 present,
  // the predicate is vacuously true mathematically but un-compliant
  // because memberCountMet is false anyway.
  const workerRepRequirementMet = presentMembers > 0 && workerRepsPresent * 2 >= presentMembers;
  const memberCountMet = presentMembers >= thresholdMembers && totalMembers > 0;
  return {
    compliant: memberCountMet && workerRepRequirementMet,
    ruleCitation: 'CLC s.135.1(8)',
    details: {
      totalMembers,
      presentMembers,
      workerRepsPresent,
      mgmtRepsPresent,
      guestsPresent,
      thresholdMembers,
      workerRepRequirementMet,
    },
  };
}
