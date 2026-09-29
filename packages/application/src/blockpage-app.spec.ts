/**
 *  composition-root tests: a non-Markdown document family flows
 * through the same workspace/session/persistence/search path with the
 * structured editor demonstrably replaceable (exit gate).
 */

import { describe, expect, it } from 'vitest';
import { createApp } from './index.js';
import {
  InMemorySearchService,
  blockPageKind,
  blockPageKindId,
  emptyBlockPage,
  markdownKind,
  memoryVaultPlugin,
  workspacePath,
  type BlockPageModel,
} from '@froglight/foundation';
import {
  MockBlockPageEditorProvider,
  TiptapStubProvider,
} from '@froglight/foundation/testing';

function opaqueModel(): BlockPageModel {
  const model = emptyBlockPage({ title: 'App Level' });
  model.rootOrder = ['x1'];
  model.blocks.x1 = { id: 'x1', type: 'acme.callout', tone: 'loud' };
  return model;
}

describe('application — block page vertical slice', () => {
  it('creates/opens/edits/saves a block page through the shared composition', async () => {
    const search = new InMemorySearchService();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: search,
      documentKinds: [markdownKind, blockPageKind],
      blockPageEditorProvider: new MockBlockPageEditorProvider(),
    });
    const workspace = app.getWorkspace()!;

    // The structured editor resolves through the generic registry seam.
    const genericProvider = app.getDocumentEditor(blockPageKindId);
    expect(genericProvider).not.toBeNull();

    const ref = await workspace.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('pages/page.blockpage'),
      initialModel: opaqueModel(),
    });
    await workspace.rebuildDerivedState();

    // Open via the generic provider; drive an edit through its handle.
    const session = await workspace.openDocument<BlockPageModel>(
      ref.documentId,
    );
    const handle = genericProvider!.createEditor({ session, parent: {} });
    (
      handle as unknown as { appendParagraph(text: string): void }
    ).appendParagraph('composed');
    session.markDirty();
    const saved = await session.save();
    expect(saved.committed).toBe(true);

    // Search sees the projected text, anchored to the mock's new block.
    const hits = search.search({ text: 'composed' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.documentId).toBe(ref.documentId);
    expect(hits[0]?.location.address).toBe('mock-2');

    // Unknown plugin content survives the whole cycle.
    const reopened = await workspace.openDocument<BlockPageModel>(
      ref.documentId,
    );
    expect(reopened.model.blocks.x1).toEqual(opaqueModel().blocks.x1);
    await app.dispose();
  });

  it('swaps the block-page adapter without changing canonical contracts', async () => {
    for (const provider of [
      new MockBlockPageEditorProvider(),
      new TiptapStubProvider(),
    ]) {
      const app = await createApp({
        vaultPlugin: memoryVaultPlugin,
        searchService: new InMemorySearchService(),
        documentKinds: [blockPageKind],
        blockPageEditorProvider: provider,
      });
      expect(app.getDocumentEditor(blockPageKindId)).not.toBeNull();
      await app.dispose();
    }
  });
});
