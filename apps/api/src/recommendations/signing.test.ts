// Unit tests for the Ed25519 signing helpers (Milestone 1.9 S4).
//
// Coverage:
//   - Sign + verify round-trip with a fresh keypair.
//   - Signature is exactly 64 bytes (Ed25519 detached).
//   - Tamper on the PDF bytes -> verify returns false.
//   - Tamper on the manifest canonical string -> verify returns false.
//   - Wrong public key -> verify returns false.

import { describe, expect, it, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  buildSignedMessage,
  signRecommendationBundle,
  verifyRecommendationBundle,
} from './signing';

beforeAll(async () => {
  await sodium.ready;
});

const PDF = new TextEncoder().encode('%PDF-1.4 minimal fixture body bytes');
const MANIFEST = JSON.stringify({
  version: 1,
  pdfSha256: 'abc',
  signatureScope: 'pdf_and_manifest',
});

describe('signRecommendationBundle / verifyRecommendationBundle', () => {
  it('signs and verifies a fresh keypair round-trip', () => {
    const kp = sodium.crypto_sign_keypair();
    const sig = signRecommendationBundle(PDF, MANIFEST, kp.privateKey);
    expect(sig.length).toBe(64);
    const ok = verifyRecommendationBundle(PDF, MANIFEST, sig, kp.publicKey);
    expect(ok).toBe(true);
  });

  it('fails verification when the PDF is tampered', () => {
    const kp = sodium.crypto_sign_keypair();
    const sig = signRecommendationBundle(PDF, MANIFEST, kp.privateKey);
    const tamperedPdf = new TextEncoder().encode('%PDF-1.4 minimal fixture body byteX');
    expect(verifyRecommendationBundle(tamperedPdf, MANIFEST, sig, kp.publicKey)).toBe(false);
  });

  it('fails verification when the manifest is tampered', () => {
    const kp = sodium.crypto_sign_keypair();
    const sig = signRecommendationBundle(PDF, MANIFEST, kp.privateKey);
    // Even a single-character change in the manifest flips the hash
    // and therefore the signed message; verify returns false (T-R26).
    const tamperedManifest = MANIFEST.replace('"abc"', '"abd"');
    expect(verifyRecommendationBundle(PDF, tamperedManifest, sig, kp.publicKey)).toBe(false);
  });

  it('fails verification when the public key is wrong', () => {
    const kp = sodium.crypto_sign_keypair();
    const sig = signRecommendationBundle(PDF, MANIFEST, kp.privateKey);
    const other = sodium.crypto_sign_keypair();
    expect(verifyRecommendationBundle(PDF, MANIFEST, sig, other.publicKey)).toBe(false);
  });

  it('rejects a private key of the wrong length', () => {
    expect(() => signRecommendationBundle(PDF, MANIFEST, new Uint8Array(32))).toThrow(
      /privateKey must be/,
    );
  });

  it('returns false on signature of the wrong length without throwing', () => {
    const kp = sodium.crypto_sign_keypair();
    expect(verifyRecommendationBundle(PDF, MANIFEST, new Uint8Array(63), kp.publicKey)).toBe(false);
    expect(verifyRecommendationBundle(PDF, MANIFEST, new Uint8Array(65), kp.publicKey)).toBe(false);
  });

  it('returns false on public key of the wrong length without throwing', () => {
    const kp = sodium.crypto_sign_keypair();
    const sig = signRecommendationBundle(PDF, MANIFEST, kp.privateKey);
    expect(verifyRecommendationBundle(PDF, MANIFEST, sig, new Uint8Array(31))).toBe(false);
    expect(verifyRecommendationBundle(PDF, MANIFEST, sig, new Uint8Array(33))).toBe(false);
  });
});

describe('buildSignedMessage', () => {
  it('produces a 129-byte UTF-8 message (64 + 1 + 64)', () => {
    const msg = buildSignedMessage(PDF, MANIFEST);
    expect(msg.length).toBe(129);
    const decoded = new TextDecoder().decode(msg);
    expect(decoded.charAt(64)).toBe(':');
    expect(decoded.slice(0, 64)).toMatch(/^[0-9a-f]{64}$/);
    expect(decoded.slice(65, 129)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical inputs', () => {
    const a = buildSignedMessage(PDF, MANIFEST);
    const b = buildSignedMessage(PDF, MANIFEST);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
