/**
 * Selection-verb history regressions.
 *
 * Several direct-mutation verbs mutated canonical records first and only
 * later synchronized/invalidated them, so `history.beginGesture()` saw no
 * BEFORE snapshot, `commitGesture()` built an empty patch, and undo could
 * not restore geometry. These tests route every verb through the real
 * pre-mutation recorder seam (`onBeforeMutate` → `history.recordBeforeMany`)
 * inside a real `selectionTransaction`-style gesture and verify exact
 * canonical samples/style before, after, on undo, and on redo.
 *
 * Pure translation stays a `TranslateObjectsCommand`-style entry (zero
 * sample clones); scale/rotate/style/align are ordinary patches.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  inkStrokeObject,
  rectangleObject,
  type SurfaceModel,
} from '@froglight/foundation';
import { InkToolController } from '@froglight/foundation';
import { SurfaceGestureHistory } from './history.js';

function strokeSamples(
  count: number,
  xBase: number,
  yBase = 200,
): { x: number; y: number; pressure: number; dt: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    x: xBase + i * 2,
    y: yBase + Math.sin(i / 5) * 6,
    pressure: 0.5,
    dt: i * 8,
  }));
}

function addStroke(
  model: SurfaceModel,
  id: string,
  xBase: number,
  extra: Record<string, unknown> = {},
): void {
  model.objects[id] = inkStrokeObject(id, {
    points: strokeSamples(60, xBase),
    width: 3,
    color: '#111111',
    ...extra,
  });
  model.order.push(id);
}

function addChunk(
  model: SurfaceModel,
  id: string,
  logicalId: string,
  chunkIndex: number,
  xBase: number,
): void {
  model.objects[id] = inkStrokeObject(id, {
    points: strokeSamples(40, xBase),
    width: 3,
    logicalId,
    chunkIndex,
  });
  model.order.push(id);
}

function wire(model: SurfaceModel): {
  history: SurfaceGestureHistory;
  controller: InkToolController;
} {
  const registry = createDefaultSurfaceObjectTypeRegistry();
  const history = new SurfaceGestureHistory(model, registry as never);
  const controller = new InkToolController({
    model,
    objectRegistry: registry,
    onBeforeMutate: (ids) => history.recordBeforeMany(ids),
    onBeforeTranslate: (ids, dx, dy) => history.recordTranslate(ids, dx, dy),
    onMutate: () => undefined,
  });
  return { history, controller };
}

/** Production-style verb transaction (mirrors `selectionTransaction`). */
function transact(
  history: SurfaceGestureHistory,
  controller: InkToolController,
  run: () => string[],
): string[] {
  history.beginGesture();
  const ids = run();
  if (ids.length > 0) {
    history.commitGesture();
    const finalIds =
      history.lastChangeIds().length > 0 ? history.lastChangeIds() : ids;
    controller.notifyExternalMutation(finalIds);
  } else {
    history.cancelGesture();
  }
  return ids;
}

function undoRedoSync(
  history: SurfaceGestureHistory,
  controller: InkToolController,
  which: 'undo' | 'redo',
): boolean {
  const ok = which === 'undo' ? history.undo() : history.redo();
  if (!ok) return false;
  const translated = history.lastChangeTranslate();
  const ids = history.lastChangeIds();
  if (translated !== null) {
    controller.notifyTranslated(translated.ids, translated.dx, translated.dy);
  } else {
    controller.notifyExternalMutation(ids);
  }
  return true;
}

function pointsOf(model: SurfaceModel, id: string): { x: number; y: number }[] {
  const record = model.objects[id] as unknown as {
    points: { x: number; y: number }[];
  };
  return record.points.map((p) => ({ x: p.x, y: p.y }));
}

describe('selection scale history', () => {
  it('scale → undo restores exact coordinates → redo restores scaled geometry', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    addStroke(model, 's0', 100);
    const { history, controller } = wire(model);
    controller.setSelection(['s0']);
    const before = pointsOf(model, 's0');

    transact(history, controller, () => controller.scaleSelection(1.5));
    const scaled = pointsOf(model, 's0');
    expect(scaled).not.toEqual(before);
    // Uniform scale about the selection center moves the first point.
    expect(scaled[0]!.x).not.toBeCloseTo(before[0]!.x, 9);

    expect(undoRedoSync(history, controller, 'undo')).toBe(true);
    expect(pointsOf(model, 's0')).toEqual(before);

    expect(undoRedoSync(history, controller, 'redo')).toBe(true);
    expect(pointsOf(model, 's0')).toEqual(scaled);
  });

  it('logical/chunked stroke scales all canonical members with exact undo', () => {
    const model = emptySurface(boundedFrame(40000, 20000));
    addChunk(model, 'L-A', 'L', 0, 100);
    addChunk(model, 'L-B', 'L', 1, 2000);
    const { history, controller } = wire(model);
    controller.setSelection(['L-A']);
    const beforeA = pointsOf(model, 'L-A');
    const beforeB = pointsOf(model, 'L-B');

    const mutated = transact(history, controller, () =>
      controller.scaleSelection(2),
    );
    expect(mutated.sort()).toEqual(['L-A', 'L-B']);
    expect(pointsOf(model, 'L-A')).not.toEqual(beforeA);
    expect(pointsOf(model, 'L-B')).not.toEqual(beforeB);

    expect(undoRedoSync(history, controller, 'undo')).toBe(true);
    expect(pointsOf(model, 'L-A')).toEqual(beforeA);
    expect(pointsOf(model, 'L-B')).toEqual(beforeB);

    expect(undoRedoSync(history, controller, 'redo')).toBe(true);
    expect(pointsOf(model, 'L-A')).not.toEqual(beforeA);
    expect(pointsOf(model, 'L-B')).not.toEqual(beforeB);
  });
});

