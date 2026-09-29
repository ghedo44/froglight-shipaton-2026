/**
 * Interaction controller behavior: normalized input events
 * produce model mutations and camera changes — fully headless. Selection
 * is ephemeral session state and never enters the canonical payload.
 */

import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { createCamera } from './geometry.js';
import {
  rectangleObject,
  textObject,
  lineObject,
  infiniteFrame,
  inkStrokeObject,
} from './model.js';
import type { SurfaceModel } from './model.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import { SurfaceInteractionController } from './controller.js';

function board(): SurfaceModel {
  return {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['back', 'front', 'label', 'ghost'],
    objects: {
      back: rectangleObject('back', { x: 0, y: 0, width: 20, height: 20 }),
      front: rectangleObject('front', { x: 5, y: 5, width: 10, height: 10 }),
      label: textObject('label', { x: 30, y: 30, text: 'note' }),
      ghost: { id: 'ghost', type: 'acme.immovable', data: true },
    },
  };
}

const registry = () => createDefaultSurfaceObjectTypeRegistry();

describe('selection', () => {
  it('picks the topmost object under the pointer', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
    });
    expect(c.hitTest({ x: 8, y: 8 })).toBe('front');
    expect(c.hitTest({ x: 1, y: 1 })).toBe('back');
    expect(c.hitTest({ x: 500, y: 500 })).toBeNull();
    c.pointerDown({ point: { x: 8, y: 8 } });
    expect(c.selection()).toEqual(['front']);
  });

  it('clears selection on empty clicks and extends it with shift-clicks', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
    });
    c.pointerDown({ point: { x: 8, y: 8 } });
    c.pointerDown({ point: { x: 500, y: 500 } });
    expect(c.selection()).toEqual([]);
    c.pointerDown({ point: { x: 1, y: 1 } });
    c.pointerDown({ point: { x: 31, y: 31 }, shift: true });
    expect(c.selection()).toEqual(['back', 'label']);
  });

  it('never leaks selection into canonical data', () => {
    const model = board();
    const c = new SurfaceInteractionController({ model, registry: registry() });
    c.pointerDown({ point: { x: 8, y: 8 } });
    expect(JSON.parse(JSON.stringify(model))).toEqual(board());
  });
});

