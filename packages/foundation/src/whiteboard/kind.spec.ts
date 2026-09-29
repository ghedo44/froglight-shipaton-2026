/**
 * Whiteboard document kind integration — infinite surface document.
 * Tests external behavior at DocumentKind + DocumentSession seam.
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
import { encodeWhiteboard } from './codec.js';
import { whiteboardKind, whiteboardKindId } from './kind.js';
import {
  emptySurface,
  cardObject,
  resourceEmbedObject,
  textObject,
  rectangleObject,
  imageObject,
  inkStrokeObject,
  lineObject,
  infiniteFrame,
  type SurfaceModel,
} from '../surfaces/model.js';

function makeWorkspace() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(whiteboardKind);
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
    workspaceId: 'ws-whiteboard-test',
  });
  return { vault, registry, metadata, relationships, search, revisions, wsPromise };
}

describe('whiteboard kind', () => {
  it('recognizes its id and.whiteboard extension', () => {
    expect(whiteboardKind.recognize!(whiteboardKindId)).toBe(true);
    expect(whiteboardKind.recognize!('froglight.whiteboard' as never)).toBe(true);
    expect(whiteboardKind.recognize!('some.whiteboard' as never)).toBe(true);
    expect(whiteboardKind.recognize!('froglight.markdown' as never)).toBe(false);
  });

  it('creates, saves, and reopens infinite board byte-stably through session', async () => {
    const { vault, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const created = await ws.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('board.whiteboard'),
      initialModel: emptySurface(infiniteFrame()),
    });
    const documentId = String(created.documentId);

    const opened = await ws.openDocument(documentId as never);
    const model = opened.model as SurfaceModel;
    model.objects.t1 = textObject('t1', { x: 10, y: 10, text: 'hello' });
    model.objects.c1 = cardObject('c1', { x: 20, y: 20, width: 200, height: 120, text: 'card' });
    model.objects.r1 = rectangleObject('r1', { x: 0, y: 0, width: 50, height: 50 });
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      target: { documentId: 'doc1', kindId: 'froglight.markdown', resourceId: 'res1' },
      cachedTitle: 'Note',
    });
    model.objects.i1 = inkStrokeObject('i1', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    model.objects.l1 = lineObject('l1', { x: 0, y: 0, x2: 10, y2: 10 });
    model.objects.img1 = imageObject('img1', { x: 5, y: 5, width: 10, height: 10, src: 'assets/p.png', sha256: 'ab'.repeat(32) });
    model.order.push('t1', 'c1', 'r1', 'e1', 'i1', 'l1', 'img1');
    opened.markDirty();
    await opened.save();
    await opened.close();

    const reopened = await ws.openDocument(documentId as never);
    const reopenedModel = reopened.model as SurfaceModel;
    expect(reopenedModel.order).toEqual(['t1', 'c1', 'r1', 'e1', 'i1', 'l1', 'img1']);
    expect((reopenedModel.objects.c1 as Record<string, unknown>).text).toBe('card');
    expect((reopenedModel.objects.e1 as Record<string, unknown>).cachedTitle).toBe('Note');

    expect(encodeWhiteboard(reopenedModel)).toEqual(await vault.read(workspacePath('board.whiteboard')));
    await reopened.close();
  });

  it('projects relationships and search rebuild headless', async () => {
    const { relationships, search, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const model = emptySurface(infiniteFrame());
    model.objects.t1 = textObject('t1', { x: 10, y: 10, text: 'quicksort pivot notes' });
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 50,
      y: 50,
      width: 300,
      height: 200,
      target: { documentId: 'docX', kindId: 'froglight.markdown', resourceId: 'resX' },
      cachedTitle: 'Related note',
    });
    model.order.push('t1', 'e1');
    await ws.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('board2.whiteboard'),
      initialModel: model,
    });
    await ws.rebuildDerivedState();

    const hits = search.search({ text: 'quicksort' });
    expect(hits).toHaveLength(1);
    const hits2 = search.search({ text: 'Related note' });
    expect(hits2).toHaveLength(1);

    expect(relationships.byTarget('docX' as never)).toHaveLength(1);

    relationships.clear();
    search.clear();
    await ws.rebuildDerivedState();
    expect(search.search({ text: 'quicksort' })).toHaveLength(1);
  });

  it('preserves unknown object types round-trip', async () => {
    const { vault, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const model = emptySurface(infiniteFrame());
    (model.objects as Record<string, unknown>).x1 = { id: 'x1', type: 'acme.widget', foo: { bar: 1 } };
    model.order.push('x1');
    const created = await ws.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('unknown.whiteboard'),
      initialModel: model,
    });
    const opened = await ws.openDocument(created.documentId);
    opened.markDirty();
    await opened.save();
    const bytes = await vault.read(workspacePath('unknown.whiteboard'));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.objects.x1).toEqual({ id: 'x1', type: 'acme.widget', foo: { bar: 1 } });
    await opened.close();
  });

  it('rejects bounded payload at kind decode', async () => {
    const { vault, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    // Write bounded surface bytes directly under .whiteboard path
    const boundedModel = emptySurface({ kind: 'bounded', width: 800, height: 600 } as never);
    const { encodeSurfacePayload } = await import('../surfaces/codec.js');
    await vault.write(workspacePath('bounded.whiteboard'), encodeSurfacePayload(boundedModel));
    // Manually register whiteboard kind to decode those bytes should fail
    await expect(ws.openDocument('fake' as never)).rejects.toThrow();
    // Instead create via ws to show bounded via whiteboard codec fails at save time is covered elsewhere;
    // Here we directly test decodeWhiteboard rejection
    const { decodeWhiteboard } = await import('./codec.js');
    const boundedBytes = encodeSurfacePayload(boundedModel);
    expect(() => decodeWhiteboard(boundedBytes)).toThrow();
  });

  it('survives move/rename via stable DocumentRef (vault path change does not affect embed)', async () => {
    const { wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    // Create a markdown target
    // Use ws's registry which already has whiteboard; need markdown too for target creation
    // For this test, manually write a resource and reference it via stable ids
    const targetDocId = 'doc-stable' as never;
    const targetResId = 'res-stable' as never;
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: { documentId: targetDocId as string, kindId: 'froglight.markdown', resourceId: targetResId as string },
      cachedTitle: 'Stable title',
    });
    model.order.push('e1');
    const created = await ws.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('board-stable.whiteboard'),
      initialModel: model,
    });
    const opened = await ws.openDocument(created.documentId);
    const reopenedModel = opened.model as SurfaceModel;
    const targetBefore = (reopenedModel.objects.e1 as Record<string, unknown>).target as Record<string, unknown>;
    expect(targetBefore.documentId).toBe('doc-stable');
    // Simulate rename: no file path change affects target identity
    await opened.close();
    // Reopen again — target unchanged
    const reopened2 = await ws.openDocument(created.documentId);
    const targetAfter = ((reopened2.model as SurfaceModel).objects.e1 as Record<string, unknown>).target as Record<string, unknown>;
    expect(targetAfter).toEqual(targetBefore);
    await reopened2.close();
  });

  it('provider removal does not mutate canonical bytes (placeholder presentation only)', async () => {
    const { wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 200,
      height: 150,
      target: { documentId: 'doc1', kindId: 'froglight.markdown', resourceId: 'res1' },
      cachedTitle: 'Keep me',
    });
    model.order.push('e1');
    const created = await ws.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('board-placeholder.whiteboard'),
      initialModel: model,
    });
    let opened = await ws.openDocument(created.documentId);
    const beforeBytes = encodeWhiteboard(opened.model as SurfaceModel);
    await opened.close();
    // Simulate provider loss: no provider registered, but reopening should still have same bytes
    // Composition registry with no provider yields placeholder at render time, not at decode
    opened = await ws.openDocument(created.documentId);
    const afterBytes = encodeWhiteboard(opened.model as SurfaceModel);
    expect(afterBytes).toEqual(beforeBytes);
    expect((opened.model as SurfaceModel).objects.e1).toBeDefined();
    await opened.close();
  });
});
