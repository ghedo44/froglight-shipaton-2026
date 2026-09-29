/**
 * @froglight/editor-blockpage — replaceable block-page editor providers.
 *
 * Each document kind keeps its own `<Kind>DocumentEditorProvider` behind
 * this barrel; no Tiptap/ProseMirror type crosses the seam.
 */

export { BlockPageDocumentEditorProvider } from './editor.js';
export { blockPageKindId } from '@froglight/foundation';
export type {
  BlockPageEditorHandle,
  BlockPageEditorInput,
  BlockPageEditorProvider,
} from '@froglight/foundation';

export { BlockpageHostSkeleton, type BlockpageSkeleton, type BlockpageHostSkeletonProps } from './react/BlockpageHostSkeleton.jsx';
