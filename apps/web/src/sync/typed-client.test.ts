// Unit tests for the typed-client wrapper (Milestone 1.10 S2).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isClientId } from '@jhsc/shared-types';
import { db, freshSyncMetadata } from './db';
import {
  NetworkRequiredError,
  newClientId,
  requireOnline,
  syncify,
  _internal,
  type RouteSpec,
} from './typed-client';

beforeEach(async () => {
  // Clear all tables between tests so each test starts from a clean
  // singleton Dexie state.
  for (const t of db.tables) {
    await t.clear();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('newClientId', () => {
  it('produces a valid ClientId (RFC 4122 v4)', () => {
    const id = newClientId();
    expect(isClientId(id)).toBe(true);
  });

  it('produces a different id each call', () => {
    const a = newClientId();
    const b = newClientId();
    expect(a).not.toBe(b);
  });
});

describe('interpretResponse', () => {
  it('200 → success with extracted version', () => {
    const r = _internal.interpretResponse(
      { status: 200, body: { id: 'x', version: 3 }, swQueued: false },
      { entityKind: 'hazard', entityLocalId: 'x' },
    );
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      expect(r.serverVersion).toBe(3);
    }
  });

  it('202 + X-Synthetic-Origin → sw_queued', () => {
    const r = _internal.interpretResponse(
      { status: 202, body: null, swQueued: true },
      { entityKind: 'hazard', entityLocalId: 'x' },
    );
    expect(r.kind).toBe('sw_queued');
  });

  it('409 → conflict with currentVersion + serverState', () => {
    const r = _internal.interpretResponse(
      {
        status: 409,
        body: {
          error: 'version_conflict',
          currentVersion: 7,
          serverState: { id: 'x', version: 7, status: 'assigned' },
        },
        swQueued: false,
      },
      { entityKind: 'hazard', entityLocalId: 'x' },
    );
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') {
      expect(r.serverVersion).toBe(7);
    }
  });

  it('503 network_required → network_required', () => {
    const r = _internal.interpretResponse(
      { status: 503, body: { error: 'network_required' }, swQueued: false },
      { entityKind: 'hazard', entityLocalId: 'x' },
    );
    expect(r.kind).toBe('network_required');
  });

  it('428 → dead_letter (precondition_required)', () => {
    const r = _internal.interpretResponse(
      { status: 428, body: { error: 'precondition_required' }, swQueued: false },
      { entityKind: 'hazard', entityLocalId: 'x' },
    );
    expect(r.kind).toBe('dead_letter');
  });

  it('422 invalid_body → dead_letter', () => {
    const r = _internal.interpretResponse(
      { status: 422, body: { error: 'invalid_body' }, swQueued: false },
      { entityKind: 'hazard', entityLocalId: 'x' },
    );
    expect(r.kind).toBe('dead_letter');
  });

  it('500 → transient_failure', () => {
    const r = _internal.interpretResponse(
      { status: 500, body: null, swQueued: false },
      { entityKind: 'hazard', entityLocalId: 'x' },
    );
    expect(r.kind).toBe('transient_failure');
  });
});

describe('syncify — read', () => {
  it('returns Dexie snapshot when row exists; fires background refresh', async () => {
    const LOCAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await db.hazards.put({
      id: LOCAL_ID,
      hazardCode: 'H-001',
      title: 'Snap',
      severity: 'high',
      status: 'open',
      jurisdiction: 'ON',
      locationZone: null,
      reportedAt: '2026-06-02T10:00:00.000Z',
      description_ct_b64: null,
      description_dek_ct_b64: null,
      ...freshSyncMetadata(LOCAL_ID),
    });

    const original = vi.fn(async (id: string) => {
      return { id, version: 5, title: 'Server', severity: 'high', status: 'open' };
    });

    const routes: Record<string, RouteSpec> = {
      get: { kind: 'read', httpMethod: 'GET', dexieTable: 'hazards' },
    };
    const wrapped = syncify({ get: original }, routes);
    const result = (await wrapped.get(LOCAL_ID)) as { id: string };
    expect(result.id).toBe(LOCAL_ID);
    // The original is called for the background refresh.
    // Wait a tick for the floating promise to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(original).toHaveBeenCalled();
  });

  it('falls through to live fetch when Dexie has no row', async () => {
    const LOCAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const original = vi.fn(async (id: string) => ({
      id,
      version: 1,
      title: 'Fresh',
      severity: 'low',
      status: 'open',
    }));
    const routes: Record<string, RouteSpec> = {
      get: { kind: 'read', httpMethod: 'GET', dexieTable: 'hazards' },
    };
    const wrapped = syncify({ get: original }, routes);
    const result = (await wrapped.get(LOCAL_ID)) as { title: string };
    expect(result.title).toBe('Fresh');
    expect(original).toHaveBeenCalled();
  });
});

describe('syncify — mutation create', () => {
  it('generates a clientId + writes optimistic row + appends queue row', async () => {
    const original = vi.fn(async (..._args: unknown[]) => ({
      id: 'never-called-because-we-queue',
    }));
    const routes: Record<string, RouteSpec> = {
      create: {
        kind: 'mutation',
        httpMethod: 'POST',
        opKind: 'create',
        entityKind: 'hazard',
        dexieTable: 'hazards',
        endpointBuilder: () => '/api/hazards',
      },
    };
    const wrapped = syncify({ create: original }, routes) as {
      create: (...args: unknown[]) => Promise<unknown>;
    };
    const result = (await wrapped.create({
      title: 'Test',
      description: 'desc',
      severity: 'high',
      jurisdiction: 'ON',
    })) as { id: string; _sync_state: string };
    expect(typeof result.id).toBe('string');
    expect(isClientId(result.id)).toBe(true);
    expect(result._sync_state).toBe('dirty_create');

    // The queue should have one row.
    const queue = await db.sync_queue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.kind).toBe('create');
    expect(queue[0]!.entityLocalId).toBe(result.id);

    // The original (live fetch) was NOT called — the queue worker does
    // that later.
    expect(original).not.toHaveBeenCalled();
  });
});

