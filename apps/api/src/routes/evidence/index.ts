// /api/evidence/* — four routes per ADR-0006.
//
//   POST   /upload-url           — issue presigned PUT for Tigris.
//   POST   /                     — finalize upload, write evidence_files row,
//                                  emit evidence.uploaded into the chain.
//   GET    /?linkedType&linkedId — list evidence for an owning entity
//                                  (metadata only; no ciphertext).
//   GET    /:id/decrypt          — server-side decrypt + stream plaintext.
//                                  Step-up gated; emits evidence.read.
//
// Encryption boundary:
//   - Browser holds the workplace PUBLIC key (shipped via /api/auth/session)
//     and uses crypto_box_seal to wrap the per-file DEK before upload.
//   - Server holds the workplace PRIVATE key sealed under KEK. Opens it
//     ONLY inside the decrypt handler for the lifetime of one response.
//
// Two-step upload keeps the API off the ciphertext data path: the
// multi-MB blob goes browser-direct to Tigris via presigned PUT; the
// finalize call carries only metadata + sealed_dek.

import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import sodium from 'libsodium-wrappers-sumo';
import { append } from '@jhsc/audit';
import {
  evidenceLinkedType,
  evidenceMimeType,
  type EvidenceLinkedType,
  type EvidenceMimeType,
} from '@jhsc/shared-types';
import { getDb } from '../../db/client';
import { authMiddleware, checkStepUpFreshness } from '../../auth/step-up';
import { rateLimit } from '../../middleware/rate-limit';
import {
  fetchEvidenceCiphertext,
  presignEvidenceUpload,
  verifyEvidenceObject,
} from '../../evidence/tigris';
import { getActiveWorkplacePublicKey, openWorkplacePrivateKey } from '../../evidence/workplace-key';

export const evidenceRoute = new Hono();

evidenceRoute.use('*', authMiddleware());
// Same middleware order as 1.6 close-out: rate-limit BEFORE body-limit
// so spammed oversize POSTs still drain the bucket.
evidenceRoute.use('*', rateLimit({ name: 'evidence', capacity: 60, refillPerSecond: 10 }));
// 64KB cap is enough for the metadata POST. Ciphertext goes
// browser-direct to Tigris, NEVER through this route.
evidenceRoute.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  }),
);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MAX_BYTE_SIZE = 50 * 1024 * 1024; // 50 MB — matches the SQL CHECK + bucket policy.
const SHA256_HEX = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 hex chars (SHA-256)');
const B64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be valid base64');

// linkedType the route ACCEPTS in 1.7. Schema allows the full set so a
// future migration can add per-type FK triggers without altering the
// table; the route layer rejects the rest until those tables ship
// (fail-closed forward seam — same pattern as action items priv-AI-F3).
const acceptedLinkedTypes: ReadonlyArray<EvidenceLinkedType> = ['hazard', 'action_item'];

const uploadUrlBody = z
  .object({
    mimeType: z.enum(evidenceMimeType),
    byteSizeEstimate: z.number().int().min(1).max(MAX_BYTE_SIZE),
  })
  .strict();

const finalizeBody = z
  .object({
    storageKey: z.string().min(1).max(256),
    ciphertextSha256: SHA256_HEX,
    sealedDekB64: B64,
    plaintextSha256: SHA256_HEX,
    workplaceKeyId: z.string().uuid(),
    mimeType: z.enum(evidenceMimeType),
    byteSize: z.number().int().min(1).max(MAX_BYTE_SIZE),
    capturedAt: z.string().datetime().optional(),
    gpsLatitude: z.number().min(-90).max(90).optional(),
    gpsLongitude: z.number().min(-180).max(180).optional(),
    gpsAccuracyM: z.number().min(0).max(100000).optional(),
    linkedType: z.enum(evidenceLinkedType),
    linkedId: z.string().uuid(),
  })
  .strict()
  .refine(
    (b) =>
      (b.gpsLatitude === undefined && b.gpsLongitude === undefined) ||
      (b.gpsLatitude !== undefined && b.gpsLongitude !== undefined),
    { message: 'gpsLatitude and gpsLongitude are a pair', path: ['gpsLatitude'] },
  )
  .refine((b) => acceptedLinkedTypes.includes(b.linkedType), {
    message:
      'linkedType not yet supported -- inspection_finding / recommendation / incident land in their owning milestones',
    path: ['linkedType'],
  });

const listQuery = z
  .object({
    linkedType: z.enum(evidenceLinkedType),
    linkedId: z.string().uuid(),
  })
  .strict()
  .refine((b) => acceptedLinkedTypes.includes(b.linkedType), {
    message: 'linkedType not yet supported',
    path: ['linkedType'],
  });

