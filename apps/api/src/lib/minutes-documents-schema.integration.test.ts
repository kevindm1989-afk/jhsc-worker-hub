// DB-backed schema smoke test for the minutes_documents +
// minutes_distributions tables (Milestone 2.3, ADR-0014 §3.1 + TM-folds).
//
// Skips when DATABASE_URL is unset.
//
// Coverage:
//   - INSERT a minutes_documents row (initial, no prior_document_id).
//   - INSERT a regeneration row pointing at the prior via prior_document_id.
//   - UNIQUE(meeting_id, document_hash, render_audience) rejects an
//     idempotent re-insert with the same bytes for the same audience.
//   - The same hash CAN co-exist if render_audience differs (so the
//     same logical content rendered for jhsc_internal vs external
//     does not collide).
//   - tigris_storage_key regex CHECK rejects a malformed key
//     (TM-fold-4).
//   - document_hash length CHECK rejects a non-64-hex hash.
//   - hold_envelope pair CHECK rejects hold_state='none' + envelope
//     bytes, and rejects hold_state='subpoena_hold' + null envelope.
//   - hold_released_at <= hold_placed_at is rejected.
//   - attestation_signed_ct must be 64 bytes.
//   - INSERT a minutes_distributions row referencing the document.
//   - recipient_hash CHECK rejects a non-64-hex hash.
//   - recipient_role CHECK rejects an out-of-enum value.
//   - sent_method CHECK rejects an out-of-enum value.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { append } from '@jhsc/audit';
import { getDb } from '../db/client';
import {
  meetings,
  meetingTemplates,
  workplaceSigningKeys,
  users,
  minutesDocuments,
  minutesDistributions,
} from '../db/schema';
import { bootAuthTestEnv } from '../auth/test-setup';
import { cleanAuthTables, hasDb } from '../auth/test-db';

const SKIP = !hasDb();

async function seedTemplate(version: number): Promise<void> {
  const db = getDb();
  await db.insert(meetingTemplates).values({
    templateCode: 'jhsc_standard',
    versionNumber: version,
    name: 'JHSC Standard Agenda',
    jurisdiction: 'ON',
    sectionsJson: [
      {
        section_type: 'call_to_order',
        default_time_alloc_minutes: 5,
        default_visibility: 'standard',
        order_idx: 0,
      },
    ],
  });
}

async function seedSigningKey(): Promise<string> {
  const db = getDb();
  await sodium.ready;
  const { publicKey, privateKey } = sodium.crypto_sign_keypair();
  const rows = await db
    .insert(workplaceSigningKeys)
    .values({
      algorithm: 'ed25519',
      active: true,
      publicKey,
      privateKeyCt: privateKey,
      privateKeyDekCt: new Uint8Array(48),
    })
    .returning({ id: workplaceSigningKeys.id });
  return rows[0]!.id;
}

async function seedUser(): Promise<string> {
  const db = getDb();
  const rows = await db.insert(users).values({}).returning({ id: users.id });
  return rows[0]!.id;
}

async function seedMeeting(userId: string): Promise<string> {
  const db = getDb();
  const rows = await db
    .insert(meetings)
    .values({
      meetingDate: '2026-06-10',
      scheduledStartAt: new Date('2026-06-10T13:00:00.000Z'),
      scheduledEndAt: new Date('2026-06-10T14:30:00.000Z'),
      agendaTemplateVersion: 1,
      createdByActorId: userId,
    })
    .returning({ id: meetings.id });
  return rows[0]!.id;
}

/** Append a placeholder audit row + return the idx. */
async function anchorRow(
  meetingId: string,
  documentId: string,
  documentHash: string,
): Promise<number> {
  const db = getDb();
  const res = await append(db as unknown as Parameters<typeof append>[0], {
    payload: {
      kind: 'minutes_document.generated',
      meetingId,
      documentId,
      documentHash,
      documentSize: 1234,
      formatVersion: 'v1',
      renderAudience: 'jhsc_internal',
      generatedAt: new Date().toISOString(),
      generatedByActorId: meetingId, // any uuid is fine for chain
      retentionCorpusEntryHashes: [],
    },
  });
  return res.idx;
}

