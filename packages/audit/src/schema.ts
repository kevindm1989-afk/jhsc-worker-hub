// Drizzle schema for the audit chain. Lives in the package so the
// table definition follows the same dependency direction as the rest
// of the code — apps/api imports from @jhsc/audit, never the other way.

import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  inet,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const auditLog = pgTable(
  'audit_log',
  {
    idx: bigint('idx', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    actorId: uuid('actor_id'),
    kind: text('kind').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    // Optional network context. Auth events populate them. Other modules
    // (hazards, exports, etc.) leave them null. computeThisHash binds
    // both into the hash so tampering with the network context flips the
    // chain.
    ip: inet('ip'),
    userAgent: text('user_agent'),
    prevHash: bytea('prev_hash').notNull(),
    thisHash: bytea('this_hash').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => ({
    thisHashUnique: uniqueIndex('audit_log_this_hash_unique').on(t.thisHash),
    tsIdx: index('audit_log_ts_idx').on(t.ts),
    kindTsIdx: index('audit_log_kind_ts_idx').on(t.kind, t.ts),
    actorTsIdx: index('audit_log_actor_ts_idx').on(t.actorId, t.ts),
  }),
);
