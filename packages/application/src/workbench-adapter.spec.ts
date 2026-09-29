import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  emptyNotebook,
  inkPageKind,
  inkPageKindId,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  notebookKind,
  notebookKindId,
  whiteboardKind,
  whiteboardKindId,
  workspacePath,
  type DocumentEditorProvider,
  type DocumentKindId,
} from '@froglight/foundation';
import { createWorkbenchDocumentPort } from '@froglight/ui/testing';
import { createApp, createWorkbenchController } from './index.js';

function mockEditorProvider(kindId: DocumentKindId): DocumentEditorProvider {
  return {
    id: `adapter-editor-${String(kindId)}`,
    kindIds: [kindId],
    createEditor() {
      return {
        focus() {
          /* test double: focus is unobserved */
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        destroy() {
          /* test double: teardown is unobserved */
        },
      };
    },
  };
}

async function makeApp() {
  return createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind, notebookKind, inkPageKind, whiteboardKind],
    documentEditorProviders: [
      mockEditorProvider(markdownKindId),
      mockEditorProvider(notebookKindId),
      mockEditorProvider(inkPageKindId),
      mockEditorProvider(whiteboardKindId),
    ],
  });
}

describe('workbench document-port adapters', () => {
  it('creating a Notebook through the UI document port creates notebookKindId', async () => {
    const app = await makeApp();
    const controller = createWorkbenchController(app);
    const documents = createWorkbenchDocumentPort(controller);
    try {
      const created = (await documents.createAndOpen('notes/ideas.notebook', {
        kindId: String(notebookKindId),
      })) as { documentId: string };
      const listed = controller
        .listDocuments()
        .find((doc) => doc.documentId === created.documentId);
      expect(listed?.kindId).toBe(notebookKindId);
    } finally {
      await app.dispose();
    }
  });

  it('preserves non-Markdown kinds (Ink/Whiteboard)', async () => {
    const app = await makeApp();
    const controller = createWorkbenchController(app);
    const documents = createWorkbenchDocumentPort(controller);
    try {
      const ink = (await documents.createAndOpen('sketch.ink', {
        kindId: String(inkPageKindId),
      })) as { documentId: string };
      const board = (await documents.createAndOpen('board.whiteboard', {
        kindId: String(whiteboardKindId),
      })) as { documentId: string };
      const byId = new Map(
        controller.listDocuments().map((doc) => [doc.documentId, doc]),
      );
      expect(byId.get(ink.documentId)?.kindId).toBe(inkPageKindId);
      expect(byId.get(board.documentId)?.kindId).toBe(whiteboardKindId);
    } finally {
      await app.dispose();
    }
  });

  it('forwards explicit target pane options', async () => {
    const app = await makeApp();
    const controller = createWorkbenchController(app);
    const documents = createWorkbenchDocumentPort(controller);
    try {
      const second = controller.splitPane('main', 'right');
      const created = (await documents.createAndOpen('notes/pinned.md', {
        pane: second,
      })) as { documentId: string };
      const panes = controller.paneStates();
      const target = panes.find((pane) => pane.pane === second);
      expect(target?.documentId).toBe(created.documentId);
    } finally {
      await app.dispose();
    }
  });

  it('never stores the options object as an editor host', async () => {
    const app = await makeApp();
    const controller = createWorkbenchController(app);
    const documents = createWorkbenchDocumentPort(controller);
    try {
      const opts = { kindId: String(notebookKindId) };
      const created = (await documents.createAndOpen(
        'notes/host-check.notebook',
        opts,
      )) as { documentId: string };
      expect(created.documentId).toBeTypeOf('string');
      // The options object must not become the pane's editor host.
      expect(controller.isPaneAttached('main', opts)).toBe(false);
      // The created kind must still be Notebook (not Markdown fallback).
      const listed = controller
        .listDocuments()
        .find((doc) => doc.documentId === created.documentId);
      expect(listed?.kindId).toBe(notebookKindId);
    } finally {
      await app.dispose();
    }
  });

  it('forwards openDocument pane and address without storing opts as host', async () => {
    const app = await makeApp();
    const controller = createWorkbenchController(app);
    const documents = createWorkbenchDocumentPort(controller);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: notebookKindId,
        path: workspacePath('notes/target.notebook'),
        initialModel: emptyNotebook('target'),
      });
      const documentId = String(ref.documentId);
      const second = controller.splitPane('main', 'right');
      const opts = { pane: second };
      await documents.openDocument(documentId, opts);
      const panes = controller.paneStates();
      expect(panes.find((pane) => pane.pane === second)?.documentId).toBe(
        documentId,
      );
      expect(controller.isPaneAttached(second, opts)).toBe(false);
    } finally {
      await app.dispose();
    }
  });
});
