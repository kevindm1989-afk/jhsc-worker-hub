import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { b64ToBytes, bytesToB64, sealEvidence, sha256Hex } from '../evidence/crypto';

await sodium.ready;

describe('evidence/crypto', () => {
  it('sha256Hex matches the spec output', async () => {
    const empty = await sha256Hex(new Uint8Array(0));
    expect(empty).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const abc = await sha256Hex(new TextEncoder().encode('abc'));
    expect(abc).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('bytesToB64 / b64ToBytes round-trip', () => {
    const original = new Uint8Array([0, 1, 2, 250, 255]);
    expect(b64ToBytes(bytesToB64(original))).toEqual(original);
  });

  it('sealEvidence produces ciphertext that the workplace private key can open', async () => {
    // Generate a workplace-style X25519 keypair via libsodium.
    const kp = sodium.crypto_box_keypair();
    const plaintext = new TextEncoder().encode(
      'A committee shall make recommendations under OHSA s.9(20).',
    );
    const sealed = await sealEvidence(plaintext, kp.publicKey);

    // Wire-format invariants.
    expect(sealed.ciphertext[0]).toBe(0x02);
    expect(sealed.ciphertext.length).toBe(1 + 24 + plaintext.length + 16); // version + nonce + body + tag

    // sealedDek opens with the private key and decrypts the body.
    const dek = sodium.crypto_box_seal_open(sealed.sealedDek, kp.publicKey, kp.privateKey);
    const nonce = sealed.ciphertext.slice(1, 25);
    const body = sealed.ciphertext.slice(25);
    const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, null, nonce, dek);
    expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(plaintext));

    // plaintextSha256 anchor matches a fresh re-hash of the plaintext.
    expect(sealed.plaintextSha256).toBe(await sha256Hex(plaintext));
    expect(sealed.ciphertextSha256).toBe(await sha256Hex(sealed.ciphertext));
  });

  it('two seals of the same plaintext produce different ciphertexts (fresh DEK + nonce)', async () => {
    const kp = sodium.crypto_box_keypair();
    const plaintext = new TextEncoder().encode('same input');
    const a = await sealEvidence(plaintext, kp.publicKey);
    const b = await sealEvidence(plaintext, kp.publicKey);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
    expect(Buffer.from(a.sealedDek).equals(Buffer.from(b.sealedDek))).toBe(false);
    expect(a.plaintextSha256).toBe(b.plaintextSha256); // same plaintext
  });

  it('rejects a malformed workplace public key', async () => {
    await expect(sealEvidence(new Uint8Array(0), new Uint8Array(16))).rejects.toThrow(
      /workplacePublicKey/,
    );
  });
});
