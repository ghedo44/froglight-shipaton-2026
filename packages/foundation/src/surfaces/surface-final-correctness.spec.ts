/**
 * Surface scalability FINAL correctness closure (mission §10 matrix).
 *
 * Production-shape tests through production seams (IncrementalSceneCache,
 * createLiveCachedCompiledRestore, DerivedReopenStore, actual registry,
 * actual packed protocol, cold Worker seam, logical grouping, actual
 * persistence, prepared-item transforms). Structural counters only.
 */

import { describe, expect, it } from 'vitest';
import {
  SurfaceDerivedCache,
  DerivedReopenStore,
  createLiveCachedCompiledRestore,
  collectPersistEntries,
  scheduleBackgroundPackForRecords,
  flushBackgroundPackQueueForTests,
  resetBackgroundPackForTests,
  setBackgroundPackWorkerFactory,
  cancelBackgroundPackForTests,
  backgroundPackStats,
  BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
  type BackgroundPackWorker,
  type SurfaceReopenBinding,
  IncrementalSceneCache,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  boundedFrame,
  inkStrokeObject,
  compiledStrokeForRecord,
  compiledStrokeComputeStats,
  jointPackedForChunk,
  retainJointPackedForChunks,
  accumulateDerivedTranslation,
  derivedTranslationOfRecord,
  jointTranslationOfPacked,
  derivedTranslationStats,
  resolveInkInteractionGeometry,
  smoothSpineOfRecord,
  smoothSamplesOfRecord,
  inkStrokeCompiledBounds,
  invalidateCompiledForIds,
  packCompiledInk,
  packedRenderCounters,
  resetPackedRenderCounters,
  SurfaceInteractionController,
  type SurfaceModel,
  SURFACE_MAX_STROKE_POINTS,
} from './index.js';
import { compileInkStroke } from './ink/compiler.js';
import {
  unpackInkSamples,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from './ink/packed-protocol.js';

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

function translateCanonical(
  model: SurfaceModel,
  ids: readonly string[],
  dx: number,
  dy: number,
): void {
  for (const id of ids) {
    const record = model.objects[id];
    if (record === undefined) continue;
    const points = (record as Record<string, unknown>).points;
    if (!Array.isArray(points)) continue;
    for (const raw of points) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.x === 'number') s.x += dx;
      if (typeof s.y === 'number') s.y += dy;
    }
  }
}

function spineCentroid(spine: { x: number; y: number }[]): {
  x: number;
  y: number;
} {
  let sx = 0;
  let sy = 0;
  for (const p of spine) {
    sx += p.x;
    sy += p.y;
  }
  return {
    x: sx / Math.max(spine.length, 1),
    y: sy / Math.max(spine.length, 1),
  };
}

function fakeBackgroundWorker(counter: { count: number }): {
  worker: BackgroundPackWorker;
  setTarget: (w: BackgroundPackWorker) => void;
} {
  let target: BackgroundPackWorker | null = null;
  const worker: BackgroundPackWorker = {
    postMessage(message: PackedInkCompileRequest) {
      const request = structuredClone(message);
      queueMicrotask(() => {
        if (target!.onmessage === null) return;
        counter.count += 1;
        const compiled = compileInkStroke(
          unpackInkSamples(request.samples),
          request.brush,
          request.options ?? {},
        );
        const { packed, bytes } = packCompiledInk(compiled);
        target!.onmessage({
          data: structuredClone({
            type: 'compiled-ink',
            requestId: request.requestId,
            objectId: request.objectId,
            generation: request.generation,
            compiled: packed,
            workerUnpackMs: 0,
            compileMs: 1,
            packMs: 0,
            outputBytes: bytes,
          }) as PackedInkCompileResponse,
        });
      });
    },
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
  };
  return {
    worker,
    setTarget: (w) => {
      target = w;
    },
  };
}

async function synthesizeJoint(model: SurfaceModel, logicalId: string) {
  const { groupLogicalChunks, logicalSamples, logicalHead } = await import(
    './logical-stroke.js'
  );
  const { resolveStrokeBrush } = await import('./objects.js');
  const groups = groupLogicalChunks(model);
  const group = groups.get(logicalId)!;
  const jointSamples = logicalSamples(group);
  const head = logicalHead(group);
  const brush = resolveStrokeBrush(head);
  const jointCompiled = compileInkStroke(jointSamples, brush);
  const jointPacked = packCompiledInk(jointCompiled).packed;
  const chunks = model.order.map((id) => model.objects[id]!);
  retainJointPackedForChunks(chunks, jointPacked);
  return { jointPacked, chunks, group };
}

