/**
 * Notebook stack zoom and gesture math.
 *
 * Pure calculations for pager-level zoom: clamping, touch centroid and
 * pinch distance, and pinch-preview stepping.
 * The pager owns the current zoom value, DOM reads, style writes, and the
 * touch-event state machine; this module never touches DOM, models, or
 * stroke/object coordinates.
 */

import { elasticZoom } from '@froglight/editor-ink';

export const NOTEBOOK_MIN_ZOOM = 0.25;
export const NOTEBOOK_MAX_ZOOM = 8;

export interface ZoomPoint {
  readonly x: number;
  readonly y: number;
}

/** Clamp a zoom factor to the finite sheet range. */
export function clampNotebookZoom(current: number, requested: number): number {
  if (!Number.isFinite(requested)) return current;
  return Math.min(Math.max(requested, NOTEBOOK_MIN_ZOOM), NOTEBOOK_MAX_ZOOM);
}

/** Average touch points into a centroid. */
export function touchCentroid(points: readonly ZoomPoint[]): ZoomPoint {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  const count = Math.max(points.length, 1);
  return { x: x / count, y: y / count };
}

/** Pinch distance with a unit floor so a single touch never divides by zero. */
export function touchPinchDistance(points: readonly ZoomPoint[]): number {
  const [first, second] = points;
  return first === undefined || second === undefined
    ? 1
    : Math.max(Math.hypot(first.x - second.x, first.y - second.y), 1);
}

export interface PinchPreview {
  readonly baseZoom: number;
  startCentroid: ZoomPoint;
  startDistance: number;
  readonly point: ZoomPoint;
  baseScale: number;
  baseTranslation: ZoomPoint;
  scale: number;
  settledZoom: number;
  targetZoom: number;
  translation: ZoomPoint;
}

/** Start a pinch preview from the current touches and stack origin. */
export function beginPinchPreview(
  baseZoom: number,
  touches: readonly ZoomPoint[],
  stackOrigin: ZoomPoint,
): PinchPreview {
  const startCentroid = touchCentroid(touches);
  return {
    baseZoom,
    startCentroid,
    startDistance: touchPinchDistance(touches),
    point: {
      x: startCentroid.x - stackOrigin.x,
      y: startCentroid.y - stackOrigin.y,
    },
    baseScale: 1,
    baseTranslation: { x: 0, y: 0 },
    scale: 1,
    settledZoom: baseZoom,
    targetZoom: baseZoom,
    translation: { x: 0, y: 0 },
  };
}

/** Step a pinch preview from the current touches (pure; no style writes). */
export function stepPinchPreview(
  preview: PinchPreview,
  touches: readonly ZoomPoint[],
): { targetZoom: number; translation: ZoomPoint; scale: number } {
  const centroid = touchCentroid(touches);
  const factor = touchPinchDistance(touches) / preview.startDistance;
  const requestedZoom = preview.baseZoom * preview.baseScale * factor;
  const outwardAtSaturatedLimit =
    (preview.baseZoom <= NOTEBOOK_MIN_ZOOM &&
      requestedZoom < NOTEBOOK_MIN_ZOOM) ||
    (preview.baseZoom >= NOTEBOOK_MAX_ZOOM &&
      requestedZoom > NOTEBOOK_MAX_ZOOM);
  if (outwardAtSaturatedLimit) {
    preview.settledZoom = preview.baseZoom;
    return {
      targetZoom: preview.baseZoom,
      translation: {
        x: preview.baseTranslation.x + centroid.x - preview.startCentroid.x,
        y: preview.baseTranslation.y + centroid.y - preview.startCentroid.y,
      },
      scale: 1,
    };
  }
  const elastic = elasticZoom(
    requestedZoom,
    NOTEBOOK_MIN_ZOOM,
    NOTEBOOK_MAX_ZOOM,
  );
  const targetZoom = elastic.visualZoom;
  preview.settledZoom = elastic.settledZoom;
  return {
    targetZoom,
    translation: {
      x: preview.baseTranslation.x + centroid.x - preview.startCentroid.x,
      y: preview.baseTranslation.y + centroid.y - preview.startCentroid.y,
    },
    scale: targetZoom / preview.baseZoom,
  };
}

/** Rebase a changed primary pair from the currently displayed transform. */
export function rebasePinchPreview(
  preview: PinchPreview,
  touches: readonly ZoomPoint[],
): void {
  preview.startCentroid = touchCentroid(touches);
  preview.startDistance = touchPinchDistance(touches);
  preview.baseScale = preview.scale;
  preview.baseTranslation = preview.translation;
}

/**
 * Step a pinch preview from an incremental factor plus a centroid delta
 * (embedded driver).
 *
 * Pure except for updating `preview.settledZoom` like `stepPinchPreview`;
 * the caller assigns the returned target/scale/translation. Delegates to
 * the single shared `elasticZoom` — no second resistance formula.
 * Non-finite/non-positive factors are treated as 1 (no zoom change);
 * non-finite deltas are treated as 0. Never throws.
 */
export function stepPinchPreviewWithFactor(
  preview: PinchPreview,
  factor: number,
  centroidDelta: ZoomPoint,
): { targetZoom: number; translation: ZoomPoint; scale: number } {
  const safeFactor =
    typeof factor === 'number' && Number.isFinite(factor) && factor > 0
      ? factor
      : 1;
  const dx =
    typeof centroidDelta.x === 'number' && Number.isFinite(centroidDelta.x)
      ? centroidDelta.x
      : 0;
  const dy =
    typeof centroidDelta.y === 'number' && Number.isFinite(centroidDelta.y)
      ? centroidDelta.y
      : 0;
  const requestedZoom = preview.targetZoom * safeFactor;
  const outwardAtSaturatedLimit =
    (preview.baseZoom <= NOTEBOOK_MIN_ZOOM &&
      preview.targetZoom <= NOTEBOOK_MIN_ZOOM &&
      requestedZoom < NOTEBOOK_MIN_ZOOM) ||
    (preview.baseZoom >= NOTEBOOK_MAX_ZOOM &&
      preview.targetZoom >= NOTEBOOK_MAX_ZOOM &&
      requestedZoom > NOTEBOOK_MAX_ZOOM);
  if (outwardAtSaturatedLimit) {
    preview.settledZoom = preview.baseZoom;
    return {
      targetZoom: preview.targetZoom,
      translation: {
        x: preview.translation.x + dx,
        y: preview.translation.y + dy,
      },
      scale: preview.targetZoom / preview.baseZoom,
    };
  }
  const elastic = elasticZoom(
    requestedZoom,
    NOTEBOOK_MIN_ZOOM,
    NOTEBOOK_MAX_ZOOM,
  );
  const targetZoom = elastic.visualZoom;
  preview.settledZoom = elastic.settledZoom;
  return {
    targetZoom,
    translation: {
      x: preview.translation.x + dx,
      y: preview.translation.y + dy,
    },
    scale: targetZoom / preview.baseZoom,
  };
}
