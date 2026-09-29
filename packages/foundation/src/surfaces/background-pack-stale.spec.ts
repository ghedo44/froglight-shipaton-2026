/**
 * Background-pack stale-Worker regressions.
 *
 * Proves the explicit geometry-generation contract rejects pre-mutation
 * packed geometry for same-length mutations that the old count/translation
 * heuristic accepted. Every test holds a logical/single Worker job, mutates
 * canonically with the SAME sample count, runs the normal
 * `invalidateCompiledForIds` invalidation, releases the OLD Worker response,
 * and asserts it is counted stale with NO old geometry installed.
 *
 * Retained geometry (not merely counters) is verified in every case.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  emptySurface,
  boundedFrame,
  inkStrokeObject,
  compiledStrokeForRecord,
  jointPackedForChunk,
  packedCompiledForRecord,
  smoothSpineOfRecord,
  invalidateCompiledForIds,
  captureGeometryOwnershipForIds,
  recordGeometryGeneration,
  logicalGeometryGeneration,
  resetGeometryGenerationsForTests,
  scheduleBackgroundPackForRecords,
  flushBackgroundPackQueueForTests,
  resetBackgroundPackForTests,
  setBackgroundPackWorkerFactory,
  backgroundPackStats,
  type BackgroundPackWorker,
  type SurfaceModel,
  SURFACE_MAX_STROKE_POINTS,
} from './index.js';
import { compileInkStroke } from './ink/compiler.js';
import {
  unpackInkSamples,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from './ink/packed-protocol.js';
import { packCompiledInk } from './ink/packed-protocol.js';

function chunkedLogicalModel(
  totalSamples: number,
  logicalId = 'L',
  width = 3,
): SurfaceModel {
  const model = emptySurface(boundedFrame(500000, 5000));
  let remaining = totalSamples;
  let index = 0;
  let xBase = 100;
  const cap = SURFACE_MAX_STROKE_POINTS;
  while (remaining > 0) {
    const count = Math.min(cap, remaining);
    const points: { x: number; y: number; pressure: number; dt: number }[] = [];
    for (let i = 0; i < count; i++) {
      const global = index * cap + i;
      points.push({
        x: xBase + i * 1.5,
        y: 300 + Math.sin(global / 7) * 10,
        pressure: 0.5,
        dt: global * 4,
      });
    }
    const chunkId = index === 0 ? logicalId : `${logicalId}#part${index + 1}`;
    model.objects[chunkId] = inkStrokeObject(chunkId, {
      points,
      width,
      logicalId,
      chunkIndex: index,
    });
    model.order.push(chunkId);
    remaining -= count;
    xBase += count * 1.5;
    index += 1;
  }
  return model;
}

function singleModel(samples = 500, id = 's0'): SurfaceModel {
  const model = emptySurface(boundedFrame(20000, 20000));
  const points: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < samples; i++) {
    points.push({
      x: 100 + i * 2,
      y: 200 + Math.sin(i / 5) * 8,
      pressure: 0.5,
      dt: i * 8,
    });
  }
  model.objects[id] = inkStrokeObject(id, { points, width: 3 });
  model.order.push(id);
  return model;
}

function threeChunkLogicalModel(logicalId: string): SurfaceModel {
  const model = emptySurface(boundedFrame(20000, 20000));
  for (let chunkIndex = 0; chunkIndex < 3; chunkIndex++) {
    const id = `${logicalId}-${String.fromCharCode(65 + chunkIndex)}`;
    const points = Array.from({ length: 300 }, (_, i) => ({
      x: chunkIndex * 1000 + i * 2,
      y: 200 + Math.sin(i / 5) * 8,
      pressure: 0.5,
      dt: (chunkIndex * 300 + i) * 8,
    }));
    model.objects[id] = inkStrokeObject(id, {
      points,
      width: 3,
      logicalId,
      chunkIndex,
    });
    model.order.push(id);
  }
  return model;
}

function warmAll(model: SurfaceModel): void {
  for (const id of model.order) {
    expect(compiledStrokeForRecord(model.objects[id]!)).not.toBeNull();
  }
}

/** Held Worker: captures the request and waits until the test releases it. */
function heldWorker(): {
  worker: BackgroundPackWorker;
  held: () => PackedInkCompileRequest | null;
  releaseOld: () => void;
} {
  let held: PackedInkCompileRequest | null = null;
  let target: BackgroundPackWorker | null = null;
  const worker: BackgroundPackWorker = {
    postMessage(message: PackedInkCompileRequest) {
      held = structuredClone(message) as PackedInkCompileRequest;
    },
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
  };
  target = worker;
  void target;
  return {
    worker,
    held: () => held,
    releaseOld: () => {
      const req = held!;
      expect(req).not.toBeNull();
      const compiled = compileInkStroke(
        unpackInkSamples(req.samples),
        req.brush,
        (req as { options?: never }).options ?? {},
      );
      const { packed, bytes } = packCompiledInk(compiled);
      worker.onmessage!({
        data: {
          type: 'compiled-ink',
          requestId: req.requestId,
          objectId: req.objectId,
          generation: req.generation,
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

async function retainJoint(model: SurfaceModel): Promise<void> {
  const held = heldWorker();
  setBackgroundPackWorkerFactory(() => held.worker);
  warmAll(model);
  scheduleBackgroundPackForRecords(
    model.order.map((id) => model.objects[id]!),
    model,
  );
  await flushBackgroundPackQueueForTests(20);
  expect(held.held()).not.toBeNull();
  held.releaseOld();
  await tick();
  const joint = jointPackedForChunk(model.objects[model.order[0]!]!);
  expect(joint).toBeDefined();
  for (const id of model.order) {
    expect(jointPackedForChunk(model.objects[id]!)).toBe(joint);
  }
}

beforeEach(() => {
  resetBackgroundPackForTests();
  resetGeometryGenerationsForTests();
});

describe('logical same-length coordinate mutation rejects stale joint', () => {
  it('held joint job + same-count point edit → stale, no joint installed', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = chunkedLogicalModel(20000, 'BGSTALE');
    warmAll(model);
    const chunks = model.order.map((id) => model.objects[id]!);
    // Production passes the owning model for identity validation.
    scheduleBackgroundPackForRecords(chunks, model);
    await flushBackgroundPackQueueForTests(20);
    const req = held.held();
    expect(req).not.toBeNull();
    // Meaningful generation (not hardcoded 0 for a fresh logical? epoch 0 is
    // correct here; the point is it echoes the captured logical epoch).
    expect(req!.generation).toBe(logicalGeometryGeneration(model, 'BGSTALE'));
    expect(req!.objectId).toBe('BGSTALE');
    const staleBefore = backgroundPackStats.workerStaleDrops;
    // Same-length coordinate mutation of one member.
    const victim = model.objects[model.order[0]!]!;
    const pts = (victim as Record<string, unknown>).points as {
      x: number;
      y: number;
    }[];
    const beforeCount = pts.length;
    for (let i = 0; i < pts.length; i += 7) {
      pts[i]!.x += 33;
      pts[i]!.y -= 17;
    }
    expect(pts.length).toBe(beforeCount);
    invalidateCompiledForIds(model, [victim.id]);
    // Epochs advanced (the contract that makes the old response stale).
    expect(recordGeometryGeneration(model, victim.id)).toBeGreaterThan(0);
    expect(logicalGeometryGeneration(model, 'BGSTALE')).toBeGreaterThan(
      req!.generation,
    );
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    // NO old logical joint installed on any peer (retained geometry check).
    for (const id of model.order) {
      expect(
        jointPackedForChunk(model.objects[id]!),
        `joint must not install on ${id}`,
      ).toBeUndefined();
    }
    setBackgroundPackWorkerFactory(null);
  });
});

describe('single-record same-length mutations reject stale output', () => {
  it('same-count coordinate edit → stale, no packed installed', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = singleModel(800, 's0');
    warmAll(model);
    const record = model.objects['s0']!;
    const spineBefore = smoothSpineOfRecord(record);
    expect(spineBefore.length).toBeGreaterThan(0);
    scheduleBackgroundPackForRecords([record], model);
    await flushBackgroundPackQueueForTests(10);
    const req = held.held();
    expect(req).not.toBeNull();
    expect(req!.generation).toBe(recordGeometryGeneration(model, 's0'));
    const staleBefore = backgroundPackStats.workerStaleDrops;
    const pts = (record as Record<string, unknown>).points as {
      x: number;
      y: number;
    }[];
    const n = pts.length;
    for (let i = 0; i < pts.length; i++) {
      pts[i]!.x += 5;
    }
    expect(pts.length).toBe(n);
    invalidateCompiledForIds(model, ['s0']);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    // No old packed installed (retained geometry, not just counters).
    expect(packedCompiledForRecord(record)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });

  it('same-length pressure edit → stale, no packed installed', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = singleModel(600, 'sp');
    warmAll(model);
    const record = model.objects['sp']!;
    scheduleBackgroundPackForRecords([record], model);
    await flushBackgroundPackQueueForTests(10);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    const pts = (record as Record<string, unknown>).points as {
      pressure: number;
    }[];
    const n = pts.length;
    for (const p of pts) p.pressure = 0.9;
    expect(pts.length).toBe(n);
    invalidateCompiledForIds(model, ['sp']);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    expect(packedCompiledForRecord(record)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });

  it('brush/width mutation → stale, no packed installed', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = singleModel(600, 'sw');
    warmAll(model);
    const record = model.objects['sw']!;
    scheduleBackgroundPackForRecords([record], model);
    await flushBackgroundPackQueueForTests(10);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    // Geometry-affecting width change (same sample count).
    (record as Record<string, unknown>).width = 9;
    (record as Record<string, unknown>).brush = {
      kind: 'brush',
      pressure: { enabled: true },
    };
    invalidateCompiledForIds(model, ['sw']);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    expect(packedCompiledForRecord(record)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });
});

describe('logical same-length pressure/brush mutations reject stale joint', () => {
  it('same-count pressure edit on one member → stale joint', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = chunkedLogicalModel(15000, 'BGPRESS');
    warmAll(model);
    const chunks = model.order.map((id) => model.objects[id]!);
    scheduleBackgroundPackForRecords(chunks, model);
    await flushBackgroundPackQueueForTests(20);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    const victim = model.objects[model.order[1]!]!;
    const pts = (victim as Record<string, unknown>).points as {
      pressure: number;
    }[];
    const n = pts.length;
    for (const p of pts) p.pressure = 0.15;
    expect(pts.length).toBe(n);
    invalidateCompiledForIds(model, [victim.id]);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
    }
    setBackgroundPackWorkerFactory(null);
  });

  it('brush/width mutation on head → stale joint', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = chunkedLogicalModel(15000, 'BGBRUSH');
    warmAll(model);
    const chunks = model.order.map((id) => model.objects[id]!);
    scheduleBackgroundPackForRecords(chunks, model);
    await flushBackgroundPackQueueForTests(20);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    const head = model.objects[model.order[0]!]!;
    (head as Record<string, unknown>).width = 12;
    invalidateCompiledForIds(model, [head.id]);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
    }
    setBackgroundPackWorkerFactory(null);
  });
});

describe('deletion and same-id replacement reject stale output', () => {
  it('single deletion while output pending → stale, nothing installed', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = singleModel(500, 'del');
    warmAll(model);
    const record = model.objects['del']!;
    scheduleBackgroundPackForRecords([record], model);
    await flushBackgroundPackQueueForTests(10);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    // Delete: remove from model then invalidate the deleted id (bumps the
    // id-keyed epoch so the held job goes stale).
    delete model.objects['del'];
    model.order.splice(model.order.indexOf('del'), 1);
    invalidateCompiledForIds(model, ['del']);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    // Detached old reference must not gain packed geometry.
    expect(packedCompiledForRecord(record)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });

  it('logical member deletion while joint pending → stale joint', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = chunkedLogicalModel(20000, 'BGDEL');
    warmAll(model);
    const chunks = model.order.map((id) => model.objects[id]!);
    scheduleBackgroundPackForRecords(chunks, model);
    await flushBackgroundPackQueueForTests(20);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    const doomedId = model.order[0]!;
    const doomed = model.objects[doomedId]!;
    delete model.objects[doomedId];
    model.order.splice(model.order.indexOf(doomedId), 1);
    invalidateCompiledForIds(model, [doomedId]);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    expect(jointPackedForChunk(doomed)).toBeUndefined();
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
    }
    setBackgroundPackWorkerFactory(null);
  });

  it('same-id replacement while output pending → stale, no old install', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = singleModel(400, 'rep');
    warmAll(model);
    const oldRecord = model.objects['rep']!;
    const oldSpine = smoothSpineOfRecord(oldRecord);
    expect(oldSpine.length).toBeGreaterThan(0);
    scheduleBackgroundPackForRecords([oldRecord], model);
    await flushBackgroundPackQueueForTests(10);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    // Replace with a NEW record object under the SAME id (same count, moved
    // far away so old geometry would be visibly wrong if installed).
    const oldPts = (oldRecord as Record<string, unknown>).points as {
      x: number;
      y: number;
      pressure: number;
      dt: number;
    }[];
    const newPoints = oldPts.map((p) => ({
      x: p.x + 5000,
      y: p.y - 5000,
      pressure: p.pressure,
      dt: p.dt,
    }));
    const replacement = inkStrokeObject('rep', { points: newPoints, width: 3 });
    model.objects['rep'] = replacement;
    invalidateCompiledForIds(model, ['rep']);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    // Neither the detached old reference nor the replacement carries the
    // stale packed output.
    expect(packedCompiledForRecord(oldRecord)).toBeUndefined();
    expect(packedCompiledForRecord(replacement)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });

  it('logical same-id chunk replacement while joint pending → stale joint', async () => {
    const held = heldWorker();
    setBackgroundPackWorkerFactory(() => held.worker);
    const model = chunkedLogicalModel(20000, 'BGREP');
    warmAll(model);
    const chunks = model.order.map((id) => model.objects[id]!);
    scheduleBackgroundPackForRecords(chunks, model);
    await flushBackgroundPackQueueForTests(20);
    expect(held.held()).not.toBeNull();
    const staleBefore = backgroundPackStats.workerStaleDrops;
    const victimId = model.order[1]!;
    const oldChunk = model.objects[victimId]!;
    const oldPts = (oldChunk as Record<string, unknown>).points as {
      x: number;
      y: number;
      pressure: number;
      dt: number;
    }[];
    const logicalId = (oldChunk as Record<string, unknown>).logicalId as string;
    const chunkIndex = (oldChunk as Record<string, unknown>)
      .chunkIndex as number;
    const newPoints = oldPts.map((p) => ({
      x: p.x + 9000,
      y: p.y,
      pressure: p.pressure,
      dt: p.dt,
    }));
    const replacement = inkStrokeObject(victimId, {
      points: newPoints,
      width: 3,
      logicalId,
      chunkIndex,
    });
    model.objects[victimId] = replacement;
    invalidateCompiledForIds(model, [victimId]);
    held.releaseOld();
    await tick();
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(staleBefore);
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
    }
    expect(jointPackedForChunk(oldChunk)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });
});

