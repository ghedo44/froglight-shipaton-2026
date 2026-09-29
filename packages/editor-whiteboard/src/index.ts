/**
 * @froglight/editor-whiteboard — replaceable whiteboard editor providers.
 *
 * Each document kind keeps its own `<Kind>DocumentEditorProvider` behind
 * this barrel; whiteboards reuse the shared ink surface engine rather than
 * growing a second drawing stack (no second canvas engine).
 */

export { WhiteboardDocumentEditorProvider } from './editor.js';
export { WHITEBOARD_TOOL_IDS } from './editor.js';
export { renderInkPreviewImage as renderWhiteboardPreviewImage } from '@froglight/editor-ink';
export {
  insertWhiteboardEmbed,
  isWhiteboardEmbedDangling,
  isWhiteboardEmbedRecord,
  removeWhiteboardEmbed,
  replaceWhiteboardEmbedTarget,
  resolveWhiteboardEmbedPresentation,
  WHITEBOARD_EMBED_DEFAULT_SIZE,
  type WhiteboardEmbedPlacement,
  type WhiteboardEmbedPoint,
} from './resource-embed.js';
