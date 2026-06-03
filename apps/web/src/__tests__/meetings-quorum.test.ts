// Unit tests for the client-side computeQuorum helper
// (apps/web/src/meetings/quorum.ts). Mirrors apps/api/src/lib/
// compute-quorum.test.ts so the client and server implementations
// stay in lock-step over the OHSA s.9(8) + CLC s.135.1(8) edge
// cases.
//
// Per ADR-0012 §3.6 the chain payload's quorum compliance is computed
// by the SERVER inside the adjourn transaction; this client-side
// helper exists to drive the LIVE chip on the meeting top bar. Drift
// between client and server would surface as a chip-vs-chain
// disagreement and is the explicit non-goal — these tests pin the
// mirror.

import { describe, expect, it } from 'vitest';
import {
  computeQuorum,
  type QuorumAttendanceRow,
  type QuorumJurisdiction,
} from '@/meetings/quorum';

function row(
  role: QuorumAttendanceRow['role'],
  presentStatus: QuorumAttendanceRow['presentStatus'],
): QuorumAttendanceRow {
  return { role, presentStatus };
}

describe('client computeQuorum — Ontario (OHSA s.9(8))', () => {
  it('returns not-compliant for an empty roster', () => {
    const r = computeQuorum([], 'ON');
    expect(r.compliant).toBe(false);
    expect(r.ruleCitation).toBe('OHSA s.9(8)');
  });

  it('counts late_arrival + early_departure as present', () => {
    const r = computeQuorum(
      [
        row('worker_co_chair', 'present'),
        row('mgmt_co_chair', 'late_arrival'),
        row('mgmt_rep', 'early_departure'),
        row('worker_rep', 'regrets'),
      ],
      'ON',
    );
    expect(r.details.presentMembers).toBe(3);
    expect(r.details.workerRepsPresent).toBe(1);
  });

  it('passes when 2 of 4 members present + at least one worker rep', () => {
    const r = computeQuorum(
      [
        row('worker_co_chair', 'present'),
        row('mgmt_co_chair', 'present'),
        row('worker_rep', 'regrets'),
        row('mgmt_rep', 'regrets'),
      ],
      'ON',
    );
    expect(r.compliant).toBe(true);
    expect(r.details.thresholdMembers).toBe(2);
  });

  it('fails when no worker rep present, even with majority', () => {
    const r = computeQuorum(
      [
        row('mgmt_co_chair', 'present'),
        row('mgmt_rep', 'present'),
        row('mgmt_rep', 'present'),
        row('worker_rep', 'regrets'),
      ],
      'ON',
    );
    expect(r.compliant).toBe(false);
    expect(r.details.workerRepRequirementMet).toBe(false);
  });

  it('ignores guests', () => {
    const r = computeQuorum(
      [row('guest', 'present'), row('guest', 'present'), row('guest', 'present')],
      'ON',
    );
    expect(r.details.totalMembers).toBe(0);
    expect(r.compliant).toBe(false);
  });
});

describe('client computeQuorum — Federal (CLC s.135.1(8))', () => {
  const J: QuorumJurisdiction = 'CA-FED';

  it('requires a STRICT majority (not just half) of members', () => {
    // 4 members; ON threshold is 2 (half), CA-FED threshold is 3
    // (majority).
    const r = computeQuorum(
      [
        row('worker_co_chair', 'present'),
        row('mgmt_co_chair', 'present'),
        row('worker_rep', 'regrets'),
        row('mgmt_rep', 'regrets'),
      ],
      J,
    );
    expect(r.details.thresholdMembers).toBe(3);
    expect(r.compliant).toBe(false);
  });

  it('passes with a majority AND at least half of present are worker reps', () => {
    const r = computeQuorum(
      [
        row('worker_co_chair', 'present'),
        row('worker_rep', 'present'),
        row('mgmt_co_chair', 'present'),
        row('mgmt_rep', 'regrets'),
      ],
      J,
    );
    expect(r.compliant).toBe(true);
    expect(r.details.workerRepsPresent).toBe(2);
    expect(r.details.presentMembers).toBe(3);
  });

  it('fails when fewer than half of present are worker reps', () => {
    const r = computeQuorum(
      [
        row('worker_co_chair', 'present'),
        row('mgmt_co_chair', 'present'),
        row('mgmt_rep', 'present'),
      ],
      J,
    );
    expect(r.compliant).toBe(false);
    expect(r.details.workerRepRequirementMet).toBe(false);
  });
});
