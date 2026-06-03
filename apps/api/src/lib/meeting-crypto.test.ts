// Meeting-crypto envelope + attestation tests (ADR-0012, TM-fold-4).
//
// Coverage:
//   - sealMeetingField → openMeetingField round-trip for representative
//     PII strings (attendee display name, signer name, section notes,
//     evidence body, chain-of-custody note).
//   - sealOptionalMeetingField returns null on empty/undefined/null.
//   - signAttestation produces a 64-byte Ed25519 sig that
//     verifyAttestation accepts; any tamper of the row flips it false.
//
// Audit payload type-level test lives in a sibling file; this is the
// runtime crypto round-trip.

import { describe, expect, it, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { initCrypto, randomBytes } from '@jhsc/crypto';
import {
  openMeetingField,
  openOptionalMeetingField,
  sealMeetingField,
  sealOptionalMeetingField,
  sealMeetingNotes,
  unsealMeetingNotes,
  signAttestation,
  verifyAttestation,
  sha256Hex,
  type AttestationRowCanonical,
} from './meeting-crypto';
import { _setMasterKeyForTests, _resetForTests } from '../auth/crypto-stub';

beforeAll(async () => {
  await initCrypto();
  // Pin a deterministic master key for the round-trip tests. The
  // setup.ts hook seeds process.env.MASTER_KEY; we override here with a
  // freshly generated key so this file is self-contained.
  _setMasterKeyForTests(randomBytes(32));
});

describe('meeting envelope round-trip', () => {
  it.each([
    ['attendee display name', 'Worker Co-Chair Smith'],
    ['signer display name', 'External Signer 1'],
    ['section notes', 'Discussed Q3 inspection backlog; deferred two items.'],
    ['evidence body', 'Email body: I attest to the minutes as recorded.'],
    ['chain-of-custody note', 'Received signed PDF via email on 2026-06-10.'],
    ['multi-byte unicode', '署名者：日本語の名前 — éàü漢字'],
    ['empty-ish whitespace', '   '],
  ])('round-trips %s', (_label, plaintext) => {
    const sealed = sealMeetingField(plaintext);
    expect(sealed.ct.length).toBeGreaterThan(0);
    expect(sealed.dekCt.length).toBeGreaterThan(0);
    const opened = openMeetingField(sealed);
    expect(opened).toBe(plaintext);
  });

  it('sealOptionalMeetingField returns null for null/undefined/empty', () => {
    expect(sealOptionalMeetingField(null)).toBeNull();
    expect(sealOptionalMeetingField(undefined)).toBeNull();
    expect(sealOptionalMeetingField('')).toBeNull();
  });

  it('sealOptionalMeetingField returns a sealed field for non-empty input', () => {
    const sealed = sealOptionalMeetingField('signer name');
    expect(sealed).not.toBeNull();
    if (sealed) {
      expect(openMeetingField(sealed)).toBe('signer name');
    }
  });

  it('openOptionalMeetingField returns null when either column is null', () => {
    expect(openOptionalMeetingField({ ct: null, dekCt: null })).toBeNull();
    expect(openOptionalMeetingField({ ct: new Uint8Array(0), dekCt: null })).toBeNull();
    expect(openOptionalMeetingField({ ct: null, dekCt: new Uint8Array(0) })).toBeNull();
  });
});

describe('explicit-KEK helpers (sealMeetingNotes / unsealMeetingNotes)', () => {
  it('round-trips with an explicit KEK argument', () => {
    const kek = randomBytes(32);
    const sealed = sealMeetingNotes('private co-chair note', kek);
    const opened = unsealMeetingNotes(sealed, kek);
    expect(opened).toBe('private co-chair note');
  });

  it('a different KEK fails to open', () => {
    const kek1 = randomBytes(32);
    const kek2 = randomBytes(32);
    const sealed = sealMeetingNotes('private note', kek1);
    expect(() => unsealMeetingNotes(sealed, kek2)).toThrow();
  });
});

describe('TM-fold-4: signAttestation / verifyAttestation', () => {
  it('signs and verifies a meeting_signatures row', async () => {
    await sodium.ready;
    const { publicKey, privateKey } = sodium.crypto_sign_keypair();
    const row: AttestationRowCanonical = {
      meetingId: '11111111-1111-4111-8111-111111111111',
      signerRole: 'worker_co_chair',
      signerDisplayNameHash: sha256Hex(new TextEncoder().encode('encrypted-name-ct-bytes')),
      signerUserId: '22222222-2222-4222-8222-222222222222',
      signedAt: '2026-06-10T13:00:00.000Z',
      signedMethod: 'in_app_passkey',
      evidenceStorageKey: null,
      evidenceHash: null,
      stepUpJti: 'step-up-jti-abc',
      chainOfCustodyNoteHash: null,
      signingKeyId: '33333333-3333-4333-8333-333333333333',
    };
    const sig = signAttestation(row, privateKey);
    expect(sig.length).toBe(64);
    expect(verifyAttestation(row, sig, publicKey)).toBe(true);
  });

  it('rejects a tampered row', async () => {
    await sodium.ready;
    const { publicKey, privateKey } = sodium.crypto_sign_keypair();
    const row: AttestationRowCanonical = {
      meetingId: '11111111-1111-4111-8111-111111111111',
      signerRole: 'mgmt_external_1',
      signerDisplayNameHash: sha256Hex(new TextEncoder().encode('a')),
      signerUserId: null,
      signedAt: '2026-06-10T13:00:00.000Z',
      signedMethod: 'paper_attestation',
      evidenceStorageKey: 'meetings/abc/sigs/1.pdf.enc',
      evidenceHash: sha256Hex(new TextEncoder().encode('evidence-ct')),
      stepUpJti: null,
      chainOfCustodyNoteHash: sha256Hex(new TextEncoder().encode('note-ct')),
      signingKeyId: '33333333-3333-4333-8333-333333333333',
    };
    const sig = signAttestation(row, privateKey);
    const tampered = { ...row, signerRole: 'worker_co_chair' };
    expect(verifyAttestation(tampered, sig, publicKey)).toBe(false);
  });

  it('rejects a wrong public key', async () => {
    await sodium.ready;
    const a = sodium.crypto_sign_keypair();
    const b = sodium.crypto_sign_keypair();
    const row: AttestationRowCanonical = {
      meetingId: '11111111-1111-4111-8111-111111111111',
      signerRole: 'worker_co_chair',
      signerDisplayNameHash: 'a',
      signerUserId: null,
      signedAt: '2026-06-10T13:00:00.000Z',
      signedMethod: 'in_app_passkey',
      evidenceStorageKey: null,
      evidenceHash: null,
      stepUpJti: 'x',
      chainOfCustodyNoteHash: null,
      signingKeyId: 'k',
    };
    const sig = signAttestation(row, a.privateKey);
    expect(verifyAttestation(row, sig, b.publicKey)).toBe(false);
  });

  it('rejects a malformed signature length', async () => {
    await sodium.ready;
    const { publicKey } = sodium.crypto_sign_keypair();
    const row: AttestationRowCanonical = {
      meetingId: 'm',
      signerRole: 'worker_co_chair',
      signerDisplayNameHash: 'a',
      signerUserId: null,
      signedAt: 't',
      signedMethod: 'in_app_passkey',
      evidenceStorageKey: null,
      evidenceHash: null,
      stepUpJti: 'x',
      chainOfCustodyNoteHash: null,
      signingKeyId: 'k',
    };
    expect(verifyAttestation(row, new Uint8Array(32), publicKey)).toBe(false);
  });
});

describe('cleanup', () => {
  it('resets master key for downstream test isolation', () => {
    _resetForTests();
    expect(true).toBe(true);
  });
});
