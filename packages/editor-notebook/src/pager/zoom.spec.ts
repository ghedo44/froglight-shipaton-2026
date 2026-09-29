import { describe, expect, it } from 'vitest';
import { NAVIGATION_PHYSICS, inverseRubberBand, rubberBand } from '@froglight/editor-ink';
import {
  beginPinchPreview,
  clampNotebookZoom,
  stepPinchPreview,
  stepPinchPreviewWithFactor,
  touchCentroid,
  touchPinchDistance,
} from './zoom.js';

describe('clampNotebookZoom', () => {
  it('clamps to the finite sheet range', () => {
    expect(clampNotebookZoom(1, 0.1)).toBe(0.25);
    expect(clampNotebookZoom(1, 40)).toBe(8);
    expect(clampNotebookZoom(1, 2)).toBe(2);
  });

  it('keeps the current zoom for non-finite requests', () => {
    expect(clampNotebookZoom(1.5, Number.NaN)).toBe(1.5);
    expect(clampNotebookZoom(1.5, Number.POSITIVE_INFINITY)).toBe(1.5);
  });
});

describe('touch geometry', () => {
  it('averages touch points into a centroid', () => {
    expect(
      touchCentroid([
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ]),
    ).toEqual({ x: 5, y: 10 });
  });

  it('measures pinch distance with a unit floor', () => {
    expect(
      touchPinchDistance([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ]),
    ).toBe(5);
    expect(touchPinchDistance([{ x: 0, y: 0 }])).toBe(1);
    expect(touchPinchDistance([])).toBe(1);
  });
});

describe('pinch preview', () => {
  it('scales the target zoom by the finger spread factor', () => {
    const preview = beginPinchPreview(
      1,
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      { x: 0, y: 0 },
    );
    const stepped = stepPinchPreview(preview, [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]);
    expect(stepped.targetZoom).toBe(2);
    expect(stepped.scale).toBe(2);
  });

  it('tracks centroid translation alongside the zoom', () => {
    const preview = beginPinchPreview(
      1,
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      { x: 0, y: 0 },
    );
    const stepped = stepPinchPreview(preview, [
      { x: 10, y: 5 },
      { x: 110, y: 5 },
    ]);
    expect(stepped.targetZoom).toBe(1);
    expect(stepped.translation).toEqual({ x: 10, y: 5 });
  });

  it('resists runaway pinch factors while retaining a legal settle target', () => {
    const preview = beginPinchPreview(
      1,
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      { x: 0, y: 0 },
    );
    const stepped = stepPinchPreview(preview, [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
    ]);
    expect(stepped.targetZoom).toBeGreaterThan(8);
    expect(preview.settledZoom).toBe(8);
  });
});

describe('pinch preview factor stepping (embedded driver)', () => {
  function startAt(baseZoom = 1): ReturnType<typeof beginPinchPreview> {
    return beginPinchPreview(
      baseZoom,
      [
        { x: 75, y: 100 },
        { x: 125, y: 100 },
      ],
      { x: 0, y: 0 },
    );
  }

  it('fails without the fix: applies an incremental factor to the live target, not the base', () => {
    const preview = startAt(1);
    const first = stepPinchPreviewWithFactor(preview, 2, { x: 0, y: 0 });
    preview.targetZoom = first.targetZoom;
    preview.scale = first.scale;
    preview.translation = first.translation;
    expect(first.targetZoom).toBe(2);
    const second = stepPinchPreviewWithFactor(preview, 1.5, { x: 0, y: 0 });
    // Incremental: 2 * 1.5 = 3 (a base-locked fork would return 1.5).
    expect(second.targetZoom).toBeCloseTo(3, 9);
    expect(second.scale).toBeCloseTo(3, 9);
  });

  it('accumulates centroid deltas alongside the zoom', () => {
    const preview = startAt(1);
    const stepped = stepPinchPreviewWithFactor(preview, 1, { x: 10, y: -4 });
    expect(stepped.targetZoom).toBe(1);
    expect(stepped.translation).toEqual({ x: 10, y: -4 });
  });

  it('delegates to the single shared elasticZoom (no second formula)', () => {
    const preview = startAt(1);
    const stepped = stepPinchPreviewWithFactor(preview, 20, { x: 0, y: 0 });
    // Visual resists past the max while the settle target stays legal.
    expect(stepped.targetZoom).toBeGreaterThan(8);
    expect(preview.settledZoom).toBe(8);
    const under = startAt(1);
    const shrunk = stepPinchPreviewWithFactor(under, 0.01, { x: 0, y: 0 });
    expect(shrunk.targetZoom).toBeLessThan(0.25);
    expect(under.settledZoom).toBe(0.25);
  });

  it('keeps a stationary saturated pinch visually stable and reverses immediately', () => {
    const minimum = startAt(0.25);
    const outwardMinimum = stepPinchPreviewWithFactor(
      minimum,
      0.5,
      { x: 0, y: 0 },
    );
    expect(outwardMinimum).toEqual({
      targetZoom: 0.25,
      translation: { x: 0, y: 0 },
      scale: 1,
    });
    const reversedMinimum = stepPinchPreviewWithFactor(
      minimum,
      2,
      { x: 0, y: 0 },
    );
    expect(reversedMinimum.targetZoom).toBe(0.5);

    const maximum = startAt(8);
    const outwardMaximum = stepPinchPreviewWithFactor(
      maximum,
      2,
      { x: 0, y: 0 },
    );
    expect(outwardMaximum).toEqual({
      targetZoom: 8,
      translation: { x: 0, y: 0 },
      scale: 1,
    });
    const reversedMaximum = stepPinchPreviewWithFactor(
      maximum,
      0.5,
      { x: 0, y: 0 },
    );
    expect(reversedMaximum.targetZoom).toBe(4);
  });

  it('sanitizes non-finite factors and deltas without throwing', () => {
    const preview = startAt(2);
    for (const factor of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1.5,
    ]) {
      const stepped = stepPinchPreviewWithFactor(preview, factor, {
        x: Number.NaN,
        y: Number.POSITIVE_INFINITY,
      });
      expect(stepped.targetZoom).toBe(preview.targetZoom);
      expect(stepped.translation).toEqual(preview.translation);
      expect(Number.isFinite(stepped.targetZoom)).toBe(true);
      expect(Number.isFinite(stepped.scale)).toBe(true);
    }
  });
});

