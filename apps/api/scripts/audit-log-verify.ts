#!/usr/bin/env bun
// Audit-log chain verifier (ADR-0002, runbook §7).
//
// Walks audit_log idx ASC, recomputes this_hash for every row, and
// exits 0 on PASS or non-zero with the diverging idx on FAIL. Run
// nightly via cron / pg-boss (SECURITY.md §3 — Audit & Logging).
//
// Usage:
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --quiet
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --check-backfill
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --check-evidence
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --check-sync
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --check-meetings
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --full
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --full --since=2026-01-01T00:00:00Z
//   DATABASE_URL=... bun run scripts/audit-log-verify.ts --full --report=json
//
// Exit codes
//   0   chain verified (and any requested anchor checks pass)
//   1   tamper detected (firstDivergence reported, or backfill mismatch,
//       or evidence forward-defense check fails, or sync_idempotency
//       anomaly detected, or --full reported any divergence)
//   2   operational error (could not reach DB, etc.)
//
// --full (ADR-0011 §3.7, Milestone 1.12 S2)
//   Re-canonicalizes + rehashes every chain row's payload, walks the
//   chain-link sequence, runs per-actor timestamp monotonicity, and
//   emits a structured report. See docs/release-1-audit-verify-gaps.md
//   for the documented skip-list (Ed25519 signatures, per-actor
//   sequence column, per-kind field validation).

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalJsonStringify, verify } from '@jhsc/audit';
import { authEvents } from '../src/db/schema';
import { getDb } from '../src/db/client';
import {
  parseFullArgs,
  renderHumanReport,
  renderJsonReport,
  verifyChainFull,
  type AuditRow,
} from '../src/lib/audit-verify-full';

interface AuthEventRow {
  id: string;
  ts: Date;
  actor_id: string | null;
  kind: string;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

interface BackfillAnchorPayload {
  kind: 'audit.backfill.1_2_auth_events';
  rowCount: number;
  rowsSha256: string;
  oldestTs: string | null;
  newestTs: string | null;
}

async function checkBackfillAnchor(
  db: ReturnType<typeof getDb>,
): Promise<
  { ok: true; rowCount: number } | { ok: false; reason: string; expected?: string; actual?: string }
> {
  // Read the anchor (idx=1, kind='audit.backfill.1_2_auth_events').
  const anchorRows = (await db.execute(sql`
    SELECT payload FROM audit_log
    WHERE idx = 1 AND kind = 'audit.backfill.1_2_auth_events'
  `)) as unknown as Array<{ payload: BackfillAnchorPayload }>;
  if (anchorRows.length === 0) {
    return { ok: false, reason: 'anchor_missing' };
  }
  const stored = anchorRows[0]!.payload;
  // Recompute rowsSha256 from live auth_events.
  const rows = (await db.execute(sql`
    SELECT id, ts, actor_id, kind, ip, user_agent, metadata
    FROM ${authEvents}
    ORDER BY ts ASC, id ASC
  `)) as unknown as AuthEventRow[];
  const canonical = canonicalJsonStringify(
    rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      actor_id: r.actor_id,
      kind: r.kind,
      ip: r.ip,
      user_agent: r.user_agent,
      metadata: r.metadata,
    })),
  );
  const liveHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  if (liveHash !== stored.rowsSha256) {
    return {
      ok: false,
      reason: 'rowsSha256_mismatch',
      expected: stored.rowsSha256,
      actual: liveHash,
    };
  }
  if (rows.length !== stored.rowCount) {
    return {
      ok: false,
      reason: 'rowCount_mismatch',
      expected: String(stored.rowCount),
      actual: String(rows.length),
    };
  }
  return { ok: true, rowCount: rows.length };
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * sec-F1 forward defense: reject any chain row whose payload carries
 * the all-zero placeholder UUID. The pre-fix evidence finalize handler
 * (Milestone 1.7) emitted `evidence.uploaded` rows with a literal
 * '00000000-0000-0000-0000-000000000000' in the `evidenceId` slot — the
 * fix is to pre-allocate the UUID, but a regression here would silently
 * break the chain-only export contract. Scan all rows for the marker.
 */
