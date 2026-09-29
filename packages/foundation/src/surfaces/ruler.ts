/**
 * Surface straightedge ruler (slice 10, notebook).
 *
 * Headless, DOM/Canvas/React/Tauri-free, deterministic. The ruler is
 * ephemeral UI state: it never enters canonical `SurfaceModel` data, undo
 * history, or dirty state. Ink drawn against it commits as ordinary
 * `froglight.ink.stroke` samples (projected x/y, all other axes and
 * unknown members preserved verbatim).
 *
 * A protractor mode is explicitly deferred: this straightedge covers the
 * plan's "ruler" requirement; angular measurement stays an open decision.
 */

import type { DrawItem } from './draw.js';
import { SURFACE_MAX_COORDINATE, type InkSample } from './model.js';
import type { Point } from './geometry.js';

/**
 * Straightedge state in surface coordinates (stable across zoom/DPR).
 * `angle` is the edge direction in radians; `length` is the visible
 * edge length. `visible === false` disables both rendering and snapping.
 */
export interface SurfaceRulerState {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly length: number;
}

/** Default edge length in surface units. */
export const RULER_DEFAULT_LENGTH = 400;
/** Snap distance in surface units: samples this close snap to the edge. */
export const RULER_SNAP_THRESHOLD = 12;
/** Snap distance in view (screen) units: visual tolerance stays constant
 * across zoom; convert with `rulerSnapThresholdSurface(zoom)`. */
export const RULER_SNAP_THRESHOLD_VIEW = 12;
/** Overlay object id for the ephemeral ruler guide (never canonical). */
export const RULER_OVERLAY_ID = 'surface.ruler';
/** Guide color: the snap-guide violet accent, shared product language. */
export const RULER_GUIDE_COLOR = '#7c6cf0';

function isFiniteCoord(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= SURFACE_MAX_COORDINATE
  );
}

/** True for a structurally valid ruler record (any visibility). */
export function isValidRulerState(value: unknown): value is SurfaceRulerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.visible !== 'boolean') return false;
  if (!isFiniteCoord(record.x) || !isFiniteCoord(record.y)) return false;
  if (typeof record.angle !== 'number' || !Number.isFinite(record.angle)) {
    return false;
  }
  return (
    typeof record.length === 'number' &&
    Number.isFinite(record.length) &&
    record.length > 0 &&
    record.length <= SURFACE_MAX_COORDINATE
  );
}

/** Hidden ruler default centered on `center` (horizontal edge). */
export function defaultRulerState(
  center: Point = { x: 0, y: 0 },
): SurfaceRulerState {
  return {
    visible: false,
    x: center.x,
    y: center.y,
    angle: 0,
    length: RULER_DEFAULT_LENGTH,
  };
}

/** Wrap an angle to (-π, π]. */
export function normalizeRulerAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const tau = Math.PI * 2;
  let wrapped = (angle + Math.PI) % tau;
  if (wrapped <= 0) wrapped += tau;
  return wrapped - Math.PI;
}

/** Unit direction vector of the ruler edge. */
export function rulerDirection(ruler: SurfaceRulerState): Point {
  return { x: Math.cos(ruler.angle), y: Math.sin(ruler.angle) };
}

/** Unit normal vector of the ruler edge. */
export function rulerNormal(ruler: SurfaceRulerState): Point {
  return { x: -Math.sin(ruler.angle), y: Math.cos(ruler.angle) };
}

/** Absolute distance from a surface point to the ruler edge (infinite line). */
export function distanceToRuler(
  point: Point,
  ruler: SurfaceRulerState,
): number {
  const normal = rulerNormal(ruler);
  return Math.abs(
    (point.x - ruler.x) * normal.x + (point.y - ruler.y) * normal.y,
  );
}

/**
 * Absolute distance from a surface point to the FINITE visible ruler
 * segment (endpoints from `rulerEndpoints`). Latch decisions must use
 * this, not the infinite line: far beyond the endpoints must not snap.
 */
