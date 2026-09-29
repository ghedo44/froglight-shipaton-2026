import { describe, expect, it, vi } from 'vitest';
import { createTestErasurePreparation } from '@froglight/foundation/testing';
import {
  InkToolController,
  InkPresetStore,
  SURFACE_TOOL_IDS,
  createDefaultSurfaceObjectTypeRegistry,
  createDefaultSurfaceToolRegistry,
  emptySurface,
  infiniteFrame,
  inkStrokeObject,
  encodeSurfacePayload,
  decodeSurfacePayload,
  inkRegion,
  SurfaceDeltaCollector,
  applySurfaceDocumentDelta,
  surfaceCheckpointUnits,
  restoreSurfaceCheckpoint,
  SurfaceDurabilityValidator,
  drainSurfaceDocumentWork,
  type SurfaceModel,
  type ErasurePreparation,
} from '@froglight/foundation';
import { SurfaceGestureHistory } from './history.js';

function fixture(
  lane: ErasurePreparation = createTestErasurePreparation(),
  failPublication?: () => boolean,
) {
  const timings = { historyMs: 0, publicationMs: 0, deltaMs: 0 };
  const model = emptySurface(infiniteFrame());
  model.objects.s = inkStrokeObject('s', {
    points: Array.from({ length: 1000 }, (_, x) => ({
      x,
      y: 50,
      pressure: 0.6,
      dt: x,
    })),
    width: 8,
    color: '#abc',
  });
  model.order.push('s');
  const initial = encodeSurfacePayload(model);
  const collector = new SurfaceDeltaCollector(model, false);
  const registry = createDefaultSurfaceObjectTypeRegistry();
  const history = new SurfaceGestureHistory(model, registry);
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 8 });
  const controller = new InkToolController({
    model,
    objectRegistry: registry,
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    erasurePreparation: lane,
    onBeforeMutate: (ids) => history.recordBeforeMany(ids),
    onGestureStart: () => history.beginGesture(),
    onGestureEnd: () => {
      const start = performance.now();
      history.commitGesture();
      timings.historyMs += performance.now() - start;
    },
    onGestureCancel: () => history.cancelGesture(),
    onErasureRefinement: (refinement, publish) => {
      if (failPublication?.()) {
        publish();
        throw new Error('injected publication failure');
      }
      const start = performance.now();
      history.refineErasure(refinement, () => {
        const start = performance.now();
        publish();
        timings.publicationMs += performance.now() - start;
      });
      timings.historyMs += performance.now() - start;
    },
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  const cut = (x: number) => {
    controller.pointerDown({ point: { x, y: 30 } });
    controller.pointerMove({ point: { x, y: 70 } });
    controller.pointerUp({ point: { x, y: 70 } });
  };
  const undo = async () => {
    expect(history.undo()).toBe(true);
    controller.notifyExternalMutation(history.lastChangeIds());
    controller.retryErasure();
    await controller.drainErasure();
  };
  const redo = async () => {
    expect(history.redo()).toBe(true);
    controller.notifyExternalMutation(history.lastChangeIds());
    controller.retryErasure();
    await controller.drainErasure();
  };
  const finish = () => {
    controller.destroy();
    history.dispose();
    collector.dispose();
  };
  return {
    model,
    initial,
    collector,
    controller,
    history,
    presets,
    cut,
    undo,
    redo,
    finish,
    timings,
  };
}
function samples(model: SurfaceModel): number {
  return Object.values(model.objects).reduce(
    (n, r) =>
      n +
      (Array.isArray(r.points) ? r.points.length : 0) +
      (Array.isArray(r.chunks)
        ? r.chunks.reduce(
            (n, c) => n + (c as { points: unknown[] }).points.length,
            0,
          )
        : 0),
    0,
  );
}

describe('precision transactions through production controller, history and delta seams', () => {
  it('repeated cuts share samples, compact boundaries, undo/redo and cold journal recovery', async () => {
    const f = fixture();
    let mirror = decodeSurfacePayload(f.initial).model;
    const validator = new SurfaceDurabilityValidator();
    let payloadBytes = 0;
    for (const x of [200, 400, 600, 800, 100, 300]) {
      f.cut(x);
      await f.controller.drainErasure();
      expect(samples(f.model)).toBe(1000);
      const deltaStart = performance.now();
      const delta = f.collector.take();
      f.timings.deltaMs += performance.now() - deltaStart;
      payloadBytes += JSON.stringify(delta).length;
      const candidate = applySurfaceDocumentDelta(
        mirror,
        delta,
        false,
      ) as SurfaceModel;
      validator.validate(candidate, delta, false);
      mirror = candidate;
      expect(decodeSurfacePayload(encodeSurfacePayload(mirror)).model).toEqual(
        decodeSurfacePayload(encodeSurfacePayload(f.model)).model,
      );
    }
    expect(f.model.order).toHaveLength(7);
    expect(f.history.historyStats().entries).toBe(6);
    expect(f.history.historyStats().retainedBytes).toBeLessThan(1024 * 1024);
    const fragments = f.model.order.map((id) => f.model.objects[id]!);
    const ownedVertices = fragments.reduce(
      (n, r) =>
        n +
        (r.visible as import('@froglight/foundation').InkVisibleRegion).reduce(
          (n, p) =>
            n +
            p.reduce(
              (n, r) => n + r.filter((token) => !Array.isArray(token)).length,
              0,
            ),
          0,
        ),
      0,
    );
    expect(ownedVertices).toBeLessThan(600);
    console.info(
      JSON.stringify({
        sourceSamples: samples(f.model),
        fragments: fragments.length,
        ownedVertices,
        encodedBytes: encodeSurfacePayload(f.model).byteLength,
        payloadBytes,
        history: f.history.historyStats(),
        phases: {
          ...f.timings,
          historyExclusiveMs: f.timings.historyMs - f.timings.publicationMs,
        },
      }),
    );
    const after = encodeSurfacePayload(f.model);
    expect(after.byteLength).toBeLessThan(f.initial.byteLength * 2);
    expect(payloadBytes).toBeLessThan(f.initial.byteLength * 2);
    const checkpoint = restoreSurfaceCheckpoint(
      new Map(
        [...surfaceCheckpointUnits(mirror, false)].map(([k, v]) => [
          k,
          JSON.parse(JSON.stringify(v)),
        ]),
      ),
      false,
    ) as SurfaceModel;
    expect(
      decodeSurfacePayload(encodeSurfacePayload(checkpoint)).model,
    ).toEqual(decodeSurfacePayload(after).model);
    await f.undo();
    expect(
      Object.values(f.collector.take().surfaces[0]!.objects).some(
        (record) => record?.type === 'froglight.ink.source',
      ),
    ).toBe(false);
    await f.redo();
    expect(decodeSurfacePayload(encodeSurfacePayload(f.model)).model).toEqual(
      decodeSurfacePayload(after).model,
    );
    const sibling = f.model.objects[f.model.order[1]!]!;
    const before = JSON.stringify(sibling);
    f.controller.setSelection(['s']);
    f.controller.moveSelectionBy({ x: 0, y: 100 });
    expect(JSON.stringify(sibling)).toBe(before);
    expect(
      inkRegion(f.model.objects.s!)!
        .flat(2)
        .some((p) => p.y > 100),
    ).toBe(true);
    f.finish();
  });
  it('a pen gesture and a second erase are accepted before preparation resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = createTestErasurePreparation();
    const f = fixture({
      ...base,
      finish: async (job) => {
        await gate;
        return base.finish(job);
      },
    });
    f.cut(300);
    f.cut(700);
    f.controller.setTool(SURFACE_TOOL_IDS.pen);
    f.controller.pointerDown({ point: { x: 10, y: 150 } });
    f.controller.pointerMove({ point: { x: 90, y: 150 } });
    f.controller.pointerUp({ point: { x: 90, y: 150 } });
    expect(f.history.historyStats().entries).toBe(3);
    release();
    await f.controller.drainErasure();
    expect(f.model.order).toHaveLength(4);
    const after = encodeSurfacePayload(f.model);
    await f.undo();
    expect(f.model.order).toHaveLength(3);
    await f.undo();
    expect(f.model.order).toHaveLength(2);
    await f.undo();
    expect(encodeSurfacePayload(f.model)).toEqual(f.initial);
    await f.redo();
    await f.redo();
    await f.redo();
    expect(decodeSurfacePayload(encodeSurfacePayload(f.model)).model).toEqual(
      decodeSurfacePayload(after).model,
    );
    f.finish();
  });
  it('undo of a pending operation cannot be resurrected by its old result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = createTestErasurePreparation();
    const f = fixture({
      ...base,
      finish: async (job) => {
        await gate;
        return base.finish(job);
      },
    });
    f.cut(500);
    expect(f.history.undo()).toBe(true);
    release();
    await f.controller.drainErasure();
    expect(encodeSurfacePayload(f.model)).toEqual(f.initial);
    expect(f.history.redo()).toBe(true);
    f.controller.notifyExternalMutation(f.history.lastChangeIds());
    expect(f.model.order).toHaveLength(2);
    expect(samples(f.model)).toBe(1000);
    f.finish();
  });
  it('preparation failure keeps the erased draft and can retry without duplicating a transaction', async () => {
    const base = createTestErasurePreparation();
    let fail = true;
    const f = fixture({
      ...base,
      finish: (job) =>
        fail
          ? Promise.reject(new Error('injected preparation failure'))
          : base.finish(job),
    });
    f.cut(500);
    await expect(f.controller.drainErasure()).rejects.toThrow('injected');
    expect(f.model.objects.s!.region).toBeDefined();
    expect(f.history.historyStats().entries).toBe(1);
    fail = false;
    f.controller.retryErasure();
    await f.controller.drainErasure();
    expect(f.model.order).toHaveLength(2);
    expect(f.history.historyStats().entries).toBe(1);
    f.controller.retryErasure();
    await f.controller.drainErasure();
    expect(f.model.order).toHaveLength(2);
    await f.undo();
    expect(encodeSurfacePayload(f.model)).toEqual(f.initial);
    f.finish();
  });
  it('publication failure rolls back every candidate and retry reuses component identities', async () => {
    let fail = true;
    const f = fixture(createTestErasurePreparation(), () => fail);
    f.cut(500);
    await expect(f.controller.drainErasure()).rejects.toThrow('publication');
    expect(f.model.order).toEqual(['s']);
    expect(f.model.objects.s!.region).toBeDefined();
    expect(
      Object.values(f.model.objects).filter(
        (r) => r.type === 'froglight.ink.stroke',
      ),
    ).toHaveLength(1);
    fail = false;
    f.controller.retryErasure();
    await f.controller.drainErasure();
    expect(f.model.order).toHaveLength(2);
    expect(f.history.historyStats().entries).toBe(1);
    await f.undo();
    expect(encodeSurfacePayload(f.model)).toEqual(f.initial);
    f.finish();
  });
  it('release submits an identity without cloning a source or preparing polygons synchronously', async () => {
    const base = createTestErasurePreparation();
    const finish = vi.fn(base.finish);
    const f = fixture({ ...base, finish });
    f.controller.pointerDown({ point: { x: 500, y: 30 } });
    f.controller.pointerMove({ point: { x: 500, y: 70 } });
    const stringify = vi.spyOn(JSON, 'stringify');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    f.controller.pointerUp({ point: { x: 500, y: 70 } });
    expect(finish).toHaveBeenCalledExactlyOnceWith(1);
    for (const [value] of [...stringify.mock.calls, ...clone.mock.calls])
      expect(
        value &&
          typeof value === 'object' &&
          ('points' in value || 'chunks' in value),
      ).toBe(false);
    expect(f.model.order).toEqual(['s']);
    stringify.mockRestore();
    clone.mockRestore();
    await f.controller.drainErasure();
    expect(f.model.order).toHaveLength(2);
    f.finish();
  });
  it('switching tools during contact rolls back the draft and releases save ownership', async () => {
    const base = createTestErasurePreparation(),
      finish = vi.fn(base.finish);
    const f = fixture({ ...base, finish });
    f.controller.pointerDown({ point: { x: 500, y: 30 } });
    f.controller.pointerMove({ point: { x: 500, y: 70 } });
    f.controller.setTool(SURFACE_TOOL_IDS.pen);
    await drainSurfaceDocumentWork(f.model);
    expect(finish).not.toHaveBeenCalled();
    expect(encodeSurfacePayload(f.model)).toEqual(f.initial);
    expect(f.history.historyStats().entries).toBe(0);
    f.controller.setTool(SURFACE_TOOL_IDS.eraser);
    f.cut(500);
    await f.controller.drainErasure();
    expect(f.model.order).toHaveLength(2);
    f.finish();
  });
  it('temporary eraser auto-return keeps the accepted gesture and its one undo step', async () => {
    const f = fixture();
    f.presets.setEraser({ mode: 'precision', radius: 8, autoReturn: true });
    f.controller.setTool(SURFACE_TOOL_IDS.pen);
    f.controller.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    f.cut(500);
    await f.controller.drainErasure();
    expect(f.controller.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
    expect(f.model.order).toHaveLength(2);
    expect(f.history.historyStats().entries).toBe(1);
    await f.undo();
    expect(encodeSurfacePayload(f.model)).toEqual(f.initial);
    f.finish();
  });
  it('cancellation closes ownership and restores prior content without preparing components', async () => {
    const base = createTestErasurePreparation(),
      finish = vi.fn(base.finish);
    const f = fixture({ ...base, finish });
    f.controller.pointerDown({ point: { x: 500, y: 30 } });
    f.controller.pointerMove({ point: { x: 500, y: 70 } });
    f.controller.pointerCancel();
    expect(finish).not.toHaveBeenCalled();
    expect(encodeSurfacePayload(f.model)).toEqual(f.initial);
    expect(f.history.historyStats().entries).toBe(0);
    f.cut(500);
    await f.controller.drainErasure();
    expect(f.model.order).toHaveLength(2);
    f.finish();
  });
});