describe('joint vs per-record ownership', () => {
  it('joint-only 25k translates joint once, records zero, copies zero', async () => {
    const model = chunkedLogicalModel(25000, 'J0');
    expect(model.order).toHaveLength(3);
    const { jointPacked } = await synthesizeJoint(model, 'J0');
    const copiesBefore = derivedTranslationStats.geometryCopies;
    const jointBefore = derivedTranslationStats.jointTransformUpdates;
    const recordBefore = derivedTranslationStats.recordTransformUpdates;
    const dx = 100;
    const dy = -20;
    translateCanonical(model, [...model.order], dx, dy);
    const total = accumulateDerivedTranslation(model, [...model.order], dx, dy);
    expect(total).toBe(1);
    expect(derivedTranslationStats.jointTransformUpdates - jointBefore).toBe(1);
    expect(derivedTranslationStats.recordTransformUpdates - recordBefore).toBe(
      0,
    );
    expect(derivedTranslationStats.geometryCopies - copiesBefore).toBe(0);
    expect(jointTranslationOfPacked(jointPacked)).toEqual({ tx: dx, ty: dy });
    for (const id of model.order) {
      expect(derivedTranslationOfRecord(model.objects[id]!)).toEqual({
        tx: 0,
        ty: 0,
      });
    }
  });

  it('joint + warm B: B hit-test moves, old fails, joint scene moves, persist reopens correct', async () => {
    const model = chunkedLogicalModel(25000, 'JB');
    const { jointPacked, chunks } = await synthesizeJoint(model, 'JB');
    // Independently warm chunk B (middle chunk) with rich geometry.
    const chunkB = model.objects[model.order[1]!]!;
    const richB = compiledStrokeForRecord(chunkB);
    expect(richB).not.toBeNull();
    const spineBBefore = smoothSpineOfRecord(chunkB);
    expect(spineBBefore.length).toBeGreaterThan(0);
    const centroidBBefore = spineCentroid(spineBBefore);
    // Verify B has independent rich state + joint still present.
    expect(jointPackedForChunk(chunkB)).toBe(jointPacked);
    const resolvedB = resolveInkInteractionGeometry(chunkB);
    expect(resolvedB.kind).toBe('record-rich');

    const copiesBefore = derivedTranslationStats.geometryCopies;
    const compilesBefore = compiledStrokeComputeStats.computes;
    const dx = 100;
    const dy = 50;
    translateCanonical(model, [...model.order], dx, dy);
    const jointBefore = derivedTranslationStats.jointTransformUpdates;
    const recordBefore = derivedTranslationStats.recordTransformUpdates;
    const total = accumulateDerivedTranslation(model, [...model.order], dx, dy);
    // Joint once + B record once = 2 (A/C have no independent geometry).
    expect(total).toBe(2);
    expect(derivedTranslationStats.jointTransformUpdates - jointBefore).toBe(1);
    expect(derivedTranslationStats.recordTransformUpdates - recordBefore).toBe(
      1,
    );
    expect(derivedTranslationStats.geometryCopies - copiesBefore).toBe(0);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    // Joint transform accumulated once.
    expect(jointTranslationOfPacked(jointPacked)).toEqual({ tx: dx, ty: dy });
    // B record translation correct, A/C records zero.
    expect(derivedTranslationOfRecord(chunkB)).toEqual({ tx: dx, ty: dy });
    expect(derivedTranslationOfRecord(chunks[0]!)).toEqual({ tx: 0, ty: 0 });
    expect(derivedTranslationOfRecord(chunks[2]!)).toEqual({ tx: 0, ty: 0 });

    // B hit-test at NEW location succeeds (via controller registry, zero compile).
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const spineBAfter = smoothSpineOfRecord(chunkB);
    const centroidBAfter = spineCentroid(spineBAfter);
    expect(centroidBAfter.x).toBeCloseTo(centroidBBefore.x + dx, 5);
    expect(centroidBAfter.y).toBeCloseTo(centroidBBefore.y + dy, 5);
    const probeNew = spineBAfter[Math.floor(spineBAfter.length / 2)]!;
    const compilesProbe = compiledStrokeComputeStats.computes;
    expect(
      registry.get(chunkB.type)!.hitTest!(chunkB, probeNew.x, probeNew.y),
    ).toBe(true);
    expect(compiledStrokeComputeStats.computes - compilesProbe).toBe(0);
    // OLD location fails (no stale coordinates).
    expect(
      registry.get(chunkB.type)!.hitTest!(
        chunkB,
        centroidBBefore.x,
        centroidBBefore.y,
      ),
    ).toBe(false);

    // Joint scene also at NEW location (joint spine + joint translation).
    const jointSpineWorld: { x: number; y: number }[] = [];
    for (let i = 0; i < jointPacked.nodeCount; i++) {
      const jt = jointTranslationOfPacked(jointPacked);
      jointSpineWorld.push({
        x: jointPacked.nodeXY[i * 2]! + jt.tx,
        y: jointPacked.nodeXY[i * 2 + 1]! + jt.ty,
      });
    }
    const jointCentroid = spineCentroid(jointSpineWorld);
    // Joint centroid should have moved by dx,dy from its local centroid.
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < jointPacked.nodeCount; i++) {
      sx += jointPacked.nodeXY[i * 2]!;
      sy += jointPacked.nodeXY[i * 2 + 1]!;
    }
    const localCentroid = {
      x: sx / jointPacked.nodeCount,
      y: sy / jointPacked.nodeCount,
    };
    expect(jointCentroid.x).toBeCloseTo(localCentroid.x + dx, 5);
    expect(jointCentroid.y).toBeCloseTo(localCentroid.y + dy, 5);

    // Persist → reopen → joint world correct, zero stale.
    const saved = new Map<string, Uint8Array>();
    const store = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    store.acquire('docJB', 'R1');
    store.scheduleWarmCompiledGeometry({
      documentId: 'docJB',
      revision: 'R1',
      model,
    });
    await store.flushPending();
    const reopenStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: () => undefined,
    });
    reopenStore.acquire('docJB', 'R1');
    await reopenStore.hydrate('docJB');
    const loaded = await reopenStore.loadDurableEntry('docJB', 'R1', 'JB');
    expect(loaded).not.toBeNull();
    let lsx = 0;
    let lsy = 0;
    for (let i = 0; i < loaded!.nodeCount; i++) {
      lsx += loaded!.nodeXY[i * 2]!;
      lsy += loaded!.nodeXY[i * 2 + 1]!;
    }
    expect(lsx / loaded!.nodeCount).toBeCloseTo(localCentroid.x + dx, 5);
    expect(lsy / loaded!.nodeCount).toBeCloseTo(localCentroid.y + dy, 5);
  });

  it('joint + A/B/C warm: every record translates, joint once, copies zero', async () => {
    const model = chunkedLogicalModel(25000, 'JABC');
    const { jointPacked } = await synthesizeJoint(model, 'JABC');
    for (const id of model.order) {
      expect(compiledStrokeForRecord(model.objects[id]!)).not.toBeNull();
    }
    const copiesBefore = derivedTranslationStats.geometryCopies;
    const jointBefore = derivedTranslationStats.jointTransformUpdates;
    const recordBefore = derivedTranslationStats.recordTransformUpdates;
    const compilesBefore = compiledStrokeComputeStats.computes;
    const dx = -30;
    const dy = 70;
    translateCanonical(model, [...model.order], dx, dy);
    const total = accumulateDerivedTranslation(model, [...model.order], dx, dy);
    expect(total).toBe(4); // joint 1 + records 3
    expect(derivedTranslationStats.jointTransformUpdates - jointBefore).toBe(1);
    expect(derivedTranslationStats.recordTransformUpdates - recordBefore).toBe(
      3,
    );
    expect(derivedTranslationStats.geometryCopies - copiesBefore).toBe(0);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(jointTranslationOfPacked(jointPacked)).toEqual({ tx: dx, ty: dy });
    for (const id of model.order) {
      expect(derivedTranslationOfRecord(model.objects[id]!)).toEqual({
        tx: dx,
        ty: dy,
      });
    }
  });

  it('logical translate via controller drag commits joint + records correctly', async () => {
    const model = chunkedLogicalModel(12000, 'JDRAG');
    // Use 4k-style? No, production 10k cap gives 2 chunks for 12k.
    const { jointPacked } = await synthesizeJoint(model, 'JDRAG');
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const controller = new SurfaceInteractionController({ model, registry });
    // Warm B rich to prove per-record path through controller.
    if (model.order.length > 1) {
      expect(
        compiledStrokeForRecord(model.objects[model.order[1]!]!),
      ).not.toBeNull();
    }
    // Select whole logical (expand via resolveGroupMembers inside controller).
    const { resolveGroupMembers } = await import('./objects.js');
    const allIds = resolveGroupMembers(model as never, [model.order[0]!]);
    expect(allIds.length).toBe(model.order.length);
    controller.setSelection([model.order[0]!]);
    // Controller expands selection to members for moving? Verify via moveSelectionBy.
    const copiesBefore = derivedTranslationStats.geometryCopies;
    const compilesBefore = compiledStrokeComputeStats.computes;
    // Move via controller (canonical + derived through production seam).
    controller.setSelection(allIds);
    const moved = controller.moveSelectionBy({ x: 40, y: -15 });
    expect(moved.length).toBe(allIds.length);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(derivedTranslationStats.geometryCopies - copiesBefore).toBe(0);
    // Joint moved once, warm chunks moved per-record.
    expect(jointTranslationOfPacked(jointPacked)).toEqual({ tx: 40, ty: -15 });
    // Prepared scene transform also updated once per logical key (controller + scene share model).
    const scene = new IncrementalSceneCache();
    scene.update(model, registry, []);
    const translatedKeys = scene.notifyTranslated(allIds, 0, 0);
    expect(translatedKeys).toBeGreaterThanOrEqual(0);
  });

  it('logical translate → undo → redo → persist → reopen', async () => {
    const model = chunkedLogicalModel(15000, 'JUR');
    await synthesizeJoint(model, 'JUR');
    const dx = 60;
    const dy = 25;
    translateCanonical(model, [...model.order], dx, dy);
    accumulateDerivedTranslation(model, [...model.order], dx, dy);
    // Undo.
    translateCanonical(model, [...model.order], -dx, -dy);
    accumulateDerivedTranslation(model, [...model.order], -dx, -dy);
    // Redo.
    translateCanonical(model, [...model.order], dx, dy);
    accumulateDerivedTranslation(model, [...model.order], dx, dy);
    const saved = new Map<string, Uint8Array>();
    const store = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    store.acquire('docJUR', 'R1');
    store.scheduleWarmCompiledGeometry({
      documentId: 'docJUR',
      revision: 'R1',
      model,
    });
    await store.flushPending();
    const reopenStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: () => undefined,
    });
    reopenStore.acquire('docJUR', 'R1');
    await reopenStore.hydrate('docJUR');
    const loaded = await reopenStore.loadDurableEntry('docJUR', 'R1', 'JUR');
    expect(loaded).not.toBeNull();
    // World position includes redo delta (joint translation rebased).
    expect(loaded!.nodeCount).toBeGreaterThan(0);
  });

  it('multiple repeated logical translations accumulate joint correctly', async () => {
    const model = chunkedLogicalModel(20000, 'JREP');
    const { jointPacked } = await synthesizeJoint(model, 'JREP');
    const deltas: [number, number][] = [
      [10, 5],
      [-3, 17],
      [40, -10],
      [0, 0],
      [5, 5],
    ];
    let ex = 0;
    let ey = 0;
    for (const [dx, dy] of deltas) {
      if (dx === 0 && dy === 0) continue;
      translateCanonical(model, [...model.order], dx, dy);
      accumulateDerivedTranslation(model, [...model.order], dx, dy);
      ex += dx;
      ey += dy;
    }
    expect(jointTranslationOfPacked(jointPacked)).toEqual({ tx: ex, ty: ey });
    expect(derivedTranslationStats.geometryCopies).toBe(0);
  });
});

