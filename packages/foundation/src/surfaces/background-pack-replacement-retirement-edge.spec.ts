/**
 * edge-proportional replacement retirement regressions.
 *
 * The forward pending map (`record → historical logicals`) is paired with a
 * model-scoped reverse holder index (`logical → holder records`) maintained
 * by edge helpers (`addReplacedLogicalEdge` / `removeReplacedLogicalEdge` /
 * `retireReplacedLogical` in `objects.ts`). Invariant: forward contains
 * (recordId, logicalId) IFF reverse contains (logicalId, recordId); empty
 * sets are deleted in both directions.
 *
 * `acknowledgeBackgroundPackRendezvousKeys` retires through the reverse
 * index only: each `l:<logical>` visits its holders, never all pending
 * record ids and never `model.objects` / `model.order`. Retirement is
 * proportional to acknowledged historical ownership edges (O(acknowledged
 * logical keys + historical edges actually retired), subject to Map/Set
 * ops). Key generation (`backgroundPackRendezvousKeysForIds`) still reads
 * the record-local forward set; the reverse index exists for retirement
 * efficiency only.
 *
 * Driven ONLY via capture→mutate→invalidate +
 * backgroundPackRendezvousKeysForIds + acknowledgeBackgroundPackRendezvousKeys
 * (no schedulers, no manual prepared keys, single invalidation per mutation).
 * Deterministic: no wall-clock, no timers. Diagnostics
 * (`replacedEdgeRetirementStats`, `inspectReplacedEdgesForTests`) are
 * imported directly from `./objects.js` and are never re-exported via the
 * barrel (`./index.ts`) public API.
 *
 * Fails on the b0550b3 baseline (which scans every pending record id per
 * ack: ~1000 holder visits for the large test) and passes with the reverse
 * index (exactly 1 holder visit for the single-holder ack, exactly 2 for
 * each shared-logical ack below).
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
  rectangleObject,
  resetGeometryGenerationsForTests,
  type SurfaceModel,
} from './index.js';
import {
  inspectReplacedEdgesForTests,
  replacedEdgeRetirementStats,
  resetReplacedEdgeRetirementStatsForTests,
} from './objects.js';

function tinySamples(
  count: number,
  xBase: number,
): { x: number; y: number; pressure: number; dt: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    x: xBase + i * 2,
    y: 200 + (i % 7),
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
    points: tinySamples(5, xBase),
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

function deleteRecord(model: SurfaceModel, id: string): void {
  captureGeometryOwnershipForIds(model, [id]);
  delete model.objects[id];
  model.order.splice(model.order.indexOf(id), 1);
  invalidateCompiledForIds(model, [id]);
}

/** Assert forward-IFF-reverse and no empty sets survive in either index. */
function expectEdgesConsistent(model: SurfaceModel): void {
  const { forward, reverse } = inspectReplacedEdgesForTests(model);
  for (const list of Object.values(forward)) {
    expect(list.length).toBeGreaterThan(0);
  }
  for (const list of Object.values(reverse)) {
    expect(list.length).toBeGreaterThan(0);
  }
  const rebuiltReverse: Record<string, string[]> = {};
  for (const [recordId, logicals] of Object.entries(forward)) {
    for (const logical of logicals) {
      (rebuiltReverse[logical] ??= []).push(recordId);
    }
  }
  for (const list of Object.values(rebuiltReverse)) list.sort();
  expect(reverse).toEqual(rebuiltReverse);
  const rebuiltForward: Record<string, string[]> = {};
  for (const [logical, holders] of Object.entries(reverse)) {
    for (const holder of holders) {
      (rebuiltForward[holder] ??= []).push(logical);
    }
  }
  for (const list of Object.values(rebuiltForward)) list.sort();
  expect(forward).toEqual(rebuiltForward);
}

beforeEach(() => {
  resetGeometryGenerationsForTests();
  resetReplacedEdgeRetirementStatsForTests();
});

