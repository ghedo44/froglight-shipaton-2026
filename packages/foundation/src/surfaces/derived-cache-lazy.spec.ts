/**
 * Dense-document derived-cache repairs:
 *
 * - byte-budgeted compiled cache (huge strokes evict before many tiny ones);
 * - lazy, viewport-first packed restore (no whole-document unpack at
 *   mount/hydration; retained packed reuse for persistence);
 * - off-thread persistence packing port (parity with the in-memory
 *   serializer);
 * - queued persistence jobs revalidate clean/revision at execution time.
 */

import { describe, expect, it } from 'vitest';
import {
  DERIVED_CACHE_MAX_COMPILED,
  SurfaceDerivedCache,
  derivedCacheKey,
} from './derived-cache.js';
import { IncrementalSceneCache } from './incremental-scene.js';
import {
  DerivedReopenStore,
  collectPersistEntries,
  createCachedCompiledRestore,
  packDerivedCacheOnMain,
  persistLiveReopenGeometry,
  persistWarmCompiledGeometry,
  type DerivedCacheStoragePort,
  type DerivedCachePackRequest,
  type SurfaceReopenBinding,
} from './derived-reopen.js';
import {
  accumulateDerivedTranslation,
  compiledStrokeComputeStats,
  compiledStrokeForRecord,
  createDefaultSurfaceObjectTypeRegistry,
  packedCompiledForRecord,
  setCompiledForRecord,
} from './objects.js';
import {
  packCompiledInk,
  packedCompiledByteLength,
  unpackCompiledInk,
} from './ink/packed-protocol.js';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from './model.js';

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

function strokeModel(samples: number, id = 's0'): SurfaceModel {
  const model = emptySurface(boundedFrame(4000, 4000));
  model.objects[id] = strokeRecord(samples, id);
  model.order.push(id);
  return model;
}

function packedStroke(
  samples: number,
): ReturnType<typeof packCompiledInk>['packed'] {
  const record = strokeRecord(samples);
  const compiled = compiledStrokeForRecord(record);
  expect(compiled).not.toBeNull();
  return packCompiledInk(compiled!).packed;
}

function memoryPort(): DerivedCacheStoragePort & {
  saved: Map<string, Uint8Array>;
} {
  const saved = new Map<string, Uint8Array>();
  return {
    saved,
    load: (documentId: string) => saved.get(documentId) ?? null,
    save: (documentId: string, bytes: Uint8Array) => {
      saved.set(documentId, bytes);
    },
    remove: (documentId: string) => {
      saved.delete(documentId);
    },
  };
}

