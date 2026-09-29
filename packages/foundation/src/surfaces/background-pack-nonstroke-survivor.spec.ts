/**
 * Same-id non-stroke replacement survivor.
 *
 * L=A+B+C with a retained joint; replacing B under the SAME id with a
 * non-stroke record (rectangle/text) must still publish `l:L` so the
 * surviving A+C re-pack, while emitting no record/stroke key for the
 * replacement itself. The replacement is never an Ink background-pack unit.
 *
 * Both rectangle and text exercise the same guard (`record.type !== stroke`
 * in `backgroundPackRendezvousKeysForIds` / `resolvePreparedBackgroundPackUnit`);
 * text is included as a second non-stroke shape to lock the shared path.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  backgroundPackRendezvousKeysForIds,
  boundedFrame,
  captureGeometryOwnershipForIds,
  emptySurface,
  flushBackgroundPackQueueForTests,
  inkStrokeObject,
  invalidateCompiledForIds,
  jointPackedForChunk,
  rectangleObject,
  resetBackgroundPackForTests,
  resetGeometryGenerationsForTests,
  resolvePreparedBackgroundPackUnit,
  resolvePreparedBackgroundPackUnitForLogical,
  scheduleBackgroundPackForPreparedUnit,
  scheduleBackgroundPackForRecords,
  setBackgroundPackWorkerFactory,
  textObject,
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

function threeChunkModel(logicalId: string): SurfaceModel {
  const model = emptySurface(boundedFrame(60000, 6000));
  addChunk(model, `${logicalId}-A`, logicalId, 0, 0);
  addChunk(model, `${logicalId}-B`, logicalId, 1, 2000);
  addChunk(model, `${logicalId}-C`, logicalId, 2, 4000);
  return model;
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
  for (const id of model.order) {
    expect(jointPackedForChunk(model.objects[id]!)).toBe(joint);
  }
  return joint;
}

function replaceWithRectangle(model: SurfaceModel, id: string): void {
  captureGeometryOwnershipForIds(model, [id]);
  model.objects[id] = rectangleObject(id, {
    x: 10,
    y: 10,
    width: 100,
    height: 50,
  });
  invalidateCompiledForIds(model, [id]);
}

function replaceWithText(model: SurfaceModel, id: string): void {
  captureGeometryOwnershipForIds(model, [id]);
  model.objects[id] = textObject(id, { x: 10, y: 10, text: 'replacement' });
  invalidateCompiledForIds(model, [id]);
}

beforeEach(() => {
  resetBackgroundPackForTests();
  resetGeometryGenerationsForTests();
});

describe('same-id non-stroke replacement still publishes the old logical survivor', () => {
  it('rectangle replacement of middle B → l:L survivor, no record key, A+C re-retain fresh joint', async () => {
    const { worker, requests } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = threeChunkModel('LNS');
    const oldJoint = await retainJointViaPrepared(model, 'LNS-A');
    const requestCountAfterRetain = requests.length;

    replaceWithRectangle(model, 'LNS-B');

    // Old joint cleared from the survivors through the membership index.
    expect(jointPackedForChunk(model.objects['LNS-A']!)).toBeUndefined();
    expect(jointPackedForChunk(model.objects['LNS-C']!)).toBeUndefined();

    // Rendezvous names ONLY the surviving old logical — never the rectangle.
    const keys = backgroundPackRendezvousKeysForIds(model, ['LNS-B']);
    expect(keys).toContain('l:LNS');
    expect(keys).not.toContain('r:LNS-B');
    expect(keys).toEqual(['l:LNS']);

    // The rectangle itself is never an Ink background-pack unit.
    expect(resolvePreparedBackgroundPackUnit(model, 'LNS-B')).toBeNull();
    expect(jointPackedForChunk(model.objects['LNS-B']!)).toBeUndefined();

    // Surviving A+C resolve and re-retain one fresh shared joint.
    const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'LNS');
    expect(survivor?.kind).toBe('logical');
    if (survivor?.kind !== 'logical') throw new Error('expected survivor');
    expect(survivor.records.map((r) => r.id).sort()).toEqual([
      'LNS-A',
      'LNS-C',
    ]);
    expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
    await flushBackgroundPackQueueForTests(200);
    const fresh = jointPackedForChunk(model.objects['LNS-A']!);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(oldJoint);
    expect(jointPackedForChunk(model.objects['LNS-C']!)).toBe(fresh);

    // The rectangle never produced a Worker job of its own: only the
    // survivor re-pack ran after the retain.
    expect(requests.length - requestCountAfterRetain).toBe(1);
    expect(requests[requests.length - 1]!.objectId).toBe('LNS');

    // Belt-and-braces: pushing the rectangle through the ordinary record
    // lane schedules nothing.
    const before = requests.length;
    scheduleBackgroundPackForRecords([model.objects['LNS-B']!], model);
    await flushBackgroundPackQueueForTests(100);
    expect(requests.length).toBe(before);
    setBackgroundPackWorkerFactory(null);
  });

  it('text replacement of middle B → same l:L survivor, no record key (shared non-stroke path)', async () => {
    const { worker } = recordingWorker();
    setBackgroundPackWorkerFactory(() => worker);
    const model = threeChunkModel('LNT');
    const oldJoint = await retainJointViaPrepared(model, 'LNT-A');

    replaceWithText(model, 'LNT-B');

    expect(jointPackedForChunk(model.objects['LNT-A']!)).toBeUndefined();
    expect(jointPackedForChunk(model.objects['LNT-C']!)).toBeUndefined();

    // Same shared `record.type !== stroke` guard as rectangle: old logical
    // first, no current-unit key.
    const keys = backgroundPackRendezvousKeysForIds(model, ['LNT-B']);
    expect(keys).toContain('l:LNT');
    expect(keys).not.toContain('r:LNT-B');
    expect(keys).toEqual(['l:LNT']);

    expect(resolvePreparedBackgroundPackUnit(model, 'LNT-B')).toBeNull();

    const survivor = resolvePreparedBackgroundPackUnitForLogical(model, 'LNT');
    expect(survivor?.kind).toBe('logical');
    if (survivor?.kind !== 'logical') throw new Error('expected survivor');
    expect(survivor.records.map((r) => r.id).sort()).toEqual([
      'LNT-A',
      'LNT-C',
    ]);
    expect(scheduleBackgroundPackForPreparedUnit(survivor, model)).toBe(true);
    await flushBackgroundPackQueueForTests(200);
    const fresh = jointPackedForChunk(model.objects['LNT-A']!);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(oldJoint);
    expect(jointPackedForChunk(model.objects['LNT-C']!)).toBe(fresh);
    setBackgroundPackWorkerFactory(null);
  });

  it('non-stroke survivor rendezvous touches only mutated ids (no document scan)', () => {
    const base = threeChunkModel('LNX');
    let keyEnumerations = 0;
    const objects = new Proxy(base.objects, {
      ownKeys(target) {
        keyEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const proxied: SurfaceModel = { ...base, objects };

    // Seed the membership index at the pre-mutation boundary (one deliberate
    // enumeration is allowed there), then measure the mutation + rendezvous.
    captureGeometryOwnershipForIds(proxied, ['LNX-B']);
    replaceWithRectangle(proxied, 'LNX-B');
    keyEnumerations = 0;
    const keys = backgroundPackRendezvousKeysForIds(proxied, ['LNX-B']);
    expect(keys).toEqual(['l:LNX']);
    expect(keyEnumerations).toBe(0);
  });
});
