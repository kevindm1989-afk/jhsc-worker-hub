// Password module — Argon2id via libsodium, plus a constant-time decoy
// for the "user does not exist" path so the password endpoint does not
// leak existence by latency.

import { initCrypto, pwhashStr, pwhashStrVerify, pwhashStrNeedsRehash } from './crypto-stub';

// A pre-computed Argon2id hash of a random string. Used as the verify
// target when the supplied identifier does not resolve to a user. The
// verify call still spends ~50 ms before returning false, matching the
// hot path's latency. The string here is the *output* of crypto_pwhash_str
// with the SECURITY.md §3 params, so the verifier won't mark it as
// needing rehash and trigger weird logging.
//
// Generated once at first call, cached forever.
let canaryHashCache: string | null = null;

async function getCanaryHash(): Promise<string> {
  if (canaryHashCache) return canaryHashCache;
  await initCrypto();
  // Hash a high-entropy throwaway. Not a security-critical secret —
  // the point is to spend Argon2id-tier time on the verify path.
  canaryHashCache = await pwhashStr(
    'canary:' + Math.random().toString(36) + Date.now().toString(36),
  );
  return canaryHashCache;
}

export interface PasswordHashResult {
  /** Algorithm-encoded hash, suitable for direct insert into password_credentials.hash. */
  readonly hash: string;
}

export async function hashPassword(plaintext: string): Promise<PasswordHashResult> {
  if (plaintext.length === 0) {
    throw new Error('hashPassword: empty plaintext');
  }
  await initCrypto();
  const hash = await pwhashStr(plaintext);
  return { hash };
}

export interface VerifyPasswordResult {
  readonly ok: boolean;
  /** True when the stored hash uses weaker params than current targets; caller should re-hash on success. */
  readonly needsRehash: boolean;
}

export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<VerifyPasswordResult> {
  await initCrypto();
  const ok = await pwhashStrVerify(hash, plaintext);
  const needsRehash = ok ? pwhashStrNeedsRehash(hash) : false;
  return { ok, needsRehash };
}

// Returns false after spending the same time as a real verify would. Use
// this in the "no such user" branch of the password endpoint so the
// response latency does not distinguish missing users from wrong
// passwords.
export async function verifyAgainstCanary(plaintext: string): Promise<false> {
  await initCrypto();
  const canary = await getCanaryHash();
  // Run the verify for its side-effect (latency). Result is always
  // ignored — even on the astronomically unlikely match, we return false.
  await pwhashStrVerify(canary, plaintext);
  return false;
}

// Test-only — reset the cached canary.
export function _resetCanaryForTests(): void {
  canaryHashCache = null;
}
