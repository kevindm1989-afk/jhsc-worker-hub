// Ed25519 detached-signature helpers for recommendation exports.
// Milestone 1.9 S4.
//
// Public surface:
//   - signRecommendationBundle(pdfBytes, manifestSansSigCanonical, privateKey)
//     -> 64-byte detached signature
//   - verifyRecommendationBundle(pdfBytes, manifestSansSigCanonical, signature, publicKey)
//     -> boolean
//
// Threat model close-outs:
//   - T-R26 (manifest swap): the signed bytes include the canonical
//     JSON of the manifest (sans signature). Tampering with
//     signing_key_id, citationsHash, or any other manifest field flips
//     verify() to false.
//   - T-R27 (PDF swap): the signed bytes include sha256(pdfBytes).
//     Tampering with the PDF flips verify() to false.
//
// Design choice — sign sha256(pdf) || ':' || sha256(manifest), not
// raw concat:
//   The signed message is `sha256Hex(pdfBytes) + ':' + sha256Hex(manifestSansSigCanonical)`,
//   which is exactly 129 bytes (two 64-char hex digests + a 1-char
//   separator). Three reasons:
//     1. **Constant-size signed message.** A verifier doesn't need to
//        stream-hash a multi-MB PDF before calling verify; they hash
//        the PDF once, hash the manifest once, format the 129-byte
//        string, and verify. Symmetric to the signer.
//     2. **No length-extension confusion.** Two distinct (pdf, manifest)
//        pairs cannot map to the same signed message: the separator
//        between the two hex digests is unambiguous, and SHA-256 hex
//        characters are 0-9a-f (the separator ':' is not in that
//        alphabet).
//     3. **Verifier-side independence from the renderer.** The verifier
//        does NOT need to know the PDF's internal structure — only the
//        bytes. A future PAdES upgrade (1.12) that switches to in-PDF
//        signatures will produce a different signature shape; the
//        sidecar verifier remains valid forever.
//
// The 64-byte Ed25519 detached signature is small enough to ship in
// the ZIP as a separate `signature.bin` entry; the verifier passes it
// to `sodium.crypto_sign_verify_detached(sig, msg, pubKey)` as-is.

import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';

/**
 * Build the exact bytes that the Ed25519 signature covers. Exported so
 * the verifier can reproduce them without re-implementing the format.
 *
 * Layout: `${sha256Hex(pdfBytes)}:${sha256Hex(manifestSansSigCanonical)}`
 * encoded UTF-8. The colon is the in-alphabet-safe separator.
 */
export function buildSignedMessage(
  pdfBytes: Uint8Array,
  manifestSansSigCanonical: string,
): Uint8Array {
  const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
  const manifestHash = createHash('sha256').update(manifestSansSigCanonical, 'utf8').digest('hex');
  // 64 + 1 + 64 = 129 bytes — fixed-size signed message regardless of
  // PDF length or manifest length. The verifier asserts this length
  // implicitly by recomputing the same string.
  return new TextEncoder().encode(`${pdfHash}:${manifestHash}`);
}

/**
 * Sign with libsodium's Ed25519 detached signature primitive. The
 * private key is the 64-byte libsodium-format secret key from
 * `crypto_sign_keypair()` (or, in production, the bytes returned by
 * `openWorkplaceSigningPrivateKey`).
 *
 * The caller is expected to `sodium.memzero(privateKey)` immediately
 * after this returns (the export route does so in a try/finally).
 * This helper does NOT memzero the input — that would be confusing
 * (the caller may want to sign multiple things in a row) and the
 * libsodium-wrappers API does not expose a "sign and consume" form.
 */
export function signRecommendationBundle(
  pdfBytes: Uint8Array,
  manifestSansSigCanonical: string,
  privateKey: Uint8Array,
): Uint8Array {
  if (privateKey.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new Error(
      `signRecommendationBundle: privateKey must be ${sodium.crypto_sign_SECRETKEYBYTES} bytes, got ${privateKey.length}`,
    );
  }
  const message = buildSignedMessage(pdfBytes, manifestSansSigCanonical);
  return sodium.crypto_sign_detached(message, privateKey);
}

/**
 * Inverse of signRecommendationBundle. Returns true iff the signature
 * was produced by the private key paired with `publicKey` over the
 * exact (pdfBytes, manifestSansSigCanonical) pair. Any tamper of
 * either input flips this to false.
 */
export function verifyRecommendationBundle(
  pdfBytes: Uint8Array,
  manifestSansSigCanonical: string,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== sodium.crypto_sign_BYTES) return false;
  if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return false;
  const message = buildSignedMessage(pdfBytes, manifestSansSigCanonical);
  try {
    return sodium.crypto_sign_verify_detached(signature, message, publicKey);
  } catch {
    // libsodium throws on malformed inputs in some bindings; treat any
    // throw as a verification failure. The function is a boolean
    // predicate, not an error reporter.
    return false;
  }
}