describe('inverseRubberBand (shared @froglight/editor-ink)', () => {
  it('returns zero for empty and non-finite inputs', () => {
    expect(inverseRubberBand(0)).toBe(0);
    expect(inverseRubberBand(Number.NaN)).toBe(0);
    expect(inverseRubberBand(Number.POSITIVE_INFINITY)).toBe(0);
    expect(inverseRubberBand(10, 0)).toBe(0);
    expect(inverseRubberBand(10, -5)).toBe(0);
  });

  it('passes through values at or beyond the extent (no over-restore)', () => {
    const extent = NAVIGATION_PHYSICS.rubberBandExtentPx;
    expect(inverseRubberBand(extent)).toBe(extent);
    expect(inverseRubberBand(extent + 40)).toBe(extent + 40);
    expect(inverseRubberBand(-extent - 40)).toBe(-extent - 40);
  });

  it('round-trips rubberBand without forking tuning', () => {
    expect(NAVIGATION_PHYSICS.rubberBandExtentPx).toBe(120);
    for (const excess of [10, 30, 50, 100, -12, -75, 200, -400]) {
      const resisted = rubberBand(excess);
      // Beyond the extent rubberBand asymptotes below it, so the inverse
      // restores the original excess; at/above the extent both pass through.
      const restored = inverseRubberBand(resisted);
      expect(restored).toBeCloseTo(excess, 6);
    }
  });
});

describe('gutter synthetic anchor (d=50 pair)', () => {
  it('centers the synthetic pair on the cursor so preview origin aligns with commit anchor', () => {
    const client = { x: 400, y: 300 };
    const half = 25;
    const synthetic = [
      { x: client.x - half, y: client.y },
      { x: client.x + half, y: client.y },
    ];
    const stackOrigin = { x: 100, y: 50 };
    const preview = beginPinchPreview(1, synthetic, stackOrigin);
    // Centroid is exactly the cursor (shared beginPinchPreview math, no
    // second formula): commit captureZoomAnchor sees the same point.
    expect(preview.startCentroid).toEqual(client);
    expect(touchCentroid(synthetic)).toEqual(client);
    expect(preview.point).toEqual({
      x: client.x - stackOrigin.x,
      y: client.y - stackOrigin.y,
    });
    expect(preview.startDistance).toBe(50);
  });

  it('steps the gutter factor through the shared elasticZoom (no fork)', () => {
    const client = { x: 400, y: 300 };
    const preview = beginPinchPreview(
      1,
      [
        { x: client.x - 25, y: client.y },
        { x: client.x + 25, y: client.y },
      ],
      { x: 0, y: 0 },
    );
    const factor = Math.exp(0.2);
    const stepped = stepPinchPreviewWithFactor(preview, factor, {
      x: 0,
      y: 0,
    });
    expect(stepped.targetZoom).toBeCloseTo(factor, 9);
    // Overshoot resists (visual past bound) while settle stays legal.
    const over = beginPinchPreview(
      7.9,
      [
        { x: client.x - 25, y: client.y },
        { x: client.x + 25, y: client.y },
      ],
      { x: 0, y: 0 },
    );
    const pushed = stepPinchPreviewWithFactor(over, Math.exp(0.2), {
      x: 0,
      y: 0,
    });
    expect(pushed.targetZoom).toBeGreaterThan(8);
    expect(over.settledZoom).toBe(8);
  });
});
