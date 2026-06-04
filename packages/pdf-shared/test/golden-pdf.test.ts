// Golden-PDF fixture invariance suite for @jhsc/pdf-shared.
//
// Purpose: the S2 refactor of inspections + recommendations renderers
// to consume pdf-shared MUST NOT change the byte output of those
// renderers. This suite enforces byte-for-byte SHA-256 invariance for
// the primitives we ship in M2.3 S1, so a future refactor that
// accidentally tweaks padding / fontmetrics / text position trips
// here BEFORE landing in the downstream renderers.
//
// Determinism strategy:
//   - We seed pdfkit's `info.CreationDate` to a fixed Date so the
//     /CreationDate metadata doesn't drift.
//   - We disable info.ModDate the same way.
//   - We pin /Producer + /Creator to generic strings (T-I28 carryover).
//   - We do NOT register custom fonts (no PDF_FONT_DIR in CI) so the
//     fallback Helvetica / Courier path is what's exercised. This is
//     intentional — the golden fixture is the FALLBACK output;
//     production deployments with the OTF files installed will
//     produce different bytes, and the S2 refactor must invariance-
//     check both paths via PDF_FONT_DIR=... in the runbook.
//
// On first run with no fixture present, the test WRITES the fixture
// and skips the comparison (with a console-quiet `expect.fail` if
// `JHSC_PDF_FIXTURE_UPDATE=1` is unset and the file is missing). The
// runbook covers updating fixtures intentionally.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';

import { registerAllFonts } from '../src/fonts';
import { pdfkitSizeFor } from '../src/page-size';
import { renderHeader } from '../src/header';
import { renderFooter } from '../src/footer';
import { renderChainReceipt } from '../src/chain-receipt';
import { renderSignaturePanel } from '../src/signature-panel';
import { renderRetentionStatement } from '../src/retention-statement';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures');

const FIXED_CREATION_DATE = new Date('2026-09-20T16:00:00.000Z');

/**
 * Drain pdfkit's stream into a Buffer. pdfkit's stream IS Node-stream
 * compatible; we collect chunks until 'end' fires.
 */
async function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * Build a deterministic PDFDocument with pinned metadata so the bytes
 * stay stable across runs.
 */
function makeDeterministicDoc(size: 'letter' | 'a4'): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: pdfkitSizeFor(size),
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    info: {
      Title: 'JHSC Document',
      Author: 'JHSC Worker Hub',
      Producer: 'JHSC Worker Hub PDF Renderer',
      Creator: 'JHSC Worker Hub PDF Renderer',
      CreationDate: FIXED_CREATION_DATE,
      ModDate: FIXED_CREATION_DATE,
    },
  });
  registerAllFonts(doc);
  return doc;
}

/**
 * Build a fixture PDF exercising the M2.3 S1 primitives in sequence.
 */
async function buildFixturePdf(size: 'letter' | 'a4'): Promise<Buffer> {
  const doc = makeDeterministicDoc(size);

  renderHeader(doc, {
    workplaceDisplayName: 'Fixture Workplace',
    documentTitle: 'JHSC Meeting Minutes — Fixture',
    generatedAt: '2026-09-20T16:00:00.000Z',
  });

  renderSignaturePanel(doc, [
    {
      roleLabel: 'Worker Co-Chair',
      signerNameDecrypted: 'Fixture WCC',
      signedAt: '2026-09-20T15:30:00.000Z',
      signedMethod: 'in_app_passkey',
      attestationSigHash: 'a'.repeat(64),
    },
    {
      roleLabel: 'Management Co-Chair',
      signerNameDecrypted: 'Fixture MCC',
      signedAt: '2026-09-20T15:35:00.000Z',
      signedMethod: 'paper_attestation',
      attestationSigHash: 'b'.repeat(64),
    },
  ]);

  renderRetentionStatement(doc, {
    jurisdiction: 'ON',
    corpusEntries: [{ statuteCode: 'OHSA', citation: 's.9(28)', versionDate: '2020-07-01' }],
  });

  renderChainReceipt(doc, {
    chainRowIndex: 42,
    chainHash: 'c'.repeat(64),
    documentHash: 'd'.repeat(64),
  });

  renderFooter(doc, {
    documentHash: 'd'.repeat(64),
    pageNumber: 1,
    totalPages: 1,
    retentionStatement: 'Retain 2 yrs · OHSA s.9(28)',
    leftLabel: 'Fixture Meeting · 2026-09-15',
  });

  return pdfToBuffer(doc);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Check vs the committed fixture's SHA-256. On the first run (fixture
 * missing) we WRITE the .sha256 file + the .pdf so the next CI run
 * has the gate active; or, when JHSC_PDF_FIXTURE_UPDATE=1 is set, we
 * intentionally overwrite.
 *
 * Returns true if the fixture existed AND matched; false if it was
 * just written. The test asserts the boolean is true (it should always
 * be true on CI; only the first authoring developer's run produces
 * false).
 */
function checkOrWriteFixture(name: string, bytes: Buffer): boolean {
  if (!existsSync(FIXTURE_DIR)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }
  const shaPath = join(FIXTURE_DIR, `${name}.sha256`);
  const pdfPath = join(FIXTURE_DIR, `${name}.pdf`);
  const computed = sha256Hex(bytes);

  const update = process.env.JHSC_PDF_FIXTURE_UPDATE === '1';

  if (!existsSync(shaPath) || update) {
    writeFileSync(shaPath, computed + '\n', 'utf8');
    writeFileSync(pdfPath, bytes);
    return false;
  }

  const expected = readFileSync(shaPath, 'utf8').trim();
  return expected === computed;
}

describe('pdf-shared golden PDF — byte-for-byte invariance', () => {
  it('letter-size fixture matches committed SHA-256', async () => {
    const bytes = await buildFixturePdf('letter');
    const ok = checkOrWriteFixture('m2.3-s1-letter', bytes);
    // The boolean is true on every CI run after the fixture is
    // committed; the first authoring run produces false (the
    // fixture is being written). The test asserts true so a future
    // refactor that drifts the bytes trips here.
    expect(ok, 'pdf-shared output drifted vs committed fixture — see runbook to regenerate').toBe(
      true,
    );
  });

  it('a4-size fixture matches committed SHA-256', async () => {
    const bytes = await buildFixturePdf('a4');
    const ok = checkOrWriteFixture('m2.3-s1-a4', bytes);
    expect(ok, 'pdf-shared a4 output drifted vs committed fixture').toBe(true);
  });

  it('the same inputs produce byte-identical output (intra-process determinism)', async () => {
    const a = await buildFixturePdf('letter');
    const b = await buildFixturePdf('letter');
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });
});
