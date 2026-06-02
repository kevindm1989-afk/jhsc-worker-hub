// PDF renderer for recommendation exports — Milestone 1.9 S4.
//
// Pure module: no Hono context, no DB, no Tigris, no fs reads beyond the
// optional Source Serif 4 font binary (loaded once at module init if
// PDF_FONT_DIR is set). Caller hands in fully-resolved + decrypted
// recommendation prose and citation bodies; this module returns the
// PDF byte stream.
//
// Library choice: pdfkit only. Justified in ADR-0008 §3.8 and aligns with
// the 1.8 inspection renderer's posture (T-R23 / T-I25). Specifically
// AVOIDED:
//   - puppeteer / Chromium: huge attack surface, no need to render HTML.
//   - @react-pdf/renderer: builds an in-memory virtual tree that keeps
//     decrypted plaintext alive past the render — the bounded plaintext
//     window discipline (T-R22) is harder to honor.
//
// PDF metadata posture (T-R23 mirror of T-I28, CLAUDE.md #1):
//   - Title:    "JHSC Notice of Recommendation"  (generic; no workplace
//                                                  name, no rec number,
//                                                  no jurisdiction, no
//                                                  title plaintext)
//   - Author:   "JHSC Worker Hub"                 (generic)
//   - Producer: "JHSC Worker Hub PDF Renderer"    (generic)
//   - CreationDate: now
//   - Subject / Keywords: NEVER set. Properties-dialog leak surface for
//     PI (#1 / #4).
//
// No PDF JavaScript surface (T-R23 mirror of T-I25):
//   - pdfkit by default does not embed JS / actions. This module never
//     calls addJS / openAction / link annotations targeting javascript:.
//     Static text + rectangles only.
//
// Provenance footer (per ADR-0008 §3.8 + the 1.8 sec-F8 close-out):
//   Left:   "Recommendation #N — Export <id-prefix>"
//   Center: "page N of M"
//   Right:  (intentionally empty — see paintFooter below for the 1.8
//            sec-F8 rationale).
//
// The footer's chainIdx column from the original ADR §3.8 was dropped
// in alignment with the 1.8 close-out: the predicted idx (computed
// pre-transaction by a non-locking MAX query) races the actual append()
// value under contention; the receipt panel on the recommendation
// detail view surfaces the canonical chainIdx out-of-band, and the
// chain row's outputSha256 is the integrity anchor regardless of what
// the footer prints. Better to print nothing than print stale data.
//
// Body marker expansion (ADR-0008 §3.3):
//   The encrypted body carries `[[cite:N]]` markers. The renderer parses
//   them at render time and emits a superscript "[N]" reference at the
//   marker's position, then renders a numbered footnote list after the
//   body. Orphan markers (no matching citation) render literally as
//   `[[cite:N]]` so the rep notices the problem at read time (matches
//   the web detail-view's BodyWithFootnotes posture).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { canonicalJsonStringify } from '@jhsc/audit';

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

export interface RenderableCitation {
  /** Matches the body's `[[cite:N]]` markers; 1-indexed. */
  readonly position: number;
  /** e.g. 'OHSA', 'CLC_PART_II'. */
  readonly statuteCode: string;
  /** Corpus clause uuid (string). */
  readonly clauseId: string;
  /** ISO date (YYYY-MM-DD) of the corpus version at submit time. */
  readonly versionDate: string;
  /** Human label e.g. "OHSA s.9(20)". */
  readonly clauseLabel: string;
  /**
   * The OUR-OWN-WORDS summary from `packages/legal-corpus` (PIPEDA-clean
   * per CLAUDE.md "Legal Reference Module Rules" #5). For
   * `third_party_restricted` statutes the caller passes the corpus
   * `body_summary`; for crown-copyright-open statutes the verbatim body.
   * The renderer does not branch on licence — that's the caller's job.
   */
  readonly clauseBody: string;
  /**
   * Hex SHA-256 of `clauseBody` — the provenance anchor (corpus-
   * amendment-invariant per T-R8). Printed as a small `[corpus hash: …]`
   * annotation on the footnote.
   */
  readonly clauseBodyHash: string;
}

