/**
 * Draw-item compilation and the renderer backend seam:
 * object payloads compile to plain-data draw items; backends see only
 * draw items + camera; unknown types render placeholders; culling runs
 * against item bounds. All assertions are on emitted plain data.
 */

import { describe, expect, it } from 'vitest';
import { RecordingSurfaceBackend } from '../testing/headless-surface-backend.js';
import { createCamera } from './geometry.js';
import { rectangleObject, textObject, infiniteFrame, boundedFrame } from './model.js';
import type { SurfaceModel } from './model.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import { InMemorySurfaceObjectTypeRegistry } from './registry.js';
import { compileScene, dispatchScene, renderSurfaceScene } from './render.js';

function modelWith(objects: SurfaceModel['objects'], order?: string[], frame = infiniteFrame()): SurfaceModel {
  return {
    formatVersion: 1,
    frame,
    order: order ?? Object.keys(objects),
    objects,
  };
}

describe('scene compilation', () => {
  it('compiles registered core objects to typed draw items in paint order', () => {
    const model = modelWith({
      r1: rectangleObject('r1', { x: 0, y: 0, width: 10, height: 4, rotation: Math.PI / 6, fill: '#ff0000' }),
      t1: textObject('t1', { x: 5, y: 6, text: 'hi', size: 20 }),
    });
    const items = compileScene(model, createDefaultSurfaceObjectTypeRegistry());
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'rect',
      objectId: 'r1',
      bounds: { x: 0, y: 0, width: 10, height: 4 },
      rotation: Math.PI / 6,
      fill: '#ff0000',
    });
    expect(items[1]).toMatchObject({ kind: 'text', objectId: 't1', text: 'hi', size: 20 });
  });

  it('renders unknown types as placeholder boxes derived from loose envelope fields', () => {
    const model = modelWith({
      x1: { id: 'x1', type: 'acme.callout', x: 3, y: 4, width: 8, height: 2 },
      e1: { id: 'e1', type: 'acme.ghost' },
    });
    const items = compileScene(model, new InMemorySurfaceObjectTypeRegistry());
    expect(items).toEqual([
      {
        kind: 'placeholder',
        objectId: 'x1',
        bounds: { x: 3, y: 4, width: 8, height: 2 },
        rotation: 0,
        label: 'acme.callout',
      },
      {
        kind: 'placeholder',
        objectId: 'e1',
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        rotation: 0,
        label: 'acme.ghost',
      },
    ]);
  });

  it('falls back to a placeholder when a registered compiler fails', () => {
    const registry = new InMemorySurfaceObjectTypeRegistry();
    registry.register({
      typeId: 'acme.boom',
      version: 1,
      compile: () => {
        throw new Error('boom');
      },
    });
    const model = modelWith({ b1: { id: 'b1', type: 'acme.boom', x: 1, y: 1, width: 2, height: 2 } });
    const items = compileScene(model, registry);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'placeholder', objectId: 'b1', label: 'acme.boom' }),
    ]);
  });

  it('treats unregistered core types like any other unknown type', () => {
    // An empty registry proves rendering never depends on a particular
    // registration set — the canonical format stands alone.
    const model = modelWith({
      r1: rectangleObject('r1', { x: 0, y: 0, width: 2, height: 2 }),
    });
    const items = compileScene(model, new InMemorySurfaceObjectTypeRegistry());
    expect(items[0]).toMatchObject({ kind: 'placeholder', objectId: 'r1', label: 'froglight.rectangle' });
  });
});