describe('large unrelated-holder ack visits only the holder', () => {
  it('1000 independent R→L edges; ack l:L500 visits exactly 1 holder, no document scan', () => {
    const base = emptySurface(boundedFrame(60000, 6000));
    const COUNT = 1000;
    for (let i = 0; i < COUNT; i++) {
      addChunk(base, `R${i}`, `L${i}`, 0, i * 10);
    }
    // Wrap BEFORE any capture/invalidation so the model-scoped indexes live
    // on the proxied identity (same pattern as the existing no-scan tests).
    // Only ownKeys is counted; indexed record reads never enumerate keys.
    let keyEnumerations = 0;
    const objects = new Proxy(base.objects, {
      ownKeys(target) {
        keyEnumerations += 1;
        return Reflect.ownKeys(target);
      },
    });
    const model: SurfaceModel = { ...base, objects };
    for (let i = 0; i < COUNT; i++) {
      replaceWithLogical(model, `R${i}`, `M${i}`, 0);
    }
    // Sanity: forward B→{L,M}-style accumulation per record; reverse holds
    // one holder per historical logical. Example edges:
    // forward R500→{L500}, reverse L500→{R500}.
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(Object.keys(forward).length).toBe(COUNT);
      expect(Object.keys(reverse).length).toBe(COUNT);
      expect(forward['R500']).toEqual(['L500']);
      expect(reverse['L500']).toEqual(['R500']);
      expect(backgroundPackRendezvousKeysForIds(model, ['R500'])).toEqual([
        'l:L500',
        'l:M500',
      ]);
    }
    expectEdgesConsistent(model);

    keyEnumerations = 0;
    resetReplacedEdgeRetirementStatsForTests();
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:L500']);
    // Edge-proportional: exactly the single holder of L500 is visited.
    // The old O(acked × pending ids) scan visited all ~1000 pending records.
    expect(replacedEdgeRetirementStats.holderVisits).toBe(1);
    expect(replacedEdgeRetirementStats.edgeVisits).toBe(1);
    // Historical acknowledgement never enumerates the document.
    expect(keyEnumerations).toBe(0);

    // Only R500 retired; every unrelated holder is untouched.
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['R500']).toBeUndefined();
      expect(reverse['L500']).toBeUndefined();
      expect(Object.keys(forward).length).toBe(COUNT - 1);
      expect(Object.keys(reverse).length).toBe(COUNT - 1);
      expect(forward['R0']).toEqual(['L0']);
      expect(forward['R999']).toEqual(['L999']);
      expect(reverse['L0']).toEqual(['R0']);
      expect(reverse['L999']).toEqual(['R999']);
    }
    expectEdgesConsistent(model);
    expect(backgroundPackRendezvousKeysForIds(model, ['R500'])).toEqual([
      'l:M500',
    ]);
    expect(backgroundPackRendezvousKeysForIds(model, ['R0'])).toEqual([
      'l:L0',
      'l:M0',
    ]);
    // Key generation also never enumerates the document.
    keyEnumerations = 0;
    expect(backgroundPackRendezvousKeysForIds(model, ['R0'])).toEqual([
      'l:L0',
      'l:M0',
    ]);
    expect(keyEnumerations).toBe(0);
  });
});

describe('sparse multi-holder ack visits exact holder sets', () => {
  it('B→{L,M} C→{L,N} D/E→{Q} F→{X}; ack L visits 2, ack Q visits 2, others untouched', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    // Shared logicals: B and C both start in L; D and E both start in Q.
    addChunk(model, 'B', 'L', 0, 0);
    addChunk(model, 'C', 'L', 1, 200);
    addChunk(model, 'D', 'Q', 0, 2000);
    addChunk(model, 'E', 'Q', 1, 2200);
    addChunk(model, 'F', 'X', 0, 4000);
    // B: L→M→PB gives pending {L,M}, current PB.
    replaceWithLogical(model, 'B', 'M', 0);
    replaceWithLogical(model, 'B', 'PB', 0);
    // C: L→N→PC gives pending {L,N}, current PC.
    replaceWithLogical(model, 'C', 'N', 0);
    replaceWithLogical(model, 'C', 'PC', 0);
    // D/E: Q→PD/PE give pending {Q} each.
    replaceWithLogical(model, 'D', 'PD', 0);
    replaceWithLogical(model, 'E', 'PE', 0);
    // F: X→PF gives pending {X}.
    replaceWithLogical(model, 'F', 'PF', 0);

    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['B']).toEqual(['L', 'M']);
      expect(forward['C']).toEqual(['L', 'N']);
      expect(forward['D']).toEqual(['Q']);
      expect(forward['E']).toEqual(['Q']);
      expect(forward['F']).toEqual(['X']);
      expect(reverse['L']).toEqual(['B', 'C']);
      expect(reverse['M']).toEqual(['B']);
      expect(reverse['N']).toEqual(['C']);
      expect(reverse['Q']).toEqual(['D', 'E']);
      expect(reverse['X']).toEqual(['F']);
    }
    expectEdgesConsistent(model);
    expect(backgroundPackRendezvousKeysForIds(model, ['B'])).toEqual([
      'l:L',
      'l:M',
      'l:PB',
    ]);
    expect(backgroundPackRendezvousKeysForIds(model, ['C'])).toEqual([
      'l:L',
      'l:N',
      'l:PC',
    ]);

    resetReplacedEdgeRetirementStatsForTests();
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:L']);
    expect(replacedEdgeRetirementStats.holderVisits).toBe(2);
    expect(replacedEdgeRetirementStats.edgeVisits).toBe(2);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['B']).toEqual(['M']);
      expect(forward['C']).toEqual(['N']);
      expect(forward['D']).toEqual(['Q']);
      expect(forward['E']).toEqual(['Q']);
      expect(forward['F']).toEqual(['X']);
      expect(reverse['L']).toBeUndefined();
      expect(reverse['M']).toEqual(['B']);
      expect(reverse['N']).toEqual(['C']);
      expect(reverse['Q']).toEqual(['D', 'E']);
    }
    expectEdgesConsistent(model);
    expect(backgroundPackRendezvousKeysForIds(model, ['B'])).toEqual([
      'l:M',
      'l:PB',
    ]);
    expect(backgroundPackRendezvousKeysForIds(model, ['C'])).toEqual([
      'l:N',
      'l:PC',
    ]);

    resetReplacedEdgeRetirementStatsForTests();
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:Q']);
    expect(replacedEdgeRetirementStats.holderVisits).toBe(2);
    expect(replacedEdgeRetirementStats.edgeVisits).toBe(2);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['B']).toEqual(['M']);
      expect(forward['C']).toEqual(['N']);
      expect(forward['D']).toBeUndefined();
      expect(forward['E']).toBeUndefined();
      expect(forward['F']).toEqual(['X']);
      expect(reverse['Q']).toBeUndefined();
      expect(reverse['M']).toEqual(['B']);
      expect(reverse['N']).toEqual(['C']);
      expect(reverse['X']).toEqual(['F']);
    }
    expectEdgesConsistent(model);

    // r: keys and malformed keys retire nothing and visit nothing.
    resetReplacedEdgeRetirementStatsForTests();
    acknowledgeBackgroundPackRendezvousKeys(model, ['r:B', 'bogus', 'l:']);
    expect(replacedEdgeRetirementStats.holderVisits).toBe(0);
    expect(replacedEdgeRetirementStats.edgeVisits).toBe(0);
    expectEdgesConsistent(model);
  });
});

