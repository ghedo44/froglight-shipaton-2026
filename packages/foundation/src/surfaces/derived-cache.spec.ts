/**
 * Persistent packed compiled-geometry cache tests (final scalability pass;
 * binary durable container; live revision ownership; async persistence).
 *
 * The derived cache stores the SAME packed representation the Worker
 * produces, keyed by (document identity, canonical content revision,
 * object identity, Ink compiler version, cache schema version):
 *
 * ```text
 * valid revision → hit (zero B-spline compiles on reopen)
 * changed revision → miss
 * changed compiler version → miss
 * corrupt payload → miss (never breaks opening)
 * binary serialize → restore → hit (durable across provider restarts)
 * ```
 *
 * The cache is never authoritative: every miss falls back to decode
 * seeds + Worker recompile without mutating canonical data. Durable
 * persistence is queued (never synchronous at teardown) and jobs whose
 * revision moved on are discarded.
 */

import { describe, expect, it } from 'vitest';
import {
  SurfaceDerivedCache,
  derivedCacheKey,
  DERIVED_CACHE_MAX_COMPILED,
  DERIVED_CACHE_VERSION,
} from './derived-cache.js';
import type { DerivedCacheKey } from './derived-cache.js';
import {
  INK_COMPILER_VERSION,
  accumulateDerivedTranslation,
  createDefaultSurfaceObjectTypeRegistry,
  inkStrokeCompiledBounds,
  smoothSpineOfRecord,
} from './objects.js';
import {
  DerivedReopenStore,
  persistWarmCompiledGeometry,
  persistenceTripwires,
  restoreCachedCompiledGeometry,
  type DerivedCacheStoragePort,
} from './derived-reopen.js';
import { packCompiledInk, unpackCompiledInk } from './ink/packed-protocol.js';
import {
  compiledStrokeComputeStats,
  compiledStrokeForRecord,
  setCompiledForRecord,
} from './objects.js';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  SURFACE_OBJECT_TYPES,
  type SurfaceModel,
} from './model.js';
import { decodeSurfacePayload, encodeSurfacePayload } from './codec.js';

function strokeModel(ids: readonly string[], samples: number): SurfaceModel {
  const model = emptySurface(boundedFrame(4000, 4000));
  ids.forEach((id, index) => {
    const points: { x: number; y: number; pressure: number; dt: number }[] = [];
    for (let i = 0; i < samples; i++) {
      points.push({
        x: index * 300 + i * 2,
        y: 100 + Math.sin(i / 5) * 8,
        pressure: 0.5,
        dt: i * 8,
      });
    }
    model.objects[id] = inkStrokeObject(id, { points, width: 3 });
    model.order.push(id);
  });
  return model;
}

function warm(model: SurfaceModel, id: string): void {
  const record = model.objects[id]!;
  const compiled = compiledStrokeForRecord(record);
  expect(compiled).not.toBeNull();
  // Simulate background packing completed (closure pass ownership): live
  // strokes render immediately via rich compile, then the low-priority lane
  // retains a reusable packed copy so teardown persists without sync packing.
  // Tests that specifically need unpacked live records (skipped at teardown)
  // construct rich-only warmth via `compiledStrokeForRecord` directly.
  const packed = packCompiledInk(compiled!).packed;
  setCompiledForRecord(record, compiled!, packed);
}

/** Simulate the controller's rigid-translation commit: canonical rewrite
 * plus derived-translation accumulation (compiled geometry stays local). */
function translateRecord(
  model: SurfaceModel,
  id: string,
  dx: number,
  dy: number,
): void {
  const record = model.objects[id]!;
  createDefaultSurfaceObjectTypeRegistry().get(SURFACE_OBJECT_TYPES.stroke)!
    .translate!(record, dx, dy);
  accumulateDerivedTranslation(model, [id], dx, dy);
}

