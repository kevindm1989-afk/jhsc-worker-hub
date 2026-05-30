import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests, signAccessToken, verifyAccessToken } from './jwt';
import { bootAuthTestEnv } from './test-setup';

beforeAll(async () => {
  await bootAuthTestEnv();
  _resetKeyCacheForTests();
});

function makeEd25519Pair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

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

describe('multi-kid registry (security-reviewer F6)', () => {
  it('accepts a token signed under K1 after K2 is provisioned and active', async () => {
    // Provision a second kid alongside the existing one.
    const k1 = makeEd25519Pair();
    const k2 = makeEd25519Pair();
    process.env.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1 = k1.priv;
    process.env.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K1 = k1.pub;
    process.env.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K2 = k2.priv;
    process.env.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K2 = k2.pub;
    process.env.AUTH_JWT_ACTIVE_KID = 'k1';
    _resetKeyCacheForTests();
    const k1Token = await signAccessToken({ sub: 'u-k1', sid: 's-k1', stepUpUntil: null });

    // Rotate issuer to k2; k1 tokens MUST still verify.
    process.env.AUTH_JWT_ACTIVE_KID = 'k2';
    _resetKeyCacheForTests();
    const claimsAfterRotation = await verifyAccessToken(k1Token);
    expect(claimsAfterRotation?.sub).toBe('u-k1');

    // A token freshly signed after the rotation carries kid=k2.
    const k2Token = await signAccessToken({ sub: 'u-k2', sid: 's-k2', stepUpUntil: null });
    expect((await verifyAccessToken(k2Token))?.sub).toBe('u-k2');

    // Reset to a known state for the next tests.
    delete process.env.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K2;
    delete process.env.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K2;
    process.env.AUTH_JWT_ACTIVE_KID = 'legacy';
    _resetKeyCacheForTests();
  });

  it('rejects a token whose kid has no keypair', async () => {
    // Build a token with kid=k99 and sign it with any key; verify should
    // reject because the registry has no k99.
    const k1 = makeEd25519Pair();
    process.env.AUTH_JWT_ED25519_PRIVATE_KEY_B64_K1 = k1.priv;
    process.env.AUTH_JWT_ED25519_PUBLIC_KEY_B64_K1 = k1.pub;
    process.env.AUTH_JWT_ACTIVE_KID = 'k1';
    _resetKeyCacheForTests();

    const realToken = await signAccessToken({ sub: 'u', sid: 's', stepUpUntil: null });
    // Re-encode the header with kid=k99 (k99 not in env).
    const parts = realToken.split('.');
    const fakeHeader = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', kid: 'k99', typ: 'JWT' }),
    ).toString('base64url');
    const tamperedKidToken = `${fakeHeader}.${parts[1]}.${parts[2]}`;
    expect(await verifyAccessToken(tamperedKidToken)).toBeNull();
  });
});
