/**
 * Camera/transform math: x-right/y-down doubles,
 * rotation radians clockwise around object centers, camera as ephemeral
 * viewport mapping. Pure headless behavior tests only.
 */

import { describe, expect, it } from 'vitest';
import {
  boundsIntersect,
  createCamera,
  normalizeBox,
  pointInEllipse,
  pointInRotatedBounds,
  rotatedBoundsAabb,
  surfaceToView,
  textEstBounds,
  viewToSurface,
  viewportSurfaceRect,
  zoomCameraAt,
} from './geometry.js';

describe('camera transforms', () => {
  it('round-trips points through arbitrary cameras', () => {
    for (const camera of [
      createCamera(0, 0, 1),
      createCamera(120, -40, 2.5),
      createCamera(-1e6, 3e5, 0.125),
    ]) {
      const p = { x: 37.5, y: -12.25 };
      const round = viewToSurface(camera, surfaceToView(camera, p));
      expect(round.x).toBeCloseTo(p.x, 9);
      expect(round.y).toBeCloseTo(p.y, 9);
    }
  });

  it('maps the viewport to a surface-space rectangle', () => {
    const camera = createCamera(100, 200, 2);
    const rect = viewportSurfaceRect(camera, { width: 800, height: 600 });
    expect(rect).toEqual({ x: 100, y: 200, width: 400, height: 300 });
  });

  it('zooming at a view focus keeps the focused surface point fixed', () => {
    const camera = createCamera(10, 20, 1);
    const focus = { x: 400, y: 300 };
    const before = viewToSurface(camera, focus);
    const zoomed = zoomCameraAt(camera, focus, 2);
    expect(zoomed.zoom).toBe(2);
    const after = viewToSurface(zoomed, focus);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('ignores invalid zoom factors instead of corrupting the camera', () => {
    const camera = createCamera(0, 0, 3);
    expect(zoomCameraAt(camera, { x: 1, y: 1 }, 0)).toEqual(camera);
    expect(zoomCameraAt(camera, { x: 1, y: 1 }, NaN)).toEqual(camera);
    expect(zoomCameraAt(camera, { x: 1, y: 1 }, Infinity)).toEqual(camera);
  });
});

describe('rotation bounds', () => {
  const unit = { x: 0, y: 0, width: 4, height: 2 };

  it('keeps axis-aligned bounds stable at zero rotation', () => {
    expect(rotatedBoundsAabb(unit, 0)).toEqual(unit);
  });

  it('swaps extents at a quarter turn', () => {
    const aabb = rotatedBoundsAabb(unit, Math.PI / 2);
    expect(aabb.width).toBeCloseTo(2, 9);
    expect(aabb.height).toBeCloseTo(4, 9);
  });

  it('grows the aabb at diagonal rotations', () => {
    const aabb = rotatedBoundsAabb(unit, Math.PI / 4);
    expect(aabb.width).toBeGreaterThan(4);
    expect(aabb.height).toBeGreaterThan(2);
  });
});

describe('hit geometry', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };

  it('normalizes drag corners into a positive box', () => {
    expect(normalizeBox({ x: 60, y: 40 }, { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 50,
      height: 30,
    });
  });

  it('tests points inside rotated boxes', () => {
    expect(pointInRotatedBounds(box, 0, { x: 5, y: 5 })).toBe(true);
    expect(pointInRotatedBounds(box, 0, { x: 11, y: 5 })).toBe(false);
    // A quarter turn turns the 10x2 bar into a 2x10 bar through the same
    // center (5,1): world points swap roles accordingly.
    const bar = { x: 0, y: 0, width: 10, height: 2 };
    expect(pointInRotatedBounds(bar, Math.PI / 2, { x: 5, y: 5.5 })).toBe(true);
    expect(pointInRotatedBounds(bar, Math.PI / 2, { x: 9, y: 1 })).toBe(false);
    expect(pointInRotatedBounds(bar, Math.PI / 2, { x: 4.5, y: 1 })).toBe(true);
  });

  it('tests points inside ellipses', () => {
    const ellipse = { x: 0, y: 0, width: 10, height: 4 };
    expect(pointInEllipse(ellipse, 0, { x: 5, y: 2 })).toBe(true);
    expect(pointInEllipse(ellipse, 0, { x: 5, y: 4.5 })).toBe(false);
    expect(pointInEllipse(ellipse, 0, { x: -0.5, y: 2 })).toBe(false);
    expect(pointInEllipse(ellipse, 0, { x: 9.8, y: 0.2 })).toBe(false);
  });
});

describe('text estimation and culling helpers', () => {
  it('derives deterministic estimated text bounds', () => {
    const b1 = textEstBounds({ x: 10, y: 20, size: 16 }, 'hello');
    const again = textEstBounds({ x: 10, y: 20, size: 16 }, 'hello');
    expect(b1).toEqual(again);
    expect(b1.x).toBe(10);
    // Nominal line box starts at the anchor and extends downward.
    expect(b1.y).toBe(20);
    expect(b1.height).toBeGreaterThan(16);

    const bigger = textEstBounds({ x: 10, y: 20, size: 32 }, 'hello');
    expect(bigger.width).toBeGreaterThan(b1.width);
  });

  it('treats touching bounds as intersecting and disjoint as not', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(boundsIntersect(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(true);
    expect(boundsIntersect(a, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
    expect(boundsIntersect(a, { x: -5, y: -5, width: 20, height: 6 })).toBe(true);
  });
});
