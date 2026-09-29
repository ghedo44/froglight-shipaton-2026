/**
 * Derived-cache reopen tests (conservative bounds-first).
 *
 * The cache is never authoritative: every behavior below must fall back
 * to decode seeds — revision mismatch, schema mismatch, corrupt payload,
 * absent entries — without mutating canonical data or breaking the open.
 */

import { describe, expect, it } from 'vitest';
import { checksumOf } from '../revisions.js';
import {
  SurfaceDerivedCache,
  derivedCacheKey,
  DERIVED_CACHE_VERSION,
} from './derived-cache.js';
import { DerivedReopenStore, resolveReopenSeeds } from './derived-reopen.js';
import {
  SURFACE_CANONICAL_CHECKSUM_KEY,
  SURFACE_SEED_BOUNDS_KEY,
} from './open-metadata.js';
import { DOCUMENT_CONTENT_REVISION_KEY } from '../documents.js';
import { decodeSurfacePayload, encodeSurfacePayload } from './codec.js';
import { inkPageKind, inkPageKindId } from './kind.js';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  type SurfaceModel,
} from './model.js';
import type { Bounds } from './geometry.js';
import { generateDocumentId, generateResourceId } from '../identity.js';

function model(): SurfaceModel {
  const m = emptySurface(boundedFrame(2000, 2000));
  for (let i = 0; i < 4; i++) {
    const id = `s${i}`;
    const points: { x: number; y: number }[] = [];
    for (let k = 0; k < 10; k++) points.push({ x: i * 100 + k * 3, y: 50 });
    m.objects[id] = inkStrokeObject(id, { points, width: 3 });
    m.order.push(id);
  }
  return m;
}

function decodeSeeds(m: SurfaceModel): ReadonlyMap<string, Bounds | null> {
  return decodeSurfacePayload(encodeSurfacePayload(m)).seedBounds;
}

describe('resolveReopenSeeds', () => {
  it('misses everything on first open and backfills the cache', () => {
    const cache = new SurfaceDerivedCache();
    const seeds = decodeSeeds(model());
    const first = resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache,
    });
    expect(first.stats).toEqual({ hits: 0, misses: 4, stores: 4 });
    expect(first.seeds).toEqual(seeds);
    // Second open with the same revision hits everything.
    const second = resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache,
    });
    expect(second.stats).toEqual({ hits: 4, misses: 0, stores: 0 });
    expect(second.seeds).toEqual(seeds);
  });

  it('a valid cache entry wins over differing decode seeds', () => {
    const cache = new SurfaceDerivedCache();
    const cached: Bounds = { x: 1, y: 2, width: 30, height: 40 };
    cache.storeBounds(derivedCacheKey('doc-1', 's0', 'rev-1'), cached);
    const seeds = new Map<string, Bounds | null>([
      ['s0', { x: 100, y: 200, width: 5, height: 5 }],
    ]);
    const resolved = resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache,
    });
    expect(resolved.seeds.get('s0')).toEqual(cached);
    expect(resolved.stats.hits).toBe(1);
  });

  it('canonical revision mismatch ignores the cache', () => {
    const cache = new SurfaceDerivedCache();
    const seeds = decodeSeeds(model());
    resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache,
    });
    // Same document, new canonical bytes: every entry misses and the
    // fresh decode seeds backfill under the new revision.
    const next = resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-2',
      decodeSeeds: seeds,
      cache,
    });
    expect(next.stats).toEqual({ hits: 0, misses: 4, stores: 4 });
    expect(next.seeds).toEqual(seeds);
  });

  it('schema/compiler mismatch restores nothing and falls back', () => {
    const cache = new SurfaceDerivedCache();
    const seeds = decodeSeeds(model());
    resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache,
    });
    const bytes = cache.serializeBinary();
    // Tamper the container version: entries from another compiler/schema
    // era must never restore.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(4, DERIVED_CACHE_VERSION + 999, true);
    const cache2 = new SurfaceDerivedCache();
    expect(cache2.restoreBinary(bytes)).toBe(0);
    const resolved = resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache: cache2,
    });
    expect(resolved.stats).toEqual({ hits: 0, misses: 4, stores: 4 });
  });

  it('corrupt cache payloads fall back safely', () => {
    const cache = new SurfaceDerivedCache();
    expect(cache.restoreBinary(new Uint8Array(0))).toBe(0);
    expect(cache.restoreBinary(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBe(0);
    expect(cache.restoreBinary(new Uint8Array([0, 1, 2]))).toBe(0);
    const seeds = decodeSeeds(model());
    const resolved = resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache,
    });
    expect(resolved.stats).toEqual({ hits: 0, misses: 4, stores: 4 });
    expect(resolved.seeds).toEqual(seeds);
  });

  it('never mutates the decode-seed input', () => {
    const cache = new SurfaceDerivedCache();
    const seeds = decodeSeeds(model());
    const before = new Map(seeds);
    cache.storeBounds(derivedCacheKey('doc-1', 's1', 'rev-1'), {
      x: 7,
      y: 7,
      width: 7,
      height: 7,
    });
    resolveReopenSeeds({
      documentId: 'doc-1',
      revision: 'rev-1',
      decodeSeeds: seeds,
      cache,
    });
    expect([...seeds.entries()]).toEqual([...before.entries()]);
  });
});

