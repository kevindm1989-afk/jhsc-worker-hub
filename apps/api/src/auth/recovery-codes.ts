// Recovery codes — 8 single-use codes generated at TOTP enrollment.
// Plaintext is shown to the user exactly once. The DB stores BLAKE2b
// hashes. Verification uses constant-time compare over the user's
// outstanding codes.

import { blake2bUnkeyed, constantTimeEqual, initCrypto, randomBytes } from './crypto-stub';

const DEFAULT_COUNT = 8;
// 10 alphanumeric chars, A-Z2-7 (Base32-style, no easily-confused
// chars). 32^10 ≈ 2^50 search space per code. With brute-force ladder
// + 8 codes ever, the probability of guessing one in the lockout
// window is negligible.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

export interface GeneratedRecovery {
  /** Show to the user once. Drop from memory after. */
  readonly plaintexts: ReadonlyArray<string>;
  /** Persist to recovery_codes.code_hash. */
  readonly hashes: ReadonlyArray<Uint8Array>;
}

export async function generateRecoveryCodes(
  count: number = DEFAULT_COUNT,
): Promise<GeneratedRecovery> {
  await initCrypto();
  const plaintexts: string[] = [];
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(CODE_LENGTH);
    let s = '';
    for (let j = 0; j < CODE_LENGTH; j++) {
      // Modulo bias: 256 mod 32 = 0, so the distribution is uniform.
      s += ALPHABET[(raw[j] as number) & 31];
    }
    plaintexts.push(s);
    hashes.push(hashRecoveryCode(s));
  }
  return { plaintexts, hashes };
}

export function hashRecoveryCode(code: string): Uint8Array {
  return blake2bUnkeyed(new TextEncoder().encode(normalizeRecoveryCode(code)));
}

// Allow users to type with or without spaces, in any case.
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface RecoveryCandidate {
  readonly id: string;
  readonly hash: Uint8Array;
}

/**
 * Constant-time match an input code against all outstanding recovery
 * codes for a user. Returns the candidate id that matched, or null.
 *
 * "Constant time" here means we ALWAYS hash and compare against every
 * candidate, regardless of an early match — so the response time does
 * not betray "which code slot was the match" or "how many codes the
 * user has left."
 */
export function matchRecoveryCode(
  input: string,
  candidates: ReadonlyArray<RecoveryCandidate>,
): RecoveryCandidate | null {
  const inputHash = hashRecoveryCode(input);
  let found: RecoveryCandidate | null = null;
  for (const c of candidates) {
    const ok = constantTimeEqual(inputHash, c.hash);
    if (ok && found === null) found = c;
  }
  return found;
}

// Format a code for display: ABCDE-FGHJ (5-4 split, no separator-noise
// in the stored form thanks to normalize on input).
export function formatRecoveryCode(plaintext: string): string {
  if (plaintext.length !== CODE_LENGTH) return plaintext;
  return `${plaintext.slice(0, 5)}-${plaintext.slice(5)}`;
}

export const _internals = { ALPHABET, CODE_LENGTH };