async function checkEvidenceForwardDefense(
  db: ReturnType<typeof getDb>,
): Promise<{ ok: true; checked: number } | { ok: false; offendingIdx: number; kind: string }> {
  const rows = (await db.execute(sql`
    SELECT idx, kind, payload
    FROM audit_log
    WHERE kind IN ('evidence.uploaded', 'evidence.read')
    ORDER BY idx ASC
  `)) as unknown as Array<{ idx: number; kind: string; payload: { evidenceId?: string } }>;
  for (const row of rows) {
    if (row.payload.evidenceId === ZERO_UUID) {
      return { ok: false, offendingIdx: row.idx, kind: row.kind };
    }
  }
  return { ok: true, checked: rows.length };
}

// ---------------------------------------------------------------------------
// --check-sync forward defense (Milestone 1.10 S4, ADR-0009 §3.4)
// ---------------------------------------------------------------------------
//
// `sync_idempotency` is the server-side idempotency cache backing the
// queue worker's per-request `Idempotency-Key` header. Each row has a
// 7-day TTL (`expires_at`); ADR-0009 §3.4 + the migration-0009 comment
// reserve the cleanup-sweep job for the 1.12 pg-boss work. Until then,
// the table grows monotonically.
//
// `--check-sync` is the forward-defense surface for the gap. It scans
// for three anomaly classes:
//
//   1. `expired_unswept`           — rows past `expires_at` plus a 1-day
//                                    grace. These should have been
//                                    swept; if any exist after 1.12
//                                    lands, the sweep job has regressed.
//                                    Until 1.12 the script accumulates
//                                    findings; the operator monitors the
//                                    count to decide when to push the
//                                    cleanup work forward.
//   2. `orphan_actor`              — rows whose `actor_user_id` has no
//                                    matching `users.id`. Referential
//                                    integrity sentinel; a successful
//                                    user delete should have CASCADEd
//                                    these (FK is `ON DELETE RESTRICT`
//                                    today — the cascade is a 1.12
//                                    line item).
//   3. `cached_5xx`                — rows whose `response_status_code`
//                                    is 5xx. Per ADR-0009 §3.4 the
//                                    middleware is supposed to skip
//                                    caching 5xx responses (so the
//                                    queue worker's retry actually
//                                    contacts the handler again).
//                                    A 5xx row here means the contract
//                                    regressed.
//
// Each anomaly maps to a SECURITY.md §2.10 threat:
//   - T-S9   queue tamper (idempotency cache should not leak across the
//            TTL).
//   - T-S10  replay surface (a stale 5xx cache hit would mask a server-
//            side regression from the rep).
//   - T-S39  sync chip false-Synced (the rep's chip relies on the
//            server's idempotency state being consistent).
//   - T-S41  dead-letter ignore (a cached 5xx that should have been a
//            retry would silently fail the rep into dead-letter).

interface SyncIdempotencyRow {
  id: string;
  actor_user_id: string;
  action_kind: string;
  response_status_code: number;
  created_at: Date;
  expires_at: Date;
  user_exists: boolean;
}

interface SyncAnomaly {
  /** The idempotency row UUID. */
  readonly id: string;
  /** A short reason code: 'expired_unswept' | 'orphan_actor' | 'cached_5xx'. */
  readonly reason: 'expired_unswept' | 'orphan_actor' | 'cached_5xx';
  /** Human-readable detail, e.g. age (for expired rows) or status code. */
  readonly detail: string;
  /** action_kind for context (POST /api/hazards, etc.). */
  readonly actionKind: string;
}

/** The 1-day grace window past `expires_at` before we treat the row as
 * "should have been swept." Matches the migration-0009 comment that the
 * sweep job will run daily under pg-boss in 1.12. */
const SWEEP_GRACE_INTERVAL_DAYS = 1;

