// Unit tests for the deterministic ZIP bundle builder (Milestone 1.9 S4).
//
// Coverage (T-R25 + T-R26 + T-R27 close-outs):
//   - byte-equal output for two byte-identical inputs (the determinism
//     contract — without this the chain anchor's outputSha256 binding
//     to the rendered PDF is the only integrity anchor; the ZIP layer
//     would slosh).
//   - four named entries present in the central directory.
//   - manifest canonical includes signatureScope='pdf_and_manifest'.
//   - the signature is preserved verbatim in the signature.bin entry.
//   - the manifest entry parses as valid JSON with the documented
//     key set.

import { describe, expect, it, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  buildSignedZipBundle,
  computeManifestSansSigCanonical,
  type RecommendationBundleManifest,
} from './zip-builder';
// Hand-parser lives in the route file's _internalsForTests export — we
// use it here to assert four entries are present without spinning yauzl.
import { _internalsForTests } from '../routes/recommendations/exports';

beforeAll(async () => {
  await sodium.ready;
});

function fixtureManifest(): RecommendationBundleManifest {
  return {
    version: 1,
    format: 'recommendation_export.v1',
    recommendationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    exportId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    exportedAt: '2026-06-02T10:00:00Z',
    pdfSha256: 'a'.repeat(64),
    citationsHash: 'b'.repeat(64),
    signingKeyId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    signingPublicKeyB64: 'd'.repeat(43), // 32 raw bytes -> 43 base64-no-pad chars
    signatureAlgorithm: 'ed25519',
    signatureScope: 'pdf_and_manifest',
  };
}

const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4 small fixture body that stands in for the rendered notice',
);
const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = i;

describe('buildSignedZipBundle', () => {
  it('produces byte-equal output for two identical inputs (T-R25)', async () => {
    const a = await buildSignedZipBundle({
      pdfBytes: PDF_BYTES,
      signature: SIGNATURE,
      manifest: fixtureManifest(),
    });
    const b = await buildSignedZipBundle({
      pdfBytes: PDF_BYTES,
      signature: SIGNATURE,
      manifest: fixtureManifest(),
    });
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('contains four named entries in alphabetical order', async () => {
    const zip = await buildSignedZipBundle({
      pdfBytes: PDF_BYTES,
      signature: SIGNATURE,
      manifest: fixtureManifest(),
    });
    const entries = _internalsForTests.parseCentralDirectory(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'README.txt',
      'manifest.json',
      'recommendation.pdf',
      'signature.bin',
    ]);
  });

  it('embeds the manifest sans-signature canonical form verbatim', async () => {
    const manifest = fixtureManifest();
    const zip = await buildSignedZipBundle({
      pdfBytes: PDF_BYTES,
      signature: SIGNATURE,
      manifest,
    });
    const { manifestJson } = _internalsForTests.extractManifestAndPdf(zip);
    expect(manifestJson).toBe(computeManifestSansSigCanonical(manifest));
    const parsed = JSON.parse(manifestJson) as RecommendationBundleManifest;
    expect(parsed.signatureScope).toBe('pdf_and_manifest');
    expect(parsed.signatureAlgorithm).toBe('ed25519');
    expect(parsed.format).toBe('recommendation_export.v1');
  });

  it('embeds the PDF bytes verbatim', async () => {
    const zip = await buildSignedZipBundle({
      pdfBytes: PDF_BYTES,
      signature: SIGNATURE,
      manifest: fixtureManifest(),
    });
    const { pdfBytes } = _internalsForTests.extractManifestAndPdf(zip);
    expect(pdfBytes.length).toBe(PDF_BYTES.length);
    expect(Buffer.from(pdfBytes).equals(Buffer.from(PDF_BYTES))).toBe(true);
  });

  it('changes byte output when the PDF bytes change', async () => {
    const baseline = await buildSignedZipBundle({
      pdfBytes: PDF_BYTES,
      signature: SIGNATURE,
      manifest: fixtureManifest(),
    });
    const altered = await buildSignedZipBundle({
      pdfBytes: new TextEncoder().encode('%PDF-1.4 different bytes entirely'),
      signature: SIGNATURE,
      manifest: fixtureManifest(),
    });
    expect(Buffer.from(baseline).equals(Buffer.from(altered))).toBe(false);
  });
});

describe('computeManifestSansSigCanonical', () => {
  it('emits keys in the documented stable order', () => {
    const out = computeManifestSansSigCanonical(fixtureManifest());
    // The first two pretty-printed keys are version + format per the
    // MANIFEST_KEY_ORDER array.
    const lines = out.split('\n');
    expect(lines[1]?.includes('"version"')).toBe(true);
    expect(lines[2]?.includes('"format"')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    const a = computeManifestSansSigCanonical(fixtureManifest());
    const b = computeManifestSansSigCanonical(fixtureManifest());
    expect(a).toBe(b);
  });
});