describe('byte-budgeted compiled cache', () => {
  it('evicts huge entries by bytes and keeps many tiny entries', () => {
    const budget = 256 * 1024;
    const cache = new SurfaceDerivedCache({
      maxCompiledBytes: budget,
      maxCompiledEntries: 100_000,
    });
    const huge = packedStroke(2_000);
    const hugeBytes = packedCompiledByteLength(huge);
    expect(hugeBytes).toBeGreaterThan(budget);
    cache.storeCompiled(derivedCacheKey('doc', 'huge', 'rev'), huge);
    // A single entry larger than the whole budget never enters the cache.
    expect(cache.statsSnapshot().entryCount).toBe(0);
    expect(cache.statsSnapshot().byteEvictions).toBe(1);
    expect(cache.statsSnapshot().compiledBytes).toBe(0);

    const tiny = packedStroke(10);
    const tinyBytes = packedCompiledByteLength(tiny);
    const capacity = Math.floor(budget / tinyBytes);
    expect(capacity).toBeGreaterThan(10);
    const writes = capacity + 5;
    for (let i = 0; i < writes; i++) {
      cache.storeCompiled(derivedCacheKey('doc', `t${i}`, 'rev'), tiny);
    }
    const stats = cache.statsSnapshot();
    // Byte-driven: the retained set fits the byte budget, not a count cap.
    expect(stats.compiledBytes).toBeLessThanOrEqual(budget);
    expect(stats.entryCount).toBeLessThanOrEqual(capacity);
    expect(stats.entryCount).toBeLessThan(writes);
    expect(stats.byteEvictions).toBeGreaterThanOrEqual(5);
    // Newest survive; the earliest tiny entry was evicted.
    expect(
      cache.loadCompiled(derivedCacheKey('doc', `t${writes - 1}`, 'rev')),
    ).toBeDefined();
    expect(
      cache.loadCompiled(derivedCacheKey('doc', 't0', 'rev')),
    ).toBeUndefined();
  });

  it('counts entries restored from a container against the byte budget', () => {
    const source = new SurfaceDerivedCache({
      maxCompiledBytes: 1024 * 1024,
      maxCompiledEntries: 4,
    });
    const packed = packedStroke(20);
    for (let i = 0; i < 6; i++) {
      source.storeCompiled(derivedCacheKey('doc', `s${i}`, 'rev'), packed);
    }
    const bytes = source.serializeBinary('rev');
    const revived = new SurfaceDerivedCache({
      maxCompiledBytes: 1024 * 1024,
      maxCompiledEntries: 4,
    });
    expect(revived.restoreBinary(bytes, 'rev')).toBe(4);
    expect(revived.statsSnapshot().entryCount).toBe(4);
    expect(revived.statsSnapshot().compiledBytes).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });

  it('keeps the object-count ceiling as a secondary guard', () => {
    const cache = new SurfaceDerivedCache({
      maxCompiledBytes: 64 * 1024 * 1024,
      maxCompiledEntries: 16,
    });
    const packed = packedStroke(10);
    for (let i = 0; i < 20; i++) {
      cache.storeCompiled(derivedCacheKey('doc', `s${i}`, 'rev'), packed);
    }
    const stats = cache.statsSnapshot();
    expect(stats.entryCount).toBe(16);
    expect(stats.compiledEvictions).toBe(4);
    expect(stats.byteEvictions).toBe(0);
    expect(stats.maxCompiledBytes).toBe(64 * 1024 * 1024);
  });
});

