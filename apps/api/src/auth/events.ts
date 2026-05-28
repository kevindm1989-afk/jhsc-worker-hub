// Typed emitter for the flat auth_events table.
//
// During the 1.2 → 1.3 gap this is the only audit surface. When 1.3
// lands, the chained logger appends a backfill anchor entry whose
// payload is the SHA-256 of the canonical-JSON serialization of all
// auth_events rows (ADR-0001).
//
// Strict contract:
// - `kind` is constrained to the AuthEventKind union (mirrors the pgEnum).
// - `metadata` may NOT contain PI (email, display name, password,
//   secret material). Routes pass typed shapes; type-narrowed event
//   constructors below enforce that.

import { getDb } from '../db/client';
import { authEvents } from '../db/schema';
import type { AuthEventKind } from './enums';

export interface AuthEventInput {
  readonly actorId?: string | null;
  readonly kind: AuthEventKind;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function emitAuthEvent(input: AuthEventInput): Promise<void> {
  const db = getDb();
  await db.insert(authEvents).values({
    actorId: input.actorId ?? null,
    kind: input.kind,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    metadata: input.metadata ?? {},
  });
}