describe('valid unchanged output still installs', () => {
  it('single and joint jobs install when nothing mutated', async () => {
    // Single.
    {
      const held = heldWorker();
      setBackgroundPackWorkerFactory(() => held.worker);
      const model = singleModel(400, 'ok1');
      warmAll(model);
      const record = model.objects['ok1']!;
      scheduleBackgroundPackForRecords([record], model);
      await flushBackgroundPackQueueForTests(10);
      expect(held.held()).not.toBeNull();
      held.releaseOld();
      await tick();
      expect(packedCompiledForRecord(record)).toBeDefined();
      const spine = smoothSpineOfRecord(record);
      expect(spine.length).toBeGreaterThan(0);
      setBackgroundPackWorkerFactory(null);
    }
    resetBackgroundPackForTests();
    resetGeometryGenerationsForTests();
    // Joint.
    {
      const held = heldWorker();
      setBackgroundPackWorkerFactory(() => held.worker);
      const model = chunkedLogicalModel(12000, 'OKJ');
      warmAll(model);
      const chunks = model.order.map((id) => model.objects[id]!);
      scheduleBackgroundPackForRecords(chunks, model);
      await flushBackgroundPackQueueForTests(20);
      expect(held.held()).not.toBeNull();
      held.releaseOld();
      await tick();
      for (const id of model.order) {
        expect(jointPackedForChunk(model.objects[id]!)).toBeDefined();
      }
      const spine = smoothSpineOfRecord(model.objects[model.order[0]!]!);
      expect(spine.length).toBeGreaterThan(0);
      setBackgroundPackWorkerFactory(null);
    }
  });
});