describe('lazy packed restore source', () => {
  it('hydrating a 1000-entry container installs no geometry synchronously', () => {
    const source = new SurfaceDerivedCache({
      maxCompiledEntries: 1_100,
      maxCompiledBytes: 512 * 1024 * 1024,
    });
    const template = packedStroke(10);
    for (let i = 0; i < 1_000; i++) {
      source.storeCompiled(derivedCacheKey('doc', `s${i}`, 'rev'), template);
    }
    const bytes = source.serializeBinary('rev');
    const revived = new SurfaceDerivedCache({
      maxCompiledEntries: 1_100,
      maxCompiledBytes: 512 * 1024 * 1024,
    });
    const computesBefore = compiledStrokeComputeStats.computes;
    // Structural parse only: every entry is indexed and byte-accounted,
    // nothing is unpacked, no B-spline compile touched.
    expect(revived.restoreBinary(bytes, 'rev')).toBe(1_000);
    expect(revived.statsSnapshot().entryCount).toBe(1_000);
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
    const restore = createCachedCompiledRestore({
      documentId: 'doc',
      revision: 'rev',
      cache: revived,
    });
    expect(restore.stats().restored).toBe(0);
    expect(restore.pending()).toBe(1_000);
    // One lazy claim: exactly one unpack, 999 still packed.
    expect(restore.restore(strokeRecord(10, 's7'))).toBe(true);
    expect(restore.stats().restored).toBe(1);
    expect(restore.pending()).toBe(999);
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
  });

  it('unpacks only on demand, retains packed, and reports counters', () => {
    const cache = new SurfaceDerivedCache();
    const sourceRecord = strokeRecord(60, 's0');
    const compiled = compiledStrokeForRecord(sourceRecord);
    expect(compiled).not.toBeNull();
    cache.storeCompiled(
      derivedCacheKey('doc', 's0', 'rev'),
      packCompiledInk(compiled!).packed,
    );

    const restore = createCachedCompiledRestore({
      documentId: 'doc',
      revision: 'rev',
      cache,
    });
    expect(restore.stats()).toMatchObject({
      restored: 0,
      misses: 0,
      restoreMs: 0,
    });
    expect(restore.pending()).toBe(1);
    expect(restore.available()).toBe(1);

    const target = strokeRecord(60, 's0');
    const computesBefore = compiledStrokeComputeStats.computes;
    expect(restore.restore(target)).toBe(true);
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
    expect(restore.stats().restored).toBe(1);
    expect(restore.stats().misses).toBe(0);
    expect(restore.pending()).toBe(0);
    // Retained packed rides alongside the compiled geometry for reuse.
    expect(packedCompiledForRecord(target)).toBeDefined();
    // Never restores the same object twice.
    expect(restore.restore(target)).toBe(false);
    expect(restore.stats().misses).toBe(1);
  });

  it('corrupt payloads are lazy safe misses (Worker recompiles)', () => {
    const cache = new SurfaceDerivedCache();
    const packed = packedStroke(40);
    packed.nodeXY[0] = Number.NaN;
    // The invalid payload is rejected by the eager store gate...
    cache.storeCompiled(derivedCacheKey('doc', 's0', 'rev'), packed);
    expect(
      cache.loadCompiled(derivedCacheKey('doc', 's0', 'rev')),
    ).toBeUndefined();
    // ...and by the lazy source when structurally plausible corrupt data
    // is forced in via container restore (deferred validation).
    const container = new SurfaceDerivedCache();
    const good = packedStroke(40);
    container.storeCompiled(derivedCacheKey('doc', 's0', 'rev'), good);
    const bytes = container.serializeBinary('rev');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // First compiled entry: magic(4)+version(4)+count(4)+kind(1)+key+meta+len
    // is expensive to locate here; instead flip a byte inside the first
    // Float64 payload via the documented offset helper shape (skip to the
    // first geometry buffer).
    let offset = 12 + 1;
    for (let i = 0; i < 3; i++) {
      const length = view.getUint32(offset, true);
      offset += 4 + length * 2;
    }
    offset += 8 + 4 + 4 + 4 + 4 + 4 + 1;
    const extras = view.getUint8(offset);
    offset += 1;
    if (extras === 1) {
      const length = view.getUint32(offset, true);
      offset += 4 + length * 2;
    }
    offset += 4;
    view.setFloat64(offset, Number.NaN, true);
    const lazyCache = new SurfaceDerivedCache();
    expect(lazyCache.restoreBinary(bytes, 'rev')).toBe(1);
    const restore = createCachedCompiledRestore({
      documentId: 'doc',
      revision: 'rev',
      cache: lazyCache,
    });
    const target = strokeRecord(40, 's0');
    expect(restore.restore(target)).toBe(false);
    expect(restore.stats().misses).toBe(1);
    // Canonical demand compilation still works (safe miss).
    expect(compiledStrokeForRecord(target)).not.toBeNull();
  });

  it('revision mismatch never restores', () => {
    const cache = new SurfaceDerivedCache();
    const compiled = compiledStrokeForRecord(strokeRecord(40, 's0'));
    cache.storeCompiled(
      derivedCacheKey('doc', 's0', 'rev-1'),
      packCompiledInk(compiled!).packed,
    );
    const restore = createCachedCompiledRestore({
      documentId: 'doc',
      revision: 'rev-2',
      cache,
    });
    expect(restore.restore(strokeRecord(40, 's0'))).toBe(false);
    expect(restore.stats().misses).toBe(1);
  });

  it('async preparation restores a deferred huge stroke with zero compiles', async () => {
    // The record carries over-budget canonical samples but is never
    // compiled: the packed payload is a cheap template filed under the
    // record's key, which is exactly what a persisted entry is.
    const model = strokeModel(8_000, 's0');
    const template = compiledStrokeForRecord(strokeRecord(40, 'template'));
    expect(template).not.toBeNull();
    const cache = new SurfaceDerivedCache();
    cache.storeCompiled(
      derivedCacheKey('doc', 's0', 'rev'),
      packCompiledInk(template!).packed,
    );
    const restore = createCachedCompiledRestore({
      documentId: 'doc',
      revision: 'rev',
      cache,
    });
    const scene = new IncrementalSceneCache();
    scene.setCompiledRestoreSource(restore);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const computesBefore = compiledStrokeComputeStats.computes;
    // Deferred over-budget stroke: the async lane must consult the cache
    // BEFORE the Worker/fallback compiler.
    const ready = await scene.prepareOneAsync(model, registry, 's0');
    expect(ready).toBe(true);
    expect(restore.stats().restored).toBe(1);
    expect(restore.stats().misses).toBe(0);
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
  });
});