describe('contextual touch targets', () => {
  for (const indexed of [false, true]) {
    for (const zoom of [0.5, 1, 4]) {
      it(`keeps touch tolerance in screen space (indexed=${indexed}, zoom=${zoom})`, () => {
        const model = board();
        const c = new SurfaceInteractionController({
          model,
          registry: registry(),
          camera: { x: 0, y: 0, zoom },
        });
        if (indexed) c.ensureIndexes();
        const before = JSON.stringify(model);
        // Ten CSS pixels to the left of text, outside the precise predicate.
        const point = { x: 30 * zoom - 10, y: 31 * zoom };
        expect(c.hitTest({ x: point.x / zoom, y: point.y / zoom })).not.toBe(
          'label',
        );
        expect(c.touchSelectionTarget(point)).toEqual({
          kind: 'object',
          id: 'label',
        });
        expect(
          c.touchSelectionTarget({ x: 30 * zoom - 13, y: 31 * zoom }),
        ).toBeNull();
        expect(c.touchSelectionTarget({ x: zoom, y: zoom })).toEqual({
          kind: 'object',
          id: 'back',
        });
        c.setSelection(['back', 'front']);
        expect(c.touchSelectionTarget({ x: 8 * zoom, y: 8 * zoom })).toEqual({
          kind: 'selection',
        });
        expect(JSON.stringify(model)).toBe(before);
      });
    }
  }
  it('uses registered geometry for custom touch targets instead of selecting empty bounding boxes', () => {
    const model = board();
    model.objects.custom = {
      id: 'custom',
      type: 'acme.widget',
      x: 200,
      y: 200,
      width: 60,
      height: 60,
    };
    model.order.push('custom');
    const types = registry();
    types.register({
      typeId: 'acme.widget',
      version: 1,
      boundsOf: () => ({ x: 200, y: 200, width: 60, height: 60 }),
      hitTest: (_record, x, y) => Math.hypot(x - 230, y - 230) <= 30,
    });
    const controller = new SurfaceInteractionController({
      model,
      registry: types,
    });
    for (const indexed of [false, true]) {
      if (indexed) controller.ensureIndexes();
      expect(controller.touchSelectionTarget({ x: 230, y: 230 })).toEqual({
        kind: 'object',
        id: 'custom',
      });
      expect(controller.touchSelectionTarget({ x: 201, y: 201 })).toBeNull();
    }
  });

  it('discovers rotated text through the index without changing its canonical bounds', () => {
    const model = board();
    model.objects.label = {
      ...textObject('label', {
        x: 100,
        y: 100,
        text: 'Rotated finger target',
        appearance: { wrapWidth: 200 },
      }),
      rotation: Math.PI / 2,
    };
    const c = new SurfaceInteractionController({ model, registry: registry() });
    const before = JSON.stringify(model);
    // Query a point on the far end of the rotated box, outside its local AABB.
    c.setSelection(['label']);
    const bounds = c.selectionBoundsCached()!;
    c.setSelection([]);
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + 2 };
    expect(c.touchSelectionTarget(point)).toEqual({
      kind: 'object',
      id: 'label',
    });
    c.ensureIndexes();
    expect(c.touchSelectionTarget(point)).toEqual({
      kind: 'object',
      id: 'label',
    });
    expect(JSON.stringify(model)).toBe(before);
  });

  it('skips locked text and selects semantic cards', () => {
    const model = board();
    model.objects.label = { ...model.objects.label!, locked: true };
    model.objects.card = {
      id: 'card',
      type: 'froglight.card',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      text: 'Card text',
    };
    model.order.push('card');
    const c = new SurfaceInteractionController({ model, registry: registry() });
    c.ensureIndexes();
    expect(c.touchSelectionTarget({ x: 31, y: 31 })).toBeNull();
    expect(c.touchSelectionTarget({ x: 150, y: 150 })).toEqual({
      kind: 'object',
      id: 'card',
    });
  });
});

describe('drag translation', () => {
  it('tracks repeated pointer moves without compounding down-relative deltas', () => {
    const model = board();
    const c = new SurfaceInteractionController({ model, registry: registry() });
    c.pointerDown({ point: { x: 8, y: 8 } });
    // Ephemeral (Slice 1): canonical stays put during moves; only the
    // session delta updates.
    c.pointerMove({ point: { x: 18, y: 18 } });
    expect(model.objects.front!.x).toBe(5);
    expect(c.selectionDrag()?.delta).toEqual({ x: 10, y: 10 });
    c.pointerMove({ point: { x: 28, y: 28 } });
    c.pointerMove({ point: { x: 38, y: 38 } });
    expect(model.objects.front!.x).toBe(5);
    expect(c.selectionDrag()?.delta).toEqual({ x: 30, y: 30 });
    // Pointer-up commits once.
    c.pointerUp({ point: { x: 38, y: 38 } });
    expect(model.objects.front!.x).toBe(35);
    expect(model.objects.front!.y).toBe(35);
  });

  it('moves selected objects by the surface delta and reports mutations', () => {
    const model = board();
    const mutated: string[][] = [];
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      onMutate: (ids) => mutated.push([...ids]),
    });
    c.pointerDown({ point: { x: 8, y: 8 } });
    // Ephemeral: no canonical mutation per move, no onMutate per move.
    const moved = c.pointerMove({ point: { x: 13, y: 12 } });
    expect(moved).toEqual([]);
    expect(mutated).toEqual([]);
    expect(model.objects.front!.x).toBe(5);
    expect(c.dragDelta()).toEqual({ x: 5, y: 4 });
    c.pointerUp({ point: { x: 13, y: 12 } });
    expect(mutated).toEqual([['front']]);
    expect(model.objects.front!.x).toBe(10);
    expect(model.objects.front!.y).toBe(9);
    expect(model.objects.back!.x).toBe(0);
  });

  it('translates every selected object together', () => {
    const model = board();
    const c = new SurfaceInteractionController({ model, registry: registry() });
    c.pointerDown({ point: { x: 1, y: 1 } });
    // The shift-click extends the selection AND re-anchors the drag.
    c.pointerDown({ point: { x: 31, y: 31 }, shift: true });
    c.pointerMove({ point: { x: 33, y: 33 } });
    c.pointerUp({ point: { x: 33, y: 33 } });
    expect(model.objects.back!.x).toBe(2);
    expect(model.objects.back!.y).toBe(2);
    // label anchored at (30,30): +2 on both axes.
    expect(model.objects.label!.x).toBe(32);
    expect(model.objects.label!.y).toBe(32);
  });

  it('skips plugin objects without usable geometry instead of corrupting them', () => {
    const model = board();
    const c = new SurfaceInteractionController({ model, registry: registry() });
    c.setSelection(['front', 'ghost']);
    const moved = c.moveSelectionBy({ x: 100, y: 100 });
    expect(moved).toEqual(['front']);
    expect(model.objects.ghost).toEqual({
      id: 'ghost',
      type: 'acme.immovable',
      data: true,
    });
  });

  it('ignores moves without an active drag', () => {
    const model = board();
    const c = new SurfaceInteractionController({ model, registry: registry() });
    c.setSelection(['front']);
    expect(c.pointerMove({ point: { x: 99, y: 99 } })).toEqual([]);
    expect(model.objects.front!.x).toBe(5);
  });
});

