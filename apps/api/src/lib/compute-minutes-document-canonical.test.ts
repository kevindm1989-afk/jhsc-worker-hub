// Unit test for compute-minutes-document-canonical.ts (2.3, ADR-0014 §3.1.1).
//
// Goals:
//   - Deterministic canonicalization (same input -> same bytes).
//   - Tampering with any load-bearing field changes the digest.
//   - retentionCorpusEntryHashes are sorted defensively (caller can
//     pass them in any order).
//   - Digest is the SHA-256 of the canonical JSON, 32 bytes.
//   - priorDocumentId null vs string both round-trip cleanly.

import { describe, expect, it } from 'vitest';
import {
  canonicalizeMinutesDocument,
  minutesDocumentCanonicalDigest,
  type MinutesDocumentCanonical,
} from './compute-minutes-document-canonical';

const BASE: MinutesDocumentCanonical = {
  meetingId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222',
  formatVersion: 'v1',
  renderAudience: 'jhsc_internal',
  documentHash: 'a'.repeat(64),
  documentSizeBytes: 12345,
  tigrisStorageKey:
    'minutes/11111111-1111-4111-8111-111111111111/20260920160000/' + 'a'.repeat(64) + '.pdf',
  priorDocumentId: null,
  generatedAt: '2026-09-20T16:00:00.000Z',
  generatedByActorId: '33333333-3333-4333-8333-333333333333',
  signingKeyId: '44444444-4444-4444-8444-444444444444',
  retentionCorpusEntryHashes: ['c'.repeat(64), 'b'.repeat(64)],
};

describe('canonicalizeMinutesDocument — pure stable stringifier', () => {
  it('is deterministic for the same input', () => {
    expect(canonicalizeMinutesDocument(BASE)).toBe(canonicalizeMinutesDocument(BASE));
  });

  it('sorts retentionCorpusEntryHashes ascending so caller order does not matter', () => {
    const reordered: MinutesDocumentCanonical = {
      ...BASE,
      retentionCorpusEntryHashes: [...BASE.retentionCorpusEntryHashes].reverse(),
    };
    expect(canonicalizeMinutesDocument(BASE)).toBe(canonicalizeMinutesDocument(reordered));
  });

  it('keys are emitted in alphabetical order', () => {
    const canonical = canonicalizeMinutesDocument(BASE);
    // The first 5 keys in alphabetical order:
    // documentHash, documentId, documentSizeBytes, formatVersion, generatedAt
    expect(canonical.indexOf('"documentHash"')).toBeLessThan(canonical.indexOf('"documentId"'));
    expect(canonical.indexOf('"documentId"')).toBeLessThan(
      canonical.indexOf('"documentSizeBytes"'),
    );
    expect(canonical.indexOf('"documentSizeBytes"')).toBeLessThan(
      canonical.indexOf('"formatVersion"'),
    );
    expect(canonical.indexOf('"generatedAt"')).toBeLessThan(
      canonical.indexOf('"generatedByActorId"'),
    );
  });

  it('tampering with documentHash changes the canonical bytes', () => {
    const tampered: MinutesDocumentCanonical = { ...BASE, documentHash: 'z'.repeat(64) };
    expect(canonicalizeMinutesDocument(BASE)).not.toBe(canonicalizeMinutesDocument(tampered));
  });

  it('tampering with tigrisStorageKey changes the canonical bytes (TM-fold-4 bind)', () => {
    const tampered: MinutesDocumentCanonical = {
      ...BASE,
      tigrisStorageKey:
        'minutes/11111111-1111-4111-8111-111111111111/20260920160001/' + 'a'.repeat(64) + '.pdf',
    };
    expect(canonicalizeMinutesDocument(BASE)).not.toBe(canonicalizeMinutesDocument(tampered));
  });

  it('tampering with renderAudience changes the canonical bytes (TM-fold-2 bind)', () => {
    const tampered: MinutesDocumentCanonical = { ...BASE, renderAudience: 'external_distribution' };
    expect(canonicalizeMinutesDocument(BASE)).not.toBe(canonicalizeMinutesDocument(tampered));
  });

  it('priorDocumentId null vs a uuid both serialize cleanly', () => {
    const initial = canonicalizeMinutesDocument({ ...BASE, priorDocumentId: null });
    const regen = canonicalizeMinutesDocument({
      ...BASE,
      priorDocumentId: '55555555-5555-4555-8555-555555555555',
    });
    expect(initial).toContain('"priorDocumentId":null');
    expect(regen).toContain('"priorDocumentId":"55555555-5555-4555-8555-555555555555"');
  });

  it('tampering with one retention corpus hash changes the canonical bytes (TM-fold-5 bind)', () => {
    const tampered: MinutesDocumentCanonical = {
      ...BASE,
      retentionCorpusEntryHashes: ['c'.repeat(64), 'd'.repeat(64)],
    };
    expect(canonicalizeMinutesDocument(BASE)).not.toBe(canonicalizeMinutesDocument(tampered));
  });
});

describe('minutesDocumentCanonicalDigest — 32-byte SHA-256', () => {
  it('returns 32 bytes', () => {
    const d = minutesDocumentCanonicalDigest(BASE);
    expect(d).toBeInstanceOf(Uint8Array);
    expect(d.byteLength).toBe(32);
  });

  it('is deterministic for the same input', () => {
    const a = minutesDocumentCanonicalDigest(BASE);
    const b = minutesDocumentCanonicalDigest(BASE);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('changes on any tamper to a load-bearing field', () => {
    const base = Buffer.from(minutesDocumentCanonicalDigest(BASE)).toString('hex');
    const tampered = Buffer.from(
      minutesDocumentCanonicalDigest({ ...BASE, documentSizeBytes: 99999 }),
    ).toString('hex');
    expect(base).not.toBe(tampered);
  });
});
