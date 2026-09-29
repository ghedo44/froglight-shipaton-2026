/**
 * IncrementalSceneCache logical-membership transitions.
 *
 * `update()` must invalidate BOTH the previous prepared key (old ownership
 * via `chunkToKey`) and the current canonical key (new ownership via
 * `logicalIdOf` / record id) for every mutated id, then reconcile every
 * cache structure to current canonical membership. Proves the six
 * transitions (logical→logical, logical→single, logical→non-stroke,
 * single→logical, member deletion, new member joins) plus the L→M→N
 * interaction trace, through observable outputs: prepared joint `points`
 * (joint membership, no rescan), item reference reuse for untouched keys,
 * `isPrepared` keys, and stats (`newlyCompiledObjects`, `fullRebuilds`,
 * `logicalRegroups`). Minimal private introspection (`chunkToKey`,
 * `logicalMembers`) pins the required end-state ownership; no new public
 * API is introduced.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  inkStrokeObject,
  rectangleObject,
  IncrementalSceneCache,
  type PreparedItem,
  type SurfaceModel,
} from './index.js';

function pts(count: number, xBase: number): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    x: xBase + i * 2,
    y: i,
  }));
}

function addChunk(
  model: SurfaceModel,
  id: string,
  xBase: number,
  logicalId: string,
  chunkIndex: number,
): void {
  model.objects[id] = inkStrokeObject(id, {
    points: pts(20, xBase),
    width: 3,
    logicalId,
    chunkIndex,
  });
  model.order.push(id);
}

function addSingle(model: SurfaceModel, id: string, xBase: number): void {
  model.objects[id] = inkStrokeObject(id, {
    points: pts(20, xBase),
    width: 3,
  });
  model.order.push(id);
}

/** Retarget one chunk to a new logical (canonical replacement). */
function retargetChunk(
  model: SurfaceModel,
  id: string,
  xBase: number,
  logicalId: string,
  chunkIndex: number,
): void {
  model.objects[id] = inkStrokeObject(id, {
    points: pts(20, xBase),
    width: 3,
    logicalId,
    chunkIndex,
  });
}

/** Detach one chunk to an independent single (canonical replacement). */
function detachToSingle(model: SurfaceModel, id: string, xBase: number): void {
  model.objects[id] = inkStrokeObject(id, {
    points: pts(20, xBase),
    width: 3,
  });
}

/**
 * Baseline: L=A+B+C (20 samples each), M=D (20), unrelated single U (20).
 * Distinct x bands per chunk so joint membership is directly observable:
 * A:0–38, B:2000–2038, C:4000–4038, D:8000–8038, U:20000–20038.
 */
function membershipModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(100000, 10000));
  addChunk(model, 'A', 0, 'L', 0);
  addChunk(model, 'B', 2000, 'L', 1);
  addChunk(model, 'C', 4000, 'L', 2);
  addChunk(model, 'D', 8000, 'M', 0);
  addSingle(model, 'U', 20000);
  return model;
}

function itemOf(
  ordered: readonly PreparedItem[],
  objectId: string,
): PreparedItem {
  const found = ordered.find(
    (p) => (p.item as { objectId?: unknown }).objectId === objectId,
  );
  if (found === undefined) throw new Error(`missing prepared item ${objectId}`);
  return found;
}

/** Joint membership signal: the prepared stroke item carries joint samples. */
function strokePointCount(
  ordered: readonly PreparedItem[],
  objectId: string,
): number {
  const item = itemOf(ordered, objectId).item as { points?: unknown };
  if (!Array.isArray(item.points))
    throw new Error(`item ${objectId} has no points`);
  return item.points.length;
}

function strokeMaxX(
  ordered: readonly PreparedItem[],
  objectId: string,
): number {
  const item = itemOf(ordered, objectId).item as {
    points?: { x: number }[];
  };
  if (!Array.isArray(item.points))
    throw new Error(`item ${objectId} has no points`);
  return Math.max(...item.points.map((p) => p.x));
}

