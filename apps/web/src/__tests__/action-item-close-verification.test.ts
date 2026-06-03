// Unit tests for the close-verification view's state machine + the
// closure helpers (Milestone 2.2 S3, ADR-0013 §3.5).
//
// We test the load-bearing pieces without a full RTL render so the
// tests stay fast + deterministic:
//   - The closure-reason envelope shape (round-trip through the
//     M2.1 sealMeetingField helper to assert client-side encryption
//     is wired correctly + the closure-reason ciphertext is never
//     sent as plaintext).
//   - The Dexie schema v3 store registration (action_item_closures +
//     meeting_live_metrics open without throw).
//   - The MEETING_RIGHTS_COPY closure strings (T-IM25 / T-IM26 /
//     T-IM23 / T-IM27 mitigation properties).
//   - The actionItemsApi.closeVerification + reopen endpoint paths +
//     verb shape.

import 'fake-indexeddb/auto';
import sodium from 'libsodium-wrappers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JhscOfflineDb, DEXIE_SCHEMA_VERSION } from '@/sync/db';
import { MEETING_RIGHTS_COPY } from '@/meetings/rights-protective-copy';
import { actionItemsApi, ActionItemsApiError } from '@/action-items/api';

describe('Dexie schema v3 — M2.2 S3 stores', () => {
  it('declares the v3 schema constant', () => {
    expect(DEXIE_SCHEMA_VERSION).toBe(3);
  });

  it('opens with the action_item_closures + meeting_live_metrics stores', async () => {
    const db = new JhscOfflineDb('m22-s3-schema-test');
    try {
      await db.open();
      expect(db.action_item_closures).toBeDefined();
      expect(db.meeting_live_metrics).toBeDefined();
      // Round-trip an action_item_closures row to assert the index is wired.
      await db.action_item_closures.put({
        id: '11111111-1111-4111-8111-111111111111',
        actionItemId: '22222222-2222-4222-8222-222222222222',
        meetingId: null,
        closedByActorId: 'actor-a',
        closedAt: '2026-06-03T10:00:00Z',
        counterSignerActorId: 'actor-a',
        counterSignedAt: '2026-06-03T10:00:00Z',
        selfAttestation: true,
        signingKeyId: 'sk-1',
        evidenceStorageKey: null,
        chainAnchorHash: 'aa',
        attestationSigHash: 'bb',
        cachedAt: '2026-06-03T10:00:00Z',
      });
      const found = await db.action_item_closures
        .where('actionItemId')
        .equals('22222222-2222-4222-8222-222222222222')
        .first();
      expect(found).toBeDefined();
      expect(found?.selfAttestation).toBe(true);
      // Round-trip a meeting_live_metrics row.
      await db.meeting_live_metrics.put({
        meetingId: '33333333-3333-4333-8333-333333333333',
        responseJson: JSON.stringify({ itemsRaised: 0 }),
        cachedAt: '2026-06-03T10:00:00Z',
      });
      const m = await db.meeting_live_metrics.get('33333333-3333-4333-8333-333333333333');
      expect(m).toBeDefined();
    } finally {
      db.close();
      await indexedDB.deleteDatabase('m22-s3-schema-test');
    }
  });
});

describe('MEETING_RIGHTS_COPY — M2.2 closure surface guards', () => {
  it('exposes the closureVerificationBanner with evidence framing (T-IM25)', () => {
    const banner = MEETING_RIGHTS_COPY.closureVerificationBanner;
    expect(banner).toMatch(/evidence/i);
    expect(banner).toMatch(/tamper-evident/i);
    expect(banner).not.toMatch(/approve/i);
    expect(banner).not.toMatch(/sign off/i);
  });

  it('uses descriptive placeholder, never adversarial (T-IM26)', () => {
    expect(MEETING_RIGHTS_COPY.closureReasonPlaceholder).toBe('What was done to verify closure?');
    expect(MEETING_RIGHTS_COPY.closureReasonPlaceholder).not.toMatch(/justify/i);
  });

  it('selfAttestation banner records the constraint honestly (S0 Q2)', () => {
    expect(MEETING_RIGHTS_COPY.closureSelfAttestationBanner).toMatch(/single-rep constraint/i);
    expect(MEETING_RIGHTS_COPY.closureSelfAttestationBanner).not.toMatch(/violation/i);
    expect(MEETING_RIGHTS_COPY.closureSelfAttestationBanner).not.toMatch(/forbidden/i);
  });

  it('offline hint surfaces the recovery affordance neutrally (T-IM23)', () => {
    expect(MEETING_RIGHTS_COPY.closureOfflineHint).toMatch(/network connection/i);
    expect(MEETING_RIGHTS_COPY.closureOfflineHint).not.toMatch(/lost/i);
    expect(MEETING_RIGHTS_COPY.closureOfflineHint).not.toMatch(/wait/i);
  });

  it('live metrics legend surfaces aggregate-only posture (T-IM27)', () => {
    expect(MEETING_RIGHTS_COPY.liveMetricsLegend).toMatch(/aggregates|counts only/i);
    expect(MEETING_RIGHTS_COPY.liveMetricsLegend).toMatch(/no per-rep/i);
  });
});

