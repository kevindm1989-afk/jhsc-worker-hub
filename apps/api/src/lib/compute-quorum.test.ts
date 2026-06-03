// Unit tests for computeQuorum (ADR-0012 §3.6).
//
// Coverage targets the 8 fixture cases the S1 brief calls out:
//   1. No attendees
//   2. All guests, no members
//   3. Exactly half (ON pass; CA-FED fail)
//   4. All worker reps absent (ON fail even with quorum count)
//   5. Late arrivals count as present
//   6. Early departures count as present (interval tracked elsewhere)
//   7. Mid-meeting quorum loss (re-compute after a state flip)
//   8. Mixed roles + jurisdictions

import { describe, expect, it } from 'vitest';
import { computeQuorum, type QuorumAttendanceRow } from './compute-quorum';

function row(
  role: QuorumAttendanceRow['role'],
  presentStatus: QuorumAttendanceRow['presentStatus'],
): QuorumAttendanceRow {
  return { role, presentStatus };
}

describe('computeQuorum — Ontario (OHSA s.9(8))', () => {
  it('1) no attendees → not compliant; cites s.9(8)', () => {
    const r = computeQuorum([], 'ON');
    expect(r.compliant).toBe(false);
    expect(r.ruleCitation).toBe('OHSA s.9(8)');
    expect(r.details.totalMembers).toBe(0);
    expect(r.details.presentMembers).toBe(0);
    expect(r.details.workerRepRequirementMet).toBe(false);
  });

  it('2) all guests, no members → not compliant', () => {
    const r = computeQuorum([row('guest', 'present'), row('guest', 'present')], 'ON');
    expect(r.compliant).toBe(false);
    expect(r.details.totalMembers).toBe(0);
    expect(r.details.guestsPresent).toBe(2);
  });

  it('3) exactly half + at least one worker rep → compliant', () => {
    // 4 members total; 2 present (1 worker, 1 mgmt). Half = 2.
    const r = computeQuorum(
      [
        row('worker_rep', 'present'),
        row('mgmt_rep', 'present'),
        row('worker_rep', 'regrets'),
        row('mgmt_rep', 'absent_unexcused'),
      ],
      'ON',
    );
    expect(r.compliant).toBe(true);
    expect(r.details.totalMembers).toBe(4);
    expect(r.details.presentMembers).toBe(2);
    expect(r.details.workerRepsPresent).toBe(1);
    expect(r.details.thresholdMembers).toBe(2);
  });

  it('4) all worker reps absent → not compliant (worker rep requirement)', () => {
    const r = computeQuorum(
      [
        row('worker_rep', 'regrets'),
        row('worker_rep', 'absent_unexcused'),
        row('mgmt_rep', 'present'),
        row('mgmt_rep', 'present'),
      ],
      'ON',
    );
    expect(r.compliant).toBe(false);
    expect(r.details.workerRepsPresent).toBe(0);
    expect(r.details.workerRepRequirementMet).toBe(false);
  });

  it('5) late_arrival counts as present', () => {
    const r = computeQuorum(
      [row('worker_co_chair', 'late_arrival'), row('mgmt_co_chair', 'present')],
      'ON',
    );
    expect(r.compliant).toBe(true);
    expect(r.details.presentMembers).toBe(2);
  });

  it('6) early_departure counts as present', () => {
    const r = computeQuorum(
      [row('worker_co_chair', 'early_departure'), row('mgmt_co_chair', 'present')],
      'ON',
    );
    expect(r.compliant).toBe(true);
    expect(r.details.presentMembers).toBe(2);
  });

  it('7) mid-meeting state flip — flipping a worker rep to absent_unexcused breaks quorum', () => {
    const startingAttendance: QuorumAttendanceRow[] = [
      row('worker_co_chair', 'present'),
      row('mgmt_co_chair', 'present'),
      row('worker_rep', 'present'),
      row('mgmt_rep', 'present'),
    ];
    const before = computeQuorum(startingAttendance, 'ON');
    expect(before.compliant).toBe(true);

    // Single worker rep dropping doesn't lose quorum (still 1 worker
    // present + 3 of 4 members), but losing BOTH worker reps does.
    const afterBothWorkersDrop: QuorumAttendanceRow[] = [
      row('worker_co_chair', 'absent_unexcused'),
      row('mgmt_co_chair', 'present'),
      row('worker_rep', 'absent_unexcused'),
      row('mgmt_rep', 'present'),
    ];
    const after = computeQuorum(afterBothWorkersDrop, 'ON');
    expect(after.compliant).toBe(false);
    expect(after.details.workerRepsPresent).toBe(0);
  });

  it('8) mixed roles + guest does not raise the threshold', () => {
    // 3 members + 2 guests. Threshold = ceil(3/2) = 2. Guests do not
    // count toward total. Two members present + 1 worker rep → compliant.
    const r = computeQuorum(
      [
        row('worker_co_chair', 'present'),
        row('mgmt_co_chair', 'present'),
        row('mgmt_rep', 'regrets'),
        row('guest', 'present'),
        row('guest', 'present'),
      ],
      'ON',
    );
    expect(r.compliant).toBe(true);
    expect(r.details.totalMembers).toBe(3);
    expect(r.details.guestsPresent).toBe(2);
    expect(r.details.thresholdMembers).toBe(2);
  });
});

