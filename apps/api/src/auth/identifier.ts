// Email identifier helpers.
//
// We normalize email at intake (trim + lowercase) so users typing
// "Alice@Workplace.invalid" vs "alice@workplace.invalid" still hit the
// same row. The lookup key is BLAKE2b keyed with MASTER_KEY (not raw
// email) so the DB cannot enumerate users from a passive read.

import { emailLookupHash as masterKeyedHash, initCrypto } from './crypto-stub';

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export async function lookupHashForEmail(email: string): Promise<Uint8Array> {
  await initCrypto();
  return masterKeyedHash(normalizeEmail(email));
}

// For the lockout module: we want to count attempts against an
// identifier hash, but pre-auth attempts have no userId. The same
// keyed-BLAKE2b on the normalized email serves both keys.
export async function lockoutIdentifierForEmail(email: string): Promise<Uint8Array> {
  return lookupHashForEmail(email);
}
