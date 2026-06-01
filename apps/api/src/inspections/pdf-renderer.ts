// PDF renderer for inspection exports — Milestone 1.8 S4.
//
// Pure module: no Hono context, no DB, no Tigris, no fs reads beyond the
// optional Source Serif 4 font binary (loaded once at module init if
// PDF_FONT_DIR is set). Caller hands in fully-resolved inspections +
// decrypted photo bytes; this module returns the PDF byte stream.
//
// Library choice: pdfkit only. Justified in ADR-0007 §3.9 and the
// T-I25 (no embedded JS / actions / OpenAction) line in SECURITY.md
// §2.8. Specifically AVOIDED:
//   - puppeteer / Chromium: huge attack surface, no need to render HTML.
//   - @react-pdf/renderer: builds an in-memory virtual tree that keeps
//     every decrypted photo buffer alive until the document renders.
//     pdfkit's streaming API lets the caller free per-photo plaintext
//     between embed calls.
//
// PDF metadata posture (T-I28, CLAUDE.md non-negotiable #1):
//   - Title:    "JHSC Inspection Export"          (generic; no workplace name)
//   - Author:   "JHSC Worker Hub"                  (generic)
//   - Producer: "JHSC Worker Hub PDF Renderer"     (generic)
//   - CreationDate: now
//   - Subject / Keywords: NEVER set. The metadata fields are the most
//     leaky surface for the workplace identity (#1) and the
//     finding-content surface (PI under #4); we don't write them.
//
// No PDF JavaScript surface (T-I25):
//   - pdfkit by default does not embed JS / actions. This module never
//     calls any API that would add `/JS`, `/JavaScript`, `/AA`, or
//     `/OpenAction` entries. Static text + images + lines only.
//
// Provenance footer (per ADR-0007 §3.9 + ARCHITECTURE.md §6a — and the
// S4 implementer prompt re-shape):
//   Left:   "Export <id-prefix>"  (8-char UUID prefix; full uuid is in
//            export_records + chain row)
//   Center: "page N of M"
//   Right:  "Chain idx <N>"       (audit_log.idx of inspection.exported)
//
// The doc-hash placeholder dance from the original ADR §3.9 is SIMPLIFIED
// in S4: the chain row's outputSha256 is the canonical anchor; the PDF
// itself does not need to embed its own hash in-pixel. The S5 reviewer
// runbook documents the chain-row binding as the integrity anchor.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

export interface RenderablePhoto {
  readonly evidenceId: string;
  readonly mimeType: string;
  /** Decrypted plaintext bytes. Caller memzeros after render returns. */
  readonly bytes: Uint8Array;
  readonly capturedAt: string | null;
  readonly gpsLatitude: number | null;
  readonly gpsLongitude: number | null;
}

export interface RenderableFinding {
  readonly id: string;
  readonly sectionLabel: string;
  readonly itemLabel: string;
  readonly statusVocab: 'ABC_X' | 'GAR';
  readonly statusValue: string;
  /** Decrypted plaintext or null. Caller memzeros after render returns. */
  readonly observation: string | null;
  readonly correctiveAction: string | null;
  readonly responsibleParty: string | null;
  readonly photos: ReadonlyArray<RenderablePhoto>;
}

export interface RenderableSignature {
  readonly role: 'inspector' | 'supervisor' | 'jhsc_worker_co_chair';
  readonly signedByUserId: string;
  readonly signedAt: string;
}

export interface RenderableInspection {
  readonly id: string;
  readonly templateCode: string;
  readonly templateDisplayName: string;
  readonly templateVersion: number;
  readonly zoneId: string;
  readonly zoneDisplayName: string;
  readonly conductedByUserId: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly findings: ReadonlyArray<RenderableFinding>;
  readonly signatures: ReadonlyArray<RenderableSignature>;
}

export interface ProvenanceFooter {
  readonly exportId: string;
  readonly exportedAt: string;
  /** audit_log.idx of the inspection.exported chain row. Filled by caller. */
  readonly chainIdx: number;
  /**
   * Placeholder for compatibility with the original ADR §3.9 footer-hash
   * dance. S4 does NOT do the post-replace dance — the chain row's
   * outputSha256 is the canonical anchor. This field is accepted so the
   * S5 reviewer can audit the API surface, but the renderer does NOT
   * write it into the PDF.
   */
  readonly outputSha256Placeholder: string;
}

// ---------------------------------------------------------------------------
// Font loading
// ---------------------------------------------------------------------------