describe('retained logical ownership survives the first destructive mutation', () => {
  it.each([
    ['head', 0],
    ['member', 1],
  ] as const)('first %s deletion clears retained joint ownership', async (_label, index) => {
    const model = threeChunkLogicalModel('RETAIN-DEL');
    await retainJoint(model);
    const doomedId = model.order[index]!;
    const doomed = model.objects[doomedId]!;
    const before = logicalGeometryGeneration(model, 'RETAIN-DEL');

    captureGeometryOwnershipForIds(model, [doomedId]);
    delete model.objects[doomedId];
    model.order.splice(index, 1);
    invalidateCompiledForIds(model, [doomedId]);

    expect(logicalGeometryGeneration(model, 'RETAIN-DEL')).toBeGreaterThan(
      before,
    );
    expect(jointPackedForChunk(doomed)).toBeUndefined();
    for (const id of model.order) {
      expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
    }
  });

  it.each([
    ['the same logical', 'RETAIN-REPLACE'],
    ['another logical', 'M'],
    ['a single stroke', null],
  ] as const)(
    'same-id replacement L → %s clears old L ownership',
    async (_label, nextLogical) => {
      const model = threeChunkLogicalModel('RETAIN-REPLACE');
      await retainJoint(model);
      const victimId = model.order[1]!;
      const oldRecord = model.objects[victimId]!;
      const oldPoints = (oldRecord as unknown as { points: Array<{
        x: number;
        y: number;
        pressure: number;
        dt: number;
      }> }).points;
      captureGeometryOwnershipForIds(model, [victimId]);
      model.objects[victimId] = inkStrokeObject(victimId, {
        points: oldPoints.map((point) => ({ ...point, y: point.y + 1000 })),
        width: 3,
        ...(nextLogical === null
          ? {}
          : { logicalId: nextLogical, chunkIndex: 0 }),
      });
      invalidateCompiledForIds(model, [victimId]);

      expect(jointPackedForChunk(oldRecord)).toBeUndefined();
      expect(jointPackedForChunk(model.objects[victimId]!)).toBeUndefined();
      for (const id of model.order.filter((id) => id !== victimId)) {
        expect(jointPackedForChunk(model.objects[id]!)).toBeUndefined();
      }
      expect(
        logicalGeometryGeneration(model, 'RETAIN-REPLACE'),
      ).toBeGreaterThan(0);
    },
  );
});

