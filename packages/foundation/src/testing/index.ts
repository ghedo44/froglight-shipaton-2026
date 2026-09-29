/**
 * Test-only exports for the foundation package.
 *
 * Imported via the `@froglight/foundation/testing` subpath. Nothing in this
 * module is part of the production surface.
 */

export { registerVaultContractSuite } from './contract-suite-vitest.js';
export { requireValue } from './require-value.js';
export { testNoteKind, testNoteKindId, testNoteModel, type TestDocModel, type TestDocLink } from './test-note.js';
export {
  composeWorkspace,
  replaceVaultProvider,
  testDocumentsPluginFactory,
  type ComposeWorkspaceOptions,
  type ComposedWorkspace,
  type TestDocumentsPluginConfig,
  type TestDocumentsPluginHooks,
} from './compose.js';
export { CodemirrorStubProvider } from './codemirror-stub.js';
export {
  MockMarkdownEditorHandle,
  MockMarkdownEditorProvider,
} from './mock-editor.js';
export { SnapshotHandleBase } from './block-editor-base.js';
export { TiptapStubProvider, TiptapStubHandle } from './tiptap-stub.js';
export {
  MockBlockPageEditorHandle,
  MockBlockPageEditorProvider,
} from './mock-block-editor.js';
export {
  MockInkEditorHandle,
  MockInkEditorProvider,
} from './mock-ink-editor.js';
export { RecordingSurfaceBackend, type RecordedRenderOp } from './headless-surface-backend.js';
export {
  MockHandwritingRecognizer,
} from './mock-handwriting-recognizer.js';
export {
  MockNotebookEditorHandle,
  MockNotebookEditorProvider,
} from './mock-notebook-editor.js';
export {
  MockWhiteboardEditorHandle,
  MockWhiteboardEditorProvider,
} from './mock-whiteboard-editor.js';
export { createMockSurfaceTools } from './mock-surface-tools.js';
export { installCanvasStub } from './canvas-stub.js';
export {
  MockPdfProvider,
  type MockPdfFixture,
  type MockPdfPageFixture,
} from './mock-pdf.js';

export {
  MockLaTeXProvider,
  type MockLaTeXFixture,
} from './mock-latex.js';

export { createTestErasurePreparation } from './erasure-preparation.js';