describe('computeQuorum — Federal (CLC s.135.1(8))', () => {
  it('cites the federal rule', () => {
    const r = computeQuorum([row('worker_co_chair', 'present')], 'CA-FED');
    expect(r.ruleCitation).toBe('CLC s.135.1(8)');
  });

  it('requires a MAJORITY (not just half) — half-of-4 fails', () => {
    // 4 members, 2 present (split worker/mgmt). ON would pass; CA-FED
    // requires floor(4/2)+1 = 3.
    const r = computeQuorum(
      [
        row('worker_rep', 'present'),
        row('mgmt_rep', 'present'),
        row('worker_rep', 'regrets'),
        row('mgmt_rep', 'regrets'),
      ],
      'CA-FED',
    );
    expect(r.compliant).toBe(false);
    expect(r.details.thresholdMembers).toBe(3);
  });

  it('majority + at least half-present-are-workers → compliant', () => {
    // 4 members; 3 present (2 worker, 1 mgmt). 2 workers >= 3/2.
    const r = computeQuorum(
      [
        row('worker_rep', 'present'),
        row('worker_rep', 'present'),
        row('mgmt_rep', 'present'),
        row('mgmt_rep', 'regrets'),
      ],
      'CA-FED',
    );
    expect(r.compliant).toBe(true);
    expect(r.details.workerRepsPresent).toBe(2);
    expect(r.details.presentMembers).toBe(3);
    expect(r.details.workerRepRequirementMet).toBe(true);
  });

  it('majority but <half-workers fails the federal employee-majority rule', () => {
    // 6 members; 4 present (1 worker, 3 mgmt). 1 worker << half of 4.
    const r = computeQuorum(
      [
        row('worker_rep', 'present'),
        row('mgmt_rep', 'present'),
        row('mgmt_rep', 'present'),
        row('mgmt_rep', 'present'),
        row('worker_rep', 'regrets'),
        row('worker_rep', 'regrets'),
      ],
      'CA-FED',
    );
    expect(r.compliant).toBe(false);
    expect(r.details.workerRepRequirementMet).toBe(false);
  });
});

describe('computeQuorum — invariants', () => {
  it('never throws on degenerate inputs', () => {
    expect(() => computeQuorum([], 'ON')).not.toThrow();
    expect(() => computeQuorum([], 'CA-FED')).not.toThrow();
    expect(() => computeQuorum([row('guest', 'present')], 'ON')).not.toThrow();
  });

  it('details.totalMembers + details.guestsPresent never exceeds the input length', () => {
    const attendance: QuorumAttendanceRow[] = [
      row('worker_co_chair', 'present'),
      row('guest', 'present'),
      row('guest', 'regrets'),
    ];
    const r = computeQuorum(attendance, 'ON');
    expect(r.details.totalMembers).toBe(1);
    expect(r.details.guestsPresent).toBe(1);
  });
});
