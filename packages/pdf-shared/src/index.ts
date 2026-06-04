// @jhsc/pdf-shared — shared pdfkit primitives for evidentiary PDFs.
//
// Promised in ADR-0008 §S4 (the inspections-vs-recommendations
// renderer extraction that never landed) and now ships in M2.3 §3.2.2
// as the foundation for the minutes-document renderer + the S2 refactor
// of the inspections + recommendations renderers.
//
// Re-exports the seven sub-modules at the package root for consumers
// who prefer `import { renderHeader, renderFooter } from '@jhsc/pdf-shared'`
// over the per-module imports.

export {
  PDF_TYPOGRAPHY,
  registerAllFonts,
  resolveFont,
  applyFont,
  type FontFamily,
  type FontRegistration,
} from './fonts';

export {
  PAGE_DIMENSIONS,
  pdfkitSizeFor,
  type DocumentPageSize,
  type PageDimensions,
} from './page-size';

export { renderHeader, type HeaderMeta } from './header';
export { renderFooter, type FooterMeta } from './footer';
export { renderChainReceipt, type ChainReceiptMeta } from './chain-receipt';
export { renderSignaturePanel, type SignaturePanelRow } from './signature-panel';
export {
  renderRetentionStatement,
  type Jurisdiction,
  type RetentionCorpusEntry,
  type RetentionStatementMeta,
} from './retention-statement';
