// Typed-client wrapper for offline sync (Milestone 1.10 S2, ADR-0009 §3.5).
//
// The per-domain `api.ts` files in apps/web/src/{hazards,action-items,
// inspections,recommendations,evidence} are the typed interfaces the
// view code calls. They run a raw `fetch` per call today (online-only).
// This file wraps those existing modules so:
//
//   1. Reads (GET) check Dexie first and return the snapshot immediately,
//      then fire a background fetch that reconciles into Dexie.
//   2. Mutations (POST / PATCH) write an optimistic row to Dexie + append
//      a sync_queue row + return the optimistic row to the caller. The
//      queue worker ships the actual request later.
//   3. Reveals (and other require-online endpoints) pass through to live
//      fetch + throw NetworkRequiredError when offline.
//
// Header contract preserved on every wire call:
//   - X-Requested-With: jhsc-web        (existing CSRF defence)
//   - credentials: same-origin           (existing cookie ride)
//   - Idempotency-Key: <uuid>            (NEW: 1.10 S2; per-request UUID
//                                         so the server middleware can
//                                         dedupe queue retries)
//   - If-Match: "<integer>"              (NEW: 1.10 S2; on PATCH, the
//                                         row's _server_version)
//
// The X-Requested-With header is preserved verbatim; the wrapper only
// adds Idempotency-Key (per-request) and If-Match (per-PATCH). The
// existing auth/api.ts step-up flow is untouched — reveal endpoints
// continue to surface the step-up modal via stepUpEmitter.

import {
  isClientId,
  type ClientId,
  type SyncEntityKind,
  type SyncOperationKind,
} from '@jhsc/shared-types';
import {
  db,
  baseStateKey,
  freshSyncMetadata,
  nowIso,
  type BaseEntityRow,
  type JhscOfflineDb,
} from './db';
import {
  enqueueOp,
  setQueueDispatcher,
  type DispatchResult,
  type QueueDispatcher,
  type SyncOperation,
} from './queue-worker';

// ---------------------------------------------------------------------------
// NetworkRequiredError — surfaced by reveal endpoints when offline
// ---------------------------------------------------------------------------

/**
 * Thrown by `requireOnline()`-wrapped calls when the service worker
 * returns a synthetic 503 `network_required` (or when navigator.onLine
 * is false). UI code catches this and renders the "Network required"
 * banner per ADR §3.6.
 */
export class NetworkRequiredError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(`network_required: ${action}`);
    this.name = 'NetworkRequiredError';
    this.action = action;
  }
}

// ---------------------------------------------------------------------------
// UUID v4 generator (no external dep — uses crypto.randomUUID in
// browsers / Node 19+; falls back to a getRandomValues-built v4 string)
// ---------------------------------------------------------------------------

/** Generate a fresh ClientId (UUID v4). Branded by passing through
 * `isClientId`. */
export function newClientId(): ClientId {
  const raw = uuidV4();
  if (!isClientId(raw)) {
    throw new Error(`newClientId: generator produced a non-v4 value: ${raw}`);
  }
  return raw;
}

function uuidV4(): string {
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: getRandomValues-built v4.
  const bytes = new Uint8Array(16);
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // No crypto.getRandomValues — refuse rather than ship a Math.random
    // UUID into an evidentially-sensitive primary key (T-S12 forbids
    // non-cryptographic randomness here).
    throw new Error('newClientId: crypto.getRandomValues is not available');
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Live fetch — the wire call the queue worker dispatcher (below) makes
// ---------------------------------------------------------------------------

/** Options for `liveFetch` — the wire-level fetch shape that adds the
 * 1.10 sync headers on top of the existing X-Requested-With + same-
 * origin cookie pattern. */
interface LiveFetchOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly json?: unknown;
  /** When set, sent as Idempotency-Key header. The queue worker passes
   * the queue row's idempotencyKey UUID here. */
  readonly idempotencyKey?: string;
  /** When set, sent as `If-Match: "<integer>"` header. The queue worker
   * passes the entity row's _server_version here. */
  readonly ifMatch?: number;
}

interface LiveFetchResult {
  readonly status: number;
  readonly body: unknown;
  readonly swQueued: boolean;
}