describe('DerivedReopenStore', () => {
  it('returns the same cache for the same revision', () => {
    const store = new DerivedReopenStore();
    const a = store.acquire('doc-1', 'rev-1');
    expect(store.acquire('doc-1', 'rev-1')).toBe(a);
    expect(store.size).toBe(1);
  });

  it('a revision change retires the whole document entry set', () => {
    const store = new DerivedReopenStore();
    const cache = store.acquire('doc-1', 'rev-1');
    cache.storeBounds(derivedCacheKey('doc-1', 's0', 'rev-1'), {
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    });
    const same = store.acquire('doc-1', 'rev-2');
    expect(same).toBe(cache);
    expect(
      same.loadBounds(derivedCacheKey('doc-1', 's0', 'rev-1')),
    ).toBeUndefined();
    expect(
      same.loadBounds(derivedCacheKey('doc-1', 's0', 'rev-2')),
    ).toBeUndefined();
  });

  it('evicts oldest documents past the cap and tracks evictions', () => {
    const store = new DerivedReopenStore(3);
    store.acquire('a', 'r');
    store.acquire('b', 'r');
    store.acquire('c', 'r');
    expect(store.size).toBe(3);
    store.acquire('d', 'r');
    expect(store.size).toBe(3);
    expect(store.statsSnapshot()).toMatchObject({ documents: 3, evictions: 1 });
    // Reacquiring an evicted document creates a fresh cache.
    const fresh = store.acquire('a', 'r');
    expect(fresh.statsSnapshot()).toMatchObject({
      hits: 0,
      misses: 0,
      stores: 0,
      invalidations: 0,
      compiledHits: 0,
      compiledMisses: 0,
      compiledStores: 0,
      compiledEvictions: 0,
      byteEvictions: 0,
      compiledBytes: 0,
      entryCount: 0,
    });
  });

  it('evict and clear drop entries', () => {
    const store = new DerivedReopenStore();
    store.acquire('a', 'r');
    store.acquire('b', 'r');
    store.evict('a');
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('content revision ownership (session layer, not decoders)', () => {
  it('ink decode performs no whole-file checksum pass of its own', () => {
    const m = model();
    const bytes = encodeSurfacePayload(m);
    const ref = {
      documentId: generateDocumentId(),
      kindId: inkPageKindId,
      location: { resourceId: generateResourceId() },
    };
    const first = inkPageKind.decode(bytes, ref);
    // The decoder contributes seeds only — no revision token (the session
    // owns the canonical bytes and supplies the revision once per open).
    expect(
      first.openMetadata?.[SURFACE_CANONICAL_CHECKSUM_KEY],
    ).toBeUndefined();
    expect(first.openMetadata?.[DOCUMENT_CONTENT_REVISION_KEY]).toBeUndefined();
    expect(first.openMetadata?.[SURFACE_SEED_BOUNDS_KEY]).toBeDefined();
    // Canonical metadata stays clean (seeds are disposable open data).
    expect(first.metadata).toEqual({});
    // Cache validation still retires entries whenever canonical bytes
    // change — keyed by the session-supplied revision, not a decoder scan.
    m.objects['extra'] = inkStrokeObject('extra', {
      points: [
        { x: 1, y: 1 },
        { x: 9, y: 9 },
      ],
      width: 2,
    });
    m.order.push('extra');
    const bytes2 = encodeSurfacePayload(m);
    expect(checksumOf(bytes2)).not.toBe(checksumOf(bytes));
  });
});