describe('persistent packed compiled-geometry cache', () => {
  it('valid revision hits; changed revision and compiler miss', () => {
    const model = strokeModel(['s0'], 60);
    warm(model, 's0');
    const cache = new SurfaceDerivedCache();
    const key = derivedCacheKey('doc-1', 's0', 'rev-1');
    const compiled = compiledStrokeForRecord(model.objects['s0']!);
    cache.storeCompiled(key, packCompiledInk(compiled!).packed);

    // Hit: identical geometry, no recompile.
    const hit = cache.loadCompiled(key);
    expect(hit).toBeDefined();
    expect(unpackCompiledInk(hit!).nodes).toEqual(compiled!.nodes);
    const stats = cache.statsSnapshot();
    expect(stats.compiledHits).toBe(1);
    expect(stats.compiledStores).toBe(1);

    // Changed canonical revision misses.
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-2')),
    ).toBeUndefined();
    // Changed compiler version misses (never reuse across upgrades).
    const staleCompiler: DerivedCacheKey = {
      ...key,
      compilerVersion: INK_COMPILER_VERSION + 1,
    };
    expect(cache.loadCompiled(staleCompiler)).toBeUndefined();
    // Unknown object misses.
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 'missing', 'rev-1')),
    ).toBeUndefined();
  });

  it('corrupt entries miss and are dropped, never breaking opens', () => {
    const model = strokeModel(['s0'], 60);
    warm(model, 's0');
    const cache = new SurfaceDerivedCache();
    const key = derivedCacheKey('doc-1', 's0', 'rev-1');
    const compiled = compiledStrokeForRecord(model.objects['s0']!);
    const { packed } = packCompiledInk(compiled!);
    cache.storeCompiled(key, packed);
    // Corrupt the stored payload in place (bit rot / truncated write).
    packed.nodeXY[0] = Number.NaN;
    expect(cache.loadCompiled(key)).toBeUndefined();
    // Dropped: a second load misses cleanly (no poisoned entry).
    expect(cache.loadCompiled(key)).toBeUndefined();
    const stats = cache.statsSnapshot();
    expect(stats.compiledMisses).toBe(2);
    expect(stats.invalidations).toBeGreaterThanOrEqual(1);
  });

  it('binary serialize/restore round-trips packed geometry', () => {
    const model = strokeModel(['s0', 's1'], 60);
    warm(model, 's0');
    warm(model, 's1');
    const cache = new SurfaceDerivedCache();
    for (const id of ['s0', 's1']) {
      const compiled = compiledStrokeForRecord(model.objects[id]!);
      cache.storeCompiled(
        derivedCacheKey('doc-1', id, 'rev-1'),
        packCompiledInk(compiled!).packed,
      );
    }
    cache.storeBounds(derivedCacheKey('doc-1', 's0', 'rev-1'), {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    const bytes = cache.serializeBinary();
    // The container is binary and compact: raw Float64 geometry is written
    // verbatim (no base64 expansion, no JSON number parsing).
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeLessThan(JSON.stringify([...bytes]).length);

    const revived = new SurfaceDerivedCache();
    // Two compiled entries + one bounds entry restore.
    expect(revived.restoreBinary(bytes)).toBe(3);
    const back = revived.loadCompiled(derivedCacheKey('doc-1', 's1', 'rev-1'));
    expect(back).toBeDefined();
    const original = compiledStrokeForRecord(model.objects['s1']!);
    expect(unpackCompiledInk(back!).nodes).toEqual(original!.nodes);
    expect(revived.loadBounds(derivedCacheKey('doc-1', 's0', 'rev-1'))).toEqual(
      { x: 1, y: 2, width: 3, height: 4 },
    );
  });

  it('serialize filters to the requested revision', () => {
    const cache = new SurfaceDerivedCache();
    cache.storeBounds(derivedCacheKey('doc-1', 's0', 'rev-1'), null);
    cache.storeBounds(derivedCacheKey('doc-1', 's0', 'rev-2'), {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    const onlyRev2 = cache.serializeBinary('rev-2');
    const revived = new SurfaceDerivedCache();
    expect(revived.restoreBinary(onlyRev2, 'rev-2')).toBe(1);
    expect(revived.restoreBinary(onlyRev2, 'rev-1')).toBe(0);
  });

  it('stale, truncated, and corrupt containers restore nothing', () => {
    const cache = new SurfaceDerivedCache();
    expect(cache.restoreBinary(new Uint8Array(0))).toBe(0);
    expect(
      cache.restoreBinary(new TextEncoderless().bytes('not a cache')),
    ).toBe(0);
    // Stale cache-format version (patch the u32 after the magic).
    const model = strokeModel(['s0'], 40);
    warm(model, 's0');
    const source = new SurfaceDerivedCache();
    source.storeCompiled(
      derivedCacheKey('doc-1', 's0', 'rev-1'),
      packCompiledInk(compiledStrokeForRecord(model.objects['s0']!)!).packed,
    );
    const valid = source.serializeBinary();
    const view = new DataView(valid.buffer, valid.byteOffset, valid.byteLength);
    view.setUint32(4, DERIVED_CACHE_VERSION + 99, true);
    expect(new SurfaceDerivedCache().restoreBinary(valid)).toBe(0);
    // Truncated container.
    expect(new SurfaceDerivedCache().restoreBinary(valid.slice(0, 12))).toBe(0);
    // A flipped non-finite byte inside packed geometry is discovered
    // LAZILY: the container structurally restores (hydration stays a
    // cheap index load) but the corrupt entry is a safe miss on first
    // use — never partial derived geometry.
    const corrupted = source.serializeBinary();
    const packedOffset = bytesOf(corrupted, 'nodeXY');
    const corruptView = new DataView(
      corrupted.buffer,
      corrupted.byteOffset,
      corrupted.byteLength,
    );
    corruptView.setFloat64(packedOffset, Number.NaN, true);
    const lazy = new SurfaceDerivedCache();
    expect(lazy.restoreBinary(corrupted)).toBe(1);
    expect(
      lazy.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
    // Dropped: a second load misses cleanly (no poisoned entry).
    expect(
      lazy.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
  });

  it('bounds the compiled slot with oldest-first eviction', () => {
    const cache = new SurfaceDerivedCache();
    const model = strokeModel(['s0'], 20);
    warm(model, 's0');
    const compiled = compiledStrokeForRecord(model.objects['s0']!);
    const { packed } = packCompiledInk(compiled!);
    for (let i = 0; i < DERIVED_CACHE_MAX_COMPILED + 10; i++) {
      cache.storeCompiled(derivedCacheKey('doc-1', `s${i}`, 'rev-1'), packed);
    }
    const stats = cache.statsSnapshot();
    expect(stats.compiledEvictions).toBe(10);
    // Newest entries survive; oldest evicted.
    expect(
      cache.loadCompiled(
        derivedCacheKey('doc-1', `s${DERIVED_CACHE_MAX_COMPILED + 9}`, 'rev-1'),
      ),
    ).toBeDefined();
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
  });

  it('invalidation drops compiled entries with bounds', () => {
    const model = strokeModel(['s0'], 40);
    warm(model, 's0');
    const cache = new SurfaceDerivedCache();
    const compiled = compiledStrokeForRecord(model.objects['s0']!);
    cache.storeCompiled(
      derivedCacheKey('doc-1', 's0', 'rev-1'),
      packCompiledInk(compiled!).packed,
    );
    cache.storeBounds(derivedCacheKey('doc-1', 's0', 'rev-1'), null);
    cache.invalidateObject('doc-1', 's0');
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
    cache.storeCompiled(
      derivedCacheKey('doc-1', 's0', 'rev-1'),
      packCompiledInk(compiled!).packed,
    );
    cache.invalidateDocument('doc-1');
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
    cache.clear();
    expect(cache.statsSnapshot().compiledHits).toBe(0);
  });
});

/** Minimal no-TextEncoder byte builder (foundation builds with lib es2022). */
class TextEncoderless {
  bytes(value: string): Uint8Array {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }
}

/** Locate the byte offset of a named packed field inside a container. */
function bytesOf(container: Uint8Array, _field: string): number {
  // Container layout: magic(4) version(4) count(4) kind(1) key fields.
  // The first compiled entry's first F64 array is nodeXY; find the run of
  // its length prefix by scanning for the known node count is brittle, so
  // the caller only needs *some* offset inside the first geometry buffer.
  // Header + key: 12 + 1 + (3 strings + 2 u32) — compute directly.
  const view = new DataView(
    container.buffer,
    container.byteOffset,
    container.byteLength,
  );
  let offset = 12;
  offset += 1; // kind
  for (let i = 0; i < 3; i++) {
    const length = view.getUint32(offset, true);
    offset += 4 + length * 2;
  }
  offset += 8; // compilerVersion + cacheVersion
  // Skip version/nodeCount/controlCount/cornerCount/segmentCount/dotPresent.
  offset += 4 + 4 + 4 + 4 + 4 + 1;
  const extras = view.getUint8(offset);
  offset += 1;
  if (extras === 1) {
    const length = view.getUint32(offset, true);
    offset += 4 + length * 2;
  }
  // First packed field length prefix.
  offset += 4;
  return offset;
}

describe('reopen through a storage port (durable across restarts)', () => {
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
    };
  }

  it('valid revision restores vectors with zero recompiles', async () => {
    const port = memoryPort();
    const first = new DerivedReopenStore(32, port);
    const model = strokeModel(['s0', 's1'], 80);
    // First open: cold compiles (Worker in production, sync here).
    const computesBefore = compiledStrokeComputeStats.computes;
    warm(model, 's0');
    warm(model, 's1');
    expect(compiledStrokeComputeStats.computes - computesBefore).toBe(2);
    // Teardown persists warm vectors (queued) + flushes to durable storage
    // (truly-lazy manifest + per-entry records, not a monolithic container).
    const cache = first.acquire('doc-1', 'rev-1');
    const persisted = persistWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model,
      cache,
    });
    expect(persisted.stores).toBe(2);
    first.persist('doc-1');
    await first.flushPending();
    expect(port.saved.has('doc-1')).toBe(true);

    // Provider restart: fresh store, same durable port, fresh records.
    // Truly-lazy open loads ONLY the manifest/index (cheap), then fetches
    // packed entries on demand (viewport priority) — never the whole cache.
    const second = new DerivedReopenStore(32, port);
    const reopened = strokeModel(['s0', 's1'], 80);
    second.acquire('doc-1', 'rev-1');
    expect(await second.hydrate('doc-1')).toBe(true);
    for (const id of ['s0', 's1']) {
      expect(
        await second.loadDurableEntry('doc-1', 'rev-1', id),
      ).not.toBeNull();
    }
    const cache2 = second.acquire('doc-1', 'rev-1');
    const restored = restoreCachedCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model: reopened,
      cache: cache2,
    });
    expect(restored).toEqual({ hits: 2, misses: 0 });
    // First viewport renders cached vectors: zero new compiles.
    const reopenedComputes = compiledStrokeComputeStats.computes;
    for (const id of ['s0', 's1']) {
      expect(compiledStrokeForRecord(reopened.objects[id]!)).not.toBeNull();
    }
    expect(compiledStrokeComputeStats.computes - reopenedComputes).toBe(0);
    // Restored vectors match the originals exactly.
    for (const id of ['s0', 's1']) {
      expect(compiledStrokeForRecord(reopened.objects[id]!)!.polygon).toEqual(
        compiledStrokeForRecord(model.objects[id]!)!.polygon,
      );
    }
    // Manifest-only open never materialized offscreen geometry: durable
    // reads were exactly the two demanded entries (plus the manifest).
    const stats = second.statsSnapshot();
    expect(stats.durablePackedReads).toBe(2);
    expect(stats.manifestLoads).toBeGreaterThanOrEqual(1);
  });

  it('changed revision misses and recompiles only misses', async () => {
    const port = memoryPort();
    const first = new DerivedReopenStore(32, port);
    const model = strokeModel(['s0'], 60);
    warm(model, 's0');
    const cache = first.acquire('doc-1', 'rev-1');
    persistWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model,
      cache,
    });
    first.persist('doc-1');
    await first.flushPending();

    const second = new DerivedReopenStore(32, port);
    const reopened = strokeModel(['s0'], 60);
    const cache2 = second.acquire('doc-1', 'rev-2');
    const restored = restoreCachedCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-2',
      model: reopened,
      cache: cache2,
    });
    expect(restored).toEqual({ hits: 0, misses: 1 });
  });

  it('corrupt durable payload still opens (decode seeds + recompile)', () => {
    const port = memoryPort();
    port.save('doc-1', new Uint8Array([1, 2, 3, 4, 5]));
    const store = new DerivedReopenStore(32, port);
    // Acquire never throws; the reopen restores nothing.
    const cache = store.acquire('doc-1', 'rev-1');
    const reopened = strokeModel(['s0'], 60);
    const restored = restoreCachedCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model: reopened,
      cache,
    });
    expect(restored).toEqual({ hits: 0, misses: 1 });
    // Canonical document still opens: demand compile works.
    expect(compiledStrokeForRecord(reopened.objects['s0']!)).not.toBeNull();
    // Clearing compiled entries directly is observable as a miss.
    setCompiledForRecord(reopened.objects['s0']!, null);
    void cache;
  });

  it('async host load hydrates entries after acquire', async () => {
    const saved = new Map<string, Uint8Array>();
    const source = new DerivedReopenStore(32, {
      load: (id) => saved.get(id) ?? null,
      save: (id, bytes) => {
        saved.set(id, bytes);
      },
    });
    const model = strokeModel(['s0'], 40);
    warm(model, 's0');
    const key = derivedCacheKey('doc-1', 's0', 'rev-1');
    source
      .acquire('doc-1', 'rev-1')
      .storeCompiled(
        key,
        packCompiledInk(compiledStrokeForRecord(model.objects['s0']!)!).packed,
      );
    source.persist('doc-1');
    await source.flushPending();

    let resolveLoad: (bytes: Uint8Array | null) => void = () => undefined;
    const port: DerivedCacheStoragePort = {
      load: (id) => {
        // Manifest (doc-1) loads async (delayed); per-entry records serve
        // immediately from the saved map (truly-lazy: only demanded entries
        // are read, never the whole cache).
        if (id === 'doc-1') {
          return new Promise<Uint8Array | null>((resolve) => {
            resolveLoad = resolve;
          });
        }
        return saved.get(id) ?? null;
      },
      save: () => undefined,
    };
    const store = new DerivedReopenStore(32, port);
    const cache = store.acquire('doc-1', 'rev-1');
    // Synchronous miss: the durable manifest is still in flight (cheap index
    // only — no geometry materialized).
    expect(cache.loadCompiled(key)).toBeUndefined();
    resolveLoad(saved.get('doc-1') ?? null);
    expect(await store.hydrate('doc-1')).toBe(true);
    // Manifest-only hydration never materializes geometry: still a miss until
    // the demanded entry is fetched (viewport priority).
    expect(cache.loadCompiled(key)).toBeUndefined();
    expect(await store.loadDurableEntry('doc-1', 'rev-1', 's0')).toBeDefined();
    // Demanded entry now serves (packed, validated).
    expect(cache.loadCompiled(key)).toBeDefined();
  });
});

