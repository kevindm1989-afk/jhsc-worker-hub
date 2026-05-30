import { beforeAll, describe, expect, it } from 'vitest';
import { _internals, generateTotpSecret, totpKeyUri, verifyTotp } from './totp';
import { bootAuthTestEnv } from './test-setup';

beforeAll(async () => {
  await bootAuthTestEnv();
});

// A deterministic 20-byte secret so the codes are stable across test runs.
const SECRET = new Uint8Array([
  0x3d, 0xc6, 0xca, 0xa4, 0x82, 0x4a, 0x6d, 0x28, 0x87, 0x67, 0xb2, 0x33, 0x1e, 0x20, 0xb4, 0x31,
  0xcf, 0x03, 0x71, 0x6e,
]);

function codeAt(step: number): string {
  return _internals.hotpForStep(SECRET, step);
}

describe('generateTotpSecret', () => {
  it('returns 20 bytes', async () => {
    const s = await generateTotpSecret();
    expect(s.length).toBe(_internals.SECRET_BYTES);
  });
});

describe('totpKeyUri', () => {
  it('builds an otpauth URI with our params', () => {
    const uri = totpKeyUri(SECRET, 'alice@workplace.invalid', 'JHSC');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=JHSC');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('verifyTotp', () => {
  const stepNow = 1_700_000_000; // arbitrary step number
  const nowMs = stepNow * _internals.PERIOD_SECONDS * 1000;

  it('accepts the current-step code', () => {
    const code = codeAt(stepNow);
    const r = verifyTotp(code, SECRET, 0, nowMs);
    expect(r).toEqual({ ok: true, step: stepNow });
  });

  it('accepts the previous-step code (skew tolerance)', () => {
    const code = codeAt(stepNow - 1);
    const r = verifyTotp(code, SECRET, 0, nowMs);
    expect(r).toEqual({ ok: true, step: stepNow - 1 });
  });

  it('rejects the future-step code (no forward skew)', () => {
    const code = codeAt(stepNow + 1);
    const r = verifyTotp(code, SECRET, 0, nowMs);
    expect(r.ok).toBe(false);
  });

  it('rejects replay of a previously-used step', () => {
    const code = codeAt(stepNow - 1);
    // Already used step N-1; reusing the same code MUST fail.
    const r = verifyTotp(code, SECRET, stepNow - 1, nowMs);
    expect(r.ok).toBe(false);
  });

  it('rejects when current step is already consumed (replay)', () => {
    const code = codeAt(stepNow);
    const r = verifyTotp(code, SECRET, stepNow, nowMs);
    expect(r.ok).toBe(false);
  });

  it('rejects non-numeric / wrong-length codes', () => {
    expect(verifyTotp('abcdef', SECRET, 0, nowMs).ok).toBe(false);
    expect(verifyTotp('12345', SECRET, 0, nowMs).ok).toBe(false);
    expect(verifyTotp('1234567', SECRET, 0, nowMs).ok).toBe(false);
    expect(verifyTotp('', SECRET, 0, nowMs).ok).toBe(false);
  });

  it('rejects a wrong code', () => {
    const wrong = codeAt(stepNow + 999); // a code from far away
    const r = verifyTotp(wrong, SECRET, 0, nowMs);
    expect(r.ok).toBe(false);
  });
});
