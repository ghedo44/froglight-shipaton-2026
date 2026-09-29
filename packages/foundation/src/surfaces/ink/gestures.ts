/**
 * Pen-gesture recognizers (writing-experience upgrade, slice 7): pure,
 * deterministic fits over confirmed samples — draw-and-hold shapes,
 * scribble-to-erase, circle-to-lasso. Thresholds are exported constants;
 * every boundary is pinned by unit tests. DOM-free and headless.
 */

import type { InkSample } from '../model.js';

export const GESTURE_THRESHOLDS = {
  /** Stillness before a hold gesture arms (provider timer, not used here). */
  holdMs: 500,
  /** Minimum samples for any shape fit. */
  minShapeSamples: 4,
  /** Minimum endpoint span for line/arrow fits. */
  minShapeSpan: 20,
  /** Max perpendicular deviation / length for lines. */
  lineMaxDeviationRatio: 0.08,
  /** Minimum head-hook turn (radians) for arrows. */
  arrowHeadMinTurnRadians: (100 * Math.PI) / 180,
  /** Fraction of samples forming the arrow shaft. */
  arrowShaftFraction: 0.75,
  /** Minimum samples hugging each rectangle edge. */
  rectMinEdgeSamples: 2,
  /** Edge proximity as a fraction of the smaller side. */
  rectEdgeToleranceRatio: 0.12,
  /** Max closure gap / perimeter for rectangles. */
  rectMaxClosureRatio: 0.25,
  /** Minimum sharp corner turns for rectangles. */
  rectMinCornerTurns: 3,
  /** Corner turn threshold (radians). */
  rectCornerTurnRadians: 1.0,
  /** Max mean radial error / mean radius for ellipses. */
  ellipseMaxRadialErrorRatio: 0.12,
  /** Minimum bounding-box side for ellipses. */
  ellipseMinSpan: 10,
  /** Max closure gap / perimeter for ellipses. */
  ellipseMaxClosureRatio: 0.2,
  /** Minimum direction reversals for a scribble. */
  scribbleMinReversals: 4,
  /** Scribbles stay flat: min bbox side / max side at most this. */
  scribbleMaxHeightRatio: 0.5,
  /** Minimum path length / bbox diagonal for scribbles. */
  scribbleMinOverdraw: 1.8,
  /** Minimum scribble path length. */
  scribbleMinLength: 30,
  /** Max closure gap / perimeter for circle-lasso. */
  circleMaxClosureRatio: 0.15,
  /** Minimum bbox squareness for circle-lasso. */
  circleMinRoundness: 0.6,
  /** Minimum samples for circle-lasso. */
  circleMinSamples: 8,
  /** Minimum loop span for circle-lasso. */
  circleMinSpan: 10,
  /** Max mean radial error for circle-lasso. */
  circleMaxRadialErrorRatio: 0.15,
} as const;

interface XY {
  readonly x: number;
  readonly y: number;
}

function pointsOf(samples: readonly InkSample[]): XY[] {
  const out: XY[] = [];
  for (const s of samples) {
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) out.push({ x: s.x, y: s.y });
  }
  return out;
}

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

