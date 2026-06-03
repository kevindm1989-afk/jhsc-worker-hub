// GET /api/meetings/:id/metrics — Milestone 2.2 S2 (ADR-0013 §3.4 +
// TM-fold-3). Returns the live metrics dict for the dashboard chip-
// bar. The same shape that the adjournment route's
// `meeting.adjourned` payload carries — single source of truth via
// the S1 `computeMeetingLiveMetrics` helper.
//
// TM-fold-3 (T-IM17 + T-IM18) discipline:
//   * Cache-Control: no-store, no-cache, must-revalidate.
//   * Pragma: no-cache.
//   * Vary: Cookie — defends against an intermediate cache leaking
//     one rep's metrics to a different rep's session.
//   * Zod path validation rejects non-uuid `:id` before any DB read.
//   * Rate-limit middleware reuses the existing 1.5 token bucket
//     (T-IM17 mitigation); the chilling-effect bound is the
//     dashboard's 5s SWR poll (12/min) — generous capacity keeps
//     normal use under the limit.
//
// Read-only; no step-up; no chain emission (the metrics endpoint is
// the M2.2 selective read-anchoring posture — the canonical chain
// anchor for metrics is `meeting.adjourned` at adjournment time per
// ADR-0012 §3.8).

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../../auth/step-up';
import { getDb } from '../../db/client';
import {
  computeMeetingLiveMetrics,
  type MeetingActionItemSnapshotRow,
  type MeetingClosureRow,
  type MeetingInspectionReviewRow,
  type MeetingMetricsContext,
  type MeetingRecommendationRow,
} from '../../lib/compute-meeting-live-metrics';
import { rateLimit } from '../../middleware/rate-limit';
import { type QuorumAttendanceRow, type QuorumJurisdiction } from '../../lib/compute-quorum';
import type { ActionItemSection, ActionItemStatus } from '@jhsc/shared-types';
import { loadWorkplaceConfig } from '../../../../../config/workplace';

export const meetingMetricsRoute = new Hono();

meetingMetricsRoute.use('*', authMiddleware());
// T-IM17: reuse the rate-limit middleware; bucket is sized so the
// dashboard's 5s SWR poll across a 90-minute meeting (~1100 reads)
// fits comfortably and a hostile SWR-storm trips the bucket.
meetingMetricsRoute.use(
  '*',
  rateLimit({ name: 'meeting-metrics', capacity: 120, refillPerSecond: 4 }),
);

const uuidParam = z.string().uuid();

meetingMetricsRoute.get('/:id/metrics', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

  // TM-fold-3 (T-IM18): no caching at the wire layer. The route reads
  // from the canonical tables every time; an intermediate cache here
  // could surface one rep's session-scoped quorum view to another.
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Vary', 'Cookie');

  const db = getDb();
  const workplace = loadWorkplaceConfig();

  const meetingRows = (await db.execute(sql`
    SELECT id, status,
           actual_start_at,
           actual_end_at
    FROM meetings WHERE id = ${idParsed.data} LIMIT 1
  `)) as unknown as Array<{
    id: string;
    status: string;
    actual_start_at: Date | null;
    actual_end_at: Date | null;
  }>;
  if (meetingRows.length === 0) return c.json({ error: 'not_found' }, 404);
  const m = meetingRows[0]!;

  const snapshotRows = (await db.execute(sql`
    SELECT m.action_item_id,
           m.snapshot_kind,
           m.snapshot_status,
           m.snapshot_section,
           m.snapshot_at,
           ai.first_raised_meeting_id
    FROM meeting_action_item_state m
    LEFT JOIN action_items ai ON ai.id = m.action_item_id
    WHERE m.meeting_id = ${idParsed.data}
    ORDER BY m.action_item_id, m.snapshot_at DESC
  `)) as unknown as Array<{
    action_item_id: string;
    snapshot_kind: string;
    snapshot_status: string;
    snapshot_section: string;
    snapshot_at: Date;
    first_raised_meeting_id: string | null;
  }>;

  const closureRows = (await db.execute(sql`
    SELECT action_item_id, self_attestation
    FROM action_item_closures WHERE meeting_id = ${idParsed.data}
  `)) as unknown as Array<{ action_item_id: string; self_attestation: boolean }>;

  const inspectionReviewRows = (await db.execute(sql`
    SELECT inspection_id FROM meeting_inspection_review WHERE meeting_id = ${idParsed.data}
  `)) as unknown as Array<{ inspection_id: string }>;

  const recommendationRows = (await db.execute(sql`
    SELECT id FROM recommendations WHERE meeting_id = ${idParsed.data}
  `)) as unknown as Array<{ id: string }>;

  const attendanceRows = (await db.execute(sql`
    SELECT role, present_status FROM meeting_attendance WHERE meeting_id = ${idParsed.data}
  `)) as unknown as Array<{ role: string; present_status: string }>;

  const meeting: MeetingMetricsContext = {
    meetingId: idParsed.data,
    status: m.status as MeetingMetricsContext['status'],
    actualStartAtMs: m.actual_start_at ? m.actual_start_at.getTime() : null,
    actualEndAtMs: m.actual_end_at ? m.actual_end_at.getTime() : null,
    jurisdiction: workplace.jurisdiction as QuorumJurisdiction,
  };

  const snapshots: ReadonlyArray<MeetingActionItemSnapshotRow> = snapshotRows.map((r) => ({
    actionItemId: r.action_item_id,
    snapshotKind: r.snapshot_kind as 'live' | 'finalized',
    snapshotStatus: r.snapshot_status as ActionItemStatus,
    snapshotSection: r.snapshot_section as ActionItemSection,
    snapshotAtMs: r.snapshot_at.getTime(),
    firstRaisedHere: r.first_raised_meeting_id === idParsed.data,
  }));
  const attendance: ReadonlyArray<QuorumAttendanceRow> = attendanceRows.map((a) => ({
    role: a.role as QuorumAttendanceRow['role'],
    presentStatus: a.present_status as QuorumAttendanceRow['presentStatus'],
  }));
  const inspectionReviews: ReadonlyArray<MeetingInspectionReviewRow> = inspectionReviewRows.map(
    (r) => ({ inspectionId: r.inspection_id }),
  );
  const recommendations: ReadonlyArray<MeetingRecommendationRow> = recommendationRows.map((r) => ({
    recommendationId: r.id,
  }));
  const closures: ReadonlyArray<MeetingClosureRow> = closureRows.map((r) => ({
    actionItemId: r.action_item_id,
    selfAttestation: r.self_attestation,
  }));

  const metrics = computeMeetingLiveMetrics({
    meeting,
    snapshots,
    attendance,
    inspectionReviews,
    recommendations,
    closures,
    nowMs: Date.now(),
  });

  return c.json({
    ...metrics,
    asOf: new Date().toISOString(),
  });
});
