import { describe, expect, it } from 'vitest';
import { definePlugin } from '@froglight/runtime';
import {
  InMemorySearchService,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  vaultToken,
  workspacePath,
  type DocumentEditorProvider,
  type VaultService,
} from '@froglight/foundation';
import {
  createApp,
  createWorkbenchController,
  DOCK_RECORD_PATH,
  type DockLayoutRecord,
} from './index.js';
import { DockLayoutStoreImpl } from './dock-layout.js';

const provider: DocumentEditorProvider = {
  id: 'dock-layout-editor',
  kindIds: [markdownKindId],
  createEditor() {
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
        return undefined;
      },
    };
  },
};

async function setup() {
  let vault: VaultService | null = null;
  const capture = definePlugin({
    id: 'test.vault-capture',
    requirements: { requires: [vaultToken] },
    activate: (ctx) => {
      vault = ctx.require(vaultToken);
    },
  });
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind],
    documentEditorProviders: [provider],
    extraPlugins: [capture],
  });
  if (vault === null) throw new Error('vault capture failed');
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
  const capturedVault: VaultService = vault as VaultService;
  return { app, controller, vault: capturedVault, store: app.getDockLayout()!, create };
}

const sampleRecord: DockLayoutRecord = {
  format: 'froglight.dock',
  version: 1,
  root: {
    kind: 'split',
    direction: 'horizontal',
    ratio: 0.6,
    first: { kind: 'leaf', pane: 'main' },
    second: { kind: 'leaf', pane: 'pane-2' },
  },
  panes: [
    {
      pane: 'main',
      tabs: [{ id: 'doc-1', kind: 'document', documentId: 'doc-1', viewId: null }],
      activeTab: 'doc-1',
      modes: [],
    },
    { pane: 'pane-2', tabs: [], activeTab: null, modes: [] },
  ],
  focusedPane: 'main',
};

describe('dock layout persistence', () => {
  it('round-trips a layout through the vault', async () => {
    const { app, vault, store } = await setup();
    store.save(sampleRecord);
    await store.flush();

    const reopened = await DockLayoutStoreImpl.open(vault);
    expect(await reopened.load()).toEqual(sampleRecord);

    await app.dispose();
  });

  it('treats missing, corrupt, and unknown-version records as no layout', async () => {
    const { app, vault } = await setup();

    expect(await (await DockLayoutStoreImpl.open(vault)).load()).toBeNull();

    await vault.write(DOCK_RECORD_PATH, new TextEncoder().encode('{not json'));
    expect(await (await DockLayoutStoreImpl.open(vault)).load()).toBeNull();

    await vault.write(
      DOCK_RECORD_PATH,
      new TextEncoder().encode(
        JSON.stringify({ format: 'froglight.dock', version: 99, root: null, panes: [] }),
      ),
    );
    expect(await (await DockLayoutStoreImpl.open(vault)).load()).toBeNull();

    await app.dispose();
  });

  it('preserves unknown fields across a load/save cycle', async () => {
    const { app, vault } = await setup();
    await vault.write(
      DOCK_RECORD_PATH,
      new TextEncoder().encode(
        JSON.stringify({
          format: 'froglight.dock',
          version: 1,
          root: { kind: 'leaf', pane: 'main' },
          panes: [],
          focusedPane: 'main',
          futureField: { keep: true },
        }),
      ),
    );
    const store = await DockLayoutStoreImpl.open(vault);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    store.save(loaded!);
    await store.flush();

    const raw = JSON.parse(new TextDecoder().decode(await vault.read(DOCK_RECORD_PATH))) as {
      futureField?: unknown;
    };
    expect(raw.futureField).toEqual({ keep: true });

    await app.dispose();
  });

  it('treats a non-object JSON record as no layout', async () => {
    const { app, vault } = await setup();
    await vault.write(DOCK_RECORD_PATH, new TextEncoder().encode('null'));
    expect(await (await DockLayoutStoreImpl.open(vault)).load()).toBeNull();
    await app.dispose();
  });

  it('a fresh vault never sees another vault\'s dock layout', async () => {
    const { app, controller, store, create } = await setup();
    await controller.openDocument(await create('alpha.md', '# Alpha'), {});
    await store.flush();
    const before = await app.getDockLayout()!.load();
    expect(before).not.toBeNull();

    // Swap to a brand-new vault: the new store must start empty even
    // though the controller (and its in-memory dock) persists.
    await controller.openVault(memoryVaultPlugin, {});
    const freshStore = app.getDockLayout()!;
    expect(freshStore).not.toBe(store);
    expect(await freshStore.load()).toBeNull();

    await app.dispose();
  });

  it('initialize restores the persisted dock instead of opening the first document', async () => {
    const { app, controller, store, create } = await setup();
    const alphaId = await create('alpha.md', '# Alpha');
    const betaId = await create('beta.md', '# Beta');

    await controller.openDocument(alphaId, {});
    const second = controller.splitPane('main', 'right');
    await controller.openDocument(betaId, {}, { pane: second });
    await store.flush();

    const fresh = createWorkbenchController(app);
    await fresh.initialize({});

    expect(fresh.leafIds()).toEqual(['main', second]);
    const main = fresh.paneStates().find((pane) => pane.pane === 'main');
    const secondState = fresh.paneStates().find((pane) => pane.pane === second);
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([alphaId]);
    expect(secondState?.tabs.map((tab) => tab.documentId)).toEqual([betaId]);
    // Sessions reopen through the shell's host reconciliation, not here.
    expect(fresh.isPaneActive('main')).toBe(false);
    // And the dock still works afterwards.
    await fresh.openDocument(alphaId, {});
    expect(fresh.isPaneActive('main')).toBe(true);

    await app.dispose();
  });
});
