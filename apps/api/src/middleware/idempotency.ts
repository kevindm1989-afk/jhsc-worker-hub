// Idempotency-Key middleware (Milestone 1.10, ADR-0009 §3.4).
//
// Caches the (actor, action_kind, entity_local_id, payload_hash) tuple's
// response so a queue retry that drained but lost the response leg
// returns the cached body without re-running the handler — preserving
// the once-per-logical-operation chain-anchor invariant (CLAUDE.md #2 +
// SECURITY.md §2.10 T-S4).
//
// ## Middleware order
//
// The ADR's §3.4 framing puts this BEFORE auth + body + rate-limit. In
// practice the four-way UNIQUE on `sync_idempotency` needs the actor's
// `user_id`, so we cannot short-circuit BEFORE auth without a second
// identity lookup path (split-JWT verification, cookie-only-decode,
// etc.) that's too complex for the budget gain. The pragmatic order is:
//
//   csrfHeaderGuard()       — global, runs first
//   authMiddleware()        — populates c.get('auth')
//   idempotencyKey()        — NEW: this file. AFTER auth so we have
//                             auth.userId for the cache key.
//   rateLimit()             — AFTER idempotency: a cache hit short-
//                             circuits without burning a token.
//   bodyLimit()             — AFTER rate-limit: spammed oversize POSTs
//                             still drain the bucket (1.6 close-out
//                             pattern). Cache hits also skip this.
//   route handler
//
// This is a refinement of ADR-0009 §3.4's "BEFORE auth" framing —
// documented inline here and in SECURITY.md §2.10 T-S5 (the malicious
// unauthenticated probe is bounded by csrfHeaderGuard + authMiddleware
// running first; an authenticated retry still skips rate-limit + body-
// limit on cache hit, which is the budget gain that matters in practice).
//
// ## Caching contract
//
//   - GET / HEAD / OPTIONS: no-op pass-through.
//   - Idempotency-Key header absent: no-op pass-through (idempotency is
//     opt-in per request — the existing CSRF-header pattern).
//   - Cache HIT (matching row with expires_at > now()): return the
//     cached status + decrypted body + `X-Idempotent-Replay: true`
//     header. Handler is NOT run.
//   - Cache MISS: handler runs. If 2xx OR 409, encrypt + INSERT.
//     5xx is NOT cached (retry-safe semantics — the rep may retry with
//     a corrected payload). 409 IS cached because the conflict is
//     deterministic (the version mismatch will recur).
//
// ## Wire shape
//
//   Request:  Idempotency-Key: <opaque-string>  (typically the queue's
//             payload_hash hex). The middleware also computes its own
//             sha256(canonical-JSON(body)) and stores that as the
//             `payload_hash` UNIQUE column so a replay with a different
//             body but the same key (extremely unlikely; defense
//             against a buggy key derivation) is a cache MISS, not a
//             stale cache hit.
//   Response on replay: X-Idempotent-Replay: true
//
// ## Body re-read
//
// Hono caches the parsed body internally (verified against
// node_modules/.pnpm/hono@4.12.18/.../request.js `#cachedBody`), so the
// route handler's `await c.req.json()` after this middleware returns
// the same cached body — no second stream read, no re-parse needed.

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { canonicalJsonStringify } from '@jhsc/audit';
import { sealWithEnvelope, openWithEnvelope } from '@jhsc/crypto';
import { getDb } from '../db/client';
import { getMasterKey } from '../auth/crypto-stub';

/** Header the client sets to opt the request into idempotency caching. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Response header set on a cache-hit replay. */
export const IDEMPOTENT_REPLAY_HEADER = 'X-Idempotent-Replay';

/** 7-day TTL per ADR-0009 §3.4. Documented residual: the table grows
 * monotonically through 1.10; the TTL sweep is a 1.12 pg-boss job. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** HTTP methods that bypass the middleware. Reads are not cached
 * (the read path's correctness is bounded by the entity tables, not
 * by an idempotency ledger). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface CachedResponseBody {
  /** The JSON body the route returned. Stored as the parsed value so
   * the replay path can serialize identically; PostgreSQL's jsonb is
   * avoided here because the body is envelope-encrypted. */
  readonly body: unknown;
}

