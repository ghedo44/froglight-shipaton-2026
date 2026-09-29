/** Document outline extractors + registry. Headless, engine-free.*/

export type {
  DocumentOutlineEntry,
  OutlineExtractInput,
  OutlineExtractor,
} from './types.js';
export { extractMarkdownOutline, markdownOutlineExtractor } from './markdown.js';
export {
  extractBlockPageOutline,
  blockPageOutlineExtractor,
} from './blockpage.js';
export { extractNotebookOutline, notebookOutlineExtractor } from './notebook.js';
export { extractLatexOutline, latexOutlineExtractor } from './latex.js';
export { pdfOutlineExtractor } from './pdf.js';
export {
  InMemoryOutlineRegistry,
  MAX_OUTLINE_CACHE_SLOTS,
  firstPartyOutlineExtractors,
  outlineRegistryToken,
  outlineRegistryPlugin,
  outlineExtractorsPlugin,
  type OutlineCacheStats,
  type OutlineRegistry,
} from './registry.js';
