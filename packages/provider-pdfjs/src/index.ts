/**
 * @froglight/provider-pdfjs — replaceable PDF render + editor providers.
 *
 * The render capability (`pdf-provider.ts`, `PdfJsProvider`) and the
 * standalone-PDF editing surface (`editor.ts`,
 * `PdfDocumentEditorProvider`) share only the PDF.js engine dependency.
 * Each side keeps its own module behind this barrel; no PDF.js types cross
 * the document seams.
 */

export {
  PdfJsProvider,
  pdfJsWorkerUrl,
  renderPdfPreviewImage,
} from './pdf-provider.js';
export {
  PdfDocumentEditorProvider,
  type PdfDocumentEditorDeps,
  type PdfReaderHandle,
  type PdfReaderSearchHit,
} from './editor.js';
export {
  PdfReaderSkeleton,
  type PdfReaderSkeletonProps,
  type PdfSkeleton,
} from './react/PdfReaderSkeleton.jsx';
