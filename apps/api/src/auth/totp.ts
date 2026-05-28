// TOTP module (RFC 6238) — wraps @oslojs primitives with the
// replay-protection layer ADR-0001 specifies. We track `lastUsedStep`
// per user so a code that matched at step N cannot be reused even
// inside the ±1-step skew window we accept.
//
// @oslojs/otp doesn't expose a step-indexed TOTP generator (its API
// takes a key + interval and reads Date.now() internally), so we
// implement HOTP per-step directly using its HMAC + SHA-1 primitives.
// TOTP = HOTP at counter = floor(time / period) (RFC 6238 §4.2).

import { hmac } from '@oslojs/crypto/hmac';
import { SHA1 } from '@oslojs/crypto/sha1';
import { createTOTPKeyURI } from '@oslojs/otp';
import { initCrypto, randomBytes } from './crypto-stub';

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // RFC 6238 — 160-bit shared secret with SHA-1 HMAC.

export async function generateTotpSecret(): Promise<Uint8Array> {
  await initCrypto();
  return randomBytes(SECRET_BYTES);
}

export function totpKeyUri(secret: Uint8Array, accountName: string, issuer: string): string {
  return createTOTPKeyURI(issuer, accountName, secret, PERIOD_SECONDS, DIGITS);
}

export type TotpVerifyResult =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false };

function currentStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function hotpForStep(secret: Uint8Array, counter: number): string {
  const counterBytes = new Uint8Array(8);
  // Big-endian 64-bit counter. JS numbers are safe up to 2^53; our step
  // is `time/30 < 2^32`, so the high 4 bytes stay zero.
  const view = new DataView(counterBytes.buffer);
  view.setUint32(0, 0);
  view.setUint32(4, counter);
  const mac = hmac(SHA1, secret, counterBytes);
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const truncated =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return (truncated % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * Verify a TOTP code with one-step backward skew tolerance.
 *
 * - Tries step N (current) and step N-1.
 * - Constant-time-compares against each.
 * - Returns the matched step number; caller persists it as
 *   `last_used_step` to block replay inside the skew window.
 * - Rejects codes whose matched step is ≤ `lastUsedStep` (replay).
 * - We deliberately do NOT accept step N+1 — a future code only exists
 *   on a forward-skewed device clock, which an attacker can manipulate;
 *   rejecting future codes denies them that attack surface.
 */
export function verifyTotp(
  code: string,
  secret: Uint8Array,
  lastUsedStep: number,
  nowMs: number = Date.now(),
): TotpVerifyResult {
  if (!/^[0-9]{6}$/.test(code)) {
    return { ok: false };
  }
  const current = currentStep(nowMs);
  // Try current first to keep the common path fast. Both candidates run
  // their compares unconditionally below so latency does not betray which
  // step matched.
  const candidates: ReadonlyArray<number> = [current, current - 1];
  let matchedStep = -1;
  for (const step of candidates) {
    if (step <= lastUsedStep) continue;
    const expected = hotpForStep(secret, step);
    const ok = constantTimeStringEqual(code, expected);
    if (ok && matchedStep === -1) matchedStep = step;
  }
  if (matchedStep === -1) return { ok: false };
  return { ok: true, step: matchedStep };
}

export const _internals = {
  hotpForStep,
  currentStep,
  PERIOD_SECONDS,
  DIGITS,
  SECRET_BYTES,
};
