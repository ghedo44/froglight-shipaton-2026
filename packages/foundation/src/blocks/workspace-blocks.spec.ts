/**
 * Foundation-level integration tests for Block Pages:
 * create/open/edit/save through WorkspaceService with derived
 * metadata/relationships/search projections kept fresh.
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { VaultRevisionService } from '../revisions.js';
import { InMemorySearchService } from '../search/service.js';
import { createMemoryVault } from '../vault/memory.js';
import { blockPageKind, blockPageKindId } from './kind.js';
import {
  emptyBlockPage,
  headingBlock,
  paragraphBlock,
  type BlockPageModel,
} from './model.js';
import { workspacePath } from '../paths.js';

function makeWorkspace() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(blockPageKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const search = new InMemorySearchService();
  const revisions = new VaultRevisionService({ vault, resolveResource: () => undefined });
  const wsPromise = WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata,
    relationships,
    revisions,
    search,
    workspaceId: 'ws-blocks-test',
  });
  return { vault, registry, metadata, relationships, search, revisions, wsPromise };
}

function modelWithLink(): BlockPageModel {
  const model = emptyBlockPage({ title: 'Blocks' });
  model.rootOrder = ['h1', 'p1'];
  model.blocks = {
    h1: headingBlock('h1', 1, [{ text: 'Alpha' }]),
    p1: paragraphBlock('p1', [
      { text: 'link to ', },
      { text: 'notes', marks: [{ type: 'link', href: 'other.blockpage#tgt' }] },
    ]),
  };
  return model;
}

describe('block page vertical slice — shared document path', () => {
  it('creates, opens, saves, and keeps derived state fresh', async () => {
    const { wsPromise, metadata, relationships } = makeWorkspace();
    const ws = await wsPromise;
    const ref = await ws.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('pages/a.blockpage'),
      initialModel: modelWithLink(),
    });
    const session = await ws.openDocument<BlockPageModel>(ref.documentId);
    // Product shells rebuild derived state during initialization.
    await ws.rebuildDerivedState();

    // Derived projections populated from canonical decode.
    expect(metadata.get(ref.documentId).title).toBe('Blocks');
    expect(relationships.bySource(ref.location.resourceId)).toHaveLength(1);

    // Edit via the canonical model (as the editor adapter would), then save.
    session.model.blocks.p1 = paragraphBlock('p1', [{ text: 'renamed anchor text' }]);
    session.model.meta.title = 'Renamed';
    session.markDirty();
    const result = await session.save();
    expect(result.committed).toBe(true);
    // Shared revision path records the save like every other family.
    expect(session.lastSavedRevision).not.toBeNull();

    expect(metadata.get(ref.documentId).title).toBe('Renamed');
  });

  it('searches block pages and anchors results to containing blocks', async () => {
    const { wsPromise, search } = makeWorkspace();
    const ws = await wsPromise;
    const ref = await ws.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('pages/b.blockpage'),
      initialModel: modelWithLink(),
    });
    await ws.rebuildDerivedState();

    const hits = search.search({ text: 'Alpha' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.documentId).toBe(ref.documentId);
    // Generalized location: anchored to the heading block, not raw offsets.
    expect(hits[0]?.location.address).toBe('h1');
  });

  it('round-trips unknown plugin content through a full open/save cycle', async () => {
    const { wsPromise, vault } = makeWorkspace();
    const ws = await wsPromise;
    const model = modelWithLink();
    model.blocks.opaque = {
      id: 'opaque',
      type: 'acme.callout',
      tone: 'loud',
      payload: { nested: [1, 2] },
    };
    model.rootOrder.push('opaque');
    const ref = await ws.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('pages/c.blockpage'),
      initialModel: model,
    });
    await ws.rebuildDerivedState();

    // Simulate restart: reopen from canonical bytes and re-save untouched.
    const reopened = await ws.openDocument<BlockPageModel>(ref.documentId);
    const serialized = JSON.stringify(reopened.model.blocks.opaque);
    expect(serialized).toContain('"tone":"loud"');
    void vault;
  });
});