describe('arrange selection', () => {
  function arrangeBoard() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'b', 'c'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 10, height: 10 }),
        b: rectangleObject('b', { x: 30, y: 5, width: 10, height: 10 }),
        c: rectangleObject('c', { x: 70, y: 0, width: 10, height: 10 }),
      },
    };
    const mutated: string[][] = [];
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      onMutate: (ids) => mutated.push([...ids]),
    });
    return { model, mutated, c };
  }

  it('aligns edges and centers to the selection union', () => {
    const { model, mutated, c } = arrangeBoard();
    c.setSelection(['a', 'b', 'c']);
    expect(c.alignSelection('left')).toEqual(['b', 'c']);
    expect(model.objects.b!.x).toBe(0);
    expect(model.objects.c!.x).toBe(0);
    expect(model.objects.a!.x).toBe(0);
    expect(mutated).toEqual([['b', 'c']]);
    expect(c.alignSelection('top')).toEqual(['b']);
    expect(model.objects.b!.y).toBe(0);
  });

  it('distributes middles with equal gaps keeping the outer pair', () => {
    const { model, mutated, c } = arrangeBoard();
    c.setSelection(['a', 'b', 'c']);
    // Span 0..80, widths 30, gap (80-30)/2 = 25: b lands at 35.
    expect(c.distributeSelection('x')).toEqual(['b']);
    expect(model.objects.b!.x).toBe(35);
    expect(model.objects.a!.x).toBe(0);
    expect(model.objects.c!.x).toBe(70);
    expect(mutated).toEqual([['b']]);
    // Fewer than three members distribute nothing.
    c.setSelection(['a']);
    expect(c.distributeSelection('x')).toEqual([]);
  });

  it('locks objects out of hit-testing and unlocks them back', () => {
    const { model, mutated, c } = arrangeBoard();
    expect(c.setLocked(['a'], true)).toEqual(['a']);
    expect(model.objects.a!.locked).toBe(true);
    expect(c.hitTest({ x: 5, y: 5 })).toBeNull();
    // Locked members skip arrangement (line over unlocked only).
    c.setSelection(['a', 'b', 'c']);
    expect(c.alignSelection('left')).toEqual(['c']);
    expect(model.objects.b!.x).toBe(30);
    expect(model.objects.c!.x).toBe(30);
    expect(c.setLocked(['a'], false)).toEqual(['a']);
    expect(model.objects.a!.locked).toBeUndefined();
    expect(c.hitTest({ x: 5, y: 5 })).toBe('a');
    expect(mutated[mutated.length - 1]).toEqual(['a']);
  });

  it('excludes locked objects from move drags', () => {
    const { model, c } = arrangeBoard();
    c.setLocked(['a'], true);
    c.setSelection(['a', 'b']);
    c.moveSelectionBy({ x: 10, y: 0 });
    expect(model.objects.a!.x).toBe(0);
    expect(model.objects.b!.x).toBe(40);
  });
});

