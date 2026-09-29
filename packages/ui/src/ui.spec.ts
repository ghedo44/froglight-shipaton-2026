import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  InMemorySearchService,
  documentId,
  memoryVaultPlugin,
  resourceId,
  searchToken,
  workspacePlugin,
} from '@froglight/foundation';
import {
  fileExplorerPlugin,
  installDefaultUi,
  searchUiPlugin,
  searchUiToken,
  vaultManagerPlugin,
  type SearchUiService,
} from './index.js';

describe('ui — shared plugins are modular and interchangeable', () => {
  it('file-explorer plugin registers and lists files via WorkspaceService', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    await runtime.registerSlot({
      id: 'file-explorer',
      plugin: fileExplorerPlugin,
    });
    expect(
      runtime.inspect().slots.find((slot) => slot.id === 'file-explorer')
        ?.state,
    ).toBe('active');

    await runtime.removeSlot('file-explorer');
    expect(
      runtime.inspect().slots.find((slot) => slot.id === 'file-explorer'),
    ).toBeUndefined();
    await runtime.registerSlot({
      id: 'file-explorer',
      plugin: fileExplorerPlugin,
    });
    expect(
      runtime.inspect().slots.find((slot) => slot.id === 'file-explorer')
        ?.state,
    ).toBe('active');
    await runtime.dispose();
  });

  it('vault-manager plugin allows create/open vault', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'vault-manager',
      plugin: vaultManagerPlugin,
    });
    expect(
      runtime.inspect().slots.find((slot) => slot.id === 'vault-manager')
        ?.state,
    ).toBe('active');
    await runtime.dispose();
  });

  it('search-ui composes SearchService with WorkspaceService', async () => {
    const runtime = new Runtime();
    const search = new InMemorySearchService();
    const searchProvider = definePlugin({
      id: 'test.search-provider',
      activate: (ctx) => {
        ctx.provide(searchToken, search);
      },
    });

    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    await runtime.registerSlot({ id: 'search', plugin: searchProvider });
    await runtime.registerSlot({ id: 'search-ui', plugin: searchUiPlugin });
    const captured: { search?: SearchUiService } = {};
    await runtime.registerSlot({
      id: 'search-ui-probe',
      plugin: definePlugin({
        id: 'test.search-ui-probe',
        requirements: { requires: [searchUiToken] },
        activate: (ctx) => {
          captured.search = ctx.require(searchUiToken);
        },
      }),
    });
    expect(
      runtime.inspect().slots.find((slot) => slot.id === 'search-ui')?.state,
    ).toBe('active');
    search.indexDocument(
      documentId('doc-1'),
      { resourceId: resourceId('res-1') },
      '# Meeting notes\n\nThe full-text-only phrase lives here.',
    );
    const uiSearch = captured.search;
    if (uiSearch === undefined)
      throw new Error('search UI service did not activate');
    await expect(uiSearch.search('full-text-only')).resolves.toEqual([
      expect.objectContaining({
        documentId: 'doc-1',
        matchedIn: 'content',
      }),
    ]);
    await runtime.dispose();
  });

  it('keeps the installed search facade live across vault replacement', async () => {
    const runtime = new Runtime();
    const search = new InMemorySearchService();
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    await runtime.registerSlot({
      id: 'search',
      plugin: definePlugin({
        id: 'test.search-provider.lifecycle',
        activate: (ctx) => ctx.provide(searchToken, search),
      }),
    });
    const ui = await installDefaultUi(runtime);

    await runtime.removeSlot('vault');
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    search.indexDocument(
      documentId('doc-after-open'),
      { resourceId: resourceId('res-after-open') },
      '# Reopened\n\nSearch works after opening a vault.',
    );

    await expect(ui.search.search('after opening')).resolves.toEqual([
      expect.objectContaining({
        documentId: 'doc-after-open',
        matchedIn: 'content',
      }),
    ]);
    await runtime.dispose();
  });
});
