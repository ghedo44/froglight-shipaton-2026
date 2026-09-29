/**
 * Composite translate+patch history: a selection move whose followers
 * reconcile (bound connectors) must preserve BOTH sides in ONE undo step —
 * primaries as a zero-clone translation command, followers as before/after
 * patches — with split notification routing.
 *
 * Seams under test: `SurfaceGestureHistory` (commit/undo/redo/lastChange)
 * wired to the real `InkToolController` selection-translation path
 * (`moveSelectionBy` → `onBeforeTranslate` + `onBeforeMutate` → reconcile).
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  inkStrokeObject,
  lineObject,
  rectangleObject,
  recordGeometryGeneration,
  recordPositionGeneration,
  InkToolController,
  type SurfaceModel,
} from '@froglight/foundation';
import { SurfaceGestureHistory } from './history.js';

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

/** Production split routing for undo/redo (mirrors surface.ts). */
function syncUndoRedo(
  history: SurfaceGestureHistory,
  controller: InkToolController,
  which: 'undo' | 'redo',
): boolean {
  const ok = which === 'undo' ? history.undo() : history.redo();
  if (!ok) return false;
  const change = history.lastChange();
  if (change.kind === 'translate') {
    controller.notifyTranslated(change.ids, change.dx, change.dy);
  } else if (change.kind === 'translate-patch') {
    controller.notifyTranslated(
      change.translate.ids,
      change.translate.dx,
      change.translate.dy,
    );
    controller.notifyExternalMutation(change.patchIds);
  } else if (change.kind === 'patch') {
    controller.notifyExternalMutation(change.ids);
  }
  return true;
}

function rectXY(model: SurfaceModel, id: string): { x: number; y: number } {
  const record = model.objects[id] as unknown as { x: number; y: number };
  return { x: record.x, y: record.y };
}

function lineEnds(
  model: SurfaceModel,
  id: string,
): { x: number; y: number; x2: number; y2: number } {
  const record = model.objects[id] as unknown as {
    x: number;
    y: number;
    x2: number;
    y2: number;
  };
  return { x: record.x, y: record.y, x2: record.x2, y2: record.y2 };
}

describe('composite translate+patch: rectangle + bound connector', () => {
  it('one gesture moves primary + follower; undo/redo restores exactly; one undo step', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    model.objects['A'] = rectangleObject('A', {
      x: 10,
      y: 10,
      width: 60,
      height: 30,
    });
    // Connector C bound at its source end to A's center (40,25).
    model.objects['C'] = lineObject('C', {
      x: 40,
      y: 25,
      x2: 200,
      y2: 200,
      source: { objectId: 'A', anchor: 'center' },
    });
    model.order.push('A', 'C');
    const { history, controller } = wire(model);
    controller.setSelection(['A']);

    const beforeA = rectXY(model, 'A');
    const beforeC = lineEnds(model, 'C');
    const entriesBefore = history.historyStats().entries;

    history.beginGesture();
    controller.moveSelectionBy({ x: 50, y: 20 });
    history.commitGesture();

    // Primary translated, follower followed.
    expect(rectXY(model, 'A')).toEqual({ x: 60, y: 30 });
    const movedC = lineEnds(model, 'C');
    expect(movedC.x).toBe(90);
    expect(movedC.y).toBe(45);
    expect(movedC.x2).toBe(beforeC.x2);
    expect(movedC.y2).toBe(beforeC.y2);

    // One gesture == one undo entry, composite kind.
    expect(history.historyStats().entries - entriesBefore).toBe(1);
    expect(history.canUndo()).toBe(true);
    const change = history.lastChange();
    expect(change.kind).toBe('translate-patch');
    if (change.kind === 'translate-patch') {
      expect([...change.translate.ids]).toEqual(['A']);
      expect(change.translate.dx).toBe(50);
      expect(change.translate.dy).toBe(20);
      expect([...change.patchIds]).toEqual(['C']);
    }
    // Compat wrappers: translate side visible, patch ids only (never union,
    // so primaries never take the recompile path — see code comment).
    expect(history.lastChangeTranslate()).toMatchObject({
      dx: 50,
      dy: 20,
    });
    expect([...history.lastChangeIds()]).toEqual(['C']);
    expect(history.historyStats().fullModelSerializations).toBe(0);

    // Undo restores BOTH exactly.
    expect(syncUndoRedo(history, controller, 'undo')).toBe(true);
    expect(rectXY(model, 'A')).toEqual(beforeA);
    expect(lineEnds(model, 'C')).toEqual(beforeC);

    // Redo reproduces the committed state.
    expect(syncUndoRedo(history, controller, 'redo')).toBe(true);
    expect(rectXY(model, 'A')).toEqual({ x: 60, y: 30 });
    expect(lineEnds(model, 'C')).toEqual(movedC);

    // Still one entry (undo/redo move across the stack, not new entries).
    expect(history.historyStats().entries).toBe(entriesBefore + 1);
    expect(history.historyStats().fullModelSerializations).toBe(0);
  });
});

