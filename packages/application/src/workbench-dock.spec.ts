import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
  type DocumentEditorProvider,
} from '@froglight/foundation';
import { MockMarkdownEditorProvider } from '@froglight/foundation/testing';
import { createApp, createWorkbenchController } from './index.js';

function spyProvider(): {
  provider: DocumentEditorProvider;
  destroyed: string[];
  mountedIn(parent: unknown): readonly string[];
  readOnlyFor(documentId: string): boolean | undefined;
} {
  const destroyed: string[] = [];
  const mounted = new Map<unknown, Set<string>>();
  const readOnly = new Map<string, boolean>();
  const provider: DocumentEditorProvider = {
    id: 'spy-editor',
    kindIds: [markdownKindId],
    createEditor({ session, parent }) {
      const id = String(session.document.documentId);
      const editors = mounted.get(parent) ?? new Set<string>();
      editors.add(id);
      mounted.set(parent, editors);
      return {
        setReadOnly(value) {
          readOnly.set(id, value);
        },
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
          editors.delete(id);
        },
      };
    },
  };
  return {
    provider,
    destroyed,
    mountedIn: (parent) => [...(mounted.get(parent) ?? [])],
    readOnlyFor: (documentId) => readOnly.get(documentId),
  };
}

async function setup() {
  const { provider, destroyed } = spyProvider();
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentEditorProviders: [provider],
  });
  const controller = createWorkbenchController(app);
  const workspace = app.getWorkspace()!;
  const create = async (path: string, body: string): Promise<string> => {
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath(path),
      initialModel: markdownModel(body),
    });
    return String(ref.documentId);
  };
  const alphaId = await create('alpha.md', '# Alpha');
  const betaId = await create('beta.md', '# Beta');
  const gammaId = await create('gamma.md', '# Gamma');
  return { app, controller, destroyed, create, alphaId, betaId, gammaId };
}

describe('workbench controller dock — replaceability', () => {
  it('open/save/reopen survives dock rearrangement on the mock editor', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      markdownEditorProvider: new MockMarkdownEditorProvider(),
    });
    const controller = createWorkbenchController(app);
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/draft.md'),
      initialModel: markdownModel('# Draft'),
    });
    const draftId = String(ref.documentId);

    await controller.openDocument(draftId, {});
    controller.execEditorCommand('undo');
    const second = controller.splitPane('main', 'down');
    await controller.moveTab(
      'main',
      draftId,
      { kind: 'pane', pane: second },
      { editorParent: {} },
    );
    // The mock editor mutates text through the session; save from the pane
    // the document now lives in.
    await controller.savePane(second);

    await controller.closeTab(second, draftId);
    expect(controller.isPaneActive(second)).toBe(false);

    // Reopen elsewhere: canonical bytes round-tripped through the mock.
    await controller.openDocument(draftId, {}, { pane: 'main' });
    expect(controller.getPaneText('main')).toContain('Draft');

    await app.dispose();
  });
});