/** Minimal Foundation-internal ownership introspection (end-state only). */
function cacheOwnership(cache: IncrementalSceneCache): {
  chunkToKey: Map<string, string>;
  logicalMembers: Map<string, Set<string>>;
} {
  return cache as unknown as {
    chunkToKey: Map<string, string>;
    logicalMembers: Map<string, Set<string>>;
  };
}

describe('incremental scene membership: logical→logical invalidates both keys', () => {
  it('B:L→M recompiles L as A+C and M as B+D, reuses U, no full rebuild', () => {
    const model = membershipModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    const before = cache.fullRebuild(model, registry);
    expect(cache.statsSnapshot().fullRebuilds).toBe(1);
    expect(strokePointCount(before, 'L')).toBe(60);
    expect(strokePointCount(before, 'M')).toBe(20);
    const lBefore = itemOf(before, 'L');
    const mBefore = itemOf(before, 'M');
    const uBefore = itemOf(before, 'U');
    expect(cache.isPrepared('L')).toBe(true);
    expect(cache.isPrepared('M')).toBe(true);

    // Mutate B:L→M (canonical replacement, new samples in a fresh band).
    retargetChunk(model, 'B', 6000, 'M', 1);
    const after = cache.update(model, registry, ['B']);
    const stats = cache.statsSnapshot();

    // Both affected keys recompiled exactly once each — nothing else.
    expect(stats.newlyCompiledObjects).toBe(2);
    expect(stats.fullRebuilds).toBe(1);
    expect(stats.oldStrokeCompiles).toBe(0);
    expect(stats.oldStrokeFingerprintScans).toBe(0);
    expect(cache.isPrepared('L')).toBe(true);
    expect(cache.isPrepared('M')).toBe(true);
    expect(cache.isPrepared('U')).toBe(true);

    // Prepared truth: L is A+C (40), M is B+D (40).
    expect(strokePointCount(after, 'L')).toBe(40);
    expect(strokePointCount(after, 'M')).toBe(40);
    // B only in M: L keeps the A/C bands, M carries the fresh B band.
    expect(strokeMaxX(after, 'L')).toBeLessThan(5000);
    expect(strokeMaxX(after, 'M')).toBeGreaterThanOrEqual(8000);

    // Old geometries gone (recompiled), unrelated U reused by reference.
    expect(itemOf(after, 'L')).not.toBe(lBefore);
    expect(itemOf(after, 'M')).not.toBe(mBefore);
    expect(itemOf(after, 'U')).toBe(uBefore);

    // Cache structures reflect current canonical membership.
    const ownership = cacheOwnership(cache);
    expect(ownership.chunkToKey.get('B')).toBe('M');
    expect([...(ownership.logicalMembers.get('L') ?? [])].sort()).toEqual([
      'A',
      'C',
    ]);
    expect([...(ownership.logicalMembers.get('M') ?? [])].sort()).toEqual([
      'B',
      'D',
    ]);
  });
});