// Optional Source Serif 4 binary. If absent, the renderer falls back to
// Helvetica (pdfkit's built-in) so the verification gate works in CI
// without the binary present. Per the S4 prompt: "the verification gate
// will work without the binary present because pdfkit falls back to
// Helvetica. Whichever path: the renderer must NOT crash on missing
// fonts."
const FONT_DIR = process.env.PDF_FONT_DIR ?? '';
const REG_PATH = FONT_DIR ? join(FONT_DIR, 'SourceSerif4-Regular.otf') : '';
const BOLD_PATH = FONT_DIR ? join(FONT_DIR, 'SourceSerif4-Bold.otf') : '';
const FONT_AVAILABLE =
  FONT_DIR !== '' && REG_PATH !== '' && BOLD_PATH !== ''
    ? existsSync(REG_PATH) && existsSync(BOLD_PATH)
    : false;

function applyDefaultFont(doc: PDFKit.PDFDocument): void {
  if (FONT_AVAILABLE) {
    try {
      doc.registerFont('serif', REG_PATH);
      doc.registerFont('serif-bold', BOLD_PATH);
      doc.font('serif');
      return;
    } catch {
      // Fall through to Helvetica. We intentionally do not throw — the
      // font surface is non-load-bearing and the gate must run without
      // the binary in CI.
    }
  }
  doc.font('Helvetica');
}

function fontBold(doc: PDFKit.PDFDocument): void {
  if (FONT_AVAILABLE) {
    try {
      doc.font('serif-bold');
      return;
    } catch {
      // fall through
    }
  }
  doc.font('Helvetica-Bold');
}

function fontRegular(doc: PDFKit.PDFDocument): void {
  if (FONT_AVAILABLE) {
    try {
      doc.font('serif');
      return;
    } catch {
      // fall through
    }
  }
  doc.font('Helvetica');
}

// ---------------------------------------------------------------------------
// Status badge color + label helpers
// ---------------------------------------------------------------------------

interface StatusBadge {
  readonly label: string;
  readonly fill: string; // hex color
  readonly textColor: string;
}

function statusBadge(vocab: 'ABC_X' | 'GAR', value: string): StatusBadge {
  if (vocab === 'ABC_X') {
    switch (value) {
      case 'A':
        return { label: 'Status A — Immediate', fill: '#b91c1c', textColor: '#ffffff' };
      case 'B':
        return { label: 'Status B — 1–7 days', fill: '#b45309', textColor: '#ffffff' };
      case 'C':
        return { label: 'Status C — Longer-term', fill: '#1e3a8a', textColor: '#ffffff' };
      case 'X':
        return { label: 'Status X — No issue / N/A', fill: '#52525b', textColor: '#ffffff' };
      default:
        return { label: `Status ${value}`, fill: '#52525b', textColor: '#ffffff' };
    }
  }
  // GAR
  switch (value) {
    case 'G':
      return { label: 'Status G — Green', fill: '#15803d', textColor: '#ffffff' };
    case 'A':
      return { label: 'Status A — Amber', fill: '#b45309', textColor: '#ffffff' };
    case 'R':
      return { label: 'Status R — Red', fill: '#b91c1c', textColor: '#ffffff' };
    default:
      return { label: `Status ${value}`, fill: '#52525b', textColor: '#ffffff' };
  }
}