describe('snap alignment', () => {
  it('is off by default: drags translate exactly', () => {
    const model = board();
    const guides: unknown[] = [];
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      onSnapGuides: (items) => guides.push(items.length),
    });
    c.pointerDown({ point: { x: 8, y: 8 } });
    c.pointerMove({ point: { x: 13, y: 12 } });
    c.pointerUp({ point: { x: 13, y: 12 } });
    expect(model.objects.front!.x).toBe(10);
    expect(guides).toEqual([]);
  });

  it('snaps dragged edges to neighbors and reports guides', () => {
    // Nearby-only snapping (Slice 4): static sits on the same row so the
    // spatial-index query (expanded moving bounds) finds it. Far objects
    // outside the threshold margin no longer snap (performance gate).
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['static', 'moving'],
      objects: {
        static: rectangleObject('static', {
          x: 100,
          y: 200,
          width: 40,
          height: 40,
        }),
        moving: rectangleObject('moving', {
          x: 0,
          y: 200,
          width: 40,
          height: 40,
        }),
      },
    };
    const seen: number[] = [];
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      snapThresholdView: 8,
      onSnapGuides: (items) => {
        seen.push(items.length);
      },
    });
    // Grab the moving box and drag its max edge to 116 (4 short of 120).
    c.pointerDown({ point: { x: 10, y: 210 } });
    c.pointerMove({ point: { x: 86, y: 210 } });
    // Ephemeral: canonical unchanged during move, guides still publish.
    expect(model.objects.moving!.x).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(1);
    // Snapped +4 on commit: max edge lands on the static center.
    c.pointerUp({ point: { x: 86, y: 210 } });
    expect(model.objects.moving!.x).toBe(80);
  });
});

describe('camera gestures', () => {
  it('zooms around the cursor keeping the focused point fixed', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
      camera: createCamera(0, 0, 1),
    });
    c.wheel({ point: { x: 400, y: 400 }, factor: 2 });
    expect(c.camera().zoom).toBe(2);
    // The surface point under the cursor (view 400,400 at zoom 1 →
    // surface 400,400) still projects to view 400,400 after zooming.
    expect(c.camera().x).toBeCloseTo(200, 6);
    expect(c.camera().y).toBeCloseTo(200, 6);
  });

  it('respects configured zoom clamps', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
      camera: createCamera(0, 0, 1),
      minZoom: 0.5,
      maxZoom: 4,
    });
    c.wheel({ point: { x: 50, y: 50 }, factor: 100 });
    expect(c.camera().zoom).toBe(4);
    c.wheel({ point: { x: 50, y: 50 }, factor: 0.0001 });
    expect(c.camera().zoom).toBe(0.5);
  });

  it('pans by a view-space delta through the current zoom', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
      camera: createCamera(10, 20, 2),
    });
    c.panBy({ x: 100, y: 50 });
    expect(c.camera().x).toBeCloseTo(60, 9);
    expect(c.camera().y).toBeCloseTo(45, 9);
    expect(c.camera().zoom).toBe(2);
  });

  it('derives a deterministic default wheel factor from deltaY', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
    });
    c.wheel({ point: { x: 0, y: 0 }, deltaY: -100 });
    expect(c.camera().zoom).toBeCloseTo(1.1, 9);
    c.wheel({ point: { x: 0, y: 0 }, deltaY: 100 });
    expect(c.camera().zoom).toBeCloseTo(1, 9);
  });
});

