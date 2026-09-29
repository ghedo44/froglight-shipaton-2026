/**
 * SurfaceGestureHistory unit tests.
 *
 * Patch/command history: entries contain only changed records (absent
 * markers for creations/deletions), order edits, and frame changes.
 * Mutation code records BEFORE images via `recordBefore` — the test
 * seam mirrors the production `onBeforeMutate` wiring.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  infiniteFrame,
  emptySurface,
  rectangleObject,
  freezeInkValue,
  inkStrokeObject,
  publishSurfaceObjects,
  type SurfaceModel,
} from '@froglight/foundation';
import { SurfaceGestureHistory } from './history.js';

function makeModel(): SurfaceModel {
  return emptySurface(boundedFrame(800, 600));
}

describe('SurfaceGestureHistory', () => {
  it('starts with empty undo/redo', () => {
    const history = new SurfaceGestureHistory(makeModel());
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('begin/undo/redo restores the exact pre/post gesture model state', () => {
    const model = makeModel();
    const history = new SurfaceGestureHistory(model);

    history.beginGesture();
    const rect = rectangleObject('r1', { x: 10, y: 10, width: 60, height: 30 });
    history.recordBefore(rect.id);
    model.objects[rect.id] = rect;
    model.order.push(rect.id);
    history.commitGesture();

    expect(history.canUndo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(model.objects['r1']).toBeUndefined();
    expect(model.order).toEqual([]);
    expect(history.canRedo()).toBe(true);

    expect(history.redo()).toBe(true);
    expect(model.objects['r1']).toEqual(rect);
    expect(model.order).toEqual(['r1']);
  });

  it('commit without changes leaves no undo entry', () => {
    const model = makeModel();
    const history = new SurfaceGestureHistory(model);
    history.beginGesture();
    history.commitGesture();
    expect(history.canUndo()).toBe(false);
  });

  it('cancel restores the pre-gesture model without touching undo/redo', () => {
    const model = makeModel();
    const history = new SurfaceGestureHistory(model);
    history.beginGesture();
    const rect = rectangleObject('r1', { x: 10, y: 10, width: 60, height: 30 });
    history.recordBefore(rect.id);
    model.objects[rect.id] = rect;
    model.order.push(rect.id);
    history.cancelGesture();
    expect(model.objects['r1']).toBeUndefined();
    expect(model.order).toEqual([]);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('cancel restores a deleted object at its original order index', () => {
    const model = makeModel();
    const a = rectangleObject('a', { x: 0, y: 0, width: 10, height: 10 });
    const b = rectangleObject('b', { x: 20, y: 0, width: 10, height: 10 });
    model.objects['a'] = a;
    model.objects['b'] = b;
    model.order.push('a', 'b');
    const history = new SurfaceGestureHistory(model);
    history.beginGesture();
    history.recordBefore('a');
    delete model.objects['a'];
    model.order.splice(model.order.indexOf('a'), 1);
    history.cancelGesture();
    expect(model.order).toEqual(['a', 'b']);
    expect(model.objects['a']).toEqual(a);
  });

  it('undo/redo refuse while a gesture is active', () => {
    const model = makeModel();
    const history = new SurfaceGestureHistory(model);
    history.beginGesture();
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
    history.cancelGesture();
  });

  it('cancel of a 100px drag restores exact original coordinates', () => {
    const model = makeModel();
    const rect = rectangleObject('r1', { x: 10, y: 10, width: 60, height: 30 });
    model.objects['r1'] = rect;
    model.order.push('r1');
    const history = new SurfaceGestureHistory(model);
    history.beginGesture();
    history.recordBefore('r1');
    (model.objects['r1'] as unknown as { x: number }).x += 100;
    history.cancelGesture();
    expect((model.objects['r1'] as unknown as { x: number }).x).toBe(10);
    expect(history.canUndo()).toBe(false);
  });

  it('cancel of an image resize restores dimensions', () => {
    const model = makeModel();
    model.objects['img'] = {
      id: 'img',
      type: 'froglight.image',
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    } as never;
    model.order.push('img');
    const history = new SurfaceGestureHistory(model);
    history.beginGesture();
    history.recordBefore('img');
    (
      model.objects['img'] as unknown as { width: number; height: number }
    ).width = 500;
    (
      model.objects['img'] as unknown as { width: number; height: number }
    ).height = 250;
    history.cancelGesture();
    expect(model.objects['img']).toMatchObject({ width: 400, height: 200 });
    expect(history.canUndo()).toBe(false);
  });

  it('cancel of a lasso move restores every displaced object', () => {
    const model = makeModel();
    const a = rectangleObject('a', { x: 0, y: 0, width: 10, height: 10 });
    const b = rectangleObject('b', { x: 30, y: 0, width: 10, height: 10 });
    model.objects['a'] = a;
    model.objects['b'] = b;
    model.order.push('a', 'b');
    const history = new SurfaceGestureHistory(model);
    history.beginGesture();
    history.recordBeforeMany(['a', 'b']);
    (model.objects['a'] as unknown as { x: number; y: number }).x += 25;
    (model.objects['b'] as unknown as { x: number; y: number }).y += 40;
    history.cancelGesture();
    expect(model.objects['a']).toMatchObject({ x: 0, y: 0 });
    expect(model.objects['b']).toMatchObject({ x: 30, y: 0 });
    expect(history.canUndo()).toBe(false);
  });

  it('invalidates redo when a new gesture begins', () => {
    const model = makeModel();
    const history = new SurfaceGestureHistory(model);

    history.beginGesture();
    history.recordBefore('a');
    model.order.push('a');
    model.objects['a'] = rectangleObject('a', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    history.commitGesture();
    expect(history.undo()).toBe(true);
    expect(history.canRedo()).toBe(true);

    history.beginGesture();
    history.recordBefore('b');
    model.order.push('b');
    model.objects['b'] = rectangleObject('b', {
      x: 50,
      y: 0,
      width: 10,
      height: 10,
    });
    history.commitGesture();
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('removes strokes added after the snapshot instead of leaving ghosts', () => {
    const model = makeModel();
    const history = new SurfaceGestureHistory(model);

    history.beginGesture();
    history.recordBefore('s1');
    model.objects['s1'] = rectangleObject('s1', {
      x: 0,
      y: 0,
      width: 5,
      height: 5,
    });
    model.order.push('s1');
    history.commitGesture();

    history.beginGesture();
    history.recordBefore('s2');
    model.objects['s2'] = rectangleObject('s2', {
      x: 100,
      y: 0,
      width: 5,
      height: 5,
    });
    model.order.push('s2');
    history.commitGesture();

    expect(Object.keys(model.objects)).toHaveLength(2);
    expect(history.undo()).toBe(true);
    expect(Object.keys(model.objects)).toHaveLength(1);
    expect(model.order).toEqual(['s1']);
  });
});

describe('incremental paint-order transactions', () => {
  it('does not iterate the existing order at gesture start or commit', () => {
    const model = emptySurface(infiniteFrame());
    const history = new SurfaceGestureHistory(model);
    for (let i = 0; i < 20_000; i++) model.order.push(`old-${i}`);
    Object.defineProperty(model.order, Symbol.iterator, {
      value: () => {
        throw new Error('global order scan');
      },
    });
    history.beginGesture();
    history.recordBefore('new');
    model.objects.new = { id: 'new', type: 'vendor.note', text: 'new' };
    model.order.push('new');
    history.commitGesture();
    expect(history.historyStats().changedRecordsCaptured).toBe(1);
    expect(history.undo()).toBe(true);
    expect(model.order.length).toBe(20_000);
    expect(history.redo()).toBe(true);
    expect(model.order.at(-1)).toBe('new');
    history.dispose();
  });
});

it('one oversized source transaction is rejected while rollback images remain available', () => {
  const model = makeModel(),
    history = new SurfaceGestureHistory(model);
  const unknownSample = 'x'.repeat(17 * 1024 * 1024);
  history.beginGesture();
  for (const id of ['source-a', 'source-b']) {
    history.recordBefore(id);
    const chunk = inkStrokeObject('chunk', {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      width: 3,
    });
    (chunk.points as Array<Record<string, unknown>>)[0]!.unknownSample =
      unknownSample;
    model.objects[id] = freezeInkValue({
      id,
      type: 'froglight.ink.source',
      chunks: [chunk],
      outlineLength: 3,
    });
  }
  publishSurfaceObjects(model, ['source-a', 'source-b']);
  expect(() => history.commitGesture()).toThrow('undo memory budget');
  history.cancelGesture();
  expect(model.objects).toEqual({});
  expect(history.historyStats().entries).toBe(0);
  history.dispose();
});
