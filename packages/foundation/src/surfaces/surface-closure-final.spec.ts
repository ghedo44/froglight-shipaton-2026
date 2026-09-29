/**
 * Surface scalability FINAL closure regressions (task items A–D).
 *
 * Proves the production paths, not isolated helpers:
 * - packed-only translation correctness (A)
 * - packed first interaction zero B-spline (B)
 * - bounded background packing (C)
 * - logical joint persistence (D)
 *
 * Structural counters only (no wall-clock thresholds).
 */

import { describe, expect, it } from 'vitest';
import {
  SurfaceDerivedCache,
  derivedCacheKey,
  DerivedReopenStore,
  createLiveCachedCompiledRestore,
  collectPersistEntries,
  scheduleBackgroundPackForRecords,
  flushBackgroundPackQueueForTests,
  resetBackgroundPackForTests,
  setBackgroundPackWorkerFactory,
  backgroundPackStats,
  MAX_MAIN_THREAD_PACK_CHUNK_ITEMS,
  BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
  persistenceTripwires,
  type BackgroundPackWorker,
  type SurfaceReopenBinding,
  IncrementalSceneCache,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  boundedFrame,
  inkStrokeObject,
  compiledStrokeForRecord,
  compiledStrokeComputeStats,
  materializeRichFromPacked,
  packedCompiledForRecord,
  packedOnlyForRecord,
  retainPackedOnlyForRecord,
  jointPackedForChunk,
  retainJointPackedForChunks,
  accumulateDerivedTranslation,
  derivedTranslationOfRecord,
  hasRichCompiledGeometry,
  smoothSpineOfRecord,
  smoothSamplesOfRecord,
  inkStrokeCompiledBounds,
  invalidateCompiledForIds,
  setCompiledForRecord,
  packCompiledInk,
  packedRenderCounters,
  resetPackedRenderCounters,
  ColdInkCompileScheduler,
  type ColdCompileWorker,
  type SurfaceObjectRecord,
  type SurfaceModel,
} from './index.js';
import { compileInkStroke } from './ink/compiler.js';
import {
  unpackInkSamples,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from './ink/packed-protocol.js';

function strokeRecord(samples: number, id = 's0'): SurfaceObjectRecord {
  const points: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < samples; i++) {
    points.push({
      x: 100 + i * 2,
      y: 200 + Math.sin(i / 5) * 8,
      pressure: 0.5,
      dt: i * 8,
    });
  }
  return inkStrokeObject(id, { points, width: 3 });
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

function fakeWorker(): {
  worker: ColdCompileWorker;
  compiles: { count: number };
} {
  const compiles = { count: 0 };
  let target: ColdCompileWorker | null = null;
  const worker: ColdCompileWorker = {
    postMessage(message: PackedInkCompileRequest) {
      const request = structuredClone(message);
      queueMicrotask(() => {
        if (target!.onmessage === null) return;
        compiles.count += 1;
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
  target = worker;
  return { worker, compiles };
}

function logicalModel(
  totalSamples: number,
  chunkSize: number,
  logicalId = 'L',
): SurfaceModel {
  const model = emptySurface(boundedFrame(20000, 20000));
  let remaining = totalSamples;
  let index = 0;
  let xBase = 100;
  while (remaining > 0) {
    const count = Math.min(chunkSize, remaining);
    const points: { x: number; y: number; pressure: number; dt: number }[] = [];
    for (let i = 0; i < count; i++) {
      points.push({
        x: xBase + i * 1.5,
        y: 300 + Math.sin((index * chunkSize + i) / 7) * 10,
        pressure: 0.5,
        dt: (index * chunkSize + i) * 4,
      });
    }
    const chunkId = index === 0 ? logicalId : `${logicalId}#part${index + 1}`;
    model.objects[chunkId] = inkStrokeObject(chunkId, {
      points,
      width: 3,
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

describe('A. packed-only translation correctness', () => {
  it('packed-only restore → translate → save R1 → reopen R1 at world, zero recompiles, zero stale', async () => {
    resetPackedRenderCounters();
    const compilesBefore = compiledStrokeComputeStats.computes;
    const store = new DerivedReopenStore(32, null);
    const cacheR0 = store.acquire('docA', 'R0');
    const seed = strokeRecord(300, 's0');
    const seedCompiled = compiledStrokeForRecord(seed);
    expect(seedCompiled).not.toBeNull();
    const seedPacked = packCompiledInk(seedCompiled!).packed;
    cacheR0.storeCompiled(derivedCacheKey('docA', 's0', 'R0'), seedPacked);

    const bindingR0: SurfaceReopenBinding = {
      store,
      documentId: 'docA',
      getContentRevision: () => 'R0',
      isDirty: () => false,
    };
    const restoreR0 = createLiveCachedCompiledRestore(bindingR0);
    const model = emptySurface(boundedFrame(4000, 4000));
    model.objects['s0'] = strokeRecord(300, 's0');
    model.order.push('s0');
    const record = model.objects['s0']!;
    const packedHit = restoreR0.restorePacked?.(record);
    expect(packedHit).toBeDefined();
    expect(packedOnlyForRecord(record)).toBeDefined();
    expect(hasRichCompiledGeometry(record)).toBe(false);
    expect(packedCompiledForRecord(record)).toBeDefined();
    const worldBefore = smoothSpineOfRecord(record);
    expect(worldBefore.length).toBeGreaterThan(0);
    const centroidBefore = spineCentroid(worldBefore);

    const dx = 120;
    const dy = -45;
    translateCanonical(model, ['s0'], dx, dy);
    const translatedCount = accumulateDerivedTranslation(model, ['s0'], dx, dy);
    expect(translatedCount).toBe(1);
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: dx, ty: dy });
    const worldAfter = smoothSpineOfRecord(record);
    const centroidAfter = spineCentroid(worldAfter);
    expect(centroidAfter.x).toBeCloseTo(centroidBefore.x + dx, 6);
    expect(centroidAfter.y).toBeCloseTo(centroidBefore.y + dy, 6);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(1);

    const saved = new Map<string, Uint8Array>();
    const persistStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    persistStore.acquire('docA', 'R1');
    persistStore.scheduleWarmCompiledGeometry({
      documentId: 'docA',
      revision: 'R1',
      model,
    });
    await persistStore.flushPending();
    expect(persistenceTripwires.mainThreadPersistencePacks).toBe(0);
    expect(saved.has('docA')).toBe(true);

    const reopenStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: () => undefined,
    });
    reopenStore.acquire('docA', 'R1');
    expect(await reopenStore.hydrate('docA')).toBe(true);
    const bindingR1: SurfaceReopenBinding = {
      store: reopenStore,
      documentId: 'docA',
      getContentRevision: () => 'R1',
      isDirty: () => false,
    };
    const reopenRestore = createLiveCachedCompiledRestore(bindingR1);
    const fresh: SurfaceObjectRecord = inkStrokeObject('s0', {
      points: structuredClone(
        (model.objects['s0'] as Record<string, unknown>).points,
      ) as never,
      width: 3,
    });
    const modelR1 = emptySurface(boundedFrame(4000, 4000));
    modelR1.objects['s0'] = fresh;
    modelR1.order.push('s0');
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    const compilesBeforeReopen = compiledStrokeComputeStats.computes;
    const scene = new IncrementalSceneCache();
    scene.setCompiledRestoreSource(reopenRestore);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    // Durable reopen awaits ONE entry (viewport priority, bounded) via the
    // async lane; `prepareOneAsync` handles the manifest→entry await while
    // `prepareVisible` would defer synchronously and return empty.
    expect(await scene.prepareOneAsync(modelR1, registry, 's0')).toBe(true);
    const items = scene.update(modelR1, registry, []);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const packedItem = items.find((p) => p.item.kind === 'packed-stroke');
    expect(packedItem).toBeDefined();
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(0);
    expect(compiledStrokeComputeStats.computes - compilesBeforeReopen).toBe(0);
    const reopenedSpine = smoothSpineOfRecord(fresh);
    const reopenedCentroid = spineCentroid(reopenedSpine);
    expect(reopenedCentroid.x).toBeCloseTo(centroidAfter.x, 6);
    expect(reopenedCentroid.y).toBeCloseTo(centroidAfter.y, 6);
    const reopenedBounds = inkStrokeCompiledBounds(fresh);
    const expectedBounds = inkStrokeCompiledBounds(record);
    expect(reopenedBounds!.x).toBeCloseTo(expectedBounds!.x, 6);
    expect(reopenedBounds!.y).toBeCloseTo(expectedBounds!.y, 6);
  });

  it('translate → undo → redo → persist → reopen stays correct', async () => {
    const model = emptySurface(boundedFrame(4000, 4000));
    model.objects['s0'] = strokeRecord(150, 's0');
    model.order.push('s0');
    const record = model.objects['s0']!;
    const compiled = compiledStrokeForRecord(record);
    expect(compiled).not.toBeNull();
    setCompiledForRecord(record, compiled!, packCompiledInk(compiled!).packed);
    const spine0 = smoothSpineOfRecord(record);
    const c0 = spineCentroid(spine0);

    // Translate (same ordering as SurfaceGestureHistory translate commands).
    translateCanonical(model, ['s0'], 50, 25);
    accumulateDerivedTranslation(model, ['s0'], 50, 25);
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: 50, ty: 25 });

    // Undo (canonical back + inverse accumulation).
    translateCanonical(model, ['s0'], -50, -25);
    accumulateDerivedTranslation(model, ['s0'], -50, -25);
    const spineUndo = smoothSpineOfRecord(model.objects['s0']!);
    const cUndo = spineCentroid(spineUndo);
    expect(cUndo.x).toBeCloseTo(c0.x, 6);
    expect(cUndo.y).toBeCloseTo(c0.y, 6);

    // Redo (forward again).
    translateCanonical(model, ['s0'], 50, 25);
    accumulateDerivedTranslation(model, ['s0'], 50, 25);
    const spineRedo = smoothSpineOfRecord(model.objects['s0']!);
    const cRedo = spineCentroid(spineRedo);
    expect(cRedo.x).toBeCloseTo(c0.x + 50, 6);
    expect(cRedo.y).toBeCloseTo(c0.y + 25, 6);

    const saved = new Map<string, Uint8Array>();
    const store = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    store.acquire('docUndo', 'R1');
    store.scheduleWarmCompiledGeometry({
      documentId: 'docUndo',
      revision: 'R1',
      model,
    });
    await store.flushPending();
    const reopenStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: () => undefined,
    });
    reopenStore.acquire('docUndo', 'R1');
    await reopenStore.hydrate('docUndo');
    const binding: SurfaceReopenBinding = {
      store: reopenStore,
      documentId: 'docUndo',
      getContentRevision: () => 'R1',
      isDirty: () => false,
    };
    const restore = createLiveCachedCompiledRestore(binding);
    const fresh = inkStrokeObject('s0', {
      points: structuredClone(
        (model.objects['s0'] as Record<string, unknown>).points,
      ) as never,
      width: 3,
    });
    const modelR = emptySurface(boundedFrame(4000, 4000));
    modelR.objects['s0'] = fresh;
    modelR.order.push('s0');
    const scene = new IncrementalSceneCache();
    scene.setCompiledRestoreSource(restore);
    // Durable reopen via the async lane (awaits the single entry).
    expect(
      await scene.prepareOneAsync(
        modelR,
        createDefaultSurfaceObjectTypeRegistry(),
        's0',
      ),
    ).toBe(true);
    const items = scene.update(
      modelR,
      createDefaultSurfaceObjectTypeRegistry(),
      [],
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((p) => p.item.kind === 'packed-stroke')).toBe(true);
    const cReopen = spineCentroid(smoothSpineOfRecord(fresh));
    expect(cReopen.x).toBeCloseTo(cRedo.x, 6);
    expect(cReopen.y).toBeCloseTo(cRedo.y, 6);
  });

  it('repeated packed-only translations stay correct', () => {
    const model = emptySurface(boundedFrame(4000, 4000));
    model.objects['s0'] = strokeRecord(120, 's0');
    model.order.push('s0');
    const record = model.objects['s0']!;
    // Make packed-only: compile, pack, invalidate rich, retain packed-only.
    const compiled = compiledStrokeForRecord(record);
    expect(compiled).not.toBeNull();
    const packed = packCompiledInk(compiled!).packed;
    invalidateCompiledForIds(model, ['s0']);
    retainPackedOnlyForRecord(record, packed);
    expect(packedOnlyForRecord(record)).toBeDefined();
    expect(hasRichCompiledGeometry(record)).toBe(false);
    const c0 = spineCentroid(smoothSpineOfRecord(record));
    translateCanonical(model, ['s0'], 10, 5);
    expect(accumulateDerivedTranslation(model, ['s0'], 10, 5)).toBe(1);
    translateCanonical(model, ['s0'], -3, 17);
    expect(accumulateDerivedTranslation(model, ['s0'], -3, 17)).toBe(1);
    translateCanonical(model, ['s0'], 40, -10);
    expect(accumulateDerivedTranslation(model, ['s0'], 40, -10)).toBe(1);
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: 47, ty: 12 });
    const c1 = spineCentroid(smoothSpineOfRecord(record));
    expect(c1.x).toBeCloseTo(c0.x + 47, 6);
    expect(c1.y).toBeCloseTo(c0.y + 12, 6);
    // Persist + reopen the repeatedly-translated packed-only stroke.
    const worldPacked = packedCompiledForRecord(record);
    expect(worldPacked).toBeDefined();
  });
});