describe('workbench controller dock', () => {
  it('switches the active provider between edit and read-only modes', async () => {
    const { provider, readOnlyFor } = spyProvider();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentEditorProviders: [provider],
    });
    const controller = createWorkbenchController(app);
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('reader.md'),
      initialModel: markdownModel('# Reader'),
    });
    const id = String(ref.documentId);

    await controller.openDocument(id, {});
    controller.setTabMode('main', id, 'reading');
    expect(readOnlyFor(id)).toBe(true);
    expect(controller.execEditorCommand('undo')).toBe(false);

    controller.setTabMode('main', id, 'edit');
    expect(readOnlyFor(id)).toBe(false);
    await app.dispose();
  });

  it('opening documents stacks tabs in the pane and activates the newest', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });

    const main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([alphaId, betaId]);
    expect(main?.activeTab).toBe(betaId);
    expect(controller.getPaneText('main')).toContain('Beta');

    await app.dispose();
  });

  it('activateTab switches the live session without touching other panes', async () => {
    const { app, controller, alphaId, betaId, gammaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });
    controller.splitPane('main', 'right');
    await controller.openDocument(
      gammaId,
      {},
      { pane: controller.focusedPane },
    );

    await controller.activateTab('main', alphaId);
    expect(controller.getPaneText('main')).toContain('Alpha');
    expect(controller.getPaneText(controller.leafIds()[1]!)).toContain('Gamma');

    await controller.activateTab('main', betaId);
    expect(controller.getPaneText('main')).toContain('Beta');

    await app.dispose();
  });

  it('keeps the last selected tab and live document in sync across overlapping activations', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });
    const workspace = app.getWorkspace()!;
    const originalOpen = workspace.openDocument.bind(workspace);
    let releaseAlpha!: () => void;
    let reachedAlpha!: () => void;
    const alphaGate = new Promise<void>((resolve) => (releaseAlpha = resolve));
    const alphaReached = new Promise<void>(
      (resolve) => (reachedAlpha = resolve),
    );
    workspace.openDocument = async (documentId) => {
      if (String(documentId) === alphaId) {
        reachedAlpha();
        await alphaGate;
      }
      return originalOpen(documentId);
    };

    const selectAlpha = controller.activateTab('main', alphaId);
    await alphaReached;
    const selectBeta = controller.activateTab('main', betaId);
    releaseAlpha();
    await Promise.all([selectAlpha, selectBeta]);

    const main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.activeTab).toBe(betaId);
    expect(main?.documentId).toBe(betaId);
    expect(controller.getPaneText('main')).toContain('Beta');

    await app.dispose();
  });

  it('does not resurrect a tab closed while its session is opening', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });
    const workspace = app.getWorkspace()!;
    const originalOpen = workspace.openDocument.bind(workspace);
    let releaseAlpha!: () => void;
    let reachedAlpha!: () => void;
    const alphaGate = new Promise<void>((resolve) => (releaseAlpha = resolve));
    const alphaReached = new Promise<void>(
      (resolve) => (reachedAlpha = resolve),
    );
    workspace.openDocument = async (documentId) => {
      if (String(documentId) === alphaId) {
        reachedAlpha();
        await alphaGate;
      }
      return originalOpen(documentId);
    };

    const selectAlpha = controller.activateTab('main', alphaId);
    await alphaReached;
    const closeAlpha = controller.closeTab('main', alphaId);
    // Give an unqueued close enough turns to reopen beta before alpha; a
    // correctly queued close remains behind the gated activation.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    releaseAlpha();
    await Promise.all([selectAlpha, closeAlpha]);

    const main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([betaId]);
    expect(main?.activeTab).toBe(betaId);
    expect(main?.documentId).toBe(betaId);
    expect(controller.getPaneText('main')).toContain('Beta');

    await app.dispose();
  });

  it('closing a background tab keeps the session; closing the active tab activates its neighbor', async () => {
    const { app, controller, destroyed, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });

    await controller.closeTab('main', alphaId);
    expect(controller.getPaneText('main')).toContain('Beta');
    // Opening beta already replaced alpha's live session (one session per
    // pane); closing the background tab destroys nothing further.
    expect(destroyed).toEqual([alphaId]);

    await controller.closeTab('main', betaId);
    expect(controller.getPaneText('main')).toBeNull();
    expect(destroyed).toEqual([alphaId, betaId]);

    await app.dispose();
  });

  it('closing a pane migrates its tabs into the next neighbor', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    const second = controller.splitPane('main', 'right');
    await controller.openDocument(betaId, {}, { pane: second });

    await controller.closePane(second);

    const main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(controller.leafIds()).toEqual(['main']);
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([alphaId, betaId]);
    expect(main?.activeTab).toBe(alphaId);
    expect(controller.focusedPane).toBe('main');

    await app.dispose();
  });

  it('closing the last tab of a pane closes and rebalances without migration', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    const second = controller.splitPane('main', 'down');
    await controller.openDocument(betaId, {}, { pane: second });

    await controller.closeTab(second, betaId);

    expect(controller.leafIds()).toEqual(['main']);
    expect(controller.paneStates().length).toBe(1);
    expect(controller.focusedPane).toBe('main');

    await app.dispose();
  });

  it('moveTab reorders within a pane and moves sessions across panes', async () => {
    const { app, controller, alphaId, betaId, gammaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });
    await controller.openDocument(gammaId, {}, { pane: 'main' });

    await controller.moveTab('main', alphaId, {
      kind: 'pane',
      pane: 'main',
      index: 2,
    });
    let main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([
      betaId,
      gammaId,
      alphaId,
    ]);

    const second = controller.splitPane('main', 'right');
    await controller.moveTab(
      'main',
      alphaId,
      { kind: 'pane', pane: second },
      { editorParent: {} },
    );
    main = controller.paneStates().find((pane) => pane.pane === 'main');
    const secondState = controller
      .paneStates()
      .find((pane) => pane.pane === second);
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([betaId, gammaId]);
    expect(secondState?.tabs.map((tab) => tab.documentId)).toEqual([alphaId]);
    expect(secondState?.activeTab).toBe(alphaId);
    expect(controller.getPaneText(second)).toContain('Alpha');

    await app.dispose();
  });

  it('keeps exactly one mounted editor when reordering the active tab', async () => {
    const { provider, mountedIn } = spyProvider();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentEditorProviders: [provider],
    });
    const controller = createWorkbenchController(app);
    const workspace = app.getWorkspace();
    if (workspace === null) throw new Error('workspace not active');
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
    const host = {};
    await controller.openDocument(String(alpha.documentId), host);
    await controller.openDocument(String(beta.documentId), host);

    await controller.moveTab('main', String(beta.documentId), {
      kind: 'pane',
      pane: 'main',
      index: 0,
    });

    expect(mountedIn(host)).toEqual([String(beta.documentId)]);
    expect(controller.getPaneText('main')).toContain('Beta');
    await app.dispose();
  });

  it('replaces the target editor when moving into an occupied pane', async () => {
    const { provider, mountedIn } = spyProvider();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentEditorProviders: [provider],
    });
    const controller = createWorkbenchController(app);
    const workspace = app.getWorkspace();
    if (workspace === null) throw new Error('workspace not active');
    const create = async (path: string): Promise<string> =>
      String(
        (
          await workspace.createDocument({
            kindId: markdownKindId,
            path: workspacePath(path),
            initialModel: markdownModel(`# ${path}`),
          })
        ).documentId,
      );
    const alpha = await create('alpha.md');
    const beta = await create('beta.md');
    const gamma = await create('gamma.md');
    const mainHost = {};
    const secondHost = {};
    await controller.openDocument(alpha, mainHost);
    await controller.openDocument(beta, mainHost);
    const second = controller.splitPane('main', 'right');
    await controller.openDocument(gamma, secondHost, { pane: second });

    await controller.moveTab(
      'main',
      beta,
      { kind: 'pane', pane: second },
      { editorParent: secondHost },
    );

    expect(mountedIn(mainHost)).toEqual([alpha]);
    expect(mountedIn(secondHost)).toEqual([beta]);
    expect(controller.getPaneText(second)).toContain('beta.md');
    await app.dispose();
  });

  it('opens an inactive tab when splitting before the new pane host exists', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    try {
      await controller.openDocument(alphaId, {});
      await controller.openDocument(betaId, {}, { pane: 'main' });
      const moved = await controller.moveTab('main', alphaId, {
        kind: 'split',
        pane: 'main',
        direction: 'right',
      });
      if (moved === null) throw new Error('moveTab returned no pane');
      expect(controller.getPaneText(moved)).toContain('Alpha');
      expect(controller.getPaneText('main')).toContain('Beta');
    } finally {
      await app.dispose();
    }
  });

  it('moveTab with a split target creates the split and lands the tab there', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });

    const moved = await controller.moveTab(
      'main',
      betaId,
      { kind: 'split', pane: 'main', direction: 'down' },
      { editorParent: {} },
    );

    if (moved === null) throw new Error('moveTab returned no pane');
    expect(controller.leafIds()).toEqual(['main', moved]);
    const target = controller.paneStates().find((pane) => pane.pane === moved);
    expect(target?.tabs.map((tab) => tab.documentId)).toEqual([betaId]);
    expect(controller.getPaneText(moved)).toContain('Beta');

    await app.dispose();
  });

  it('view tabs tear down the document session and restore it when reactivated', async () => {
    const { app, controller, destroyed, alphaId } = await setup();
    await controller.openDocument(alphaId, {});

    const graphTab = await controller.openView('graph');
    expect(destroyed).toEqual([alphaId]);
    expect(controller.getPaneText('main')).toBeNull();
    const main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.tabs.map((tab) => tab.id)).toEqual([alphaId, graphTab]);
    expect(main?.activeTab).toBe(graphTab);

    await controller.activateTab('main', alphaId);
    expect(controller.getPaneText('main')).toContain('Alpha');
    expect(destroyed).toEqual([alphaId]);

    await app.dispose();
  });

  it('opening a view that already has a tab in the pane activates it instead of stacking', async () => {
    const { app, controller, alphaId } = await setup();
    await controller.openDocument(alphaId, {});

    const first = await controller.openView('graph');
    const second = await controller.openView('graph');
    expect(second).toBe(first);

    const main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.tabs.filter((tab) => tab.viewId === 'graph')).toHaveLength(1);
    expect(main?.activeTab).toBe(first);

    await app.dispose();
  });

  it('reactivating an existing view tab tears down the active document session', async () => {
    const { app, controller, destroyed, alphaId } = await setup();
    await controller.openDocument(alphaId, {});

    const viewTab = await controller.openView('graph');
    await controller.activateTab('main', alphaId);
    expect(destroyed).toEqual([alphaId]);

    const again = await controller.openView('graph');
    expect(again).toBe(viewTab);
    expect(destroyed).toEqual([alphaId, alphaId]);
    expect(controller.getPaneText('main')).toBeNull();

    await app.dispose();
  });

  it('the same view may still be open in two panes', async () => {
    const { app, controller } = await setup();
    const mainTab = await controller.openView('graph');
    const created = controller.splitPane('main', 'right');
    const otherTab = await controller.openView('graph', { pane: created });
    expect(otherTab).not.toBe(mainTab);

    const panes = controller.paneStates();
    expect(
      panes
        .find((pane) => pane.pane === 'main')
        ?.tabs.filter((tab) => tab.viewId === 'graph'),
    ).toHaveLength(1);
    expect(
      panes
        .find((pane) => pane.pane === created)
        ?.tabs.filter((tab) => tab.viewId === 'graph'),
    ).toHaveLength(1);

    await app.dispose();
  });

  it('per-tab modes follow the tab, not the pane', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });

    controller.setTabMode('main', alphaId, 'reading');
    expect(
      controller.paneStates().find((pane) => pane.pane === 'main')?.mode,
    ).toBe('edit');

    await controller.activateTab('main', alphaId);
    expect(
      controller.paneStates().find((pane) => pane.pane === 'main')?.mode,
    ).toBe('reading');

    await app.dispose();
  });

  it('dock state exposes the tree, focus, and maximize for the shell', async () => {
    const { app, controller } = await setup();
    expect(controller.dockState().root).toEqual({ kind: 'leaf', pane: 'main' });

    const second = controller.splitPane('main', 'right');
    controller.toggleMaximize(second);
    expect(controller.dockState().maximizedPane).toBe(second);
    controller.toggleMaximize(second);
    expect(controller.dockState().maximizedPane).toBeNull();

    await app.dispose();
  });

  it('layout snapshot round-trips through restore', async () => {
    const { app, controller, alphaId, betaId } = await setup();
    await controller.openDocument(alphaId, {});
    const second = controller.splitPane('main', 'right');
    await controller.openDocument(betaId, {}, { pane: second });
    controller.setTabMode(second, betaId, 'reading');

    const record = controller.dockLayout();
    const fresh = createWorkbenchController(app);
    await fresh.restoreDockLayout(record);

    expect(fresh.leafIds()).toEqual(['main', second]);
    const main = fresh.paneStates().find((pane) => pane.pane === 'main');
    const secondState = fresh.paneStates().find((pane) => pane.pane === second);
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([alphaId]);
    expect(secondState?.tabs.map((tab) => tab.documentId)).toEqual([betaId]);
    expect(secondState?.activeTab).toBe(betaId);
    expect(secondState?.mode).toBe('reading');
    expect(fresh.dockState().focusedPane).toBe(second);

    await app.dispose();
  });
});