it('pending component preparation reconciles later group edits through undo and redo', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = createTestErasurePreparation(),
    f = fixture({
      ...base,
      finish: async (job) => {
        await gate;
        return base.finish(job);
      },
    });
  f.model.objects.g = { id: 'g', type: 'froglight.group', children: ['s'] };
  f.model.order.push('g');
  f.controller.notifyExternalMutation(['g']);
  const initial = encodeSurfacePayload(f.model);
  f.cut(500);
  f.history.beginGesture();
  f.history.recordBeforeMany(['extra', 'g']);
  f.model.objects.extra = inkStrokeObject('extra', {
    points: [
      { x: 0, y: 200 },
      { x: 100, y: 200 },
    ],
    width: 3,
  });
  f.model.order.push('extra');
  f.model.objects.g = { ...f.model.objects.g!, children: ['s', 'extra'] };
  f.controller.notifyExternalMutation(['extra', 'g']);
  f.history.commitGesture();
  release();
  await f.controller.drainErasure();
  const fragments = f.model.order.filter((id) => id !== 'g' && id !== 'extra');
  expect(fragments).toHaveLength(2);
  expect(f.model.objects.g!.children).toEqual([...fragments, 'extra']);
  await f.undo();
  expect(f.model.objects.g!.children).toEqual(fragments);
  await f.undo();
  expect(encodeSurfacePayload(f.model)).toEqual(initial);
  await f.redo();
  expect(f.model.objects.g!.children).toEqual(fragments);
  await f.redo();
  expect(f.model.objects.g!.children).toEqual([...fragments, 'extra']);
  f.finish();
});

it('disposing the view retains an accepted job until document-owned preparation settles', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = createTestErasurePreparation(),
    dispose = vi.fn(base.dispose);
  const f = fixture({
    ...base,
    dispose,
    finish: async (job) => {
      await gate;
      return base.finish(job);
    },
  });
  f.cut(500);
  f.controller.destroy();
  expect(dispose).not.toHaveBeenCalled();
  release();
  await f.controller.drainErasure();
  await Promise.resolve();
  expect(f.model.order).toHaveLength(2);
  expect(() => encodeSurfacePayload(f.model)).not.toThrow();
  expect(dispose).toHaveBeenCalled();
  f.history.dispose();
  f.collector.dispose();
});