async function checkSyncIdempotency(
  db: ReturnType<typeof getDb>,
): Promise<
  | { ok: true; rowsChecked: number }
  | { ok: false; anomalies: ReadonlyArray<SyncAnomaly>; rowsChecked: number }
> {
  // Single read joining sync_idempotency LEFT JOIN users — we need the
  // referential-integrity sentinel and the row contents in one round-
  // trip. The `user_exists` boolean is true iff the FK target row is
  // still in `users`.
  const rows = (await db.execute(sql`
    SELECT
      si.id::text AS id,
      si.actor_user_id::text AS actor_user_id,
      si.action_kind,
      si.response_status_code,
      si.created_at,
      si.expires_at,
      (u.id IS NOT NULL) AS user_exists
    FROM sync_idempotency si
    LEFT JOIN users u ON u.id = si.actor_user_id
    ORDER BY si.created_at ASC
  `)) as unknown as SyncIdempotencyRow[];

  const now = new Date();
  const graceMs = SWEEP_GRACE_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  const anomalies: SyncAnomaly[] = [];

  for (const row of rows) {
    // 1. expired_unswept — row is past expires_at + 1d grace.
    const expiredMs = now.getTime() - row.expires_at.getTime();
    if (expiredMs > graceMs) {
      const ageHours = Math.round(expiredMs / (60 * 60 * 1000));
      anomalies.push({
        id: row.id,
        reason: 'expired_unswept',
        detail: `${ageHours}h past TTL (sweep job 1.12 not yet running)`,
        actionKind: row.action_kind,
      });
    }
    // 2. orphan_actor — actor_user_id no longer exists.
    if (!row.user_exists) {
      anomalies.push({
        id: row.id,
        reason: 'orphan_actor',
        detail: `actor_user_id=${row.actor_user_id} has no users row`,
        actionKind: row.action_kind,
      });
    }
    // 3. cached_5xx — 5xx response was cached, contract violation.
    if (row.response_status_code >= 500 && row.response_status_code < 600) {
      anomalies.push({
        id: row.id,
        reason: 'cached_5xx',
        detail: `response_status_code=${row.response_status_code} should not have been cached`,
        actionKind: row.action_kind,
      });
    }
  }

  if (anomalies.length === 0) {
    return { ok: true, rowsChecked: rows.length };
  }
  return { ok: false, anomalies, rowsChecked: rows.length };
}

// ---------------------------------------------------------------------------
// --check-meetings forward defense (Milestone 2.1 S2, ADR-0012 §3.10)
// ---------------------------------------------------------------------------
//
// Walks every `meeting.*` chain event and asserts:
//
//   1. Every `meeting.finalized` event has all 4 required
//      `meeting.signed` events UPSTREAM with the required role coverage
//      (worker_co_chair + mgmt_co_chair + mgmt_external_1 +
//      mgmt_external_2). T-ML4 (4-sig bypass) close-out.
//
//   2. Every `meeting.adjourned` event has at least one
//      `meeting.created` event upstream (referencing the same
//      meetingId) AND a structurally valid metrics dict. T-ML16
//      (replay) + T-ML9 (PI leak) close-out.
//
//   3. Every `meeting.recommendation_drafted` event's
//      `recommendationCreatedEventHash` matches the `this_hash` of an
//      upstream `recommendation.drafted` event for the same
//      recommendationId. TM-fold-3 / T-ML42 cross-chain anchor
//      integrity.
//
// Anomalies are aggregated and reported one per offending event.

interface MeetingChainRow {
  idx: number;
  kind: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  this_hash: Uint8Array | Buffer;
}

interface MeetingAnomaly {
  readonly idx: number;
  readonly kind: string;
  readonly reason:
    | 'finalized_missing_signatures'
    | 'finalized_signatures_wrong_count'
    | 'adjourned_no_upstream_create'
    | 'adjourned_metrics_malformed'
    | 'recommendation_drafted_hash_missing'
    | 'recommendation_drafted_hash_mismatch';
  readonly detail: string;
}