describe('incremental scene membership: targeted transitions', () => {
  it('L→single recompiles the survivor L and the detached single', () => {
    const model = membershipModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    const before = cache.fullRebuild(model, registry);
    const mBefore = itemOf(before, 'M');

    detachToSingle(model, 'B', 6000);
    const after = cache.update(model, registry, ['B']);
    const stats = cache.statsSnapshot();

    expect(stats.newlyCompiledObjects).toBe(2);
    expect(stats.fullRebuilds).toBe(1);
    expect(strokePointCount(after, 'L')).toBe(40);
    expect(strokeMaxX(after, 'L')).toBeLessThan(5000);
    // B renders as its own single with its own samples.
    expect(strokePointCount(after, 'B')).toBe(20);
    expect(strokeMaxX(after, 'B')).toBeGreaterThanOrEqual(6000);
    expect(cache.isPrepared('B')).toBe(true);
    // Unrelated M untouched.
    expect(itemOf(after, 'M')).toBe(mBefore);

    const ownership = cacheOwnership(cache);
    expect(ownership.chunkToKey.has('B')).toBe(false);
    expect([...(ownership.logicalMembers.get('L') ?? [])].sort()).toEqual([
      'A',
      'C',
    ]);
  });

  it('L→non-stroke recompiles the survivor L and the replacement shape', () => {
    const model = membershipModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    cache.fullRebuild(model, registry);

    model.objects['B'] = rectangleObject('B', {
      x: 6000,
      y: 0,
      width: 100,
      height: 50,
    });
    const after = cache.update(model, registry, ['B']);
    const stats = cache.statsSnapshot();

    expect(stats.newlyCompiledObjects).toBe(2);
    expect(stats.fullRebuilds).toBe(1);
    expect(strokePointCount(after, 'L')).toBe(40);
    expect(strokeMaxX(after, 'L')).toBeLessThan(5000);
    // B renders as the replacement rectangle, not a stroke.
    const bItem = itemOf(after, 'B').item as { kind?: unknown };
    expect(bItem.kind).toBe('rect');

    const ownership = cacheOwnership(cache);
    expect(ownership.chunkToKey.has('B')).toBe(false);
    expect([...(ownership.logicalMembers.get('L') ?? [])].sort()).toEqual([
      'A',
      'C',
    ]);
  });

  it('single→M recompiles only M and retires the old single entry', () => {
    const model = membershipModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    const before = cache.fullRebuild(model, registry);
    const lBefore = itemOf(before, 'L');

    retargetChunk(model, 'U', 9000, 'M', 1);
    const after = cache.update(model, registry, ['U']);
    const stats = cache.statsSnapshot();

    expect(stats.newlyCompiledObjects).toBe(1);
    expect(stats.fullRebuilds).toBe(1);
    expect(strokePointCount(after, 'M')).toBe(40);
    expect(strokeMaxX(after, 'M')).toBeGreaterThanOrEqual(9000);
    // Unrelated L untouched.
    expect(itemOf(after, 'L')).toBe(lBefore);

    const ownership = cacheOwnership(cache);
    expect(ownership.chunkToKey.get('U')).toBe('M');
    expect([...(ownership.logicalMembers.get('M') ?? [])].sort()).toEqual([
      'D',
      'U',
    ]);
    // The retired single key no longer masks the chunk mapping.
    expect(cache.isPrepared('U')).toBe(false);
    expect(cache.isPrepared('M')).toBe(true);
  });

  it('deleted member recompiles only the survivor logical', () => {
    const model = membershipModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    const before = cache.fullRebuild(model, registry);
    const mBefore = itemOf(before, 'M');
    const uBefore = itemOf(before, 'U');

    delete model.objects['B'];
    model.order = model.order.filter((id) => id !== 'B');
    const after = cache.update(model, registry, ['B']);
    const stats = cache.statsSnapshot();

    expect(stats.newlyCompiledObjects).toBe(1);
    expect(stats.fullRebuilds).toBe(1);
    expect(strokePointCount(after, 'L')).toBe(40);
    expect(strokeMaxX(after, 'L')).toBeLessThan(5000);
    // Unrelated keys untouched.
    expect(itemOf(after, 'M')).toBe(mBefore);
    expect(itemOf(after, 'U')).toBe(uBefore);

    const ownership = cacheOwnership(cache);
    expect(ownership.chunkToKey.has('B')).toBe(false);
    expect([...(ownership.logicalMembers.get('L') ?? [])].sort()).toEqual([
      'A',
      'C',
    ]);
  });

  it('new member joining M recompiles only M', () => {
    const model = membershipModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    const before = cache.fullRebuild(model, registry);
    const lBefore = itemOf(before, 'L');
    const uBefore = itemOf(before, 'U');

    addChunk(model, 'E', 9000, 'M', 1);
    const after = cache.update(model, registry, ['E']);
    const stats = cache.statsSnapshot();

    expect(stats.newlyCompiledObjects).toBe(1);
    expect(stats.fullRebuilds).toBe(1);
    expect(strokePointCount(after, 'M')).toBe(40);
    expect(strokeMaxX(after, 'M')).toBeGreaterThanOrEqual(9000);
    // Unrelated keys untouched.
    expect(itemOf(after, 'L')).toBe(lBefore);
    expect(itemOf(after, 'U')).toBe(uBefore);

    const ownership = cacheOwnership(cache);
    expect(ownership.chunkToKey.get('E')).toBe('M');
    expect([...(ownership.logicalMembers.get('M') ?? [])].sort()).toEqual([
      'D',
      'E',
    ]);
  });
});