describe('persistence reuses retained packed geometry', () => {
  it('rebases retained packed vectors without repacking', () => {
    const model = strokeModel(80, 's0');
    const record = model.objects['s0']!;
    const compiled = compiledStrokeForRecord(record);
    expect(compiled).not.toBeNull();
    const packed = packCompiledInk(compiled!).packed;
    setCompiledForRecord(record, compiled!, packed);
    accumulateDerivedTranslation(model, ['s0'], 37.5, -18.25);
    const computesBefore = compiledStrokeComputeStats.computes;

    const cache = new SurfaceDerivedCache();
    const stats = persistWarmCompiledGeometry({
      documentId: 'doc',
      revision: 'rev',
      model,
      cache,
    });
    expect(stats.stores).toBe(1);
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);

    const hit = cache.loadCompiled(derivedCacheKey('doc', 's0', 'rev'));
    expect(hit).toBeDefined();
    const world = unpackCompiledInk(hit!);
    expect(world.nodes[0]!.x).toBeCloseTo(compiled!.nodes[0]!.x + 37.5, 9);
    expect(world.nodes[0]!.y).toBeCloseTo(compiled!.nodes[0]!.y - 18.25, 9);
    // The retained local copy was never mutated by persistence.
    expect(packed.nodeXY[0]).toBe(compiled!.nodes[0]!.x);
  });

  it('collectPersistEntries bounds by bytes and prefers retained packed', () => {
    const model = strokeModel(40, 's0');
    const record = model.objects['s0']!;
    const compiled = compiledStrokeForRecord(record);
    const packed = packCompiledInk(compiled!).packed;
    setCompiledForRecord(record, compiled!, packed);
    const entries = collectPersistEntries({
      documentId: 'doc',
      revision: 'rev',
      warm: [record],
      cache: new SurfaceDerivedCache(),
      maxBytes: packedCompiledByteLength(packed) - 1,
      maxEntries: 10,
    });
    expect(entries).toEqual([]);
    const fitted = collectPersistEntries({
      documentId: 'doc',
      revision: 'rev',
      warm: [record],
      cache: new SurfaceDerivedCache(),
    });
    expect(fitted).toHaveLength(1);
    expect(fitted[0]!.transfer).toBe(false);
  });
});

