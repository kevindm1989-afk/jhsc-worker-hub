// Workplace Ed25519 signing keypair lifecycle (ADR-0008 §3.7).
//
// Separate primitive from the X25519 workplace_keys (1.7) per ADR §3.7:
//   - Ed25519 for crypto_sign_detached (signed-PDF export).
//   - Different rotation semantics (retired keys stay queryable
//     forever so past signatures keep verifying).
//   - Different operational risk surface (leaked private signing key
//     enables forgery of past-dated PDFs; leaked encryption key
//     compromises confidentiality only).
//
// At most one workplace_signing_keys row is active=true at a time
// (enforced by the partial UNIQUE INDEX in migration 0008 — T-R19).
// Rotation is a 1.12 hardening line item; until then, the active key
// is effectively permanent.
//
// SCOPE OF THIS MODULE (S1):
//   - ensureWorkplaceSigningKey: idempotent seed (S2 wires it into
//     first-run-confirm).
//   - getActiveWorkplaceSigningPublicKey: cached public-key lookup
//     (S2 ships it via the session response; S3 surfaces the
//     fingerprint in the export-detail view).
//   - openWorkplaceSigningPrivateKey: one-shot decrypt path (S4 uses
//     it inside the recommendation-export route's bounded plaintext
//     window).
//   - _invalidateWorkplaceSigningKeyCache: rotation + test helper.
//
// The signing helper itself (sodium.crypto_sign_detached over the PDF
// bytes) is NOT in this file — it lives in the S4
// apps/api/src/recommendations/signing.ts module so the seal/open
// surface stays narrow.

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import sodium from 'libsodium-wrappers-sumo';
import { sealWithEnvelope, openWithEnvelope } from '@jhsc/crypto';
import { append, type DrizzlePg } from '@jhsc/audit';
import type { WorkplaceSigningKeyAlgorithm } from '@jhsc/shared-types';
import { getMasterKey } from '../auth/crypto-stub';