function bboxOf(points: readonly XY[]): Box | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function pathLength(points: readonly XY[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

function perpDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/**
 * Direction change between consecutive segments, 0 (straight) to π
 * (full reversal). Zero-length segments are skipped by the caller.
 */
function turnAngle(a: XY, b: XY, c: XY): number {
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  return Math.atan2(Math.abs(cross), dot);
}

/** Non-degenerate path segments (drops zero-length repeats). */
function segmentsOf(points: readonly XY[]): Array<{ ax: number; ay: number; bx: number; by: number }> {
  const out: Array<{ ax: number; ay: number; bx: number; by: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) {
      out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }
  return out;
}

/** Ramanujan ellipse perimeter approximation. */
function ellipsePerimeter(w: number, h: number): number {
  const a = w / 2;
  const b = h / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

export interface LineFit {
  readonly kind: 'line';
  readonly x: number;
  readonly y: number;
  readonly x2: number;
  readonly y2: number;
}

function fitLine(points: readonly XY[]): LineFit | null {
  if (points.length < GESTURE_THRESHOLDS.minShapeSamples) return null;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < GESTURE_THRESHOLDS.minShapeSpan) return null;
  let maxDev = 0;
  for (const p of points) maxDev = Math.max(maxDev, perpDistance(p, a, b));
  if (maxDev / length > GESTURE_THRESHOLDS.lineMaxDeviationRatio) return null;
  return { kind: 'line', x: a.x, y: a.y, x2: b.x, y2: b.y };
}

/** Fit a line to explicit endpoints (tests + arrow shaft reuse). */
export function recognizeLine(samples: readonly InkSample[]): LineFit | null {
  return fitLine(pointsOf(samples));
}

export interface ArrowFit {
  readonly kind: 'arrow';
  readonly x: number;
  readonly y: number;
  readonly x2: number;
  readonly y2: number;
}

/** Fit a shaft plus a sharp head hook (slice 7). */
export function recognizeArrow(samples: readonly InkSample[]): ArrowFit | null {
  const points = pointsOf(samples);
  if (points.length < GESTURE_THRESHOLDS.minShapeSamples + 2) return null;
  const split = Math.floor(points.length * GESTURE_THRESHOLDS.arrowShaftFraction);
  const shaft = fitLine(points.slice(0, split));
  if (shaft === null) return null;
  // The head hook starts where the shaft ends: scan turns from just
  // before the split through the tail.
  let maxTurn = 0;
  for (let i = Math.max(1, split - 2); i + 1 < points.length; i++) {
    maxTurn = Math.max(maxTurn, turnAngle(points[i - 1]!, points[i]!, points[i + 1]!));
  }
  if (maxTurn < GESTURE_THRESHOLDS.arrowHeadMinTurnRadians) return null;
  // Tip: furthest projection onto the shaft direction.
  const dx = shaft.x2 - shaft.x;
  const dy = shaft.y2 - shaft.y;
  const len = Math.hypot(dx, dy) || 1;
  let tip = points[points.length - 1]!;
  let best = -Infinity;
  for (const p of points) {
    const t = ((p.x - shaft.x) * dx + (p.y - shaft.y) * dy) / len;
    if (t > best) {
      best = t;
      tip = p;
    }
  }
  return { kind: 'arrow', x: points[0]!.x, y: points[0]!.y, x2: tip.x, y2: tip.y };
}

export interface RectFit {
  readonly kind: 'rectangle';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Fit a closed rectangular path to its bounding box (slice 7). */
export function recognizeRectangle(samples: readonly InkSample[]): RectFit | null {
  const points = pointsOf(samples);
  if (points.length < GESTURE_THRESHOLDS.minShapeSamples + 2) return null;
  const box = bboxOf(points);
  if (box === null) return null;
  if (box.width < GESTURE_THRESHOLDS.minShapeSpan || box.height < GESTURE_THRESHOLDS.minShapeSpan) {
    return null;
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const closure =
    Math.hypot(last.x - first.x, last.y - first.y) / (2 * (box.width + box.height));
  if (closure > GESTURE_THRESHOLDS.rectMaxClosureRatio) return null;
  // Every edge needs sample coverage within tolerance.
  const tol = GESTURE_THRESHOLDS.rectEdgeToleranceRatio * Math.min(box.width, box.height);
  const near = [0, 0, 0, 0];
  for (const p of points) {
    if (Math.abs(p.y - box.minY) <= tol && p.x >= box.minX - tol && p.x <= box.maxX + tol) near[0]! += 1;
    if (Math.abs(p.y - box.maxY) <= tol && p.x >= box.minX - tol && p.x <= box.maxX + tol) near[1]! += 1;
    if (Math.abs(p.x - box.minX) <= tol && p.y >= box.minY - tol && p.y <= box.maxY + tol) near[2]! += 1;
    if (Math.abs(p.x - box.maxX) <= tol && p.y >= box.minY - tol && p.y <= box.maxY + tol) near[3]! += 1;
  }
  if (near.some((count) => count < GESTURE_THRESHOLDS.rectMinEdgeSamples)) return null;
  // Sharp corners distinguish rectangles from round loops.
  const segments = segmentsOf(points);
  let corners = 0;
  for (let i = 1; i < segments.length; i++) {
    const a = segments[i - 1]!;
    const b = segments[i]!;
    if (
      turnAngle({ x: a.ax, y: a.ay }, { x: a.bx, y: a.by }, { x: b.bx, y: b.by }) >
      GESTURE_THRESHOLDS.rectCornerTurnRadians
    ) {
      corners += 1;
    }
  }
  if (corners < GESTURE_THRESHOLDS.rectMinCornerTurns) return null;
  return { kind: 'rectangle', x: box.minX, y: box.minY, width: box.width, height: box.height };
}

export interface EllipseFit {
  readonly kind: 'ellipse';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function radialError(points: readonly XY[]): number | null {
  if (points.length === 0) return null;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;
  let mean = 0;
  const radii: number[] = [];
  for (const p of points) {
    const r = Math.hypot(p.x - cx, p.y - cy);
    radii.push(r);
    mean += r;
  }
  mean /= radii.length;
  if (mean < 1e-9) return null;
  let err = 0;
  for (const r of radii) err += Math.abs(r - mean);
  return err / radii.length / mean;
}

/** Fit a closed loop to its bounding box (slice 7). */
export function recognizeEllipse(samples: readonly InkSample[]): EllipseFit | null {
  const points = pointsOf(samples);
  if (points.length < GESTURE_THRESHOLDS.minShapeSamples + 2) return null;
  const box = bboxOf(points);
  if (box === null) return null;
  if (box.width < GESTURE_THRESHOLDS.ellipseMinSpan || box.height < GESTURE_THRESHOLDS.ellipseMinSpan) {
    return null;
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const closure =
    Math.hypot(last.x - first.x, last.y - first.y) / ellipsePerimeter(box.width, box.height);
  if (closure > GESTURE_THRESHOLDS.ellipseMaxClosureRatio) return null;
  const err = radialError(points);
  if (err === null || err > GESTURE_THRESHOLDS.ellipseMaxRadialErrorRatio) return null;
  return { kind: 'ellipse', x: box.minX, y: box.minY, width: box.width, height: box.height };
}

export type ShapeFit = LineFit | ArrowFit | RectFit | EllipseFit;

/**
 * Best-fit shape across kinds, most specific first. Returns null for
 * ordinary handwriting.
 */
export function recognizeShape(samples: readonly InkSample[]): ShapeFit | null {
  return (
    recognizeArrow(samples) ??
    recognizeRectangle(samples) ??
    recognizeEllipse(samples) ??
    recognizeLine(samples)
  );
}

export interface ScribbleHit {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Deliberate scribble-to-erase: dense zigzag overdraw in a flat zone.
 * Conservative by design — ordinary w-like writing stays ink.
 */
export function recognizeScribble(samples: readonly InkSample[]): ScribbleHit | null {
  const points = pointsOf(samples);
  if (points.length < GESTURE_THRESHOLDS.minShapeSamples + 2) return null;
  const length = pathLength(points);
  if (length < GESTURE_THRESHOLDS.scribbleMinLength) return null;
  const box = bboxOf(points);
  if (box === null) return null;
  const longSide = Math.max(box.width, box.height);
  const shortSide = Math.min(box.width, box.height);
  if (longSide < 1e-9) return null;
  if (shortSide / longSide > GESTURE_THRESHOLDS.scribbleMaxHeightRatio) return null;
  if (length / Math.hypot(box.width, box.height) < GESTURE_THRESHOLDS.scribbleMinOverdraw) {
    return null;
  }
  // Direction reversals on the dominant axis (zero-deltas ignored).
  let reversalsX = 0;
  let reversalsY = 0;
  let lastSignX = 0;
  let lastSignY = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    const signX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const signY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    if (signX !== 0) {
      if (lastSignX !== 0 && signX !== lastSignX) reversalsX += 1;
      lastSignX = signX;
    }
    if (signY !== 0) {
      if (lastSignY !== 0 && signY !== lastSignY) reversalsY += 1;
      lastSignY = signY;
    }
  }
  if (Math.max(reversalsX, reversalsY) < GESTURE_THRESHOLDS.scribbleMinReversals) {
    return null;
  }
  return { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY };
}

export interface CircleHit {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Closed round loop for circle-to-lasso conversion (slice 7). */
export function recognizeCircle(samples: readonly InkSample[]): CircleHit | null {
  const points = pointsOf(samples);
  if (points.length < GESTURE_THRESHOLDS.circleMinSamples) return null;
  const box = bboxOf(points);
  if (box === null) return null;
  if (Math.max(box.width, box.height) < GESTURE_THRESHOLDS.circleMinSpan) {
    return null;
  }
  if (
    Math.min(box.width, box.height) / Math.max(box.width, box.height) <
    GESTURE_THRESHOLDS.circleMinRoundness
  ) {
    return null;
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const closure =
    Math.hypot(last.x - first.x, last.y - first.y) /
    ellipsePerimeter(box.width, box.height);
  if (closure > GESTURE_THRESHOLDS.circleMaxClosureRatio) return null;
  const err = radialError(points);
  if (err === null || err > GESTURE_THRESHOLDS.circleMaxRadialErrorRatio) {
    return null;
  }
  return {
    x: box.minX + box.width / 2,
    y: box.minY + box.height / 2,
    radius: (box.width + box.height) / 4,
  };
}
