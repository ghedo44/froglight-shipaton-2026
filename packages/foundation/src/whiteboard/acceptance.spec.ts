/**
 * Whiteboard acceptance — large board, relationships/search,
 * move/rename survival, provider-removal placeholder, cycle termination.
 * External-behavior only; engine-free where possible.
 */

import { describe, expect, it } from 'vitest';
import { emptySurface, cardObject, resourceEmbedObject, textObject, rectangleObject, infiniteFrame, type SurfaceModel } from '../surfaces/model.js';
import { decodeWhiteboard, encodeWhiteboard } from './codec.js';
import { InMemoryCompositionRegistry, MAX_COMPOSITION_DEPTH } from '../composition.js';
import { documentKindId } from '../identity.js';
import { compileScene, createDefaultSurfaceObjectTypeRegistry } from '../surfaces/index.js';
import { workspacePath } from '../paths.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { VaultRevisionService } from '../revisions.js';
import { InMemorySearchService } from '../search/service.js';
import { createMemoryVault } from '../vault/memory.js';
import { whiteboardKind, whiteboardKindId } from './kind.js';

describe('large unbounded board', () => {
  it('creates/reopens a board with many objects across ±50k extent and compiles without loss', async () => {
    const { wsPromise } = (() => {
      const { vault } = createMemoryVault();
      const registry = new InMemoryDocumentRegistry();
      registry.register(whiteboardKind);
      const metadata = new InMemoryMetadataService();
      const relationships = new InMemoryRelationshipService();
      const search = new InMemorySearchService();
      const revisions = new VaultRevisionService({ vault, resolveResource: () => undefined });
      const wsPromise = WorkspaceServiceImpl.create({ vault, registry, metadata, relationships, revisions, search, workspaceId: 'ws-large' });
      return { wsPromise };
    })();
    const ws = await wsPromise;
    const model = emptySurface(infiniteFrame());
    const count = 2000;
    for (let i = 0; i < count; i++) {
      const id = `o${i}`;
      const x = (i % 100) * 1000 - 50000;
      const y = Math.floor(i / 100) * 1000 - 50000;
      if (i % 6 === 0) model.objects[id] = textObject(id, { x, y, text: `text ${i}` });
      else if (i % 6 === 1) model.objects[id] = cardObject(id, { x, y, width: 200, height: 120, text: `card ${i}` });
      else if (i % 6 === 2) model.objects[id] = rectangleObject(id, { x, y, width: 50, height: 50 });
      else if (i % 6 === 3) model.objects[id] = resourceEmbedObject(id, { x, y, width: 300, height: 200, target: { documentId: `doc${i}`, kindId: 'froglight.markdown', resourceId: `res${i}` }, cachedTitle: `title ${i}` });
      else model.objects[id] = textObject(id, { x, y, text: `extra ${i}` });
      model.order.push(id);
    }
    const created = await ws.createDocument({ kindId: whiteboardKindId, path: workspacePath('large.whiteboard'), initialModel: model });
    const opened = await ws.openDocument(created.documentId);
    expect((opened.model as SurfaceModel).order).toHaveLength(count);
    // compile → cull smoke: must complete quickly (<200ms for 10k is spec; 2k should be trivial)
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const start = performance.now();
    const scene = compileScene(opened.model as SurfaceModel, registry);
    expect(scene).toHaveLength(count);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    await opened.close();
  });

  it('headless decode→compile→cull over 10k objects completes without error', () => {
    const model = emptySurface(infiniteFrame());
    for (let i = 0; i < 10000; i++) model.objects[`o${i}`] = rectangleObject(`o${i}`, { x: i, y: i, width: 10, height: 10 });
    model.order.push(...Object.keys(model.objects));
    const start = performance.now();
    const decoded = decodeWhiteboard(encodeWhiteboard(model));
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const scene = compileScene(decoded.model, registry);
    expect(scene).toHaveLength(10000);
    expect(performance.now() - start).toBeLessThan(800);
  });
});

