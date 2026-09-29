/**
 * Surviving-logical background retention.
 *
 * Deleting a member of L=A+B+C must clear the old joint but still let the
 * surviving A+C re-queue as ONE logical unit (the directly mutated id B no
 * longer exists, so the rendezvous must represent the affected logical unit
 * itself, not just the deleted record). Same for head deletion and L→single
 * / L→M replacement. Uses the normal destructive mutation path
 * (capture → delete/replace → invalidate) and verifies retained packed
 * objects, not just queue counters.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  backgroundPackRendezvousKeysForIds,
  backgroundPackStats,
  boundedFrame,
  captureGeometryOwnershipForIds,
  compiledStrokeForRecord,
  emptySurface,
  flushBackgroundPackQueueForTests,
  inkStrokeObject,
  invalidateCompiledForIds,
  jointPackedForChunk,
  logicalGeometryGeneration,
  resetBackgroundPackForTests,
  resetGeometryGenerationsForTests,
  resolvePreparedBackgroundPackUnit,
  resolvePreparedBackgroundPackUnitForLogical,
  scheduleBackgroundPackForPreparedUnit,
  scheduleBackgroundPackForRecords,
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

function threeChunkModel(logicalId = 'L'): SurfaceModel {
  const model = emptySurface(boundedFrame(60000, 6000));
  addChunk(model, `${logicalId}-A`, logicalId, 0, 0);
  addChunk(model, `${logicalId}-B`, logicalId, 1, 2000);
  addChunk(model, `${logicalId}-C`, logicalId, 2, 4000);
  return model;
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
  for (const id of model.order) {
    expect(jointPackedForChunk(model.objects[id]!)).toBe(joint);
  }
  return joint;
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

describe('member deletion re-retains the surviving logical', () => {
  it('delete middle B → old joint cleared → A+C receive one fresh shared joint', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = threeChunkModel('L');
    const oldJoint = await retainJointViaPrepared(model, 'L-A');

    const doomedId = 'L-B';
    // The rendezvous key for the deleted id must name the surviving logical.
    const keysBefore = backgroundPackRendezvousKeysForIds(model, [doomedId]);
    expect(keysBefore).toContain('l:L');
    deleteRecord(model, doomedId);

    expect(logicalGeometryGeneration(model, 'L')).toBeGreaterThan(0);
    expect(jointPackedForChunk(model.objects['L-A']!)).toBeUndefined();
    expect(jointPackedForChunk(model.objects['L-C']!)).toBeUndefined();
    // Deleted-id keys still resolve to the survivor after deletion.
    expect(backgroundPackRendezvousKeysForIds(model, [doomedId])).toContain(
      'l:L',
    );

    // Scene prepares surviving A+C → background re-queues L.
    const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'L');
    expect(survivor?.kind).toBe('logical');
    if (survivor?.kind !== 'logical') throw new Error('expected survivor');
    expect(survivor.records.map((r) => r.id).sort()).toEqual(['L-A', 'L-C']);
    expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
    await flushBackgroundPackQueueForTests(200);
    const fresh = jointPackedForChunk(model.objects['L-A']!);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(oldJoint);
    expect(jointPackedForChunk(model.objects['L-C']!)).toBe(fresh);
    expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    setBackgroundPackWorkerFactory(null);
  });

  it('delete head A → surviving B+C receive one fresh shared joint', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = threeChunkModel('LHEAD');
    const oldJoint = await retainJointViaPrepared(model, 'LHEAD-A');

    deleteRecord(model, 'LHEAD-A');
    expect(jointPackedForChunk(model.objects['LHEAD-B']!)).toBeUndefined();
    expect(jointPackedForChunk(model.objects['LHEAD-C']!)).toBeUndefined();

    const survivor = resolvePreparedBackgroundPackUnitForLogical(
      model,
      'LHEAD',
    );
    if (survivor?.kind !== 'logical') throw new Error('expected survivor');
    expect(survivor.records.map((r) => r.id).sort()).toEqual([
      'LHEAD-B',
      'LHEAD-C',
    ]);
    expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
    await flushBackgroundPackQueueForTests(200);
    const fresh = jointPackedForChunk(model.objects['LHEAD-B']!);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(oldJoint);
    expect(jointPackedForChunk(model.objects['LHEAD-C']!)).toBe(fresh);
    setBackgroundPackWorkerFactory(null);
  });
});

describe('replacement re-retains surviving and new units', () => {
  it('L → single: surviving A+C re-retain and the new single packs', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = threeChunkModel('LRS');
    await retainJointViaPrepared(model, 'LRS-A');

    // Replace middle chunk with a single stroke under the SAME id.
    const victimId = 'LRS-B';
    const oldPoints = (
      model.objects[victimId] as unknown as {
        points: { x: number; y: number; pressure: number; dt: number }[];
      }
    ).points;
    captureGeometryOwnershipForIds(model, [victimId]);
    model.objects[victimId] = inkStrokeObject(victimId, {
      points: oldPoints.map((p) => ({ ...p, y: p.y + 500 })),
      width: 3,
    });
    invalidateCompiledForIds(model, [victimId]);

    // Rendezvous keys name BOTH the old survivor and the new single.
    const keys = backgroundPackRendezvousKeysForIds(model, [victimId]);
    expect(keys).toContain('l:LRS');
    expect(keys).toContain(`r:${victimId}`);

    // Surviving logical A+C re-retains a fresh joint.
    const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'LRS');
    if (survivor?.kind !== 'logical') throw new Error('expected survivor');
    expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
    // New single needs rich warmth for the ordinary record path.
    const single = model.objects[victimId]!;
    expect(compiledStrokeForRecord(single)).not.toBeNull();
    scheduleBackgroundPackForRecords([single], model);
    await flushBackgroundPackQueueForTests(300);
    const freshLogical = jointPackedForChunk(model.objects['LRS-A']!);
    expect(freshLogical).toBeDefined();
    expect(jointPackedForChunk(model.objects['LRS-C']!)).toBe(freshLogical);
    // Single retention is per-record packed (logical joint must not leak).
    const { packedCompiledForRecord } = await import('./index.js');
    expect(packedCompiledForRecord(single)).toBeDefined();
    expect(jointPackedForChunk(single)).toBeUndefined();
    setBackgroundPackWorkerFactory(null);
  });

  it('L → M: old L survivors and new M both become retained', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = threeChunkModel('LRM');
    await retainJointViaPrepared(model, 'LRM-A');

    const victimId = 'LRM-B';
    const oldPoints = (
      model.objects[victimId] as unknown as {
        points: { x: number; y: number; pressure: number; dt: number }[];
      }
    ).points;
    captureGeometryOwnershipForIds(model, [victimId]);
    model.objects[victimId] = inkStrokeObject(victimId, {
      points: oldPoints.map((p) => ({ ...p, x: p.x + 1000 })),
      width: 3,
      logicalId: 'M',
      chunkIndex: 0,
    });
    invalidateCompiledForIds(model, [victimId]);

    const keys = backgroundPackRendezvousKeysForIds(model, [victimId]);
    expect(keys).toContain('l:LRM');
    expect(keys).toContain('l:M');

    const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'LRM');
    if (survivor?.kind !== 'logical') throw new Error('expected L survivor');
    expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
    const moved = resolvePreparedBackgroundPackUnitForLogical(model, 'M');
    if (moved?.kind !== 'logical') throw new Error('expected M unit');
    expect(scheduleBackgroundPackForPreparedUnit(moved, model)).toBe(true);
    await flushBackgroundPackQueueForTests(300);
    const freshL = jointPackedForChunk(model.objects['LRM-A']!);
    expect(freshL).toBeDefined();
    expect(jointPackedForChunk(model.objects['LRM-C']!)).toBe(freshL);
    const freshM = jointPackedForChunk(model.objects[victimId]!);
    expect(freshM).toBeDefined();
    expect(freshM).not.toBe(freshL);
    setBackgroundPackWorkerFactory(null);
  });
});
