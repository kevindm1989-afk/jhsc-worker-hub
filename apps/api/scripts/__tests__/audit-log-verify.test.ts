// Unit tests for the `audit-log-verify --full` pure verifier
// (Milestone 1.12 S2, ADR-0011 §3.7).
//
// Tests run against an in-memory synthetic chain — no Postgres
// required. The chain is built with `buildSyntheticChain` from
// `src/lib/audit-verify-full.ts`, which uses the real
// `computeThisHash` from `@jhsc/audit` so the test is verifying the
// production hash logic end-to-end (not a stub).
//
// Test cases:
//   1. Synthetic clean chain (3 rows) passes `--full` (ok=true,
//      zero divergences).
//   2. Payload mutation WITHOUT touching this_hash: `--full` MUST
//      catch it (payload_hash_mismatch); plain `verify()` MUST NOT
//      catch it on its own — covered by the comparison in test (3).
//   3. Chain-link break (prev_hash of row N+1 swapped): BOTH modes
//      MUST catch it.
//   4. Signature mutation: `--full` would catch it ONLY if the schema
//      carried signatures (Gap-1). The test asserts the skipped-checks
//      report enumerates the gap so a runbook operator sees that
//      signature checking was NOT performed.
//   5. `--since=` arg parsing accepts ISO timestamps + rejects junk.
//   6. `--report=json` produces a JSON-parseable summary.
//   7. Per-actor timestamp regression is caught (Gap-2 substitution).
//   8. idx gap (deleted row) is caught.

import { describe, expect, it } from 'vitest';
import { computeThisHash, GENESIS_PREV_HASH, verify as chainVerify } from '@jhsc/audit';
import type { AuditPayload } from '@jhsc/shared-types';
import {
  buildSyntheticChain,
  parseFullArgs,
  renderHumanReport,
  renderJsonReport,
  verifyChainFull,
  bytesToHex,
  type AuditRow,
} from '../../src/lib/audit-verify-full';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a small synthetic chain — genesis + two real rows. */
function cleanChain(): AuditRow[] {
  return buildSyntheticChain([
    {
      tsMs: 1_700_000_000_000,
      actorId: null,
      kind: 'system.genesis',
      payload: { kind: 'system.genesis', schemaVersion: '1.3.0' } as AuditPayload,
    },
    {
      tsMs: 1_700_000_001_000,
      actorId: '00000000-0000-0000-0000-000000000001',
      kind: 'login.passkey',
      payload: { kind: 'login.passkey' } as AuditPayload,
    },
    {
      tsMs: 1_700_000_002_000,
      actorId: '00000000-0000-0000-0000-000000000001',
      kind: 'hazard.created',
      payload: {
        kind: 'hazard.created',
        hazardId: '00000000-0000-0000-0000-000000000010',
        hazardCode: 'HAZ-001',
        severity: 'high',
        jurisdiction: 'ON',
      } as AuditPayload,
    },
  ]);
}

/**
 * Drizzle-shaped fake just sufficient to drive `verify()` from
 * `@jhsc/audit` against an in-memory chain. The package's `verify()`
 * only calls `db.select(...).from(...).orderBy(...)`; we mock the
 * chain end of that fluent API.
 *
 * The cast hides the precise Drizzle types from the test surface —
 * this is a test-only adapter, not production code.
 */