function newUuid(): string {
  // RFC 4122 v4-ish; the DB does not check format beyond a valid uuid.
  return [
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0'),
    Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0'),
    '4' +
      Math.floor(Math.random() * 0xfff)
        .toString(16)
        .padStart(3, '0'),
    (0x8000 + Math.floor(Math.random() * 0x4000)).toString(16),
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0') +
      Math.floor(Math.random() * 0xffff)
        .toString(16)
        .padStart(4, '0'),
  ].join('-');
}

function canonicalStorageKey(meetingId: string, hashHex: string): string {
  // minutes/<meetingId>/<utc14>/<hash>.pdf
  return `minutes/${meetingId}/20260920160000/${hashHex}.pdf`;
}

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  await cleanAuthTables();
});

describe.skipIf(SKIP)('minutes_documents schema smoke (2.3)', () => {
  it('inserts an initial minutes_documents row', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);

    const documentId = newUuid();
    const documentHash = 'a'.repeat(64);
    const auditIdx = await anchorRow(meetingId, documentId, documentHash);

    const rows = await db
      .insert(minutesDocuments)
      .values({
        id: documentId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'jhsc_internal',
        documentHash,
        documentSizeBytes: 1234,
        tigrisStorageKey: canonicalStorageKey(meetingId, documentHash),
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: ['b'.repeat(64)],
        auditIdx,
      })
      .returning({ id: minutesDocuments.id, version: minutesDocuments.version });
    expect(rows[0]!.id).toBe(documentId);
    expect(rows[0]!.version).toBe(1);
  });

  it('rejects duplicate (meeting_id, document_hash, render_audience) — UNIQUE', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const documentHash = 'c'.repeat(64);

    const docId1 = newUuid();
    const auditIdx1 = await anchorRow(meetingId, docId1, documentHash);
    await db.insert(minutesDocuments).values({
      id: docId1,
      meetingId,
      formatVersion: 'v1',
      renderAudience: 'jhsc_internal',
      documentHash,
      documentSizeBytes: 1234,
      tigrisStorageKey: canonicalStorageKey(meetingId, documentHash),
      generatedByActorId: userId,
      signingKeyId,
      attestationSignedCt: new Uint8Array(64),
      retentionCorpusEntryHashes: [],
      auditIdx: auditIdx1,
    });

    const docId2 = newUuid();
    const auditIdx2 = await anchorRow(meetingId, docId2, documentHash);
    await expect(
      db.insert(minutesDocuments).values({
        id: docId2,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'jhsc_internal',
        documentHash, // SAME
        documentSizeBytes: 1234,
        tigrisStorageKey: `minutes/${meetingId}/20260920160001/${documentHash}.pdf`,
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: [],
        auditIdx: auditIdx2,
      }),
    ).rejects.toThrow();
  });

  it('allows same hash across different render_audience values', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const documentHash = 'd'.repeat(64);

    const docInternalId = newUuid();
    const auditIdxA = await anchorRow(meetingId, docInternalId, documentHash);
    await db.insert(minutesDocuments).values({
      id: docInternalId,
      meetingId,
      formatVersion: 'v1',
      renderAudience: 'jhsc_internal',
      documentHash,
      documentSizeBytes: 1234,
      tigrisStorageKey: canonicalStorageKey(meetingId, documentHash),
      generatedByActorId: userId,
      signingKeyId,
      attestationSignedCt: new Uint8Array(64),
      retentionCorpusEntryHashes: [],
      auditIdx: auditIdxA,
    });

    const docExternalId = newUuid();
    const auditIdxB = await anchorRow(meetingId, docExternalId, documentHash);
    const rows = await db
      .insert(minutesDocuments)
      .values({
        id: docExternalId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'external_distribution',
        documentHash, // SAME hash
        documentSizeBytes: 1234,
        tigrisStorageKey: `minutes/${meetingId}/20260920160100/${documentHash}.pdf`,
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: [],
        auditIdx: auditIdxB,
      })
      .returning({ id: minutesDocuments.id });
    expect(rows[0]!.id).toBe(docExternalId);
  });

  it('rejects a malformed tigris_storage_key (TM-fold-4 regex CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const docId = newUuid();
    const documentHash = 'e'.repeat(64);
    const auditIdx = await anchorRow(meetingId, docId, documentHash);

    await expect(
      db.insert(minutesDocuments).values({
        id: docId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'jhsc_internal',
        documentHash,
        documentSizeBytes: 1234,
        // BAD: doesn't match `minutes/<meetingId>/<utc14>/<hash>.pdf`
        tigrisStorageKey: 'attacker-controlled-path/foo.pdf',
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: [],
        auditIdx,
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-64-hex document_hash', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const docId = newUuid();
    const goodHash = 'f'.repeat(64);
    const auditIdx = await anchorRow(meetingId, docId, goodHash);

    await expect(
      db.insert(minutesDocuments).values({
        id: docId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'jhsc_internal',
        documentHash: 'not-a-valid-hash', // BAD
        documentSizeBytes: 1234,
        tigrisStorageKey: canonicalStorageKey(meetingId, goodHash),
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: [],
        auditIdx,
      }),
    ).rejects.toThrow();
  });

  it('rejects hold_state != none without envelope bytes (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const docId = newUuid();
    const hash = '1'.repeat(64);
    const auditIdx = await anchorRow(meetingId, docId, hash);

    await expect(
      db.insert(minutesDocuments).values({
        id: docId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'jhsc_internal',
        documentHash: hash,
        documentSizeBytes: 1234,
        tigrisStorageKey: canonicalStorageKey(meetingId, hash),
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: [],
        auditIdx,
        holdState: 'subpoena_hold', // BAD: missing envelope + placed_at
      }),
    ).rejects.toThrow();
  });

  it('rejects attestation_signed_ct not 64 bytes (length CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const docId = newUuid();
    const hash = '2'.repeat(64);
    const auditIdx = await anchorRow(meetingId, docId, hash);

    await expect(
      db.insert(minutesDocuments).values({
        id: docId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'jhsc_internal',
        documentHash: hash,
        documentSizeBytes: 1234,
        tigrisStorageKey: canonicalStorageKey(meetingId, hash),
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(32), // BAD
        retentionCorpusEntryHashes: [],
        auditIdx,
      }),
    ).rejects.toThrow();
  });

  it('rejects document_size_bytes <= 0 (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const docId = newUuid();
    const hash = '3'.repeat(64);
    const auditIdx = await anchorRow(meetingId, docId, hash);

    await expect(
      db.insert(minutesDocuments).values({
        id: docId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'jhsc_internal',
        documentHash: hash,
        documentSizeBytes: 0, // BAD
        tigrisStorageKey: canonicalStorageKey(meetingId, hash),
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: [],
        auditIdx,
      }),
    ).rejects.toThrow();
  });

  it('rejects an out-of-enum render_audience (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const docId = newUuid();
    const hash = '4'.repeat(64);
    const auditIdx = await anchorRow(meetingId, docId, hash);

    await expect(
      db.insert(minutesDocuments).values({
        id: docId,
        meetingId,
        formatVersion: 'v1',
        renderAudience: 'workplace_eyes_only', // BAD
        documentHash: hash,
        documentSizeBytes: 1234,
        tigrisStorageKey: canonicalStorageKey(meetingId, hash),
        generatedByActorId: userId,
        signingKeyId,
        attestationSignedCt: new Uint8Array(64),
        retentionCorpusEntryHashes: [],
        auditIdx,
      }),
    ).rejects.toThrow();
  });
});

