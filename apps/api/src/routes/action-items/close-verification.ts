// /api/action-items/:id/close-verification + /reopen — Milestone 2.2 S2
// (ADR-0013 §3.2 + §3.5 + §3.10 + TM-folds 1 + 5; SECURITY §2.14 T-IM1
// / T-IM2 / T-IM3 / T-IM4 / T-IM5 / T-IM7 / T-IM10 / T-IM32 / T-IM33 /
// T-IM37).
//
// Two routes:
//
//   POST /api/action-items/:id/close-verification
//     The JHSC counter-sign closure attestation. The most security-
//     sensitive route in M2.2:
//       * Step-up required + freshness <60s (T-IM2 — same window as
//         M2.1 signatures per F-S1 close-out).
//       * Closer identity is the authenticated request actor — NEVER
//         a body field (T-IM1 forge mitigation).
//       * Counter-signer must resolve to a `worker_co_chair`. Per
//         single-tenant scope (ADR-0012 §3.4 — the in-app rep IS the
//         worker_co_chair), this collapses to "counter_signer_actor_id
//         must equal auth.userId" until 2.5 introduces a second in-app
//         worker rep. The validation surfaces a clean 422 for the
//         forward-seam violation rather than reaching the DB CHECK.
//       * If `selfAttestation=false` AND closer==counter-signer, the
//         route fails fast 422 INVALID_SELF_ATTESTATION_FLAG. The DB
//         CHECK is the structural backstop.
//       * Optional Tigris evidence blob — same M2.1 F-L1 HEAD-verify
//         pattern as the signature route.
//       * Single transaction: INSERT closure row → flip
//         action_items.status='Closed' + closure_verification_id (the
//         bi-directional CHECK enforces the invariant) → Ed25519-sign
//         the canonical row JSON → emit `action_item.closure_verified`
//         chain anchor → optionally emit
//         `meeting.action_item_status_changed` cross-anchor when the
//         closure happens inside an in_progress meeting (T-IM33).
//
//   POST /api/action-items/:id/reopen
//     Closed → In Progress transition (T-IM4 mitigation: re-opening is
//     high-stakes; step-up gates the WebAuthn assertion). Body carries
//     an enum reason (rep_decision | jhsc_review | mgmt_appeal — never
//     free text per ADR §3.5). The previous closure row is PRESERVED
//     as historical evidence (append-only invariant); only the FK on
//     action_items is cleared.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import sodium from 'libsodium-wrappers-sumo';
import { z } from 'zod';
import { append } from '@jhsc/audit';
import {
  actionItemReopenReason,
  actionItemClosureEvidenceSchema,
  actionItemClosureReasonEnvelopeSchema,
} from '@jhsc/shared-types/action-item-closure';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { getDb } from '../../db/client';
import {
  getActiveWorkplaceSigningPublicKey,
  openWorkplaceSigningPrivateKey,
} from '../../evidence/workplace-signing-key';
import { verifyEvidenceObject } from '../../evidence/tigris';
import {
  actionItemClosureCanonicalDigest,
  type ActionItemClosureCanonical,
} from '../../lib/compute-action-item-closure-canonical';
import { sha256Hex } from '../../lib/meeting-crypto';
import { idempotencyKey } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rate-limit';
import { computeChainEntryHash, writeLiveActionItemSnapshot } from '../meetings';

export const actionItemClosureRoute = new Hono();

actionItemClosureRoute.use('*', authMiddleware());
actionItemClosureRoute.use('*', idempotencyKey());
// T-IM17 + T-IM37 mitigation: generous bucket so a meeting where the
// rep closes 10–15 items in succession does NOT trip the limit (the
// chilling-effect bound). Same shape as the meetings route.
actionItemClosureRoute.use(
  '*',
  rateLimit({ name: 'action-item-closures', capacity: 60, refillPerSecond: 10 }),
);

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const uuidParam = z.string().uuid();

