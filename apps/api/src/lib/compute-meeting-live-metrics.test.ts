// Unit tests for computeMeetingLiveMetrics (Milestone 2.2,
// ADR-0013 §3.4).
//
// Coverage targets the 4-6 fixture cases the S1 brief calls out:
//   1. Empty meeting (no items raised, no items closed)
//   2. Mid-meeting with 2 items raised
//   3. Mixed: 1 item closed via self-attestation + 1 peer-verified
//   4. Mixed live + finalized snapshots (live takes precedence for
//      the current-state buckets; finalized is informational)
//   5. Quorum lost mid-meeting (attendance change re-computes)
//   6. Post-adjournment: durationSeconds is fixed (start → end),
//      not start → nowMs.

import { describe, expect, it } from 'vitest';
import {
  computeMeetingLiveMetrics,
  type ComputeLiveMetricsInput,
  type MeetingActionItemSnapshotRow,
  type MeetingClosureRow,
  type MeetingInspectionReviewRow,
  type MeetingMetricsContext,
  type MeetingRecommendationRow,
} from './compute-meeting-live-metrics';
import type { QuorumAttendanceRow } from './compute-quorum';

const START_MS = Date.UTC(2026, 5, 10, 13, 0, 0); // 2026-06-10T13:00:00Z
const NOW_MS = START_MS + 30 * 60 * 1000; // +30 min
const END_MS = START_MS + 90 * 60 * 1000; // +90 min

function meetingCtx(overrides: Partial<MeetingMetricsContext> = {}): MeetingMetricsContext {
  return {
    meetingId: 'meeting-1',
    status: 'in_progress',
    actualStartAtMs: START_MS,
    actualEndAtMs: null,
    jurisdiction: 'ON',
    ...overrides,
  };
}

function attendanceQuorate(): ReadonlyArray<QuorumAttendanceRow> {
  // 4 members; 3 present (2 worker, 1 mgmt). Half = 2; worker rep
  // requirement met. ON quorum compliant.
  return [
    { role: 'worker_co_chair', presentStatus: 'present' },
    { role: 'worker_rep', presentStatus: 'present' },
    { role: 'mgmt_co_chair', presentStatus: 'present' },
    { role: 'mgmt_rep', presentStatus: 'regrets' },
  ];
}

function attendanceNonQuorate(): ReadonlyArray<QuorumAttendanceRow> {
  // 4 members; 1 present. Half = 2; not met.
  return [
    { role: 'worker_co_chair', presentStatus: 'present' },
    { role: 'worker_rep', presentStatus: 'absent_unexcused' },
    { role: 'mgmt_co_chair', presentStatus: 'absent_unexcused' },
    { role: 'mgmt_rep', presentStatus: 'absent_unexcused' },
  ];
}

function baseInput(): ComputeLiveMetricsInput {
  return {
    meeting: meetingCtx(),
    snapshots: [],
    attendance: attendanceQuorate(),
    inspectionReviews: [],
    recommendations: [],
    closures: [],
    nowMs: NOW_MS,
  };
}

describe('computeMeetingLiveMetrics — case 1: empty meeting', () => {
  it('returns zero counts; quorum reflects attendance', () => {
    const result = computeMeetingLiveMetrics(baseInput());
    expect(result.meetingId).toBe('meeting-1');
    expect(result.itemsRaised).toBe(0);
    expect(result.itemsClosed).toBe(0);
    expect(result.recommendationsDrafted).toBe(0);
    expect(result.inspectionsReviewed).toBe(0);
    expect(result.closureVerifications.total).toBe(0);
    expect(result.closureVerifications.selfAttestation).toBe(0);
    expect(result.closureVerifications.peerVerified).toBe(0);
    expect(result.quorumCompliance.currentlyMet).toBe(true);
    expect(result.quorumCompliance.metAtCallToOrder).toBe(true);
    expect(result.quorumCompliance.ruleCitation).toBe('OHSA s.9(8)');
    expect(result.durationSeconds).toBe(30 * 60);
  });

  it('durationSeconds is 0 when the meeting has not started', () => {
    const result = computeMeetingLiveMetrics({
      ...baseInput(),
      meeting: meetingCtx({ status: 'scheduled', actualStartAtMs: null }),
    });
    expect(result.durationSeconds).toBe(0);
  });
});