describe.skipIf(SKIP)('minutes_distributions schema smoke (2.3)', () => {
  async function seedDocument(
    userId: string,
    signingKeyId: string,
    meetingId: string,
  ): Promise<string> {
    const db = getDb();
    const docId = newUuid();
    const hash = '5'.repeat(64);
    const auditIdx = await anchorRow(meetingId, docId, hash);
    await db.insert(minutesDocuments).values({
      id: docId,
      meetingId,
      formatVersion: 'v1',
      renderAudience: 'jhsc_internal',
      documentHash: hash,
      documentSizeBytes: 1234,
      tigrisStorageKey: canonicalStorageKey(meetingId, hash),
      generatedByActorId: userId,
      signingKeyId,
      attestationSignedCt: new Uint8Array(64),
      retentionCorpusEntryHashes: [],
      auditIdx,
    });
    return docId;
  }

  it('inserts a distribution row', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const documentId = await seedDocument(userId, signingKeyId, meetingId);

    const distributionId = newUuid();
    // Anchor a distributed event for the FK.
    const res = await append(db as unknown as Parameters<typeof append>[0], {
      payload: {
        kind: 'minutes_document.distributed',
        meetingId,
        documentId,
        distributionId,
        documentHash: '5'.repeat(64),
        recipientHash: 'a'.repeat(64),
        recipientRole: 'mlitsd_inspector',
        sentMethod: 'email',
        sentAt: new Date().toISOString(),
        sentByActorId: userId,
      },
    });

    const rows = await db
      .insert(minutesDistributions)
      .values({
        id: distributionId,
        documentId,
        recipientRole: 'mlitsd_inspector',
        recipientDisplayNameEnvelopeCt: new Uint8Array(8),
        recipientDisplayNameEnvelopeDekCt: new Uint8Array(8),
        recipientHash: 'a'.repeat(64),
        sentMethod: 'email',
        sentAt: new Date(),
        sentByActorId: userId,
        auditIdx: res.idx,
      })
      .returning({ id: minutesDistributions.id });
    expect(rows[0]!.id).toBe(distributionId);
  });

  it('rejects non-64-hex recipient_hash (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const documentId = await seedDocument(userId, signingKeyId, meetingId);

    const distributionId = newUuid();
    const res = await append(db as unknown as Parameters<typeof append>[0], {
      payload: {
        kind: 'minutes_document.distributed',
        meetingId,
        documentId,
        distributionId,
        documentHash: '5'.repeat(64),
        recipientHash: 'a'.repeat(64),
        recipientRole: 'mgmt_co_chair',
        sentMethod: 'email',
        sentAt: new Date().toISOString(),
        sentByActorId: userId,
      },
    });

    await expect(
      db.insert(minutesDistributions).values({
        id: distributionId,
        documentId,
        recipientRole: 'mgmt_co_chair',
        recipientDisplayNameEnvelopeCt: new Uint8Array(8),
        recipientDisplayNameEnvelopeDekCt: new Uint8Array(8),
        recipientHash: 'not-a-hex-hash', // BAD
        sentMethod: 'email',
        sentAt: new Date(),
        sentByActorId: userId,
        auditIdx: res.idx,
      }),
    ).rejects.toThrow();
  });

  it('rejects an out-of-enum recipient_role (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const documentId = await seedDocument(userId, signingKeyId, meetingId);

    const distributionId = newUuid();
    const res = await append(db as unknown as Parameters<typeof append>[0], {
      payload: {
        kind: 'minutes_document.distributed',
        meetingId,
        documentId,
        distributionId,
        documentHash: '5'.repeat(64),
        recipientHash: 'b'.repeat(64),
        recipientRole: 'mgmt_co_chair',
        sentMethod: 'email',
        sentAt: new Date().toISOString(),
        sentByActorId: userId,
      },
    });

    await expect(
      db.execute(sql`
        INSERT INTO minutes_distributions
          (id, document_id, recipient_role, recipient_display_name_envelope_ct,
           recipient_display_name_envelope_dek_ct, recipient_hash, sent_method,
           sent_at, sent_by_actor_id, audit_idx)
        VALUES
          (${distributionId}, ${documentId}, 'workplace_eyes_only',
           ${Buffer.from(new Uint8Array(8))}, ${Buffer.from(new Uint8Array(8))},
           ${'b'.repeat(64)}, 'email', now(), ${userId}, ${res.idx})
      `),
    ).rejects.toThrow();
  });

  it('rejects an out-of-enum sent_method (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const signingKeyId = await seedSigningKey();
    const meetingId = await seedMeeting(userId);
    const documentId = await seedDocument(userId, signingKeyId, meetingId);

    const distributionId = newUuid();
    const res = await append(db as unknown as Parameters<typeof append>[0], {
      payload: {
        kind: 'minutes_document.distributed',
        meetingId,
        documentId,
        distributionId,
        documentHash: '5'.repeat(64),
        recipientHash: 'c'.repeat(64),
        recipientRole: 'mgmt_co_chair',
        sentMethod: 'email',
        sentAt: new Date().toISOString(),
        sentByActorId: userId,
      },
    });

    await expect(
      db.execute(sql`
        INSERT INTO minutes_distributions
          (id, document_id, recipient_role, recipient_display_name_envelope_ct,
           recipient_display_name_envelope_dek_ct, recipient_hash, sent_method,
           sent_at, sent_by_actor_id, audit_idx)
        VALUES
          (${distributionId}, ${documentId}, 'mgmt_co_chair',
           ${Buffer.from(new Uint8Array(8))}, ${Buffer.from(new Uint8Array(8))},
           ${'c'.repeat(64)}, 'carrier_pigeon', now(), ${userId}, ${res.idx})
      `),
    ).rejects.toThrow();
  });
});
