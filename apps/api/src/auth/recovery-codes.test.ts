import { beforeAll, describe, expect, it } from 'vitest';
import {
  _internals,
  formatRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchRecoveryCode,
  normalizeRecoveryCode,
} from './recovery-codes';
import { bootAuthTestEnv } from './test-setup';

beforeAll(async () => {
  await bootAuthTestEnv();
});

describe('generateRecoveryCodes', () => {
  it('emits 8 codes by default', async () => {
    const { plaintexts, hashes } = await generateRecoveryCodes();
    expect(plaintexts.length).toBe(8);
    expect(hashes.length).toBe(8);
  });

  it('every code is the configured length, alphabet-only', async () => {
    const { plaintexts } = await generateRecoveryCodes();
    for (const code of plaintexts) {
      expect(code.length).toBe(_internals.CODE_LENGTH);
      for (const ch of code) {
        expect(_internals.ALPHABET).toContain(ch);
      }
    }
  });

  it('generates distinct plaintexts (overwhelming probability)', async () => {
    const { plaintexts } = await generateRecoveryCodes();
    expect(new Set(plaintexts).size).toBe(plaintexts.length);
  });

  it('hash and plaintext correspond — round-trip via hashRecoveryCode', async () => {
    const { plaintexts, hashes } = await generateRecoveryCodes();
    for (let i = 0; i < plaintexts.length; i++) {
      expect(hashRecoveryCode(plaintexts[i]!)).toEqual(hashes[i]);
    }
  });
});

describe('normalizeRecoveryCode', () => {
  it('strips spaces, dashes, and lowercases', () => {
    expect(normalizeRecoveryCode('ab-cd ef-gh')).toBe('ABCDEFGH');
  });

  it('discards punctuation', () => {
    expect(normalizeRecoveryCode('abcd.efgh!')).toBe('ABCDEFGH');
  });
});

describe('matchRecoveryCode', () => {
  it('returns the matching candidate', async () => {
    const { plaintexts, hashes } = await generateRecoveryCodes();
    const candidates = plaintexts.map((_, i) => ({ id: `c-${i}`, hash: hashes[i]! }));
    const probe = plaintexts[3]!;
    const match = matchRecoveryCode(probe, candidates);
    expect(match?.id).toBe('c-3');
  });

  it('accepts hyphenated user input (normalization)', async () => {
    const { plaintexts, hashes } = await generateRecoveryCodes();
    const candidates = plaintexts.map((_, i) => ({ id: `c-${i}`, hash: hashes[i]! }));
    const probe = formatRecoveryCode(plaintexts[5]!); // adds dash
    const match = matchRecoveryCode(probe, candidates);
    expect(match?.id).toBe('c-5');
  });

  it('returns null for a non-matching input', async () => {
    const { plaintexts, hashes } = await generateRecoveryCodes();
    const candidates = plaintexts.map((_, i) => ({ id: `c-${i}`, hash: hashes[i]! }));
    expect(matchRecoveryCode('XXXXXYYYYY', candidates)).toBeNull();
  });
});

describe('formatRecoveryCode', () => {
  it('inserts a hyphen mid-code', () => {
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });

  it('leaves wrong-length input unchanged', () => {
    expect(formatRecoveryCode('TOO_SHORT')).toBe('TOO_SHORT');
  });
});
