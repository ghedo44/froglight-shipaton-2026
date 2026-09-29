/**
 * single-owner translation during undo/redo.
 *
 * Translation ownership matrix — one owner per layer,
 * never two:
 *
 * | Operation                    | Canonical owner                  | Derived/index owner                    | Prepared-scene owner            |
 * | ---------------------------- | -------------------------------- | -------------------------------------- | ------------------------------- |
 * | Original drag/commit         | Controller (#applyTranslation /  | Controller (#indexTranslated, DURING   | onBeforeTranslate hook (during  |
 * |                              |  #commitMoveDrag)                |  run — already complete at commit)     |  run) + geometry-commit publish |
 * | History undo                 | History (applyTranslateToModel)  | Controller notification                | surface notifyHistoryChange     |
 * | History redo                 | History (applyTranslateToModel)  |  (notifyTranslated, exactly once)      | surface notifyHistoryChange     |
 * | Composite follower patch     | History (#apply restore)         | notifyExternalMutation                 | publishContentMutation          |
 *
 * History MUST NOT call accumulateDerivedTranslation during undo/redo: the
 * surface notify path already routes the same delta through
 * controller.notifyTranslated (which accumulates exactly once). Two callers
 * displaced retained geometry (undo landed at -delta instead of 0) and
 * advanced position epochs twice per operation.
 *
 * selectionTransaction audit: the controller verbs
 * reachable through selectionTransaction today (align/distribute via
 * #translateBy, scale/rotate/delete/style/reorder/group/...) record patch
 * entries only — #translateBy never calls onBeforeTranslate and
 * align/distribute finish with #indexMutated, so the post-commit route takes
 * the external-mutation branch. moveSelectionBy/commitEphemeralMove (which
 * DO #indexTranslated during run) never execute inside selectionTransaction
 * today; the pointer-drag commit path notifies the prepared scene via
 * onBeforeTranslate during run and onGestureEnd publishes geometry commits
 * only (never a second translate notification). The last test below pins
 * both halves of that audit.
 *
 * Seams under test: SurfaceGestureHistory (commit/undo/redo/lastChange)
 * wired to the real InkToolController selection-translation path, with an
 * undo/redo sync that mirrors surface.ts notifyHistoryChange exactly
 * (translate -> notifyTranslated; translate-patch -> notifyTranslated for
 * primaries + notifyExternalMutation for followers). The committed-scene
 * prepared shift (committed.notifyTranslated) needs a DOM scene and stays
 * covered by committed-renderer.spec.ts; the derived/index/epoch ownership
 * under repair lives in the controller notification tested here.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  lineObject,
  rectangleObject,
  resolveConnectorAnchor,
  createDefaultSurfaceObjectTypeRegistry,
  InkToolController,
  compiledStrokeForRecord,
  compiledStrokeComputeStats,
  packCompiledInk,
  retainPackedForRecord,
  packedCompiledForRecord,
  jointPackedForChunk,
  jointTranslationForChunk,
  derivedTranslationOfRecord,
  recordGeometryGeneration,
  logicalGeometryGeneration,
  recordPositionGeneration,
  logicalPositionGeneration,
  resetGeometryGenerationsForTests,
  resolvePreparedBackgroundPackUnit,
  scheduleBackgroundPackForPreparedUnit,
  flushBackgroundPackQueueForTests,
  resetBackgroundPackForTests,
  setBackgroundPackWorkerFactory,
  compileInkStroke,
  unpackInkSamples,
  type BackgroundPackWorker,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
  type SurfaceModel,
} from '@froglight/foundation';
import { SurfaceGestureHistory } from './history.js';

function strokePoints(
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

/**
 * Production pointer-drag commit shape: the controller synchronizes derived
 * state DURING run (#indexTranslated), so commit performs no second
 * translation notification — onGestureEnd publishes geometry commits only.
 */
function moveCommitted(
  history: SurfaceGestureHistory,
  controller: InkToolController,
  selection: readonly string[],
  dx: number,
  dy: number,
): readonly string[] {
  history.beginGesture();
  controller.setSelection([...selection]);
  const moved = controller.moveSelectionBy({ x: dx, y: dy });
  history.commitGesture();
  return moved;
}

/** Exact mirror of surface.ts notifyHistoryChange (controller half). */
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

function pointsJson(model: SurfaceModel, id: string): string {
  const record = model.objects[id] as unknown as { points: unknown };
  return JSON.stringify(record.points);
}

function firstPoint(model: SurfaceModel, id: string): { x: number; y: number } {
  const record = model.objects[id] as unknown as {
    points: { x: number; y: number }[];
  };
  return { x: record.points[0]!.x, y: record.points[0]!.y };
}

