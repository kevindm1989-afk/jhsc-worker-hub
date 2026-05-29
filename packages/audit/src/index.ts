// @jhsc/audit — tamper-evident hash-chain logger (ADR-0002).
//
// Public surface:
//   - append(args) — writes one row inside a transaction, computing
//     this_hash from the previous row's this_hash.
//   - verify({fromIdx?, toIdx?}) — walks idx ASC and reports the first
//     hash divergence. Genesis must have prev_hash = \x00 × 32.
//   - computeThisHash(...) — exported for migration scripts that seed
//     genesis + backfill anchors without going through append().
//   - GENESIS_PREV_HASH — \x00 × 32.

import { createHash } from 'node:crypto';
import { sql, desc, gte, lte } from 'drizzle-orm';
import type { AuditEventKind, AuditPayload } from '@jhsc/shared-types';
import { canonicalJsonStringify } from './canonical-json';
import { auditLog } from './schema';

export { auditLog } from './schema';
export { canonicalJsonStringify } from './canonical-json';

export const HASH_BYTES = 32;
export const GENESIS_PREV_HASH = new Uint8Array(HASH_BYTES); // \x00 × 32

// ---------------------------------------------------------------------------
// Drizzle type erasure — keep the package decoupled from a specific
// Drizzle client. We accept any object exposing the methods we use.
// ---------------------------------------------------------------------------

