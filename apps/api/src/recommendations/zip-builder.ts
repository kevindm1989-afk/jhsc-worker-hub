// Deterministic ZIP bundle builder for signed recommendation exports.
// Milestone 1.9 S4.
//
// Bundle layout (four entries, alphabetical order — see T-R25 below):
//
//   README.txt          — plain-English verification recipe.
//   manifest.json       — canonical JSON of the manifest object.
//   recommendation.pdf  — the rendered PDF bytes.
//   signature.bin       — the 64-byte Ed25519 detached signature.
//
// Determinism (T-R25 close-out):
//   - Every entry's mtime is pinned to a fixed Y2K epoch
//     (`2000-01-01T00:00:00Z`). Without this, yazl uses Date.now() per
//     entry and two byte-identical renders produce two different ZIPs,
//     defeating the chain anchor's integrity claim (the chain row's
//     outputSha256 binds the PDF — see Option B in the route — so the
//     ZIP doesn't have to be deterministic for the integrity property,
//     but determinism makes re-issue defensible and is cheap).
//   - `compress: false` (store mode). Faster + deterministic; the PDF
//     itself is already flate-compressed by pdfkit so re-compressing
//     yields negligible savings.
//   - Entry order is sorted alphabetically by name. yazl emits entries
//     in the order addBuffer is called; we sort the array first.
//   - ZIP comment is empty.
//
// Signature scope (T-R26 + T-R27 close-outs):
//   The manifest carries `signatureScope: 'pdf_and_manifest'`. The
//   detached signature is computed over a concatenation of
//   sha256(pdfBytes) and sha256(manifestSansSigCanonical) — see
//   apps/api/src/recommendations/signing.ts. A verifier that consults
//   the manifest's signatureScope cannot be tricked into checking the
//   wrong scope; a verifier that does NOT consult signatureScope can
//   still validate because the signing module's verify function
//   reproduces the same buildSignedMessage construction.
//
// The manifest is INTENTIONALLY held separate from the signature: the
// signature.bin entry is the raw 64-byte primitive output; the
// manifest.json entry is human-readable JSON. Recipients can verify
// with a one-line libsodium call against the public key in the
// manifest.

import { Buffer } from 'node:buffer';
import { ZipFile } from 'yazl';

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

/**
 * The canonical manifest shape. The signature is held OUTSIDE this
 * object (the manifest itself is the input to the signature, sans the
 * signature field — see SignedExportBundle below for the unified
 * input). This matches the original ADR-0008 §3.9 layout but with the
 * scope-binding fields (signatureScope, signingPublicKeyB64) added
 * per the threat-model close-outs.
 */
export interface RecommendationBundleManifest {
  readonly version: 1;
  readonly format: 'recommendation_export.v1';
  readonly recommendationId: string;
  readonly exportId: string;
  /** ISO timestamp. */
  readonly exportedAt: string;
  /** Hex sha256 of `recommendation.pdf` bytes. Binds the manifest to the PDF (T-R27). */
  readonly pdfSha256: string;
  /** Hex sha256 of the canonical-JSON of the resolved citations (corpus binding). */
  readonly citationsHash: string;
  /** UUID of the workplace_signing_keys row that signed the bundle. */
  readonly signingKeyId: string;
  /**
   * Base64 (RFC 4648, no padding) of the 32-byte Ed25519 public key.
   * The verifier uses this directly with the signature; the
   * `signingKeyId` is the durable pointer if they want to cross-check
   * against the workplace's public key roster.
   */
  readonly signingPublicKeyB64: string;
  readonly signatureAlgorithm: 'ed25519';
  /**
   * Binds the signature to BOTH the PDF and the manifest. A verifier
   * MUST refuse to validate a bundle whose signatureScope it does not
   * recognize (forward-compat: future versions might add new scopes).
   * T-R26 close-out.
   */
  readonly signatureScope: 'pdf_and_manifest';
}

export interface SignedExportBundle {
  readonly pdfBytes: Uint8Array;
  /** 64-byte Ed25519 detached signature (output of crypto_sign_detached). */
  readonly signature: Uint8Array;
  readonly manifest: RecommendationBundleManifest;
}

// ---------------------------------------------------------------------------
// Canonical JSON for the manifest. We intentionally do not import the
// `canonicalJsonStringify` from @jhsc/audit here — the manifest is a
// public artifact the recipient parses with a generic JSON tool; the
// shape we produce is "pretty-printed canonical": stable key order,
// 2-space indentation, trailing newline. This is the string the
// recipient reads visually AND the string the signature covers.
// ---------------------------------------------------------------------------

const MANIFEST_KEY_ORDER: ReadonlyArray<keyof RecommendationBundleManifest> = [
  'version',
  'format',
  'recommendationId',
  'exportId',
  'exportedAt',
  'pdfSha256',
  'citationsHash',
  'signingKeyId',
  'signingPublicKeyB64',
  'signatureAlgorithm',
  'signatureScope',
];

/**
 * The canonical-JSON form of the manifest that the signature covers.
 * Stable key order (the array above), 2-space indent, trailing
 * newline. The signature operation hashes this exact string; the
 * verifier reproduces it from manifest.json in the ZIP.
 */
