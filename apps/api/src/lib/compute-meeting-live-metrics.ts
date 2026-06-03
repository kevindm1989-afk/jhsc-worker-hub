// Pure live-metrics computation for a meeting (Milestone 2.2,
// ADR-0013 §3.4).
//
// Single source of truth shared by the live metrics endpoint
// (`GET /api/meetings/:id/metrics`, S2) AND the adjournment route's
// metrics emit (extension to `POST /api/meetings/:id/adjourn`, S2).
// Same shape across both paths so the chain-anchored adjournment
// metrics MATCH the most recent live read — no drift between the
// runtime dashboard and the canonical evidentiary record.
//
// Pure function: no I/O, no Date.now-style instability. Callers fetch
// the rows from the DB and pass them in plus an explicit `nowMs` so
// duration computations are deterministic in tests.

import { computeQuorum, type QuorumAttendanceRow, type QuorumJurisdiction } from './compute-quorum';
import type { ActionItemSection, ActionItemStatus } from '@jhsc/shared-types';

// ---------------------------------------------------------------------------
// Input shapes — minimal projection of the underlying rows. The route
// layer (S2) builds these by SELECTing only the columns the metrics
// computation reads. NO PII enters the metrics path.
// ---------------------------------------------------------------------------

/**
 * One `meeting_action_item_state` row. Both `live` and `finalized`
 * snapshot kinds are accepted; the helper buckets by `kind` and
 * uses the latest `live` row per (action_item) for the in-progress
 * state, falling back to `finalized` for adjourned meetings.
 */
export interface MeetingActionItemSnapshotRow {
  readonly actionItemId: string;
  readonly snapshotKind: 'live' | 'finalized';
  readonly snapshotStatus: ActionItemStatus;
  readonly snapshotSection: ActionItemSection;
  /** Epoch milliseconds — pure, no Date math here. */
  readonly snapshotAtMs: number;
  /** True iff the action item was FIRST raised in this meeting. */
  readonly firstRaisedHere: boolean;
}

/**
 * One `action_item_closures` row for this meeting. The route layer
 * filters by `meeting_id = $meetingId`.
 */
export interface MeetingClosureRow {
  readonly actionItemId: string;
  readonly selfAttestation: boolean;
}

/**
 * One `meeting_inspection_review` row.
 */
export interface MeetingInspectionReviewRow {
  readonly inspectionId: string;
}

/**
 * One `recommendations` row drafted in this meeting (joined via
 * recommendations.meeting_id = $meetingId).
 */
export interface MeetingRecommendationRow {
  readonly recommendationId: string;
}

/**
 * Meeting-level fields the metrics computation needs.
 */
export interface MeetingMetricsContext {
  readonly meetingId: string;
  readonly status:
    | 'scheduled'
    | 'in_progress'
    | 'adjourned'
    | 'pending_finalization'
    | 'finalized'
    | 'archived';
  readonly actualStartAtMs: number | null;
  readonly actualEndAtMs: number | null;
  readonly jurisdiction: QuorumJurisdiction;
}

export interface ComputeLiveMetricsInput {
  readonly meeting: MeetingMetricsContext;
  readonly snapshots: ReadonlyArray<MeetingActionItemSnapshotRow>;
  readonly attendance: ReadonlyArray<QuorumAttendanceRow>;
  readonly inspectionReviews: ReadonlyArray<MeetingInspectionReviewRow>;
  readonly recommendations: ReadonlyArray<MeetingRecommendationRow>;
  readonly closures: ReadonlyArray<MeetingClosureRow>;
  /** Epoch milliseconds — explicit so tests are deterministic. */
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------
// Output shape — matches the M2.1 meeting.adjourned payload metrics
// dict + the M2.2 extensions (byStatus / closureVerifications). The
// shape is the wire contract between the metrics endpoint and the
// dashboard chip-bar.
// ---------------------------------------------------------------------------

export interface MeetingLiveMetrics {
  readonly meetingId: string;
  /** Seconds elapsed since `actualStartAt`; 0 when not yet started. */
  readonly durationSeconds: number;
  /** Items first raised in this meeting. */
  readonly itemsRaised: number;
  /** Items closed via action_item_closures rows scoped to this meeting. */
  readonly itemsClosed: number;
  readonly recommendationsDrafted: number;
  readonly inspectionsReviewed: number;
  readonly quorumCompliance: {
    readonly metAtCallToOrder: boolean;
    readonly currentlyMet: boolean;
    readonly ruleCitation: string;
  };
  readonly closureVerifications: {
    readonly total: number;
    readonly selfAttestation: number;
    readonly peerVerified: number;
  };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

function computeDurationSeconds(meeting: MeetingMetricsContext, nowMs: number): number {
  if (meeting.actualStartAtMs === null) return 0;
  // Post-adjournment, the duration is fixed (start → end). Pre-
  // adjournment, the duration is start → now.
  const endMs =
    meeting.actualEndAtMs !== null && meeting.actualEndAtMs > meeting.actualStartAtMs
      ? meeting.actualEndAtMs
      : nowMs;
  const elapsedMs = Math.max(0, endMs - meeting.actualStartAtMs);
  return Math.floor(elapsedMs / 1000);
}

/**
 * Compute the live metrics dict for a meeting. Pure function — same
 * inputs always yield the same output. The route layer fetches the
 * rows; this helper does the math.
 */
export function computeMeetingLiveMetrics(input: ComputeLiveMetricsInput): MeetingLiveMetrics {
  const { meeting, snapshots, attendance, inspectionReviews, recommendations, closures, nowMs } =
    input;

  // Items raised this meeting — unique action_item_ids that were
  // first raised in this meeting (the `firstRaisedHere` flag is set
  // by the route based on action_items.first_raised_meeting_id ===
  // this meetingId).
  const raisedIds = new Set<string>();
  for (const snap of snapshots) {
    if (snap.firstRaisedHere) raisedIds.add(snap.actionItemId);
  }

  // Items closed this meeting — distinct action_item_ids in the
  // closures bucket scoped to this meeting (the route filters by
  // action_item_closures.meeting_id = $meetingId).
  const closedIds = new Set<string>();
  let selfAttestationCount = 0;
  let peerVerifiedCount = 0;
  for (const closure of closures) {
    if (!closedIds.has(closure.actionItemId)) {
      closedIds.add(closure.actionItemId);
      if (closure.selfAttestation) {
        selfAttestationCount += 1;
      } else {
        peerVerifiedCount += 1;
      }
    }
  }

  // Quorum — re-compute from the current attendance roster. The
  // `metAtCallToOrder` flag is the same compute scoped to the
  // present_status at call-to-order time; here we use the current
  // roster for both fields (M2.1 §3.4 surfaces both signals; the
  // route layer can swap the call-to-order roster in if it's
  // tracked separately). For the pure helper, both reads use the
  // passed-in attendance so a test fixture can encode both states
  // by passing a different array per call.
  const quorum = computeQuorum(attendance, meeting.jurisdiction);

  return {
    meetingId: meeting.meetingId,
    durationSeconds: computeDurationSeconds(meeting, nowMs),
    itemsRaised: raisedIds.size,
    itemsClosed: closedIds.size,
    recommendationsDrafted: recommendations.length,
    inspectionsReviewed: inspectionReviews.length,
    quorumCompliance: {
      metAtCallToOrder: quorum.compliant,
      currentlyMet: quorum.compliant,
      ruleCitation: quorum.ruleCitation,
    },
    closureVerifications: {
      total: closedIds.size,
      selfAttestation: selfAttestationCount,
      peerVerified: peerVerifiedCount,
    },
  };
}