/** Perform the wire call. Returns the status + parsed JSON body so the
 * queue worker dispatcher can branch on it. */
export async function liveFetch(opts: LiveFetchOptions): Promise<LiveFetchResult> {
  const headers: Record<string, string> = { 'X-Requested-With': 'jhsc-web' };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }
  if (typeof opts.ifMatch === 'number') {
    // Strong etag = quoted integer per RFC 9110.
    headers['If-Match'] = `"${opts.ifMatch}"`;
  }
  const res = await fetch(opts.path, {
    method: opts.method,
    credentials: 'same-origin',
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  // The service worker returns 202 (sw_queued) with an empty body when
  // it queues the request offline.
  const swQueued = res.status === 202 && res.headers.get('X-Synthetic-Origin') === 'service-worker';
  let body: unknown = null;
  if (res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, swQueued };
}

// ---------------------------------------------------------------------------
// Queue dispatcher — the function the queue worker calls per row
// ---------------------------------------------------------------------------

/** Map a (SyncOperation) → liveFetch call + interpret the response into
 * a DispatchResult. Registered with the queue worker at module init via
 * `setQueueDispatcher`. */
async function dispatchOp(op: SyncOperation): Promise<DispatchResult> {
  // We can't recover the original idempotencyKey + ifMatch from the
  // SyncOperation shape alone — those live on the queue row. Pull the
  // row directly.
  const row = await db.sync_queue.get(op.id);
  if (!row) {
    return { kind: 'dead_letter', error: 'queue_row_disappeared' };
  }
  try {
    const result = await liveFetch({
      method: row.httpMethod as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: row.endpoint,
      json: op.payload,
      idempotencyKey: row.idempotencyKey,
      ifMatch: row.ifMatchEtag ?? undefined,
    });
    return interpretResponse(result, row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'transient_failure', error: msg };
  }
}

/** Translate a live HTTP response into a DispatchResult. */
function interpretResponse(
  result: LiveFetchResult,
  row: { entityKind: SyncEntityKind; entityLocalId: string },
): DispatchResult {
  const { status, body, swQueued } = result;
  if (swQueued) {
    return { kind: 'sw_queued' };
  }
  if (status >= 200 && status < 300) {
    const serverVersion = extractVersion(body);
    return { kind: 'success', serverState: body, serverVersion };
  }
  if (status === 409) {
    // The server's PATCH ratchet returns 409 with currentVersion +
    // serverState (see apps/api/src/routes/.../index.ts §F.2 of the
    // 1.10 S2 plan).
    const conflictBody = (body ?? {}) as {
      currentVersion?: number;
      serverState?: unknown;
    };
    return {
      kind: 'conflict',
      serverState: conflictBody.serverState ?? body,
      serverVersion: conflictBody.currentVersion ?? 0,
    };
  }
  if (status === 503) {
    // The SW returns 503 with `error: network_required` when it can't
    // reach the server and the route is on the require-online allow-
    // list. Treat as offline.
    const err = (body ?? {}) as { error?: string };
    if (err.error === 'network_required') {
      return { kind: 'network_required' };
    }
    return {
      kind: 'transient_failure',
      error: `503 ${row.entityKind}:${row.entityLocalId}`,
    };
  }
  if (status === 428) {
    // precondition_required — the client forgot the If-Match. This is a
    // bug in the wrapper, not a transient failure. Dead-letter it so the
    // rep sees the error.
    return { kind: 'dead_letter', error: '428 precondition_required' };
  }
  if (status >= 400 && status < 500) {
    // 4xx other than 409 / 428: schema reject. Dead-letter — retrying
    // produces the same rejection.
    const err = (body ?? {}) as { error?: string };
    return { kind: 'dead_letter', error: `${status} ${err.error ?? 'client_error'}` };
  }
  // 5xx + network error.
  return {
    kind: 'transient_failure',
    error: `${status} ${row.entityKind}:${row.entityLocalId}`,
  };
}

function extractVersion(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const b = body as { version?: unknown };
  if (typeof b.version === 'number') return b.version;
  return 0;
}

// Register the dispatcher with the queue worker (module-init side effect).
const _registeredDispatcher: QueueDispatcher = dispatchOp;
setQueueDispatcher(_registeredDispatcher);

// ---------------------------------------------------------------------------
// syncify: the typed-client wrapper
// ---------------------------------------------------------------------------

/**
 * Per-call routing config. The `syncify` wrapper consults this map to
 * decide whether a given method on the typed API is a read, a mutation,
 * or a require-online passthrough.
 *
 * The shape is `<api-method-name> -> RouteSpec`. We use the method name
 * as the key because the existing api.ts modules expose flat object
 * shapes (`hazardsApi.create`, `hazardsApi.patchStatus`, etc.).
 */
export interface RouteSpec {
  readonly kind: 'read' | 'mutation' | 'require_online';
  /** The HTTP method the underlying api.ts call would send. */
  readonly httpMethod: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** The entity kind for the sync queue (mutations only). */
  readonly entityKind?: SyncEntityKind;
  /** The SyncOperationKind for the queue row. */
  readonly opKind?: SyncOperationKind;
  /** The Dexie table name to optimistically write (mutations only). */
  readonly dexieTable?: string;
  /** Endpoint template — the caller's args.id is interpolated. */
  readonly endpointBuilder?: (args: ReadonlyArray<unknown>) => string;
  /** Optional: extract the entityLocalId from the call args (defaults
   * to args[0] for PATCH-style calls). */
  readonly entityLocalIdFromArgs?: (args: ReadonlyArray<unknown>) => string | undefined;
}

// (helper removed in favor of inline readSnapshot below; the original
// shape isn't currently called by any wrapped read path. Kept as a doc
// hook for future refactors that need an explicit "snapshot +
// background refresh" combinator.)

/**
 * Wrap a typed API object so that:
 *
 *   - For methods declared as 'read' in the routes map, the wrapped
 *     method reads from Dexie first; the original (live-fetch) call is
 *     fired in the background.
 *   - For methods declared as 'mutation', the wrapped method:
 *       (a) generates a clientId (if a create) or extracts the id (if a
 *           PATCH-style call);
 *       (b) writes an optimistic row to Dexie;
 *       (c) appends a sync_queue row via enqueueOp();
 *       (d) returns the optimistic shape to the caller (so the existing
 *           Promise<T> contract is preserved).
 *   - For methods declared as 'require_online', the wrapped method
 *     passes through to the original — but if the network throws and
 *     navigator.onLine is false, we wrap the error as
 *     NetworkRequiredError.
 *   - Methods NOT listed in the routes map pass through unchanged (the
 *     existing api.ts contract is unaffected).
 *
 * The wrapper returns a new object with the same shape as the input,
 * so view code can do `const api = syncify(hazardsApi, routes)` and
 * keep all existing call sites.
 *
 * Wrapper note for nested API objects (e.g. `inspectionsApi.exports`):
 * pass a `prefix` parameter — methods named `${prefix}.${method}` are
 * matched. The current S2 typed clients don't lean on this heavily; S3
 * may extend.
 */
export function syncify<T extends Record<string, unknown>>(
  api: T,
  routes: Readonly<Record<string, RouteSpec>>,
): T {
  const wrapped: Record<string, unknown> = { ...api };
  for (const [methodName, spec] of Object.entries(routes)) {
    const original = (api as Record<string, unknown>)[methodName];
    if (typeof original !== 'function') continue;
    wrapped[methodName] = wrapMethod(original as (...a: unknown[]) => unknown, spec, methodName);
  }
  return wrapped as T;
}

function wrapMethod(
  original: (...a: unknown[]) => unknown,
  spec: RouteSpec,
  methodName: string,
): (...a: unknown[]) => unknown {
  return async function syncified(...args: unknown[]): Promise<unknown> {
    if (spec.kind === 'require_online') {
      try {
        return await original(...args);
      } catch (err) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          throw new NetworkRequiredError(methodName);
        }
        // Server-side 503 network_required surfaces as an api-error
        // whose body.error === 'network_required'.
        const e = err as { status?: number; body?: { error?: string } };
        if (e && (e.status === 503 || e.body?.error === 'network_required')) {
          throw new NetworkRequiredError(methodName);
        }
        throw err;
      }
    }
    if (spec.kind === 'read') {
      // Dexie snapshot read — the caller's args may contain filter
      // params; we don't try to translate them into Dexie indexes
      // perfectly. The snapshot is "give me what we already have"; the
      // background refresh fetches the canonical filtered shape.
      const snapshot = await readSnapshot(spec, args);
      // Background-refresh: call the original; on success, reconcile
      // into Dexie. Failures swallowed.
      const livePromise = Promise.resolve(original(...args)) as Promise<unknown>;
      void livePromise
        .then((fresh: unknown) => reconcileRead(spec, fresh).catch(() => undefined))
        .catch(() => undefined);
      return snapshot ?? (await livePromise);
    }
    // mutation
    return await enqueueMutation(spec, args, original);
  };
}