export interface WorkplaceSigningKeyMaterial {
  /** UUID of the workplace_signing_keys row. */
  readonly id: string;
  /** 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
  readonly algorithm: WorkplaceSigningKeyAlgorithm;
}

/**
 * Bootstrap the workplace signing keypair if none exists. Idempotent:
 * if an active row is already present, returns it unchanged. Emits
 * an `audit.workplace_signing_key.seeded` chain anchor on first insert
 * (PI-clean: {signingKeyId, algorithm, publicKeySha256}).
 *
 * S2 wires this into the first-run-confirm handler so the public
 * signing key is available immediately after the JHSC is set up. S1
 * lands the function but leaves the route-layer wiring as a TODO so
 * the slice stays scoped.
 *
 * TODO(S2): call from apps/api/src/routes/auth/first-run.ts confirm
 * handler alongside ensureWorkplaceKey().
 */
export async function ensureWorkplaceSigningKey(
  tx: DrizzlePg,
): Promise<WorkplaceSigningKeyMaterial> {
  await sodium.ready;

  const existing = (await tx.execute(sql`
    SELECT id, algorithm, public_key FROM workplace_signing_keys WHERE active = true LIMIT 1
  `)) as unknown as Array<{ id: string; algorithm: string; public_key: Uint8Array }>;
  if (existing[0]) {
    return {
      id: existing[0].id,
      algorithm: existing[0].algorithm as WorkplaceSigningKeyAlgorithm,
      publicKey: Uint8Array.from(existing[0].public_key),
    };
  }

  // Ed25519 keypair: publicKey is 32 bytes, privateKey is 64 bytes
  // (the libsodium-format private key carries the seed + public key,
  // which crypto_sign_detached consumes directly).
  const keyPair = sodium.crypto_sign_keypair();
  const sealed = sealWithEnvelope(keyPair.privateKey, getMasterKey());

  const inserted = (await tx.execute(sql`
    INSERT INTO workplace_signing_keys (algorithm, active, public_key, private_key_ct, private_key_dek_ct)
    VALUES (
      'ed25519',
      true,
      ${Buffer.from(keyPair.publicKey) as unknown as Uint8Array},
      ${Buffer.from(sealed.ciphertext) as unknown as Uint8Array},
      ${Buffer.from(sealed.dekSealed) as unknown as Uint8Array}
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const signingKeyId = inserted[0]!.id;

  const publicKeySha256 = createHash('sha256').update(keyPair.publicKey).digest('hex');

  await append(tx, {
    payload: {
      kind: 'audit.workplace_signing_key.seeded',
      signingKeyId,
      algorithm: 'ed25519',
      publicKeySha256,
    },
    resourceType: 'workplace_signing_keys',
    resourceId: signingKeyId,
  });

  sodium.memzero(keyPair.privateKey);
  return { id: signingKeyId, algorithm: 'ed25519', publicKey: keyPair.publicKey };
}

/**
 * Returns the currently active workplace signing public key. Public —
 * safe to ship to the browser per session (the verifier needs it to
 * confirm `crypto_sign_verify_detached(sig, pdfBytes, publicKey)`).
 * Cached per process for the lifetime of the row; rotation invalidates
 * via _invalidateWorkplaceSigningKeyCache().
 */
let publicSigningKeyCache: WorkplaceSigningKeyMaterial | null = null;

export async function getActiveWorkplaceSigningPublicKey(
  db: DrizzlePg,
): Promise<WorkplaceSigningKeyMaterial | null> {
  if (publicSigningKeyCache) return publicSigningKeyCache;
  const rows = (await db.execute(sql`
    SELECT id, algorithm, public_key FROM workplace_signing_keys WHERE active = true LIMIT 1
  `)) as unknown as Array<{ id: string; algorithm: string; public_key: Uint8Array }>;
  if (!rows[0]) return null;
  publicSigningKeyCache = {
    id: rows[0].id,
    algorithm: rows[0].algorithm as WorkplaceSigningKeyAlgorithm,
    publicKey: Uint8Array.from(rows[0].public_key),
  };
  return publicSigningKeyCache;
}

/**
 * Open the workplace signing private key for one sign operation. The
 * caller MUST call sodium.memzero on the returned key after use. This
 * is the ONLY path that exposes the workplace signing private key in
 * process memory; the function intentionally does NOT cache. Mirrors
 * openWorkplacePrivateKey (1.7).
 *
 * Looks up by id (not by active=true) because past exports may need
 * to sign-verify against a retired key during the rotation window;
 * the call site (S4) knows which signing_key_id to open.
 */
export async function openWorkplaceSigningPrivateKey(
  db: DrizzlePg,
  signingKeyId: string,
): Promise<Uint8Array> {
  await sodium.ready;
  const rows = (await db.execute(sql`
    SELECT private_key_ct, private_key_dek_ct
    FROM workplace_signing_keys WHERE id = ${signingKeyId}
  `)) as unknown as Array<{ private_key_ct: Uint8Array; private_key_dek_ct: Uint8Array }>;
  if (!rows[0]) {
    throw new Error(`workplace_signing_keys row ${signingKeyId} not found`);
  }
  const opened = openWithEnvelope(
    {
      ciphertext: Uint8Array.from(rows[0].private_key_ct),
      dekSealed: Uint8Array.from(rows[0].private_key_dek_ct),
    },
    getMasterKey(),
  );
  return opened;
}

/**
 * Invalidate the in-process public-key cache. Used by the test
 * harness AND by the future workplace-signing-key rotation script
 * (1.12) so the next SELECT picks up the newly-active row instead of
 * a stale cache. Multi-machine deploys still need a deploy-level
 * invalidation. Mirror of _invalidateWorkplaceKeyCache from
 * workplace-key.ts.
 */
export function _invalidateWorkplaceSigningKeyCache(): void {
  publicSigningKeyCache = null;
}
