/**
 * Ephemeral selection drag session (Slice 1).
 *
 * Canonical records stay untouched during pointer movement; only
 * `delta` updates per frame. Renderers draw cached selection geometry
 * with an ephemeral translation transform. Pointer-up commits once;
 * pointer-cancel discards.
 */

import type { DrawItem } from './draw.js';
import type { Bounds, Point } from './geometry.js';
import type { SurfaceObjectId } from './model.js';

export interface SelectionDragSession {
  /** Ephemeral geometry for connectors attached to moving objects. */
  readonly followers: readonly DrawItem[];
  /** Logical selection ids captured at pointer-down. */
  readonly logicalIds: readonly SurfaceObjectId[];
  /** Surface-space grab point at drag start. */
  readonly startSurface: Point;
  /** Current surface-space translation (updated per move, never canonical). */
  delta: Point;
  /** Union bounds at drag start (computed once, translated per frame). */
  readonly startBounds: Bounds | null;
}

export function translateBounds(bounds: Bounds, delta: Point): Bounds {
  return {
    x: bounds.x + delta.x,
    y: bounds.y + delta.y,
    width: bounds.width,
    height: bounds.height,
  };
}
