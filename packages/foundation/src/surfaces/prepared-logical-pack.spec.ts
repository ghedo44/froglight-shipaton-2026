/**
 * Scene-prepared logical background-pack regressions.
 *
 * The committed scene compiles a chunked logical stroke as ONE synthetic
 * joint; individual canonical chunks generally do NOT own rich compiled
 * geometry. These tests prove the scheduling seam understands that
 * distinction: a prepared logical unit packs as one joint Worker job over
 * canonical `chunkIndex` order and retains one shared packed identity on
 * every member, without per-chunk warming or a full-document scan.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
  boundedFrame,
  backgroundPackStats,
  captureGeometryOwnershipForIds,
  compiledStrokeForRecord,
  emptySurface,
  flushBackgroundPackQueueForTests,
  hasRichCompiledGeometry,
  inkStrokeObject,
  invalidateCompiledForIds,
  isCompiledWarm,
  jointPackedForChunk,
  logicalGeometryGeneration,
  logicalMembersOf,
  packedCompiledForRecord,
  resetBackgroundPackForTests,
  resetGeometryGenerationsForTests,
  resolvePreparedBackgroundPackUnit,
  scheduleBackgroundPackForRecords,
  scheduleBackgroundPackForPreparedUnit,
  setBackgroundPackWorkerFactory,
  smoothSpineOfRecord,
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
    x: xBase + i * 1.5,
    y: 300 + Math.sin((xBase + i) / 9) * 12,
    pressure: 0.5,
    dt: (xBase + i) * 4,
  }));
}

function addSingle(
  model: SurfaceModel,
  id: string,
  points: ReturnType<typeof samples>,
): void {
  model.objects[id] = inkStrokeObject(id, { points, width: 3 });
  model.order.push(id);
}

function addChunk(
  model: SurfaceModel,
  id: string,
  points: ReturnType<typeof samples>,
  logicalId: string,
  chunkIndex: number,
): void {
  model.objects[id] = inkStrokeObject(id, {
    points,
    width: 3,
    logicalId,
    chunkIndex,
  });
  model.order.push(id);
}

/** Held Worker: captures the request and waits until the test releases it. */
function heldWorker(): {
  worker: BackgroundPackWorker;
  held: () => PackedInkCompileRequest | null;
  release: () => void;
} {
  let held: PackedInkCompileRequest | null = null;
  const worker: BackgroundPackWorker = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage(message) {
      held = structuredClone(message) as PackedInkCompileRequest;
    },
  };
  return {
    worker,
    held: () => held,
    release: () => {
      const request = held;
      if (request === null) throw new Error('no held request');
      const compiled = compileInkStroke(
        unpackInkSamples(request.samples),
        request.brush,
        request.options ?? {},
      );
      const { packed, bytes } = packCompiledInk(compiled);
      worker.onmessage?.({
        data: {
          type: 'compiled-ink',
          requestId: request.requestId,
          objectId: request.objectId,
          generation: request.generation,
          compiled: structuredClone(packed),
          workerUnpackMs: 0,
          compileMs: 1,
          packMs: 0,
          outputBytes: bytes,
        } as PackedInkCompileResponse,
      });
    },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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
            compiled: packed,
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

beforeEach(() => {
  resetBackgroundPackForTests();
  resetGeometryGenerationsForTests();
});

describe('scene-prepared logical units pack as one joint job', () => {
  it('cold chunks (no per-chunk rich geometry) → one joint request, one shared packed identity', async () => {
    const { worker, requests } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = emptySurface(boundedFrame(500000, 5000));
    addChunk(model, 'LPC', samples(7000, 0), 'LPC', 0);
    addChunk(model, 'LPC#part2', samples(1500, 12000), 'LPC', 1);

    // Scene preparation truth WITHOUT per-chunk rich geometry: every chunk
    // is cold on its own (the committed scene compiled the synthetic joint).
    for (const id of model.order) {
      expect(isCompiledWarm(model.objects[id]!)).toBe(false);
      expect(hasRichCompiledGeometry(model.objects[id]!)).toBe(false);
    }

    const unit = resolvePreparedBackgroundPackUnit(model, 'LPC');
    expect(unit?.kind).toBe('logical');
    if (unit?.kind !== 'logical') throw new Error('expected logical unit');
    expect(unit.logicalId).toBe('LPC');
    expect(unit.records.map((r) => r.id)).toEqual(['LPC', 'LPC#part2']);

    const jobsBefore = backgroundPackStats.workerJobs;
    const completedBefore = backgroundPackStats.workerCompleted;
    expect(scheduleBackgroundPackForPreparedUnit(unit, model)).toBe(true);
    await flushBackgroundPackQueueForTests(200);

    // ONE logical Worker job over canonical chunk order.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.objectId).toBe('LPC');
    expect(requests[0]!.samples.count).toBe(8500);
    expect(backgroundPackStats.workerJobs - jobsBefore).toBe(1);
    expect(backgroundPackStats.workerCompleted).toBe(completedBefore + 1);
    expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
      BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
    );

    // One shared retained packed identity on every chunk, meaningful
    // geometry (non-empty bounds + a resolvable spine over the joint).
    const head = model.objects['LPC']!;
    const joint = jointPackedForChunk(head);
    expect(joint).toBeDefined();
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBe(joint);
      // The joint is retained; per-chunk record-packed is not fabricated.
      expect(packedCompiledForRecord(model.objects[id]!)).toBeUndefined();
    }
    expect(joint!.boundsXYWH[2]).toBeGreaterThan(0);
    expect(joint!.boundsXYWH[3]).toBeGreaterThan(0);
    expect(smoothSpineOfRecord(head).length).toBeGreaterThan(0);
    setBackgroundPackWorkerFactory(null);
  });

  it('new chunk appended to an existing logical resolves enriched membership', () => {
    const model = emptySurface(boundedFrame(500000, 5000));
    addChunk(model, 'LGM', samples(500, 0), 'LGM', 0);
    addChunk(model, 'LGM#part2', samples(500, 2000), 'LGM', 1);
    // Creation boundary: the new chunk is invalidated as it enters the model.
    addChunk(model, 'LGM#part3', samples(500, 4000), 'LGM', 2);
    invalidateCompiledForIds(model, ['LGM#part3']);
    expect(logicalMembersOf(model, 'LGM').sort()).toEqual([
      'LGM',
      'LGM#part2',
      'LGM#part3',
    ]);
    const unit = resolvePreparedBackgroundPackUnit(model, 'LGM');
    expect(unit?.kind).toBe('logical');
    if (unit?.kind !== 'logical') throw new Error('expected logical unit');
    expect(unit.records.map((r) => r.id)).toEqual([
      'LGM',
      'LGM#part2',
      'LGM#part3',
    ]);
  });

  it('scheduling-time mutation advances the logical epoch and drops the prepared request', async () => {
    const { worker, requests } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = emptySurface(boundedFrame(500000, 5000));
    addChunk(model, 'LSTALE', samples(1200, 0), 'LSTALE', 0);
    addChunk(model, 'LSTALE#part2', samples(1200, 4000), 'LSTALE', 1);
    const unit = resolvePreparedBackgroundPackUnit(model, 'LSTALE');
    if (unit?.kind !== 'logical') throw new Error('expected logical unit');
    expect(scheduleBackgroundPackForPreparedUnit(unit, model)).toBe(true);
    // Mutate a member before the idle pump creates the job.
    const victim = model.objects['LSTALE#part2']!;
    ((victim as Record<string, unknown>).points as { x: number }[])[0]!.x +=
      100;
    invalidateCompiledForIds(model, ['LSTALE#part2']);
    expect(logicalGeometryGeneration(model, 'LSTALE')).toBeGreaterThan(0);
    await flushBackgroundPackQueueForTests(100);
    expect(requests).toHaveLength(0);
    expect(jointPackedForChunk(model.objects['LSTALE']!)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });

  it('refreshed prepared truth replaces a queued stale request instead of being dropped', async () => {
    const { worker, requests } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = emptySurface(boundedFrame(500000, 5000));
    addChunk(model, 'LREF', samples(1200, 0), 'LREF', 0);
    addChunk(model, 'LREF#part2', samples(1200, 4000), 'LREF', 1);
    const first = resolvePreparedBackgroundPackUnit(model, 'LREF');
    if (first?.kind !== 'logical') throw new Error('expected logical unit');
    expect(scheduleBackgroundPackForPreparedUnit(first, model)).toBe(true);
    // Mutate before the idle pump runs, then re-prepare/re-schedule: the
    // queued request must be refreshed to the newest epoch, not dropped.
    const victim = model.objects['LREF#part2']!;
    ((victim as Record<string, unknown>).points as { x: number }[])[0]!.x +=
      250;
    invalidateCompiledForIds(model, ['LREF#part2']);
    const second = resolvePreparedBackgroundPackUnit(model, 'LREF');
    if (second?.kind !== 'logical') throw new Error('expected logical unit');
    expect(scheduleBackgroundPackForPreparedUnit(second, model)).toBe(true);
    await flushBackgroundPackQueueForTests(200);
    expect(requests).toHaveLength(1);
    const joint = jointPackedForChunk(model.objects['LREF']!);
    expect(joint).toBeDefined();
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBe(joint);
    }
    setBackgroundPackWorkerFactory(null);
  });

  it('in-flight prepared logical Worker output drops when a member mutates before release', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = emptySurface(boundedFrame(500000, 5000));
    addChunk(model, 'LHOLD', samples(1200, 0), 'LHOLD', 0);
    addChunk(model, 'LHOLD#part2', samples(1200, 4000), 'LHOLD', 1);
    const unit = resolvePreparedBackgroundPackUnit(model, 'LHOLD');
    if (unit?.kind !== 'logical') throw new Error('expected logical unit');
    expect(scheduleBackgroundPackForPreparedUnit(unit, model)).toBe(true);
    await flushBackgroundPackQueueForTests(50);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    const victim = model.objects['LHOLD#part2']!;
    ((victim as Record<string, unknown>).points as { x: number }[])[0]!.x += 33;
    invalidateCompiledForIds(model, ['LHOLD#part2']);
    held.release();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
    }
    setBackgroundPackWorkerFactory(null);
  });

  it('identical logical ids across two models never merge into one joint request', async () => {
    const { worker, requests } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const modelA = emptySurface(boundedFrame(500000, 5000));
    addChunk(modelA, 'SAME', samples(900, 0), 'SAME', 0);
    addChunk(modelA, 'SAME#part2', samples(900, 2000), 'SAME', 1);
    const modelB = emptySurface(boundedFrame(500000, 5000));
    addChunk(modelB, 'SAME', samples(900, 0), 'SAME', 0);
    addChunk(modelB, 'SAME#part2', samples(900, 2000), 'SAME', 1);
    const unitA = resolvePreparedBackgroundPackUnit(modelA, 'SAME');
    const unitB = resolvePreparedBackgroundPackUnit(modelB, 'SAME');
    if (unitA?.kind !== 'logical' || unitB?.kind !== 'logical')
      throw new Error('expected logical units');
    expect(scheduleBackgroundPackForPreparedUnit(unitA, modelA)).toBe(true);
    expect(scheduleBackgroundPackForPreparedUnit(unitB, modelB)).toBe(true);
    await flushBackgroundPackQueueForTests(200);
    expect(requests).toHaveLength(2);
    const jointA = jointPackedForChunk(modelA.objects['SAME']!);
    const jointB = jointPackedForChunk(modelB.objects['SAME']!);
    expect(jointA).toBeDefined();
    expect(jointB).toBeDefined();
    expect(jointA).not.toBe(jointB);
    setBackgroundPackWorkerFactory(null);
  });
});

