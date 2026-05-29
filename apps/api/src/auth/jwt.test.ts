import { beforeAll, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests, signAccessToken, verifyAccessToken } from './jwt';
import { bootAuthTestEnv } from './test-setup';

beforeAll(async () => {
  await bootAuthTestEnv();
  _resetKeyCacheForTests();
});

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips claims', async () => {
    const jwt = await signAccessToken({
      sub: 'u-1',
      sid: 's-1',
      stepUpUntil: null,
    });
    const claims = await verifyAccessToken(jwt);
    expect(claims?.sub).toBe('u-1');
    expect(claims?.sid).toBe('s-1');
    expect(claims?.stepUpUntil).toBeNull();
    expect(claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('carries step_up_until when set', async () => {
    const target = Math.floor(Date.now() / 1000) + 60;
    const jwt = await signAccessToken({ sub: 'u-2', sid: 's-2', stepUpUntil: target });
    const claims = await verifyAccessToken(jwt);
    expect(claims?.stepUpUntil).toBe(target);
  });

  it('returns null for a tampered token', async () => {
    const jwt = await signAccessToken({ sub: 'u-3', sid: 's-3', stepUpUntil: null });
    // Flip one character mid-payload to break the signature.
    const parts = jwt.split('.');
    const tampered = `${parts[0]}.${parts[1]}A.${parts[2]}`;
    expect(await verifyAccessToken(tampered)).toBeNull();
  });

  it('returns null for a non-JWT string', async () => {
    expect(await verifyAccessToken('not.a.jwt')).toBeNull();
    expect(await verifyAccessToken('')).toBeNull();
  });
});