describe('object transforms', () => {
  it('resizes with negative clamping and reports the mutation', () => {
    const model = board();
    const mutated: string[][] = [];
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      onMutate: (ids) => mutated.push([...ids]),
    });
    c.resizeObject('front', { width: -5, height: 12 });
    expect(model.objects.front!.width).toBe(0);
    expect(model.objects.front!.height).toBe(12);
    expect(mutated).toEqual([['front']]);
  });

  it('rejects unknown ids and cap violations with structured errors', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
    });
    try {
      c.resizeObject('nope', { width: 1 });
      expect.unreachable('expected INVALID_ID');
    } catch (error) {
      expect((error as FroglightError).code).toBe('INVALID_ID');
    }
    try {
      c.resizeObject('front', { width: 1e12 });
      expect.unreachable('expected FORMAT_LIMIT_EXCEEDED');
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
    try {
      c.rotateObject('front', Number.NaN);
      expect.unreachable('expected FORMAT_LIMIT_EXCEEDED');
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
  });

  it('accumulates rotation on the stored record', () => {
    const model = board();
    const c = new SurfaceInteractionController({ model, registry: registry() });
    c.rotateObject('front', Math.PI / 2);
    c.rotateObject('front', Math.PI / 2);
    expect(model.objects.front!.rotation).toBeCloseTo(Math.PI, 12);
  });
});

describe('connector endpoint drag', () => {
  function dragBoard() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'b', 'c'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 }),
        b: rectangleObject('b', { x: 100, y: 0, width: 20, height: 20 }),
        c: lineObject('c', {
          x: 20,
          y: 10,
          x2: 100,
          y2: 10,
          arrows: 'end',
          source: { objectId: 'a', anchor: 'e' },
        }),
      },
    };
    const mutated: string[][] = [];
    let ids = 0;
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      onMutate: (m) => mutated.push([...m]),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    return { model, mutated, c };
  }

  it('previews bound arrows during a drag without mutating saved objects', () => {
    const { model, c } = dragBoard();
    const before = JSON.stringify(model);
    c.pointerDown({ point: { x: 5, y: 5 } });
    c.pointerMove({ point: { x: 35, y: 45 } });
    expect(c.selectionDrag()?.followers).toEqual([
      expect.objectContaining({ objectId: 'c', x: 50, y: 50, x2: 100, y2: 10 }),
    ]);
    expect(JSON.stringify(model)).toBe(before);
    c.pointerCancel();
    expect(c.selectionDrag()).toBeNull();
    expect(JSON.stringify(model)).toBe(before);
  });

  it('drags a free endpoint and rebinds it on drop over an object', () => {
    const { model, mutated, c } = dragBoard();
    c.setSelection(['c']);
    // Grab the free target end at (100,10), drag left, drop on `a`.
    c.pointerDown({ point: { x: 100, y: 10 } });
    c.pointerMove({ point: { x: 60, y: 10 } });
    expect(model.objects.c!.x2).toBe(60);
    c.pointerUp({ point: { x: 2, y: 10 } });
    expect(model.objects.c!.target).toEqual({ objectId: 'a', anchor: 'w' });
    expect(model.objects.c!.x2).toBe(0);
    expect(model.objects.c!.y2).toBe(10);
    expect(mutated.length).toBeGreaterThan(0);
  });

  it('keeps a free drop unbound at the pointer', () => {
    const { model, c } = dragBoard();
    c.setSelection(['c']);
    c.pointerDown({ point: { x: 100, y: 10 } });
    c.pointerMove({ point: { x: 60, y: 50 } });
    c.pointerUp({ point: { x: 60, y: 50 } });
    expect(model.objects.c!.target).toBeUndefined();
    expect(model.objects.c!.x2).toBe(60);
    expect(model.objects.c!.y2).toBe(50);
  });

  it('restores a bound endpoint on cancellation, including a return to its origin', () => {
    const { model, c } = dragBoard();
    c.setSelection(['c']);
    c.pointerDown({ point: { x: 20, y: 10 } });
    c.pointerMove({ point: { x: 50, y: 40 } });
    expect(model.objects.c!.source).toBeUndefined();
    expect(model.objects.c!.x).toBe(50);
    c.pointerMove({ point: { x: 20, y: 10 } });
    c.pointerCancel();
    expect(model.objects.c!.source).toEqual({ objectId: 'a', anchor: 'e' });
    expect(model.objects.c).toMatchObject({ x: 20, y: 10 });
  });

  it('treats a tap on an endpoint as a no-op', () => {
    const { model, mutated, c } = dragBoard();
    c.setSelection(['c']);
    c.pointerDown({ point: { x: 100, y: 10 } });
    c.pointerUp({ point: { x: 100, y: 10 } });
    expect(model.objects.c!.target).toBeUndefined();
    expect(mutated).toEqual([]);
  });
});