describe('logical membership index (no full-document peer scan)', () => {
  it('single-only documents never enumerate document keys on mutation', () => {
    const base = emptySurface(boundedFrame(30000, 5000));
    for (let i = 0; i < 50; i++) {
      addSingle(base, `single-${i}`, samples(60, i * 120));
    }
    let keyEnumerations = 0;
    const objects = new Proxy(base.objects, {
      ownKeys(target) {
        keyEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const model: SurfaceModel = { ...base, objects };
    captureGeometryOwnershipForIds(model, ['single-0']);
    // No logical membership → no index seed, no document enumeration.
    expect({ phase: 'capture', keyEnumerations }).toEqual({
      phase: 'capture',
      keyEnumerations: 0,
    });
    invalidateCompiledForIds(model, ['single-0']);
    expect({ phase: 'invalidate', keyEnumerations }).toEqual({
      phase: 'invalidate',
      keyEnumerations: 0,
    });
  });

  it('invalidation after seeding never enumerates document keys and peers clear correctly', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const base = emptySurface(boundedFrame(900000, 5000));
    addChunk(base, 'PA', samples(800, 0), 'PL1', 0);
    addChunk(base, 'PB', samples(800, 2000), 'PL1', 1);
    addChunk(base, 'PC', samples(800, 4000), 'PL2', 0);
    addSingle(base, 'SINGLE', samples(800, 8000));

    let keyEnumerations = 0;
    const objects = new Proxy(base.objects, {
      ownKeys(target) {
        keyEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const model: SurfaceModel = { ...base, objects };

    // Warm every logical member, then retain joints through the ordinary
    // record lane (grouped per model + logical id).
    for (const id of model.order) {
      if (id === 'SINGLE') continue;
      compiledStrokeForRecord(model.objects[id]!);
    }
    scheduleBackgroundPackForRecords(
      model.order
        .filter((id) => id !== 'SINGLE')
        .map((id) => model.objects[id]!),
      model,
    );
    await flushBackgroundPackQueueForTests(200);
    expect(jointPackedForChunk(model.objects['PA']!)).toBeDefined();
    expect(jointPackedForChunk(model.objects['PC']!)).toBeDefined();

    // Seed the membership index at the pre-mutation capture boundary (one
    // deliberate enumeration), then measure the mutation invalidation: no
    // document key enumeration.
    captureGeometryOwnershipForIds(model, ['PA']);
    keyEnumerations = 0;
    invalidateCompiledForIds(model, ['PA']);
    expect(keyEnumerations).toBe(0);
    // PL1 peers cleared, unrelated PL2 joint preserved.
    expect(jointPackedForChunk(model.objects['PB']!)).toBeUndefined();
    expect(jointPackedForChunk(model.objects['PC']!)).toBeDefined();
    setBackgroundPackWorkerFactory(null);
  });
});