export interface RenderableResponse {
  readonly position: number;
  /** ISO timestamp. */
  readonly receivedAt: string;
  /**
   * 8-char prefix of the receiving rep's user uuid. The rep does the
   * join offline if they need the full identity — PIPEDA-cleaner than
   * surfacing the full uuid in the disclosable PDF.
   */
  readonly receivedByUserIdPrefix: string;
  /** Decrypted external author role string (e.g. "VP Operations"). */
  readonly authorRole: string;
  /** Decrypted response prose. */
  readonly body: string;
}

export interface RenderableRecommendation {
  readonly id: string;
  /** Per-jurisdiction sequence number (1-indexed). */
  readonly recommendationNumber: number;
  readonly jurisdiction: 'ON' | 'CA-FED';
  /** Decrypted title. */
  readonly title: string;
  /** Decrypted body. Contains `[[cite:N]]` markers to be expanded. */
  readonly body: string;
  /** 8-char prefix of the drafting rep's user uuid (same rationale as receivedByUserIdPrefix). */
  readonly draftedByUserIdPrefix: string;
  readonly draftedAt: string;
  readonly submittedAt: string | null;
  /** ISO date (ON) or null (CA-FED has no fixed clock per s.135(6)). */
  readonly deadline: string | null;
  readonly resolvedAt: string | null;
  readonly withdrawnAt: string | null;
  /**
   * Withdrawal reason as the PI-clean enum value (template-supplied; the
   * rep's free-text reason is intentionally not exported per ADR-0008
   * §3.2). Null when status !== 'withdrawn'.
   */
  readonly withdrawnReason: string | null;
  readonly status: 'draft' | 'submitted' | 'response_received' | 'resolved' | 'withdrawn';
  readonly citations: ReadonlyArray<RenderableCitation>;
  readonly responses: ReadonlyArray<RenderableResponse>;
}

export interface ProvenanceFooter {
  readonly exportId: string;
  /** ISO timestamp. */
  readonly exportedAt: string;
  /**
   * audit_log.idx of the recommendation.exported chain row. Accepted
   * for back-compat with the original ADR §3.8 footer shape; the
   * running footer does NOT surface it (see paintFooter — sec-F8
   * close-out from 1.8 carries forward).
   */
  readonly chainIdx: number;
  /**
   * Placeholder for the pre-S5 footer-hash dance. ADR-0008 §3.8 simplified
   * this — the chain row's outputSha256 is the canonical anchor, no in-
   * PDF hash placeholder dance.
   */
  readonly outputSha256Placeholder: string;
  /**
   * Hex sha256 of the canonical-JSON of the resolved citations array
   * (including each clause body hash). Bound to the chain anchor per
   * ADR-0008 §3.8; the footer does NOT print it — it's a chain-payload
   * concern, not a printed-document concern.
   */
  readonly citationsHash: string;
}

export interface RenderOptions {
  /**
   * Optional override of the Source Serif 4 font directory. When unset
   * the module reads PDF_FONT_DIR from process.env; when neither is
   * set the renderer falls back to Helvetica. Caller-supplied path
   * takes precedence so the test harness can pin the font directory
   * without poking at env.
   */
  readonly fontDir?: string;
}

// ---------------------------------------------------------------------------
// Pure helper: canonical-JSON SHA-256 of the citations array. Exported
// for the route to compute the chain anchor's `citationsHash` AND for
// the unit test to assert determinism on identical inputs.
// ---------------------------------------------------------------------------

export function computeCitationsHash(citations: ReadonlyArray<RenderableCitation>): string {
  // Sort by position so the hash is order-invariant across callers — the
  // route SELECTs by ORDER BY position ASC, but defensive sort costs
  // nothing and bounds a future caller that passes unordered citations.
  const sorted = [...citations].sort((a, b) => a.position - b.position);
  const canon = canonicalJsonStringify(
    sorted.map((c) => ({
      position: c.position,
      statuteCode: c.statuteCode,
      clauseId: c.clauseId,
      versionDate: c.versionDate,
      clauseLabel: c.clauseLabel,
      // Include the body hash (not the body itself — the hash IS the
      // provenance anchor; including the body would bloat the canonical
      // string and make tiny corpus whitespace edits change the chain
      // anchor for materially identical content).
      clauseBodyHash: c.clauseBodyHash,
    })),
  );
  return createHash('sha256').update(canon).digest('hex');
}

