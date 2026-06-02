// Unit tests for the Dexie schema (Milestone 1.10 S2).
//
// Uses `fake-indexeddb` to stand in for the real IndexedDB so the tests
// run in Node without a browser. The schema-version round-trip + the
// per-table index presence are the contract we care about; the
// per-domain projection shape is tested by the typed-client tests.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEXIE_DB_NAME,
  DEXIE_SCHEMA_VERSION,
  JhscOfflineDb,
  baseStateKey,
  cleanSyncMetadata,
  clearOnLogout,
  db,
  freshSyncMetadata,
} from './db';

const TEST_DB_NAME = 'jhsc-test-' + Math.random().toString(36).slice(2);

let testDb: JhscOfflineDb;

beforeEach(() => {
  testDb = new JhscOfflineDb(TEST_DB_NAME);
});

afterEach(async () => {
  await testDb.delete();
});

describe('JhscOfflineDb schema', () => {
  it('exports a stable schema version', () => {
    expect(DEXIE_SCHEMA_VERSION).toBe(1);
  });

  it('exports the canonical singleton db name', () => {
    expect(DEXIE_DB_NAME).toBe('jhsc-offline-sync');
  });

  it('opens cleanly at version 1', async () => {
    await testDb.open();
    expect(testDb.verno).toBe(1);
  });

  it('has every expected mutable-entity table', async () => {
    await testDb.open();
    const names = testDb.tables.map((t) => t.name).sort();
    // priv-F1 close-out: workplace_keys_cache +
    // workplace_signing_keys_cache removed in S5 fix bundle
    // (declared but never populated; deferred to 1.12 hardening).
    const expected = [
      '_base_state',
      'action_item_moves',
      'action_items',
      'evidence_files',
      'evidence_pending_uploads',
      'hazards',
      'inspection_findings',
      'inspection_signatures',
      'inspection_templates',
      'inspections',
      'legal_clauses',
      'recommendation_action_item_links',
      'recommendation_citations',
      'recommendation_responses',
      'recommendations',
      'sync_conflicts',
      'sync_queue',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    // Assert the removed tables are NOT present.
    expect(names).not.toContain('workplace_keys_cache');
    expect(names).not.toContain('workplace_signing_keys_cache');
  });

  it('indexes _sync_state on every mutable-entity table', async () => {
    await testDb.open();
    const mutableEntityTables = [
      'hazards',
      'action_items',
      'action_item_moves',
      'inspections',
      'inspection_findings',
      'inspection_signatures',
      'recommendations',
      'recommendation_citations',
      'recommendation_responses',
      'recommendation_action_item_links',
      'evidence_files',
    ];
    for (const tableName of mutableEntityTables) {
      const table = testDb.table(tableName);
      const indexNames = table.schema.indexes.map((i) => i.name);
      expect(indexNames).toContain('_sync_state');
    }
  });

  it('indexes nextAttemptAt on sync_queue (the hot-path index)', async () => {
    await testDb.open();
    const table = testDb.table('sync_queue');
    const indexNames = table.schema.indexes.map((i) => i.name);
    expect(indexNames).toContain('nextAttemptAt');
    expect(indexNames).toContain('state');
    expect(indexNames).toContain('dependsOnQueueId');
  });

  it('does NOT index _sync_state on the read-only caches', async () => {
    await testDb.open();
    // The read-only caches mirror the server's canonical id and refresh
    // on each sync drain; they don't carry the _sync_ metadata.
    // workplace_keys_cache / workplace_signing_keys_cache removed in
    // S5 fix bundle per priv-F1 close-out.
    const readOnlyTables = ['inspection_templates', 'legal_clauses'];
    for (const tableName of readOnlyTables) {
      const table = testDb.table(tableName);
      const indexNames = table.schema.indexes.map((i) => i.name);
      expect(indexNames).not.toContain('_sync_state');
    }
  });

  it('round-trips a hazard row with _sync_ metadata', async () => {
    await testDb.open();
    const localId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await testDb.hazards.put({
      id: localId,
      hazardCode: null,
      title: 'Test hazard',
      severity: 'high',
      status: 'open',
      jurisdiction: 'ON',
      locationZone: 'zone_1',
      reportedAt: '2026-06-02T10:00:00.000Z',
      description_ct_b64: null,
      description_dek_ct_b64: null,
      ...freshSyncMetadata(localId),
    });
    const row = await testDb.hazards.get(localId);
    expect(row).toBeDefined();
    expect(row!._sync_state).toBe('dirty_create');
    expect(row!._local_id).toBe(localId);
    expect(row!._server_version).toBe(0);
    expect(row!._synced_at).toBeNull();
  });

  it('can filter hazards by _sync_state', async () => {
    await testDb.open();
    await testDb.hazards.bulkPut([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        hazardCode: 'H-001',
        title: 'Clean',
        severity: 'low',
        status: 'open',
        jurisdiction: 'ON',
        locationZone: null,
        reportedAt: '2026-06-02T10:00:00.000Z',
        description_ct_b64: null,
        description_dek_ct_b64: null,
        ...cleanSyncMetadata('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, '{}'),
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        hazardCode: null,
        title: 'Dirty',
        severity: 'high',
        status: 'open',
        jurisdiction: 'ON',
        locationZone: null,
        reportedAt: '2026-06-02T10:00:00.000Z',
        description_ct_b64: null,
        description_dek_ct_b64: null,
        ...freshSyncMetadata('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      },
    ]);
    const dirty = await testDb.hazards.where('_sync_state').equals('dirty_create').toArray();
    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.title).toBe('Dirty');
  });

  it('sync_queue auto-increments id', async () => {
    await testDb.open();
    const id1 = await testDb.sync_queue.add({
      kind: 'create',
      entityKind: 'hazard',
      entityLocalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      payload: '{}',
      httpMethod: 'POST',
      endpoint: '/api/hazards',
      ifMatchEtag: null,
      idempotencyKey: 'idem-1',
      attemptCount: 0,
      nextAttemptAt: '2026-06-02T10:00:00.000Z',
      state: 'queued',
      lastError: null,
      createdAt: '2026-06-02T10:00:00.000Z',
      dependsOnQueueId: null,
      pauseReason: null,
    });
    const id2 = await testDb.sync_queue.add({
      kind: 'update',
      entityKind: 'hazard',
      entityLocalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      payload: '{}',
      httpMethod: 'PATCH',
      endpoint: '/api/hazards/x/status',
      ifMatchEtag: 1,
      idempotencyKey: 'idem-2',
      attemptCount: 0,
      nextAttemptAt: '2026-06-02T10:00:00.000Z',
      state: 'queued',
      lastError: null,
      createdAt: '2026-06-02T10:01:00.000Z',
      dependsOnQueueId: null,
      pauseReason: null,
    });
    expect(typeof id1).toBe('number');
    expect(typeof id2).toBe('number');
    expect((id2 as number) - (id1 as number)).toBe(1);
  });

  it('_base_state composite key helper is stable', () => {
    expect(baseStateKey('hazard', 'aaaa-bbbb')).toBe('hazard:aaaa-bbbb');
    expect(baseStateKey('recommendation', 'xyz')).toBe('recommendation:xyz');
  });
});

describe('clearOnLogout (sec-F9 close-out, T-S56)', () => {
  beforeEach(async () => {
    await db.open();
    await db.sync_queue.clear();
    await db.sync_conflicts.clear();
    await db._base_state.clear();
    await db.legal_clauses.clear();
    await db.inspection_templates.clear();
    await db.hazards.clear();
  });

  afterEach(async () => {
    await db.sync_queue.clear();
    await db.sync_conflicts.clear();
    await db._base_state.clear();
    await db.legal_clauses.clear();
    await db.inspection_templates.clear();
    await db.hazards.clear();
  });

  it('drops sync_queue, sync_conflicts, _base_state, legal_clauses, inspection_templates', async () => {
    // Seed each table.
    await db.sync_queue.add({
      kind: 'create',
      entityKind: 'hazard',
      entityLocalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      payload: '{}',
      httpMethod: 'POST',
      endpoint: '/api/hazards',
      ifMatchEtag: null,
      idempotencyKey: 'idem-1',
      attemptCount: 0,
      nextAttemptAt: '2026-06-02T10:00:00.000Z',
      state: 'queued',
      lastError: null,
      createdAt: '2026-06-02T10:00:00.000Z',
      dependsOnQueueId: null,
      pauseReason: null,
    });
    await db.sync_conflicts.add({
      entityKind: 'hazard',
      entityLocalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localStateJson: '{}',
      serverStateJson: '{}',
      baseStateJson: '{}',
      serverVersion: 1,
      detectedAt: '2026-06-02T10:00:00.000Z',
      resolved: 0,
    });
    await db._base_state.put({
      key: 'hazard:aaaa-bbbb',
      entityKind: 'hazard',
      entityLocalId: 'aaaa-bbbb',
      version: 1,
      stateJson: '{}',
      cachedAt: '2026-06-02T10:00:00.000Z',
    });
    await db.legal_clauses.put({
      id: 'lc-1',
      statuteCode: 'OHSA',
      clauseId: 's.9(20)',
      versionDate: '2024-01-01',
      citation: 'OHSA s.9(20)',
      summary: 'Notice of Recommendation',
      jurisdiction: 'ON',
      cachedAt: '2026-06-02T10:00:00.000Z',
    });
    await db.inspection_templates.put({
      id: 't-1',
      templateCode: 'zone_monthly',
      versionNumber: 1,
      displayName: 'Zone Monthly',
      statusVocab: 'standard',
      cadence: 'monthly',
      requiresThreeSignatures: false,
      sections: [],
      cachedAt: '2026-06-02T10:00:00.000Z',
    });
    // Seed an entity row that should SURVIVE the logout clear.
    await db.hazards.put({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hazardCode: 'H-001',
      title: 'Test',
      severity: 'low',
      status: 'open',
      jurisdiction: 'ON',
      locationZone: null,
      reportedAt: '2026-06-02T10:00:00.000Z',
      description_ct_b64: null,
      description_dek_ct_b64: null,
      ...cleanSyncMetadata('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, '{}'),
    });

    // Sanity: rows exist.
    expect(await db.sync_queue.count()).toBe(1);
    expect(await db.sync_conflicts.count()).toBe(1);
    expect(await db._base_state.count()).toBe(1);
    expect(await db.legal_clauses.count()).toBe(1);
    expect(await db.inspection_templates.count()).toBe(1);
    expect(await db.hazards.count()).toBe(1);

    await clearOnLogout();

    // Per-session tables are drained.
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.sync_conflicts.count()).toBe(0);
    expect(await db._base_state.count()).toBe(0);
    expect(await db.legal_clauses.count()).toBe(0);
    expect(await db.inspection_templates.count()).toBe(0);
    // Entity caches survive (the rep may sign back in and expect
    // their drafts to still be there).
    expect(await db.hazards.count()).toBe(1);
  });
});