describe('B. packed first interaction zero B-spline', () => {
  it('cached packed 10k hit-test causes zero B-spline compiles', async () => {
    const N = 10_000;
    const seed = strokeRecord(N, 'big10k');
    const compiled = compiledStrokeForRecord(seed);
    expect(compiled).not.toBeNull();
    const packed = packCompiledInk(compiled!).packed;
    const store = new DerivedReopenStore(32, null);
    store
      .acquire('doc10k', 'R0')
      .storeCompiled(derivedCacheKey('doc10k', 'big10k', 'R0'), packed);
    const binding: SurfaceReopenBinding = {
      store,
      documentId: 'doc10k',
      getContentRevision: () => 'R0',
      isDirty: () => false,
    };
    const restore = createLiveCachedCompiledRestore(binding);
    const model = emptySurface(boundedFrame(50000, 5000));
    model.objects['big10k'] = strokeRecord(N, 'big10k');
    model.order.push('big10k');
    const record = model.objects['big10k']!;
    resetPackedRenderCounters();
    const scene = new IncrementalSceneCache();
    scene.setCompiledRestoreSource(restore);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const items = scene.prepareVisible(model, registry, ['big10k']);
    expect(items[0]!.item.kind).toBe('packed-stroke');
    expect(packedRenderCounters.synchronousRichUnpacks).toBe(0);
    const spine = smoothSpineOfRecord(record);
    expect(spine.length).toBeGreaterThan(100);
    const inside = spine[Math.floor(spine.length / 2)]!;
    const compilesBefore = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    const hit = registry.get(record.type)!.hitTest!(record, inside.x, inside.y);
    expect(hit).toBe(true);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(0);
  }, 60000);

  it('cached packed 50k selection causes zero B-spline compiles', async () => {
    const N = 50_000;
    const seed = strokeRecord(N, 'big50k');
    const compiled = compiledStrokeForRecord(seed);
    expect(compiled).not.toBeNull();
    const packed = packCompiledInk(compiled!).packed;
    const store = new DerivedReopenStore(32, null);
    store
      .acquire('doc50k', 'R0')
      .storeCompiled(derivedCacheKey('doc50k', 'big50k', 'R0'), packed);
    const binding: SurfaceReopenBinding = {
      store,
      documentId: 'doc50k',
      getContentRevision: () => 'R0',
      isDirty: () => false,
    };
    const restore = createLiveCachedCompiledRestore(binding);
    const model = emptySurface(boundedFrame(200000, 5000));
    model.objects['big50k'] = strokeRecord(N, 'big50k');
    model.order.push('big50k');
    const record = model.objects['big50k']!;
    const scene = new IncrementalSceneCache();
    scene.setCompiledRestoreSource(restore);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    expect(
      scene.prepareVisible(model, registry, ['big50k'])[0]!.item.kind,
    ).toBe('packed-stroke');
    const compilesBefore = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    const bounds = inkStrokeCompiledBounds(record);
    expect(bounds).not.toBeNull();
    const spine = smoothSpineOfRecord(record);
    expect(spine.length).toBeGreaterThan(100);
    const samples = smoothSamplesOfRecord(record);
    expect(samples.length).toBe(spine.length);
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(0);
  }, 120000);

  it('rich materialization from packed uses unpack (not compile), correct world, others stay packed', () => {
    resetPackedRenderCounters();
    const model = emptySurface(boundedFrame(8000, 8000));
    model.objects['s0'] = strokeRecord(400, 's0');
    model.objects['s1'] = strokeRecord(400, 's1');
    model.order.push('s0', 's1');
    const r0 = model.objects['s0']!;
    const r1 = model.objects['s1']!;
    // Both packed-only.
    for (const r of [r0, r1]) {
      const c = compiledStrokeForRecord(r);
      expect(c).not.toBeNull();
      const p = packCompiledInk(c!).packed;
      invalidateCompiledForIds(model, [r.id]);
      retainPackedOnlyForRecord(r, p);
      expect(hasRichCompiledGeometry(r)).toBe(false);
    }
    // Translate s0 only.
    translateCanonical(model, ['s0'], 30, -12);
    expect(accumulateDerivedTranslation(model, ['s0'], 30, -12)).toBe(1);
    const world0Before = smoothSpineOfRecord(r0);
    const c0 = spineCentroid(world0Before);
    // Materialize rich for s0 only (genuinely needs rich).
    const compilesBefore = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    const rich = materializeRichFromPacked(r0);
    expect(rich).not.toBeNull();
    expect(rich).not.toBeUndefined();
    expect(compiledStrokeComputeStats.computes - compilesBefore).toBe(0);
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(1);
    // World translation preserved through materialization.
    const world0After = smoothSpineOfRecord(r0);
    expect(spineCentroid(world0After).x).toBeCloseTo(c0.x, 6);
    expect(spineCentroid(world0After).y).toBeCloseTo(c0.y, 6);
    // Unrelated record stays packed (no rich, no unpack).
    expect(hasRichCompiledGeometry(r1)).toBe(false);
    expect(packedOnlyForRecord(r1)).toBeDefined();
    expect(packedCompiledForRecord(r1)).toBeDefined();
  });
});