function roleLabel(role: 'inspector' | 'supervisor' | 'jhsc_worker_co_chair'): string {
  switch (role) {
    case 'inspector':
      return 'Inspector';
    case 'supervisor':
      return 'Supervisor';
    case 'jhsc_worker_co_chair':
      return 'JHSC Worker Co-Chair';
  }
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 56; // ~0.78in
const MAX_PHOTO_WIDTH = 480;
const MAX_PHOTO_HEIGHT = 360;

function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

function formatGps(lat: number | null, lon: number | null): string | null {
  if (lat === null || lon === null) return null;
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Cover page
// ---------------------------------------------------------------------------

function renderCoverPage(
  doc: PDFKit.PDFDocument,
  inspection: RenderableInspection,
  isFirst: boolean,
): void {
  // autoFirstPage is false; always addPage. First call creates page 1,
  // subsequent calls add a fresh page so each inspection starts on its
  // own cover sheet.
  void isFirst;
  doc.addPage();
  fontBold(doc);
  doc.fontSize(20).fillColor('#0f172a').text(inspection.templateDisplayName, {
    align: 'left',
  });

  fontRegular(doc);
  doc.moveDown(0.25);
  doc
    .fontSize(11)
    .fillColor('#475569')
    .text(`Template ${inspection.templateCode} · v${inspection.templateVersion}`, {
      align: 'left',
    });

  doc.moveDown(1);

  // A tabular block of stable identifiers. Workplace name is intentionally
  // not rendered here — the prompt says "leave it out entirely, document
  // as a follow-up" for 1.8.
  const rows: ReadonlyArray<[string, string]> = [
    ['Inspection ID', shortId(inspection.id)],
    ['Zone', `${inspection.zoneDisplayName} (${inspection.zoneId})`],
    ['Conducted by', shortId(inspection.conductedByUserId)],
    ['Started at', inspection.startedAt ?? '—'],
    ['Completed at', inspection.completedAt ?? '—'],
    ['Findings', String(inspection.findings.length)],
    ['Signatures', String(inspection.signatures.length)],
  ];

  fontRegular(doc);
  doc.fontSize(10).fillColor('#0f172a');
  const labelX = PAGE_MARGIN;
  const valueX = PAGE_MARGIN + 140;
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.fillColor('#64748b').text(label, labelX, y, { width: 130 });
    doc.fillColor('#0f172a').text(value, valueX, y, { width: 380 });
    doc.moveDown(0.4);
  }
}

// ---------------------------------------------------------------------------
// Finding block
// ---------------------------------------------------------------------------

function renderFinding(doc: PDFKit.PDFDocument, finding: RenderableFinding, index: number): void {
  // If we're getting near the bottom, force a page break before starting
  // a finding. Avoids splitting a finding's header from its body.
  if (doc.y > doc.page.height - PAGE_MARGIN - 160) {
    doc.addPage();
  }

  fontBold(doc);
  doc
    .fontSize(12)
    .fillColor('#0f172a')
    .text(`${index + 1}. ${finding.sectionLabel} — ${finding.itemLabel}`, { align: 'left' });
  fontRegular(doc);

  doc.moveDown(0.2);

  // Status badge: render a small color rectangle with white label text.
  const badge = statusBadge(finding.statusVocab, finding.statusValue);
  const badgeY = doc.y;
  const badgeWidth = 220;
  const badgeHeight = 16;
  doc.save().rect(PAGE_MARGIN, badgeY, badgeWidth, badgeHeight).fill(badge.fill).restore();
  doc
    .fillColor(badge.textColor)
    .fontSize(9)
    .text(badge.label, PAGE_MARGIN + 6, badgeY + 3, {
      width: badgeWidth - 12,
      lineBreak: false,
    });
  doc.fillColor('#0f172a');
  doc.y = badgeY + badgeHeight + 6;
  doc.x = PAGE_MARGIN;

  // Decrypted paragraphs.
  function paragraph(label: string, value: string | null): void {
    if (value === null || value === '') return;
    fontBold(doc);
    doc.fontSize(9).fillColor('#475569').text(label.toUpperCase(), { align: 'left' });
    fontRegular(doc);
    doc
      .fontSize(10)
      .fillColor('#0f172a')
      .text(value, {
        align: 'left',
        width: doc.page.width - PAGE_MARGIN * 2,
      });
    doc.moveDown(0.4);
  }
  paragraph('Observation', finding.observation);
  paragraph('Corrective action', finding.correctiveAction);
  paragraph('Responsible party', finding.responsibleParty);

  // Photos. Each photo gets the max-width fit + caption.
  for (const photo of finding.photos) {
    if (doc.y > doc.page.height - PAGE_MARGIN - MAX_PHOTO_HEIGHT - 30) {
      doc.addPage();
    }
    try {
      // pdfkit's image() takes a Buffer or path. We pass a Buffer view of
      // the decrypted plaintext.
      const buf = Buffer.from(photo.bytes);
      doc.image(buf, PAGE_MARGIN, doc.y, {
        fit: [MAX_PHOTO_WIDTH, MAX_PHOTO_HEIGHT],
      });
      // Manually advance doc.y because image() doesn't always update it.
      doc.y = doc.y + MAX_PHOTO_HEIGHT + 4;
    } catch {
      // A photo whose bytes pdfkit cannot decode is rendered as a
      // placeholder line so the export does not crash on a corrupt
      // image. The route layer's per-photo plaintext-SHA-256 verify
      // (T-I24) is the upstream gate; this is the renderer-side
      // belt-and-suspenders so a non-image MIME never blows up rendering.
      doc
        .fontSize(9)
        .fillColor('#b91c1c')
        .text(`[photo ${shortId(photo.evidenceId)} could not be embedded]`, { align: 'left' });
      doc.fillColor('#0f172a');
    }
    // Caption.
    fontRegular(doc);
    const cap: string[] = [`Photo ${shortId(photo.evidenceId)}`];
    if (photo.capturedAt) cap.push(`captured ${photo.capturedAt}`);
    const gps = formatGps(photo.gpsLatitude, photo.gpsLongitude);
    if (gps) cap.push(`GPS ${gps}`);
    doc.fontSize(8).fillColor('#475569').text(cap.join(' · '), {
      align: 'left',
    });
    doc.fillColor('#0f172a');
    doc.moveDown(0.4);
  }

  doc.moveDown(0.4);
}

// ---------------------------------------------------------------------------
// Signature block
// ---------------------------------------------------------------------------

function renderSignatures(
  doc: PDFKit.PDFDocument,
  signatures: ReadonlyArray<RenderableSignature>,
): void {
  if (signatures.length === 0) return;
  if (doc.y > doc.page.height - PAGE_MARGIN - 80) {
    doc.addPage();
  }
  fontBold(doc);
  doc.fontSize(12).fillColor('#0f172a').text('Signatures', { align: 'left' });
  fontRegular(doc);
  doc.moveDown(0.3);
  for (const sig of signatures) {
    doc
      .fontSize(10)
      .fillColor('#0f172a')
      .text(`${roleLabel(sig.role)} · ${shortId(sig.signedByUserId)} · ${sig.signedAt}`, {
        align: 'left',
      });
    doc.moveDown(0.15);
  }
  doc.moveDown(0.5);
}

// ---------------------------------------------------------------------------
// Provenance footer (running, on every page)
// ---------------------------------------------------------------------------

function paintFooter(
  doc: PDFKit.PDFDocument,
  provenance: ProvenanceFooter,
  pageNum: number,
  totalPages: number,
): void {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const y = pageHeight - PAGE_MARGIN + 10;
  fontRegular(doc);
  doc.fontSize(8).fillColor('#64748b');

  const left = `Export ${shortId(provenance.exportId)}`;
  const center = `page ${pageNum} of ${totalPages}`;
  const right = `Chain idx ${provenance.chainIdx}`;

  doc.text(left, PAGE_MARGIN, y, {
    width: 200,
    align: 'left',
    lineBreak: false,
  });
  doc.text(center, PAGE_MARGIN, y, {
    width: pageWidth - PAGE_MARGIN * 2,
    align: 'center',
    lineBreak: false,
  });
  doc.text(right, pageWidth - PAGE_MARGIN - 200, y, {
    width: 200,
    align: 'right',
    lineBreak: false,
  });

  doc.fillColor('#0f172a');
}

// ---------------------------------------------------------------------------
// Buffer collection from the pdfkit stream
// ---------------------------------------------------------------------------

function collectStream(doc: PDFKit.PDFDocument): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    doc.on('end', () => {
      const total = Buffer.concat(chunks);
      // Slice so the returned Uint8Array owns its memory and the
      // chunks array can be GC'd promptly.
      resolve(new Uint8Array(total));
    });
    doc.on('error', (err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

export async function renderInspectionPdf(
  inspections: ReadonlyArray<RenderableInspection>,
  provenance: ProvenanceFooter,
): Promise<Uint8Array> {
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    margin: PAGE_MARGIN,
    // T-I28: metadata is generic. No workplace name, no inspection ids,
    // no zone names, no finding text.
    info: {
      Title: 'JHSC Inspection Export',
      Author: 'JHSC Worker Hub',
      Producer: 'JHSC Worker Hub PDF Renderer',
      CreationDate: new Date(),
      // Subject / Keywords intentionally omitted. Adding either would
      // surface inspection content into a quick file-properties dialog.
    },
    pdfVersion: '1.4',
    compress: true,
  });

  // Begin collecting bytes BEFORE we start emitting content. pdfkit
  // emits 'data' events as content lands; if we waited until after
  // `end()`, we'd race the consumer.
  const collected = collectStream(doc);

  applyDefaultFont(doc);

  // Render each inspection. The first inspection drives the initial
  // page; subsequent ones each start with addPage.
  inspections.forEach((insp, i) => {
    renderCoverPage(doc, insp, i === 0);
    doc.moveDown(1);
    fontBold(doc);
    doc.fontSize(14).fillColor('#0f172a').text('Findings', { align: 'left' });
    fontRegular(doc);
    doc.moveDown(0.3);
    if (insp.findings.length === 0) {
      doc
        .fontSize(10)
        .fillColor('#64748b')
        .text('No findings recorded on this inspection.', { align: 'left' });
      doc.fillColor('#0f172a');
      doc.moveDown(0.5);
    } else {
      insp.findings.forEach((finding, idx) => {
        renderFinding(doc, finding, idx);
      });
    }
    renderSignatures(doc, insp.signatures);
  });

  // Footer pass. With bufferPages: true we can iterate every page now
  // and stamp the running footer with the final total. Without this we
  // wouldn't know `totalPages` while rendering content.
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    paintFooter(doc, provenance, i + 1, total);
  }

  doc.end();
  const bytes = await collected;
  return bytes;
}