const REQUIRED_SIGNER_ROLES = [
  'worker_co_chair',
  'mgmt_co_chair',
  'mgmt_external_1',
  'mgmt_external_2',
] as const;

function checkMeetingChain(
  rows: ReadonlyArray<MeetingChainRow>,
):
  | { ok: true; checked: number }
  | { ok: false; anomalies: ReadonlyArray<MeetingAnomaly>; checked: number } {
  const meetingEvents = rows.filter((r) => r.kind.startsWith('meeting.'));
  const recommendationDraftedEvents = rows.filter((r) => r.kind === 'recommendation.drafted');

  // Index recommendation.drafted by recommendationId for O(1) lookup.
  const recDraftedByRecId = new Map<string, MeetingChainRow>();
  for (const r of recommendationDraftedEvents) {
    const recId = r.payload?.recommendationId;
    if (typeof recId === 'string') recDraftedByRecId.set(recId, r);
  }

  // Group meeting events by meetingId.
  const byMeetingId = new Map<string, MeetingChainRow[]>();
  for (const e of meetingEvents) {
    const mid = e.payload?.meetingId;
    if (typeof mid !== 'string') continue;
    const list = byMeetingId.get(mid) ?? [];
    list.push(e);
    byMeetingId.set(mid, list);
  }

  const anomalies: MeetingAnomaly[] = [];

  for (const e of meetingEvents) {
    const mid = e.payload?.meetingId;
    if (typeof mid !== 'string') continue;
    const peers = byMeetingId.get(mid) ?? [];

    if (e.kind === 'meeting.finalized') {
      // Gate 1: 4 meeting.signed events upstream of this finalized event
      // covering all 4 required roles.
      const sigsUpstream = peers.filter((p) => p.kind === 'meeting.signed' && p.idx < e.idx);
      if (sigsUpstream.length !== 4) {
        anomalies.push({
          idx: e.idx,
          kind: e.kind,
          reason: 'finalized_signatures_wrong_count',
          detail: `expected 4 meeting.signed events; found ${sigsUpstream.length}`,
        });
        continue;
      }
      const roles = new Set(sigsUpstream.map((s) => s.payload?.signerRole));
      const missing = REQUIRED_SIGNER_ROLES.filter((r) => !roles.has(r));
      if (missing.length > 0) {
        anomalies.push({
          idx: e.idx,
          kind: e.kind,
          reason: 'finalized_missing_signatures',
          detail: `missing signer roles: ${missing.join(', ')}`,
        });
      }
    } else if (e.kind === 'meeting.adjourned') {
      // Gate 2: a meeting.created event upstream.
      const created = peers.find((p) => p.kind === 'meeting.created' && p.idx < e.idx);
      if (!created) {
        anomalies.push({
          idx: e.idx,
          kind: e.kind,
          reason: 'adjourned_no_upstream_create',
          detail: 'no meeting.created event found upstream of this meeting.adjourned',
        });
      }
      // Structural metrics dict check (PI-free shape).
      const m = e.payload?.metrics;
      const metricsOk =
        m &&
        typeof m === 'object' &&
        typeof m.durationSeconds === 'number' &&
        typeof m.itemsRaised === 'number' &&
        typeof m.itemsClosed === 'number' &&
        typeof m.recommendationsDrafted === 'number' &&
        typeof m.inspectionsReviewed === 'number' &&
        m.quorumCompliance &&
        typeof m.quorumCompliance.metAtCallToOrder === 'boolean' &&
        typeof m.quorumCompliance.ruleCitation === 'string';
      if (!metricsOk) {
        anomalies.push({
          idx: e.idx,
          kind: e.kind,
          reason: 'adjourned_metrics_malformed',
          detail: 'metrics dict missing required structural fields',
        });
      }
    } else if (e.kind === 'meeting.recommendation_drafted') {
      // Gate 3: cross-chain anchor hash match (TM-fold-3 / T-ML42).
      const recId = e.payload?.recommendationId;
      const claimedHash = e.payload?.recommendationCreatedEventHash;
      if (typeof recId !== 'string' || typeof claimedHash !== 'string') {
        anomalies.push({
          idx: e.idx,
          kind: e.kind,
          reason: 'recommendation_drafted_hash_missing',
          detail: 'recommendationId or recommendationCreatedEventHash missing from payload',
        });
        continue;
      }
      const recDrafted = recDraftedByRecId.get(recId);
      if (!recDrafted) {
        anomalies.push({
          idx: e.idx,
          kind: e.kind,
          reason: 'recommendation_drafted_hash_missing',
          detail: `no upstream recommendation.drafted event for recommendationId=${recId}`,
        });
        continue;
      }
      const actualHash = Buffer.from(recDrafted.this_hash).toString('hex');
      if (actualHash !== claimedHash) {
        anomalies.push({
          idx: e.idx,
          kind: e.kind,
          reason: 'recommendation_drafted_hash_mismatch',
          detail: `payload hash=${claimedHash} does not match recommendation.drafted hash=${actualHash}`,
        });
      }
    }
  }

  if (anomalies.length === 0) {
    return { ok: true, checked: meetingEvents.length };
  }
  return { ok: false, anomalies, checked: meetingEvents.length };
}