export function distanceToRulerSegment(
  point: Point,
  ruler: SurfaceRulerState,
): number {
  const { ax, ay, bx, by } = rulerEndpoints(ruler);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (!(lenSq > 0)) return Math.hypot(point.x - ax, point.y - ay);
  const t = Math.min(
    Math.max(((point.x - ax) * dx + (point.y - ay) * dy) / lenSq, 0),
    1,
  );
  return Math.hypot(point.x - (ax + dx * t), point.y - (ay + dy * t));
}

/**
 * Convert a view-space snap tolerance to surface units at `zoom`.
 * Ruler activation feels constant on screen instead of shrinking when
 * zoomed out or growing when zoomed in.
 */
export function rulerSnapThresholdSurface(
  zoom: number,
  viewThreshold: number = RULER_SNAP_THRESHOLD_VIEW,
): number {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return RULER_SNAP_THRESHOLD;
  if (!(viewThreshold > 0) || !Number.isFinite(viewThreshold)) {
    return RULER_SNAP_THRESHOLD;
  }
  return viewThreshold / zoom;
}

/** Project a surface point onto the ruler edge (infinite line). */
export function projectPointToRuler(
  point: Point,
  ruler: SurfaceRulerState,
): Point {
  const direction = rulerDirection(ruler);
  const dx = point.x - ruler.x;
  const dy = point.y - ruler.y;
  const along = dx * direction.x + dy * direction.y;
  return { x: ruler.x + direction.x * along, y: ruler.y + direction.y * along };
}

/**
 * True when a surface point should snap: the ruler is visible, valid,
 * and the point lies within `threshold` of the FINITE edge segment.
 * After a stroke latches, projection may use the supporting line for a
 * continuous straightedge; the latch itself never uses the infinite line.
 */
export function shouldSnapToRuler(
  point: Point,
  ruler: SurfaceRulerState | null | undefined,
  threshold: number = RULER_SNAP_THRESHOLD,
): boolean {
  if (ruler === null || ruler === undefined || ruler.visible !== true)
    return false;
  if (!isValidRulerState(ruler)) return false;
  if (!(threshold > 0)) return false;
  return distanceToRulerSegment(point, ruler) <= threshold;
}

/**
 * Project sample positions onto the ruler edge, preserving pressure,
 * tilt, twist, dt, and unknown members verbatim. Pure: inputs untouched.
 */
export function snapSamplesToRuler(
  samples: readonly InkSample[],
  ruler: SurfaceRulerState,
): InkSample[] {
  return samples.map((sample) => {
    const projected = projectPointToRuler(sample, ruler);
    return { ...sample, x: projected.x, y: projected.y };
  });
}

/** Edge endpoints for overlay rendering (anchor ± direction × length/2). */
export function rulerEndpoints(ruler: SurfaceRulerState): {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
} {
  const direction = rulerDirection(ruler);
  const half = ruler.length / 2;
  return {
    ax: ruler.x - direction.x * half,
    ay: ruler.y - direction.y * half,
    bx: ruler.x + direction.x * half,
    by: ruler.y + direction.y * half,
  };
}

/**
 * Ephemeral overlay items for the ruler guide: one line when visible,
 * empty when hidden/invalid. Never canonical — providers render these
 * as preview overlays alongside snap guides.
 */
export function rulerToDrawItems(
  ruler: SurfaceRulerState | null | undefined,
  objectId: string = RULER_OVERLAY_ID,
): DrawItem[] {
  if (ruler === null || ruler === undefined || ruler.visible !== true)
    return [];
  if (!isValidRulerState(ruler)) return [];
  const { ax, ay, bx, by } = rulerEndpoints(ruler);
  return [
    {
      kind: 'line',
      objectId,
      bounds: {
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        width: Math.abs(bx - ax),
        height: Math.abs(by - ay),
      },
      rotation: 0,
      x: ax,
      y: ay,
      x2: bx,
      y2: by,
      width: 2,
      color: RULER_GUIDE_COLOR,
    },
  ];
}
