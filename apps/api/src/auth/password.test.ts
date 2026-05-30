import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstCanary, verifyPassword } from './password';
import { bootAuthTestEnv } from './test-setup';

beforeAll(async () => {
  await bootAuthTestEnv();
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const { hash } = await hashPassword('SafeP@ssword!123');
    const r = await verifyPassword('SafeP@ssword!123', hash);
    expect(r.ok).toBe(true);
    expect(r.needsRehash).toBe(false);
  });

  it('rejects a wrong password', async () => {
    const { hash } = await hashPassword('SafeP@ssword!123');
    const r = await verifyPassword('NotTheRightOne', hash);
    expect(r.ok).toBe(false);
  });

  it('rejects empty plaintext at the boundary', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });

  it('two hashes of the same plaintext differ (random salt)', async () => {
    const a = await hashPassword('SafeP@ssword!123');
    const b = await hashPassword('SafeP@ssword!123');
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('verifyAgainstCanary', () => {
  it('always returns false', async () => {
    const r = await verifyAgainstCanary('anything');
    expect(r).toBe(false);
  });
});