describe('composite zero-clone: ink stroke + connector', () => {
  it('follower clones only; primary position advances, geometry unchanged', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    const points = Array.from({ length: 2000 }, (_, i) => ({
      x: 100 + i * 2,
      y: 200 + Math.sin(i / 5) * 6,
      pressure: 0.5,
      dt: i * 8,
    }));
    model.objects['S'] = inkStrokeObject('S', {
      points,
      width: 3,
      color: '#111111',
    });
    // Bound connector follows the stroke's envelope center.
    model.objects['C'] = lineObject('C', {
      x: 0,
      y: 0,
      x2: 500,
      y2: 500,
      source: { objectId: 'S', anchor: 'center' },
    });
    model.order.push('S', 'C');
    const { history, controller } = wire(model);
    controller.setSelection(['S']);

    const geoBefore = recordGeometryGeneration(model, 'S');
    const posBefore = recordPositionGeneration(model, 'S');
    const capturedBefore = history.historyStats().changedRecordsCaptured;
    const beforeC = lineEnds(model, 'C');

    history.beginGesture();
    controller.moveSelectionBy({ x: 40, y: -15 });
    history.commitGesture();

    // Composite, not pure translate / pure patch.
    const change = history.lastChange();
    expect(change.kind).toBe('translate-patch');

    // Zero-clone proof: exactly ONE follower before + ONE follower after
    // (2 captures), ZERO primary clones despite 2000 samples.
    const capturedAfterCommit =
      history.historyStats().changedRecordsCaptured - capturedBefore;
    expect(capturedAfterCommit).toBe(2);
    expect(history.historyStats().fullModelSerializations).toBe(0);

    // Position epoch advanced for the primary; geometry generation did not
    // (zero-copy Ink samples — no B-spline recompile).
    expect(recordPositionGeneration(model, 'S')).toBeGreaterThan(posBefore);
    expect(recordGeometryGeneration(model, 'S')).toBe(geoBefore);
    // Follower moved.
    expect(lineEnds(model, 'C')).not.toEqual(beforeC);

    // Undo is translation-based for the primary: position advances again,
    // geometry still unchanged; follower restores exactly.
    const posAfterMove = recordPositionGeneration(model, 'S');
    expect(syncUndoRedo(history, controller, 'undo')).toBe(true);
    expect(recordPositionGeneration(model, 'S')).toBeGreaterThan(posAfterMove);
    expect(recordGeometryGeneration(model, 'S')).toBe(geoBefore);
    expect(lineEnds(model, 'C')).toEqual(beforeC);

    // Redo mirrors: position advances a third time, geometry unchanged.
    const posAfterUndo = recordPositionGeneration(model, 'S');
    expect(syncUndoRedo(history, controller, 'redo')).toBe(true);
    expect(recordPositionGeneration(model, 'S')).toBeGreaterThan(posAfterUndo);
    expect(recordGeometryGeneration(model, 'S')).toBe(geoBefore);
    expect(history.historyStats().fullModelSerializations).toBe(0);
  });
});

describe('composite notification split', () => {
  it('primaries take translated path only; followers take mutation path', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    model.objects['A'] = rectangleObject('A', {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    model.objects['C'] = lineObject('C', {
      x: 50,
      y: 25,
      x2: 400,
      y2: 300,
      source: { objectId: 'A', anchor: 'center' },
    });
    model.order.push('A', 'C');
    const { history, controller } = wire(model);
    controller.setSelection(['A']);
    controller.ensureIndexes();

    const geoABefore = recordGeometryGeneration(model, 'A');

    history.beginGesture();
    controller.moveSelectionBy({ x: 30, y: 10 });
    history.commitGesture();
    expect(history.lastChange().kind).toBe('translate-patch');

    // Correct split: primaries via notifyTranslated (geometry gen
    // unchanged), followers via notifyExternalMutation (geometry MAY
    // advance — ordinary publication).
    const change = history.lastChange();
    if (change.kind !== 'translate-patch') throw new Error('expected composite');
    controller.notifyTranslated(
      change.translate.ids,
      change.translate.dx,
      change.translate.dy,
    );
    expect(recordGeometryGeneration(model, 'A')).toBe(geoABefore);
    controller.notifyExternalMutation(change.patchIds);
    expect([...change.patchIds]).toEqual(['C']);

    // Regression catch: routing the WHOLE gesture as one patch (the old
    // bug's shape — primaries through notifyExternalMutation) recompiles
    // primary geometry. Split routing must never do this.
    controller.notifyExternalMutation(['A']);
    expect(recordGeometryGeneration(model, 'A')).toBeGreaterThan(geoABefore);
  });

  it('pure translate still publishes nothing for geometry commits', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    model.objects['R'] = rectangleObject('R', {
      x: 5,
      y: 5,
      width: 40,
      height: 20,
    });
    model.order.push('R');
    const { history, controller } = wire(model);
    controller.setSelection(['R']);

    history.beginGesture();
    controller.moveSelectionBy({ x: 12, y: 7 });
    history.commitGesture();

    // No followers → pure translate fast path unchanged.
    expect(history.lastChange().kind).toBe('translate');
    expect(history.historyStats().changedRecordsCaptured).toBe(0);
    expect(history.historyStats().fullModelSerializations).toBe(0);
  });
});