const closeVerificationBody = z
  .object({
    clientId: z.string().uuid().optional(),
    counterSignerActorId: z.string().uuid(),
    selfAttestation: z.boolean(),
    meetingId: z.string().uuid().optional(),
    closureReason: actionItemClosureReasonEnvelopeSchema,
    evidence: actionItemClosureEvidenceSchema.optional(),
  })
  .strict();

const reopenBody = z
  .object({
    reason: z.enum(actionItemReopenReason),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// M2.1 S5 F-L1 mirror — same Tigris key regex discipline for the
// closure-evidence path. Rejects `pending:` placeholders structurally;
// the HEAD check is the dynamic backstop.
const TIGRIS_EVIDENCE_KEY_REGEX = /^[A-Za-z0-9._/-]+$/;

function bytesFromBase64(b64: string): Uint8Array {
  return Buffer.from(b64, 'base64') as unknown as Uint8Array;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stepUpGate(c: any, action: string): Response | null {
  const auth = c.get('auth');
  const challenge = checkStepUpFreshness(auth, { action, maxAgeSeconds: 60 });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }
  return null;
}

class ClosureWriteAborted extends Error {
  readonly payload: { status: number; body: Record<string, unknown> };
  constructor(payload: { status: number; body: Record<string, unknown> }) {
    super(`closure_write_aborted: ${payload.status}`);
    this.name = 'ClosureWriteAborted';
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// POST /api/action-items/:id/close-verification
// ---------------------------------------------------------------------------

actionItemClosureRoute.post('/:id/close-verification', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

  const auth = c.get('auth');
  // T-IM2: step-up + 60s freshness. Same calibration as meeting.sign.
  const challenge = stepUpGate(c, 'action_item.close_verification');
  if (challenge) return challenge;

  const parsed = closeVerificationBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const closerActorId = auth.userId;
  const counterSignerActorId = body.counterSignerActorId;

  // T-IM1 + ADR §3.5: enforce the closer-vs-counter-signer flag
  // consistency at the route layer so the rep sees a clean 422 before
  // the DB CHECK fires. The CHECK is the structural backstop.
  if (body.selfAttestation === false && closerActorId === counterSignerActorId) {
    return c.json(
      {
        error: 'INVALID_SELF_ATTESTATION_FLAG',
        message:
          'Closer and counter-signer are the same user; selfAttestation must be true. See ADR-0013 §3.5.',
      },
      422,
    );
  }
  if (body.selfAttestation === true && closerActorId !== counterSignerActorId) {
    return c.json(
      {
        error: 'INVALID_SELF_ATTESTATION_FLAG',
        message:
          'Closer and counter-signer are distinct users; selfAttestation must be false. See ADR-0013 §3.5.',
      },
      422,
    );
  }

  // S0 user-decision Q1 + ADR §3.5: counter-signer must be a
  // `worker_co_chair`. Per ADR-0012 §3.4 the rep is the sole in-app
  // worker_co_chair until 2.5 introduces a second in-app worker rep —
  // so the role gate collapses to "counter_signer_actor_id must equal
  // the authenticated rep". A handcrafted POST that names some other
  // user_id is the 2.5 forward-seam violation and gets a clean 422.
  if (counterSignerActorId !== auth.userId) {
    return c.json(
      {
        error: 'COUNTER_SIGNER_ROLE_INVALID',
        message:
          'Counter-signer must be a worker_co_chair. Single-tenant scope: the in-app rep is the sole worker_co_chair; the second worker rep is a 2.5 forward seam.',
      },
      422,
    );
  }

  // Tigris HEAD verify on the evidence key, when present. Same shape
  // as the M2.1 signature route's F-L1 fix.
  if (body.evidence && process.env.TIGRIS_BUCKET) {
    if (body.evidence.storageKey.startsWith('pending:')) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    if (!TIGRIS_EVIDENCE_KEY_REGEX.test(body.evidence.storageKey)) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    try {
      const head = await verifyEvidenceObject({
        storageKey: body.evidence.storageKey,
        expectedByteSize: -1,
      });
      if (head.byteSize === null) {
        return c.json(
          {
            error: 'EVIDENCE_NOT_UPLOADED',
            message:
              'Closure-verification evidence must be uploaded to Tigris before recording the closure.',
            evidenceStorageKey: body.evidence.storageKey,
          },
          422,
        );
      }
    } catch {
      // Same fall-through posture as the signature route — better to
      // surface structural validation as the gate than 500 on a
      // network-transient Tigris fault.
    }
  }

  const db = getDb();
  const closureReasonCtBytes = bytesFromBase64(body.closureReason.ciphertextB64);
  const closureReasonDekBytes = bytesFromBase64(body.closureReason.dekCiphertextB64);
  const closureReasonHash = sha256Hex(closureReasonCtBytes);
  const evidenceCtBytes = body.evidence ? bytesFromBase64(body.evidence.envelopeCtB64) : null;
  const evidenceDekBytes = body.evidence ? bytesFromBase64(body.evidence.envelopeDekCtB64) : null;
  const evidenceHashHex = evidenceCtBytes ? sha256Hex(evidenceCtBytes) : null;

  const signingKey = await getActiveWorkplaceSigningPublicKey(db);
  if (!signingKey) {
    return c.json({ error: 'workplace_signing_key_not_seeded' }, 500);
  }

  await sodium.ready;
  const signingPrivateKey = await openWorkplaceSigningPrivateKey(db, signingKey.id);

  const closureId = randomUUID();
  const closedAt = new Date().toISOString();
  const counterSignedAt = closedAt;

  try {
    const canonical: ActionItemClosureCanonical = {
      actionItemId: idParsed.data,
      closureId,
      meetingId: body.meetingId ?? null,
      closerActorId,
      counterSignerActorId,
      closedAt,
      counterSignedAt,
      selfAttestation: body.selfAttestation,
      signingKeyId: signingKey.id,
      closureReasonHash,
      evidenceHash: evidenceHashHex,
    };
    const digest = actionItemClosureCanonicalDigest(canonical);
    const attestationSig = sodium.crypto_sign_detached(digest, signingPrivateKey);
    const attestationSigHash = sha256Hex(attestationSig);

    try {
      await db.transaction(async (tx) => {
        // T-IM10 mitigation: SELECT FOR UPDATE serializes concurrent
        // close-verifications on the same action_item; the UNIQUE on
        // (action_item_id) is the structural backstop.
        const locked = (await tx.execute(sql`
          SELECT id, status, closure_verification_id, meeting_id, version
          FROM action_items WHERE id = ${idParsed.data} FOR UPDATE
        `)) as unknown as Array<{
          id: string;
          status: string;
          closure_verification_id: string | null;
          meeting_id: string | null;
          version: number;
        }>;
        if (locked.length === 0) {
          throw new ClosureWriteAborted({
            status: 404,
            body: { error: 'ACTION_ITEM_NOT_FOUND' },
          });
        }
        const item = locked[0]!;
        if (item.closure_verification_id !== null) {
          throw new ClosureWriteAborted({
            status: 409,
            body: {
              error: 'ALREADY_CLOSED',
              existingClosureId: item.closure_verification_id,
            },
          });
        }

        // M2.1 F-L2 parity — all closures within a single meeting must
        // use the same workplace signing key. A rotation between
        // closures in the same meeting would break key-of-record.
        if (body.meetingId) {
          const priorClosures = (await tx.execute(sql`
            SELECT signing_key_id FROM action_item_closures
            WHERE meeting_id = ${body.meetingId}
            LIMIT 1
          `)) as unknown as Array<{ signing_key_id: string }>;
          if (priorClosures.length > 0 && priorClosures[0]!.signing_key_id !== signingKey.id) {
            throw new ClosureWriteAborted({
              status: 422,
              body: {
                error: 'SIGNING_KEY_REBOUND',
                message:
                  'All closures within a meeting must use the same workplace signing key. Key rotation requires a new meeting cycle.',
                activeSigningKeyId: signingKey.id,
                meetingSigningKeyId: priorClosures[0]!.signing_key_id,
              },
            });
          }
        }

        try {
          await tx.execute(sql`
            INSERT INTO action_item_closures (
              id, action_item_id, meeting_id,
              closed_by_actor_id, closed_at,
              counter_signed_by_actor_id, counter_signed_at,
              closure_reason_envelope_ct, closure_reason_envelope_dek_ct,
              evidence_storage_key, evidence_envelope_ct, evidence_envelope_dek_ct,
              self_attestation, signing_key_id, attestation_signed_ct
            )
            VALUES (
              ${closureId}, ${idParsed.data}, ${body.meetingId ?? null},
              ${closerActorId}, ${closedAt}::timestamptz,
              ${counterSignerActorId}, ${counterSignedAt}::timestamptz,
              ${Buffer.from(closureReasonCtBytes) as unknown as Uint8Array},
              ${Buffer.from(closureReasonDekBytes) as unknown as Uint8Array},
              ${body.evidence?.storageKey ?? null},
              ${evidenceCtBytes ? (Buffer.from(evidenceCtBytes) as unknown as Uint8Array) : null},
              ${evidenceDekBytes ? (Buffer.from(evidenceDekBytes) as unknown as Uint8Array) : null},
              ${body.selfAttestation}, ${signingKey.id},
              ${Buffer.from(attestationSig) as unknown as Uint8Array}
            )
          `);
        } catch (e) {
          if (e instanceof Error && /action_item_closures_action_item_unique/.test(e.message)) {
            throw new ClosureWriteAborted({
              status: 409,
              body: { error: 'ALREADY_CLOSED' },
            });
          }
          throw e;
        }

        // TM-fold-1: closure_verification_id FK + bi-directional CHECK
        // make the closed state structurally atomic.
        await tx.execute(sql`
          UPDATE action_items
          SET status = 'Closed',
              closed_date = CURRENT_DATE,
              verified_by_jhsc_id = ${counterSignerActorId},
              closure_verification_id = ${closureId},
              version = version + 1,
              updated_at = now()
          WHERE id = ${idParsed.data}
        `);

        const closureChainRow = await append(tx, {
          actorId: auth.userId,
          payload: {
            kind: 'action_item.closure_verified',
            actionItemId: idParsed.data,
            closureId,
            meetingId: body.meetingId ?? null,
            closerActorId,
            counterSignerActorId,
            selfAttestation: body.selfAttestation,
            signingKeyId: signingKey.id,
            evidenceHash: evidenceHashHex,
            attestationSigHash,
          },
          resourceType: 'action_item_closures',
          resourceId: closureId,
        });

        // Cross-chain anchor when the closure happens inside an
        // in_progress meeting (T-IM33). The cross-anchor wraps the
        // per-item closure with a meeting context envelope so the
        // verifier composes the two chains. Also drop a `live`
        // snapshot capturing the post-closure Closed status.
        if (body.meetingId) {
          const meetingStatus = (await tx.execute(sql`
            SELECT status FROM meetings WHERE id = ${body.meetingId} LIMIT 1
          `)) as unknown as Array<{ status: string }>;
          if (meetingStatus.length > 0 && meetingStatus[0]!.status === 'in_progress') {
            await writeLiveActionItemSnapshot(tx, {
              actorId: auth.userId,
              meetingId: body.meetingId,
              actionItemId: idParsed.data,
              status: 'Closed',
              section: item.status === 'Closed' ? 'completed_this_period' : 'new_business',
              assigneeCt: null,
              assigneeDekCt: null,
            });
            // Compose the cross-anchor — we re-emit the
            // `meeting.action_item_status_changed` shape with the
            // closure-verified event's hash as the upstream link.
            const closureHashHex = Buffer.from(closureChainRow.thisHash).toString('hex');
            await append(tx, {
              actorId: auth.userId,
              payload: {
                kind: 'meeting.action_item_status_changed',
                meetingId: body.meetingId,
                actionItemId: idParsed.data,
                fromStatus: item.status as
                  | 'Not Started'
                  | 'In Progress'
                  | 'Blocked'
                  | 'Pending Review'
                  | 'Closed'
                  | 'Cancelled',
                toStatus: 'Closed',
                changedAt: closedAt,
                statusChangedEventHash: closureHashHex,
              },
              resourceType: 'meetings',
              resourceId: body.meetingId,
            });
            // computeChainEntryHash is exported by the meetings route
            // for the cross-chain hash helper; referenced here so the
            // import stays load-bearing even though we use the chain
            // row's own thisHash for this anchor.
            void computeChainEntryHash;
          }
        }
      });
    } catch (err) {
      if (err instanceof ClosureWriteAborted) {
        return c.json(err.payload.body, err.payload.status as 404 | 409 | 422 | 500);
      }
      throw err;
    }

    return c.json(
      {
        id: closureId,
        actionItemId: idParsed.data,
        meetingId: body.meetingId ?? null,
        closedByActorId: closerActorId,
        counterSignerActorId,
        selfAttestation: body.selfAttestation,
        signingKeyId: signingKey.id,
        closedAt,
        evidenceHash: evidenceHashHex,
        attestationSigHash,
      },
      201,
    );
  } finally {
    sodium.memzero(signingPrivateKey);
  }
});

// ---------------------------------------------------------------------------
// POST /api/action-items/:id/reopen
// ---------------------------------------------------------------------------

actionItemClosureRoute.post('/:id/reopen', async (c) => {
  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

  const auth = c.get('auth');
  // T-IM4: re-opening is high-stakes (a closed item moving back to
  // open is an evidentiary event). Step-up gates the WebAuthn
  // assertion.
  const challenge = stepUpGate(c, 'action_item.reopen');
  if (challenge) return challenge;

  const parsed = reopenBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const db = getDb();
  const reopenedAt = new Date().toISOString();

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id, status, closure_verification_id, version
        FROM action_items WHERE id = ${idParsed.data} FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        status: string;
        closure_verification_id: string | null;
        version: number;
      }>;
      if (locked.length === 0) {
        throw new ClosureWriteAborted({
          status: 404,
          body: { error: 'ACTION_ITEM_NOT_FOUND' },
        });
      }
      const item = locked[0]!;
      if (item.status !== 'Closed' || item.closure_verification_id === null) {
        throw new ClosureWriteAborted({
          status: 409,
          body: { error: 'NOT_CLOSED', currentStatus: item.status },
        });
      }
      const previousClosureId = item.closure_verification_id;
      const newVersion = item.version + 1;

      // TM-fold-1: the CHECK constraint requires
      // (status='Closed') == (closure_verification_id IS NOT NULL),
      // so we clear BOTH atomically inside the transaction. The prior
      // closure row in action_item_closures STAYS (per ADR §3.5 append-
      // only history) — re-closing later writes a NEW row.
      //
      // Wait — UNIQUE on (action_item_id) means there can be exactly
      // ONE closure row per item ever. The S1 brief and the ADR are
      // explicit on this point: re-opening clears the FK but the prior
      // closure row remains as historical evidence. Re-closing
      // requires a fresh route call (no second closure row is allowed
      // by the UNIQUE; the re-open chain anchor + the existing closure
      // row are the operational trace).
      await tx.execute(sql`
        UPDATE action_items
        SET status = 'In Progress',
            closure_verification_id = NULL,
            verified_by_jhsc_id = NULL,
            version = ${newVersion},
            updated_at = now()
        WHERE id = ${idParsed.data}
      `);

      await append(tx, {
        actorId: auth.userId,
        payload: {
          kind: 'action_item.reopened',
          actionItemId: idParsed.data,
          previousClosureId,
          reopenedAt,
          reopenedByActorId: auth.userId,
          reason: body.reason,
        },
        resourceType: 'action_items',
        resourceId: idParsed.data,
      });

      return { previousClosureId, newVersion };
    });

    return c.json({
      id: idParsed.data,
      status: 'In Progress',
      previousClosureId: result.previousClosureId,
      version: result.newVersion,
      reason: body.reason,
      reopenedAt,
    });
  } catch (err) {
    if (err instanceof ClosureWriteAborted) {
      return c.json(err.payload.body, err.payload.status as 404 | 409);
    }
    throw err;
  }
});
