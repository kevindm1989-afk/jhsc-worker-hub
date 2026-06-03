// DB-backed schema smoke test for the action_item_closures table +
// action_items.closure_verification_id + the meeting_action_item_state
// partial UNIQUE (Milestone 2.2, ADR-0013 §3.1 + TM-folds 1 + 2 + 5).
//
// Skips when DATABASE_URL is unset.
//
// Coverage:
//   - INSERT a peer-verified closure (different actors) → OK.
//   - INSERT a self-attestation closure (identical actors) with
//     selfAttestation=TRUE → OK.
//   - INSERT a closure with selfAttestation=FALSE + identical actors
//     → CHECK rejection (actors_shape).
//   - INSERT a closure with selfAttestation=TRUE + distinct actors
//     → CHECK rejection (actors_shape).
//   - INSERT two closures for the same action_item_id → UNIQUE rejection.
//   - UPDATE action_items.status='Closed' without setting
//     closure_verification_id → CHECK rejection.
//   - UPDATE action_items.status='In Progress' while
//     closure_verification_id IS NOT NULL → CHECK rejection.
//   - INSERT two live snapshot rows for the same (meeting, action_item,
//     status, section) → partial-UNIQUE rejection.
//   - INSERT two live snapshot rows for the same (meeting, action_item)
//     but DIFFERENT status → both succeed.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { getDb } from '../db/client';
import {
  meetings,
  meetingTemplates,
  meetingActionItemState,
  workplaceSigningKeys,
  users,
  actionItems,
  actionItemClosures,
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

async function seedActionItem(): Promise<string> {
  const db = getDb();
  const rows = await db
    .insert(actionItems)
    .values({
      sequenceNumber: 1,
      type: 'INSIGHT',
      descriptionCt: new Uint8Array(8),
      descriptionDekCt: new Uint8Array(8),
      status: 'In Progress',
      risk: 'Medium',
      section: 'new_business',
      startDate: '2026-06-10',
    })
    .returning({ id: actionItems.id });
  return rows[0]!.id;
}

beforeAll(async () => {
  if (SKIP) return;
  await bootAuthTestEnv();
});

beforeEach(async () => {
  if (SKIP) return;
  await cleanAuthTables();
});

describe.skipIf(SKIP)('action_item_closures schema smoke (2.2)', () => {
  it('accepts a peer-verified closure with distinct actors', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const closer = await seedUser();
    const counter = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    const rows = await db
      .insert(actionItemClosures)
      .values({
        actionItemId,
        closedByActorId: closer,
        counterSignedByActorId: counter,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: false,
        signingKeyId,
        attestationSignedCt: attestationSig,
      })
      .returning({ id: actionItemClosures.id });
    expect(rows[0]!.id).toBeTruthy();
  });

  it('accepts a self-attestation closure with identical actors', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const rep = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    const rows = await db
      .insert(actionItemClosures)
      .values({
        actionItemId,
        closedByActorId: rep,
        counterSignedByActorId: rep,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: true,
        signingKeyId,
        attestationSignedCt: attestationSig,
      })
      .returning({ id: actionItemClosures.id });
    expect(rows[0]!.id).toBeTruthy();
  });

  it('rejects selfAttestation=FALSE with identical actors (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const rep = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    await expect(
      db.insert(actionItemClosures).values({
        actionItemId,
        closedByActorId: rep,
        counterSignedByActorId: rep,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: false, // BAD: must be true if actors are identical
        signingKeyId,
        attestationSignedCt: attestationSig,
      }),
    ).rejects.toThrow();
  });

  it('rejects selfAttestation=TRUE with distinct actors (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const closer = await seedUser();
    const counter = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    await expect(
      db.insert(actionItemClosures).values({
        actionItemId,
        closedByActorId: closer,
        counterSignedByActorId: counter,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: true, // BAD: distinct actors require false
        signingKeyId,
        attestationSignedCt: attestationSig,
      }),
    ).rejects.toThrow();
  });

  it('rejects two closures for the same action_item (UNIQUE)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const closer = await seedUser();
    const counter = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    await db.insert(actionItemClosures).values({
      actionItemId,
      closedByActorId: closer,
      counterSignedByActorId: counter,
      closureReasonEnvelopeCt: new Uint8Array(8),
      closureReasonEnvelopeDekCt: new Uint8Array(8),
      selfAttestation: false,
      signingKeyId,
      attestationSignedCt: attestationSig,
    });

    await expect(
      db.insert(actionItemClosures).values({
        actionItemId,
        closedByActorId: closer,
        counterSignedByActorId: counter,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: false,
        signingKeyId,
        attestationSignedCt: attestationSig,
      }),
    ).rejects.toThrow();
  });

  it('rejects evidence pair-NULL violations (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const closer = await seedUser();
    const counter = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    await expect(
      db.insert(actionItemClosures).values({
        actionItemId,
        closedByActorId: closer,
        counterSignedByActorId: counter,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        // BAD: storage_key without envelope ct/dek
        evidenceStorageKey: 'closures/abc/evidence.bin',
        selfAttestation: false,
        signingKeyId,
        attestationSignedCt: attestationSig,
      }),
    ).rejects.toThrow();
  });

  it('rejects an attestation sig that is not 64 bytes (CHECK)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const closer = await seedUser();
    const counter = await seedUser();
    const actionItemId = await seedActionItem();

    await expect(
      db.insert(actionItemClosures).values({
        actionItemId,
        closedByActorId: closer,
        counterSignedByActorId: counter,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: false,
        signingKeyId,
        attestationSignedCt: new Uint8Array(32), // BAD: not 64 bytes
      }),
    ).rejects.toThrow();
  });
});