/** Background-pack test worker: real canonical compile/pack. */
function recordingWorker(): {
  worker: BackgroundPackWorker;
  requests: PackedInkCompileRequest[];
} {
  const requests: PackedInkCompileRequest[] = [];
  const worker: BackgroundPackWorker = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage(message) {
      requests.push(message);
      const compiled = compileInkStroke(
        unpackInkSamples(message.samples),
        message.brush,
        message.options ?? {},
      );
      const { packed, bytes } = packCompiledInk(compiled);
      queueMicrotask(() =>
        worker.onmessage?.({
          data: {
            type: 'compiled-ink',
            requestId: message.requestId,
            objectId: message.objectId,
            generation: message.generation,
            compiled: structuredClone(packed),
            workerUnpackMs: 0,
            compileMs: 1,
            packMs: 0,
            outputBytes: bytes,
          } as PackedInkCompileResponse,
        }),
      );
    },
  };
  return { worker, requests };
}

function addChunk(
  model: SurfaceModel,
  id: string,
  logicalId: string,
  chunkIndex: number,
  xBase: number,
): void {
  model.objects[id] = inkStrokeObject(id, {
    points: strokePoints(300, xBase),
    width: 3,
    logicalId,
    chunkIndex,
  });
  model.order.push(id);
}

/** Retain one shared joint through the real background-pack prepared lane. */
async function retainJointViaPrepared(
  model: SurfaceModel,
  headId: string,
): Promise<unknown> {
  const unit = resolvePreparedBackgroundPackUnit(model, headId);
  expect(unit?.kind).toBe('logical');
  if (unit?.kind !== 'logical') throw new Error('expected logical unit');
  expect(scheduleBackgroundPackForPreparedUnit(unit, model)).toBe(true);
  await flushBackgroundPackQueueForTests(200);
  const joint = jointPackedForChunk(model.objects[headId]!);
  expect(joint).toBeDefined();
  for (const id of model.order) {
    expect(jointPackedForChunk(model.objects[id]!)).toBe(joint);
  }
  return joint;
}

beforeEach(() => {
  resetBackgroundPackForTests();
  resetGeometryGenerationsForTests();
});

afterEach(() => {
  setBackgroundPackWorkerFactory(null);
});

describe('pure translate: retained packed geometry moves exactly once', () => {
  it('move -> undo -> redo keeps canonical, derived, epochs, and packed identity exact', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    model.objects['S'] = inkStrokeObject('S', {
      points: strokePoints(60, 100),
      width: 3,
      color: '#111111',
    });
    model.order.push('S');
    const { history, controller } = wire(model);
    // Primary identity is stable across rigid translation (history and the
    // controller mutate translate-path records in place, never replace).
    const record = model.objects['S']!;

    // Warm/retain packed geometry (LOCAL coordinates, zero translation).
    const compiled = compiledStrokeForRecord(record);
    expect(compiled).not.toBeNull();
    const packed = packCompiledInk(compiled!).packed;
    retainPackedForRecord(record, packed);
    expect(packedCompiledForRecord(record)).toBe(packed);
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: 0, ty: 0 });

    const canonical0 = pointsJson(model, 'S');
    const first0 = firstPoint(model, 'S');
    const geom0 = recordGeometryGeneration(model, 'S');
    const computes0 = compiledStrokeComputeStats.computes;
    const captured0 = history.historyStats().changedRecordsCaptured;
    expect(recordPositionGeneration(model, 'S')).toBe(0);

    // Move +50,+20 through the production commit shape.
    const moved = moveCommitted(history, controller, ['S'], 50, 20);
    expect(moved).toContain('S');
    const change = history.lastChange();
    expect(change.kind).toBe('translate');
    if (change.kind !== 'translate') throw new Error('expected translate');
    expect(change.dx).toBe(50);
    expect(change.dy).toBe(20);
    expect(firstPoint(model, 'S')).toEqual({
      x: first0.x + 50,
      y: first0.y + 20,
    });
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: 50, ty: 20 });
    // Exactness: one canonical translation -> one epoch.
    expect(recordPositionGeneration(model, 'S')).toBe(1);
    // Zero-copy / zero-recompile.
    expect(recordGeometryGeneration(model, 'S')).toBe(geom0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);
    expect(packedCompiledForRecord(record)).toBe(packed);
    expect(history.historyStats().changedRecordsCaptured).toBe(captured0);

    // Undo restores canonical AND derived exactly (double application would
    // land derived at -50,-20 and push the epoch to 3).
    expect(syncUndoRedo(history, controller, 'undo')).toBe(true);
    expect(pointsJson(model, 'S')).toBe(canonical0);
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: 0, ty: 0 });
    expect(recordPositionGeneration(model, 'S')).toBe(2);
    expect(recordGeometryGeneration(model, 'S')).toBe(geom0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);
    expect(packedCompiledForRecord(record)).toBe(packed);

    // Redo reproduces the moved state exactly once more.
    expect(syncUndoRedo(history, controller, 'redo')).toBe(true);
    expect(firstPoint(model, 'S')).toEqual({
      x: first0.x + 50,
      y: first0.y + 20,
    });
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: 50, ty: 20 });
    expect(recordPositionGeneration(model, 'S')).toBe(3);
    expect(recordGeometryGeneration(model, 'S')).toBe(geom0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);
    expect(packedCompiledForRecord(record)).toBe(packed);
  });
});

