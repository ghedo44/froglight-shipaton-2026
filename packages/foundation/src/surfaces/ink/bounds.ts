/**
 * Derived bounds for the smooth-stroke pipeline.
 *
 * Bounds are derived, never stored: the axis-aligned box of the compiled
 * outline ring (caps and joins included). The conservative sample-envelope
 * in `objects.ts` always contains these tight bounds; culling and
 * selection chrome use whichever fits the caller's needs, both derived
 * from the same compiled geometry truth.
 *
 * Headless, DOM-free, deterministic.
 */

import type { Bounds, Point } from '../geometry.js';

/** Empty bounds for empty geometry (never null — callers stay total). */
export const EMPTY_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 };

/** Axis-aligned bounds of a point cloud (outline ring, spine, caps). */
export function boundsOfPoints(points: readonly Point[]): Bounds {
  if (points.length === 0) return { ...EMPTY_BOUNDS };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { ...EMPTY_BOUNDS };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** True when `outer` contains `inner` (inclusive, with slack). */
export function boundsContain(
  outer: Bounds,
  inner: Bounds,
  slack = 1e-9,
): boolean {
  return (
    outer.x <= inner.x + slack &&
    outer.y <= inner.y + slack &&
    outer.x + outer.width >= inner.x + inner.width - slack &&
    outer.y + outer.height >= inner.y + inner.height - slack
  );
}

/** Union of two bounds (either may be empty). */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  if (a.width === 0 && a.height === 0) return { ...b };
  if (b.width === 0 && b.height === 0) return { ...a };
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