describe('selection rotate history', () => {
  it('rotate → undo → redo restores exact canonical samples', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    addStroke(model, 'r0', 300);
    const { history, controller } = wire(model);
    controller.setSelection(['r0']);
    const before = pointsOf(model, 'r0');

    transact(history, controller, () =>
      controller.rotateSelection(Math.PI / 2),
    );
    const rotated = pointsOf(model, 'r0');
    expect(rotated).toEqual(before);
    expect(model.objects.r0!.rotation).toBe(Math.PI / 2);

    expect(undoRedoSync(history, controller, 'undo')).toBe(true);
    expect(pointsOf(model, 'r0')).toEqual(before);
    expect(model.objects.r0!.rotation ?? 0).toBe(0);

    expect(undoRedoSync(history, controller, 'redo')).toBe(true);
    expect(pointsOf(model, 'r0')).toEqual(rotated);
    expect(model.objects.r0!.rotation).toBe(Math.PI / 2);
  });
});

describe('selection style history', () => {
  it('width/color/opacity undo/redo restores exact canonical values', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    addStroke(model, 'st', 500);
    const { history, controller } = wire(model);
    controller.setSelection(['st']);

    transact(history, controller, () =>
      controller.setSelectionStyle({
        color: '#ff0000',
        width: 9,
        opacity: 0.4,
      }),
    );
    const styled = model.objects['st'] as unknown as Record<string, unknown>;
    expect(styled.color).toBe('#ff0000');
    expect(styled.width).toBe(9);
    expect(styled.opacity).toBe(0.4);

    expect(undoRedoSync(history, controller, 'undo')).toBe(true);
    const undone = model.objects['st'] as unknown as Record<string, unknown>;
    expect(undone.color).toBe('#111111');
    expect(undone.width).toBe(3);
    expect(undone.opacity).toBeUndefined();

    expect(undoRedoSync(history, controller, 'redo')).toBe(true);
    const redone = model.objects['st'] as unknown as Record<string, unknown>;
    expect(redone.color).toBe('#ff0000');
    expect(redone.width).toBe(9);
    expect(redone.opacity).toBe(0.4);
  });
});

describe('align/distribute share the history seam', () => {
  it('align → undo restores exact origins (representative for distribute)', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    model.objects['a'] = rectangleObject('a', {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    model.objects['b'] = rectangleObject('b', {
      x: 400,
      y: 200,
      width: 100,
      height: 50,
    });
    model.order.push('a', 'b');
    const { history, controller } = wire(model);
    controller.setSelection(['a', 'b']);
    const beforeB = { ...(model.objects['b'] as unknown as object) } as {
      x: number;
      y: number;
    };

    const moved = transact(history, controller, () =>
      controller.alignSelection('left'),
    );
    expect(moved.length).toBeGreaterThan(0);
    const afterB = model.objects['b'] as unknown as { x: number; y: number };
    expect(afterB.x).toBe(0);

    expect(undoRedoSync(history, controller, 'undo')).toBe(true);
    const undoneB = model.objects['b'] as unknown as { x: number; y: number };
    expect(undoneB.x).toBe(beforeB.x);
    expect(undoneB.y).toBe(beforeB.y);
  });
});

describe('pure translation stays a zero-clone command', () => {
  it('moveSelectionBy records translate (no patch clones) and undo restores', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    addStroke(model, 'm0', 700);
    const { history, controller } = wire(model);
    controller.setSelection(['m0']);
    const before = pointsOf(model, 'm0');
    const capturedBefore = history.historyStats().changedRecordsCaptured;

    history.beginGesture();
    controller.moveSelectionBy({ x: 40, y: -15 });
    history.commitGesture();
    controller.notifyTranslated(
      history.lastChangeTranslate()!.ids,
      history.lastChangeTranslate()!.dx,
      history.lastChangeTranslate()!.dy,
    );

    expect(history.lastChangeTranslate()).not.toBeNull();
    // Zero sample clones for the command path.
    expect(history.historyStats().changedRecordsCaptured).toBe(capturedBefore);
    const moved = pointsOf(model, 'm0');
    expect(moved[0]!.x).toBeCloseTo(before[0]!.x + 40, 9);

    expect(undoRedoSync(history, controller, 'undo')).toBe(true);
    expect(pointsOf(model, 'm0')).toEqual(before);
  });
});