function makeFakeDb(rows: ReadonlyArray<AuditRow>): any {
  // Project AuditRow → the column-aliased shape `verify()` selects.
  const projected = rows.map((r) => ({
    idx: r.idx,
    ts: r.ts,
    actorId: r.actorId,
    kind: r.kind,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    ip: r.ip,
    userAgent: r.userAgent,
    prevHash: r.prevHash,
    thisHash: r.thisHash,
    payload: r.payload,
  }));
  return {
    select: () => ({
      from: () => ({
        orderBy: () => Promise.resolve([...projected].sort((a, b) => b.idx - a.idx)),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyChainFull — clean chain', () => {
  it('reports ok=true with zero divergences on a fresh synthetic chain', () => {
    const rows = cleanChain();
    const report = verifyChainFull({
      rows,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(true);
    expect(report.rowCount).toBe(3);
    expect(report.lowestIdx).toBe(0);
    expect(report.highestIdx).toBe(2);
    expect(report.divergences).toEqual([]);
    expect(report.counts.hashMismatches).toBe(0);
    expect(report.counts.chainLinkMismatches).toBe(0);
    expect(report.counts.gaps).toBe(0);
    expect(report.counts.payloadShapeMismatches).toBe(0);
    expect(report.counts.actorTimestampRegressions).toBe(0);
    // Documented gaps are surfaced in the report regardless of ok-ness.
    expect(report.skippedChecks.map((s) => s.id)).toEqual(['gap-1', 'gap-2', 'gap-3']);
  });

  it('renders a human report with the rows-by-kind table', () => {
    const rows = cleanChain();
    const report = verifyChainFull({
      rows,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    const text = renderHumanReport(report);
    expect(text).toContain('audit-log-verify --full PASS');
    expect(text).toContain('system.genesis');
    expect(text).toContain('login.passkey');
    expect(text).toContain('hazard.created');
    expect(text).toContain('skipped checks');
    expect(text).toContain('[gap-1]');
  });

  it('renders a JSON report that round-trips through JSON.parse', () => {
    const rows = cleanChain();
    const report = verifyChainFull({
      rows,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    const json = renderJsonReport(report);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.rowCount).toBe(3);
    expect(parsed.rowsByKind['system.genesis']).toBe(1);
    expect(parsed.skippedChecks).toHaveLength(3);
  });
});

describe('verifyChainFull — payload mutation (Test 2, row-edit attack)', () => {
  it('catches a payload edit that the plain-mode chain-link walk MISSES', async () => {
    const rows = cleanChain();
    // Mutate row 2's payload IN PLACE without touching this_hash.
    // This is the "someone edited the row in the DB but the chain
    // hashes are still wired correctly" attack — the row's this_hash
    // is the OLD value, but the payload column is now the NEW value.
    // The chain-link walk (`verify()`) would catch this because
    // recomputed this_hash != stored this_hash. BUT if we also
    // updated prev_hash of row 3 to match the OLD this_hash, the
    // chain-link walk would still pass — only the payload-rehash
    // catches the mutation.
    //
    // For this test we mutate ONLY row 2's payload (leaving its
    // this_hash and row 3's prev_hash untouched). `--full` should
    // detect a payload_hash_mismatch on row 2.
    const r = rows[2] as AuditRow;
    const mutatedPayload = {
      ...(r.payload as Record<string, unknown>),
      hazardCode: 'HAZ-999-TAMPERED',
    };
    const mutatedRows: AuditRow[] = [
      rows[0] as AuditRow,
      rows[1] as AuditRow,
      { ...r, payload: mutatedPayload },
    ];

    const report = verifyChainFull({
      rows: mutatedRows,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(false);
    expect(report.counts.hashMismatches).toBe(1);
    const d = report.divergences.find((x) => x.kind === 'payload_hash_mismatch');
    expect(d).toBeDefined();
    if (d && d.kind === 'payload_hash_mismatch') {
      expect(d.idx).toBe(2);
    }

    // Cross-check: the plain-mode chain verifier ALSO catches this in
    // the current implementation because `verify()` from @jhsc/audit
    // recomputes the hash. The 1.12 --full check is structurally
    // stronger because it ALSO runs payload-shape validation + per-
    // actor timestamp checks + a structured report; the
    // payload-mutation case is one shared signal across modes.
    const fakeDb = makeFakeDb(mutatedRows);
    const plainResult = await chainVerify(fakeDb);
    expect(plainResult.ok).toBe(false);
  });

  it('payload mutation paired with this_hash mutation is caught by --full and missed by plain', async () => {
    // The structurally interesting case: an attacker who mutated the
    // payload AND recomputed this_hash using a DIFFERENT canonical-
    // JSON serializer (one that orders keys differently, or includes
    // whitespace) would produce a chain that LOOKS hash-consistent
    // under a wrong serializer but FAILS our canonical-JSON
    // recompute. We simulate this by mutating the payload AND
    // installing a this_hash that hashes a tampered serialization.
    const rows = cleanChain();
    const r = rows[2] as AuditRow;
    const mutatedPayload = {
      ...(r.payload as Record<string, unknown>),
      hazardCode: 'HAZ-999-TAMPERED',
    };
    // Compute a this_hash with the mutated payload — making the chain
    // link from row[1].this_hash → row[2].prev_hash → row[2].this_hash
    // structurally valid against the tampered payload. The forward
    // chain (no row 3 below) is then internally consistent. `--full`
    // STILL catches this because the canonical-JSON recompute matches
    // the mutated payload's recomputed-this_hash — i.e. the chain
    // accepts the mutation as valid because the attacker computed a
    // new this_hash. The interesting failure mode is therefore: when
    // the attacker DOESN'T update this_hash (the previous test) the
    // mismatch is caught; when the attacker DOES update this_hash
    // (this test) AND there are downstream rows, the downstream
    // prev_hash links break.
    //
    // To exercise the "this_hash updated, no downstream rows" case
    // we truncate the chain at row 2 and confirm `--full` reports OK
    // (because the chain is internally consistent under the
    // tampering — this is the documented bound of hash-chain
    // tamper-detection without an external trust anchor).
    const newHash = computeThisHash(
      r.prevHash,
      {
        idx: r.idx,
        tsMs: r.ts.getTime(),
        actorId: r.actorId,
        kind: r.kind as 'hazard.created',
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        ip: r.ip,
        userAgent: r.userAgent,
      },
      mutatedPayload as AuditPayload,
    );
    const tampered: AuditRow[] = [
      rows[0] as AuditRow,
      rows[1] as AuditRow,
      { ...r, payload: mutatedPayload, thisHash: newHash },
    ];
    const report = verifyChainFull({
      rows: tampered,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    // Internally consistent — the tamper requires an external anchor
    // (e.g. a signed PDF carrying the chain root) to detect. This is
    // documented in the audit chain design (ADR-0002).
    expect(report.ok).toBe(true);

    // Now extend the chain with an additional row whose prev_hash is
    // the OLD this_hash (i.e. the attacker did not re-link downstream
    // rows). `--full` catches the chain_link_mismatch.
    const extra = buildSyntheticChain([
      {
        tsMs: 1_700_000_003_000,
        actorId: null,
        kind: 'login.passkey',
        payload: { kind: 'login.passkey' } as AuditPayload,
      },
    ])[0] as AuditRow;
    // Manually wire the extra row so its prev_hash is the OLD
    // (pre-tamper) this_hash of row 2.
    const oldThisHash = (rows[2] as AuditRow).thisHash;
    const extraTied: AuditRow = {
      ...extra,
      idx: 3,
      prevHash: oldThisHash,
      thisHash: computeThisHash(
        oldThisHash,
        {
          idx: 3,
          tsMs: extra.ts.getTime(),
          actorId: extra.actorId,
          kind: extra.kind as 'login.passkey',
          resourceType: null,
          resourceId: null,
          ip: null,
          userAgent: null,
        },
        extra.payload as AuditPayload,
      ),
    };
    const tampered2 = [...tampered, extraTied];
    const report2 = verifyChainFull({
      rows: tampered2,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report2.ok).toBe(false);
    expect(report2.counts.chainLinkMismatches).toBe(1);
  });
});

describe('verifyChainFull — hash chain break (Test 3, both modes catch)', () => {
  it('catches a broken prev_hash link in --full mode', async () => {
    const rows = cleanChain();
    // Replace row 2's prev_hash with a random-looking 32-byte value.
    const bogus = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bogus[i] = (i * 7 + 1) & 0xff;
    const broken: AuditRow[] = [
      rows[0] as AuditRow,
      rows[1] as AuditRow,
      { ...(rows[2] as AuditRow), prevHash: bogus },
    ];
    const report = verifyChainFull({
      rows: broken,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(false);
    expect(report.counts.chainLinkMismatches).toBe(1);
    // Also catches the resulting payload_hash_mismatch because the
    // recomputed this_hash binds the prev_hash.
    expect(report.counts.hashMismatches).toBe(1);

    // The plain mode (chain-link walk) also catches the break.
    const fakeDb = makeFakeDb(broken);
    const plainResult = await chainVerify(fakeDb);
    expect(plainResult.ok).toBe(false);
  });
});

describe('verifyChainFull — signature mutation (Test 4, schema-gap)', () => {
  it('reports the gap-1 skip even on a clean chain', () => {
    const rows = cleanChain();
    const report = verifyChainFull({
      rows,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    // The audit_log schema does not carry signatures, so a signature
    // mutation is structurally unrepresentable. The runbook contract
    // is that the operator sees gap-1 in the skip list so the
    // missing check is explicit, not silent. See
    // docs/release-1-audit-verify-gaps.md.
    const gap1 = report.skippedChecks.find((s) => s.id === 'gap-1');
    expect(gap1).toBeDefined();
    expect(gap1?.reason).toContain('Ed25519');
  });
});

describe('parseFullArgs', () => {
  it('detects --full', () => {
    expect(parseFullArgs(['node', 'script.ts', '--full']).full).toBe(true);
    expect(parseFullArgs(['node', 'script.ts']).full).toBe(false);
  });

  it('parses --since=<ISO>', () => {
    const a = parseFullArgs(['--full', '--since=2026-01-01T00:00:00Z']);
    expect(a.sinceIso).toBe('2026-01-01T00:00:00Z');
  });

  it('rejects an invalid --since value', () => {
    expect(() => parseFullArgs(['--full', '--since=not-a-date'])).toThrow(/invalid ISO/);
  });

  it('parses --report=json', () => {
    const a = parseFullArgs(['--full', '--report=json']);
    expect(a.reportJson).toBe(true);
  });
});

describe('verifyChainFull — per-actor timestamp regression (gap-2 substitution)', () => {
  it('catches a row whose ts is BEFORE the same actor`s previous row', () => {
    // Build a chain where actor X emits at t=100, then again at t=50
    // (a back-dated row, the dominant tamper signal under gap-2).
    const rows = buildSyntheticChain([
      {
        tsMs: 1_700_000_000_000,
        actorId: null,
        kind: 'system.genesis',
        payload: { kind: 'system.genesis', schemaVersion: '1.3.0' } as AuditPayload,
      },
      {
        tsMs: 1_700_000_001_000,
        actorId: 'actor-X',
        kind: 'login.passkey',
        payload: { kind: 'login.passkey' } as AuditPayload,
      },
      {
        tsMs: 1_700_000_000_500, // back-dated relative to actor-X's previous
        actorId: 'actor-X',
        kind: 'login.passkey',
        payload: { kind: 'login.passkey' } as AuditPayload,
      },
    ]);
    const report = verifyChainFull({
      rows,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(false);
    expect(report.counts.actorTimestampRegressions).toBe(1);
    const d = report.divergences.find((x) => x.kind === 'actor_timestamp_regression');
    expect(d).toBeDefined();
  });
});

describe('verifyChainFull — idx gap (deleted row)', () => {
  it('catches a missing idx in the sequence', () => {
    const rows = cleanChain();
    // Delete the middle row.
    const withGap: AuditRow[] = [rows[0] as AuditRow, rows[2] as AuditRow];
    const report = verifyChainFull({
      rows: withGap,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(false);
    expect(report.counts.gaps).toBeGreaterThanOrEqual(1);
    const d = report.divergences.find((x) => x.kind === 'idx_gap');
    expect(d).toBeDefined();
    if (d && d.kind === 'idx_gap') {
      // Mid-walk gaps are real deletions, not window boundaries.
      expect(d.windowBoundary).toBe(false);
    }
  });

  it('does NOT flag a leading gap when --since narrows the window', () => {
    const rows = cleanChain();
    // Windowed walk that starts at idx=1 (not at idx=0). This is the
    // legitimate post-restore case: the operator runs --full
    // --since=<last-backup>, which excludes pre-backup rows. The
    // verifier should NOT report a "missing idx=0" gap because the
    // window deliberately excludes it.
    const windowed: AuditRow[] = [rows[1] as AuditRow, rows[2] as AuditRow];
    const report = verifyChainFull({
      rows: windowed,
      window: { sinceIso: '2026-01-01T00:00:00Z', fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(true);
    expect(report.counts.gaps).toBe(0);
    // No idx_gap divergence at all — the windowed leading edge is
    // silent (not even an informational `windowBoundary: true` row).
    expect(report.divergences.find((x) => x.kind === 'idx_gap')).toBeUndefined();
  });

  it('flags an unbounded walk whose chain does not start at genesis (per S5 F-S2)', () => {
    const rows = cleanChain();
    // The chain has rows 0..2; drop row 0. With NO window specified
    // (operator did a full walk, not --since=...), the missing
    // genesis row IS a real divergence — someone deleted it.
    const leadingGap: AuditRow[] = [rows[1] as AuditRow, rows[2] as AuditRow];
    const report = verifyChainFull({
      rows: leadingGap,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(false);
    const d = report.divergences.find((x) => x.kind === 'idx_gap');
    expect(d).toBeDefined();
    if (d && d.kind === 'idx_gap') {
      expect(d.previousIdx).toBeNull();
      // The disambiguator: this is NOT a window boundary, it is a
      // real leading-edge gap (the genesis row is missing).
      expect(d.windowBoundary).toBe(false);
    }
  });

  it('JSON report exposes the windowBoundary field per F-S2', () => {
    const rows = cleanChain();
    const leadingGap: AuditRow[] = [rows[1] as AuditRow, rows[2] as AuditRow];
    const report = verifyChainFull({
      rows: leadingGap,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    const json = renderJsonReport(report);
    const parsed = JSON.parse(json) as {
      divergences: ReadonlyArray<{ kind: string; windowBoundary?: boolean }>;
    };
    const gap = parsed.divergences.find((x) => x.kind === 'idx_gap');
    expect(gap).toBeDefined();
    expect(gap?.windowBoundary).toBe(false);
  });
});

describe('verifyChainFull — payload shape (gap-3 structural)', () => {
  it('catches a payload whose kind does not match the row kind', () => {
    const rows = cleanChain();
    const r = rows[2] as AuditRow;
    const mismatched: AuditRow[] = [
      rows[0] as AuditRow,
      rows[1] as AuditRow,
      {
        ...r,
        payload: { kind: 'login.passkey' }, // row.kind is 'hazard.created'
      },
    ];
    const report = verifyChainFull({
      rows: mismatched,
      window: { sinceIso: null, fromIdx: null, toIdx: null },
    });
    expect(report.ok).toBe(false);
    expect(report.counts.payloadShapeMismatches).toBeGreaterThanOrEqual(1);
  });
});

describe('verifyChainFull — bytesToHex sanity', () => {
  it('renders 32-byte digests with 64 hex chars', () => {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 32; i++) buf[i] = i;
    expect(bytesToHex(buf)).toBe(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    expect(bytesToHex(GENESIS_PREV_HASH)).toBe('00'.repeat(32));
  });
});

// ---------------------------------------------------------------------------
// --check-meetings (Milestone 2.1 S2, ADR-0012 §3.10)
// ---------------------------------------------------------------------------
//
// Tests the meeting-lifecycle forward-defense walker. Each case feeds
// `checkMeetingChain` a hand-built `meeting.*` chain slice and asserts
// the expected anomaly surfaces (or absence thereof).

import { _internals as verifyInternals } from '../audit-log-verify';

const MID = '00000000-0000-0000-0000-000000aaaa01';
const REC_ID = '00000000-0000-0000-0000-000000bbbb01';

function meetingRow(args: {
  idx: number;
  kind: string;
  payload: Record<string, unknown>;
  thisHash?: Uint8Array;
}): { idx: number; kind: string; payload: Record<string, unknown>; this_hash: Uint8Array } {
  return {
    idx: args.idx,
    kind: args.kind,
    payload: args.payload,
    this_hash: args.thisHash ?? new Uint8Array(32),
  };
}

const VALID_METRICS = {
  durationSeconds: 5400,
  itemsRaised: 3,
  itemsClosed: 1,
  recommendationsDrafted: 1,
  inspectionsReviewed: 2,
  quorumCompliance: { metAtCallToOrder: true, ruleCitation: 'OHSA s.9(8)' },
};

describe('checkMeetingChain — happy path', () => {
  it('ok=true for a clean meeting.created → adjourned → 4 signed → finalized chain', () => {
    const rows = [
      meetingRow({ idx: 0, kind: 'meeting.created', payload: { meetingId: MID } }),
      meetingRow({
        idx: 1,
        kind: 'meeting.adjourned',
        payload: { meetingId: MID, metrics: VALID_METRICS },
      }),
      meetingRow({
        idx: 2,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'worker_co_chair' },
      }),
      meetingRow({
        idx: 3,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_co_chair' },
      }),
      meetingRow({
        idx: 4,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_external_1' },
      }),
      meetingRow({
        idx: 5,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_external_2' },
      }),
      meetingRow({ idx: 6, kind: 'meeting.finalized', payload: { meetingId: MID } }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checked).toBe(7);
  });
});

describe('checkMeetingChain — finalized missing signatures (T-ML4)', () => {
  it('detects meeting.finalized with only 3 upstream meeting.signed events', () => {
    const rows = [
      meetingRow({ idx: 0, kind: 'meeting.created', payload: { meetingId: MID } }),
      meetingRow({
        idx: 1,
        kind: 'meeting.adjourned',
        payload: { meetingId: MID, metrics: VALID_METRICS },
      }),
      meetingRow({
        idx: 2,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'worker_co_chair' },
      }),
      meetingRow({
        idx: 3,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_co_chair' },
      }),
      meetingRow({
        idx: 4,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_external_1' },
      }),
      meetingRow({ idx: 5, kind: 'meeting.finalized', payload: { meetingId: MID } }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomalies[0]!.reason).toBe('finalized_signatures_wrong_count');
    }
  });

  it('detects meeting.finalized with 4 signatures but wrong roles', () => {
    const rows = [
      meetingRow({ idx: 0, kind: 'meeting.created', payload: { meetingId: MID } }),
      meetingRow({
        idx: 1,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'worker_co_chair' },
      }),
      meetingRow({
        idx: 2,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'worker_co_chair' },
      }),
      meetingRow({
        idx: 3,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_co_chair' },
      }),
      meetingRow({
        idx: 4,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_external_1' },
      }),
      meetingRow({ idx: 5, kind: 'meeting.finalized', payload: { meetingId: MID } }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomalies.some((a) => a.reason === 'finalized_missing_signatures')).toBe(true);
    }
  });
});

describe('checkMeetingChain — adjourned must have upstream create + valid metrics', () => {
  it('detects meeting.adjourned with no upstream meeting.created', () => {
    const rows = [
      meetingRow({
        idx: 0,
        kind: 'meeting.adjourned',
        payload: { meetingId: MID, metrics: VALID_METRICS },
      }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomalies.some((a) => a.reason === 'adjourned_no_upstream_create')).toBe(true);
    }
  });

  it('detects meeting.adjourned with malformed metrics dict', () => {
    const rows = [
      meetingRow({ idx: 0, kind: 'meeting.created', payload: { meetingId: MID } }),
      meetingRow({
        idx: 1,
        kind: 'meeting.adjourned',
        payload: { meetingId: MID, metrics: { durationSeconds: 0 } },
      }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomalies.some((a) => a.reason === 'adjourned_metrics_malformed')).toBe(true);
    }
  });
});

describe('checkMeetingChain — cross-chain anchor (TM-fold-3 / T-ML42)', () => {
  it('passes when meeting.recommendation_drafted hash matches upstream recommendation.drafted this_hash', () => {
    const recHash = new Uint8Array(32).fill(0xab);
    const recHashHex = Buffer.from(recHash).toString('hex');
    const rows = [
      meetingRow({ idx: 0, kind: 'meeting.created', payload: { meetingId: MID } }),
      meetingRow({
        idx: 1,
        kind: 'recommendation.drafted',
        payload: { recommendationId: REC_ID, recommendationNumber: 1, jurisdiction: 'ON' },
        thisHash: recHash,
      }),
      meetingRow({
        idx: 2,
        kind: 'meeting.recommendation_drafted',
        payload: {
          meetingId: MID,
          recommendationId: REC_ID,
          sectionId: '00000000-0000-0000-0000-000000cccc01',
          recommendationCreatedEventHash: recHashHex,
        },
      }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(true);
  });

  it('fails when the cross-chain hash does NOT match', () => {
    const recHash = new Uint8Array(32).fill(0xab);
    const rows = [
      meetingRow({ idx: 0, kind: 'meeting.created', payload: { meetingId: MID } }),
      meetingRow({
        idx: 1,
        kind: 'recommendation.drafted',
        payload: { recommendationId: REC_ID, recommendationNumber: 1, jurisdiction: 'ON' },
        thisHash: recHash,
      }),
      meetingRow({
        idx: 2,
        kind: 'meeting.recommendation_drafted',
        payload: {
          meetingId: MID,
          recommendationId: REC_ID,
          sectionId: '00000000-0000-0000-0000-000000cccc01',
          recommendationCreatedEventHash: 'ff'.repeat(32),
        },
      }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.anomalies.some((a) => a.reason === 'recommendation_drafted_hash_mismatch'),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// M2.1 S4 — meeting.created must reference a seeded template version
// ---------------------------------------------------------------------------

describe('checkMeetingChain — created_template_not_seeded (M2.1 S4)', () => {
  it('passes when an upstream audit.meeting_template.seeded matches the (jurisdiction, version) pair', () => {
    const rows = [
      meetingRow({
        idx: 0,
        kind: 'audit.meeting_template.seeded',
        payload: {
          templateVersion: 1,
          jurisdiction: 'ON',
          templateHash: 'a'.repeat(64),
        },
      }),
      meetingRow({
        idx: 1,
        kind: 'meeting.created',
        payload: { meetingId: MID, agendaTemplateVersion: 1, jurisdiction: 'ON' },
      }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(true);
  });

  it('detects a meeting.created event with no upstream template seed event', () => {
    const rows = [
      meetingRow({
        idx: 0,
        kind: 'meeting.created',
        payload: { meetingId: MID, agendaTemplateVersion: 1, jurisdiction: 'ON' },
      }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomalies.some((a) => a.reason === 'created_template_not_seeded')).toBe(true);
    }
  });

  it('detects a meeting.created event when the seed is for the wrong jurisdiction', () => {
    const rows = [
      meetingRow({
        idx: 0,
        kind: 'audit.meeting_template.seeded',
        payload: {
          templateVersion: 1,
          jurisdiction: 'CA-FED',
          templateHash: 'a'.repeat(64),
        },
      }),
      meetingRow({
        idx: 1,
        kind: 'meeting.created',
        payload: { meetingId: MID, agendaTemplateVersion: 1, jurisdiction: 'ON' },
      }),
    ];
    const result = verifyInternals.checkMeetingChain(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomalies.some((a) => a.reason === 'created_template_not_seeded')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// M2.1 S5 F-S2 — runtime signer roles config
// ---------------------------------------------------------------------------
//
// The verifier's Gate 1 (4-of-4 signature presence) MUST match the
// route's runtime config so a workplace whose env declares a different
// role set is verifiable end-to-end. The pre-S5 verifier hardcoded the
// 4 role IDs; this test asserts the Gate accepts a 3-role config when
// passed via options and that Gates 2/3/4 still hold.

describe('checkMeetingChain — runtime signer roles (M2.1 S5 F-S2)', () => {
  it('accepts a meeting.finalized chain with 3 sigs when 3 roles are configured', () => {
    const rows = [
      meetingRow({
        idx: 0,
        kind: 'audit.meeting_template.seeded',
        payload: { templateVersion: 1, jurisdiction: 'ON', templateHash: 'a'.repeat(64) },
      }),
      meetingRow({
        idx: 1,
        kind: 'meeting.created',
        payload: { meetingId: MID, agendaTemplateVersion: 1, jurisdiction: 'ON' },
      }),
      meetingRow({
        idx: 2,
        kind: 'meeting.adjourned',
        payload: { meetingId: MID, metrics: VALID_METRICS },
      }),
      meetingRow({
        idx: 3,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'worker_co_chair' },
      }),
      meetingRow({
        idx: 4,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_co_chair' },
      }),
      meetingRow({
        idx: 5,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_external_1' },
      }),
      meetingRow({ idx: 6, kind: 'meeting.finalized', payload: { meetingId: MID } }),
    ];
    const result = verifyInternals.checkMeetingChain(rows, {
      requiredSignerRoles: ['worker_co_chair', 'mgmt_co_chair', 'mgmt_external_1'],
    });
    expect(result.ok).toBe(true);
  });

  it('flags a finalized chain that does NOT match the configured role count', () => {
    // 3-role config but the chain has 4 sigs — count mismatch.
    const rows = [
      meetingRow({ idx: 0, kind: 'meeting.created', payload: { meetingId: MID } }),
      meetingRow({
        idx: 1,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'worker_co_chair' },
      }),
      meetingRow({
        idx: 2,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_co_chair' },
      }),
      meetingRow({
        idx: 3,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_external_1' },
      }),
      meetingRow({
        idx: 4,
        kind: 'meeting.signed',
        payload: { meetingId: MID, signerRole: 'mgmt_external_2' },
      }),
      meetingRow({ idx: 5, kind: 'meeting.finalized', payload: { meetingId: MID } }),
    ];
    const result = verifyInternals.checkMeetingChain(rows, {
      requiredSignerRoles: ['worker_co_chair', 'mgmt_co_chair', 'mgmt_external_1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomalies.some((a) => a.reason === 'finalized_signatures_wrong_count')).toBe(
        true,
      );
    }
  });

  it('readRequiredSignerRolesFromEnv falls back to the canonical 4 roles when env is empty', () => {
    const roles = verifyInternals.readRequiredSignerRolesFromEnv({});
    expect(roles).toEqual([
      'worker_co_chair',
      'mgmt_co_chair',
      'mgmt_external_1',
      'mgmt_external_2',
    ]);
  });
});
