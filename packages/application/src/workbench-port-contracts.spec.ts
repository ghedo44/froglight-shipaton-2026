import {
  InMemorySearchService,
  latexKind,
  latexKindId,
  latexModel,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
  type DocumentEditorProvider,
  type DocumentId,
  type DocumentKindId,
  type DocumentReaderHandle,
  type DocumentReaderProvider,
} from '@froglight/foundation';
import {
  defineWorkbenchPortContracts,
  createWorkbenchDocumentPort,
  type WorkbenchContractFixture,
} from '@froglight/ui/testing';
import { createApp, createWorkbenchController } from './index.js';

function mockEditorProvider(kindId: DocumentKindId): DocumentEditorProvider {
  return {
    id: `contract-editor-${String(kindId)}`,
    kindIds: [kindId],
    createEditor() {
      return {
        focus() {
          /* contract double: focus is unobserved */
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        setReadOnly() {
          /* contract double: read-only state is unobserved */
        },
        flush() {
          /* contract double: persistence is unobserved */
        },
        revealAddress() {
          /* contract double: reveal target is unobserved */
        },
        destroy() {
          /* contract double: teardown is unobserved */
        },
      };
    },
  };
}

function mockReaderProvider(kindId: DocumentKindId): DocumentReaderProvider {
  return {
    id: `contract-reader-${String(kindId)}`,
    kindIds: [kindId],
    createReader(): DocumentReaderHandle {
      return {
        update() {
          /* contract double: rendering is unobserved */
        },
        revealAddress() {
          /* contract double: reveal target is unobserved */
        },
        destroy() {
          /* contract double: teardown is unobserved */
        },
      };
    },
  };
}

async function makeFixture(): Promise<
  WorkbenchContractFixture & { dispose(): Promise<void> }
> {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind, latexKind],
    documentEditorProviders: [
      mockEditorProvider(markdownKindId),
      mockEditorProvider(latexKindId),
    ],
    documentReaderProviders: [mockReaderProvider(markdownKindId)],
  });
  const controller = createWorkbenchController(app);
  const workspace = app.getWorkspace()!;
  // The shared contract suite must run against the real adapters, not
  // accidental structural compatibility: the documents port adapts the
  // host-bearing controller (`(path, undefined, opts)`), while the host
  // port carries host-bearing signatures directly.
  const documents = createWorkbenchDocumentPort(controller);
  return {
    state: controller,
    dock: controller,
    documents,
    reading: controller,
    tools: controller,
    host: controller,
    seedDocument: async (path: string, text = '') => {
      const tex = path.endsWith('.tex');
      const ref = await workspace.createDocument({
        kindId: tex ? latexKindId : markdownKindId,
        path: workspacePath(path),
        initialModel: tex ? latexModel(text) : markdownModel(text),
      });
      return String(ref.documentId);
    },
    hostObject: () => ({}),
    deleteDocumentExternally: async (documentId: string) => {
      await workspace.removeDocument(documentId as DocumentId);
    },
    dispose: () => app.dispose(),
  };
}

defineWorkbenchPortContracts(makeFixture);
