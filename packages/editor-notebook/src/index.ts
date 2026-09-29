/**
 * @froglight/editor-notebook — replaceable notebook editor providers.
 *
 * Each document kind keeps its own `<Kind>DocumentEditorProvider` behind
 * this barrel; pager and page-surface machinery stay provider-internal
 * except for the explicitly shared integration surface below.
 */

export {
  NotebookDocumentEditorProvider,
  HeadlessNotebookEditorHandle,
  type NotebookDocumentEditorDeps,
} from './editor.js';
export {
  mountNotebook,
  NOTEBOOK_INK_COLORS,
  NOTEBOOK_INK_WIDTHS,
  NOTEBOOK_PAPER_LABELS,
  NOTEBOOK_PAPER_COLORS,
  NOTEBOOK_PAGE_SIZE_LABELS,
  type NotebookPagerHandle,
  type NotebookPagerOptions,
  type NotebookPagerSkeleton,
} from './pager.js';
export {
  NotebookChrome,
  type NotebookChromeProps,
} from './react/NotebookChrome.jsx';
export {
  PAGE_TOOL_IDS,
  mountPageSurface,
  type PageSurfaceHandle,
  type PageSurfaceOptions,
} from './page-surface.js';
export {
  exportSurfacePng,
  renderNotebookPreviewImages,
} from './pager/export.js';
export {
  insertNotebookEmbed,
  isNotebookEmbedDangling,
  isNotebookEmbedRecord,
  NOTEBOOK_EMBED_DEFAULT_SIZE,
  removeNotebookEmbed,
  replaceNotebookEmbedTarget,
  resolveNotebookEmbedPresentation,
  type NotebookEmbedPlacement,
} from './react/resource-embed.js';
