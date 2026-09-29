/** Shared eraser modes, content filters, and segment/box predicates.
 * Appearance-preserving subtraction lives in erasure.ts. */

import { SURFACE_OBJECT_TYPES, type SurfaceObjectRecord } from '../model.js';
import type { Point } from '../geometry.js';

/** Axis-aligned box for hit-testing (inclusive boundaries). */
export interface HitBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * True when segment ab touches or crosses an inclusive box — including
 * crossings with no endpoint inside (slab method, pure).
 */
export function segmentIntersectsBox(a: Point, b: Point, box: HitBox): boolean {
  if (
    a.x >= box.minX &&
    a.x <= box.maxX &&
    a.y >= box.minY &&
    a.y <= box.maxY
  ) {
    return true;
  }
  if (
    b.x >= box.minX &&
    b.x <= box.maxX &&
    b.y >= box.minY &&
    b.y <= box.maxY
  ) {
    return true;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x - box.minX) &&
    clip(dx, box.maxX - a.x) &&
    clip(-dy, a.y - box.minY) &&
    clip(dy, box.maxY - a.y) &&
    t0 <= t1
  );
}

/** Eraser behavior per gesture (slice 5). */
export const ERASER_MODES = ['stroke', 'precision'] as const;

export type EraserMode = (typeof ERASER_MODES)[number];

/**
 * Default eraser mode when no stored mode survives validation: whole-stroke
 * erase.
 */
export const DEFAULT_ERASER_MODE: EraserMode = 'stroke';

/**
 * Tolerant eraser-mode guard. Unknown, absent, or
 * non-string values read as absent (never throws) so corrupt preferences
 * degrade to the default tool instead of breaking.
 */
export function isEraserMode(value: unknown): value is EraserMode {
  return (
    typeof value === 'string' &&
    (ERASER_MODES as readonly string[]).includes(value)
  );
}

/** Lasso marquee shape (slice 6). */
export const LASSO_MODES = ['freehand', 'rectangle'] as const;

export type LassoMode = (typeof LASSO_MODES)[number];

/** What one eraser gesture may remove (slice 5). Text erases only under `all`/`text`. */
export const ERASER_FILTERS = [
  'all',
  'ink',
  'highlighter',
  'shapes',
  'images',
  'text',
] as const;

export type EraserFilter = (typeof ERASER_FILTERS)[number];

/**
 * True when a record is erasable under a filter. Highlighter strokes are
 * recognized by their stored brush kind (legacy strokes without a brush
 * member count as ink); shapes cover rect/ellipse/line/card; anything —
 * including text — erases under `all`. Unknown filters erase nothing.
 */
export function matchesEraserFilter(
  record: SurfaceObjectRecord,
  filter: EraserFilter,
): boolean {
  if (filter === 'all') return true;
  switch (record.type) {
    case SURFACE_OBJECT_TYPES.stroke: {
      const brush = record.brush;
      const kind =
        typeof brush === 'object' && brush !== null
          ? (brush as Record<string, unknown>).kind
          : undefined;
      const isHighlighter = kind === 'highlighter';
      if (filter === 'highlighter') return isHighlighter;
      if (filter === 'ink') return !isHighlighter;
      return false;
    }
    case SURFACE_OBJECT_TYPES.rectangle:
    case SURFACE_OBJECT_TYPES.ellipse:
    case SURFACE_OBJECT_TYPES.line:
    case SURFACE_OBJECT_TYPES.card:
      return filter === 'shapes';
    case SURFACE_OBJECT_TYPES.image:
      return filter === 'images';
    case SURFACE_OBJECT_TYPES.text:
      return filter === 'text';
    default:
      return false;
  }
}