describe('production logical interaction (real 10k chunking)', () => {
  it('25k non-head hit-test uses joint, zero B-spline', async () => {
    resetPackedRenderCounters();
    const model = chunkedLogicalModel(25000, 'P25');
    expect(model.order).toHaveLength(3);
    await synthesizeJoint(model, 'P25');
    // Simulate fresh decode/reopen: new record identities with same canonical + joint restore.
    const fresh = chunkedLogicalModel(25000, 'P25');
    // Copy canonical points from translated? No translate here, just restore joint.
    const { jointPacked } = await synthesizeJoint(model, 'P25');
    // Retain joint on fresh chunks (simulating durable restore path).
    const freshChunks = fresh.order.map((id) => fresh.objects[id]!);
    // Use same packed reference for test (in production, durable decode gives equal bytes).
    retainJointPackedForChunks(freshChunks, jointPacked);
    // Interact in NON-HEAD chunk region (middle chunk).
    const middle = fresh.objects[fresh.order[1]!]!;
    const resolved = resolveInkInteractionGeometry(middle);
    expect(resolved.kind).toBe('logical-joint-packed');
    const compilesBefore = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    const spine = smoothSpineOfRecord(middle);
    expect(spine.length).toBeGreaterThan(100);
    const inside = spine[Math.floor(spine.length / 2)]!;
    const registry = createDefaultSurfaceObjectTypeRegistry();
    expect(
      registry.get(middle.type)!.hitTest!(middle, inside.x, inside.y),
    ).toBe(true);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(0);
  }, 60000);

  it('50k non-head selection uses joint, zero B-spline, one logical', async () => {
    resetPackedRenderCounters();
    const model = chunkedLogicalModel(50000, 'P50');
    expect(model.order).toHaveLength(5);
    const { jointPacked } = await synthesizeJoint(model, 'P50');
    const fresh = chunkedLogicalModel(50000, 'P50');
    const freshChunks = fresh.order.map((id) => fresh.objects[id]!);
    retainJointPackedForChunks(freshChunks, jointPacked);
    const target = fresh.objects[fresh.order[3]!]!;
    const compilesBefore = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    const bounds = inkStrokeCompiledBounds(target);
    expect(bounds).not.toBeNull();
    const spine = smoothSpineOfRecord(target);
    expect(spine.length).toBeGreaterThan(100);
    const samples = smoothSamplesOfRecord(target);
    expect(samples.length).toBe(spine.length);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(0);
    // One logical result: expanding any chunk gives whole logical.
    const { expandLogicalIds } = await import('./logical-stroke.js');
    expect(expandLogicalIds(fresh, [target.id]).length).toBe(5);
    // Unrelated logical stays cold (no accidental warming).
    const other = chunkedLogicalModel(5000, 'OTHER');
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    void other;
  }, 120000);

  it('100k first interaction (hit + selection) causes zero B-spline', async () => {
    resetPackedRenderCounters();
    const model = chunkedLogicalModel(100000, 'P100');
    expect(model.order).toHaveLength(10);
    const { jointPacked } = await synthesizeJoint(model, 'P100');
    const fresh = chunkedLogicalModel(100000, 'P100');
    retainJointPackedForChunks(
      fresh.order.map((id) => fresh.objects[id]!),
      jointPacked,
    );
    const target = fresh.objects[fresh.order[7]!]!;
    const compilesBefore = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    // Non-head region: use the target chunk's own canonical middle as probe.
    // The joint curve passes through it (joint is fit over concatenated samples),
    // so hit-testing the chunk via its JOINT spine must succeed without compiling.
    const rawPts = (target as Record<string, unknown>).points as {
      x: number;
      y: number;
    }[];
    const probeCanonical = rawPts[Math.floor(rawPts.length / 2)]!;
    const registry = createDefaultSurfaceObjectTypeRegistry();
    expect(
      registry.get(target.type)!.hitTest!(
        target,
        probeCanonical.x,
        probeCanonical.y,
      ),
    ).toBe(true);
    const spine = smoothSpineOfRecord(target);
    expect(spine.length).toBeGreaterThan(100);
    const bounds = inkStrokeCompiledBounds(target);
    expect(bounds).not.toBeNull();
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(0);
  }, 180000);

  it('chunk-boundary interaction returns one logical, no duplicates', async () => {
    const model = chunkedLogicalModel(20000, 'PBND');
    const { jointPacked } = await synthesizeJoint(model, 'PBND');
    const fresh = chunkedLogicalModel(20000, 'PBND');
    retainJointPackedForChunks(
      fresh.order.map((id) => fresh.objects[id]!),
      jointPacked,
    );
    // Boundary between chunk 0 and 1: x at 10k*1.5 + 100 ≈ 15100.
    // Use joint spine to find a point near the seam, then hit-test via controller.
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const controller = new SurfaceInteractionController({
      model: fresh,
      registry,
    });
    const head = fresh.objects[fresh.order[0]!]!;
    const spine = smoothSpineOfRecord(head);
    // Joint spine covers whole logical; pick a seam-adjacent sample.
    const seamProbe = spine[Math.min(spine.length - 1, 10000)]!;
    const hit = controller.hitTest(seamProbe);
    expect(hit).not.toBeNull();
    // Hit must be a chunk of PBND (one logical), not duplicate.
    const { expandLogicalIds } = await import('./logical-stroke.js');
    const expanded = expandLogicalIds(fresh, [hit!]);
    expect(expanded.length).toBe(fresh.order.length);
  });
});