async function readSnapshot(spec: RouteSpec, args: ReadonlyArray<unknown>): Promise<unknown> {
  if (!spec.dexieTable) return null;
  const table = db.table(spec.dexieTable);
  const id =
    spec.entityLocalIdFromArgs?.(args) ?? (typeof args[0] === 'string' ? args[0] : undefined);
  if (typeof id === 'string') {
    const row = await table.get(id);
    return row ?? null;
  }
  // List shape: return all rows. The caller's shape is `{items:
  // ReadonlyArray<T>}` so we wrap.
  const rows = await table.toArray();
  return { items: rows.filter((r) => (r as BaseEntityRow)._sync_state !== 'dirty_delete') };
}

async function reconcileRead(spec: RouteSpec, fresh: unknown): Promise<void> {
  if (!spec.dexieTable) return;
  if (fresh === null || typeof fresh !== 'object') return;
  const table = db.table(spec.dexieTable);
  const items = (fresh as { items?: ReadonlyArray<unknown> }).items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const r = item as { id?: string; version?: number };
      if (typeof r.id !== 'string') continue;
      const existing = await table.get(r.id);
      // Only overwrite clean rows; leave dirty / conflicting rows
      // alone (the pending op will eventually drain).
      if (!existing || (existing as BaseEntityRow)._sync_state === 'clean') {
        await table.put({
          ...item,
          ...cleanFromServer(r.id, r.version ?? 0, item),
        });
      }
    }
    return;
  }
  // Detail shape — single row.
  const r = fresh as { id?: string; version?: number };
  if (typeof r.id !== 'string') return;
  const existing = await table.get(r.id);
  if (!existing || (existing as BaseEntityRow)._sync_state === 'clean') {
    await table.put({
      ...fresh,
      ...cleanFromServer(r.id, r.version ?? 0, fresh),
    });
  }
}

