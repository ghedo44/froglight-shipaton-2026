/**
 * Background-pack translation/position-epoch regressions.
 *
 * Geometry generations deliberately do NOT change on rigid translation
 * (zero-copy translation must not recompile B-splines). Without a separate
 * position epoch, a logical pack job that copied coordinates across
 * multiple idle slices (or while a Worker request is in flight) would pass
 * every geometry/identity/count check and install stale or mixed-coordinate
 * packed geometry.
 *
 * These tests exercise the REAL background input-copy machinery (bounded
 * slices, real Worker lane) plus the REAL translation seam (canonical
 * rewrite via the type registry + `accumulateDerivedTranslation`, which
 * advances the model-scoped position epoch O(moved ids)). They never set
 * private counters directly.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
  accumulateDerivedTranslation,
  backgroundPackStats,
  boundedFrame,
  compiledStrokeComputeStats,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  flushBackgroundPackQueueForTests,
  jointPackedForChunk,
  jointTranslationForChunk,
  derivedTranslationOfRecord,
  logicalGeometryGeneration,
  logicalPositionGeneration,
  recordGeometryGeneration,
  recordPositionGeneration,
  resetBackgroundPackForTests,
  resetGeometryGenerationsForTests,
  resolvePreparedBackgroundPackUnit,
  scheduleBackgroundPackForPreparedUnit,
  setBackgroundPackWorkerFactory,
  inkStrokeObject,
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
      requests.push(structuredClone(message) as PackedInkCompileRequest);
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

async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Rigid translation through the real seam: canonical rewrite via the type
 * registry (the same `translate` the interaction controller invokes) plus
 * derived-transform accumulation (which advances the model-scoped position
 * epoch O(moved ids) without touching geometry generations or samples).
 */
function translateLogical(
  model: SurfaceModel,
  ids: readonly string[],
  dx: number,
  dy: number,
): void {
  const registry = createDefaultSurfaceObjectTypeRegistry();
  for (const id of ids) {
    const record = model.objects[id];
    if (record === undefined) continue;
    registry.get(record.type)?.translate?.(record, dx, dy);
  }
  accumulateDerivedTranslation(model, ids, dx, dy);
}

beforeEach(() => {
  resetBackgroundPackForTests();
  resetGeometryGenerationsForTests();
});

describe('translation while Worker response is held', () => {
  it('stale joint drops, position advances, geometry does not, fresh pack installs translated geometry', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = emptySurface(boundedFrame(500000, 5000));
    addChunk(model, 'L', samples(600, 0), 'L', 0);
    addChunk(model, 'L#part2', samples(600, 2000), 'L', 1);
    addChunk(model, 'L#part3', samples(600, 4000), 'L', 2);
    const ids = [...model.order];

    const unit = resolvePreparedBackgroundPackUnit(model, 'L');
    expect(unit?.kind).toBe('logical');
    if (unit?.kind !== 'logical') throw new Error('expected logical unit');
    expect(scheduleBackgroundPackForPreparedUnit(unit, model)).toBe(true);
    await flushBackgroundPackQueueForTests(50);
    expect(held.held()).not.toBeNull();
    const staleRequest = held.held()!;
    expect(staleRequest.samples.count).toBe(1800);
    const firstXBefore = (
      model.objects['L'] as unknown as { points: { x: number }[] }
    ).points[0]!.x;

    const staleBefore = backgroundPackStats.workerStaleDrops;
    const geoBefore = ids.map((id) => recordGeometryGeneration(model, id));
    const logicalGeoBefore = logicalGeometryGeneration(model, 'L');
    const posBefore = ids.map((id) => recordPositionGeneration(model, id));
    const logicalPosBefore = logicalPositionGeneration(model, 'L');
    const computesBefore = compiledStrokeComputeStats.computes;

    // Real rigid translation of the whole logical stroke.
    translateLogical(model, ids, 50, -30);

    // Position epoch advanced (record + logical); geometry did NOT.
    for (let i = 0; i < ids.length; i++) {
      expect(recordGeometryGeneration(model, ids[i]!)).toBe(geoBefore[i]);
      expect(recordPositionGeneration(model, ids[i]!)).toBeGreaterThan(
        posBefore[i]!,
      );
    }
    expect(logicalGeometryGeneration(model, 'L')).toBe(logicalGeoBefore);
    expect(logicalPositionGeneration(model, 'L')).toBeGreaterThan(
      logicalPosBefore,
    );
    // No B-spline recompilation triggered by pure translation.
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
    // The race precondition: no joint existed yet and cold chunks own no
    // per-record derived geometry, so the old translation checks read zero.
    expect(jointTranslationForChunk(model.objects['L']!).tx).toBe(0);
    expect(derivedTranslationOfRecord(model.objects['L']!).tx).toBe(0);

    // Release the OLD Worker response (compiled from pre-translation input).
    held.release();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    for (const id of ids) {
      expect(
        jointPackedForChunk(model.objects[id]!),
        `stale joint must not install on ${id}`,
      ).toBeUndefined();
    }
    expect(backgroundPackStats.mainThreadFullPacks).toBe(0);

    // Fresh valid pack after translation installs translated geometry.
    const rec = recordingWorker();
    setBackgroundPackWorkerFactory(() => rec.worker);
    const fresh = resolvePreparedBackgroundPackUnit(model, 'L');
    expect(fresh?.kind).toBe('logical');
    if (fresh?.kind !== 'logical') throw new Error('expected logical unit');
    expect(scheduleBackgroundPackForPreparedUnit(fresh, model)).toBe(true);
    await flushBackgroundPackQueueForTests(200);
    expect(rec.requests).toHaveLength(1);
    // Fresh Worker input copies the TRANSLATED canonical position.
    expect(rec.requests[0]!.samples.positionXY[0]).toBeCloseTo(
      firstXBefore + 50,
      9,
    );
    const joint = jointPackedForChunk(model.objects['L']!);
    expect(joint).toBeDefined();
    for (const id of ids) {
      expect(jointPackedForChunk(model.objects[id]!)).toBe(joint);
    }
    expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    setBackgroundPackWorkerFactory(null);
  });
});