describe('item 5: teardown persistence is asynchronous and discardable', () => {
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

  it('scheduling teardown does no synchronous serialization or packing', async () => {
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port);
    const model = strokeModel(['s0'], 200);
    warm(model, 's0');
    store.acquire('doc-1', 'rev-1');
    store.scheduleWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model,
    });
    // The synchronous caller (editor `destroy()`) returned without any
    // durable writes having run: the job yields before it touches storage.
    // Zero main-thread `packCompiledInk` for teardown (retained-only).
    expect(port.saved.has('doc-1')).toBe(false);
    expect(persistenceTripwires.mainThreadPersistencePacks).toBe(0);
    await store.flushPending();
    // Truly-lazy durable: lightweight manifest + per-entry record (no
    // monolithic container, no whole-cache materialization on open).
    expect(port.saved.has('doc-1')).toBe(true);
    expect(persistenceTripwires.mainThreadPersistencePacks).toBe(0);
    // Demanded entry serves from durable (packed, validated) via a fresh
    // store (manifest-only open + on-demand fetch, never whole-cache).
    const second = new DerivedReopenStore(32, port);
    second.acquire('doc-1', 'rev-1');
    expect(await second.hydrate('doc-1')).toBe(true);
    expect(await second.loadDurableEntry('doc-1', 'rev-1', 's0')).toBeDefined();
  });

  it('packs at most the compiled-slot cap, keeping the topmost records', () => {
    const overCap = DERIVED_CACHE_MAX_COMPILED + 24;
    const ids = Array.from({ length: overCap }, (_, i) => `s${i}`);
    const model = strokeModel(ids, 12);
    for (const id of ids) warm(model, id);
    const cache = new SurfaceDerivedCache();
    const persisted = persistWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model,
      cache,
    });
    // Never packs more than the cache can retain.
    expect(persisted.stores).toBe(DERIVED_CACHE_MAX_COMPILED);
    expect(cache.statsSnapshot().compiledStores).toBe(
      DERIVED_CACHE_MAX_COMPILED,
    );
    // The tail (topmost paint order) survives; the earliest evicts.
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', ids[overCap - 1]!, 'rev-1')),
    ).toBeDefined();
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
  });

  it('discards jobs for obsolete revisions without touching storage', async () => {
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port);
    const model = strokeModel(['s0'], 80);
    warm(model, 's0');
    store.acquire('doc-1', 'rev-1');
    store.scheduleWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model,
    });
    // The document saves before the queued job runs: its revision moves on.
    store.acquire('doc-1', 'rev-2');
    await store.flushPending();
    expect(port.saved.has('doc-1')).toBe(false);
  });

  it('evict removes durable storage', async () => {
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port);
    const model = strokeModel(['s0'], 40);
    warm(model, 's0');
    store.acquire('doc-1', 'rev-1');
    store.scheduleWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model,
    });
    await store.flushPending();
    expect(port.saved.has('doc-1')).toBe(true);
    store.evict('doc-1');
    await store.flushPending();
    expect(port.saved.has('doc-1')).toBe(false);
  });
});

