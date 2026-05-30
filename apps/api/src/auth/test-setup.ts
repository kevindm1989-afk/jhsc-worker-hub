// Shared test helpers for the auth unit tests.
//
// Pins a deterministic MASTER_KEY and a deterministic Ed25519 keypair so
// tests that call requireAuthEnv() see a consistent environment without
// each test having to set process.env itself.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, initCrypto } from './crypto-stub';

let booted = false;

export async function bootAuthTestEnv(): Promise<void> {
  if (booted) return;
  // Stable env values — keys are regenerated per process so a flaky
  // test that leaks crypto across processes still fails fast.
  if (!process.env.MASTER_KEY) {
    process.env.MASTER_KEY = randomBytes(32).toString('base64');
  }
  if (!process.env.AUTH_JWT_ED25519_PRIVATE_KEY_B64) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.AUTH_JWT_ED25519_PRIVATE_KEY_B64 = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    process.env.AUTH_JWT_ED25519_PUBLIC_KEY_B64 = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
  }
  await initCrypto();
  // Lock the master key to a known 32-byte buffer so seal/open is
  // deterministic in tests that need it.
  _setMasterKeyForTests(new Uint8Array(32).fill(0x42));
  booted = true;
}