describe('render pipeline', () => {
  it('dispatches exactly the visible items in paint order', () => {
    const model = modelWith(
      {
        near: rectangleObject('near', { x: 10, y: 10, width: 50, height: 50 }),
        far: rectangleObject('far', { x: -5, y: -5, width: 10, height: 10 }),
        late: textObject('late', { x: 30, y: 30, text: 'z' }),
      },
      ['far', 'near', 'late'],
    );
    const backend = new RecordingSurfaceBackend();
    renderSurfaceScene(backend, model, createDefaultSurfaceObjectTypeRegistry(), createCamera(0, 0, 1), {
      width: 100,
      height: 100,
    });
    expect(backend.ops).toEqual([
      { op: 'begin', camera: { x: 0, y: 0, zoom: 1 }, viewport: { width: 100, height: 100 } },
      { op: 'draw', item: expect.objectContaining({ objectId: 'far' }) },
      { op: 'draw', item: expect.objectContaining({ objectId: 'near' }) },
      { op: 'draw', item: expect.objectContaining({ objectId: 'late' }) },
      { op: 'end' },
    ]);
  });

  it('culls objects fully outside the camera viewport', () => {
    const model = modelWith({
      inside: rectangleObject('inside', { x: 10, y: 10, width: 10, height: 10 }),
      outside: rectangleObject('outside', { x: 1000, y: 1000, width: 10, height: 10 }),
      straddling: rectangleObject('straddling', { x: 95, y: 95, width: 10, height: 10 }),
    });
    const backend = new RecordingSurfaceBackend();
    renderSurfaceScene(backend, model, createDefaultSurfaceObjectTypeRegistry(), createCamera(0, 0, 1), {
      width: 100,
      height: 100,
    });
    const drawn = backend.drawnItemIds();
    expect(drawn).toContain('inside');
    expect(drawn).toContain('straddling');
    expect(drawn).not.toContain('outside');
  });

  it('culls rotated objects by their rotated aabb', () => {
    // The bar's axis-aligned envelope lies entirely left of the viewport,
    // but its 45° swing carries the rotated AABB across the edge — culling
    // must consult the rotated bounds, not the stored envelope.
    const model = modelWith({
      bar: rectangleObject('bar', { x: -30, y: 10, width: 4, height: 80, rotation: Math.PI / 4 }),
    });
    const backend = new RecordingSurfaceBackend();
    renderSurfaceScene(backend, model, createDefaultSurfaceObjectTypeRegistry(), createCamera(0, 0, 1), {
      width: 100,
      height: 100,
    });
    expect(backend.drawnItemIds()).toContain('bar');

    // Without the rotation the same envelope stays fully outside.
    const unrotatedModel = modelWith({
      bar: rectangleObject('bar', { x: -30, y: 10, width: 4, height: 80 }),
    });
    const plainBackend = new RecordingSurfaceBackend();
    renderSurfaceScene(
      plainBackend,
      unrotatedModel,
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(0, 0, 1),
      { width: 100, height: 100 },
    );
    expect(plainBackend.drawnItemIds()).not.toContain('bar');
  });

  it('clips bounded frames once before drawing and never clips infinite frames', () => {
    const objects = {
      r1: rectangleObject('r1', { x: 0, y: 0, width: 5, height: 5 }),
    };
    const boundedBackend = new RecordingSurfaceBackend();
    renderSurfaceScene(
      boundedBackend,
      modelWith(objects, undefined, boundedFrame(800, 600)),
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      { width: 100, height: 100 },
    );
    expect(boundedBackend.ops[1]).toEqual({
      op: 'clip',
      frame: { x: 0, y: 0, width: 800, height: 600 },
    });

    const infiniteBackend = new RecordingSurfaceBackend();
    renderSurfaceScene(
      infiniteBackend,
      modelWith(objects),
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      { width: 100, height: 100 },
    );
    expect(infiniteBackend.ops.some((entry) => entry.op === 'clip')).toBe(false);
  });

  it('produces an identical op stream through any conforming backend', () => {
    // Swap-proof at the seam (pattern): the same scene/camera
    // through two independent backends yields identical recorded streams.
    const model = modelWith({
      r1: rectangleObject('r1', { x: 0, y: 0, width: 10, height: 10 }),
      x1: { id: 'x1', type: 'acme.callout', x: 1, y: 1, width: 3, height: 3 },
    });
    const camera = createCamera(5, 5, 2);
    const viewport = { width: 200, height: 100 };
    const first = new RecordingSurfaceBackend();
    const second = new RecordingSurfaceBackend();
    for (const backend of [first, second]) {
      renderSurfaceScene(backend, model, createDefaultSurfaceObjectTypeRegistry(), camera, viewport);
    }
    expect(second.ops).toEqual(first.ops);
    // Canonical bytes are untouched by rendering.
    expect(model.order).toEqual(['r1', 'x1']);
  });

  it('dispatches a precompiled scene identically to a fresh compile', () => {
    // The version-scoped item cache (committed renderer) replays compiled
    // items across camera moves: dispatch must equal renderSurfaceScene
    // without recompiling.
    const model = modelWith({
      r1: rectangleObject('r1', { x: 0, y: 0, width: 10, height: 10 }),
      x1: { id: 'x1', type: 'acme.callout', x: 1, y: 1, width: 3, height: 3 },
    });
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const camera = createCamera(5, 5, 2);
    const viewport = { width: 200, height: 100 };
    const compiled = new RecordingSurfaceBackend();
    renderSurfaceScene(compiled, model, registry, camera, viewport);
    const replayed = new RecordingSurfaceBackend();
    dispatchScene(
      replayed,
      {
        frame: model.frame,
        items: compileScene(model, registry),
      },
      camera,
      viewport,
    );
    expect(replayed.ops).toEqual(compiled.ops);
  });

  it('replays one compile across pans and zooms with zero recompiles', () => {
    // (scene cache): camera moves must not recompile
    // unchanged committed strokes — count descriptor compiles directly.
    const model = modelWith({
      r1: rectangleObject('r1', { x: 0, y: 0, width: 400, height: 400 }),
    });
    const inner = createDefaultSurfaceObjectTypeRegistry();
    let compiles = 0;
    const counting = new InMemorySurfaceObjectTypeRegistry();
    for (const descriptor of inner.list()) {
      const compile = descriptor.compile?.bind(descriptor);
      counting.register({
        ...descriptor,
        ...(compile !== undefined
          ? {
              compile: (
                ...args: Parameters<NonNullable<typeof descriptor.compile>>
              ) => {
                compiles += 1;
                return compile(...args);
              },
            }
          : {}),
      });
    }
    const viewport = { width: 200, height: 100 };
    const scene = { frame: model.frame, items: compileScene(model, counting) };
    const afterCompile = compiles;
    expect(afterCompile).toBeGreaterThan(0);
    // Pan and zoom dispatch the cached items: no further compiles.
    for (const camera of [
      createCamera(50, 0, 1),
      createCamera(0, 50, 1),
      createCamera(0, 0, 2),
      createCamera(0, 0, 0.5),
    ]) {
      dispatchScene(new RecordingSurfaceBackend(), scene, camera, viewport);
    }
    expect(compiles).toBe(afterCompile);
  });
});