describe.skipIf(SKIP)('action_items.closure_verification_id CHECK (TM-fold-1)', () => {
  it('rejects status=Closed with NULL closure_verification_id', async () => {
    const db = getDb();
    await seedTemplate(1);
    const actionItemId = await seedActionItem();

    await expect(
      db.execute(sql`UPDATE action_items SET status = 'Closed' WHERE id = ${actionItemId}::uuid`),
    ).rejects.toThrow();
  });

  it('rejects non-Closed status with closure_verification_id NOT NULL', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const closer = await seedUser();
    const counter = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    const closures = await db
      .insert(actionItemClosures)
      .values({
        actionItemId,
        closedByActorId: closer,
        counterSignedByActorId: counter,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: false,
        signingKeyId,
        attestationSignedCt: attestationSig,
      })
      .returning({ id: actionItemClosures.id });
    const closureId = closures[0]!.id;

    // First land the legitimate Closed pairing.
    await db.execute(
      sql`UPDATE action_items SET status = 'Closed', closure_verification_id = ${closureId}::uuid WHERE id = ${actionItemId}::uuid`,
    );

    // Now attempt the illegal state (non-Closed with FK set).
    await expect(
      db.execute(
        sql`UPDATE action_items SET status = 'In Progress' WHERE id = ${actionItemId}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('accepts the legitimate Closed pairing', async () => {
    const db = getDb();
    await seedTemplate(1);
    const signingKeyId = await seedSigningKey();
    const closer = await seedUser();
    const counter = await seedUser();
    const actionItemId = await seedActionItem();
    const attestationSig = new Uint8Array(64);

    const closures = await db
      .insert(actionItemClosures)
      .values({
        actionItemId,
        closedByActorId: closer,
        counterSignedByActorId: counter,
        closureReasonEnvelopeCt: new Uint8Array(8),
        closureReasonEnvelopeDekCt: new Uint8Array(8),
        selfAttestation: false,
        signingKeyId,
        attestationSignedCt: attestationSig,
      })
      .returning({ id: actionItemClosures.id });
    const closureId = closures[0]!.id;

    await db.execute(
      sql`UPDATE action_items SET status = 'Closed', closure_verification_id = ${closureId}::uuid WHERE id = ${actionItemId}::uuid`,
    );

    const after = await db.execute(
      sql`SELECT status, closure_verification_id FROM action_items WHERE id = ${actionItemId}::uuid`,
    );
    const row = (
      after as unknown as Array<{
        status: string;
        closure_verification_id: string;
      }>
    )[0]!;
    expect(row.status).toBe('Closed');
    expect(row.closure_verification_id).toBe(closureId);
  });
});

describe.skipIf(SKIP)('meeting_action_item_state live partial UNIQUE (TM-fold-2)', () => {
  it('rejects duplicate live snapshots with same (meeting, item, status, section)', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const meetingId = await seedMeeting(userId);
    const actionItemId = await seedActionItem();

    await db.insert(meetingActionItemState).values({
      meetingId,
      actionItemId,
      snapshotKind: 'live',
      snapshotStatus: 'In Progress',
      snapshotSection: 'new_business',
    });

    await expect(
      db.insert(meetingActionItemState).values({
        meetingId,
        actionItemId,
        snapshotKind: 'live',
        snapshotStatus: 'In Progress',
        snapshotSection: 'new_business',
      }),
    ).rejects.toThrow();
  });

  it('accepts two live snapshots with same (meeting, item) but DIFFERENT status', async () => {
    const db = getDb();
    await seedTemplate(1);
    const userId = await seedUser();
    const meetingId = await seedMeeting(userId);
    const actionItemId = await seedActionItem();

    await db.insert(meetingActionItemState).values({
      meetingId,
      actionItemId,
      snapshotKind: 'live',
      snapshotStatus: 'Not Started',
      snapshotSection: 'new_business',
    });

    // Second row with a semantically-distinct status — must succeed.
    await db.insert(meetingActionItemState).values({
      meetingId,
      actionItemId,
      snapshotKind: 'live',
      snapshotStatus: 'In Progress',
      snapshotSection: 'new_business',
    });

    const count = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM meeting_action_item_state WHERE meeting_id = ${meetingId}::uuid AND action_item_id = ${actionItemId}::uuid AND snapshot_kind = 'live'`,
    );
    expect((count as unknown as Array<{ n: number }>)[0]!.n).toBe(2);
  });
});