const uuidParam = z.string().uuid();

// ---------------------------------------------------------------------------
// POST /api/evidence/upload-url
// ---------------------------------------------------------------------------

evidenceRoute.post('/upload-url', async (c) => {
  const parsed = uploadUrlBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const db = getDb();
  const workplaceKey = await getActiveWorkplacePublicKey(db);
  if (!workplaceKey) {
    return c.json({ error: 'workplace_key_not_ready' }, 503);
  }
  const storageKey = `evidence/${randomUUID()}/blob`;
  const { uploadUrl, expiresInSeconds } = await presignEvidenceUpload({
    storageKey,
    mimeType: parsed.data.mimeType,
    byteSizeEstimate: parsed.data.byteSizeEstimate,
  });
  return c.json({
    uploadUrl,
    storageKey,
    expiresInSeconds,
    workplaceKeyId: workplaceKey.id,
    workplacePublicKeyB64: Buffer.from(workplaceKey.publicKey).toString('base64'),
  });
});

// ---------------------------------------------------------------------------
// POST /api/evidence — finalize
// ---------------------------------------------------------------------------

evidenceRoute.post('/', async (c) => {
  const parsed = finalizeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const body = parsed.data;
  const db = getDb();

  // Verify the object actually landed in Tigris with the expected size.
  // The route NEVER fetches the ciphertext here; HeadObject is cheap
  // and gives us a tamper-detection point.
  const head = await verifyEvidenceObject({
    storageKey: body.storageKey,
    expectedByteSize: body.byteSize,
  });
  if (!head.exists) {
    return c.json({ error: 'object_missing_or_size_mismatch', byteSize: head.byteSize }, 422);
  }

  // Verify the linked entity exists -- T-E6 backstop. The DB trigger
  // catches a manual SQL bypass; this catches the API path.
  if (body.linkedType === 'hazard') {
    const rows = (await db.execute(
      sql`SELECT 1 FROM hazards WHERE id = ${body.linkedId} LIMIT 1`,
    )) as unknown as Array<unknown>;
    if (rows.length === 0) return c.json({ error: 'linked_entity_not_found' }, 422);
  } else if (body.linkedType === 'action_item') {
    const rows = (await db.execute(
      sql`SELECT 1 FROM action_items WHERE id = ${body.linkedId} LIMIT 1`,
    )) as unknown as Array<unknown>;
    if (rows.length === 0) return c.json({ error: 'linked_entity_not_found' }, 422);
  }

  // sec-F5 close-out: the client tells us which workplaceKeyId it
  // sealed under, but the server re-asserts that's the currently
  // ACTIVE key. Stops a malicious or buggy client from pinning new
  // uploads to a retired (and possibly compromised) key id.
  const activeKey = await getActiveWorkplacePublicKey(db);
  if (!activeKey) {
    return c.json({ error: 'workplace_key_not_ready' }, 503);
  }
  if (body.workplaceKeyId !== activeKey.id) {
    return c.json({ error: 'workplace_key_id_not_active' }, 422);
  }

  // Convert hex SHA-256 inputs to bytea for the DB.
  const ciphertextSha = Buffer.from(body.ciphertextSha256, 'hex');
  const plaintextSha = Buffer.from(body.plaintextSha256, 'hex');
  const sealedDek = Buffer.from(body.sealedDekB64, 'base64');
  // sec-F1 close-out: pre-allocate the evidence row id so the
  // evidence.uploaded chain payload (canonicalised + hashed at append
  // time) carries the real evidenceId, not a zero-UUID placeholder.
  const evidenceId = randomUUID();

  const inserted = await db.transaction(async (tx) => {
    const chainRow = await append(tx, {
      actorId: auth.userId,
      payload: {
        kind: 'evidence.uploaded',
        evidenceId,
        linkedType: body.linkedType,
        linkedId: body.linkedId,
        mimeType: body.mimeType,
        byteSize: body.byteSize,
        plaintextSha256: body.plaintextSha256,
      },
      resourceType: 'evidence_files',
      resourceId: evidenceId,
    });
    const rows = (await tx.execute(sql`
      INSERT INTO evidence_files (
        id, linked_type, linked_id, storage_key,
        ciphertext_sha256, sealed_dek, workplace_key_id, plaintext_sha256,
        mime_type, byte_size,
        captured_at, gps_latitude, gps_longitude, gps_accuracy_m,
        audit_idx, uploaded_by_user_id
      )
      VALUES (
        ${evidenceId},
        ${body.linkedType}, ${body.linkedId}, ${body.storageKey},
        ${ciphertextSha as unknown as Uint8Array},
        ${sealedDek as unknown as Uint8Array},
        ${body.workplaceKeyId},
        ${plaintextSha as unknown as Uint8Array},
        ${body.mimeType}, ${body.byteSize},
        ${body.capturedAt ?? null}, ${body.gpsLatitude ?? null}, ${body.gpsLongitude ?? null}, ${body.gpsAccuracyM ?? null},
        ${chainRow.idx}, ${auth.userId}
      )
      RETURNING id, uploaded_at::text AS uploaded_at
    `)) as unknown as Array<{ id: string; uploaded_at: string }>;
    return rows[0]!;
  });

  return c.json({
    id: inserted.id,
    linkedType: body.linkedType,
    linkedId: body.linkedId,
    uploadedAt: inserted.uploaded_at,
  });
});