describe('return-to-old removes only the matching edge', () => {
  it('B:L→M→L swaps {L} to {M}; reverse drops L, keeps M; ack M deletes empty sets', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'B', 'L', 0, 0);
    addChunk(model, 'A', 'L', 1, 2000);

    replaceWithLogical(model, 'B', 'M', 0);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['B']).toEqual(['L']);
      expect(reverse['L']).toEqual(['B']);
      expect(reverse['M']).toBeUndefined();
    }
    expectEdgesConsistent(model);

    // Return to the old logical: current becomes L again, so (B,L) is no
    // longer historical. Only that edge is removed; the still-pending M
    // (added by this same invalidation as the remembered logical) is kept.
    // The two-step L→M→L therefore swaps {L} to {M}: it never clears the
    // whole record set. (A three-step L→M→N→L analogously keeps {M,N}.)
    replaceWithLogical(model, 'B', 'L', 0);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['B']).toEqual(['M']);
      expect(reverse['L']).toBeUndefined();
      expect(reverse['M']).toEqual(['B']);
    }
    expectEdgesConsistent(model);
    // Current L plus still-pending M stay independently representable.
    expect(backgroundPackRendezvousKeysForIds(model, ['B'])).toEqual([
      'l:M',
      'l:L',
    ]);

    resetReplacedEdgeRetirementStatsForTests();
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:M']);
    expect(replacedEdgeRetirementStats.holderVisits).toBe(1);
    expect(replacedEdgeRetirementStats.edgeVisits).toBe(1);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['B']).toBeUndefined();
      expect(reverse['M']).toBeUndefined();
      expect(forward).toEqual({});
      expect(reverse).toEqual({});
    }
    expectEdgesConsistent(model);
    expect(backgroundPackRendezvousKeysForIds(model, ['B'])).toEqual(['l:L']);
  });

  it('L→M→N→L keeps every still-pending historique except the returned L', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'B', 'L', 0, 0);
    replaceWithLogical(model, 'B', 'M', 0);
    replaceWithLogical(model, 'B', 'N', 0);
    {
      const { forward } = inspectReplacedEdgesForTests(model);
      expect(forward['B']).toEqual(['L', 'M']);
    }
    replaceWithLogical(model, 'B', 'L', 0);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      // Added N, removed L, kept M: only the matching edge leaves.
      expect(forward['B']).toEqual(['M', 'N']);
      expect(reverse['L']).toBeUndefined();
      expect(reverse['M']).toEqual(['B']);
      expect(reverse['N']).toEqual(['B']);
    }
    expectEdgesConsistent(model);
  });
});

