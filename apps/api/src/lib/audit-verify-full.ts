// Pure full-chain verifier for `audit-log-verify --full` (Milestone
// 1.12 S2, ADR-0011 §3.7).
//
// The script in `apps/api/scripts/audit-log-verify.ts` calls
// `verifyChainFull` after fetching the rows from Postgres. This module
// is DB-free: it accepts an array of row records + emits a structured
// report. The split keeps the verifier unit-testable in-memory without
// a Postgres dependency (see __tests__/audit-verify-full.test.ts).
//
// Spec checks (ADR-0011 §3.7):
//
//   1. Re-canonicalize each entry's payload via the same canonical-JSON
//      used at write time, recompute its SHA-256, and assert it
//      matches the stored `this_hash`. Catches "someone edited the
//      row" not just "someone broke the chain".
//
//   2. Re-verify the signing chain — verify each entry's Ed25519
//      signature against the public key registered for that signing
//      key id at the time of write. SKIPPED in 1.12: the audit-log
//      schema has no `signing_key_id` / `signature` columns. See
//      `docs/release-1-audit-verify-gaps.md` Gap 1.
//
//   3. Walk every `(actor_id, ts)` pair and assert monotonic per-actor
//      sequence numbers if the schema has them. SUBSTITUTED in 1.12:
//      no `sequence` column; we run a per-actor timestamp-monotonicity
//      check instead. See `docs/release-1-audit-verify-gaps.md` Gap 2.
//
//   4. `--since=<ISO timestamp>` window. Bounds the verification range
//      to rows with `ts >= since`. The runbook calls this with
//      `--since=<last-backup>` after a restore.
//
//   5. `--report=json` emits a machine-readable summary; default is
//      the human-readable report. Exit code: 0 if clean, 1 if any
//      divergence, 2 if the script itself can't read the chain.

import { computeThisHash, canonicalJsonStringify, GENESIS_PREV_HASH } from '@jhsc/audit';
import type { AuditEventKind, AuditPayload } from '@jhsc/shared-types';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Row shape — independent of Drizzle so tests can construct synthetic
// rows without a DB.
// ---------------------------------------------------------------------------