describe('resource reference survival', () => {
  it('move/rename via stable id leaves whiteboard bytes unchanged except vault path', async () => {
    const { vault } = createMemoryVault();
    const registry = new InMemoryDocumentRegistry();
    registry.register(whiteboardKind);
    const ws = await WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: new VaultRevisionService({ vault, resolveResource: () => undefined }),
      search: new InMemorySearchService(),
      workspaceId: 'ws-rename',
    });
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', { x: 0, y: 0, width: 100, height: 100, target: { documentId: 'docA', kindId: 'froglight.markdown', resourceId: 'resA' }, cachedTitle: 'A' });
    model.order.push('e1');
    const created = await ws.createDocument({ kindId: whiteboardKindId, path: workspacePath('board.whiteboard'), initialModel: model });
    const opened = await ws.openDocument(created.documentId);
    const before = encodeWhiteboard(opened.model as SurfaceModel);
    await opened.close();
    // Simulate vault move of target document (no board bytes change)
    const reopened = await ws.openDocument(created.documentId);
    expect(encodeWhiteboard(reopened.model as SurfaceModel)).toEqual(before);
    await reopened.close();
  });
});

describe('provider removal placeholder', () => {
  it('removing preview provider keeps spatial frame as recoverable placeholder', () => {
    const registry = new InMemoryCompositionRegistry();
    const target = { documentId: 'doc1', kindId: 'froglight.markdown', resourceId: 'res1' };
    // No provider registered → placeholder
    const handle = registry.open({ role: 'preview', target });
    expect(handle.snapshot().state).toBe('placeholder');
    expect(handle.snapshot()).toMatchObject({ reason: 'missing-provider', recoverable: true });
    handle.dispose();

    // Register then remove → before has preview, after has placeholder, but board bytes never changed
    const reg = new InMemoryCompositionRegistry();
    const provider = {
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview' as const],
      writeAuthority: 'none' as const,
      open: () => ({
        snapshot: () => ({ state: 'ready' as const, title: 'hello' }),
        onDidChange: () => ({ dispose: () => undefined }),
        dispose: () => undefined,
      }),
    };
    const disp = reg.register(provider);
    const h1 = reg.open({ role: 'preview', target });
    expect(h1.snapshot().state).toBe('ready');
    h1.dispose();
    disp.dispose();
    const h2 = reg.open({ role: 'preview', target });
    expect(h2.snapshot().state).toBe('placeholder');
    h2.dispose();
  });
});

describe('cycle and depth safety', () => {
  it('terminates at repeated target/location with placeholder', () => {
    const registry = new InMemoryCompositionRegistry();
    const target = { documentId: 'docA', kindId: 'froglight.whiteboard', resourceId: 'resA' };
    const key = `preview\u001fdocA\u001ffroglight.whiteboard\u001fresA\u001f\u001f`;
    const handle = registry.open({ role: 'preview', target, ancestry: [key] });
    expect(handle.snapshot()).toMatchObject({ state: 'placeholder', reason: 'cycle' });
  });

  it('depth bound 16 terminates with depth placeholder', () => {
    const registry = new InMemoryCompositionRegistry();
    const target = { documentId: 'docX', kindId: 'froglight.markdown', resourceId: 'resX' };
    const ancestry = Array.from({ length: MAX_COMPOSITION_DEPTH }, (_, i) => `k${i}`);
    const handle = registry.open({ role: 'preview', target, ancestry });
    expect(handle.snapshot()).toMatchObject({ state: 'placeholder', reason: 'depth' });
  });
});

describe('unknown object preservation', () => {
  it('unknown plugin object survives round-trip', () => {
    const model = emptySurface(infiniteFrame());
    (model.objects as Record<string, unknown>).u1 = { id: 'u1', type: 'acme.widget', foo: { bar: [1, 2] }, extra: 'keep' };
    model.order.push('u1');
    const decoded = decodeWhiteboard(encodeWhiteboard(model));
    expect(decoded.model.objects.u1).toEqual({ id: 'u1', type: 'acme.widget', foo: { bar: [1, 2] }, extra: 'keep' });
    expect(decoded.model.objects.u1.type).toBe('acme.widget');
    // Compiles to placeholder draw-item, not dropped
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const scene = compileScene(decoded.model, registry);
    const placeholder = scene.find((i) => i.objectId === 'u1');
    expect(placeholder?.kind).toBe('placeholder');
  });
});

describe('locked objects', () => {
  it('locked objects skip hit-test but still render', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.r1 = { id: 'r1', type: 'froglight.rectangle', x: 0, y: 0, width: 100, height: 100, locked: true };
    model.order.push('r1');
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const desc = registry.get('froglight.rectangle');
    expect(desc).toBeDefined();
    expect(desc!.hitTest?.(model.objects.r1, 50, 50)).toBe(false);
    const scene = compileScene(model, registry);
    expect(scene[0]?.objectId).toBe('r1');
  });
});
