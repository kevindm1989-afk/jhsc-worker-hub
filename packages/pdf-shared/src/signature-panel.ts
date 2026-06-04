// Signature panel primitive (ADR-0014 §3.2.5 step 7 / ADR-0012 §3.9).
//
// Renders a sequence of attestation blocks, one per signer. Each block:
//   - Role label (from env-driven config; passed in by caller)
//   - Signer display name (decrypted server-side; passed in)
//   - signed_at + signed_method
//   - Workplace-key attestation signature hash (truncated, JetBrains Mono)
//
// Neutral evidentiary framing per non-negotiable #7 — no "approval"
// or "endorsement" copy; this is a JHSC counter-sign attestation
// record, not management approval.

import { PDF_TYPOGRAPHY, applyFont } from './fonts';

export interface SignaturePanelRow {
  readonly roleLabel: string;
  readonly signerNameDecrypted: string;
  readonly signedAt: string;
  readonly signedMethod: string;
  /** Hex SHA-256 of the workplace-key Ed25519 attestation signature. */
  readonly attestationSigHash: string;
}

/**
 * Paint the signature panel — N rows in vertical stack. Caller
 * controls cursor; primitive advances it past the panel.
 */
export function renderSignaturePanel(
  doc: PDFKit.PDFDocument,
  rows: ReadonlyArray<SignaturePanelRow>,
): void {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableWidth = right - left;

  // Heading.
  applyFont(doc, 'sans-bold');
  doc.fontSize(PDF_TYPOGRAPHY.headerSize).fillColor('#18181b');
  doc.text('Signatures', left, doc.y);
  doc.moveDown(0.4);

  for (const row of rows) {
    // Row top — light separator.
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#e4e4e7').lineWidth(0.3).stroke();
    doc.moveDown(0.2);

    // Role + name on one line.
    applyFont(doc, 'sans-bold');
    doc.fontSize(PDF_TYPOGRAPHY.bodySize).fillColor('#18181b');
    doc.text(row.roleLabel, left, doc.y, { width: usableWidth * 0.4, continued: true });
    applyFont(doc, 'serif');
    doc.text(`  ${row.signerNameDecrypted}`, { continued: false });

    // Method + signed-at on second line.
    applyFont(doc, 'sans');
    doc.fontSize(PDF_TYPOGRAPHY.labelSize).fillColor('#52525b');
    doc.text(`${row.signedMethod} · ${row.signedAt}`, left, doc.y + 1);

    // Attestation sig hash truncated.
    applyFont(doc, 'mono');
    doc.fontSize(PDF_TYPOGRAPHY.monoSize).fillColor('#71717a');
    const truncated =
      row.attestationSigHash.length > 16
        ? row.attestationSigHash.slice(0, 16)
        : row.attestationSigHash;
    doc.text(`attestation sig: ${truncated}…`, left, doc.y + 1);

    doc.moveDown(0.4);
  }

  // Reset.
  applyFont(doc, 'serif');
  doc.fontSize(PDF_TYPOGRAPHY.bodySize).fillColor('#18181b');
}