describe('logical retained joint: move -> undo -> redo translates once', () => {
  it('L=A+B+C shares one joint; joint identity, translation, and epochs stay exact', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'L-A', 'L', 0, 0);
    addChunk(model, 'L-B', 'L', 1, 2000);
    addChunk(model, 'L-C', 'L', 2, 4000);
    const { history, controller } = wire(model);

    const joint0 = await retainJointViaPrepared(model, 'L-A');
    const chunk = (id: string) => model.objects[id]!;
    // Joint-only retention: no per-record geometry yet.
    for (const id of model.order) {
      expect(derivedTranslationOfRecord(chunk(id))).toEqual({ tx: 0, ty: 0 });
      expect(jointTranslationForChunk(chunk(id))).toEqual({ tx: 0, ty: 0 });
    }

    const canonicalOf = (id: string): string => pointsJson(model, id);
    const beforeA = canonicalOf('L-A');
    const beforeB = canonicalOf('L-B');
    const beforeC = canonicalOf('L-C');
    const geomA0 = recordGeometryGeneration(model, 'L-A');
    const geomL0 = logicalGeometryGeneration(model, 'L');
    const computes0 = compiledStrokeComputeStats.computes;

    // Selecting one chunk moves the whole logical (member expansion).
    const moved = moveCommitted(history, controller, ['L-A'], 40, -15);
    expect(moved).toHaveLength(3);
    const change = history.lastChange();
    expect(change.kind).toBe('translate');
    if (change.kind !== 'translate') throw new Error('expected translate');
    expect(change.dx).toBe(40);
    expect(change.dy).toBe(-15);

    // Joint translated exactly once; identity shared and stable.
    for (const id of ['L-A', 'L-B', 'L-C']) {
      expect(jointPackedForChunk(chunk(id))).toBe(joint0);
      expect(jointTranslationForChunk(chunk(id))).toEqual({
        tx: 40,
        ty: -15,
      });
      expect(derivedTranslationOfRecord(chunk(id))).toEqual({ tx: 0, ty: 0 });
      expect(recordPositionGeneration(model, id)).toBe(1);
    }
    expect(logicalPositionGeneration(model, 'L')).toBe(1);
    expect(recordGeometryGeneration(model, 'L-A')).toBe(geomA0);
    expect(logicalGeometryGeneration(model, 'L')).toBe(geomL0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);

    // Undo: joint identity unchanged, translation back to 0, canonical exact.
    expect(syncUndoRedo(history, controller, 'undo')).toBe(true);
    for (const id of ['L-A', 'L-B', 'L-C']) {
      expect(jointPackedForChunk(chunk(id))).toBe(joint0);
      expect(jointTranslationForChunk(chunk(id))).toEqual({ tx: 0, ty: 0 });
      expect(recordPositionGeneration(model, id)).toBe(2);
    }
    expect(logicalPositionGeneration(model, 'L')).toBe(2);
    expect(canonicalOf('L-A')).toBe(beforeA);
    expect(canonicalOf('L-B')).toBe(beforeB);
    expect(canonicalOf('L-C')).toBe(beforeC);
    expect(recordGeometryGeneration(model, 'L-A')).toBe(geomA0);
    expect(logicalGeometryGeneration(model, 'L')).toBe(geomL0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);

    // Redo: same joint identity, original delta restored.
    expect(syncUndoRedo(history, controller, 'redo')).toBe(true);
    for (const id of ['L-A', 'L-B', 'L-C']) {
      expect(jointPackedForChunk(chunk(id))).toBe(joint0);
      expect(jointTranslationForChunk(chunk(id))).toEqual({
        tx: 40,
        ty: -15,
      });
      expect(recordPositionGeneration(model, id)).toBe(3);
    }
    expect(logicalPositionGeneration(model, 'L')).toBe(3);
    expect(recordGeometryGeneration(model, 'L-A')).toBe(geomA0);
    expect(logicalGeometryGeneration(model, 'L')).toBe(geomL0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);
  });
});

