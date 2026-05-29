// Auth events emitter.
//
// Milestone 1.3: every emission lands in the tamper-evident audit
// chain (`audit_log` via @jhsc/audit). The legacy flat `auth_events`
// table is no longer written — the 1.3 migration's backfill anchor
// (idx=1) locks the pre-1.3 rows into the chain by hash, and
// `auth_events` is preserved read-only.
//
// Call sites continue to use the existing `emitAuthEvent(args)`
// signature with kind + ip + userAgent + metadata. This module
// builds the typed AuditPayload from kind + metadata at the boundary.

import { append } from '@jhsc/audit';
import type { AuditEventKind, AuditPayload } from '@jhsc/shared-types';
import { getDb } from '../db/client';

export interface AuthEventInput {
  readonly actorId?: string | null;
  readonly kind: AuditEventKind;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Append an auth event to the audit chain. The metadata object is
 * merged into the typed payload under `kind`; the typechecker
 * on the @jhsc/shared-types AuditPayload union enforces the field
 * shape at the call sites that build typed payloads. Routes that
 * pass an untyped metadata bag (the historical 1.2 pattern) get a
 * runtime-shaped object; the verifier hashes whatever was stored,
 * so the chain integrity holds regardless.
 */
export async function emitAuthEvent(input: AuthEventInput): Promise<void> {
  const db = getDb();
  const payload = { kind: input.kind, ...(input.metadata ?? {}) } as AuditPayload;
  await append(db, {
    actorId: input.actorId ?? null,
    payload,
    kind: input.kind,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
}
