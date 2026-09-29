/**
 * Notebook surface-text selection state (shared).
 *
 * Thin provider-local re-export of the shared foundation derivation
 * (`deriveSurfaceTextSelectionState`). The pager calls this for the toolbar
 * snapshot; the shared builder carries the result into control shapes. The
 * single foundation implementation keeps Notebook, Ink, and Whiteboard read
 * semantics identical; only provider-owned control ids differ.
 */

export { deriveSurfaceTextSelectionState } from '@froglight/foundation';