export const _internals = { checkMeetingChain };

/**
 * Fetch the audit_log rows in idx-ASC order, optionally bounded by
 * `ts >= sinceIso`. Returns the rows in the in-memory `AuditRow` shape
 * the pure verifier consumes.
 */
async function fetchChainRows(
  db: ReturnType<typeof getDb>,
  sinceIso: string | null,
): Promise<AuditRow[]> {
  // We rely on SQL filtering for the windowed case so we do not pull
  // megabytes of pre-window rows into memory just to discard them.
  const rows = (sinceIso
    ? await db.execute(sql`
        SELECT idx, ts, actor_id, kind, resource_type, resource_id, ip,
               user_agent, prev_hash, this_hash, payload
        FROM audit_log
        WHERE ts >= ${sinceIso}::timestamptz
        ORDER BY idx ASC
      `)
    : await db.execute(sql`
        SELECT idx, ts, actor_id, kind, resource_type, resource_id, ip,
               user_agent, prev_hash, this_hash, payload
        FROM audit_log
        ORDER BY idx ASC
      `)) as unknown as Array<{
    idx: number | string;
    ts: Date;
    actor_id: string | null;
    kind: string;
    resource_type: string | null;
    resource_id: string | null;
    ip: string | null;
    user_agent: string | null;
    prev_hash: Uint8Array | Buffer;
    this_hash: Uint8Array | Buffer;
    payload: unknown;
  }>;
  return rows.map((r) => ({
    idx: Number(r.idx),
    ts: r.ts,
    actorId: r.actor_id,
    kind: r.kind,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    ip: r.ip,
    userAgent: r.user_agent,
    prevHash: Uint8Array.from(r.prev_hash as Uint8Array | Buffer),
    thisHash: Uint8Array.from(r.this_hash as Uint8Array | Buffer),
    payload: r.payload,
  }));
}