describe('incremental scene membership: L→M→N interaction trace', () => {
  it('old L refreshes, intermediate M not stale, current N correct', () => {
    const model = emptySurface(boundedFrame(100000, 10000));
    addChunk(model, 'A', 0, 'L', 0);
    addChunk(model, 'B', 2000, 'L', 1);
    addChunk(model, 'C', 4000, 'L', 2);
    addChunk(model, 'D', 8000, 'M', 0);
    addChunk(model, 'E', 12000, 'N', 0);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    cache.fullRebuild(model, registry);

    // B:L→M before render.
    retargetChunk(model, 'B', 6000, 'M', 1);
    const mid = cache.update(model, registry, ['B']);
    expect(cache.statsSnapshot().newlyCompiledObjects).toBe(2);
    expect(strokePointCount(mid, 'L')).toBe(40);
    expect(strokePointCount(mid, 'M')).toBe(40);
    const mMid = itemOf(mid, 'M');

    // B:M→N before render.
    retargetChunk(model, 'B', 14000, 'N', 1);
    const after = cache.update(model, registry, ['B']);
    const stats = cache.statsSnapshot();

    expect(stats.newlyCompiledObjects).toBe(2);
    expect(stats.fullRebuilds).toBe(1);
    // Old L refreshed (B gone), intermediate M back to D-only (not stale),
    // current N correct (E+B).
    expect(strokePointCount(after, 'L')).toBe(40);
    expect(strokeMaxX(after, 'L')).toBeLessThan(5000);
    expect(strokePointCount(after, 'M')).toBe(20);
    expect(strokeMaxX(after, 'M')).toBeLessThan(9000);
    expect(strokePointCount(after, 'N')).toBe(40);
    expect(strokeMaxX(after, 'N')).toBeGreaterThanOrEqual(14000);
    // Intermediate M recompiled away from the transient joint.
    expect(itemOf(after, 'M')).not.toBe(mMid);

    const ownership = cacheOwnership(cache);
    expect(ownership.chunkToKey.get('B')).toBe('N');
    expect([...(ownership.logicalMembers.get('L') ?? [])].sort()).toEqual([
      'A',
      'C',
    ]);
    expect([...(ownership.logicalMembers.get('M') ?? [])].sort()).toEqual([
      'D',
    ]);
    expect([...(ownership.logicalMembers.get('N') ?? [])].sort()).toEqual([
      'B',
      'E',
    ]);
  });
});

describe('incremental scene membership: no document scan, no full rebuild', () => {
  it('membership updates never enumerate document keys and never regroup', () => {
    const base = membershipModel();
    let keyEnumerations = 0;
    const objects = new Proxy(base.objects, {
      ownKeys(target) {
        keyEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const model: SurfaceModel = { ...base, objects };
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    cache.fullRebuild(model, registry);
    const regroupsAfterOpen = cache.statsSnapshot().logicalRegroups;
    const rebuildsAfterOpen = cache.statsSnapshot().fullRebuilds;

    keyEnumerations = 0;
    retargetChunk(model, 'B', 6000, 'M', 1);
    cache.update(model, registry, ['B']);
    expect(keyEnumerations).toBe(0);
    expect(cache.statsSnapshot().fullRebuilds).toBe(rebuildsAfterOpen);
    expect(cache.statsSnapshot().logicalRegroups).toBe(regroupsAfterOpen);

    keyEnumerations = 0;
    detachToSingle(model, 'C', 7000);
    cache.update(model, registry, ['C']);
    expect(keyEnumerations).toBe(0);
    expect(cache.statsSnapshot().fullRebuilds).toBe(rebuildsAfterOpen);
    expect(cache.statsSnapshot().logicalRegroups).toBe(regroupsAfterOpen);
  });
});
