import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
  type DocumentEditorProvider,
} from '@froglight/foundation';
import { createApp, createWorkbenchController } from './index.js';

interface EditorSpy {
  readonly destroyedIds: string[];
  destroyedCount(): number;
}

function spyProvider(): { provider: DocumentEditorProvider; spy: EditorSpy } {
  const destroyed: string[] = [];
  let counter = 0;
  const provider: DocumentEditorProvider = {
    id: 'spy-editor',
    kindIds: [markdownKindId],
    createEditor({ session }) {
      const id = String(session.document.documentId);
      return {
        focus() {
          return undefined;
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        destroy() {
          destroyed.push(id);
          counter += 1;
        },
      };
    },
  };
  return {
    provider,
    spy: { destroyedIds: destroyed, destroyedCount: () => counter },
  };
}

async function setup() {
  const { provider, spy } = spyProvider();
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentEditorProviders: [provider],
  });
  const controller = createWorkbenchController(app);
  const workspace = app.getWorkspace()!;
  const alpha = await workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath('alpha.md'),
    initialModel: markdownModel('# Alpha'),
  });
  const beta = await workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath('beta.md'),
    initialModel: markdownModel('# Beta'),
  });
  return {
    app,
    controller,
    spy,
    alphaId: String(alpha.documentId),
    betaId: String(beta.documentId),
  };
}

describe('workbench controller panes', () => {
  it('keeps two live sessions when a second pane opens its own document', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    expect(controller.state.activeDocumentId).toBe(alphaId);

    await controller.openDocument(betaId, {}, { pane: 'second' });

    expect(controller.focusedPane).toBe('second');
    expect(controller.state.activeDocumentId).toBe(betaId);
    expect(controller.getPaneText('main')).toContain('Alpha');
    expect(controller.getPaneText('second')).toContain('Beta');
    expect(controller.paneStates().length).toBe(2);

    await app.dispose();
  });

  it('closing the split disposes only that pane and refocuses main', async () => {
    const { app, controller, spy, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'second' });

    await controller.closePane('second');

    expect(controller.paneStates().length).toBe(1);
    expect(controller.focusedPane).toBe('main');
    expect(controller.state.activeDocumentId).toBe(alphaId);
    expect(spy.destroyedIds.filter((id) => id === betaId).length).toBe(1);

    await app.dispose();
  });

  it('opening into an existing pane replaces exactly that pane', async () => {
    const { app, controller, spy, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'second' });
    const gamma = await createDoc(app, 'gamma.md', '# Gamma');
    await controller.openDocument(String(gamma), {}, { pane: 'second' });

    expect(controller.getPaneText('main')).toContain('Alpha');
    expect(controller.getPaneText('second')).toContain('Gamma');
    expect(spy.destroyedIds.filter((id) => id === betaId).length).toBe(1);

    await app.dispose();
  });

  it('serializes overlapping opens so one pane owns exactly one editor root', async () => {
    const live = new Set<object>();
    const parent = { roots: new Set<object>() };
    const provider: DocumentEditorProvider = {
      id: 'mounted-editor',
      kindIds: [markdownKindId],
      createEditor({ parent }) {
        const root = {};
        (parent as { roots: Set<object> }).roots.add(root);
        live.add(root);
        return {
          focus: () => undefined,
          hasFocus: () => false,
          execCommand: () => false,
          destroy() {
            live.delete(root);
            (parent as { roots: Set<object> }).roots.delete(root);
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
    const workspace = app.getWorkspace()!;
    const alpha = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('concurrent-alpha.md'),
      initialModel: markdownModel('# Alpha'),
    });
    const beta = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('concurrent-beta.md'),
      initialModel: markdownModel('# Beta'),
    });
    await Promise.all([
      controller.openDocument(String(alpha.documentId), parent),
      controller.openDocument(String(beta.documentId), parent),
    ]);

    expect(parent.roots).toHaveLength(1);
    expect(live).toHaveLength(1);
    expect(controller.paneStates()[0]?.documentId).toBe(
      String(beta.documentId),
    );
    await app.dispose();
  });

  it('keeps a pane occupied while a dirty document is replaced', async () => {
    const provider: DocumentEditorProvider = {
      id: 'dirty-editor',
      kindIds: [markdownKindId],
      createEditor({ session }) {
        let pending = true;
        return {
          focus: () => undefined,
          hasFocus: () => false,
          execCommand: () => false,
          flush: () => {
            // Consume buffered input once; an empty flush is not a new edit.
            if (!pending) return;
            pending = false;
            session.markDirty();
          },
          destroy: () => undefined,
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
    const workspace = app.getWorkspace()!;
    const alpha = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('dirty-alpha.md'),
      initialModel: markdownModel('# Alpha'),
    });
    const beta = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('dirty-beta.md'),
      initialModel: markdownModel('# Beta'),
    });
    await controller.openDocument(String(alpha.documentId), {});

    const originalOpen = workspace.openDocument.bind(workspace);
    let releaseBeta!: () => void;
    let reachedBeta!: () => void;
    const betaGate = new Promise<void>((resolve) => (releaseBeta = resolve));
    const betaReached = new Promise<void>((resolve) => (reachedBeta = resolve));
    workspace.openDocument = async (documentId) => {
      if (String(documentId) === String(beta.documentId)) {
        reachedBeta();
        await betaGate;
      }
      return originalOpen(documentId);
    };

    const switching = controller.openDocument(String(beta.documentId), {});
    await betaReached;

    // React's reconciler runs during this exact gap. The pane must remain
    // occupied so it cannot enqueue the old active tab behind this switch.
    expect(controller.isPaneActive('main')).toBe(true);

    releaseBeta();
    await switching;
    expect(controller.paneStates()[0]?.documentId).toBe(
      String(beta.documentId),
    );
    await app.dispose();
  });

  it('focusPane retargets save/state operations without touching sessions', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'second' });

    controller.focusPane('main');
    expect(controller.state.activeDocumentId).toBe(alphaId);
    controller.focusPane('second');
    expect(controller.state.activeDocumentId).toBe(betaId);

    await app.dispose();
  });

  it('deleting a document empties every pane showing it', async () => {
    const { app, controller, alphaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(alphaId, {}, { pane: 'second' });

    await controller.deleteDocument(alphaId);

    expect(
      controller.paneStates().every((pane) => pane.documentId === null),
    ).toBe(true);
    expect(controller.getPaneText('main')).toBeNull();

    await app.dispose();
  });

  it('closeVaultView tears down all panes at once', async () => {
    const { app, controller, spy, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'second' });

    await controller.closeVaultView();

    // The dock tree keeps its (empty) structure; every live session is gone.
    expect(
      controller.paneStates().every((pane) => pane.documentId === null),
    ).toBe(true);
    expect(spy.destroyedCount()).toBe(2);
    expect(controller.state.activeDocumentId).toBeNull();

    await app.dispose();
  });
});

async function createDoc(
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  body: string,
): Promise<string> {
  const workspace = app.getWorkspace()!;
  const ref = await workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath(path),
    initialModel: markdownModel(body),
  });
  return String(ref.documentId);
}
