// Client-side quorum compute (Milestone 2.1 S3).
//
// The S2 server route does NOT expose a standalone GET /quorum
// endpoint — the chain payload's quorumCompliance is computed inside
// the adjourn transaction. The live meeting view needs a number on
// the top bar BEFORE adjournment, so this module re-implements the
// `computeQuorum` pure function client-side (mirror of
// apps/api/src/lib/compute-quorum.ts).
//
// The rule_citation strings are kept in sync with the server's; if
// they diverge the audit chain (which carries the server's value)
// remains authoritative. The browser's compute is for the LIVE chip
// only.
//
// Per ADR-0012 §3.6: at single-tenant scale and with the same
// MeetingAttendanceRole / MeetingPresentStatus enums in shared-types,
// the two implementations cannot drift in a way that affects the
// chain — both read the same role + present_status fields. Drift in
// the THRESHOLD math would surface as a chip-vs-chain disagreement
// at adjournment; the chain wins.

import type { MeetingAttendanceRole, MeetingPresentStatus } from '@jhsc/shared-types';

export type QuorumJurisdiction = 'ON' | 'CA-FED';

export interface QuorumAttendanceRow {
  readonly role: MeetingAttendanceRole;
  readonly presentStatus: MeetingPresentStatus;
}

export interface QuorumResult {
  readonly compliant: boolean;
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
 * Compute quorum compliance from the attendance roster + jurisdiction.
 *
 * Members = non-guest roles. Guests do not count.
 * Presence = 'present' | 'late_arrival' | 'early_departure'. The two
 * partial-presence statuses count toward the LIVE chip even though
 * the adjournment metrics may track the absence interval separately
 * (server side).
 *
 * Ontario (OHSA s.9(8)): at least half the members present + at
 * least one worker rep.
 * Federal (CLC s.135.1(8)): a majority (>half) of members present
 * + at least half of those present are worker reps.
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

  const thresholdMembers = totalMembers === 0 ? 1 : Math.floor(totalMembers / 2) + 1;
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