describe('deletion and same-id recreation keep the reverse index consistent', () => {
  it('delete keeps pending edges; recreate as single/non-stroke/different/original preserves lockstep', () => {
    const model = emptySurface(boundedFrame(60000, 6000));
    addChunk(model, 'L-A', 'L', 0, 0);
    addChunk(model, 'L-B', 'L', 1, 2000);
    addChunk(model, 'L-C', 'L', 2, 4000);

    // B leaves L for M: forward B→{L}, reverse L→{B}.
    replaceWithLogical(model, 'L-B', 'M', 0);
    expectEdgesConsistent(model);
    expect(inspectReplacedEdgesForTests(model).forward['L-B']).toEqual(['L']);

    // Delete B: the pending edge is kept until ack retires it (tombstone
    // lifetime unchanged); the reverse index still names the holder.
    deleteRecord(model, 'L-B');
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['L-B']).toEqual(['L']);
      expect(reverse['L']).toEqual(['L-B']);
      // Deleted ids resolve via remembered ownership, not via the forward
      // set alone.
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toContain(
        'l:L',
      );
    }
    expectEdgesConsistent(model);

    // Same-id recreated as a single Ink stroke: old L stays historical, the
    // single itself contributes no current logical key.
    captureGeometryOwnershipForIds(model, ['L-B']);
    model.objects['L-B'] = inkStrokeObject('L-B', {
      points: tinySamples(5, 9000),
      width: 3,
    });
    model.order.push('L-B');
    invalidateCompiledForIds(model, ['L-B']);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      // Recreated single adds the remembered M as historical alongside L.
      expect(forward['L-B']).toEqual(['L', 'M']);
      expect(reverse['L']).toEqual(['L-B']);
      expect(reverse['M']).toEqual(['L-B']);
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toContain(
        'l:L',
      );
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toContain(
        'l:M',
      );
    }
    expectEdgesConsistent(model);

    // Same-id replaced by a non-stroke: old historiques survive, the
    // replacement itself emits no current unit key.
    captureGeometryOwnershipForIds(model, ['L-B']);
    model.objects['L-B'] = rectangleObject('L-B', {
      x: 10,
      y: 10,
      width: 100,
      height: 50,
    });
    invalidateCompiledForIds(model, ['L-B']);
    {
      const { forward } = inspectReplacedEdgesForTests(model);
      expect(forward['L-B']).toEqual(['L', 'M']);
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toContain(
        'l:L',
      );
    }
    expectEdgesConsistent(model);

    // Same-id recreated as a different logical: the new logical becomes
    // current, historiques accumulate (never overwrite).
    captureGeometryOwnershipForIds(model, ['L-B']);
    model.objects['L-B'] = inkStrokeObject('L-B', {
      points: tinySamples(5, 9100),
      width: 3,
      logicalId: 'Q',
      chunkIndex: 0,
    });
    invalidateCompiledForIds(model, ['L-B']);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['L-B']).toEqual(['L', 'M']);
      expect(reverse['L']).toEqual(['L-B']);
      expect(reverse['M']).toEqual(['L-B']);
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:L',
        'l:M',
        'l:Q',
      ]);
    }
    expectEdgesConsistent(model);

    // Same-id returns to the original logical: only (L-B, L) leaves.
    replaceWithLogical(model, 'L-B', 'L', 1);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['L-B']).toEqual(['M', 'Q']);
      expect(reverse['L']).toBeUndefined();
      expect(reverse['M']).toEqual(['L-B']);
      expect(reverse['Q']).toEqual(['L-B']);
    }
    expectEdgesConsistent(model);

    // Delete → recreate → replace again: reverse never substitutes for the
    // canonical membership indexes (logicalMembersById / logicalByRecordId /
    // oldLogicalOwnershipByRecordId retain their responsibilities).
    deleteRecord(model, 'L-B');
    expectEdgesConsistent(model);
    model.objects['L-B'] = inkStrokeObject('L-B', {
      points: tinySamples(5, 9200),
      width: 3,
      logicalId: 'L',
      chunkIndex: 1,
    });
    model.order.push('L-B');
    captureGeometryOwnershipForIds(model, ['L-B']);
    invalidateCompiledForIds(model, ['L-B']);
    // Recreating the deleted id as its original logical does not invent a
    // new edge (remembered Q is retained only when it differs; here the
    // delete kept Q pending and the recreate keeps it).
    expectEdgesConsistent(model);
    replaceWithLogical(model, 'L-B', 'Z', 0);
    {
      const { forward, reverse } = inspectReplacedEdgesForTests(model);
      expect(forward['L-B']).toContain('L');
      expect(reverse['L']).toEqual(['L-B']);
      expect(reverse['Z']).toBeUndefined();
    }
    expectEdgesConsistent(model);

    // Ack still retires edge-proportionally after the whole chain.
    resetReplacedEdgeRetirementStatsForTests();
    acknowledgeBackgroundPackRendezvousKeys(model, ['l:L']);
    expect(replacedEdgeRetirementStats.holderVisits).toBe(1);
    expect(inspectReplacedEdgesForTests(model).reverse['L']).toBeUndefined();
    expectEdgesConsistent(model);
  });
});
