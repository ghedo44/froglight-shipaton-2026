/**
 * Replacement-chain rendezvous regressions (Option A).
 *
 * `backgroundPackRendezvousKeysForIds()` must emit replaced-away,
 * remembered/pre-mutation, current-logical, and current-single sources
 * independently (with `seen` dedup), preserving the Option A tombstone
 * lifetime (no O(document) cleanup). The previous `if/else` let a stale
 * `replacedOldLogicalByRecordId` entry shadow the newer remembered
 * ownership for replacement chains.
 *
 * Cases:
 * - A: L=A+B+C, B L→M (M has survivor D), delete B → l:M present.
 * - B: L→non-stroke→M→delete same id → latest M present.
 * - C: L→M→N then mutate/delete → current N representable.
 * Generation semantics (§10) are preserved: geometry bumps for affected
 * logicals, old+new stale jobs drop, survivor fresh pack installs.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
  backgroundPackRendezvousKeysForIds,
  backgroundPackStats,
  boundedFrame,
  captureGeometryOwnershipForIds,
  emptySurface,
  flushBackgroundPackQueueForTests,
  inkStrokeObject,
  invalidateCompiledForIds,
  jointPackedForChunk,
  logicalGeometryGeneration,
  recordGeometryGeneration,
  rectangleObject,
  resetBackgroundPackForTests,
  resetGeometryGenerationsForTests,
  resolvePreparedBackgroundPackUnit,
  resolvePreparedBackgroundPackUnitForLogical,
  scheduleBackgroundPackForPreparedUnit,
  setBackgroundPackWorkerFactory,
  type BackgroundPackWorker,
  type SurfaceModel,
} from './index.js';
import { compileInkStroke } from './ink/compiler.js';
import {
  packCompiledInk,
  unpackInkSamples,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from './ink/packed-protocol.js';

function samples(
  count: number,
  xBase: number,
): { x: number; y: number; pressure: number; dt: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    x: xBase + i * 2,
    y: 200 + Math.sin((xBase + i) / 6) * 9,
    pressure: 0.5,
    dt: (xBase + i) * 6,
  }));
}

function addChunk(
  model: SurfaceModel,
  id: string,
  logicalId: string,
  chunkIndex: number,
  xBase: number,
): void {
  model.objects[id] = inkStrokeObject(id, {
    points: samples(300, xBase),
    width: 3,
    logicalId,
    chunkIndex,
  });
  model.order.push(id);
}

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
  return joint;
}

function replaceWithLogical(
  model: SurfaceModel,
  id: string,
  logicalId: string,
  chunkIndex: number,
): void {
  const old = model.objects[id];
  const oldPoints = (
    old as unknown as {
      points: { x: number; y: number; pressure: number; dt: number }[];
    }
  ).points;
  captureGeometryOwnershipForIds(model, [id]);
  model.objects[id] = inkStrokeObject(id, {
    points: oldPoints.map((p) => ({ ...p, x: p.x + 1000 })),
    width: 3,
    logicalId,
    chunkIndex,
  });
  invalidateCompiledForIds(model, [id]);
}

function deleteRecord(model: SurfaceModel, id: string): void {
  captureGeometryOwnershipForIds(model, [id]);
  delete model.objects[id];
  model.order.splice(model.order.indexOf(id), 1);
  invalidateCompiledForIds(model, [id]);
}

beforeEach(() => {
  resetBackgroundPackForTests();
  resetGeometryGenerationsForTests();
});

describe('Case A: L→M replacement chain then delete', () => {
  it('delete B after L→M emits l:M (l:L may also appear) and M survivors re-pack', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    try {
      const model = emptySurface(boundedFrame(60000, 6000));
      addChunk(model, 'L-A', 'L', 0, 0);
      addChunk(model, 'L-B', 'L', 1, 2000);
      addChunk(model, 'L-C', 'L', 2, 4000);
      // M already has a surviving chunk D (distinct record id).
      addChunk(model, 'M-D', 'M', 1, 8000);
      await retainJointViaPrepared(model, 'L-A');
      await retainJointViaPrepared(model, 'M-D');
      const oldMJoint = jointPackedForChunk(model.objects['M-D']!);
      expect(oldMJoint).toBeDefined();

      // B moves L→M (becomes chunk 0 of M alongside survivor D).
      replaceWithLogical(model, 'L-B', 'M', 0);
      const afterMoveKeys = backgroundPackRendezvousKeysForIds(model, ['L-B']);
      expect(afterMoveKeys).toContain('l:L');
      expect(afterMoveKeys).toContain('l:M');

      // M/B is deleted: rendezvous must include l:M (l:L may also appear
      // under Option A tombstone lifetime, but M must never be omitted).
      deleteRecord(model, 'L-B');
      const keys = backgroundPackRendezvousKeysForIds(model, ['L-B']);
      expect(keys).toContain('l:M');

      // Generation semantics: affected logicals bumped.
      expect(logicalGeometryGeneration(model, 'L')).toBeGreaterThan(0);
      expect(logicalGeometryGeneration(model, 'M')).toBeGreaterThan(0);
      expect(recordGeometryGeneration(model, 'L-B')).toBeGreaterThan(0);

      // M survivors resolve (D alone) and receive a fresh joint.
      expect(jointPackedForChunk(model.objects['M-D']!)).toBeUndefined();
      const survivorM = resolvePreparedBackgroundPackUnitForLogical(model, 'M');
      expect(survivorM?.kind).toBe('logical');
      if (survivorM?.kind !== 'logical') throw new Error('expected M survivor');
      expect(survivorM.records.map((r) => r.id)).toEqual(['M-D']);
      expect(scheduleBackgroundPackForPreparedUnit(survivorM, model)).toBe(
        true,
      );

      // L survivors resolve (A+C) and receive a fresh joint.
      const survivorL = resolvePreparedBackgroundPackUnitForLogical(model, 'L');
      expect(survivorL?.kind).toBe('logical');
      if (survivorL?.kind !== 'logical') throw new Error('expected L survivor');
      expect(survivorL.records.map((r) => r.id).sort()).toEqual(['L-A', 'L-C']);
      expect(scheduleBackgroundPackForPreparedUnit(survivorL, model)).toBe(
        true,
      );

      await flushBackgroundPackQueueForTests(300);
      const freshM = jointPackedForChunk(model.objects['M-D']!);
      expect(freshM).toBeDefined();
      expect(freshM).not.toBe(oldMJoint);
      const freshL = jointPackedForChunk(model.objects['L-A']!);
      expect(freshL).toBeDefined();
      expect(jointPackedForChunk(model.objects['L-C']!)).toBe(freshL);
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
      expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
        BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
      );
    } finally {
      setBackgroundPackWorkerFactory(null);
    }
  });
});

describe('Case B: L→non-stroke→M→delete same id', () => {
  it('latest logical M survives historical tombstones on delete', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    try {
      const model = emptySurface(boundedFrame(60000, 6000));
      addChunk(model, 'LB-A', 'LB', 0, 0);
      addChunk(model, 'LB-B', 'LB', 1, 2000);
      addChunk(model, 'LB-C', 'LB', 2, 4000);
      await retainJointViaPrepared(model, 'LB-A');

      // L→non-stroke under the same id.
      captureGeometryOwnershipForIds(model, ['LB-B']);
      model.objects['LB-B'] = rectangleObject('LB-B', {
        x: 10,
        y: 10,
        width: 100,
        height: 50,
      });
      invalidateCompiledForIds(model, ['LB-B']);
      expect(backgroundPackRendezvousKeysForIds(model, ['LB-B'])).toContain(
        'l:LB',
      );

      // Non-stroke→M stroke under the same id.
      const freshPoints = samples(300, 9000);
      captureGeometryOwnershipForIds(model, ['LB-B']);
      model.objects['LB-B'] = inkStrokeObject('LB-B', {
        points: freshPoints,
        width: 3,
        logicalId: 'MB',
        chunkIndex: 0,
      });
      invalidateCompiledForIds(model, ['LB-B']);
      const afterMKeys = backgroundPackRendezvousKeysForIds(model, ['LB-B']);
      expect(afterMKeys).toContain('l:MB');

      // Delete the M chunk: latest M must be emitted, not shadowed by L.
      deleteRecord(model, 'LB-B');
      const keys = backgroundPackRendezvousKeysForIds(model, ['LB-B']);
      expect(keys).toContain('l:MB');
      expect(logicalGeometryGeneration(model, 'MB')).toBeGreaterThan(0);

      // No surviving MB members (single-chunk M deleted) → survivor is null,
      // but the LB survivors still resolve and re-pack.
      expect(
        resolvePreparedBackgroundPackUnitForLogical(model, 'MB'),
      ).toBeNull();
      // The historical LB logical still has survivors A+C (Option A may keep
      // l:LB alongside l:MB; both are independently emitted).
      const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'LB');
      expect(survivor?.kind).toBe('logical');
      if (survivor?.kind !== 'logical') throw new Error('expected survivor');
      expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
      await flushBackgroundPackQueueForTests(200);
      const fresh = jointPackedForChunk(model.objects['LB-A']!);
      expect(fresh).toBeDefined();
      expect(jointPackedForChunk(model.objects['LB-C']!)).toBe(fresh);
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    } finally {
      setBackgroundPackWorkerFactory(null);
    }
  });

  it('L→non-stroke→M intermediate replacement already exposes the latest M', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'LX-A', 'LX', 0, 0);
    addChunk(model, 'LX-B', 'LX', 1, 2000);
    addChunk(model, 'LX-C', 'LX', 2, 4000);

    captureGeometryOwnershipForIds(model, ['LX-B']);
    model.objects['LX-B'] = rectangleObject('LX-B', {
      x: 10,
      y: 10,
      width: 100,
      height: 50,
    });
    invalidateCompiledForIds(model, ['LX-B']);

    captureGeometryOwnershipForIds(model, ['LX-B']);
    model.objects['LX-B'] = inkStrokeObject('LX-B', {
      points: samples(300, 9000),
      width: 3,
      logicalId: 'MX',
      chunkIndex: 0,
    });
    invalidateCompiledForIds(model, ['LX-B']);

    const keys = backgroundPackRendezvousKeysForIds(model, ['LX-B']);
    expect(keys).toContain('l:MX');
    // Current logical is also independently emitted (current ≠ shadowed).
    expect(keys).toContain('l:MX');
    // Dedup: no duplicate emission collapses the latest key.
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('Case C: L→M→N repeated replacement', () => {
  it('delete after L→M→N emits current N', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    try {
      const model = emptySurface(boundedFrame(60000, 6000));
      addChunk(model, 'LC-A', 'LC', 0, 0);
      addChunk(model, 'LC-X', 'LC', 1, 2000);
      addChunk(model, 'LC-C', 'LC', 2, 4000);
      await retainJointViaPrepared(model, 'LC-A');

      replaceWithLogical(model, 'LC-X', 'MC', 0);
      expect(backgroundPackRendezvousKeysForIds(model, ['LC-X'])).toContain(
        'l:MC',
      );
      replaceWithLogical(model, 'LC-X', 'NC', 0);
      const afterNKeys = backgroundPackRendezvousKeysForIds(model, ['LC-X']);
      // Current/latest logical N is always representable alongside history.
      expect(afterNKeys).toContain('l:NC');

      deleteRecord(model, 'LC-X');
      const keys = backgroundPackRendezvousKeysForIds(model, ['LC-X']);
      expect(keys).toContain('l:NC');
      expect(logicalGeometryGeneration(model, 'NC')).toBeGreaterThan(0);

      // NC has no survivors (single-chunk deleted) → null, but the original
      // LC survivors still resolve and re-pack.
      expect(
        resolvePreparedBackgroundPackUnitForLogical(model, 'NC'),
      ).toBeNull();
      const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'LC');
      expect(survivor?.kind).toBe('logical');
      if (survivor?.kind !== 'logical') throw new Error('expected survivor');
      expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
      await flushBackgroundPackQueueForTests(200);
      const fresh = jointPackedForChunk(model.objects['LC-A']!);
      expect(fresh).toBeDefined();
      expect(jointPackedForChunk(model.objects['LC-C']!)).toBe(fresh);
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    } finally {
      setBackgroundPackWorkerFactory(null);
    }
  });

  it('same-logical mutate after L→M→N keeps current N representable', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'LD-A', 'LD', 0, 0);
    addChunk(model, 'LD-X', 'LD', 1, 2000);
    addChunk(model, 'LD-C', 'LD', 2, 4000);

    replaceWithLogical(model, 'LD-X', 'MD', 0);
    replaceWithLogical(model, 'LD-X', 'ND', 0);

    // Same-logical edit of the N chunk (no membership change).
    const record = model.objects['LD-X']!;
    captureGeometryOwnershipForIds(model, ['LD-X']);
    const pts = (
      record as unknown as {
        points: { x: number; y: number; pressure: number; dt: number }[];
      }
    ).points;
    model.objects['LD-X'] = inkStrokeObject('LD-X', {
      points: pts.map((p) => ({ ...p, y: p.y + 5 })),
      width: 3,
      logicalId: 'ND',
      chunkIndex: 0,
    });
    invalidateCompiledForIds(model, ['LD-X']);

    const keys = backgroundPackRendezvousKeysForIds(model, ['LD-X']);
    expect(keys).toContain('l:ND');
    expect(logicalGeometryGeneration(model, 'ND')).toBeGreaterThan(0);
    // Current unit resolves through the live record path.
    const unit = resolvePreparedBackgroundPackUnit(model, 'LD-X');
    expect(unit?.kind).toBe('logical');
    if (unit?.kind !== 'logical') throw new Error('expected logical unit');
    expect(unit.logicalId).toBe('ND');
  });
});

describe('replacement-chain generation + budget semantics', () => {
  it('geometry bumps for old+new logicals and rendezvous stays O(mutated ids)', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    try {
      const base = emptySurface(boundedFrame(60000, 6000));
      addChunk(base, 'G-A', 'G', 0, 0);
      addChunk(base, 'G-B', 'G', 1, 2000);
      addChunk(base, 'G-C', 'G', 2, 4000);
      addChunk(base, 'H-D', 'H', 1, 8000);
      // Wrap BEFORE any capture/invalidation so the model-scoped
      // membership/ownership index lives on the proxied identity (the same
      // pattern as the non-stroke no-scan regression).
      let keyEnumerations = 0;
      const objects = new Proxy(base.objects, {
        ownKeys(target) {
          keyEnumerations += 1;
          return Reflect.ownKeys(target);
        },
      });
      const model: SurfaceModel = { ...base, objects };
      await retainJointViaPrepared(model, 'G-A');

      const lBefore = logicalGeometryGeneration(model, 'G');
      const mBefore = logicalGeometryGeneration(model, 'H');
      replaceWithLogical(model, 'G-B', 'H', 0);
      expect(logicalGeometryGeneration(model, 'G')).toBeGreaterThan(lBefore);
      expect(logicalGeometryGeneration(model, 'H')).toBeGreaterThan(mBefore);
      expect(recordGeometryGeneration(model, 'G-B')).toBeGreaterThan(0);

      // Rendezvous touches only mutated ids (no document scan).
      keyEnumerations = 0;
      const keys = backgroundPackRendezvousKeysForIds(model, ['G-B']);
      expect(keys).toContain('l:G');
      expect(keys).toContain('l:H');
      expect(keyEnumerations).toBe(0);

      // Survivor fresh pack still uses the background lane (no main-thread
      // full pack, bounded slices).
      const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'G');
      if (survivor?.kind !== 'logical') throw new Error('expected survivor');
      expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
      await flushBackgroundPackQueueForTests(200);
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
      expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
        BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
      );
    } finally {
      setBackgroundPackWorkerFactory(null);
    }
  });
});