describe('syncify — mutation PATCH', () => {
  it('captures _server_version into ifMatchEtag', async () => {
    const LOCAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await db.hazards.put({
      id: LOCAL_ID,
      hazardCode: 'H-001',
      title: 'Patchable',
      severity: 'high',
      status: 'open',
      jurisdiction: 'ON',
      locationZone: null,
      reportedAt: '2026-06-02T10:00:00.000Z',
      description_ct_b64: null,
      description_dek_ct_b64: null,
      _sync_state: 'clean',
      _local_id: LOCAL_ID,
      _server_version: 3,
      _base_state_json: '{}',
      _updated_at_client: '2026-06-02T10:00:00.000Z',
      _synced_at: '2026-06-02T10:00:00.000Z',
    });

    const original = vi.fn(async (..._args: unknown[]) => ({ id: LOCAL_ID }));
    const routes: Record<string, RouteSpec> = {
      patchStatus: {
        kind: 'mutation',
        httpMethod: 'PATCH',
        opKind: 'update',
        entityKind: 'hazard',
        dexieTable: 'hazards',
        endpointBuilder: (args) => `/api/hazards/${String(args[0])}/status`,
      },
    };
    const wrapped = syncify({ patchStatus: original }, routes) as {
      patchStatus: (...args: unknown[]) => Promise<unknown>;
    };
    await wrapped.patchStatus(LOCAL_ID, { toStatus: 'assessing' });

    const queue = await db.sync_queue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.ifMatchEtag).toBe(3);
    expect(queue[0]!.endpoint).toBe(`/api/hazards/${LOCAL_ID}/status`);
  });
});

describe('requireOnline', () => {
  it('throws NetworkRequiredError when navigator.onLine is false', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    await expect(requireOnline('test.action', async () => 'ok')).rejects.toBeInstanceOf(
      NetworkRequiredError,
    );
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  });

  it('throws NetworkRequiredError on a 503 network_required server response', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    const fn = async (): Promise<never> => {
      const err = new Error('503') as Error & { status: number; body: { error: string } };
      err.status = 503;
      err.body = { error: 'network_required' };
      throw err;
    };
    await expect(requireOnline('reveal.attempt', fn)).rejects.toBeInstanceOf(NetworkRequiredError);
  });

  it('returns the value on a successful online call', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    const r = await requireOnline('ok.action', async () => 42);
    expect(r).toBe(42);
  });
});
