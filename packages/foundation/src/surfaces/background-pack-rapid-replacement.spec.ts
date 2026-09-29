/**
 *  rapid-replacement regressions: bounded per-record multi-set plus
 * deterministic incremental retirement.
 *
 * Single-slot `replacedOldLogicalByRecordId` lost older unacknowledged
 * logicals on rapid B:L→M→N (second invalidation overwrote L with M), so the
 * commit/prepared rendezvous could no longer match l:L. Per-record pending
 * sets retain ALL still-relevant historiques; explicit ack retires only the
 * acknowledged logicals via the reverse holder index (retirement is
 * proportional to acknowledged historical ownership edges, never
 * O(document)).
 *
 * Driven ONLY via capture→mutate→invalidate +
 * backgroundPackRendezvousKeysForIds + acknowledgeBackgroundPackRendezvousKeys
 * (no schedulers, no manual prepared keys, single invalidation per mutation).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  acknowledgeBackgroundPackRendezvousKeys,
  backgroundPackRendezvousKeysForIds,
  boundedFrame,
  captureGeometryOwnershipForIds,
  emptySurface,
  inkStrokeObject,
  invalidateCompiledForIds,
  logicalGeometryGeneration,
  recordGeometryGeneration,
  resetGeometryGenerationsForTests,
  type SurfaceModel,
} from './index.js';

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

function replaceWithLogical(
  model: SurfaceModel,
  id: string,
  logicalId: string,
  chunkIndex: number,
): void {
  const old = model.objects[id];
  const oldPoints = (
    old as unknown as {
      points: { x: number; y: number; pressure: number; dt: number }[];
    }
  ).points;
  captureGeometryOwnershipForIds(model, [id]);
  model.objects[id] = inkStrokeObject(id, {
    points: oldPoints.map((p) => ({ ...p, x: p.x + 1000 })),
    width: 3,
    logicalId,
    chunkIndex,
  });
  invalidateCompiledForIds(model, [id]);
}

beforeEach(() => {
  resetGeometryGenerationsForTests();
});

describe('rapid L→M→N before prepared ack keeps every survivor', () => {
  it('B:L→M→N yields l:L,l:M,l:N deduped and deterministic', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'LC-A', 'L', 0, 0);
    addChunk(model, 'LC-X', 'L', 1, 2000);
    addChunk(model, 'LC-C', 'L', 2, 4000);

    // Rapid replacements with NO ack in between (both use the single
    // capture→mutate→invalidate boundary, exactly once per mutation).
    replaceWithLogical(model, 'LC-X', 'M', 0);
    replaceWithLogical(model, 'LC-X', 'N', 0);

    const keys = backgroundPackRendezvousKeysForIds(model, ['LC-X']);
    // ALL still-relevant unacknowledged logicals survive: oldest L is not
    // overwritten by the intermediate M.
    expect(keys).toContain('l:L');
    expect(keys).toContain('l:M');
    expect(keys).toContain('l:N');
    // Deduped (no duplicate emission collapses or duplicates a key).
    expect(new Set(keys).size).toBe(keys.length);
    // Deterministic insertion order: pending L,M (oldest first) then current N.
    expect(keys).toEqual(['l:L', 'l:M', 'l:N']);

    // Generation semantics preserved: old+new logicals bump.
    expect(logicalGeometryGeneration(model, 'L')).toBeGreaterThan(0);
    expect(logicalGeometryGeneration(model, 'M')).toBeGreaterThan(0);
    expect(logicalGeometryGeneration(model, 'N')).toBeGreaterThan(0);
    expect(recordGeometryGeneration(model, 'LC-X')).toBeGreaterThan(0);
  });
});

describe('two records leaving one L keep L until its survivor succeeds', () => {
  it('B:L→M and C:L→N share l:L once; unrelated ack never retires it', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'L-A', 'L', 0, 0);
    addChunk(model, 'L-B', 'L', 1, 2000);
    addChunk(model, 'L-C', 'L', 2, 4000);

    replaceWithLogical(model, 'L-B', 'M', 0);
    replaceWithLogical(model, 'L-C', 'N', 0);

    // Each leaver keeps its own pending {L} plus its current unit.
    expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
      'l:L',
      'l:M',
    ]);
    expect(backgroundPackRendezvousKeysForIds(model, ['L-C'])).toEqual([
      'l:L',
      'l:N',
    ]);

    // Joint query dedups the shared L (exactly once) alongside both currents.
    const both = backgroundPackRendezvousKeysForIds(model, ['L-B', 'L-C']);
    expect(both).toEqual(['l:L', 'l:M', 'l:N']);

    // Retirement is precise: acknowledging an unrelated logical or a single
    // key must NOT delete state another record still needs.
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:UNRELATED']);
    expect(backgroundPackRendezvousKeysForIds(model, ['L-B', 'L-C'])).toEqual([
      'l:L',
      'l:M',
      'l:N',
    ]);
    acknowledgeBackgroundPackRendezvousKeys(model, ['r:L-B', 'bogus']);
    expect(backgroundPackRendezvousKeysForIds(model, ['L-B', 'L-C'])).toEqual([
      'l:L',
      'l:M',
      'l:N',
    ]);

    // After L's surviving A publication succeeds, BOTH holders retire L at
    // once (satisfied together), while their own currents remain.
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:L']);
    expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual(['l:M']);
    expect(backgroundPackRendezvousKeysForIds(model, ['L-C'])).toEqual(['l:N']);
    expect(backgroundPackRendezvousKeysForIds(model, ['L-B', 'L-C'])).toEqual([
      'l:M',
      'l:N',
    ]);
  });
});

describe('pending historical state shrinks incrementally after ack', () => {
  it('ack retires one logical at a time and drops empty sets (no unbounded growth)', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'LC-A', 'L', 0, 0);
    addChunk(model, 'LC-X', 'L', 1, 2000);
    addChunk(model, 'LC-C', 'L', 2, 4000);
    replaceWithLogical(model, 'LC-X', 'M', 0);
    replaceWithLogical(model, 'LC-X', 'N', 0);
    expect(backgroundPackRendezvousKeysForIds(model, ['LC-X'])).toEqual([
      'l:L',
      'l:M',
      'l:N',
    ]);

    // Survivor A for L succeeds → only L retires (incremental, not whole-
    // record clearance: M stays pending).
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:L']);
    expect(backgroundPackRendezvousKeysForIds(model, ['LC-X'])).toEqual([
      'l:M',
      'l:N',
    ]);

    // Intermediate M has no survivors (single-chunk M abandoned): the
    // no-survivor drop path also retires via the same ack seam.
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:M']);
    expect(backgroundPackRendezvousKeysForIds(model, ['LC-X'])).toEqual([
      'l:N',
    ]);

    // Acknowledging the CURRENT logical is a no-op for pending state (it was
    // never historical); the current unit key itself remains.
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:N']);
    expect(backgroundPackRendezvousKeysForIds(model, ['LC-X'])).toEqual([
      'l:N',
    ]);

    // Empty pending sets are deleted: a second identical ack is a stable
    // no-op and keys never regrow without a new mutation.
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:L', 'l:M']);
    expect(backgroundPackRendezvousKeysForIds(model, ['LC-X'])).toEqual([
      'l:N',
    ]);
  });

  it('ack + rendezvous never scan the document (edge-proportional, not O(document))', () => {
    const base = emptySurface(boundedFrame(60000, 6000));
    addChunk(base, 'G-A', 'G', 0, 0);
    addChunk(base, 'G-X', 'G', 1, 2000);
    addChunk(base, 'G-C', 'G', 2, 4000);
    let keyEnumerations = 0;
    const objects = new Proxy(base.objects, {
      ownKeys(target) {
        keyEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const model: SurfaceModel = { ...base, objects };
    replaceWithLogical(model, 'G-X', 'H', 0);
    replaceWithLogical(model, 'G-X', 'I', 0);
    expect(backgroundPackRendezvousKeysForIds(model, ['G-X'])).toEqual([
      'l:G',
      'l:H',
      'l:I',
    ]);

    keyEnumerations = 0;
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:G']);
    expect(keyEnumerations).toBe(0);
    expect(backgroundPackRendezvousKeysForIds(model, ['G-X'])).toEqual([
      'l:H',
      'l:I',
    ]);
    expect(keyEnumerations).toBe(0);
  });
});
