/**
 * Markdown feature barrel — portable, host-agnostic.
 * No CodeMirror/ProseMirror/DOM imports.
 */
export { markdownKindId, markdownKind } from './kind.js';
export { markdownModel, type MarkdownModel } from './model.js';
export { decodeMarkdown, encodeMarkdown, fallbackTitleFromPath, resolveMarkdownRelationships } from './codec.js';
export { parseFrontmatter, serializeFrontmatter, type FrontmatterResult } from './frontmatter.js';
export { extractHeadings, extractBlocks, buildAddressIndex, slugify, type HeadingInfo, type BlockInfo } from './addressing.js';
export { extractLinks, extractTags, type ExtractedLink, type LinkKind } from './links.js';
export { extractMarkdownMetadata } from './metadata.js';
export { extractMarkdownRelationships, resolveMarkdownHrefToRef } from './relationships.js';
export { projectMarkdownForSearch, tokenize, type SearchDocument } from './search.js';
export { searchMarkdownImageFiles } from './image-files.js';