// ---------------------------------------------------------------------------
// Font loading (same shape as the 1.8 inspection renderer).
// ---------------------------------------------------------------------------

function resolveFontPaths(fontDirOverride: string | undefined): {
  reg: string;
  bold: string;
  available: boolean;
} {
  const dir = (fontDirOverride ?? process.env.PDF_FONT_DIR ?? '').trim();
  if (dir === '') return { reg: '', bold: '', available: false };
  const reg = join(dir, 'SourceSerif4-Regular.otf');
  const bold = join(dir, 'SourceSerif4-Bold.otf');
  return { reg, bold, available: existsSync(reg) && existsSync(bold) };
}

function applyDefaultFont(
  doc: PDFKit.PDFDocument,
  paths: { reg: string; bold: string; available: boolean },
): void {
  if (paths.available) {
    try {
      doc.registerFont('serif', paths.reg);
      doc.registerFont('serif-bold', paths.bold);
      doc.font('serif');
      return;
    } catch {
      // fall through — keep the renderer robust against partial font
      // installs; the gate must run without the binary in CI.
    }
  }
  doc.font('Helvetica');
}

function fontBold(
  doc: PDFKit.PDFDocument,
  paths: { reg: string; bold: string; available: boolean },
): void {
  if (paths.available) {
    try {
      doc.font('serif-bold');
      return;
    } catch {
      // fall through
    }
  }
  doc.font('Helvetica-Bold');
}