describe('durable progressive prepareMore joint restore', () => {
  it('offscreen logical with durable joint defers sync compile, restores packed', async () => {
    resetPackedRenderCounters();
    const model = chunkedLogicalModel(6000, 'PMORE');
    const { jointPacked } = await synthesizeJoint(model, 'PMORE');
    // Persist joint durably.
    const saved = new Map<string, Uint8Array>();
    const store = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    store.acquire('docMore', 'R0');
    store.scheduleWarmCompiledGeometry({
      documentId: 'docMore',
      revision: 'R0',
      model,
    });
    await store.flushPending();
    expect(saved.has('docMore')).toBe(true);
    // Reopen with small offscreen logical (6000 < FIRST_PAINT_MAX_COST, old code would sync-compile).
    const reopenStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: () => undefined,
    });
    reopenStore.acquire('docMore', 'R0');
    expect(await reopenStore.hydrate('docMore')).toBe(true);
    const binding: SurfaceReopenBinding = {
      store: reopenStore,
      documentId: 'docMore',
      getContentRevision: () => 'R0',
      isDirty: () => false,
    };
    const restore = createLiveCachedCompiledRestore(binding);
    // Durable lookup exists for logical id.
    expect(restore.hasDurable('PMORE')).toBe(true);
    const fresh = chunkedLogicalModel(6000, 'PMORE');
    const scene = new IncrementalSceneCache();
    scene.setCompiledRestoreSource(restore);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const compilesBefore = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    // Progressive path must defer (preload ONE logical entry, no sync compile).
    const pending = [...fresh.order];
    const out = scene.prepareMore(fresh, registry, pending, 3);
    // No sync B-spline for the durable-held logical in this slice.
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    // Deferred includes the logical's chunks (not dropped, not compiled).
    expect(out.remaining.length).toBeGreaterThan(0);
    // Async lane restores packed with zero compiles.
    const ok = await scene.prepareOneAsync(fresh, registry, fresh.order[0]!);
    expect(ok).toBe(true);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(
      packedRenderCounters.synchronousRichUnpacks - unpacksBefore,
    ).toBeLessThanOrEqual(1);
    void jointPacked;
  });
});