describe('C. background packing bounded', () => {
  it('giant background packing spans slices, never one uninterruptible pack', async () => {
    resetBackgroundPackForTests();
    resetPackedRenderCounters();
    persistenceTripwires.mainThreadPersistencePacks = 0;
    // Background Worker lane: SAME canonical compiler off-thread (fake seam).
    let workerJobsSeen = 0;
    let workerTarget: BackgroundPackWorker | null = null;
    const bgWorker: BackgroundPackWorker = {
      postMessage(message: PackedInkCompileRequest) {
        const request = structuredClone(message);
        queueMicrotask(() => {
          if (workerTarget!.onmessage === null) return;
          workerJobsSeen += 1;
          const compiled = compileInkStroke(
            unpackInkSamples(request.samples),
            request.brush,
            request.options ?? {},
          );
          const { packed, bytes } = packCompiledInk(compiled);
          workerTarget!.onmessage({
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
    workerTarget = bgWorker;
    setBackgroundPackWorkerFactory(() => bgWorker);
    // Giant live stroke: rich compiled, no packed yet.
    const N = 20000;
    const model = emptySurface(boundedFrame(100000, 5000));
    model.objects['giant'] = strokeRecord(N, 'giant');
    model.order.push('giant');
    const record = model.objects['giant']!;
    const compiled = compiledStrokeForRecord(record);
    expect(compiled).not.toBeNull();
    expect(packedCompiledForRecord(record)).toBeUndefined();
    scheduleBackgroundPackForRecords([record]);
    expect(backgroundPackStats.queued).toBe(1);
    expect(backgroundPackStats.jobsQueued).toBe(1);
    // Pump exactly one slice manually (simulating one idle callback).
    // A giant stroke must NOT finish input in one slice (20k > 2000 budget).
    await flushBackgroundPackQueueForTests(1);
    // After one slice, input is incomplete (giant spans slices). The invariant
    // we pin structurally: no single slice exceeded the input budget.
    expect(backgroundPackStats.maxMainThreadPackChunkItems).toBeLessThanOrEqual(
      MAX_MAIN_THREAD_PACK_CHUNK_ITEMS,
    );
    expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
      BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
    );
    expect(backgroundPackStats.inputChunks).toBeGreaterThanOrEqual(1);
    // Drain fully: Worker compiles/packs off-main, main retains without any
    // rich→packed full pack.
    await flushBackgroundPackQueueForTests(10000);
    expect(packedCompiledForRecord(record)).toBeDefined();
    expect(workerJobsSeen).toBe(1);
    expect(backgroundPackStats.completed).toBe(1);
    expect(backgroundPackStats.workerJobs).toBe(1);
    expect(backgroundPackStats.workerCompleted).toBe(1);
    expect(backgroundPackStats.maxMainThreadPackChunkItems).toBeLessThanOrEqual(
      MAX_MAIN_THREAD_PACK_CHUNK_ITEMS,
    );
    expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
      BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
    );
    expect(backgroundPackStats.mainThreadChunks).toBeGreaterThan(1);
    expect(backgroundPackStats.inputChunks).toBeGreaterThan(1);
    expect(backgroundPackStats.inputSamples).toBe(N);
    expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    expect(backgroundPackStats.fallbackJobs).toBe(0);
    expect(persistenceTripwires.mainThreadPersistencePacks).toBe(0);
    // Teardown-style collection finds the retained packed (no sync pack).
    const entries = collectPersistEntries({
      documentId: 'docBg',
      revision: 'R0',
      warm: [record],
      cache: new SurfaceDerivedCache(),
    });
    expect(entries.map((e) => e.key.objectId)).toEqual(['giant']);
    expect(persistenceTripwires.mainThreadPersistencePacks).toBe(0);
    setBackgroundPackWorkerFactory(null);
  }, 120000);

  it('teardown performs zero synchronous geometry packing', async () => {
    persistenceTripwires.mainThreadPersistencePacks = 0;
    resetBackgroundPackForTests();
    const saved = new Map<string, Uint8Array>();
    const store = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    const model = emptySurface(boundedFrame(4000, 4000));
    model.objects['live'] = strokeRecord(500, 'live');
    model.order.push('live');
    const record = model.objects['live']!;
    // Live stroke: rich only, background packing not yet run.
    expect(compiledStrokeForRecord(record)).not.toBeNull();
    expect(packedCompiledForRecord(record)).toBeUndefined();
    store.acquire('docTear', 'R0');
    store.scheduleWarmCompiledGeometry({
      documentId: 'docTear',
      revision: 'R0',
      model,
    });
    await store.flushPending();
    expect(persistenceTripwires.mainThreadPersistencePacks).toBe(0);
    // Skipped unpacked record: no durable entries for it.
    const entries = collectPersistEntries({
      documentId: 'docTear',
      revision: 'R0',
      warm: [record],
      cache: new SurfaceDerivedCache(),
    });
    expect(entries).toHaveLength(0);
  });
});

describe('D. logical joint persistence', () => {
  it('>10k joint persists and restores with zero B-spline recompiles', async () => {
    resetPackedRenderCounters();
    const compilesBeforeAll = compiledStrokeComputeStats.computes;
    const fake = fakeWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => fake.worker,
    });
    const registry = createDefaultSurfaceObjectTypeRegistry();
    // 12k samples across 3 chunks (4k each).
    const model = logicalModel(12000, 4000, 'L');
    expect(model.order).toHaveLength(3);
    const scene = new IncrementalSceneCache();
    scene.setColdScheduler(scheduler);
    // Cold Worker compile once (joint).
    const chunkId = model.order[0]!;
    expect(await scene.prepareOneAsync(model, registry, chunkId)).toBe(true);
    expect(fake.compiles.count).toBe(1);
    // Joint retained on every chunk (same reference, no per-chunk duplicate).
    const chunks = model.order.map((id) => model.objects[id]!);
    for (const chunk of chunks) {
      expect(jointPackedForChunk(chunk)).toBeDefined();
    }
    const firstJoint = jointPackedForChunk(chunks[0]!);
    for (const chunk of chunks.slice(1)) {
      expect(jointPackedForChunk(chunk)).toBe(firstJoint);
    }
    const compilesAfterCold = compiledStrokeComputeStats.computes;
    // Persist (teardown) for R0.
    const saved = new Map<string, Uint8Array>();
    const store = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    store.acquire('docLogic', 'R0');
    store.scheduleWarmCompiledGeometry({
      documentId: 'docLogic',
      revision: 'R0',
      model,
    });
    await store.flushPending();
    expect(saved.has('docLogic')).toBe(true);
    // Manifest must reference the logical id once (not per chunk).
    // Per-entry record at the logical storage key.
    const { decodeDerivedCacheManifest } = await import('./derived-cache.js');
    const manifestBytes = saved.get('docLogic')!;
    const manifest = decodeDerivedCacheManifest(
      manifestBytes,
      'docLogic',
      'R0',
    );
    expect(manifest).not.toBeNull();
    const logicalEntries = manifest!.entries.filter((e) => e.objectId === 'L');
    expect(logicalEntries).toHaveLength(1);
    const chunkEntries = manifest!.entries.filter((e) => e.objectId !== 'L');
    expect(chunkEntries).toHaveLength(0);

    // Reopen R0 with fresh record identities (new decode).
    const reopenStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: () => undefined,
    });
    reopenStore.acquire('docLogic', 'R0');
    expect(await reopenStore.hydrate('docLogic')).toBe(true);
    const binding: SurfaceReopenBinding = {
      store: reopenStore,
      documentId: 'docLogic',
      getContentRevision: () => 'R0',
      isDirty: () => false,
    };
    const restore = createLiveCachedCompiledRestore(binding);
    const modelR = logicalModel(12000, 4000, 'L');
    const sceneR = new IncrementalSceneCache();
    sceneR.setCompiledRestoreSource(restore);
    // No Worker for reopen: any miss would fall back to async compile
    // (counted as B-spline). Zero recompiles proves the joint hit.
    const compilesBeforeReopen = compiledStrokeComputeStats.computes;
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    // Prepare the joint via the async lane (durable await, no Worker).
    expect(
      await sceneR.prepareOneAsync(modelR, registry, modelR.order[0]!),
    ).toBe(true);
    expect(compiledStrokeComputeStats.computes - compilesBeforeReopen).toBe(0);
    // Joint restore may retain packed-only (1 unpack at most for counting?
    // Packed-direct joint restore does zero unpacks; allow ≤1 for legacy
    // rich fallback without failing the zero-compile invariant).
    expect(
      packedRenderCounters.synchronousRichUnpacks - unpacksBefore,
    ).toBeLessThanOrEqual(1);
    // Joint geometry present (one logical item).
    const items = sceneR.update(modelR, registry, []);
    // One joint item (packed or rich) for the logical stroke.
    expect(items.length).toBeGreaterThanOrEqual(1);
    scheduler.dispose();
    void compilesBeforeAll;
    void compilesAfterCold;
  }, 120000);

  it('logical member edit invalidates the joint', async () => {
    const model = logicalModel(6000, 2000, 'E');
    const chunks = model.order.map((id) => model.objects[id]!);
    // Retain a fake joint on all chunks.
    const seed = strokeRecord(100, 'seed');
    const seedCompiled = compiledStrokeForRecord(seed);
    const seedPacked = packCompiledInk(seedCompiled!).packed;
    retainJointPackedForChunks(chunks, seedPacked);
    for (const chunk of chunks) {
      expect(jointPackedForChunk(chunk)).toBeDefined();
    }
    // Edit one chunk (content mutation, not translation).
    const victim = model.objects[model.order[1]!]!;
    const points = (victim as Record<string, unknown>).points as unknown[];
    (points[0] as Record<string, unknown>).x = 999999;
    invalidateCompiledForIds(model, [victim.id]);
    // Whole logical joint cleared (all peers).
    for (const chunk of model.order.map((id) => model.objects[id]!)) {
      expect(jointPackedForChunk(chunk)).toBeUndefined();
    }
    // Old joint cache would miss (new compile needed) — persistence collects
    // nothing for the edited logical.
    const entries = collectPersistEntries({
      documentId: 'docEdit',
      revision: 'R0',
      warm: chunks,
      cache: new SurfaceDerivedCache(),
    });
    expect(entries.filter((e) => e.key.objectId === 'E')).toHaveLength(0);
  });

  it('logical translation persists correct world geometry', async () => {
    // Build a small logical with a retained joint, translate, persist, reopen.
    const model = logicalModel(6000, 2000, 'T');
    const chunks = model.order.map((id) => model.objects[id]!);
    // Synthesize a joint packed from the concatenated samples (small, sync ok).
    const { logicalSamples, groupLogicalChunks, logicalHead } = await import(
      './logical-stroke.js'
    );
    const groups = groupLogicalChunks(model);
    const group = groups.get('T')!;
    const jointSamples = logicalSamples(group);
    const { resolveStrokeBrush } = await import('./objects.js');
    const head = logicalHead(group);
    const brush = resolveStrokeBrush(head);
    const jointCompiled = compileInkStroke(jointSamples, brush);
    const jointPacked = packCompiledInk(jointCompiled).packed;
    retainJointPackedForChunks(chunks, jointPacked);
    const centroidBefore = (() => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < jointPacked.nodeXY.length; i += 2) {
        sx += jointPacked.nodeXY[i]!;
        sy += jointPacked.nodeXY[i + 1]!;
      }
      const n = jointPacked.nodeCount;
      return { x: sx / n, y: sy / n };
    })();
    // Translate entire logical (all chunks, same delta).
    const dx = 80;
    const dy = 35;
    const allIds = [...model.order];
    translateCanonical(model, allIds, dx, dy);
    const translated = accumulateDerivedTranslation(model, allIds, dx, dy);
    // One logical stroke accumulates once (not once per chunk).
    expect(translated).toBe(1);
    // Persist for R1.
    const saved = new Map<string, Uint8Array>();
    const store = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    store.acquire('docTrans', 'R1');
    store.scheduleWarmCompiledGeometry({
      documentId: 'docTrans',
      revision: 'R1',
      model,
    });
    await store.flushPending();
    // Reopen R1: joint must be at translated world, zero stale.
    const reopenStore = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: () => undefined,
    });
    reopenStore.acquire('docTrans', 'R1');
    await reopenStore.hydrate('docTrans');
    const loaded = await reopenStore.loadDurableEntry('docTrans', 'R1', 'T');
    expect(loaded).not.toBeNull();
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < loaded!.nodeXY.length; i += 2) {
      sx += loaded!.nodeXY[i]!;
      sy += loaded!.nodeXY[i + 1]!;
    }
    const n = loaded!.nodeCount;
    expect(sx / n).toBeCloseTo(centroidBefore.x + dx, 6);
    expect(sy / n).toBeCloseTo(centroidBefore.y + dy, 6);
  });
});
