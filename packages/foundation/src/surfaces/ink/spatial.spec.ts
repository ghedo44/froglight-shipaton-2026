/**
 * Spatial-system gates over smooth-stroke truth: bounds, hit-testing,
 * lasso selection, and erasing all consume the fitted/tessellated
 * geometry (never the raw pointer polyline), share one derived cache,
 * and agree with the rendered outline.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH, INK_HIT_TOLERANCE } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  compiledStrokeForRecord,
  inkStrokeCompiledBounds,
  invalidateCompiledForRecord,
  maxStrokeHalfWidth,
  smoothSpineOfRecord,
} from '../objects.js';
import {
  inkStrokeObject,
  SURFACE_OBJECT_TYPES,
  type SurfaceObjectRecord,
} from '../model.js';
import { segmentIntersectsBox } from './eraser-geometry.js';
import { addErasure, capsuleFootprint } from './erasure.js';
import { pointPolylineDistance } from '../geometry.js';
import type { InkSample } from '../model.js';

function arcRecord(): SurfaceObjectRecord {
  // Sparse 3-point arc: the fitted curve bulges well off the raw chords
  // (apex ≈ y 30 vs chord midpoint y 20) — the discriminating case for
  // smooth-vs-raw spatial truth.
  return inkStrokeObject('arc', {
    points: [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 50, y: 40, pressure: 0.5 },
      { x: 100, y: 0, pressure: 0.5 },
    ],
    width: 3,
    brush: { kind: 'ball' },
  });
}

describe('smooth spatial truth', () => {
  it('shares one cached compilation across spatial queries', () => {
    const record = arcRecord();
    const first = compiledStrokeForRecord(record);
    const second = compiledStrokeForRecord(record);
    expect(first).not.toBeNull();
    // Same reference: rendering, culling, hit-testing, selection, and
    // erasing share one geometry truth without recompiling.
    expect(second).toBe(first);
    expect(inkStrokeCompiledBounds(record)).toEqual(first!.bounds);
  });

  it('recompiles when canonical data changes (no stale cache)', () => {
    const record = arcRecord();
    const before = compiledStrokeForRecord(record);
    (record.points as InkSample[]).push({ x: 150, y: 50, pressure: 0.5 });
    // In-place writes bypassing the mutation system must invalidate
    // explicitly — exactly what controller/history commit paths do.
    invalidateCompiledForRecord(record);
    const after = compiledStrokeForRecord(record);
    expect(after).not.toBe(before);
    expect(after!.bounds).not.toEqual(before!.bounds);
  });

  it('hit-tests against the visible curve, not raw chords', () => {
    const record = arcRecord();
    const spine = smoothSpineOfRecord(record);
    expect(spine.length).toBeGreaterThan(3);
    // Apex of the fitted curve sits well above the raw chord midpoint.
    const apex = spine.reduce((a, b) => (b.y > a.y ? b : a));
    expect(apex.y).toBeGreaterThan(26);
    const threshold = maxStrokeHalfWidth(record) + INK_HIT_TOLERANCE;
    // A point glued to the visible curve hits…
    expect(pointPolylineDistance(apex, spine)).toBeLessThanOrEqual(threshold);
    // …while the raw chord midpoint (10+ units off the curve) misses.
    const chordMid = { x: 50, y: 20 };
    expect(pointPolylineDistance(chordMid, spine)).toBeGreaterThan(threshold);
  });

  it('cuts the visible outline while a raw-chord miss remains a no-op', () => {
    const record = arcRecord();
    const compiled = compiledStrokeForRecord(record)!;
    const apex = compiled.nodes.reduce((a, b) => (b.y > a.y ? b : a));
    expect(
      addErasure(compiled.polygon, undefined, capsuleFootprint(apex, apex, 6))
        .changed,
    ).toBe(true);
    const rawChord = { x: 50, y: 20 };
    expect(
      addErasure(
        compiled.polygon,
        undefined,
        capsuleFootprint(rawChord, rawChord, 4),
      ).changed,
    ).toBe(false);
  });

  it('selects sparse-crossing strokes by smooth segment (lasso parity)', () => {
    // A sparse stroke crossing a box with no endpoint inside selects via
    // segment intersection on the smooth spine.
    const record = arcRecord();
    const spine = smoothSpineOfRecord(record);
    const box = { minX: 40, minY: 25, maxX: 60, maxY: 45 };
    const hits = spine.some(
      (p, i) =>
        i > 0 &&
        (segmentIntersectsBox(spine[i - 1]!, p, box) ||
          (p.x >= box.minX &&
            p.x <= box.maxX &&
            p.y >= box.minY &&
            p.y <= box.maxY)),
    );
    expect(hits).toBe(true);
    expect(record.type).toBe(SURFACE_OBJECT_TYPES.stroke);
  });

  it('bounds contain the full smooth outline (ball pen apex)', () => {
    const compiled = compileInkStroke(
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 50, y: 40, pressure: 0.5 },
        { x: 100, y: 0, pressure: 0.5 },
      ],
      { ...BALL_PEN_BRUSH, stabilization: 0, streamline: 0 },
    );
    for (const p of compiled.polygon) {
      expect(p.x).toBeGreaterThanOrEqual(compiled.bounds.x - 1e-9);
      expect(p.x).toBeLessThanOrEqual(
        compiled.bounds.x + compiled.bounds.width + 1e-9,
      );
    }
    expect(compiled.bounds.y + compiled.bounds.height).toBeGreaterThan(30);
  });
});