describe('computeMeetingLiveMetrics — case 2: mid-meeting with 2 items raised', () => {
  it('counts distinct first-raised items', () => {
    const snapshots: ReadonlyArray<MeetingActionItemSnapshotRow> = [
      {
        actionItemId: 'ai-1',
        snapshotKind: 'live',
        snapshotStatus: 'Not Started',
        snapshotSection: 'new_business',
        snapshotAtMs: START_MS + 1000,
        firstRaisedHere: true,
      },
      {
        actionItemId: 'ai-2',
        snapshotKind: 'live',
        snapshotStatus: 'In Progress',
        snapshotSection: 'new_business',
        snapshotAtMs: START_MS + 2000,
        firstRaisedHere: true,
      },
      // An item carried in from a prior meeting — does NOT count
      // as "raised this meeting".
      {
        actionItemId: 'ai-3',
        snapshotKind: 'live',
        snapshotStatus: 'In Progress',
        snapshotSection: 'old_business',
        snapshotAtMs: START_MS + 3000,
        firstRaisedHere: false,
      },
    ];
    const result = computeMeetingLiveMetrics({ ...baseInput(), snapshots });
    expect(result.itemsRaised).toBe(2);
  });

  it('dedupes multiple live snapshots for the same first-raised item', () => {
    // The TM-fold-2 partial UNIQUE doesn't prevent this scenario
    // (different statuses are semantically distinct), but the
    // metrics computation must count the action_item once.
    const snapshots: ReadonlyArray<MeetingActionItemSnapshotRow> = [
      {
        actionItemId: 'ai-1',
        snapshotKind: 'live',
        snapshotStatus: 'Not Started',
        snapshotSection: 'new_business',
        snapshotAtMs: START_MS + 1000,
        firstRaisedHere: true,
      },
      {
        actionItemId: 'ai-1',
        snapshotKind: 'live',
        snapshotStatus: 'In Progress',
        snapshotSection: 'new_business',
        snapshotAtMs: START_MS + 2000,
        firstRaisedHere: true,
      },
    ];
    const result = computeMeetingLiveMetrics({ ...baseInput(), snapshots });
    expect(result.itemsRaised).toBe(1);
  });
});

describe('computeMeetingLiveMetrics — case 3: closures (self + peer)', () => {
  it('counts self-attestation and peer-verified separately', () => {
    const closures: ReadonlyArray<MeetingClosureRow> = [
      { actionItemId: 'ai-1', selfAttestation: true },
      { actionItemId: 'ai-2', selfAttestation: false },
    ];
    const result = computeMeetingLiveMetrics({ ...baseInput(), closures });
    expect(result.itemsClosed).toBe(2);
    expect(result.closureVerifications.total).toBe(2);
    expect(result.closureVerifications.selfAttestation).toBe(1);
    expect(result.closureVerifications.peerVerified).toBe(1);
  });

  it('dedupes by action_item_id (UNIQUE prevents this in practice; defensive)', () => {
    const closures: ReadonlyArray<MeetingClosureRow> = [
      { actionItemId: 'ai-1', selfAttestation: true },
      // Duplicate — UNIQUE on action_item_id stops this at the DB
      // layer; the helper must remain idempotent if it ever slips.
      { actionItemId: 'ai-1', selfAttestation: false },
    ];
    const result = computeMeetingLiveMetrics({ ...baseInput(), closures });
    expect(result.itemsClosed).toBe(1);
    expect(result.closureVerifications.total).toBe(1);
    expect(result.closureVerifications.selfAttestation).toBe(1);
    expect(result.closureVerifications.peerVerified).toBe(0);
  });
});

describe('computeMeetingLiveMetrics — case 4: mixed live + finalized snapshots', () => {
  it('does NOT double-count items that have both live and finalized rows', () => {
    const snapshots: ReadonlyArray<MeetingActionItemSnapshotRow> = [
      {
        actionItemId: 'ai-1',
        snapshotKind: 'live',
        snapshotStatus: 'In Progress',
        snapshotSection: 'new_business',
        snapshotAtMs: START_MS + 1000,
        firstRaisedHere: true,
      },
      {
        actionItemId: 'ai-1',
        snapshotKind: 'finalized',
        snapshotStatus: 'In Progress',
        snapshotSection: 'new_business',
        snapshotAtMs: START_MS + 5000,
        firstRaisedHere: true,
      },
    ];
    const result = computeMeetingLiveMetrics({ ...baseInput(), snapshots });
    expect(result.itemsRaised).toBe(1);
  });
});

describe('computeMeetingLiveMetrics — case 5: quorum lost mid-meeting', () => {
  it('returns currentlyMet=false when attendance no longer reaches quorum', () => {
    const result = computeMeetingLiveMetrics({
      ...baseInput(),
      attendance: attendanceNonQuorate(),
    });
    expect(result.quorumCompliance.currentlyMet).toBe(false);
    expect(result.quorumCompliance.metAtCallToOrder).toBe(false);
  });
});

describe('computeMeetingLiveMetrics — case 6: post-adjournment duration is fixed', () => {
  it('uses actualEndAtMs when set, not nowMs', () => {
    const meeting = meetingCtx({
      status: 'adjourned',
      actualEndAtMs: END_MS,
    });
    const farFutureNow = END_MS + 365 * 24 * 60 * 60 * 1000;
    const result = computeMeetingLiveMetrics({
      ...baseInput(),
      meeting,
      nowMs: farFutureNow,
    });
    expect(result.durationSeconds).toBe(90 * 60);
  });

  it('counts inspections reviewed + recommendations drafted', () => {
    const inspectionReviews: ReadonlyArray<MeetingInspectionReviewRow> = [
      { inspectionId: 'insp-1' },
      { inspectionId: 'insp-2' },
    ];
    const recommendations: ReadonlyArray<MeetingRecommendationRow> = [
      { recommendationId: 'rec-1' },
    ];
    const result = computeMeetingLiveMetrics({
      ...baseInput(),
      inspectionReviews,
      recommendations,
    });
    expect(result.inspectionsReviewed).toBe(2);
    expect(result.recommendationsDrafted).toBe(1);
  });
});
