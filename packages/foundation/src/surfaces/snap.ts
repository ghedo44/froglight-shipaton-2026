/**
 * Snap/alignment computation (slice 9, whiteboard): match moving
 * edge/center lines against static bounds within a threshold and emit
 * guide segments. Pure and headless; guides are ephemeral — they never
 * enter canonical data.
 */

import type { Bounds } from './geometry.js';

/** Guide color: the lasso-violet accent, shared product language. */
export const SNAP_GUIDE_COLOR = '#7c6cf0';

/** Guide segment padding past the matched pair, surface units. */
const GUIDE_PAD = 16;

export interface SnapGuide {
  readonly axis: 'x' | 'y';
  /** The aligned coordinate (a matched edge/center line). */
  readonly position: number;
  readonly from: number;
  readonly to: number;
}

export interface SnapResult {
  readonly dx: number;
  readonly dy: number;
  readonly guides: readonly SnapGuide[];
}

function axisLines(bounds: Bounds, horizontal: boolean): number[] {
  return horizontal
    ? [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height]
    : [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
}

function snapAxis(
  moving: Bounds,
  statics: readonly Bounds[],
  threshold: number,
  horizontal: boolean,
): { delta: number; guides: SnapGuide[] } {
  const mine = axisLines(moving, horizontal);
  let best: { delta: number; position: number } | null = null;
  for (const m of mine) {
    for (const target of statics) {
      for (const t of axisLines(target, horizontal)) {
        const delta = t - m;
        if (
          Math.abs(delta) <= threshold &&
          (best === null || Math.abs(delta) < Math.abs(best.delta))
        ) {
          best = { delta, position: t };
        }
      }
    }
  }
  if (best === null) return { delta: 0, guides: [] };
  // Span the guide across the moving box and every static box that
  // shares the matched line (within threshold of it).
  let from = horizontal ? moving.y : moving.x;
  let to = horizontal
    ? moving.y + moving.height
    : moving.x + moving.width;
  for (const target of statics) {
    const lines = axisLines(target, horizontal);
    if (lines.some((t) => Math.abs(t - best.position) <= threshold)) {
      const lo = horizontal ? target.y : target.x;
      const hi = horizontal ? target.y + target.height : target.x + target.width;
      from = Math.min(from, lo);
      to = Math.max(to, hi);
    }
  }
  const axis = horizontal ? 'y' : 'x';
  return {
    delta: best.delta,
    guides: [
      {
        axis,
        position: best.position,
        from: from - GUIDE_PAD,
        to: to + GUIDE_PAD,
      },
    ],
  };
}

/**
 * Snap a moving bounds against static bounds: independent per-axis
 * edge/center matching within `threshold` (surface units, ≤ 0 disables).
 * Deterministic: strict improvement wins, first candidate on ties.
 */
export function computeSnap(
  moving: Bounds,
  statics: readonly Bounds[],
  threshold: number,
): SnapResult {
  if (!(threshold > 0) || statics.length === 0) {
    return { dx: 0, dy: 0, guides: [] };
  }
  const x = snapAxis(moving, statics, threshold, false);
  const y = snapAxis(moving, statics, threshold, true);
  return { dx: x.delta, dy: y.delta, guides: [...x.guides, ...y.guides] };
}
