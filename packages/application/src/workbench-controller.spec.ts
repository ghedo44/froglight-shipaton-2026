import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@froglight/runtime';
import {
  InMemorySearchService,
  blockPageKind,
  blockPageKindId,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  documentEditorRegistryToken,
  type DocumentSession,
  type BlockPageModel,
  type DocumentEditorProvider,
} from '@froglight/foundation';
import { createApp, createWorkbenchController } from './index.js';

describe('generic document editor routing', () => {
  it('recovers the open pane after editor withdrawal without replacing its session', async () => {
    const opened: DocumentSession[] = [];
    let live = 0;
    const provider: DocumentEditorProvider = {
      id: 'test.recoverable',
      kindIds: [markdownKindId],
      createEditor({ session }) {
        opened.push(session);
        live++;
        let destroyed = false;
        return {
          focus() {
            /* no-op test stub */
          },
          hasFocus: () => false,
          execCommand: () => false,
          destroy() {
            if (!destroyed) {
              destroyed = true;
              live--;
            }
          },
        };
      },
    };
    const plugin = definePlugin({
      id: 'test.recoverable',
      requirements: { requires: [documentEditorRegistryToken] },
      activate(ctx) {
        ctx.effect(
          () =>
            ctx.require(documentEditorRegistryToken).register(provider).dispose,
        );
      },
    });
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
    });
    const controller = createWorkbenchController(app);
    try {
      await controller.initialize({});
      const documentId = controller.state.activeDocumentId;
      expect(live).toBe(0);
      expect(controller.paneStates()[0]?.editorAvailable).toBe(false);
      await app.runtime.registerSlot({ id: 'recoverable', plugin });
      expect(live).toBe(1);
      await app.runtime.removeSlot('recoverable');
      expect(live).toBe(0);
      expect(controller.state.activeDocumentId).toBe(documentId);
      await app.runtime.registerSlot({ id: 'recoverable', plugin });
      expect(live).toBe(1);
      expect(opened).toHaveLength(2);
      expect(opened[1]).toBe(opened[0]);
    } finally {
      await controller.dispose();
      await app.dispose();
    }
    expect(live).toBe(0);
  });
  it('does not report a missing editor while a tab switch is reopening its document', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
    });
    const controller = createWorkbenchController(app);
    try {
      await controller.initialize({});
      const firstDocument = controller.state.activeDocumentId;
      if (firstDocument === null) throw new Error('Expected an initial document');
      await controller.createAndOpen('notes/second.md', {});

      const workspace = app.getWorkspace();
      if (workspace === null) throw new Error('Expected an active workspace');
      const openDocument = workspace.openDocument.bind(workspace);
      const publishedLoadingStates: boolean[] = [];
      const subscription = controller.onDidChange(() => {
        const state = controller.paneStates()[0];
        if (state !== undefined) {
          publishedLoadingStates.push(state.editorLoading === true);
        }
      });
      let releaseOpen!: () => void;
      let announceOpenStarted!: () => void;
      const openGate = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      const openStarted = new Promise<void>((resolve) => {
        announceOpenStarted = resolve;
      });
      const openSpy = vi
        .spyOn(workspace, 'openDocument')
        .mockImplementation(async (...args) => {
          announceOpenStarted();
          await openGate;
          return openDocument(...args);
        });

      try {
        const switching = controller.activateTab('main', firstDocument);
        await openStarted;

        expect(controller.paneStates()[0]?.activeTab).toBe(firstDocument);
        expect(controller.paneStates()[0]?.editorAvailable).toBe(false);
        expect(controller.paneStates()[0]?.editorLoading).toBe(true);

        releaseOpen();
        await switching;
        expect(controller.paneStates()[0]?.editorAvailable).toBe(false);
        expect(controller.paneStates()[0]?.editorLoading).toBe(false);
        expect(publishedLoadingStates).toContain(true);
        expect(publishedLoadingStates.at(-1)).toBe(false);
      } finally {
        subscription.dispose();
        releaseOpen();
        openSpy.mockRestore();
      }
    } finally {
      await controller.dispose();
      await app.dispose();
    }
  });
  it('opens a document with the provider registered for its kind and closes the vault completely', async () => {
    let focused = false;
    let destroyed = false;
    const provider: DocumentEditorProvider = {
      id: 'test-markdown-editor',
      kindIds: [markdownKindId],
      createEditor() {
        return {
          focus() {
            focused = true;
          },
          hasFocus() {
            return focused;
          },
          execCommand() {
            return false;
          },
          destroy() {
            destroyed = true;
          },
        };
      },
    };

    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentEditorProviders: [provider],
    });
    const controller = createWorkbenchController(app);

    await controller.initialize({});
    expect(focused).toBe(false);
    controller.focusPane('main');
    expect(focused).toBe(true);
    expect(controller.state.activeDocumentTitle).toBe('welcome.md');
    expect(controller.state.activeDocumentPath).toBe('notes/welcome.md');
    expect(app.getDocumentEditor(markdownKindId)?.id).toBe(
      'test-markdown-editor',
    );

    await controller.createAndOpen('notes/second.md', {});
    expect(controller.state.activeDocumentTitle).toBe('second.md');
    expect(destroyed).toBe(true);

    await controller.closeVaultView();
    expect(app.getWorkspace()).toBeNull();
    expect(controller.state.activeDocumentId).toBeNull();
    await app.dispose();
  });

  it('createAndOpen honors a non-Markdown kind and seeds its canonical model', async () => {
    let destroyed = false;
    const markdownProvider: DocumentEditorProvider = {
      id: 'test-markdown-editor',
      kindIds: [markdownKindId],
      createEditor() {
        return {
          focus() {
            // Focusing the Markdown provider is not observable here; the
            // assertion below tracks the block provider's destroy instead.
          },
          hasFocus() {
            return false;
          },
          execCommand() {
            return false;
          },
          destroy() {
            destroyed = false;
          },
        };
      },
    };
    const blockProvider: DocumentEditorProvider = {
      id: 'test-block-editor',
      kindIds: [blockPageKindId],
      createEditor() {
        return {
          focus() {
            // No-op; see the Markdown provider above.
          },
          hasFocus() {
            return false;
          },
          execCommand() {
            return false;
          },
          destroy() {
            destroyed = true;
          },
        };
      },
    };

    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, blockPageKind],
      documentEditorProviders: [markdownProvider, blockProvider],
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});

    const created = await controller.createAndOpen(
      'pages/Spec.blockpage',
      {},
      { kindId: blockPageKindId },
    );
    expect(created).not.toBeNull();
    expect(controller.state.activeDocumentPath).toBe('pages/Spec.blockpage');
    expect(app.getDocumentEditor(blockPageKindId)?.id).toBe(
      'test-block-editor',
    );

    const workspace = app.getWorkspace()!;
    const session = await workspace.openDocument(created!.documentId);
    const model = session.model as BlockPageModel;
    expect(model.meta.title).toBe('Spec');
    expect(model.rootOrder.length).toBe(1);

    await session.close();
    await controller.closeVaultView();
    expect(destroyed).toBe(true);
    await app.dispose();
  });
});


it('reports reattachment during vault teardown through its Promise contract', async () => {
  const app = await createApp({ vaultPlugin: memoryVaultPlugin, vaultConfig: {} });
  const controller = createWorkbenchController(app);
  await controller.initialize({});
  const closing = controller.closeVaultView();
  await expect(controller.reattachPane('main', {})).rejects.toThrow('admission is closed');
  await closing;
  expect(app.getWorkspace()).toBeNull();
  await controller.dispose();
  await app.dispose();
});