function fontRegular(
  doc: PDFKit.PDFDocument,
  paths: { reg: string; bold: string; available: boolean },
): void {
  if (paths.available) {
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
// Layout constants
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 56; // ~0.78in — matches the 1.8 renderer
const STATUS_COLORS: Record<RenderableRecommendation['status'], { fill: string; label: string }> = {
  draft: { fill: '#52525b', label: 'Status — Draft' },
  submitted: { fill: '#1e3a8a', label: 'Status — Submitted' },
  response_received: { fill: '#b45309', label: 'Status — Response received' },
  resolved: { fill: '#15803d', label: 'Status — Resolved' },
  withdrawn: { fill: '#52525b', label: 'Status — Withdrawn' },
};

function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

function jurisdictionBadgeLabel(j: 'ON' | 'CA-FED'): string {
  return j === 'ON' ? 'Jurisdiction — Ontario (OHSA)' : 'Jurisdiction — Federal (CLC Part II)';
}

function withdrawnReasonLabel(reason: string): string {
  switch (reason) {
    case 'rescinded':
      return 'Rescinded';
    case 'superseded':
      return 'Superseded by a later recommendation';
    case 'addressed_pre_submission':
      return 'Addressed before submission';
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// Body marker expansion. Splits the body into runs of plain text and
// citation references; the caller renders each run with the appropriate
// font / baseline shift. The split itself is a pure function so the
// unit test can exercise it without spinning up pdfkit.
// ---------------------------------------------------------------------------

export type BodyRun =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'cite'; readonly position: number; readonly resolved: boolean };

const MARKER_REGEX = /\[\[cite:(\d+)\]\]/g;

export function expandBodyMarkers(body: string, citationPositions: ReadonlySet<number>): BodyRun[] {
  const out: BodyRun[] = [];
  let cursor = 0;
  for (const match of body.matchAll(MARKER_REGEX)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) out.push({ kind: 'text', value: body.slice(cursor, match.index) });
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1) {
      out.push({ kind: 'cite', position: n, resolved: citationPositions.has(n) });
    } else {
      // Bad marker — render literally so the rep notices.
      out.push({ kind: 'text', value: match[0] });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) out.push({ kind: 'text', value: body.slice(cursor) });
  return out;
}

// ---------------------------------------------------------------------------
// Cover block
// ---------------------------------------------------------------------------

function renderCover(
  doc: PDFKit.PDFDocument,
  rec: RenderableRecommendation,
  paths: ReturnType<typeof resolveFontPaths>,
): void {
  fontBold(doc, paths);
  doc
    .fontSize(20)
    .fillColor('#0f172a')
    .text(`Notice of Recommendation #${rec.recommendationNumber}`, {
      align: 'left',
    });
  fontRegular(doc, paths);
  doc.moveDown(0.4);

  // Identifier band — small tabular pairs (label / value).
  const rows: ReadonlyArray<[string, string]> = [
    ['Recommendation ID', shortId(rec.id)],
    [
      'Jurisdiction',
      rec.jurisdiction === 'ON' ? 'Ontario (OHSA)' : 'Canada Labour Code Part II (federal)',
    ],
    ['Drafted by', rec.draftedByUserIdPrefix],
    ['Drafted at', rec.draftedAt],
    ['Submitted at', rec.submittedAt ?? '—'],
    ['Status', rec.status],
  ];
  doc.fontSize(10).fillColor('#0f172a');
  const labelX = PAGE_MARGIN;
  const valueX = PAGE_MARGIN + 140;
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.fillColor('#64748b').text(label, labelX, y, { width: 130 });
    doc.fillColor('#0f172a').text(value, valueX, y, { width: 380 });
    doc.moveDown(0.4);
  }
  doc.moveDown(0.2);

  // Two small badges side by side — jurisdiction + status. Same visual
  // language as the inspection renderer's status badge.
  const badgeY = doc.y;
  const badgeHeight = 16;
  const jurisLabel = jurisdictionBadgeLabel(rec.jurisdiction);
  const statusInfo = STATUS_COLORS[rec.status];
  const jurisWidth = 220;
  const statusWidth = 220;
  doc
    .save()
    .rect(PAGE_MARGIN, badgeY, jurisWidth, badgeHeight)
    .fill(rec.jurisdiction === 'ON' ? '#1e3a8a' : '#0f766e')
    .restore();
  doc
    .fillColor('#ffffff')
    .fontSize(9)
    .text(jurisLabel, PAGE_MARGIN + 6, badgeY + 3, {
      width: jurisWidth - 12,
      lineBreak: false,
    });
  doc
    .save()
    .rect(PAGE_MARGIN + jurisWidth + 8, badgeY, statusWidth, badgeHeight)
    .fill(statusInfo.fill)
    .restore();
  doc
    .fillColor('#ffffff')
    .fontSize(9)
    .text(statusInfo.label, PAGE_MARGIN + jurisWidth + 14, badgeY + 3, {
      width: statusWidth - 12,
      lineBreak: false,
    });
  doc.fillColor('#0f172a');
  doc.y = badgeY + badgeHeight + 12;
  doc.x = PAGE_MARGIN;

  // Statutory anchor block (PI-clean — pure statute references, no rep
  // names or workplace names). Different copy per jurisdiction per
  // ADR-0008 §3.6.
  fontBold(doc, paths);
  doc.fontSize(11).fillColor('#0f172a').text('Statutory anchor', { align: 'left' });
  fontRegular(doc, paths);
  doc.moveDown(0.15);
  doc.fontSize(10).fillColor('#0f172a');
  if (rec.jurisdiction === 'ON') {
    const due = rec.deadline ? ` Deadline: ${rec.deadline}.` : '';
    doc.text(
      `Pursuant to OHSA s.9(20). Written response required within 21 days under s.9(21).${due}`,
      { align: 'left', width: doc.page.width - PAGE_MARGIN * 2 },
    );
  } else {
    doc.text(
      'Pursuant to CLC Part II s.135(5). Written response required as soon as possible under s.135(6).',
      { align: 'left', width: doc.page.width - PAGE_MARGIN * 2 },
    );
  }
  doc.moveDown(0.6);
}

// ---------------------------------------------------------------------------
// Title + body. Title is rendered larger; body expands [[cite:N]] markers
// to superscript "[N]" references.
// ---------------------------------------------------------------------------

function renderTitleAndBody(
  doc: PDFKit.PDFDocument,
  rec: RenderableRecommendation,
  paths: ReturnType<typeof resolveFontPaths>,
): void {
  if (doc.y > doc.page.height - PAGE_MARGIN - 120) doc.addPage();
  fontBold(doc, paths);
  doc
    .fontSize(14)
    .fillColor('#0f172a')
    .text(rec.title, {
      align: 'left',
      width: doc.page.width - PAGE_MARGIN * 2,
    });
  fontRegular(doc, paths);
  doc.moveDown(0.6);

  // Body with marker expansion. We render each run with continued: true
  // so consecutive text + cite + text flow as one paragraph wrap. The
  // citation run is rendered at a smaller font size and a baseline
  // shift (superscript), then we restore the body font.
  const positions = new Set(rec.citations.map((c) => c.position));
  const runs = expandBodyMarkers(rec.body, positions);
  doc.fontSize(11).fillColor('#0f172a');
  const bodyWidth = doc.page.width - PAGE_MARGIN * 2;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const last = i === runs.length - 1;
    if (run.kind === 'text') {
      doc.text(run.value, {
        continued: !last,
        width: bodyWidth,
        align: 'left',
      });
    } else {
      // Superscript reference. pdfkit doesn't expose a true superscript
      // primitive, so we drop the font size and let the natural baseline
      // approximate. Resolved markers render as `[N]` in primary color;
      // orphans render as the literal marker in amber so the rep notices.
      const text = run.resolved ? `[${run.position}]` : `[[cite:${run.position}]]`;
      doc.font(paths.available ? 'serif-bold' : 'Helvetica-Bold');
      doc.fontSize(8).fillColor(run.resolved ? '#1e3a8a' : '#b45309');
      doc.text(text, {
        continued: !last,
        width: bodyWidth,
        align: 'left',
      });
      // Restore body font for the next run.
      fontRegular(doc, paths);
      doc.fontSize(11).fillColor('#0f172a');
    }
  }
  doc.moveDown(0.8);
}