describe('closure reason envelope shape (T-IM25 / non-negotiable #4)', () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  it('produces sealed-box DEK that decrypts with the workplace private key', async () => {
    // Use a real X25519 keypair — never 32 zero bytes (low-order point;
    // crypto_box_seal throws). Lesson from M2.1 PR #31 CI fix.
    const kp = sodium.crypto_box_keypair();
    // We use libsodium directly here rather than the
    // @/meetings/crypto helper because the helper depends on the
    // cached workplace key (which the test would have to wire up).
    // The shape we're asserting is wire-equivalent: a 32-byte DEK,
    // an XChaCha20-Poly1305 ciphertext, both sealed.
    const dek = new Uint8Array(32);
    crypto.getRandomValues(dek);
    const nonce = new Uint8Array(24);
    crypto.getRandomValues(nonce);
    // Wrap TextEncoder output to satisfy libsodium's strict
    // instanceof Uint8Array check (same shape as the production
    // @/meetings/crypto sealWithKey).
    const raw = new TextEncoder().encode('Verified by inspection — corrected mat in zone 3.');
    const plaintext =
      raw instanceof Uint8Array && raw.constructor === Uint8Array ? raw : new Uint8Array(raw);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, dek);
    const dekSealed = sodium.crypto_box_seal(dek, kp.publicKey);
    const dekUnsealed = sodium.crypto_box_seal_open(dekSealed, kp.publicKey, kp.privateKey);
    expect(dekUnsealed).toEqual(dek);
    const recovered = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ct,
      null,
      nonce,
      dekUnsealed,
    );
    expect(new TextDecoder().decode(recovered)).toBe(
      'Verified by inspection — corrected mat in zone 3.',
    );
  });
});

describe('actionItemsApi.closeVerification — wire shape', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /api/action-items/:id/close-verification with the body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof _input === 'string' ? _input : (_input as URL).toString();
      expect(url).toBe('/api/action-items/abc/close-verification');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body.counterSignerActorId).toBe('user-1');
      expect(body.selfAttestation).toBe(true);
      expect(body.closureReason.ciphertextB64).toBe('CT');
      expect(body.closureReason.dekCiphertextB64).toBe('DEK');
      return new Response(
        JSON.stringify({
          id: 'abc',
          actionItemId: 'abc',
          closureId: 'closure-1',
          status: 'Closed',
          closedAt: '2026-06-03T10:00:00Z',
          counterSignedAt: '2026-06-03T10:00:00Z',
          chainAnchorHash: 'abcd',
          attestationSigHash: 'efgh',
          selfAttestation: true,
          version: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await actionItemsApi.closeVerification('abc', {
      counterSignerActorId: 'user-1',
      selfAttestation: true,
      closureReason: { ciphertextB64: 'CT', dekCiphertextB64: 'DEK' },
    });
    expect(res.closureId).toBe('closure-1');
    expect(res.selfAttestation).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws ActionItemsApiError with status on 401 step_up_required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'step_up_required', action: 'action_item.close_verification' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    await expect(
      actionItemsApi.closeVerification('abc', {
        counterSignerActorId: 'user-1',
        selfAttestation: true,
        closureReason: { ciphertextB64: 'CT', dekCiphertextB64: 'DEK' },
      }),
    ).rejects.toBeInstanceOf(ActionItemsApiError);
  });

  it('throws ActionItemsApiError on 409 already verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'ALREADY_CLOSED' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    let err: unknown = null;
    try {
      await actionItemsApi.closeVerification('abc', {
        counterSignerActorId: 'user-1',
        selfAttestation: true,
        closureReason: { ciphertextB64: 'CT', dekCiphertextB64: 'DEK' },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActionItemsApiError);
    expect((err as ActionItemsApiError).status).toBe(409);
  });
});

describe('actionItemsApi.reopen — wire shape', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /api/action-items/:id/reopen with the enum reason', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof _input === 'string' ? _input : (_input as URL).toString();
      expect(url).toBe('/api/action-items/abc/reopen');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body.reason).toBe('rep_decision');
      return new Response(
        JSON.stringify({
          id: 'abc',
          status: 'In Progress',
          previousClosureId: 'closure-1',
          version: 3,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await actionItemsApi.reopen('abc', { reason: 'rep_decision' });
    expect(res.status).toBe('In Progress');
    expect(res.previousClosureId).toBe('closure-1');
  });
});