describe('translation during multi-slice input copy', () => {
  it('partially copied job cancels before Worker post; no mixed install; slices stay bounded', async () => {
    const rec = recordingWorker();
    setBackgroundPackWorkerFactory(() => rec.worker);
    const model = emptySurface(boundedFrame(500000, 5000));
    // Total 4500 > 2000/slice → at least 3 slices (2000 + 2000 + 500).
    addChunk(model, 'BIG', samples(1500, 0), 'BIG', 0);
    addChunk(model, 'BIG#part2', samples(1500, 4000), 'BIG', 1);
    addChunk(model, 'BIG#part3', samples(1500, 8000), 'BIG', 2);
    const ids = [...model.order];

    const unit = resolvePreparedBackgroundPackUnit(model, 'BIG');
    expect(unit?.kind).toBe('logical');
    if (unit?.kind !== 'logical') throw new Error('expected logical unit');
    expect(scheduleBackgroundPackForPreparedUnit(unit, model)).toBe(true);

    // Advance only the first input slice through the REAL machinery.
    await flushBackgroundPackQueueForTests(1);
    expect(backgroundPackStats.inputSamples).toBe(
      BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
    );
    expect(backgroundPackStats.workerJobs).toBe(0);
    expect(rec.requests).toHaveLength(0);

    const geoBefore = ids.map((id) => recordGeometryGeneration(model, id));
    const logicalGeoBefore = logicalGeometryGeneration(model, 'BIG');
    const staleBefore = backgroundPackStats.workerStaleDrops;

    // Translate before the remaining slices copy (real seam, not a counter).
    translateLogical(model, ids, -80, 45);
    for (let i = 0; i < ids.length; i++) {
      expect(recordGeometryGeneration(model, ids[i]!)).toBe(geoBefore[i]);
      expect(recordPositionGeneration(model, ids[i]!)).toBeGreaterThan(0);
    }
    expect(logicalGeometryGeneration(model, 'BIG')).toBe(logicalGeoBefore);
    expect(logicalPositionGeneration(model, 'BIG')).toBeGreaterThan(0);

    // Resume the queue: the partially copied old job must cancel BEFORE any
    // Worker installation (no mixed old/new coordinate request).
    await flushBackgroundPackQueueForTests(200);
    expect(rec.requests).toHaveLength(0);
    expect(backgroundPackStats.workerJobs).toBe(0);
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    for (const id of ids) {
      expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
    }
    expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
      BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
    );
    expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    setBackgroundPackWorkerFactory(null);
  });
});

describe('position-epoch model isolation', () => {
  it('identical ids and logical ids never share position epochs across models', () => {
    const modelA = emptySurface(boundedFrame(20000, 20000));
    addChunk(modelA, 'SAME', samples(200, 0), 'SAME', 0);
    addChunk(modelA, 'SAME#part2', samples(200, 2000), 'SAME', 1);
    const modelB = emptySurface(boundedFrame(20000, 20000));
    addChunk(modelB, 'SAME', samples(200, 0), 'SAME', 0);
    addChunk(modelB, 'SAME#part2', samples(200, 2000), 'SAME', 1);

    translateLogical(modelA, ['SAME', 'SAME#part2'], 25, 10);
    expect(recordPositionGeneration(modelA, 'SAME')).toBe(1);
    expect(logicalPositionGeneration(modelA, 'SAME')).toBe(1);
    expect(recordPositionGeneration(modelB, 'SAME')).toBe(0);
    expect(logicalPositionGeneration(modelB, 'SAME')).toBe(0);
    // Geometry generations untouched on both models.
    expect(recordGeometryGeneration(modelA, 'SAME')).toBe(0);
    expect(recordGeometryGeneration(modelB, 'SAME')).toBe(0);
    expect(logicalGeometryGeneration(modelA, 'SAME')).toBe(0);
    expect(logicalGeometryGeneration(modelB, 'SAME')).toBe(0);
  });
});