// ---------------------------------------------------------------------------
// Citation footnote section. Numbered list, body text verbatim from
// corpus, plus the [corpus hash: …] provenance annotation.
// ---------------------------------------------------------------------------

function renderCitationFootnotes(
  doc: PDFKit.PDFDocument,
  citations: ReadonlyArray<RenderableCitation>,
  paths: ReturnType<typeof resolveFontPaths>,
): void {
  if (citations.length === 0) return;
  if (doc.y > doc.page.height - PAGE_MARGIN - 120) doc.addPage();
  fontBold(doc, paths);
  doc.fontSize(12).fillColor('#0f172a').text('Citations', { align: 'left' });
  fontRegular(doc, paths);
  doc.moveDown(0.3);

  const sorted = [...citations].sort((a, b) => a.position - b.position);
  for (const c of sorted) {
    if (doc.y > doc.page.height - PAGE_MARGIN - 60) doc.addPage();
    fontBold(doc, paths);
    doc
      .fontSize(10)
      .fillColor('#0f172a')
      .text(`${c.position}. ${c.clauseLabel}`, {
        align: 'left',
        width: doc.page.width - PAGE_MARGIN * 2,
      });
    fontRegular(doc, paths);
    doc
      .fontSize(10)
      .fillColor('#0f172a')
      .text(c.clauseBody, {
        align: 'left',
        width: doc.page.width - PAGE_MARGIN * 2,
      });
    doc
      .fontSize(8)
      .fillColor('#64748b')
      .text(`[corpus hash: ${c.clauseBodyHash.slice(0, 12)}… · version ${c.versionDate}]`, {
        align: 'left',
        width: doc.page.width - PAGE_MARGIN * 2,
      });
    doc.fillColor('#0f172a');
    doc.moveDown(0.4);
  }
  doc.moveDown(0.4);
}

// ---------------------------------------------------------------------------
// Responses appendix. Append-only positional order. Subsection per
// response with header (position + received_at + author role + rep
// prefix) and body.
// ---------------------------------------------------------------------------

function renderResponses(
  doc: PDFKit.PDFDocument,
  responses: ReadonlyArray<RenderableResponse>,
  paths: ReturnType<typeof resolveFontPaths>,
): void {
  if (responses.length === 0) return;
  if (doc.y > doc.page.height - PAGE_MARGIN - 120) doc.addPage();
  fontBold(doc, paths);
  doc.fontSize(12).fillColor('#0f172a').text('Management responses', { align: 'left' });
  fontRegular(doc, paths);
  doc.moveDown(0.3);

  const sorted = [...responses].sort((a, b) => a.position - b.position);
  for (const r of sorted) {
    if (doc.y > doc.page.height - PAGE_MARGIN - 80) doc.addPage();
    fontBold(doc, paths);
    doc
      .fontSize(10)
      .fillColor('#0f172a')
      .text(`Response #${r.position} · received ${r.receivedAt}`, {
        align: 'left',
        width: doc.page.width - PAGE_MARGIN * 2,
      });
    fontRegular(doc, paths);
    doc
      .fontSize(9)
      .fillColor('#64748b')
      .text(`Author role: ${r.authorRole} · captured by ${r.receivedByUserIdPrefix}`, {
        align: 'left',
        width: doc.page.width - PAGE_MARGIN * 2,
      });
    doc.fillColor('#0f172a');
    doc.moveDown(0.2);
    doc.fontSize(10).text(r.body, {
      align: 'left',
      width: doc.page.width - PAGE_MARGIN * 2,
    });
    doc.moveDown(0.4);
  }
}