describe('composite Ink + connector with retained geometry', () => {
  it('primary stays zero-clone/exact while the follower patch restores exactly', () => {
    const model = emptySurface(boundedFrame(20000, 20000));
    model.objects['S'] = inkStrokeObject('S', {
      points: strokePoints(60, 100),
      width: 3,
      color: '#111111',
    });
    // Bind the follower to the exact production anchor (envelope fallback for
    // strokes) so the initial endpoint is canonical-exact by construction.
    const anchorRegistry = createDefaultSurfaceObjectTypeRegistry();
    const anchor0 = resolveConnectorAnchor(
      model.objects['S']!,
      'center',
      anchorRegistry,
    );
    expect(anchor0).not.toBeNull();
    model.objects['C'] = lineObject('C', {
      x: anchor0!.x,
      y: anchor0!.y,
      x2: 900,
      y2: 800,
      source: { objectId: 'S', anchor: 'center' },
    });
    model.order.push('S', 'C');
    const { history, controller } = wire(model);
    // Primary identity is stable across rigid translation (only follower
    // patch ids are ever replaced by history restore).
    const stroke = model.objects['S']!;
    const ends = (): { x: number; y: number; x2: number; y2: number } => {
      const record = model.objects['C'] as unknown as {
        x: number;
        y: number;
        x2: number;
        y2: number;
      };
      return { x: record.x, y: record.y, x2: record.x2, y2: record.y2 };
    };

    // Warm/retain the primary only; the follower stays ordinary geometry.
    const compiled = compiledStrokeForRecord(stroke);
    expect(compiled).not.toBeNull();
    const packedS = packCompiledInk(compiled!).packed;
    retainPackedForRecord(stroke, packedS);

    const canonicalS0 = pointsJson(model, 'S');
    const firstS0 = firstPoint(model, 'S');
    const beforeC = ends();
    const geomS0 = recordGeometryGeneration(model, 'S');
    const computes0 = compiledStrokeComputeStats.computes;
    const captured0 = history.historyStats().changedRecordsCaptured;
    expect(recordPositionGeneration(model, 'S')).toBe(0);

    const moved = moveCommitted(history, controller, ['S'], 50, 20);
    expect(moved).toContain('S');
    expect(moved).toContain('C');
    const change = history.lastChange();
    expect(change.kind).toBe('translate-patch');
    if (change.kind !== 'translate-patch')
      throw new Error('expected translate-patch');
    expect([...change.translate.ids]).toEqual(['S']);
    expect(change.translate.dx).toBe(50);
    expect(change.translate.dy).toBe(20);
    expect([...change.patchIds]).toEqual(['C']);

    // Primary: canonical + derived exact, zero history clone for the primary
    // (before/after clones cover the single follower only).
    expect(firstPoint(model, 'S')).toEqual({
      x: firstS0.x + 50,
      y: firstS0.y + 20,
    });
    expect(derivedTranslationOfRecord(stroke)).toEqual({ tx: 50, ty: 20 });
    expect(recordPositionGeneration(model, 'S')).toBe(1);
    expect(recordGeometryGeneration(model, 'S')).toBe(geomS0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);
    expect(packedCompiledForRecord(stroke)).toBe(packedS);
    expect(history.historyStats().changedRecordsCaptured - captured0).toBe(2);

    // Follower: rigid follow (+50,+20 on the bound end, free end fixed).
    const movedC = ends();
    expect(movedC.x).toBe(beforeC.x + 50);
    expect(movedC.y).toBe(beforeC.y + 20);
    expect(movedC.x2).toBe(beforeC.x2);
    expect(movedC.y2).toBe(beforeC.y2);

    // Undo: primary canonical + derived exact, follower endpoints exact.
    const captured1 = history.historyStats().changedRecordsCaptured;
    expect(syncUndoRedo(history, controller, 'undo')).toBe(true);
    expect(pointsJson(model, 'S')).toBe(canonicalS0);
    expect(derivedTranslationOfRecord(stroke)).toEqual({ tx: 0, ty: 0 });
    expect(recordPositionGeneration(model, 'S')).toBe(2);
    expect(recordGeometryGeneration(model, 'S')).toBe(geomS0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);
    expect(packedCompiledForRecord(stroke)).toBe(packedS);
    expect(ends()).toEqual(beforeC);
    // Undo clones only the current follower image for the redo side.
    expect(history.historyStats().changedRecordsCaptured - captured1).toBe(1);

    // Redo: primary exact again, follower re-follows exactly.
    const captured2 = history.historyStats().changedRecordsCaptured;
    expect(syncUndoRedo(history, controller, 'redo')).toBe(true);
    expect(firstPoint(model, 'S')).toEqual({
      x: firstS0.x + 50,
      y: firstS0.y + 20,
    });
    expect(derivedTranslationOfRecord(stroke)).toEqual({ tx: 50, ty: 20 });
    expect(recordPositionGeneration(model, 'S')).toBe(3);
    expect(recordGeometryGeneration(model, 'S')).toBe(geomS0);
    expect(compiledStrokeComputeStats.computes).toBe(computes0);
    expect(packedCompiledForRecord(stroke)).toBe(packedS);
    expect(ends()).toEqual(movedC);
    expect(history.historyStats().changedRecordsCaptured - captured2).toBe(1);
  });
});