export function idempotencyKey(): MiddlewareHandler {
  return async (c, next) => {
    // Pass-through on safe methods.
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return undefined;
    }

    const keyHeader = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (!keyHeader) {
      // Opt-in: no header, no idempotency. The web client (S2) will set
      // this on every mutation flowing through the queue worker.
      await next();
      return undefined;
    }

    // Cap the header length defensively. The queue's payload_hash is
    // 64 hex chars; anything beyond 256 is junk.
    if (keyHeader.length === 0 || keyHeader.length > 256) {
      return c.json({ error: 'invalid_idempotency_key' }, 400);
    }

    const auth = c.get('auth');
    if (!auth) {
      // authMiddleware should have populated this; if it hasn't,
      // someone wired the middleware order wrong. Fail closed.
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Read the body ONCE — Hono caches subsequent `c.req.json()` calls
    // so the downstream handler still gets the parsed value without a
    // second stream read.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // The route handler's own Zod parse will surface a clean 400 if
      // the body is malformed JSON. We just pass through here so the
      // handler owns the error shape.
      await next();
      return undefined;
    }

    // payload_hash = sha256(canonical-JSON(body)). Pure function; the
    // queue worker computes the same hash client-side and ships it as
    // the Idempotency-Key. The cross-check in the UNIQUE column
    // defends against a future bug in the queue's key derivation
    // (SECURITY.md T-S16) — a key collision with a different body
    // produces a cache MISS, not a stale hit.
    const canonical = canonicalJsonStringify(body);
    const payloadHash = createHash('sha256').update(canonical, 'utf8').digest();

    // entity_local_id comes from the body's `clientId` field if
    // present. Routes that take the ratchet validate it as a UUID
    // before reaching their handler; here we just lift the value if
    // it's a string. Anything else (missing, non-string, malformed) is
    // stored as NULL — the partial UNIQUE indexes handle both cases.
    const entityLocalId =
      typeof body === 'object' && body !== null && 'clientId' in body
        ? typeof (body as { clientId: unknown }).clientId === 'string'
          ? ((body as { clientId: string }).clientId as string)
          : null
        : null;

    // action_kind is `${method} ${routePath}` — the registered route
    // template, so a path-param value doesn't churn the key (POST
    // /api/recommendations/abc/responses and POST /api/recommendations/
    // def/responses share action_kind 'POST /api/recommendations/
    // :id/responses', and the per-id scope comes from entity_local_id
    // / payload_hash).
    const actionKind = `${c.req.method} ${c.req.routePath}`;

    const db = getDb();

    // Cache lookup. Two partial UNIQUE indexes mean we need two
    // separate WHERE shapes — one for the NOT NULL entity case (the
    // common path for the routes we ratchet in S1) and one for the
    // NULL case. UNION ALL would also work but two distinct queries
    // are clearer and only one path actually executes (the
    // entityLocalId branch is determined upstream).
    const hitRows = entityLocalId
      ? ((await db.execute(sql`
          SELECT response_status_code, response_body_ct, response_body_dek_ct, expires_at
          FROM sync_idempotency
          WHERE actor_user_id = ${auth.userId}
            AND action_kind = ${actionKind}
            AND entity_local_id = ${entityLocalId}
            AND payload_hash = ${payloadHash as unknown as Uint8Array}
          LIMIT 1
        `)) as unknown as Array<{
          response_status_code: number;
          response_body_ct: Uint8Array;
          response_body_dek_ct: Uint8Array;
          expires_at: Date | string;
        }>)
      : ((await db.execute(sql`
          SELECT response_status_code, response_body_ct, response_body_dek_ct, expires_at
          FROM sync_idempotency
          WHERE actor_user_id = ${auth.userId}
            AND action_kind = ${actionKind}
            AND entity_local_id IS NULL
            AND payload_hash = ${payloadHash as unknown as Uint8Array}
          LIMIT 1
        `)) as unknown as Array<{
          response_status_code: number;
          response_body_ct: Uint8Array;
          response_body_dek_ct: Uint8Array;
          expires_at: Date | string;
        }>);

    const hit = hitRows[0];
    if (hit) {
      const expiresAt = hit.expires_at instanceof Date ? hit.expires_at : new Date(hit.expires_at);
      if (expiresAt.getTime() > Date.now()) {
        // Cache hit — decrypt the cached body + return verbatim.
        const opened = openWithEnvelope(
          {
            ciphertext: Uint8Array.from(hit.response_body_ct),
            dekSealed: Uint8Array.from(hit.response_body_dek_ct),
          },
          getMasterKey(),
        );
        const text = new TextDecoder().decode(opened);
        const cached = JSON.parse(text) as CachedResponseBody;
        c.header(IDEMPOTENT_REPLAY_HEADER, 'true');
        // Status code comes from the cached row; the body is the
        // route's JSON payload. We construct the response directly so
        // the cached status is honored verbatim (200, 201, 409, etc.).
        return new Response(JSON.stringify(cached.body), {
          status: hit.response_status_code,
          headers: {
            'content-type': 'application/json',
            [IDEMPOTENT_REPLAY_HEADER]: 'true',
          },
        });
      }
      // Expired — fall through to run the handler. The expired row
      // will be overwritten on INSERT below (the four-way UNIQUE
      // covers the same key, so INSERT … ON CONFLICT DO UPDATE is the
      // semantic; we use DO UPDATE to refresh the cache atomically).
    }

    // Cache miss — run the handler.
    await next();

    // Inspect the response. We need the status + the body to cache.
    // The handler may have replaced c.res with a fresh Response (the
    // shape `return c.json(...)` does this). We read both.
    const response = c.res;
    const status = response.status;

    // Skip caching on 5xx (retry-safe — the rep may try again with a
    // corrected payload or after a server fix). The route's 5xx is
    // ALWAYS structural, not request-shape; caching it would lock the
    // rep into a transient server-side failure.
    if (status >= 500) {
      return undefined;
    }

    // Skip caching anything outside the (2xx, 3xx, 4xx) range that
    // we'd want to replay. 1xx is not used by Hono handlers. We
    // explicitly cache 2xx (the happy path) and 409 (the deterministic
    // conflict — S2's If-Match etag mismatch). Other 4xx codes (400
    // invalid_body, 401 step-up, 403 csrf, 422 illegal_transition) are
    // NOT cached — the rep may correct the request and retry.
    const shouldCache = (status >= 200 && status < 300) || status === 409;
    if (!shouldCache) {
      return undefined;
    }

    // Read the response body. Cloning preserves the original response
    // for the client; the .text() drains the clone.
    let bodyText: string;
    try {
      bodyText = await response.clone().text();
    } catch {
      // Non-text response — nothing to cache.
      return undefined;
    }
    let parsedBody: unknown;
    try {
      parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : null;
    } catch {
      // Non-JSON response — nothing to cache.
      return undefined;
    }

    const cachedShape: CachedResponseBody = { body: parsedBody };
    const cachedBytes = new TextEncoder().encode(JSON.stringify(cachedShape));
    const sealed = sealWithEnvelope(cachedBytes, getMasterKey());

    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

    // INSERT … ON CONFLICT DO UPDATE so an expired row refreshes
    // atomically. The conflict target depends on whether
    // entity_local_id is NULL — the two partial UNIQUE indexes from
    // migration 0009 mean the constraint name differs. We use the
    // explicit constraint name in each branch.
    try {
      if (entityLocalId) {
        await db.execute(sql`
          INSERT INTO sync_idempotency (
            actor_user_id, action_kind, entity_local_id, payload_hash,
            response_status_code, response_body_ct, response_body_dek_ct,
            expires_at
          )
          VALUES (
            ${auth.userId},
            ${actionKind},
            ${entityLocalId},
            ${payloadHash as unknown as Uint8Array},
            ${status},
            ${Buffer.from(sealed.ciphertext) as unknown as Uint8Array},
            ${Buffer.from(sealed.dekSealed) as unknown as Uint8Array},
            ${expiresAt}::timestamptz
          )
          ON CONFLICT ON CONSTRAINT sync_idempotency_key_with_entity_unique DO UPDATE SET
            response_status_code = EXCLUDED.response_status_code,
            response_body_ct = EXCLUDED.response_body_ct,
            response_body_dek_ct = EXCLUDED.response_body_dek_ct,
            expires_at = EXCLUDED.expires_at,
            created_at = now()
        `);
      } else {
        await db.execute(sql`
          INSERT INTO sync_idempotency (
            actor_user_id, action_kind, entity_local_id, payload_hash,
            response_status_code, response_body_ct, response_body_dek_ct,
            expires_at
          )
          VALUES (
            ${auth.userId},
            ${actionKind},
            NULL,
            ${payloadHash as unknown as Uint8Array},
            ${status},
            ${Buffer.from(sealed.ciphertext) as unknown as Uint8Array},
            ${Buffer.from(sealed.dekSealed) as unknown as Uint8Array},
            ${expiresAt}::timestamptz
          )
          ON CONFLICT ON CONSTRAINT sync_idempotency_key_without_entity_unique DO UPDATE SET
            response_status_code = EXCLUDED.response_status_code,
            response_body_ct = EXCLUDED.response_body_ct,
            response_body_dek_ct = EXCLUDED.response_body_dek_ct,
            expires_at = EXCLUDED.expires_at,
            created_at = now()
        `);
      }
    } catch (err) {
      // sec-F2 / sec-F8 close-out (S5 fix bundle, T-S52): log the
      // cache-INSERT failure at warn level instead of silently
      // swallowing it. The request already succeeded (the response was
      // shipped to the client before we entered this block, see
      // `return undefined;` shape above), so a cache-INSERT failure
      // here cannot fail the request — the rep got their bytes. What
      // CAN happen is a retry of the SAME Idempotency-Key landing the
      // handler a second time (the cache row that would have dedupe'd
      // the retry never landed). For the chain-anchor double-emit
      // concern (sec-F2): every chain-anchored route runs its append()
      // inside the same db.transaction() that INSERTs into the
      // entity's content-addressed row (evidence_files.storage_key +
      // plaintext_sha256, action_item_moves(action_item_id + audit_idx
      // UNIQUE), recommendation.recommendation_number sequence,
      // inspection_signatures(inspection_id, role) UNIQUE,
      // inspection_findings(inspection_id, item_key) UNIQUE) — the
      // second invocation cannot land a duplicate chain row because
      // its INSERT path catches the UNIQUE collision FIRST and the
      // route handler maps it to its existing clientId-reuse 200
      // (same shape as the cache hit would have produced). The
      // chain-anchor invariant therefore survives a cache-INSERT
      // failure; the warn log is the operational signal that the
      // dedupe window degraded.
      console.warn(
        '[idempotency] cache INSERT failed; retries of this key will re-run the handler (chain anchor is still bounded by the entity-table UNIQUE):',
        err,
      );
    }
    return undefined;
  };
}