describe('model-scoped generations and logical queue grouping', () => {
  it('identical ids and logical ids remain isolated across two models', async () => {
    const modelA = chunkedLogicalModel(12000, 'SAME');
    const modelB = chunkedLogicalModel(12000, 'SAME');
    warmAll(modelA);
    warmAll(modelB);
    captureGeometryOwnershipForIds(modelA, [modelA.order[0]!]);
    invalidateCompiledForIds(modelA, [modelA.order[0]!]);
    expect(logicalGeometryGeneration(modelA, 'SAME')).toBe(1);
    expect(logicalGeometryGeneration(modelB, 'SAME')).toBe(0);
    expect(recordGeometryGeneration(modelB, 'SAME')).toBe(0);

    // Re-warm A after its deliberate invalidation, then queue both models
    // together through the globally shared lane.
    warmAll(modelA);
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
            },
          }),
        );
      },
    };
    setBackgroundPackWorkerFactory(() => worker);
    scheduleBackgroundPackForRecords(
      modelA.order.map((id) => modelA.objects[id]!),
      modelA,
    );
    scheduleBackgroundPackForRecords(
      modelB.order.map((id) => modelB.objects[id]!),
      modelB,
    );
    await flushBackgroundPackQueueForTests(100);

    expect(requests).toHaveLength(2);
    const jointA = jointPackedForChunk(modelA.objects[modelA.order[0]!]!);
    const jointB = jointPackedForChunk(modelB.objects[modelB.order[0]!]!);
    expect(jointA).toBeDefined();
    expect(jointB).toBeDefined();
    expect(jointA).not.toBe(jointB);
  }, 15_000);
});