describe('position epoch exactness', () => {
  it('move +1, undo +1, redo +1 — never a double increment', () => {
    const model = emptySurface(boundedFrame(800, 600));
    model.objects['r1'] = rectangleObject('r1', {
      x: 10,
      y: 10,
      width: 60,
      height: 30,
    });
    model.order.push('r1');
    const { history, controller } = wire(model);

    expect(recordPositionGeneration(model, 'r1')).toBe(0);
    moveCommitted(history, controller, ['r1'], 25, -10);
    expect(recordPositionGeneration(model, 'r1')).toBe(1);
    expect(syncUndoRedo(history, controller, 'undo')).toBe(true);
    expect(recordPositionGeneration(model, 'r1')).toBe(2);
    expect(syncUndoRedo(history, controller, 'redo')).toBe(true);
    expect(recordPositionGeneration(model, 'r1')).toBe(3);
  });
});

describe('selectionTransaction behavior', () => {
  function trioModel(): SurfaceModel {
    const model = emptySurface(boundedFrame(2000, 2000));
    for (const [id, x] of [
      ['a', 0],
      ['b', 100],
      ['c', 300],
    ] as const) {
      model.objects[id] = rectangleObject(id, {
        x,
        y: 50,
        width: 60,
        height: 30,
      });
      model.order.push(id);
    }
    return model;
  }

  it('align records a patch entry only — never the translated path', () => {
    const model = trioModel();
    const { history, controller } = wire(model);
    controller.setSelection(['a', 'b', 'c']);

    history.beginGesture();
    const aligned = controller.alignSelection('left');
    history.commitGesture();
    expect(aligned.length).toBeGreaterThan(0);
    expect(history.lastChange().kind).toBe('patch');
    controller.notifyExternalMutation(history.lastChangeIds());
    for (const id of ['a', 'b', 'c']) {
      expect(derivedTranslationOfRecord(model.objects[id]!)).toEqual({
        tx: 0,
        ty: 0,
      });
    }
  });

  it('distribute records a patch entry only — never the translated path', () => {
    const model = trioModel();
    const { history, controller } = wire(model);
    controller.setSelection(['a', 'b', 'c']);

    history.beginGesture();
    const distributed = controller.distributeSelection('x');
    history.commitGesture();
    expect(distributed.length).toBeGreaterThan(0);
    expect(history.lastChange().kind).toBe('patch');
    controller.notifyExternalMutation(history.lastChangeIds());
    for (const id of ['a', 'b', 'c']) {
      expect(derivedTranslationOfRecord(model.objects[id]!)).toEqual({
        tx: 0,
        ty: 0,
      });
    }
  });

  it('the run path already synchronizes derived state once — no post-commit translate owed', () => {
    const model = emptySurface(boundedFrame(800, 600));
    model.objects['r1'] = rectangleObject('r1', {
      x: 10,
      y: 10,
      width: 60,
      height: 30,
    });
    model.order.push('r1');
    const { history, controller } = wire(model);

    // Commit with NO post-commit translate notification (pointer-path shape):
    // canonical moved, exactly one position epoch, and — for a record with
    // no retained geometry — no phantom derived entry (accumulation only
    // tracks records that own rich/packed/joint geometry).
    moveCommitted(history, controller, ['r1'], 25, -10);
    expect(history.lastChange()).toMatchObject({ kind: 'translate' });
    expect(derivedTranslationOfRecord(model.objects['r1']!)).toEqual({
      tx: 0,
      ty: 0,
    });
    expect(recordPositionGeneration(model, 'r1')).toBe(1);
  });
});