export interface DrizzlePg {
  transaction<T>(fn: (tx: DrizzlePg) => Promise<T>): Promise<T>;
  // The narrower select/insert/execute shape would force us to import
  // Drizzle's internal types here. We `any` the chainable returns and
  // rely on the call sites to be typed by the consumer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(arg?: unknown): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: unknown): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(query: unknown): any;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

export interface ChainHeaders {
  readonly idx: number;
  /** Epoch milliseconds — included in the hash so timestamp tamper is detectable. */
  readonly tsMs: number;
  readonly actorId: string | null;
  readonly kind: AuditEventKind;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  /** Source IP for auth-surface events. null for non-auth modules. */
  readonly ip: string | null;
  /** Browser user-agent for auth-surface events. null otherwise. */
  readonly userAgent: string | null;
}

export function computeThisHash(
  prevHash: Uint8Array,
  headers: ChainHeaders,
  payload: AuditPayload,
): Uint8Array {
  if (prevHash.length !== HASH_BYTES) {
    throw new Error(`prev_hash must be ${HASH_BYTES} bytes; got ${prevHash.length}`);
  }
  const canonical = canonicalJsonStringify({
    idx: headers.idx,
    ts_ms: headers.tsMs,
    actor_id: headers.actorId,
    kind: headers.kind,
    resource_type: headers.resourceType,
    resource_id: headers.resourceId,
    ip: headers.ip,
    user_agent: headers.userAgent,
    payload,
  });
  const h = createHash('sha256');
  h.update(Buffer.from(prevHash));
  h.update(canonical, 'utf8');
  return new Uint8Array(h.digest());
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

export interface AppendInput {
  readonly actorId?: string | null;
  readonly payload: AuditPayload;
  /** Optional — defaults to payload.kind. */
  readonly kind?: AuditEventKind;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** Optional — defaults to Date.now(). Caller sets this for backfill scripts. */
  readonly nowMs?: number;
}

export interface AppendedRow {
  readonly idx: number;
  readonly thisHash: Uint8Array;
}

// Transaction-scoped advisory-lock key. Picked once for the chain;
// FOR UPDATE on a moving "latest" row does NOT actually serialize
// concurrent appenders under READ COMMITTED — Postgres' EvalPlanQual
// can return a stale row to a blocked transaction after the lock
// holder commits, leading both to compute the same nextIdx and one
// to hit the audit_log_pkey collision. The advisory lock serializes
// the entire critical section (SELECT-MAX → compute hash → INSERT)
// across all appenders for the duration of the transaction.
const AUDIT_APPEND_LOCK_KEY = 0x6175_6469_745f_6c6fn; // ascii "audi" "t_lo" — arbitrary stable key

export async function append(db: DrizzlePg, input: AppendInput): Promise<AppendedRow> {
  const kind = (input.kind ?? input.payload.kind) as AuditEventKind;
  return db.transaction(async (tx) => {
    // Serialize concurrent appenders via a transaction-scoped advisory
    // lock. Releases on commit/rollback automatically (no UNLOCK call
    // needed — that's the `_xact_` variant).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_APPEND_LOCK_KEY})`);
    const latest = (await tx.execute(sql`
      SELECT idx, this_hash
      FROM ${auditLog}
      ORDER BY idx DESC
      LIMIT 1
    `)) as unknown as Array<{ idx: string | number; this_hash: Uint8Array | Buffer }>;
    const prev = latest[0];
    const nextIdx = prev ? Number(prev.idx) + 1 : 0;
    const prevHash = prev
      ? Uint8Array.from(prev.this_hash as Uint8Array | Buffer)
      : GENESIS_PREV_HASH;
    const tsMs = input.nowMs ?? Date.now();
    const ts = new Date(tsMs);
    const headers: ChainHeaders = {
      idx: nextIdx,
      tsMs,
      actorId: input.actorId ?? null,
      kind,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    };
    const thisHash = computeThisHash(prevHash, headers, input.payload);
    await tx.insert(auditLog).values({
      idx: nextIdx,
      ts,
      actorId: input.actorId ?? null,
      kind,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      prevHash: Buffer.from(prevHash) as unknown as Uint8Array,
      thisHash: Buffer.from(thisHash) as unknown as Uint8Array,
      payload: input.payload as unknown as Record<string, unknown>,
    });
    return { idx: nextIdx, thisHash };
  });
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface VerifyInput {
  readonly fromIdx?: number;
  readonly toIdx?: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly checked: number; readonly lastIdx: number | null }
  | {
      readonly ok: false;
      readonly firstDivergence: number;
      readonly reason: 'hash_mismatch' | 'prev_hash_mismatch' | 'idx_gap' | 'genesis_prev_hash';
    };

export async function verify(db: DrizzlePg, input: VerifyInput = {}): Promise<VerifyResult> {
  const where = [];
  if (input.fromIdx !== undefined) where.push(gte(auditLog.idx, input.fromIdx));
  if (input.toIdx !== undefined) where.push(lte(auditLog.idx, input.toIdx));
  const query = db
    .select({
      idx: auditLog.idx,
      ts: auditLog.ts,
      actorId: auditLog.actorId,
      kind: auditLog.kind,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      ip: auditLog.ip,
      userAgent: auditLog.userAgent,
      prevHash: auditLog.prevHash,
      thisHash: auditLog.thisHash,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.idx));
  // (Drizzle 0.45 doesn't expose a clean WHERE-only chaining; do the
  // filter post-fetch since the chain is small per audit. Optimize when
  // the table grows past a few million rows.)
  const allRows = (await query) as Array<{
    idx: number;
    ts: Date;
    actorId: string | null;
    kind: string;
    resourceType: string | null;
    resourceId: string | null;
    ip: string | null;
    userAgent: string | null;
    prevHash: Uint8Array;
    thisHash: Uint8Array;
    payload: unknown;
  }>;
  const rows = allRows
    .filter(
      (r) =>
        (input.fromIdx === undefined || r.idx >= input.fromIdx) &&
        (input.toIdx === undefined || r.idx <= input.toIdx),
    )
    .sort((a, b) => a.idx - b.idx);

  let expectedIdx = input.fromIdx ?? 0;
  let expectedPrev: Uint8Array =
    input.fromIdx === undefined || input.fromIdx === 0
      ? GENESIS_PREV_HASH
      : Uint8Array.from(rows[0]?.prevHash ?? GENESIS_PREV_HASH); // accept caller-vouched prevHash for partial-range

  let checked = 0;
  for (const r of rows) {
    if (r.idx !== expectedIdx) {
      return { ok: false, firstDivergence: r.idx, reason: 'idx_gap' };
    }
    const rowPrev = Uint8Array.from(r.prevHash);
    if (!bytesEqual(rowPrev, expectedPrev)) {
      // Special-case the genesis row so the reason is precise.
      if (r.idx === 0) {
        return { ok: false, firstDivergence: 0, reason: 'genesis_prev_hash' };
      }
      return { ok: false, firstDivergence: r.idx, reason: 'prev_hash_mismatch' };
    }
    const recomputed = computeThisHash(
      rowPrev,
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
    const stored = Uint8Array.from(r.thisHash);
    if (!bytesEqual(recomputed, stored)) {
      return { ok: false, firstDivergence: r.idx, reason: 'hash_mismatch' };
    }
    expectedPrev = stored;
    expectedIdx = r.idx + 1;
    checked++;
  }
  return {
    ok: true,
    checked,
    lastIdx: rows.length > 0 ? (rows[rows.length - 1]?.idx ?? null) : null,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
