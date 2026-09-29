/**
 * Final performance repair gates (items 1, 3–6).
 *
 * Structural counters first — wall-clock only as a generous supplement.
 * Never reduces samples or geometry quality.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  accumulateDerivedTranslation,
  compiledStrokeComputeStats,
  compiledStrokeForRecord,
  derivedTranslationOfRecord,
  derivedTranslationStats,
  emptySurface,
  inkStrokeCompiledBounds,
  inkStrokeObject,
  createDefaultSurfaceObjectTypeRegistry,
  SurfaceInteractionController,
  IncrementalSceneCache,
  estimatePrepareCost,
  smoothSpineOfRecord,
  decodeSurfacePayload,
  encodeSurfacePayload,
  SurfaceDerivedCache,
  derivedCacheKey,
  INK_COMPILER_VERSION,
  asyncCompilerStats,
  compileInkStrokeAsync,
  compileInkStroke,
  resolveStrokeBrush,
  type SurfaceModel,
} from './index.js';

function strokePoints(baseX: number, baseY: number, count: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: baseX + i * 2, y: baseY + Math.sin(i / 4) * 6 });
  }
  return out;
}

function bigModel(strokes: number, samplesPerStroke: number): SurfaceModel {
  const model = emptySurface(boundedFrame(8000, 6000));
  for (let i = 0; i < strokes; i++) {
    const id = `s${i}`;
    model.objects[id] = inkStrokeObject(id, {
      points: strokePoints(
        (i % 50) * 120,
        Math.floor(i / 50) * 120,
        samplesPerStroke,
      ),
      width: 3,
    });
    model.order.push(id);
  }
  return model;
}

describe('item 1: geometry-preserving translation', () => {
  it('long-stroke release causes zero B-spline recompiles and zero bounds rescans', () => {
    const model = emptySurface(boundedFrame(20000, 2000));
    const id = 'long';
    model.objects[id] = inkStrokeObject(id, {
      points: strokePoints(0, 0, 10000),
      width: 3,
    });
    model.order.push(id);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const c = new SurfaceInteractionController({
      model,
      registry,
      onBeforeTranslate: () => {
        void 0;
      },
    });
    c.ensureIndexes();
    // Warm compiled geometry (simulates pre-drag viewport prepare).
    const record = model.objects[id]!;
    const beforeCompiled = compiledStrokeForRecord(record);
    expect(beforeCompiled).not.toBeNull();
    const computesBefore = compiledStrokeComputeStats.computes;
    const derivedBefore = c.derivedStats();
    const statsBefore = c.controllerStats();

    // Select + ephemeral drag (120 frames) + release via the lasso/tool
    // ephemeral API (same session/commit as pointer drags, bypasses
    // hit-test anchor ties that make raw pointer grabs flaky for huge
    // sine strokes — see scalability.spec for pointer-level coverage).
    c.setSelection([id]);
    expect(c.beginEphemeralMove({ x: 0, y: 0 })).toBe(true);
    for (let i = 1; i <= 120; i++) {
      c.updateEphemeralMove({ x: 1, y: 0 });
    }
    const during = c.controllerStats();
    expect(during.ephemeralMoves - statsBefore.ephemeralMoves).toBe(120);
    expect(during.canonicalSamplesTranslated).toBe(
      statsBefore.canonicalSamplesTranslated,
    );
    // Release drifts +120 x total (120 × +1).
    const committed = c.commitEphemeralMove();
    expect(committed).toContain(id);

    const after = c.controllerStats();
    expect(after.dragCommits - statsBefore.dragCommits).toBe(1);
    expect(after.translationCommits - statsBefore.translationCommits).toBe(1);
    // Canonical translated once (measured separately), never as mutation.
    expect(
      after.canonicalSamplesTranslated - statsBefore.canonicalSamplesTranslated,
    ).toBe(10000);
    expect(
      after.canonicalSamplesMutated - statsBefore.canonicalSamplesMutated,
    ).toBe(0);
    // Zero recompiles, zero rescans.
    expect(compiledStrokeComputeStats.computes - computesBefore).toBe(0);
    const derivedAfter = c.derivedStats();
    expect(derivedAfter.boundsScans - derivedBefore.boundsScans).toBe(0);
    expect(derivedAfter.boundsTranslates - derivedBefore.boundsTranslates).toBe(
      1,
    );
    // Translated geometry matches a fresh recompile within tolerance.
    // Immutable-local model: the cached object is IDENTICAL (zero vertex
    // copies — same reference, local coordinates untouched) and the
    // translation accumulates as derived metadata; world readers add it.
    const afterRecord = model.objects[id]!;
    const translated = compiledStrokeForRecord(afterRecord);
    expect(translated).not.toBeNull();
    // No recompute happened (same cached object, untouched) — flat.
    expect(compiledStrokeComputeStats.computes - computesBefore).toBe(0);
    expect(translated).toBe(beforeCompiled);
    expect(translated!.bounds.x).toBeCloseTo(beforeCompiled!.bounds.x, 9);
    expect(translated!.polygon.length).toBe(beforeCompiled!.polygon.length);
    const accumulated = derivedTranslationOfRecord(afterRecord);
    expect(accumulated).toEqual({ tx: 120, ty: 0 });
    expect(derivedTranslationStats.geometryCopies).toBe(0);
    // World readers see the moved stroke exactly.
    const worldSpine = smoothSpineOfRecord(afterRecord);
    const localSpine = beforeCompiled!.nodes.map((n) => ({ x: n.x, y: n.y }));
    expect(worldSpine.length).toBe(localSpine.length);
    expect(worldSpine[0]!.x).toBeCloseTo(localSpine[0]!.x + 120, 9);
    expect(worldSpine[0]!.y).toBeCloseTo(localSpine[0]!.y, 9);
    const worldBounds = inkStrokeCompiledBounds(afterRecord);
    expect(worldBounds!.x).toBeCloseTo(beforeCompiled!.bounds.x + 120, 6);
    // Hit-testing follows the translation (no stale local reads).
    expect(c.hitTest({ x: localSpine[0]!.x + 120, y: localSpine[0]!.y })).toBe(
      id,
    );
    expect(compiledStrokeComputeStats.computes - computesBefore).toBe(0);
    c.destroy();
  });

  it('translation updates cached/spatial bounds without raw-point scans', () => {
    const model = bigModel(10, 500);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const c = new SurfaceInteractionController({ model, registry });
    c.ensureIndexes();
    const id = model.order[0]!;
    const beforeBounds = c.cachedBoundsFor(id);
    expect(beforeBounds).not.toBeNull();
    const derivedBefore = c.derivedStats();
    const record = model.objects[id]!;
    // Simulate external canonical rewrite + translation notification.
    const translate = registry.get(record.type)?.translate;
    if (translate === undefined) throw new Error('no translate');
    translate(record, 15, -7);
    c.notifyTranslated([id], 15, -7);
    const afterBounds = c.cachedBoundsFor(id);
    expect(afterBounds!.x).toBeCloseTo(beforeBounds!.x + 15, 9);
    expect(afterBounds!.y).toBeCloseTo(beforeBounds!.y - 7, 9);
    expect(afterBounds!.width).toBeCloseTo(beforeBounds!.width, 9);
    const derivedAfter = c.derivedStats();
    expect(derivedAfter.boundsScans - derivedBefore.boundsScans).toBe(0);
    // Spatial query follows the translated position.
    const hits = c.queryRegion({
      x: afterBounds!.x,
      y: afterBounds!.y,
      width: afterBounds!.width,
      height: afterBounds!.height,
    });
    expect(hits).toContain(id);
    c.destroy();
  });

  it('derived translation accumulates without geometry copies', () => {
    const model = bigModel(2, 100);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const id = model.order[0]!;
    const record = model.objects[id]!;
    const compiled = compiledStrokeForRecord(record);
    expect(compiled).not.toBeNull();
    const copiesBefore = derivedTranslationStats.geometryCopies;
    // Production order: canonical rewrite first, then derived accumulation.
    const translate = registry.get(record.type)?.translate;
    if (translate === undefined) throw new Error('no translate');
    translate(record, 10, 20);
    const count = accumulateDerivedTranslation(model, [id], 10, 20);
    expect(count).toBe(1);
    // Immutable local geometry: same cached reference, untouched coords.
    const shifted = compiledStrokeForRecord(record);
    expect(shifted).toBe(compiled);
    expect(shifted!.bounds.x).toBeCloseTo(compiled!.bounds.x, 9);
    expect(shifted!.nodes[0]!.x).toBeCloseTo(compiled!.nodes[0]!.x, 9);
    expect(shifted!.polygon.length).toBe(compiled!.polygon.length);
    expect(derivedTranslationOfRecord(record)).toEqual({ tx: 10, ty: 20 });
    expect(derivedTranslationStats.geometryCopies - copiesBefore).toBe(0);
    // World readers see the moved stroke exactly.
    const worldSpine = smoothSpineOfRecord(record);
    expect(worldSpine[0]!.x).toBeCloseTo(compiled!.nodes[0]!.x + 10, 9);
    expect(worldSpine[0]!.y).toBeCloseTo(compiled!.nodes[0]!.y + 20, 9);
    const worldBounds = inkStrokeCompiledBounds(record);
    expect(worldBounds!.x).toBeCloseTo(compiled!.bounds.x + 10, 9);
    expect(worldBounds!.y).toBeCloseTo(compiled!.bounds.y + 20, 9);
    // Freshly compiled DrawItems carry world geometry; style/rotation kept.
    // Outline is world geometry (local cached polygon + translation);
    // envelope bounds (from translated canonical samples) contain it —
    // the pinned envelope-containment invariant, now at the new position.
    const items = registry.get(record.type)?.compile?.(record);
    expect(items).not.toBeNull();
    const item = (Array.isArray(items) ? items[0] : items) as unknown as {
      bounds: { x: number; y: number; width: number; height: number };
      rotation: number;
      outline: { x: number; y: number }[];
    };
    expect(item.outline.length).toBe(compiled!.polygon.length);
    expect(item.outline[0]!.x).toBeCloseTo(compiled!.polygon[0]!.x + 10, 9);
    expect(item.outline[0]!.y).toBeCloseTo(compiled!.polygon[0]!.y + 20, 9);
    expect(item.bounds.x).toBeLessThanOrEqual(worldBounds!.x + 1e-6);
    expect(item.bounds.y).toBeLessThanOrEqual(worldBounds!.y + 1e-6);
    expect(item.bounds.x + item.bounds.width).toBeGreaterThanOrEqual(
      worldBounds!.x + worldBounds!.width - 1e-6,
    );
    expect(item.bounds.y + item.bounds.height).toBeGreaterThanOrEqual(
      worldBounds!.y + worldBounds!.height - 1e-6,
    );
    expect(item.rotation).toBe(0);
  });
});

describe('item 4: no regroup/rescan per progressive slice', () => {
  it('progressive slices reuse the cached logical index', () => {
    const model = bigModel(200, 20);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    // Open: viewport prepare builds the index once.
    cache.prepareVisible(model, registry, model.order.slice(0, 20));
    const afterOpen = cache.statsSnapshot();
    expect(afterOpen.logicalRegroups).toBe(1);
    // Progressive slices over the remainder must not regroup.
    let pending: readonly string[] = model.order.filter(
      (id) => !cache.isPrepared(id),
    );
    for (let slice = 0; slice < 10 && pending.length > 0; slice++) {
      const out = cache.prepareMore(model, registry, pending, 10);
      pending = out.remaining;
    }
    const afterSlices = cache.statsSnapshot();
    expect(afterSlices.logicalRegroups).toBe(afterOpen.logicalRegroups);
  });

  it('unchanged strokes never recompile across updates and translates', () => {
    const model = bigModel(50, 20);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    cache.fullRebuild(model, registry);
    const base = cache.statsSnapshot();
    // Order-only update recompiles nothing.
    cache.update(model, registry, []);
    expect(cache.statsSnapshot().newlyCompiledObjects).toBe(0);
    // Translation shifts without recompiling.
    const ids = model.order.slice(0, 5);
    const translated = cache.notifyTranslated(ids, 10, 5);
    expect(translated).toBe(5);
    expect(cache.statsSnapshot().newlyCompiledObjects).toBe(0);
    expect(cache.statsSnapshot().translatedKeys - base.translatedKeys).toBe(5);
    void base;
  });
});

describe('item 3: genuinely non-blocking cold compilation', () => {
  it('one huge visible stroke defers synchronously and hydrates async identically', async () => {
    const model = emptySurface(boundedFrame(20000, 2000));
    model.objects.huge = inkStrokeObject('huge', {
      points: strokePoints(0, 0, 10000),
      width: 3,
    });
    model.order.push('huge');
    for (let i = 0; i < 10; i++) {
      model.objects[`s${i}`] = inkStrokeObject(`s${i}`, {
        points: strokePoints(0, 1000 + i * 50, 20),
        width: 3,
      });
      model.order.push(`s${i}`);
    }
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    // Sync slice with a 3ms budget must NOT compile the 10k stroke.
    const sync = cache.prepareMore(model, registry, [...model.order], 3);
    expect(sync.compiled).toBeLessThan(11);
    // The huge stroke is deferred (still remaining or unprepared).
    expect(cache.isPrepared('huge')).toBe(false);
    expect(cache.statsSnapshot().deferredForCost).toBeGreaterThan(0);
    // Async resumable compile yields and matches sync geometry exactly.
    const record = model.objects.huge!;
    const brush = resolveStrokeBrush(record);
    const { inkTypedSamplesOf } = await import('./objects.js');
    const samples = inkTypedSamplesOf(record);
    const yieldsBefore = asyncCompilerStats.yields;
    const asyncCompiled = await compileInkStrokeAsync(samples, brush);
    expect(asyncCompilerStats.yields - yieldsBefore).toBeGreaterThan(3);
    const syncCompiled = compileInkStroke(samples, brush);
    expect(asyncCompiled.nodes.length).toBe(syncCompiled.nodes.length);
    expect(asyncCompiled.polygon.length).toBe(syncCompiled.polygon.length);
    for (let i = 0; i < asyncCompiled.nodes.length; i += 997) {
      expect(asyncCompiled.nodes[i]!.x).toBeCloseTo(
        syncCompiled.nodes[i]!.x,
        9,
      );
      expect(asyncCompiled.nodes[i]!.y).toBeCloseTo(
        syncCompiled.nodes[i]!.y,
        9,
      );
    }
    expect(asyncCompiled.bounds.x).toBeCloseTo(syncCompiled.bounds.x, 9);
  }, 30000);
});

describe('item 5: no cold bounds rescan after decode', () => {
  it('seedIndexesFromDecode avoids Ink sample rescans', () => {
    const model = bigModel(200, 100);
    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.seedBounds.size).toBeGreaterThan(0);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const seeded = new SurfaceInteractionController({
      model: decoded.model,
      registry,
    });
    seeded.seedIndexesFromDecode(decoded.seedBounds);
    const seededStats = seeded.controllerStats();
    // Ink strokes seeded: zero registry bounds computations for them.
    // Only non-Ink fallbacks (none here) would compute.
    expect(seededStats.boundsComputations).toBe(0);
    expect(seeded.derivedStats().boundsSeeded).toBe(200);
    expect(seeded.derivedStats().boundsScans).toBe(0);
    // Seeded bounds match a rescan exactly.
    const id = decoded.model.order[0]!;
    const cached = seeded.cachedBoundsFor(id);
    const fresh = registry
      .get(decoded.model.objects[id]!.type)
      ?.boundsOf?.(decoded.model.objects[id]!);
    expect(cached!.x).toBeCloseTo(fresh!.x, 9);
    expect(cached!.width).toBeCloseTo(fresh!.width, 9);
    seeded.destroy();

    // Control: plain rebuild rescans every stroke once.
    const plain = new SurfaceInteractionController({
      model: decoded.model,
      registry,
    });
    plain.rebuildIndexes();
    expect(plain.controllerStats().boundsComputations).toBe(200);
    plain.destroy();
  });
});

describe('item 6: disposable derived-open cache', () => {
  it('bounds cache is versioned, disposable, and rebuildable', () => {
    const cache = new SurfaceDerivedCache();
    const key = derivedCacheKey('doc-1', 's-1', 'rev-1');
    expect(key.compilerVersion).toBe(INK_COMPILER_VERSION);
    expect(cache.loadBounds(key)).toBeUndefined();
    cache.storeBounds(key, { x: 1, y: 2, width: 3, height: 4 });
    expect(cache.loadBounds(key)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    // Stale compiler versions miss (never reuse across upgrades).
    const stale = { ...key, compilerVersion: INK_COMPILER_VERSION + 1 };
    expect(cache.loadBounds(stale)).toBeUndefined();
    // Binary serialize/restore round-trips current entries, skips stale.
    const bytes = cache.serializeBinary();
    const cache2 = new SurfaceDerivedCache();
    expect(cache2.restoreBinary(bytes)).toBe(1);
    expect(cache2.loadBounds(key)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    // Disposable: clearing loses nothing canonical (rebuild from samples).
    cache2.clear();
    expect(cache2.loadBounds(key)).toBeUndefined();
    const stats = cache.statsSnapshot();
    expect(stats.stores).toBe(1);
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });
});

describe('cost budgeting (item 2, headless)', () => {
  it.each([
    [400, 20],
    [400, 200],
    [400, 1000],
  ])('estimates %i×%i without scanning samples', (strokes, samples) => {
    const model = bigModel(strokes, samples);
    let total = 0;
    for (const id of model.order) {
      total += estimatePrepareCost(model.objects[id]!);
    }
    expect(total).toBe(strokes * samples);
  });

  it('one 10k stroke costs more than the first-paint budget', async () => {
    const { FIRST_PAINT_MAX_COST } = await import('./incremental-scene.js');
    const model = emptySurface(boundedFrame(20000, 2000));
    model.objects.huge = inkStrokeObject('huge', {
      points: strokePoints(0, 0, 10000),
      width: 3,
    });
    model.order.push('huge');
    expect(estimatePrepareCost(model.objects.huge!)).toBe(10000);
    expect(estimatePrepareCost(model.objects.huge!)).toBeGreaterThan(
      FIRST_PAINT_MAX_COST,
    );
  });
});