// ---------------------------------------------------------------------------
// Withdrawal block. Template-supplied enum reason, no free-text PI.
// ---------------------------------------------------------------------------

function renderWithdrawal(
  doc: PDFKit.PDFDocument,
  rec: RenderableRecommendation,
  paths: ReturnType<typeof resolveFontPaths>,
): void {
  if (rec.status !== 'withdrawn') return;
  if (doc.y > doc.page.height - PAGE_MARGIN - 80) doc.addPage();
  fontBold(doc, paths);
  doc.fontSize(12).fillColor('#0f172a').text('Withdrawal', { align: 'left' });
  fontRegular(doc, paths);
  doc.moveDown(0.3);
  doc
    .fontSize(10)
    .fillColor('#0f172a')
    .text(
      `Withdrawn on ${rec.withdrawnAt ?? '(unknown)'}. Reason: ${
        rec.withdrawnReason ? withdrawnReasonLabel(rec.withdrawnReason) : '(unspecified)'
      }.`,
      { align: 'left', width: doc.page.width - PAGE_MARGIN * 2 },
    );
  doc.moveDown(0.4);
}

// ---------------------------------------------------------------------------
// Provenance footer (running, on every page). Left + center only — see
// the header comment for the 1.8 sec-F8 close-out rationale.
// ---------------------------------------------------------------------------

function paintFooter(
  doc: PDFKit.PDFDocument,
  rec: RenderableRecommendation,
  provenance: ProvenanceFooter,
  pageNum: number,
  totalPages: number,
  paths: ReturnType<typeof resolveFontPaths>,
): void {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const y = pageHeight - PAGE_MARGIN + 10;
  fontRegular(doc, paths);
  doc.fontSize(8).fillColor('#64748b');

  const left = `Recommendation #${rec.recommendationNumber} — Export ${shortId(provenance.exportId)}`;
  const center = `page ${pageNum} of ${totalPages}`;

  doc.text(left, PAGE_MARGIN, y, {
    width: 280,
    align: 'left',
    lineBreak: false,
  });
  doc.text(center, PAGE_MARGIN, y, {
    width: pageWidth - PAGE_MARGIN * 2,
    align: 'center',
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

export async function renderRecommendationPdf(
  recommendation: RenderableRecommendation,
  provenance: ProvenanceFooter,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  const fontPaths = resolveFontPaths(opts.fontDir);
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    margin: PAGE_MARGIN,
    // T-R23 / T-I28: generic metadata. Never carry the recommendation
    // number, jurisdiction, status, or title in the /Title etc. fields —
    // those are the worst leak surface for the workplace identity.
    info: {
      Title: 'JHSC Notice of Recommendation',
      Author: 'JHSC Worker Hub',
      Producer: 'JHSC Worker Hub PDF Renderer',
      CreationDate: new Date(),
      // Subject / Keywords intentionally omitted.
    },
    pdfVersion: '1.4',
    compress: true,
  });

  // Begin collecting bytes BEFORE we emit content — pdfkit fires 'data'
  // events as content lands and we'd race the consumer otherwise.
  const collected = collectStream(doc);

  doc.addPage();
  applyDefaultFont(doc, fontPaths);

  renderCover(doc, recommendation, fontPaths);
  renderTitleAndBody(doc, recommendation, fontPaths);
  renderCitationFootnotes(doc, recommendation.citations, fontPaths);
  renderResponses(doc, recommendation.responses, fontPaths);
  renderWithdrawal(doc, recommendation, fontPaths);

  // Footer pass — with bufferPages: true we can re-visit every page and
  // stamp the running footer with the final totalPages.
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    paintFooter(doc, recommendation, provenance, i + 1, total, fontPaths);
  }

  doc.end();
  return await collected;
}
