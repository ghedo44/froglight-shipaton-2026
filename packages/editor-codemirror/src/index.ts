/**
 * @froglight/editor-codemirror — replaceable CodeMirror 6 document providers.
 *
 * Markdown editing (`markdown.ts`) and LaTeX source editing plus its
 * reading-view preview (`latex.ts`, `latex-reader.ts`) share only the
 * CodeMirror engine dependency. Each document kind keeps its own
 * `<Kind>DocumentEditorProvider` behind this barrel; no CodeMirror type
 * crosses the seam.
 */

export {
  MarkdownDocumentEditorProvider,
  parseWikiLinks,
  type MarkdownEditorHandle,
  type MarkdownEditorProvider,
  type MarkdownSkeleton,
  type ParsedWikiLink,
} from './markdown.js';
export {
  LatexDocumentEditorProvider,
  type LatexDocumentEditorDeps,
  type LatexEditorSkeleton,
} from './latex.js';
export {
  LatexDocumentReaderProvider,
  type LatexDocumentReaderDeps,
  type LatexReaderSkeleton,
} from './latex-reader.js';
export {
  CodemirrorMarkdownSkeleton,
  type CodemirrorMarkdownSkeletonProps,
} from './react/CodemirrorMarkdownSkeleton.jsx';
export {
  LatexEditorSkeleton as LatexEditorSkeletonView,
  type LatexEditorSkeletonProps,
} from './react/LatexEditorSkeleton.jsx';
export {
  LatexReaderSkeleton as LatexReaderSkeletonView,
  type LatexReaderSkeletonProps,
} from './react/LatexReaderSkeleton.jsx';
export { PREVIEW_SANDBOX, type LatexRenderDeps } from './latex-shared.js';