describe('item 2: translated geometry persists at its world position', () => {
  function reopenThrough(bytes: SurfaceModel): SurfaceModel {
    return decodeSurfacePayload(encodeSurfacePayload(bytes)).model;
  }

  it('rebases a translated stroke exactly (no recompile, no offset loss)', () => {
    const model = strokeModel(['s0'], 120);
    warm(model, 's0');
    translateRecord(model, 's0', 37.5, -18.25);
    translateRecord(model, 's0', -4.5, 9.75);
    const originalBounds = inkStrokeCompiledBounds(model.objects['s0']!);
    const originalSpine = smoothSpineOfRecord(model.objects['s0']!);
    const computesBefore = compiledStrokeComputeStats.computes;

    const cache = new SurfaceDerivedCache();
    const stores = persistWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model,
      cache,
    });
    expect(stores.stores).toBe(1);
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);

    // Reopen: canonical bytes already carry the translated samples; the
    // packed copy must land at the exact same world position.
    const reopened = reopenThrough(model);
    const restored = restoreCachedCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-1',
      model: reopened,
      cache,
    });
    expect(restored).toEqual({ hits: 1, misses: 0 });
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
    const reopenedRecord = reopened.objects['s0']!;
    expect(inkStrokeCompiledBounds(reopenedRecord)).toEqual(originalBounds);
    expect(smoothSpineOfRecord(reopenedRecord)).toEqual(originalSpine);
    // Hit-testing resolves at the translated position.
    const mid = originalSpine[Math.floor(originalSpine.length / 2)]!;
    const registry = createDefaultSurfaceObjectTypeRegistry();
    expect(
      registry.get(SURFACE_OBJECT_TYPES.stroke)!.hitTest!(
        reopenedRecord,
        mid.x,
        mid.y,
      ),
    ).toBe(true);
  });

  it('rebases every chunk of a logical (chunked) stroke', () => {
    const oversized = emptySurface(boundedFrame(30000, 2000));
    const points: { x: number; y: number; pressure: number }[] = [];
    for (let i = 0; i < 25_000; i++) {
      points.push({
        x: 200 + i * 0.9,
        y: 900 + Math.sin(i / 40) * 30,
        pressure: 0.5,
      });
    }
    oversized.objects['long-1'] = inkStrokeObject('long-1', {
      points,
      width: 3,
    });
    oversized.order.push('long-1');
    const { model } = decodeSurfacePayload(encodeSurfacePayload(oversized));
    expect(model.order.length).toBeGreaterThan(1);
    for (const id of model.order) warm(model, id);
    for (const id of model.order) translateRecord(model, id, 111.125, -57.5);
    const worldBounds = model.order.map((id) =>
      inkStrokeCompiledBounds(model.objects[id]!),
    );
    const worldSpines = model.order.map((id) =>
      smoothSpineOfRecord(model.objects[id]!),
    );

    const cache = new SurfaceDerivedCache();
    const stores = persistWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-9',
      model,
      cache,
    });
    expect(stores.stores).toBe(model.order.length);
    const reopened = decodeSurfacePayload(encodeSurfacePayload(model)).model;
    const restored = restoreCachedCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-9',
      model: reopened,
      cache,
    });
    expect(restored).toEqual({ hits: model.order.length, misses: 0 });
    model.order.forEach((id, index) => {
      expect(inkStrokeCompiledBounds(reopened.objects[id]!)).toEqual(
        worldBounds[index],
      );
      expect(smoothSpineOfRecord(reopened.objects[id]!)).toEqual(
        worldSpines[index],
      );
    });
  });

  it('never persists translated geometry under a stale revision', () => {
    const model = strokeModel(['s0'], 60);
    warm(model, 's0');
    translateRecord(model, 's0', 12, 8);
    const cache = new SurfaceDerivedCache();
    persistWarmCompiledGeometry({
      documentId: 'doc-1',
      revision: 'rev-2',
      model,
      cache,
    });
    // The old revision has no entry; the new one carries rebased geometry.
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
    expect(
      cache.loadCompiled(derivedCacheKey('doc-1', 's0', 'rev-2')),
    ).toBeDefined();
  });
});