function cleanFromServer(
  id: string,
  version: number,
  full: unknown,
): {
  _sync_state: 'clean';
  _local_id: string;
  _server_version: number;
  _base_state_json: string;
  _updated_at_client: string;
  _synced_at: string;
} {
  const t = nowIso();
  return {
    _sync_state: 'clean',
    _local_id: id,
    _server_version: version,
    _base_state_json: JSON.stringify(full ?? null),
    _updated_at_client: t,
    _synced_at: t,
  };
}

async function enqueueMutation(
  spec: RouteSpec,
  args: ReadonlyArray<unknown>,
  original: (...a: unknown[]) => unknown,
): Promise<unknown> {
  if (!spec.entityKind || !spec.opKind) {
    // No queue metadata — fall through to the live call.
    return await original(...args);
  }
  const httpMethod = spec.httpMethod;
  let entityLocalId: string;
  let bodyForQueue: unknown;
  let ifMatch: number | null = null;

  if (spec.opKind === 'create') {
    // The create body is args[0]; we inject clientId if not present.
    const body = (args[0] ?? {}) as Record<string, unknown>;
    const existingId = typeof body.clientId === 'string' ? body.clientId : null;
    const clientId = existingId ?? newClientId();
    bodyForQueue = { ...body, clientId };
    entityLocalId = clientId;
  } else {
    // PATCH / transition / etc. — args[0] is the id, args[1] is the
    // body.
    const id = spec.entityLocalIdFromArgs?.(args) ?? (typeof args[0] === 'string' ? args[0] : null);
    if (typeof id !== 'string') {
      // No id — fall through to live call.
      return await original(...args);
    }
    entityLocalId = id;
    bodyForQueue = args[1] ?? {};
    // Pull the current _server_version from Dexie for the If-Match.
    if (spec.dexieTable) {
      const existing = await db.table(spec.dexieTable).get(id);
      if (existing && typeof (existing as BaseEntityRow)._server_version === 'number') {
        ifMatch = (existing as BaseEntityRow)._server_version;
      }
    }
  }

  const endpoint = spec.endpointBuilder ? spec.endpointBuilder(args) : `/api/${spec.entityKind}s`;

  // Write the optimistic row.
  if (spec.dexieTable) {
    const table = db.table(spec.dexieTable);
    const existing = await table.get(entityLocalId);
    // sec-F10 close-out (T-S57): if a CLEAN row already exists at
    // this id, refuse to overwrite it. The original 1.10 S2 path
    // spread `bodyForQueue` over `existing` and reset _sync_state to
    // 'dirty_create' — which clobbered any field the rep had not
    // re-typed (e.g. a background-refresh that landed the canonical
    // row between the rep tapping "Add hazard" and the optimistic
    // write committing). The clobbered row would then enqueue a
    // second create with the same entityLocalId; the server's
    // clientId-reuse 200 path would return the EXISTING row,
    // silently discarding the rep's new payload fields.
    //
    // Fix shape: for opKind === 'create' on a clean existing row,
    // skip the optimistic write entirely (the row is already there
    // and clean — there's nothing to optimistically materialize)
    // and skip the queue enqueue too (no work to do; the rep can
    // PATCH the row via a normal update flow if they want to
    // change it). We still return the existing row to the caller so
    // the Promise<T> contract is preserved.
    if (
      spec.opKind === 'create' &&
      existing &&
      (existing as BaseEntityRow)._sync_state === 'clean'
    ) {
      console.warn(
        `[typed-client] create against existing clean row ${entityLocalId} — skipping optimistic write + queue enqueue (sec-F10 / T-S57). The caller likely re-fired a create handler against a row that already synced; use the PATCH path instead.`,
      );
      return existing;
    }
    const meta = freshSyncMetadata(entityLocalId);
    const optimistic = {
      ...(existing ?? {}),
      ...(bodyForQueue as object),
      id: entityLocalId,
      ...meta,
      _sync_state:
        spec.opKind === 'create' ? 'dirty_create' : existing ? 'dirty_update' : 'dirty_create',
    };
    await table.put(optimistic);
  }

  // Append the queue row.
  await enqueueOp({
    kind: spec.opKind,
    entityKind: spec.entityKind,
    entityLocalId,
    payload: bodyForQueue,
    httpMethod,
    endpoint,
    ifMatchEtag: ifMatch,
    idempotencyKey: newClientId(),
  });

  // Return the optimistic row so the caller's contract is preserved.
  if (spec.dexieTable) {
    const row = await db.table(spec.dexieTable).get(entityLocalId);
    return row ?? { id: entityLocalId };
  }
  return { id: entityLocalId };
}

// ---------------------------------------------------------------------------
// requireOnline helper — used by reveal endpoints
// ---------------------------------------------------------------------------

/**
 * Pass through to a live fetch; throw NetworkRequiredError if the
 * network or SW signals offline. Used by reveal / export / download
 * endpoints (ADR §3.6 "require-online" surface).
 */
export async function requireOnline<T>(action: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new NetworkRequiredError(action);
  }
  try {
    return await fn();
  } catch (err) {
    const e = err as { status?: number; body?: { error?: string } };
    if (e?.status === 503 || e?.body?.error === 'network_required') {
      throw new NetworkRequiredError(action);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** For tests: override the singleton Dexie database. */
export function _setDbForTests(_database: JhscOfflineDb): void {
  // Exported as a no-op marker; tests construct their own Dexie instance
  // and inject it via the queue worker's `database` constructor option.
  // Kept here so tests have a documented hook even if they choose to
  // use module-level mocking instead.
  void _database;
}

/** Exports for tests. */
export const _internal = {
  newClientId,
  uuidV4,
  dispatchOp,
  interpretResponse,
  extractVersion,
  baseStateKey,
};