// ---------------------------------------------------------------------------
// GET /api/evidence?linkedType=&linkedId=
// ---------------------------------------------------------------------------

evidenceRoute.get('/', async (c) => {
  const parsed = listQuery.safeParse({
    linkedType: c.req.query('linkedType'),
    linkedId: c.req.query('linkedId'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.flatten() }, 400);
  }
  const auth = c.get('auth');
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, mime_type, byte_size,
           captured_at::text AS captured_at,
           gps_latitude::text AS gps_latitude,
           gps_longitude::text AS gps_longitude,
           gps_accuracy_m::text AS gps_accuracy_m,
           uploaded_at::text AS uploaded_at,
           uploaded_by_user_id,
           encode(plaintext_sha256, 'hex') AS plaintext_sha256
    FROM evidence_files
    WHERE linked_type = ${parsed.data.linkedType} AND linked_id = ${parsed.data.linkedId}
    ORDER BY uploaded_at DESC
  `)) as unknown as Array<{
    id: string;
    mime_type: string;
    byte_size: number;
    captured_at: string | null;
    gps_latitude: string | null;
    gps_longitude: string | null;
    gps_accuracy_m: string | null;
    uploaded_at: string;
    uploaded_by_user_id: string;
    plaintext_sha256: string;
  }>;
  // priv-F5 close-out: emit one chain anchor per list call so a
  // session-token theft that can't pass step-up still leaves a trail
  // when bulk-walking GPS/timestamp metadata. Payload is PI-clean
  // (no per-row ids -- only linkedType + linkedId + row count).
  await append(db, {
    actorId: auth.userId,
    payload: {
      kind: 'evidence.list_accessed',
      linkedType: parsed.data.linkedType,
      linkedId: parsed.data.linkedId,
      rowCount: rows.length,
    },
    resourceType: 'evidence_files',
    resourceId: parsed.data.linkedId,
  });

  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      mimeType: r.mime_type as EvidenceMimeType,
      byteSize: Number(r.byte_size),
      capturedAt: r.captured_at,
      gpsLatitude: r.gps_latitude !== null ? Number(r.gps_latitude) : null,
      gpsLongitude: r.gps_longitude !== null ? Number(r.gps_longitude) : null,
      gpsAccuracyM: r.gps_accuracy_m !== null ? Number(r.gps_accuracy_m) : null,
      uploadedAt: r.uploaded_at,
      uploadedByUserId: r.uploaded_by_user_id,
      plaintextSha256: r.plaintext_sha256,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/evidence/:id/decrypt — step-up gated; emits evidence.read
// ---------------------------------------------------------------------------

evidenceRoute.get('/:id/decrypt', async (c) => {
  // sec-F2 close-out: GET /:id/decrypt is state-mutating (writes
  // evidence.read into the chain + materialises plaintext) and the
  // app-wide csrfHeaderGuard short-circuits on safe-method GETs. Same-
  // site phishing tabs cannot fire this via <img src> / <iframe src>
  // without the X-Requested-With header, which the web client sends
  // unconditionally. Curl / API consumers must opt in to the header.
  if (c.req.header('x-requested-with') !== 'jhsc-web') {
    return c.json({ error: 'csrf_required' }, 403);
  }

  const idParsed = uuidParam.safeParse(c.req.param('id'));
  if (!idParsed.success) return c.json({ error: 'invalid_id' }, 400);

  const auth = c.get('auth');
  const challenge = checkStepUpFreshness(auth, {
    action: 'evidence.read',
    maxAgeSeconds: 60,
  });
  if (challenge) {
    c.header(
      'WWW-Authenticate',
      `StepUp realm="jhsc", action="${challenge.action}", max_age="${challenge.maxAgeSeconds}"`,
    );
    return c.json({ error: 'step_up_required', action: challenge.action }, 401);
  }

  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT id, linked_type, linked_id, storage_key, sealed_dek, workplace_key_id,
           ciphertext_sha256, plaintext_sha256, mime_type
    FROM evidence_files WHERE id = ${idParsed.data} LIMIT 1
  `)) as unknown as Array<{
    id: string;
    linked_type: string;
    linked_id: string;
    storage_key: string;
    sealed_dek: Uint8Array;
    workplace_key_id: string;
    ciphertext_sha256: Uint8Array;
    plaintext_sha256: Uint8Array;
    mime_type: string;
  }>;
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  const row = rows[0]!;

  // sec-F3 close-out: re-assert the linkedType is one the route layer
  // accepts. Defense-in-depth against a manual SQL writer or a future
  // migration bug landing a row with an unsupported linked_type.
  if (!acceptedLinkedTypes.includes(row.linked_type as EvidenceLinkedType)) {
    return c.json({ error: 'not_found' }, 404);
  }

  // Fetch the ciphertext from Tigris.
  const ciphertext = await fetchEvidenceCiphertext(row.storage_key);

  // Verify ciphertext SHA-256 matches the stored hash. This catches a
  // bucket-side mutation between finalize and read.
  const observedCiphertextSha = createHash('sha256').update(ciphertext).digest();
  if (!observedCiphertextSha.equals(Buffer.from(row.ciphertext_sha256))) {
    return c.json({ error: 'ciphertext_tamper_detected' }, 500);
  }

  // Open the sealed DEK with the workplace private key, then decrypt
  // the ciphertext with the DEK. Both keys are zeroed before return.
  await sodium.ready;
  const privateKey = await openWorkplacePrivateKey(db, row.workplace_key_id);
  let dek: Uint8Array;
  try {
    // crypto_box_seal_open derives the X25519 public key from the
    // private key, so we don't need to pass it.
    const publicKey = sodium.crypto_scalarmult_base(privateKey);
    dek = sodium.crypto_box_seal_open(Uint8Array.from(row.sealed_dek), publicKey, privateKey);
    sodium.memzero(privateKey);
  } catch (e) {
    sodium.memzero(privateKey);
    throw e;
  }

  let plaintext: Uint8Array;
  try {
    // XChaCha20-Poly1305 ciphertext layout (matches @jhsc/crypto seal v=0x02):
    //   1 version byte || 24 nonce bytes || ciphertext+tag
    if (ciphertext.length < 25 || ciphertext[0] !== 0x02) {
      throw new Error('unexpected ciphertext format');
    }
    const nonce = ciphertext.slice(1, 25);
    const body = ciphertext.slice(25);
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, null, nonce, dek);
  } finally {
    sodium.memzero(dek);
  }

  // Verify plaintext SHA-256 — the integrity anchor. If this fails,
  // either the ciphertext was tampered or the encryption was buggy at
  // upload time. Either way, do not return the bytes.
  const observedPlaintextSha = createHash('sha256').update(plaintext).digest();
  if (!observedPlaintextSha.equals(Buffer.from(row.plaintext_sha256))) {
    return c.json({ error: 'plaintext_tamper_detected' }, 500);
  }

  // Emit evidence.read into the chain BEFORE streaming so the audit
  // anchor is durable even if the client disconnects mid-stream.
  await append(db, {
    actorId: auth.userId,
    payload: {
      kind: 'evidence.read',
      evidenceId: row.id,
      linkedType: row.linked_type as EvidenceLinkedType,
      linkedId: row.linked_id,
    },
    resourceType: 'evidence_files',
    resourceId: row.id,
  });

  // Convert the Uint8Array view into a transferable BodyInit.
  // Slicing into a fresh ArrayBuffer detaches the libsodium-owned
  // memory before the response is sent.
  const body = plaintext.slice().buffer;
  // sec-F6 close-out: PDFs render inline by default and can carry
  // embedded JS that runs at blob: origin. Force every reveal to
  // download via Content-Disposition: attachment AND lock the
  // response down with a strict CSP so even if a viewer were to
  // open the bytes inline the embedded script gets no network
  // egress. priv-F10 close-out: belt-and-suspenders cache headers
  // (pragma + expires + referrer-policy) on the plaintext response.
  const mimeExt = MIME_EXT[row.mime_type] ?? 'bin';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': row.mime_type,
      'content-disposition': `attachment; filename="evidence-${row.id}.${mimeExt}"`,
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store, max-age=0',
      pragma: 'no-cache',
      expires: '0',
      'referrer-policy': 'no-referrer',
      'content-length': String(plaintext.length),
    },
  });
});

// Extension by mime type for the Content-Disposition filename. The
// extension is cosmetic -- the actual bytes are the original ciphertext
// plaintext, mime is set by content-type.
const MIME_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};