describe('quick-connect drag', () => {
  it('drags a connector out of a shape anchor and binds the drop target', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'b'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 }),
        b: rectangleObject('b', { x: 100, y: 0, width: 20, height: 20 }),
      },
    };
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      idFactory: () => 'conn-1',
    });
    c.setSelection(['a']);
    // East anchor of `a` is (20,10): grab, drag past the threshold.
    c.pointerDown({ point: { x: 20, y: 10 } });
    c.pointerMove({ point: { x: 22, y: 10 } });
    expect(model.order).toEqual(['a', 'b']);
    c.pointerMove({ point: { x: 60, y: 10 } });
    expect(model.order).toEqual(['a', 'b', 'conn-1']);
    c.pointerUp({ point: { x: 102, y: 10 } });
    expect(model.objects['conn-1']).toMatchObject({
      type: 'froglight.line',
      arrows: 'end',
      source: { objectId: 'a', anchor: 'e' },
      target: { objectId: 'b', anchor: 'w' },
    });
  });

  it('moves a selected ink stroke grabbed on its center anchor instead of quick-connecting', () => {
    // Thin horizontal stroke x 100..172 at y 100: its envelope center
    // anchor sits exactly on the visible ink. Grabbing there must start a
    // MOVE drag (PWA selection-drag regression): ink strokes never opt
    // into quick-connect anchors, so no connector/card may materialize.
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [100, 118, 136, 154, 172].map((x, i) => ({
            x,
            y: 100,
            pressure: 0.5,
            dt: i * 8,
          })),
          width: 3.5,
        }),
      },
    };
    let ids = 0;
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    c.setSelection(['s']);
    c.pointerDown({ point: { x: 136, y: 100 } });
    expect(c.selection()).toEqual(['s']);
    expect(c.selectionDrag()).not.toBeNull();
    c.pointerMove({ point: { x: 176, y: 124 } });
    expect(c.selectionDrag()?.delta).toEqual({ x: 40, y: 24 });
    c.pointerUp({ point: { x: 176, y: 124 } });
    // Pure translation: the stroke moved, nothing was materialized.
    expect(model.order).toEqual(['s']);
    const points = (
      model.objects.s as unknown as { points: { x: number; y: number }[] }
    ).points;
    expect(points[0]).toMatchObject({ x: 140, y: 124 });
    expect(points[points.length - 1]).toMatchObject({ x: 212, y: 124 });
  });

  it('keeps empty drops as free arrows and rolls back cancelled arrows', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 }),
      },
    };
    let ids = 0;
    const c = new SurfaceInteractionController({
      model,
      registry: registry(),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    c.setSelection(['a']);
    c.pointerDown({ point: { x: 20, y: 10 } });
    c.pointerMove({ point: { x: 200, y: 200 } });
    c.pointerUp({ point: { x: 200, y: 200 } });
    expect(model.objects['gen-1']).toMatchObject({
      type: 'froglight.line',
      x2: 200,
      y2: 200,
    });
    expect(model.objects['gen-1']!.target).toBeUndefined();
    expect(model.objects['gen-2']).toBeUndefined();
    // Cancel removes the materialized pair without further traces.
    c.pointerDown({ point: { x: 20, y: 10 } });
    c.pointerMove({ point: { x: 300, y: 300 } });
    c.pointerCancel();
    expect(model.order).toEqual(['a', 'gen-1']);
  });
});

describe('lifecycle', () => {
  it('destroy clears state and rejects further events', () => {
    const c = new SurfaceInteractionController({
      model: board(),
      registry: registry(),
    });
    c.pointerDown({ point: { x: 8, y: 8 } });
    c.destroy();
    expect(c.selection()).toEqual([]);
    expect(() => c.pointerDown({ point: { x: 1, y: 1 } })).toThrowError(
      FroglightError,
    );
    try {
      c.pointerDown({ point: { x: 1, y: 1 } });
    } catch (error) {
      expect((error as FroglightError).code).toBe('SERVICE_DISPOSED');
    }
  });
});
