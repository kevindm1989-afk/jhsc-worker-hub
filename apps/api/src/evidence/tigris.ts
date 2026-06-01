// Tigris (S3-compatible) adapter — thin wrapper around @aws-sdk/client-s3
// + @aws-sdk/s3-request-presigner.
//
// The route layer NEVER touches the AWS SDK directly. All Tigris
// interactions flow through this file so the integration boundary is
// one file (matching the @jhsc/crypto + apps/api/src/hazards/crypto.ts
// + apps/api/src/action-items/crypto.ts pattern).

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireTigrisEnv } from '../env';

let clientCache: S3Client | null = null;

function getClient(): S3Client {
  if (clientCache) return clientCache;
  const env = requireTigrisEnv();
  clientCache = new S3Client({
    region: env.TIGRIS_REGION,
    endpoint: env.TIGRIS_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.TIGRIS_ACCESS_KEY_ID,
      secretAccessKey: env.TIGRIS_SECRET_ACCESS_KEY,
    },
  });
  return clientCache;
}

/**
 * Generate a presigned PUT URL for the browser to upload directly to
 * Tigris. 5-minute expiry per ADR-0006. The storageKey is namespaced
 * under `evidence/` so a future redaction sweep can scope its delete.
 */
export async function presignEvidenceUpload(opts: {
  storageKey: string;
  mimeType: string;
  byteSizeEstimate: number;
}): Promise<{ uploadUrl: string; expiresInSeconds: number }> {
  const env = requireTigrisEnv();
  const expiresInSeconds = 5 * 60;
  const cmd = new PutObjectCommand({
    Bucket: env.TIGRIS_BUCKET,
    Key: opts.storageKey,
    ContentType: opts.mimeType,
    ContentLength: opts.byteSizeEstimate,
  });
  const url = await getSignedUrl(getClient(), cmd, { expiresIn: expiresInSeconds });
  return { uploadUrl: url, expiresInSeconds };
}

/**
 * After the browser POSTs the finalize metadata, the API verifies the
 * object actually landed in Tigris with the expected SHA-256. This
 * closes the race where a presigned URL is issued but the upload
 * never completes (or completes with different bytes).
 */
export async function verifyEvidenceObject(opts: {
  storageKey: string;
  expectedByteSize: number;
}): Promise<{ exists: boolean; byteSize: number | null }> {
  const env = requireTigrisEnv();
  try {
    const res = await getClient().send(
      new HeadObjectCommand({ Bucket: env.TIGRIS_BUCKET, Key: opts.storageKey }),
    );
    const size = res.ContentLength ?? null;
    return { exists: size === opts.expectedByteSize, byteSize: size };
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'NotFound') {
      return { exists: false, byteSize: null };
    }
    throw e;
  }
}

/**
 * Fetch a ciphertext blob from Tigris for server-side decrypt. Streams
 * the bytes into memory; caller wraps with the sealed-DEK open and
 * returns plaintext.
 */
export async function fetchEvidenceCiphertext(storageKey: string): Promise<Uint8Array> {
  const env = requireTigrisEnv();
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: env.TIGRIS_BUCKET, Key: storageKey }),
  );
  const body = res.Body;
  if (!body || !('transformToByteArray' in body)) {
    throw new Error(`Tigris GET for ${storageKey} returned no body`);
  }
  // transformToByteArray is the recommended path for binary blobs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (body as any).transformToByteArray();
}

/**
 * Server-side direct PUT to Tigris. Used by the inspection export route
 * (S4) where the API already holds the final bytes in process memory
 * (rendered PDF) and has no reason to round-trip through a presigned
 * browser upload. The evidence route's two-step `presignEvidenceUpload`
 * + browser-direct PUT path is preserved for the original upload flow.
 *
 * The caller is expected to have already hashed the bytes for the
 * `output_sha256` chain anchor + DB row. This helper does NOT hash —
 * keeping the function single-purpose so the caller controls when the
 * hash is bound to the plaintext buffer.
 *
 * **Server-Side Encryption (priv-F1 / T-I40 close-out).** Every PUT
 * carries `ServerSideEncryption: 'AES256'` so Tigris stores the bytes
 * encrypted at rest. ADR-0007 §3.9 pledged SSE; pre-S5 the parameter
 * was unset and Tigris stored the rendered PDFs as plaintext. `AES256`
 * is the safe S3-compatible default; a future migration may swap to
 * `aws:kms` if/when a KMS key is provisioned for the bucket (runbook
 * docs/runbooks/inspections.md §8 flags this as ops follow-up).
 */
export async function putEvidenceObject(opts: {
  storageKey: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<void> {
  const env = requireTigrisEnv();
  await getClient().send(buildPutObjectCommand(env.TIGRIS_BUCKET, opts));
}

/**
 * Internal helper: build the PutObjectCommand with the SSE parameter
 * applied. Extracted so the unit test can assert the parameter set
 * without booting Tigris (priv-F1 close-out).
 */
export function buildPutObjectCommand(
  bucket: string,
  opts: { storageKey: string; bytes: Uint8Array; mimeType: string },
): PutObjectCommand {
  return new PutObjectCommand({
    Bucket: bucket,
    Key: opts.storageKey,
    ContentType: opts.mimeType,
    ContentLength: opts.bytes.length,
    Body: Buffer.from(opts.bytes),
    // priv-F1 / T-I40: AES256 SSE on every server-side PUT. The PDF
    // is decrypted-equivalent at this point (the export bytes ARE the
    // plaintext exhibit); without SSE Tigris would hold cleartext.
    ServerSideEncryption: 'AES256',
  });
}

/**
 * Best-effort DELETE against a Tigris object. Used by the export route
 * (sec-F6 / T-I42 close-out) to clean up orphan PDFs when the DB
 * transaction rolls back AFTER a successful PUT. Caller wraps this in a
 * try/catch and logs the outcome at warn level; the function itself
 * never throws so the original transaction error can be re-raised.
 */
export async function deleteEvidenceObject(storageKey: string): Promise<{ ok: boolean }> {
  const env = requireTigrisEnv();
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: env.TIGRIS_BUCKET, Key: storageKey }));
    return { ok: true };
  } catch {
    // Best-effort: a NoSuchKey or transient network failure here is not
    // fatal — the caller's chain anchor never landed, so there is no
    // audit-trail mismatch. The orphan-sweep follow-up in the runbook
    // covers anything missed.
    return { ok: false };
  }
}

/** Test-only: drop the cached client. */
export function _resetTigrisClientForTests(): void {
  clientCache = null;
}