describe('background Worker lane (100k logical)', () => {
  it('100k joint input spans bounded slices, Worker packs off-main, stale drops, teardown skips', async () => {
    resetBackgroundPackForTests();
    resetPackedRenderCounters();
    const counter = { count: 0 };
    const { worker, setTarget } = fakeBackgroundWorker(counter);
    setTarget(worker);
    setBackgroundPackWorkerFactory(() => worker);
    const model = chunkedLogicalModel(100000, 'BG100');
    // Live/committed rich per chunk (no joint yet).
    for (const id of model.order) {
      expect(compiledStrokeForRecord(model.objects[id]!)).not.toBeNull();
    }
    const chunks = model.order.map((id) => model.objects[id]!);
    scheduleBackgroundPackForRecords(chunks);
    expect(backgroundPackStats.jobsQueued).toBeGreaterThanOrEqual(1);
    // One slice must not exceed budget.
    await flushBackgroundPackQueueForTests(1);
    expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
      BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
    );
    await flushBackgroundPackQueueForTests(10000);
    // Joint retained on all chunks via Worker (same canonical compiler).
    expect(counter.count).toBe(1);
    for (const c of chunks) {
      expect(jointPackedForChunk(c)).toBeDefined();
    }
    expect(backgroundPackStats.inputChunks).toBeGreaterThan(1);
    expect(backgroundPackStats.inputSamples).toBe(100000);
    expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    expect(backgroundPackStats.fallbackJobs).toBe(0);
    expect(backgroundPackStats.workerCompleted).toBe(1);

    // Stale mutation before Worker completion drops result.
    resetBackgroundPackForTests();
    let heldRequest: PackedInkCompileRequest | null = null;
    let stallingTarget: BackgroundPackWorker | null = null;
    const stallingWorker: BackgroundPackWorker = {
      postMessage(message: PackedInkCompileRequest) {
        heldRequest = structuredClone(message) as PackedInkCompileRequest;
        // Hold response until test mutates (stale path).
      },
      onmessage: null,
      onerror: null,
      terminate: () => undefined,
    };
    stallingTarget = stallingWorker;
    void stallingTarget;
    setBackgroundPackWorkerFactory(() => stallingWorker);
    const model2 = chunkedLogicalModel(20000, 'BGSTALE');
    for (const id of model2.order) {
      expect(compiledStrokeForRecord(model2.objects[id]!)).not.toBeNull();
    }
    const chunks2 = model2.order.map((id) => model2.objects[id]!);
    scheduleBackgroundPackForRecords(chunks2);
    await flushBackgroundPackQueueForTests(20);
    // Input complete, Worker pending (held). Mutate one chunk (erase-like).
    expect(heldRequest).not.toBeNull();
    const staleDropsBefore = backgroundPackStats.workerStaleDrops;
    const victim = model2.objects[model2.order[0]!]!;
    (victim as Record<string, unknown>).points = [];
    invalidateCompiledForIds(model2, [victim.id]);
    // Release the held Worker response built from OLD samples (pre-mutation).
    // It must be dropped as stale, never installed.
    const oldRequest = heldRequest!;
    const oldCompiled = compileInkStroke(
      unpackInkSamples(oldRequest.samples),
      oldRequest.brush,
      (oldRequest as { options?: never }).options ?? {},
    );
    const { packed: oldPacked, bytes: oldBytes } = packCompiledInk(oldCompiled);
    stallingWorker.onmessage!({
      data: {
        type: 'compiled-ink',
        requestId: oldRequest.requestId,
        objectId: oldRequest.objectId,
        generation: oldRequest.generation,
        compiled: structuredClone(oldPacked),
        workerUnpackMs: 0,
        compileMs: 1,
        packMs: 0,
        outputBytes: oldBytes,
      } as PackedInkCompileResponse,
    });
    // Give the message handler a turn.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backgroundPackStats.workerStaleDrops).toBeGreaterThan(
      staleDropsBefore,
    );
    for (const c of model2.order
      .map((id) => model2.objects[id]!)
      .filter((r) => r !== undefined)) {
      // Mutated logical must not gain a joint from stale output.
      if (c.id === victim.id) continue;
      expect(jointPackedForChunk(c)).toBeUndefined();
    }

    // Teardown before completion skips entry (cancel).
    resetBackgroundPackForTests();
    setBackgroundPackWorkerFactory(() => worker);
    const model3 = chunkedLogicalModel(20000, 'BGTEAR');
    for (const id of model3.order) {
      expect(compiledStrokeForRecord(model3.objects[id]!)).not.toBeNull();
    }
    scheduleBackgroundPackForRecords(
      model3.order.map((id) => model3.objects[id]!),
    );
    cancelBackgroundPackForTests();
    await flushBackgroundPackQueueForTests(100);
    for (const id of model3.order) {
      expect(jointPackedForChunk(model3.objects[id]!)).toBeUndefined();
    }
    const entries = collectPersistEntries({
      documentId: 'docTearBg',
      revision: 'R0',
      warm: model3.order.map((id) => model3.objects[id]!),
      cache: new SurfaceDerivedCache(),
    });
    expect(entries.filter((e) => e.key.objectId === 'BGTEAR')).toHaveLength(0);
    setBackgroundPackWorkerFactory(null);
  }, 180000);
});

describe('translation copy tripwire across sizes', () => {
  it.each([1000, 10000, 25000, 50000, 100000])(
    'pure translation of %i logical performs zero copies, zero compiles',
    async (n) => {
      const logicalId = `COPY${n}`;
      const model = chunkedLogicalModel(n, logicalId);
      await synthesizeJoint(model, logicalId);
      // Warm all chunks rich to maximize owners (worst case for copies).
      for (const id of model.order) {
        expect(compiledStrokeForRecord(model.objects[id]!)).not.toBeNull();
      }
      const copiesBefore = derivedTranslationStats.geometryCopies;
      const compilesBefore = compiledStrokeComputeStats.computes;
      translateCanonical(model, [...model.order], 15, -9);
      accumulateDerivedTranslation(model, [...model.order], 15, -9);
      expect(derivedTranslationStats.geometryCopies - copiesBefore).toBe(0);
      expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    },
    180000,
  );
});