export function computeManifestSansSigCanonical(manifest: RecommendationBundleManifest): string {
  const ordered: Record<string, unknown> = {};
  for (const key of MANIFEST_KEY_ORDER) {
    ordered[key] = manifest[key];
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// README.txt body. Plain English so a recipient who has never seen the
// bundle before can verify it. The text is intentionally short — the
// runbook covers the full procedure; this is the one-paragraph
// orientation.
// ---------------------------------------------------------------------------

const README_BODY = `JHSC Notice of Recommendation — signed export bundle
======================================================

This bundle contains a Notice of Recommendation drafted by the worker
co-chair of the Joint Health & Safety Committee at this workplace.

Files in this bundle:

  recommendation.pdf   The notice itself.
  manifest.json        Metadata about the signature (signing key id,
                       public key, integrity hashes).
  signature.bin        The 64-byte Ed25519 detached signature.
  README.txt           This file.

Verification procedure (libsodium / Ed25519):

  1. Read manifest.json. Decode the base64 signingPublicKeyB64 to a
     32-byte Ed25519 public key.
  2. Compute sha256(recommendation.pdf) as hex.
  3. Compute sha256(manifest.json bytes — exactly as you read them
     from the ZIP, including the trailing newline).
  4. Build the signed message string:
        \${sha256(pdf hex)}:\${sha256(manifest hex)}
     (Two 64-char hex digests separated by a single colon.)
  5. Pass that 129-byte UTF-8 string, the signature.bin bytes, and
     the public key to crypto_sign_verify_detached. Verification
     succeeds iff the bundle has not been altered AND was produced
     by the workplace whose public key matches.

The manifest's signatureScope field is "pdf_and_manifest" — both the
PDF and the manifest are bound by the signature. Tampering with
either flips verification to false.

If verification fails, do NOT trust the document. Contact the rep
through an out-of-band channel to confirm whether the bundle was
intentionally re-issued.
`;

// ---------------------------------------------------------------------------
// Deterministic mtime. The ZIP central directory stores per-entry
// mtimes as DOS date/time (1980-01-01 epoch); some libraries clamp
// pre-1980 dates to 1980. We use 2000-01-01 to stay safely inside the
// valid range across implementations.
// ---------------------------------------------------------------------------

const DETERMINISTIC_MTIME = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

// ---------------------------------------------------------------------------
// Bundle builder
// ---------------------------------------------------------------------------

export async function buildSignedZipBundle(bundle: SignedExportBundle): Promise<Uint8Array> {
  const manifestCanonical = computeManifestSansSigCanonical(bundle.manifest);

  // Compose the entries first so we can sort by name. Sorting + the
  // pinned mtime + store mode + empty comment together produce
  // byte-identical output for identical inputs (T-R25).
  const entries: ReadonlyArray<{ name: string; bytes: Buffer }> = [
    { name: 'README.txt', bytes: Buffer.from(README_BODY, 'utf8') },
    { name: 'manifest.json', bytes: Buffer.from(manifestCanonical, 'utf8') },
    { name: 'recommendation.pdf', bytes: Buffer.from(bundle.pdfBytes) },
    { name: 'signature.bin', bytes: Buffer.from(bundle.signature) },
  ];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const zip = new ZipFile();
  for (const entry of sorted) {
    zip.addBuffer(entry.bytes, entry.name, {
      // Per-entry options that bear on determinism:
      mtime: DETERMINISTIC_MTIME,
      // 0o100644 = regular file rw-r--r--; pinned so the external_attr
      // field of the central-directory header is stable.
      mode: 0o100644,
      compress: false,
      // forceZip64Format=false: we never exceed 4GiB; staying in legacy
      // mode keeps the headers byte-stable across yazl versions.
      forceZip64Format: false,
      // S5 sec-F10 close-out: `forceDosTimestamp: true` was removed —
      // the option doesn't exist in yazl 2.5.1 (it appears in
      // `@types/yazl@3.3.1` but the runtime ignores it). yazl 2.5.1
      // emits no extended-timestamp extra field, so the local-file-
      // header carries only the pinned DOS date/time from `mtime`.
      // The determinism contract holds in this version; a future
      // yazl bump may add the extra field by default and require
      // explicit suppression — verify via the byte-equal test in
      // `zip-builder.test.ts` (which also parses the LFH DOS
      // timestamp at known offsets per sec-F11) before bumping the
      // dependency. The package.json pin is at `^2.5.1`; the lock
      // is the de-facto pin.
    });
  }

  // Collect the output stream into one buffer. yazl emits data
  // synchronously after end() in practice, but we await the 'end'
  // event for safety against backpressure-induced reorder.
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', (err: unknown) =>
      reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
  zip.end({
    // Empty ZIP comment is the determinism contract; yazl defaults to
    // empty but we set it explicitly so a future yazl default change
    // doesn't silently flip the bytes.
    comment: '',
    forceZip64Format: false,
  });
  const buf = await collected;
  return new Uint8Array(buf);
}