async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet');
  const checkBackfill = process.argv.includes('--check-backfill');
  const checkEvidence = process.argv.includes('--check-evidence');
  const checkSync = process.argv.includes('--check-sync');
  const checkMeetings = process.argv.includes('--check-meetings');
  const fullArgs = parseFullArgs(process.argv);

  const db = getDb();

  // --full mode: skip the existing per-row spot-check and run the
  // structured full-chain verifier. The two modes are mutually
  // exclusive at the report level — combining them would produce two
  // overlapping reports for the same chain; the --full report
  // supersedes the spot-check.
  if (fullArgs.full) {
    const rows = await fetchChainRows(db, fullArgs.sinceIso);
    const report = verifyChainFull({
      rows,
      window: {
        sinceIso: fullArgs.sinceIso,
        fromIdx: null,
        toIdx: null,
      },
    });
    if (fullArgs.reportJson) {
      process.stdout.write(renderJsonReport(report));
    } else {
      process.stdout.write(renderHumanReport(report));
    }
    process.exit(report.ok ? 0 : 1);
  }

  const result = await verify(db);
  if (!result.ok) {
    if (quiet) {
      process.stdout.write(
        `audit-log-verify TAMPER firstDivergence=${result.firstDivergence} reason=${result.reason}\n`,
      );
    } else {
      process.stderr.write(
        `audit-log-verify FAIL\n  first divergence at idx: ${result.firstDivergence}\n  reason:                  ${result.reason}\n`,
      );
      process.stderr.write('\nRun docs/runbooks/auth.md §7 (tamper response) immediately.\n');
    }
    process.exit(1);
  }

  if (checkEvidence) {
    const evidence = await checkEvidenceForwardDefense(db);
    if (!evidence.ok) {
      if (quiet) {
        process.stdout.write(
          `audit-log-verify EVIDENCE_PLACEHOLDER_UUID idx=${evidence.offendingIdx} kind=${evidence.kind}\n`,
        );
      } else {
        process.stderr.write(
          `audit-log-verify FAIL (evidence forward defense)\n  offending idx: ${evidence.offendingIdx}\n  kind:          ${evidence.kind}\n  reason:        evidenceId is the all-zero placeholder UUID\n`,
        );
        process.stderr.write(
          '\nA evidence audit payload carries the sec-F1 placeholder UUID — the finalize handler regressed. Inspect the offending row and re-run the fix.\n',
        );
      }
      process.exit(1);
    }
    if (!quiet) {
      process.stdout.write(
        `audit-log-verify evidence forward defense: ${evidence.checked} chain row(s) checked, no placeholder UUIDs found.\n`,
      );
    }
  }

  if (checkSync) {
    const syncCheck = await checkSyncIdempotency(db);
    if (!syncCheck.ok) {
      if (quiet) {
        // One line per anomaly so a downstream log scraper can grep.
        for (const a of syncCheck.anomalies) {
          process.stdout.write(
            `audit-log-verify SYNC_IDEMPOTENCY_ANOMALY id=${a.id} reason=${a.reason} action=${a.actionKind} detail=${a.detail.replaceAll(' ', '_')}\n`,
          );
        }
      } else {
        process.stderr.write(
          `audit-log-verify FAIL (sync idempotency forward defense)\n  rows checked:  ${syncCheck.rowsChecked}\n  anomalies:     ${syncCheck.anomalies.length}\n`,
        );
        for (const a of syncCheck.anomalies) {
          process.stderr.write(
            `    - id=${a.id} reason=${a.reason} action='${a.actionKind}' (${a.detail})\n`,
          );
        }
        process.stderr.write(
          '\nReason codes:\n  expired_unswept — TTL grace exceeded; 1.12 pg-boss sweep job is overdue.\n  orphan_actor    — referential integrity broken; investigate the users delete that left it behind.\n  cached_5xx      — contract violation; the middleware should not cache 5xx responses (ADR-0009 §3.4).\n\nSee SECURITY.md §2.10 (T-S9, T-S10, T-S39, T-S41) and docs/runbooks/auth.md.\n',
        );
      }
      process.exit(1);
    }
    if (!quiet) {
      process.stdout.write(
        `audit-log-verify sync forward defense: ${syncCheck.rowsChecked} sync_idempotency row(s) checked, no anomalies found.\n`,
      );
    }
  }

  if (checkMeetings) {
    const meetingRows = (await db.execute(sql`
      SELECT idx, kind, payload, this_hash
      FROM audit_log
      WHERE kind LIKE 'meeting.%' OR kind = 'recommendation.drafted'
      ORDER BY idx ASC
    `)) as unknown as Array<{
      idx: number | string;
      kind: string;
      payload: unknown;
      this_hash: Uint8Array | Buffer;
    }>;
    const meetingsCheck = checkMeetingChain(
      meetingRows.map((r) => ({
        idx: Number(r.idx),
        kind: r.kind,
        payload: r.payload,
        this_hash: r.this_hash,
      })),
    );
    if (!meetingsCheck.ok) {
      if (quiet) {
        for (const a of meetingsCheck.anomalies) {
          process.stdout.write(
            `audit-log-verify MEETING_ANOMALY idx=${a.idx} kind=${a.kind} reason=${a.reason}\n`,
          );
        }
      } else {
        process.stderr.write(
          `audit-log-verify FAIL (meeting lifecycle forward defense)\n  rows checked:  ${meetingsCheck.checked}\n  anomalies:     ${meetingsCheck.anomalies.length}\n`,
        );
        for (const a of meetingsCheck.anomalies) {
          process.stderr.write(
            `    - idx=${a.idx} kind='${a.kind}' reason=${a.reason} (${a.detail})\n`,
          );
        }
        process.stderr.write(
          '\nReason codes:\n  finalized_signatures_wrong_count   — meeting.finalized requires 4 meeting.signed upstream (ADR-0012 §3.9).\n  finalized_missing_signatures       — required signer roles missing.\n  adjourned_no_upstream_create       — meeting.adjourned lacks the meeting.created anchor.\n  adjourned_metrics_malformed        — metrics dict missing required PI-free fields.\n  recommendation_drafted_hash_*      — TM-fold-3 cross-chain anchor integrity broken.\n',
        );
      }
      process.exit(1);
    }
    if (!quiet) {
      process.stdout.write(
        `audit-log-verify meeting forward defense: ${meetingsCheck.checked} meeting.* chain row(s) checked, no anomalies found.\n`,
      );
    }
  }

  if (checkBackfill) {
    const backfill = await checkBackfillAnchor(db);
    if (!backfill.ok) {
      if (quiet) {
        process.stdout.write(
          `audit-log-verify BACKFILL_TAMPER reason=${backfill.reason}${backfill.expected ? ` expected=${backfill.expected}` : ''}${backfill.actual ? ` actual=${backfill.actual}` : ''}\n`,
        );
      } else {
        process.stderr.write(
          `audit-log-verify FAIL (backfill anchor)\n  reason: ${backfill.reason}\n${backfill.expected ? `  expected rowsSha256: ${backfill.expected}\n  actual rowsSha256:   ${backfill.actual}\n` : ''}`,
        );
        process.stderr.write(
          '\nLive auth_events no longer matches the idx=1 backfill anchor — chain integrity for the 1.2 window is BROKEN. Runbook §7.\n',
        );
      }
      process.exit(1);
    }
    if (quiet) {
      process.stdout.write(
        `audit-log-verify OK rows=${result.checked} lastIdx=${result.lastIdx} backfillRows=${backfill.rowCount}\n`,
      );
    } else {
      process.stdout.write(
        `audit-log-verify PASS\n  rows checked:    ${result.checked}\n  last idx:        ${result.lastIdx}\n  backfill anchor: ${backfill.rowCount} row(s), rowsSha256 matches live auth_events\n`,
      );
    }
    process.exit(0);
  }

  if (quiet) {
    process.stdout.write(`audit-log-verify OK rows=${result.checked} lastIdx=${result.lastIdx}\n`);
  } else {
    process.stdout.write(
      `audit-log-verify PASS\n  rows checked: ${result.checked}\n  last idx:     ${result.lastIdx}\n`,
    );
  }
  process.exit(0);
}

// Only run main() when invoked as a script (not when imported by tests).
// Importing the module for its `_internals` export must not trigger the
// process.exit(2) / DATABASE_URL operational path.
const invokedAsScript =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /audit-log-verify(\.ts|\.js)?$/.test(process.argv[1]);
if (invokedAsScript) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `audit-log-verify operational error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(2);
  });
}
