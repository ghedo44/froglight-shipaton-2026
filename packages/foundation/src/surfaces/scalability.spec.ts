/**
 * Surface scalability gates (Slices 0, 1, 4, 5, 6, 10, 11).
 *
 * Structural assertions are the primary gates; wall-clock benchmarks may
 * supplement them. Fixtures use realistic handwriting sample counts.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  compiledStrokeComputeStats,
  emptySurface,
  inkStrokeObject,
  createDefaultSurfaceObjectTypeRegistry,
  SurfaceInteractionController,
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

describe('large-selection ephemeral drag', () => {
  it('200-stroke drag touches no canonical samples per move', () => {
    const model = bigModel(1000, 250); // 250k samples total
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const mutatedBatches: string[][] = [];
    const beforeTranslateCalls: Array<{
      ids: readonly string[];
      dx: number;
      dy: number;
    }> = [];
    const c = new SurfaceInteractionController({
      model,
      registry,
      snapThresholdView: 8,
      onMutate: (ids) => mutatedBatches.push([...ids]),
      onBeforeTranslate: (ids, dx, dy) => {
        beforeTranslateCalls.push({ ids: [...ids], dx, dy });
      },
    });
    // Select 200 strokes (50k+ samples).
    const selected = model.order.slice(0, 200);
    c.setSelection(selected);
    // Snapshot canonical points hash before drag (to prove no mutation).
    const beforeJson = JSON.stringify(
      selected.map(
        (id) => (model.objects[id] as unknown as { points: unknown }).points,
      ),
    );

    // Pointer-down inside the first selected stroke (bounds center is
    // near the smooth spine, within hit tolerance; corners miss).
    const first = model.objects[selected[0]!]!;
    const bounds = registry.get(first.type)?.boundsOf?.(first);
    if (bounds === null || bounds === undefined) throw new Error('no bounds');
    const grab = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    c.pointerDown({ point: grab });

    const drag = c.selectionDrag();
    expect(drag).not.toBeNull();
    expect(drag?.logicalIds).toHaveLength(200);

    const statsBefore = c.controllerStats();
    const spatialBefore = c.spatialIndexStats();
    const connectorBefore = c.connectorIndexStats();

    // 120 pointer moves: no canonical mutation, no scene invalidation.
    // (Full canonical comparison only before/after; per-move full JSON
    // would itself be O(samples) test overhead, not production work.
    // Per-move we assert ephemeral deltas + zero-mutation counters.)
    for (let i = 1; i <= 120; i++) {
      const moved = c.pointerMove({
        point: { x: grab.x + i, y: grab.y + i * 0.5 },
      });
      expect(moved).toEqual([]);
      expect(c.selectionDrag()?.delta.x).toBeCloseTo(c.dragDelta().x, 9);
    }
    // Spot-check one selected sample stayed put during moves (O(1)).
    const spotId = selected[0] as string;
    const spotBefore = (
      JSON.parse(beforeJson) as Array<Array<{ x: number; y: number }>>
    )[0]?.[0];
    const spotNow = (
      model.objects[spotId] as unknown as {
        points: Array<{ x: number; y: number }>;
      }
    ).points[0];
    expect(spotNow?.x).toBe(spotBefore?.x);
    expect(spotNow?.y).toBe(spotBefore?.y);

    const statsDuring = c.controllerStats();
    // Ephemeral moves counted, canonical samples untouched per move.
    expect(statsDuring.ephemeralMoves - statsBefore.ephemeralMoves).toBe(120);
    expect(statsDuring.canonicalSamplesMutated).toBe(
      statsBefore.canonicalSamplesMutated,
    );
    expect(statsDuring.dragCommits).toBe(statsBefore.dragCommits);
    // No full-model scans for snap/connectors (indexed only).
    const spatialDuring = c.spatialIndexStats();
    expect(spatialDuring.fullScans).toBe(spatialBefore.fullScans);
    expect(spatialDuring.indexedQueries).toBeGreaterThan(
      spatialBefore.indexedQueries,
    );
    // Snap candidates are nearby only, not all 1000.
    const snapScanned =
      statsDuring.snapCandidatesScanned - statsBefore.snapCandidatesScanned;
    expect(snapScanned).toBeLessThan(1000);
    const connectorDuring = c.connectorIndexStats();
    expect(connectorDuring.fullScans).toBe(connectorBefore.fullScans);

    // Drag chrome uses cached translated union (no per-frame rescans).
    const translated = c.dragTranslatedBounds();
    expect(translated).not.toBeNull();
    const session = c.selectionDrag();
    if (
      session?.startBounds !== null &&
      session?.startBounds !== undefined &&
      translated !== null
    ) {
      expect(translated.x).toBeCloseTo(
        (session.startBounds as { x: number }).x + session.delta.x,
        9,
      );
    }

    // Pointer-up: exactly one canonical commit (geometry-preserving
    // translation path, item 1 — no recompiles, no rescans).
    const lastMove = { x: grab.x + 120, y: grab.y + 60 };
    const computesBeforeCommit = compiledStrokeComputeStats.computes;
    const translatesBeforeCommit = compiledStrokeComputeStats.translates;
    const derivedBeforeCommit = c.derivedStats();
    c.pointerUp({ point: lastMove });
    expect(mutatedBatches).toHaveLength(1);
    expect(mutatedBatches[0]).toHaveLength(200);
    expect(beforeTranslateCalls).toHaveLength(1);
    expect(beforeTranslateCalls[0]?.ids).toHaveLength(200);
    const statsAfter = c.controllerStats();
    expect(statsAfter.dragCommits - statsBefore.dragCommits).toBe(1);
    // 200 strokes x 250 samples = 50k samples translated once (commit only),
    // measured separately from geometry mutations (item 1).
    expect(
      statsAfter.canonicalSamplesTranslated -
        statsBefore.canonicalSamplesTranslated,
    ).toBe(200 * 250);
    expect(
      statsAfter.canonicalSamplesMutated - statsBefore.canonicalSamplesMutated,
    ).toBe(0);
    expect(statsAfter.translationCommits - statsBefore.translationCommits).toBe(
      1,
    );
    expect(
      statsAfter.translatedBoundsUpdates - statsBefore.translatedBoundsUpdates,
    ).toBe(200);
    // Zero B-spline recompiles on release (geometry preserved, not rebuilt).
    expect(compiledStrokeComputeStats.computes - computesBeforeCommit).toBe(0);
    // Translation preserves existing compiled entries (shifted, not rebuilt).
    // translates counts only previously-cached entries; uncached strokes
    // compile lazily on demand (never on release).
    expect(
      compiledStrokeComputeStats.translates - translatesBeforeCommit,
    ).toBeLessThanOrEqual(200);
    // Zero raw-point bounds rescans on release (bounds shifted by dx,dy).
    const derivedAfterCommit = c.derivedStats();
    expect(
      derivedAfterCommit.boundsScans - derivedBeforeCommit.boundsScans,
    ).toBe(0);
    expect(
      derivedAfterCommit.boundsTranslates -
        derivedBeforeCommit.boundsTranslates,
    ).toBe(200);
    // Canonical actually moved.
    const afterJson = JSON.stringify(
      selected.map(
        (id) => (model.objects[id] as unknown as { points: unknown }).points,
      ),
    );
    expect(afterJson).not.toBe(beforeJson);

    // Cancel path: discard without mutation (fresh drag).
    c.pointerDown({ point: lastMove });
    c.pointerMove({ point: { x: lastMove.x + 10, y: lastMove.y + 10 } });
    const cancelBefore = JSON.stringify(
      selected.map(
        (id) => (model.objects[id] as unknown as { points: unknown }).points,
      ),
    );
    c.pointerCancel();
    const cancelAfter = JSON.stringify(
      selected.map(
        (id) => (model.objects[id] as unknown as { points: unknown }).points,
      ),
    );
    expect(cancelAfter).toBe(cancelBefore);
    expect(c.selectionDrag()).toBeNull();
  }, 30000);

  it('5000-stroke index build stays structural (one bounds scan, no fingerprints)', () => {
    const model = bigModel(5000, 20); // 100k samples, realistic handwriting
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const c = new SurfaceInteractionController({
      model,
      registry,
      snapThresholdView: 8,
    });
    const before = c.controllerStats();
    c.ensureIndexes();
    const after = c.controllerStats();
    // One bounds computation per object (initial build), no full scans after.
    expect(
      after.boundsComputations - before.boundsComputations,
    ).toBeLessThanOrEqual(5000);
    expect(c.spatialIndexStats().entries).toBe(5000);
    expect(c.spatialIndexStats().fullScans).toBe(0);
    expect(c.connectorIndexStats().fullScans).toBe(0);
    // Viewport query returns a small slice, not all 5000.
    const visible = c.queryRegion({ x: 0, y: 0, width: 800, height: 600 });
    expect(visible.length).toBeLessThan(5000);
    expect(visible.length).toBeGreaterThan(0);
    c.destroy();
  }, 30000);

  it.each([100, 500, 1000])(
    'spatial snap scales with nearby candidates, not total (%s objects)',
    (count) => {
      const model = bigModel(count, 20);
      const registry = createDefaultSurfaceObjectTypeRegistry();
      const c = new SurfaceInteractionController({
        model,
        registry,
        snapThresholdView: 8,
      });
      c.ensureIndexes();
      // Select one stroke near the origin; drag near 10 neighbours.
      // Fixture grid is 120 units apart; snap threshold 8 selects only
      // immediate neighbours via the spatial query.
      const firstId = model.order[0]!;
      c.setSelection([firstId]);
      const first = model.objects[firstId]!;
      const bounds = registry.get(first.type)?.boundsOf?.(first);
      if (bounds === null || bounds === undefined) throw new Error('no bounds');
      const grab = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
      c.pointerDown({ point: grab });
      const before = c.controllerStats();
      for (let i = 0; i < 20; i++) {
        c.pointerMove({ point: { x: grab.x + i, y: grab.y } });
      }
      const after = c.controllerStats();
      const scanned =
        after.snapCandidatesScanned - before.snapCandidatesScanned;
      // Nearby only: well below total objects even at 1000.
      expect(scanned).toBeLessThan(Math.min(count, 100));
      c.pointerCancel();
    },
  );
});

describe('indexed hit-testing', () => {
  it('broad phase is exact: far queries miss, near-spine queries hit', () => {
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const hitTest = registry.get('froglight.ink.stroke')?.hitTest;
    if (hitTest === undefined) throw new Error('no ink hitTest');
    // Horizontal stroke: x 0..100 at y 0, width 3 → threshold 1.5 + 2 = 3.5.
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i <= 50; i++) points.push({ x: i * 2, y: 0 });
    const record = inkStrokeObject('h', { points, width: 3 });
    expect(hitTest(record, 50, 1)).toBe(true);
    expect(hitTest(record, 50, 3)).toBe(true);
    expect(hitTest(record, 50, 4)).toBe(false);
    expect(hitTest(record, 150, 0)).toBe(false);
    expect(hitTest(record, -50, 0)).toBe(false);
    // Rotated 90° about its center: spine runs vertically through x = 50.
    const rotated = inkStrokeObject('r', {
      points,
      width: 3,
      rotation: Math.PI / 2,
    });
    expect(hitTest(rotated, 50, 30)).toBe(true);
    expect(hitTest(rotated, 54, 30)).toBe(false);
    expect(hitTest(rotated, 0, 0)).toBe(false);
  });

  it('scattered clicks over a lazy dense model compile almost nothing', () => {
    const model = bigModel(1500, 60);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const c = new SurfaceInteractionController({ model, registry });
    c.ensureIndexes();
    const readComputes = (): number => compiledStrokeComputeStats.computes;
    // Warm the compiled cache for the first row only (simulated viewport).
    for (const id of model.order.slice(0, 50)) {
      const record = model.objects[id];
      if (record !== undefined) registry.get(record.type)?.boundsOf?.(record);
    }
    const beforeComputes = readComputes();
    const beforeScans = c.spatialIndexStats().fullScans;
    const started = performance.now();
    let hits = 0;
    // Twenty scattered clicks: empty areas and exact spine starts
    // (endpoints are preserved exactly by the fitter → distance 0).
    for (let i = 0; i < 20; i++) {
      const target = model.objects[model.order[(i * 137) % 1500]!]!;
      const bounds = registry.get(target.type)?.boundsOf?.(target);
      if (bounds === undefined || bounds === null) continue;
      const rawPoints = (target as unknown as { points: unknown }).points;
      const firstPoint =
        Array.isArray(rawPoints) &&
        typeof rawPoints[0] === 'object' &&
        rawPoints[0] !== null
          ? (rawPoints[0] as { x: unknown; y: unknown })
          : null;
      const inside =
        i % 2 === 0 &&
        typeof firstPoint?.x === 'number' &&
        typeof firstPoint?.y === 'number'
          ? { x: firstPoint.x, y: firstPoint.y }
          : { x: bounds.x - 1000 - i, y: bounds.y - 1000 - i };
      if (c.hitTest(inside) !== null) hits += 1;
    }
    const elapsed = performance.now() - started;
    const computes = readComputes() - beforeComputes;
    // Structural: only strokes containing a query compile (a handful),
    // never the ~1450 untouched ones; no full-model scans either.
    expect(computes).toBeLessThan(150);
    expect(c.spatialIndexStats().fullScans).toBe(beforeScans);
    // Generous wall-clock supplement (old path: seconds of compiles).
    expect(elapsed).toBeLessThan(4000);
    expect(hits).toBeGreaterThan(0);
    c.destroy();
  }, 30000);
});
