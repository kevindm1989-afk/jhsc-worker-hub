// Auth events emitter.
//
// Milestone 1.3: every emission lands in the tamper-evident audit
// chain (`audit_log` via @jhsc/audit). The legacy flat `auth_events`
// table is no longer written — the 1.3 migration's backfill anchor
// (idx=1) locks the pre-1.3 rows into the chain by hash, and
// `auth_events` is preserved read-only.
//
// privacy-reviewer F2 fix: call sites pass a `payload: AuditPayload`
// (typed discriminated union from @jhsc/shared-types). The typechecker
// rejects any field that isn't declared on the matching kind's
// variant — including any drifted PI key. The previous (kind +
// metadata) signature bypassed the typechecker at the spread.

import { append } from '@jhsc/audit';
import type { AuditPayload } from '@jhsc/shared-types';
import { getDb } from '../db/client';

export interface AuthEventInput {
  readonly actorId?: string | null;
  /**
   * Typed audit payload — kind discriminant + the fields declared on
   * its AuditPayload variant. The typechecker rejects unknown fields
   * here, including any future PI drift.
   */
  readonly payload: AuditPayload;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
}

export async function emitAuthEvent(input: AuthEventInput): Promise<void> {
  const db = getDb();
  await append(db, {
    actorId: input.actorId ?? null,
    payload: input.payload,
    kind: input.payload.kind,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
  });
}
