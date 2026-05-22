// Workplace X25519 key pair lifecycle (ADR-0006).
//
// Generated once at first-run, stored in workplace_keys. Public key
// ships to the browser per session; private key stays sealed under the
// workplace KEK and is opened only inside the evidence decrypt path.
//
// At most one workplace_keys row is active=true at a time (enforced by
// the partial UNIQUE INDEX in migration 0006). Rotation is a 1.12
// hardening line item; until then, the active key pair is effectively
// permanent.

import { sql } from 'drizzle-orm';
import sodium from 'libsodium-wrappers-sumo';
import { sealWithEnvelope, openWithEnvelope } from '@jhsc/crypto';
import { getMasterKey } from '../auth/crypto-stub';
import type { DrizzlePg } from '@jhsc/audit';

export interface WorkplaceKeyMaterial {
  /** UUID of the workplace_keys row. */
  readonly id: string;
  /** 32-byte X25519 public key. */
  readonly publicKey: Uint8Array;
}

/**
 * Bootstrap the workplace key pair if none exists. Idempotent: if an
 * active row is already present, returns it unchanged.
 *
 * Called from the first-run confirm handler so the workplace public
 * key is available immediately after the JHSC is set up.
 */
export async function ensureWorkplaceKey(tx: DrizzlePg): Promise<WorkplaceKeyMaterial> {
  // sodium.ready is awaited inside @jhsc/crypto's seal helpers; we don't
  // need an explicit await here because sealWithEnvelope checks for us.
  // But crypto_box_keypair() is sodium-direct, so we have to wait.
  await sodium.ready;

  const existing = (await tx.execute(sql`
    SELECT id, public_key FROM workplace_keys WHERE active = true LIMIT 1
  `)) as unknown as Array<{ id: string; public_key: Uint8Array }>;
  if (existing[0]) {
    return { id: existing[0].id, publicKey: Uint8Array.from(existing[0].public_key) };
  }

  const keyPair = sodium.crypto_box_keypair();
  const sealed = sealWithEnvelope(keyPair.privateKey, getMasterKey());

  const inserted = (await tx.execute(sql`
    INSERT INTO workplace_keys (active, public_key, private_key_ct, private_key_dek_ct)
    VALUES (
      true,
      ${Buffer.from(keyPair.publicKey) as unknown as Uint8Array},
      ${Buffer.from(sealed.ciphertext) as unknown as Uint8Array},
      ${Buffer.from(sealed.dekSealed) as unknown as Uint8Array}
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  sodium.memzero(keyPair.privateKey);
  return { id: inserted[0]!.id, publicKey: keyPair.publicKey };
}

/**
 * Returns the currently active workplace public key. Public — safe to
 * ship to the browser. Cached per process for the lifetime of the row.
 */
let publicKeyCache: WorkplaceKeyMaterial | null = null;

export async function getActiveWorkplacePublicKey(
  db: DrizzlePg,
): Promise<WorkplaceKeyMaterial | null> {
  if (publicKeyCache) return publicKeyCache;
  const rows = (await db.execute(sql`
    SELECT id, public_key FROM workplace_keys WHERE active = true LIMIT 1
  `)) as unknown as Array<{ id: string; public_key: Uint8Array }>;
  if (!rows[0]) return null;
  publicKeyCache = { id: rows[0].id, publicKey: Uint8Array.from(rows[0].public_key) };
  return publicKeyCache;
}

/**
 * Open the workplace private key for one decrypt operation. The
 * caller MUST call sodium.memzero on the returned key after use. This
 * is the ONLY path that exposes the workplace private key in process
 * memory; the function intentionally does NOT cache.
 */
export async function openWorkplacePrivateKey(
  db: DrizzlePg,
  workplaceKeyId: string,
): Promise<Uint8Array> {
  await sodium.ready;
  const rows = (await db.execute(sql`
    SELECT private_key_ct, private_key_dek_ct
    FROM workplace_keys WHERE id = ${workplaceKeyId}
  `)) as unknown as Array<{ private_key_ct: Uint8Array; private_key_dek_ct: Uint8Array }>;
  if (!rows[0]) {
    throw new Error(`workplace_keys row ${workplaceKeyId} not found`);
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

/** Test-only: clear the public-key cache so tests pick up freshly bootstrapped keys. */
export function _resetWorkplaceKeyCacheForTests(): void {
  publicKeyCache = null;
}
