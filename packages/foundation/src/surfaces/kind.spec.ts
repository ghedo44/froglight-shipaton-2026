/**
 * Ink page document kind integration: `.ink` resources whose
 * canonical content is one surface payload record. Create/open/edit/
 * save through WorkspaceService with derived projections kept fresh —
 * the workspace-blocks pattern over the surface codec.
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { VaultRevisionService } from '../revisions.js';
import { InMemorySearchService } from '../search/service.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { encodeSurfacePayload } from './codec.js';
import { INK_EMBED_EDGE_TYPE, inkPageKind, inkPageKindId } from './kind.js';
import {
  boundedFrame,
  emptySurface,
  infiniteFrame,
  inkStrokeObject,
  resourceEmbedObject,
  textObject,
  type SurfaceModel,
} from './model.js';

function embedTarget(overrides: Record<string, unknown> = {}) {
  return {
    documentId: 'doc1',
    kindId: 'froglight.markdown',
    resourceId: 'res1',
    ...overrides,
  };
}

function decodeRef(resourceId: string) {
  return {
    documentId: 'doc-ink' as never,
    kindId: inkPageKindId,
    location: { resourceId: resourceId as never },
  };
}

function makeWorkspace() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(inkPageKind);
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
    workspaceId: 'ws-ink-test',
  });
  return { vault, registry, metadata, relationships, search, revisions, wsPromise };
}

describe('ink page kind', () => {
  it('rejects an infinite frame without replacing the document content', () => {
    const model = emptySurface(infiniteFrame());
    const bytes = encodeSurfacePayload(model);
    expect(() => inkPageKind.decode(bytes, decodeRef('res-ink'))).toThrow(
      /bounded/i,
    );
    expect(() => inkPageKind.encode(model, decodeRef('res-ink'))).toThrow(/bounded/i);
  });
  it('recognizes its id and.ink extension aliases', () => {
    expect(inkPageKind.recognize!(inkPageKindId)).toBe(true);
    expect(inkPageKind.recognize!('froglight.ink' as never)).toBe(true);
    expect(inkPageKind.recognize!('froglight.markdown' as never)).toBe(false);
  });

  it('creates, saves, and reopens strokes byte-stably through the session path', async () => {
    const { vault, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const created = await ws.createDocument({
      kindId: inkPageKindId,
      path: workspacePath('sketch.ink'),
      initialModel: emptySurface(boundedFrame(800, 600)),
    });
    const documentId = String(created.documentId);

    const opened = await ws.openDocument(documentId as never);
    const model = opened.model as SurfaceModel;
    model.objects.s1 = inkStrokeObject('s1', {
      points: [
        { x: 1, y: 2, pressure: 0.5 },
        { x: 30, y: 40 },
      ],
      width: 3,
    });
    model.order.push('s1');
    opened.markDirty();
    await opened.save();
    await opened.close();

    // Reopen: identical strokes decoded from canonical bytes.
    const reopened = await ws.openDocument(documentId as never);
    const reopenedModel = reopened.model as SurfaceModel;
    expect(reopenedModel.order).toEqual(['s1']);
    expect((reopenedModel.objects.s1!.points as unknown[])[0]).toEqual({
      x: 1,
      y: 2,
      pressure: 0.5,
    });

    // An unmodified reopen encodes to exactly the stored bytes.
    expect(encodeSurfacePayload(reopenedModel)).toEqual(
      await vault.read(workspacePath('sketch.ink')),
    );
    await reopened.close();
  });

  it('projects surface text objects into search and keeps rebuild equivalent', async () => {
    const { relationships, search, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const model = emptySurface(boundedFrame(800, 600));
    model.objects.t1 = textObject('t1', { x: 10, y: 10, text: 'quicksort pivot notes' });
    model.order.push('t1');
    await ws.createDocument({
      kindId: inkPageKindId,
      path: workspacePath('algo.ink'),
      initialModel: model,
    });
    await ws.rebuildDerivedState();

    const hits = search.search({ text: 'quicksort' });
    expect(hits).toHaveLength(1);

    // Derived state is rebuildable: wipe and rebuild converges.
    relationships.clear();
    search.clear();
    await ws.rebuildDerivedState();
    expect(search.search({ text: 'quicksort' })).toHaveLength(1);
  });

  it('rejects corrupt payloads loudly instead of opening half-decoded', async () => {
    const { vault, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const created = await ws.createDocument({
      kindId: inkPageKindId,
      path: workspacePath('broken.ink'),
      initialModel: emptySurface(boundedFrame(800, 600)),
    });
    await vault.write(workspacePath('broken.ink'), new TextEncoder().encode('{nope'));
    await expect(ws.openDocument(created.documentId)).rejects.toThrowError();
  });

  it('projects resource embeds as ink.embed edges through kind decode', () => {
    const model = emptySurface(boundedFrame(800, 600));
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: embedTarget(),
    });
    model.objects.e2 = resourceEmbedObject('e2', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: embedTarget({ documentId: 'doc2', address: 'sec1' }),
    });
    model.order.push('e1', 'e2');

    const decoded = inkPageKind.decode(
      encodeSurfacePayload(model),
      decodeRef('res-ink'),
    );
    expect(decoded.relationships).toHaveLength(2);
    expect(decoded.relationships[0]!.type).toBe('ink.embed');
    expect(decoded.relationships[0]!.type).toBe(INK_EMBED_EDGE_TYPE);
    expect(decoded.relationships.map((e) => e.source.address)).toEqual([
      'e1',
      'e2',
    ]);
    expect(decoded.relationships[0]!.metadata).toEqual({ objectId: 'e1' });
    expect(decoded.relationships[1]!.target.location.address).toBe('sec1');
  });

  it('refreshes indexed edges after edits without stale entries', async () => {
    const { relationships, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const model = emptySurface(boundedFrame(800, 600));
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: embedTarget(),
    });
    model.order.push('e1');

    const created = await ws.createDocument({
      kindId: inkPageKindId,
      path: workspacePath('refs.ink'),
      initialModel: model,
    });
    const documentId = created.documentId;
    expect(relationships.byTarget('doc1' as never)).toHaveLength(1);

    // Add a second embed, save, expect two edges.
    const opened = await ws.openDocument<SurfaceModel>(documentId);
    const live = opened.model;
    live.objects.e2 = resourceEmbedObject('e2', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: embedTarget({ documentId: 'doc2', resourceId: 'res2' }),
    });
    live.order.push('e2');
    opened.markDirty();
    await opened.save();
    expect(
      relationships
        .bySource(created.location.resourceId)
        .map((e) => e.source.address),
    ).toEqual(['e1', 'e2']);

    // Remove the first embed, save, expect only the second edge (no stale).
    delete live.objects.e1;
    live.order = live.order.filter((id) => id !== 'e1');
    opened.markDirty();
    await opened.save();
    expect(
      relationships
        .bySource(created.location.resourceId)
        .map((e) => e.source.address),
    ).toEqual(['e2']);
    expect(relationships.byTarget('doc1' as never)).toHaveLength(0);
    await opened.close();
  });
});