describe('off-main-thread persistence packing (cooperative parity)', () => {
  it('produces the same container as the in-memory serializer', async () => {
    const cache = new SurfaceDerivedCache();
    const compiled = compiledStrokeForRecord(strokeRecord(40, 's0'));
    cache.storeCompiled(
      derivedCacheKey('doc', 's0', 'rev'),
      packCompiledInk(compiled!).packed,
    );
    cache.storeBounds(derivedCacheKey('doc', 's0', 'rev'), {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    const request: DerivedCachePackRequest = {
      documentId: 'doc',
      revision: 'rev',
      bounds: cache.boundsEntries('rev'),
      compiled: cache.compiledEntries('rev').map((entry) => ({
        key: entry.key,
        packed: entry.packed,
        tx: 0,
        ty: 0,
        transfer: false,
      })),
    };
    const packed = await packDerivedCacheOnMain(request, async () => {
      await Promise.resolve();
    });
    expect(packed).toEqual(cache.serializeBinary('rev'));
  });

  it('rebases local entries during off-thread packing', async () => {
    const direct = new SurfaceDerivedCache();
    const compiled = compiledStrokeForRecord(strokeRecord(40, 's0'));
    direct.storeCompiled(
      derivedCacheKey('doc', 's0', 'rev'),
      packCompiledInk(compiled!, { tx: 5, ty: -2 }).packed,
    );
    const local = new SurfaceDerivedCache();
    local.storeCompiled(
      derivedCacheKey('doc', 's0', 'rev'),
      packCompiledInk(compiled!).packed,
    );
    const request: DerivedCachePackRequest = {
      documentId: 'doc',
      revision: 'rev',
      bounds: [],
      compiled: local.compiledEntries('rev').map((entry) => ({
        key: entry.key,
        packed: entry.packed,
        tx: 5,
        ty: -2,
        transfer: false,
      })),
    };
    const bytes = await packDerivedCacheOnMain(request, async () => {
      await Promise.resolve();
    });
    expect(bytes).toEqual(direct.serializeBinary('rev'));
  });
});

describe('queued persistence revalidates at execution time', () => {
  function bindingFor(input: {
    store: DerivedReopenStore;
    isDirty: () => boolean;
    revision: () => string | null;
  }): SurfaceReopenBinding {
    return {
      store: input.store,
      documentId: 'doc',
      getContentRevision: input.revision,
      isDirty: input.isDirty,
    };
  }

  it('discards a job that becomes dirty before the queued work runs', async () => {
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port, {
      createPacker: () => null,
    });
    const model = strokeModel(80, 's0');
    expect(compiledStrokeForRecord(model.objects['s0']!)).not.toBeNull();
    let dirty = false;
    const binding = bindingFor({
      store,
      isDirty: () => dirty,
      revision: () => 'rev-1',
    });
    expect(persistLiveReopenGeometry(binding, model)).toBe('rev-1');
    // Clean at schedule time, dirty when the queued job starts.
    dirty = true;
    await store.flushPending();
    expect(port.saved.has('doc')).toBe(false);
  });

  it('discards an R0 job when the live revision moves to R1', async () => {
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port, {
      createPacker: () => null,
    });
    const model = strokeModel(80, 's0');
    expect(compiledStrokeForRecord(model.objects['s0']!)).not.toBeNull();
    let revision = 'R0';
    const binding = bindingFor({
      store,
      isDirty: () => false,
      revision: () => revision,
    });
    expect(persistLiveReopenGeometry(binding, model)).toBe('R0');
    revision = 'R1';
    await store.flushPending();
    expect(port.saved.has('doc')).toBe(false);
  });

  it('persists when clean and the revision is unchanged', async () => {
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port, {
      createPacker: () => null,
    });
    const model = strokeModel(80, 's0');
    const record = model.objects['s0']!;
    const compiled = compiledStrokeForRecord(record);
    expect(compiled).not.toBeNull();
    // Background packing completed (retained) — teardown persists without
    // sync packing (closure-pass ownership).
    setCompiledForRecord(record, compiled!, packCompiledInk(compiled!).packed);
    const binding = bindingFor({
      store,
      isDirty: () => false,
      revision: () => 'rev-1',
    });
    expect(persistLiveReopenGeometry(binding, model)).toBe('rev-1');
    await store.flushPending();
    expect(port.saved.has('doc')).toBe(true);
    // Truly-lazy durable: manifest + on-demand entry (never whole-cache).
    const cache = store.acquire('doc', 'rev-1');
    expect(await store.hydrate('doc')).toBe(true);
    expect(await store.loadDurableEntry('doc', 'rev-1', 's0')).toBeDefined();
    expect(
      cache.loadCompiled(derivedCacheKey('doc', 's0', 'rev-1')),
    ).toBeDefined();
  });

  it('keeps the count ceiling default secondary', () => {
    expect(DERIVED_CACHE_MAX_COMPILED).toBe(256);
  });
});
