// vitest setupFiles entry. Runs before any test module imports a
// module that snapshots process.env at load time (e.g. src/env.ts).
//
// We deliberately set env BEFORE importing anything from src/. The
// auth tests then call bootAuthTestEnv() in beforeAll to await
// sodium.ready and pin a deterministic master key.

import { generateKeyPairSync, randomBytes } from 'node:crypto';

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