export interface AuditRow {
  readonly idx: number;
  readonly ts: Date;
  readonly actorId: string | null;
  readonly kind: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly prevHash: Uint8Array;
  readonly thisHash: Uint8Array;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export type FullVerifyDivergence =
  | { readonly kind: 'chain_link_mismatch'; readonly idx: number; readonly detail: string }
  | {
      readonly kind: 'payload_hash_mismatch';
      readonly idx: number;
      readonly storedHashHex: string;
      readonly recomputedHashHex: string;
    }
  | { readonly kind: 'idx_gap'; readonly idx: number; readonly previousIdx: number | null }
  | {
      readonly kind: 'genesis_prev_hash_invalid';
      readonly idx: 0;
    }
  | {
      readonly kind: 'payload_shape_mismatch';
      readonly idx: number;
      readonly detail: string;
    }
  | {
      readonly kind: 'actor_timestamp_regression';
      readonly actorId: string;
      readonly priorIdx: number;
      readonly priorTsMs: number;
      readonly currentIdx: number;
      readonly currentTsMs: number;
    };

export interface FullVerifyReport {
  readonly ok: boolean;
  readonly rowCount: number;
  readonly highestIdx: number | null;
  readonly lowestIdx: number | null;
  readonly rowsByKind: Readonly<Record<string, number>>;
  readonly divergences: ReadonlyArray<FullVerifyDivergence>;
  /** Aggregated counts. `hashMismatches` is the row-edit signal;
   *  `gaps` is the missing-idx signal — different remediation paths
   *  per docs/release-1-audit-verify-gaps.md / SECURITY T-HD24. */
  readonly counts: {
    readonly hashMismatches: number;
    readonly chainLinkMismatches: number;
    readonly gaps: number;
    readonly payloadShapeMismatches: number;
    readonly actorTimestampRegressions: number;
  };
  /** Window applied to this run (informational). */
  readonly window: {
    readonly sinceIso: string | null;
    readonly fromIdx: number | null;
    readonly toIdx: number | null;
  };
  /** Documented gaps that were NOT checked (per
   *  `docs/release-1-audit-verify-gaps.md`). The report enumerates
   *  these so the operator knows what was skipped. */
  readonly skippedChecks: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Pure verifier
// ---------------------------------------------------------------------------

export interface FullVerifyInput {
  /** Chain rows in ASC `idx` order. Caller is responsible for fetching
   *  + sorting. Rows BELOW the `sinceIso` window are EXCLUDED by the
   *  caller (the SQL `WHERE ts >= since` is the natural filter). */
  readonly rows: ReadonlyArray<AuditRow>;
  /** Window applied during fetch — echoed back into the report. */
  readonly window: {
    readonly sinceIso: string | null;
    readonly fromIdx: number | null;
    readonly toIdx: number | null;
  };
}

const ZERO_PREV_HASH_HEX = '00'.repeat(32);

export function verifyChainFull(input: FullVerifyInput): FullVerifyReport {
  const t0 = Date.now();
  const { rows, window } = input;

  const divergences: FullVerifyDivergence[] = [];
  const rowsByKind: Record<string, number> = {};

  let hashMismatches = 0;
  let chainLinkMismatches = 0;
  let gaps = 0;
  let payloadShapeMismatches = 0;
  let actorTimestampRegressions = 0;

  // Per-actor: last seen (idx, ts) to detect timestamp regressions.
  const perActorLastSeen = new Map<string, { idx: number; tsMs: number }>();

  let prevIdx: number | null = null;
  let prevHash: Uint8Array | null = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as AuditRow;
    rowsByKind[r.kind] = (rowsByKind[r.kind] ?? 0) + 1;

    // (a) Gap detection.
    //   - First row: must be either idx=0 (full-chain walk) or any
    //     idx (windowed walk — `sinceIso` excludes earlier rows).
    //     We do not require contiguity from 0 in the windowed case.
    //   - Subsequent rows: must be exactly prevIdx + 1.
    if (prevIdx !== null && r.idx !== prevIdx + 1) {
      divergences.push({ kind: 'idx_gap', idx: r.idx, previousIdx: prevIdx });
      gaps++;
      // Keep walking — a gap may be a deletion; we want to report
      // every gap, not stop at the first.
      prevIdx = r.idx;
      prevHash = r.thisHash;
      continue;
    }

    // (b) Chain-link check. The first row's prev_hash semantics:
    //   - If idx === 0: prev_hash must be GENESIS_PREV_HASH.
    //   - Otherwise (windowed run starting mid-chain): we accept the
    //     stored prev_hash as the anchor for the windowed walk. We
    //     cannot verify it against an earlier row that we did not
    //     fetch.
    if (i === 0) {
      if (r.idx === 0) {
        if (!bytesEqual(r.prevHash, GENESIS_PREV_HASH)) {
          divergences.push({ kind: 'genesis_prev_hash_invalid', idx: 0 });
          chainLinkMismatches++;
        }
      }
    } else {
      if (!bytesEqual(r.prevHash, prevHash as Uint8Array)) {
        divergences.push({
          kind: 'chain_link_mismatch',
          idx: r.idx,
          detail: `expected prev_hash=${bytesToHex(prevHash as Uint8Array)}, got ${bytesToHex(r.prevHash)}`,
        });
        chainLinkMismatches++;
      }
    }

    // (c) Payload structural shape check. (Gap-3 per
    //     docs/release-1-audit-verify-gaps.md: structural-only; per-
    //     kind field validation belongs in the post-Release-1
    //     forward-defense flags.)
    const shape = checkPayloadShape(r.payload, r.kind);
    if (!shape.ok) {
      divergences.push({
        kind: 'payload_shape_mismatch',
        idx: r.idx,
        detail: shape.reason,
      });
      payloadShapeMismatches++;
    }

    // (d) Re-canonicalize + recompute this_hash. This is the
    //     row-edit detector — it catches a payload mutation that
    //     leaves the prev_hash chain valid but breaks the row's own
    //     hash.
    //
    //     We only run this for rows whose payload shape passed the
    //     structural check above; otherwise `computeThisHash` may
    //     throw on a malformed payload (canonical-json rejects
    //     `undefined`, BigInt, NaN, etc.).
    if (shape.ok) {
      try {
        const recomputed = computeThisHash(
          r.prevHash,
          {
            idx: r.idx,
            tsMs: r.ts.getTime(),
            actorId: r.actorId,
            kind: r.kind as AuditEventKind,
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            ip: r.ip,
            userAgent: r.userAgent,
          },
          r.payload as AuditPayload,
        );
        if (!bytesEqual(recomputed, r.thisHash)) {
          divergences.push({
            kind: 'payload_hash_mismatch',
            idx: r.idx,
            storedHashHex: bytesToHex(r.thisHash),
            recomputedHashHex: bytesToHex(recomputed),
          });
          hashMismatches++;
        }
      } catch (err) {
        // computeThisHash threw because the payload contained an
        // unsupported value (undefined / NaN / BigInt). This is itself
        // a payload-shape failure that the structural check above
        // didn't catch — record as a shape mismatch with the inner
        // error message.
        divergences.push({
          kind: 'payload_shape_mismatch',
          idx: r.idx,
          detail: `canonicalization failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        payloadShapeMismatches++;
      }
    }

    // (e) Per-actor timestamp monotonicity (Gap-2 substitution).
    if (r.actorId !== null) {
      const last = perActorLastSeen.get(r.actorId);
      const currentMs = r.ts.getTime();
      if (last && currentMs < last.tsMs) {
        divergences.push({
          kind: 'actor_timestamp_regression',
          actorId: r.actorId,
          priorIdx: last.idx,
          priorTsMs: last.tsMs,
          currentIdx: r.idx,
          currentTsMs: currentMs,
        });
        actorTimestampRegressions++;
      }
      perActorLastSeen.set(r.actorId, { idx: r.idx, tsMs: currentMs });
    }

    prevIdx = r.idx;
    prevHash = r.thisHash;
  }

  // Sentinel: if window is unbounded and the first row's idx is not 0,
  // we have a leading gap (the chain does not start at the genesis
  // row). This is only a divergence if the operator asked for a full
  // walk (no `since`). Windowed walks legitimately skip earlier rows.
  if (window.sinceIso === null && window.fromIdx === null && rows.length > 0) {
    const firstIdx = (rows[0] as AuditRow).idx;
    if (firstIdx !== 0) {
      divergences.push({ kind: 'idx_gap', idx: firstIdx, previousIdx: null });
      gaps++;
    }
  }

  // Surface the documented gaps that this run did NOT check, so the
  // operator running the runbook sees the skip list per
  // `docs/release-1-audit-verify-gaps.md`.
  const skippedChecks: FullVerifyReport['skippedChecks'] = [
    {
      id: 'gap-1',
      reason: 'Ed25519 signature check skipped — no signing_key_id/signature columns on audit_log',
    },
    {
      id: 'gap-2',
      reason:
        'per-actor sequence check substituted with per-actor timestamp-monotonicity — no sequence column on audit_log',
    },
    {
      id: 'gap-3',
      reason:
        'per-kind field validation deferred to --check-{inspections,recommendations,excel} forward-defense flags',
    },
  ];

  const highestIdx = rows.length > 0 ? (rows[rows.length - 1] as AuditRow).idx : null;
  const lowestIdx = rows.length > 0 ? (rows[0] as AuditRow).idx : null;
  // ZERO_PREV_HASH_HEX is referenced by the runbook's expected-output
  // section; kept available for downstream consumers.
  void ZERO_PREV_HASH_HEX;

  return {
    ok: divergences.length === 0,
    rowCount: rows.length,
    highestIdx,
    lowestIdx,
    rowsByKind,
    divergences,
    counts: {
      hashMismatches,
      chainLinkMismatches,
      gaps,
      payloadShapeMismatches,
      actorTimestampRegressions,
    },
    window,
    skippedChecks,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Payload shape — structural-only check (per Gap-3).
// ---------------------------------------------------------------------------

function checkPayloadShape(
  payload: unknown,
  kind: string,
): { ok: true } | { ok: false; reason: string } {
  if (payload === null || payload === undefined) {
    return { ok: false, reason: 'payload is null or undefined' };
  }
  if (typeof payload !== 'object') {
    return { ok: false, reason: `payload is ${typeof payload}, expected object` };
  }
  if (Array.isArray(payload)) {
    return { ok: false, reason: 'payload is array, expected object' };
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.kind !== 'string') {
    return { ok: false, reason: 'payload.kind missing or not a string' };
  }
  if (obj.kind !== kind) {
    return { ok: false, reason: `payload.kind='${obj.kind}' but row.kind='${kind}'` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export function renderHumanReport(report: FullVerifyReport): string {
  const lines: string[] = [];
  lines.push(`audit-log-verify --full ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`  rows checked:            ${report.rowCount}`);
  lines.push(`  idx range:               ${report.lowestIdx ?? '-'}..${report.highestIdx ?? '-'}`);
  if (report.window.sinceIso) {
    lines.push(`  since:                   ${report.window.sinceIso}`);
  }
  lines.push(`  hash mismatches:         ${report.counts.hashMismatches}`);
  lines.push(`  chain-link mismatches:   ${report.counts.chainLinkMismatches}`);
  lines.push(`  idx gaps:                ${report.counts.gaps}`);
  lines.push(`  payload-shape mismatches:${report.counts.payloadShapeMismatches}`);
  lines.push(`  actor ts regressions:    ${report.counts.actorTimestampRegressions}`);
  lines.push(`  duration:                ${report.durationMs}ms`);
  lines.push('');
  lines.push('  rows by kind:');
  const kinds = Object.keys(report.rowsByKind).sort();
  for (const k of kinds) {
    lines.push(`    ${k.padEnd(40)} ${report.rowsByKind[k]}`);
  }
  if (report.skippedChecks.length > 0) {
    lines.push('');
    lines.push('  skipped checks (see docs/release-1-audit-verify-gaps.md):');
    for (const s of report.skippedChecks) {
      lines.push(`    [${s.id}] ${s.reason}`);
    }
  }
  if (report.divergences.length > 0) {
    lines.push('');
    lines.push('  divergences:');
    for (const d of report.divergences) {
      lines.push(`    - ${formatDivergence(d)}`);
    }
    lines.push('');
    lines.push('  Run docs/runbooks/auth.md §7 (tamper response) immediately.');
  }
  return lines.join('\n') + '\n';
}

export function renderJsonReport(report: FullVerifyReport): string {
  return (
    JSON.stringify({
      ok: report.ok,
      rowCount: report.rowCount,
      lowestIdx: report.lowestIdx,
      highestIdx: report.highestIdx,
      rowsByKind: report.rowsByKind,
      counts: report.counts,
      window: report.window,
      skippedChecks: report.skippedChecks,
      durationMs: report.durationMs,
      divergences: report.divergences.map((d) => ({
        ...d,
      })),
    }) + '\n'
  );
}

function formatDivergence(d: FullVerifyDivergence): string {
  switch (d.kind) {
    case 'chain_link_mismatch':
      return `idx=${d.idx} chain_link_mismatch ${d.detail}`;
    case 'payload_hash_mismatch':
      return `idx=${d.idx} payload_hash_mismatch stored=${d.storedHashHex.slice(0, 16)}... recomputed=${d.recomputedHashHex.slice(0, 16)}...`;
    case 'idx_gap':
      return `idx=${d.idx} idx_gap previousIdx=${d.previousIdx ?? 'null'}`;
    case 'genesis_prev_hash_invalid':
      return `idx=0 genesis_prev_hash_invalid`;
    case 'payload_shape_mismatch':
      return `idx=${d.idx} payload_shape_mismatch ${d.detail}`;
    case 'actor_timestamp_regression':
      return `actor=${d.actorId} timestamp regression: idx=${d.priorIdx}@${d.priorTsMs} -> idx=${d.currentIdx}@${d.currentTsMs}`;
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing — exported for the script entry + unit tests.
// ---------------------------------------------------------------------------

export interface FullArgs {
  readonly full: boolean;
  readonly sinceIso: string | null;
  readonly reportJson: boolean;
}

export function parseFullArgs(argv: ReadonlyArray<string>): FullArgs {
  let sinceIso: string | null = null;
  let reportJson = false;
  const full = argv.includes('--full');
  for (const arg of argv) {
    if (arg.startsWith('--since=')) {
      sinceIso = arg.slice('--since='.length);
    }
    if (arg === '--report=json') {
      reportJson = true;
    }
  }
  // Validate ISO timestamp shape (cheap structural check; the SQL
  // layer parses + rejects malformed inputs definitively).
  if (sinceIso !== null) {
    const d = new Date(sinceIso);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`--since: invalid ISO timestamp '${sinceIso}'`);
    }
  }
  return { full, sinceIso, reportJson };
}

// ---------------------------------------------------------------------------
// Test helpers — synthetic chain builder used by the unit tests.
// ---------------------------------------------------------------------------

export interface SyntheticAppendInput {
  readonly tsMs: number;
  readonly actorId: string | null;
  readonly kind: AuditEventKind;
  readonly payload: AuditPayload;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Build a synthetic in-memory chain from a sequence of append inputs.
 *  The result is a series of `AuditRow` records with correct
 *  `prev_hash` / `this_hash` linkage. Used by tests + by the
 *  fixture-generator script (post-Release-1 forward seam). */
export function buildSyntheticChain(appends: ReadonlyArray<SyntheticAppendInput>): AuditRow[] {
  const out: AuditRow[] = [];
  let prevHash: Uint8Array = GENESIS_PREV_HASH;
  for (let i = 0; i < appends.length; i++) {
    const a = appends[i] as SyntheticAppendInput;
    const headers = {
      idx: i,
      tsMs: a.tsMs,
      actorId: a.actorId,
      kind: a.kind,
      resourceType: a.resourceType ?? null,
      resourceId: a.resourceId ?? null,
      ip: a.ip ?? null,
      userAgent: a.userAgent ?? null,
    };
    const thisHash = computeThisHash(prevHash, headers, a.payload);
    out.push({
      idx: i,
      ts: new Date(a.tsMs),
      actorId: a.actorId,
      kind: a.kind,
      resourceType: a.resourceType ?? null,
      resourceId: a.resourceId ?? null,
      ip: a.ip ?? null,
      userAgent: a.userAgent ?? null,
      prevHash,
      thisHash,
      payload: a.payload,
    });
    prevHash = thisHash;
  }
  return out;
}

/** Re-export of the canonical-JSON serializer for tests that want to
 *  inspect the canonical form of a payload. */
export { canonicalJsonStringify, createHash as nodeCreateHash };
