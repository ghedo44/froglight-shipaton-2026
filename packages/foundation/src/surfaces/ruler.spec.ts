/**
 * Straightedge ruler (slice 10): headless math, snap policy, and
 * ephemeral overlay items. Deterministic, DOM-free.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultRulerState,
  distanceToRuler,
  isValidRulerState,
  normalizeRulerAngle,
  projectPointToRuler,
  rulerEndpoints,
  rulerToDrawItems,
  shouldSnapToRuler,
  snapSamplesToRuler,
  RULER_SNAP_THRESHOLD,
  type SurfaceRulerState,
} from './ruler.js';

function horizontal(y = 100): SurfaceRulerState {
  return { visible: true, x: 0, y, angle: 0, length: 400 };
}

describe('ruler validation', () => {
  it('accepts a visible straightedge and the hidden default', () => {
    expect(isValidRulerState(horizontal())).toBe(true);
    expect(isValidRulerState(defaultRulerState())).toBe(true);
  });

  it('rejects malformed records', () => {
    expect(isValidRulerState(null)).toBe(false);
    expect(isValidRulerState({})).toBe(false);
    expect(
      isValidRulerState({ visible: true, x: 0, y: 0, angle: 0, length: 0 }),
    ).toBe(false);
    expect(
      isValidRulerState({ visible: true, x: 0, y: 0, angle: 0, length: -5 }),
    ).toBe(false);
    expect(
      isValidRulerState({
        visible: true,
        x: Number.NaN,
        y: 0,
        angle: 0,
        length: 100,
      }),
    ).toBe(false);
    expect(
      isValidRulerState({
        visible: 'yes',
        x: 0,
        y: 0,
        angle: 0,
        length: 100,
      }),
    ).toBe(false);
  });

  it('wraps angles to (-π, π]', () => {
    expect(normalizeRulerAngle(0)).toBeCloseTo(0, 10);
    expect(normalizeRulerAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(normalizeRulerAngle(Number.NaN)).toBe(0);
  });
});

describe('ruler projection', () => {
  it('projects onto a horizontal edge preserving the along-axis coordinate', () => {
    const ruler = horizontal(100);
    expect(projectPointToRuler({ x: 37, y: 140 }, ruler)).toEqual({
      x: 37,
      y: 100,
    });
    expect(distanceToRuler({ x: 37, y: 140 }, ruler)).toBeCloseTo(40, 10);
    expect(distanceToRuler({ x: -9, y: 100 }, ruler)).toBeCloseTo(0, 10);
  });

  it('projects onto a diagonal edge', () => {
    const ruler: SurfaceRulerState = {
      visible: true,
      x: 0,
      y: 0,
      angle: Math.PI / 4,
      length: 400,
    };
    // Points on the y=x diagonal stay fixed; the origin offset vanishes.
    expect(projectPointToRuler({ x: 10, y: 10 }, ruler)).toEqual({
      x: expect.closeTo(10, 10),
      y: expect.closeTo(10, 10),
    });
    expect(distanceToRuler({ x: 10, y: 0 }, ruler)).toBeCloseTo(
      10 / Math.SQRT2,
      10,
    );
  });

  it('snaps only when visible and within threshold', () => {
    const ruler = horizontal(100);
    expect(shouldSnapToRuler({ x: 0, y: 100 + RULER_SNAP_THRESHOLD }, ruler)).toBe(
      true,
    );
    expect(
      shouldSnapToRuler({ x: 0, y: 100 + RULER_SNAP_THRESHOLD + 0.5 }, ruler),
    ).toBe(false);
    expect(
      shouldSnapToRuler({ x: 0, y: 100 }, { ...ruler, visible: false }),
    ).toBe(false);
    expect(shouldSnapToRuler({ x: 0, y: 100 }, null)).toBe(false);
    expect(shouldSnapToRuler({ x: 0, y: 100 }, ruler, 0)).toBe(false);
  });
});

describe('sample snapping', () => {
  it('projects positions while preserving axes and unknown members', () => {
    const ruler = horizontal(100);
    const samples = [
      {
        x: 10,
        y: 130,
        pressure: 0.7,
        tilt: { x: 0.2, y: 0 },
        twist: 0.5,
        dt: 16,
        vendorFuture: 'kept',
      },
      { x: 30, y: 70 },
    ];
    const snapped = snapSamplesToRuler(samples, ruler);
    expect(snapped).toHaveLength(2);
    expect(snapped[0]).toMatchObject({
      x: 10,
      y: 100,
      pressure: 0.7,
      twist: 0.5,
      dt: 16,
      vendorFuture: 'kept',
    });
    expect(snapped[0]!.tilt).toEqual({ x: 0.2, y: 0 });
    expect(snapped[1]).toMatchObject({ x: 30, y: 100 });
    // Inputs untouched (pure).
    expect(samples[0]).toMatchObject({ y: 130 });
  });
});

describe('ruler overlay', () => {
  it('emits one guide line when visible and nothing when hidden', () => {
    const ruler = horizontal(50);
    const items = rulerToDrawItems(ruler);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'line', objectId: 'surface.ruler' });
    expect(rulerToDrawItems({ ...ruler, visible: false })).toEqual([]);
    expect(rulerToDrawItems(null)).toEqual([]);
  });

  it('spans the declared length around the anchor', () => {
    const ruler: SurfaceRulerState = {
      visible: true,
      x: 200,
      y: 200,
      angle: 0,
      length: 300,
    };
    const { ax, bx } = rulerEndpoints(ruler);
    expect(ax).toBeCloseTo(50, 10);
    expect(bx).toBeCloseTo(350, 10);
  });
});
