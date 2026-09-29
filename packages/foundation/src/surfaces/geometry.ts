/**
 * Surface geometry and camera math.
 *
 * Pure double-precision functions: x right, y down, rotation in radians
 * positive clockwise around object centers. The camera is the ephemeral
 * viewport mapping `{x, y, zoom}`; nothing here touches canonical data.
 *
 * Surface text layout constants and effective-value predicates are single-sourced
 * from `model.ts`: geometry never re-states
 * the `SURFACE_MAX_COORDINATE` cap or the `16` / `0.6` / `1.25` defaults.
 */

import {
  TEXT_AVG_ADVANCE_FACTOR,
  TEXT_DEFAULT_SIZE,
  TEXT_LINE_HEIGHT_FACTOR,
  effectiveSurfaceTextSizeOf,
  textWrapWidthOf,
} from './model.js';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Axis-aligned bounds in surface space. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ephemeral viewport mapping; never serialized into canonical payloads. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export function createCamera(x = 0, y = 0, zoom = 1): Camera {
  return { x, y, zoom };
}

/** Map a surface point to view (viewport pixel) coordinates. */
export function surfaceToView(camera: Camera, p: Point): Point {
  return {
    x: (p.x - camera.x) * camera.zoom,
    y: (p.y - camera.y) * camera.zoom,
  };
}

/** Map a view point back to surface coordinates. */
export function viewToSurface(camera: Camera, p: Point): Point {
  return { x: p.x / camera.zoom + camera.x, y: p.y / camera.zoom + camera.y };
}

/** The camera-visible rectangle in surface coordinates. */
export function viewportSurfaceRect(camera: Camera, viewport: Size): Bounds {
  return {
    x: camera.x,
    y: camera.y,
    width: viewport.width / camera.zoom,
    height: viewport.height / camera.zoom,
  };
}

/** Axis-aligned envelope spanning two surface points (drag order-free). */
export function normalizeBox(a: Point, b: Point): Bounds {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Zoom by `factor` keeping the surface point under `focusView` fixed on
 * screen. Invalid factors leave the camera unchanged.
 */
export function zoomCameraAt(
  camera: Camera,
  focusView: Point,
  factor: number,
): Camera {
  if (!Number.isFinite(factor) || factor <= 0) return camera;
  const focusSurface = viewToSurface(camera, focusView);
  const zoom = camera.zoom * factor;
  return {
    x: focusSurface.x - focusView.x / zoom,
    y: focusSurface.y - focusView.y / zoom,
    zoom,
  };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

/** Finite double or null — the single gate for geometry numbers. */
export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Center of a bounds rectangle. */
export function centerOfBounds(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Rotate a point around a center by radians (clockwise, y-down). */
export function rotateAround(p: Point, center: Point, rotation: number): Point {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/** Inverse of rotateAround: map a world point into unrotated local frame. */
export function unrotateAround(
  p: Point,
  center: Point,
  rotation: number,
): Point {
  return rotateAround(p, center, -rotation);
}

/** Conservative AABB of `bounds` after rotating around its own center. */
export function rotatedBoundsAabb(bounds: Bounds, rotation: number): Bounds {
  if (!Number.isFinite(rotation) || rotation === 0) return { ...bounds };
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
  const center = centerOfBounds(bounds);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const rotated = rotateAround(corner, center, rotation);
    minX = Math.min(minX, rotated.x);
    minY = Math.min(minY, rotated.y);
    maxX = Math.max(maxX, rotated.x);
    maxY = Math.max(maxY, rotated.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Point-in-box test in the box's local (unrotated) frame. */
export function pointInRotatedBounds(
  bounds: Bounds,
  rotation: number,
  p: Point,
): boolean {
  const local = unrotateAround(p, centerOfBounds(bounds), rotation);
  return (
    local.x >= bounds.x &&
    local.x <= bounds.x + bounds.width &&
    local.y >= bounds.y &&
    local.y <= bounds.y + bounds.height
  );
}

/** Point-in-ellipse test in the ellipse's local (unrotated) frame. */
export function pointInEllipse(
  bounds: Bounds,
  rotation: number,
  p: Point,
): boolean {
  const center = centerOfBounds(bounds);
  const local = unrotateAround(p, center, rotation);
  const rx = bounds.width / 2;
  const ry = bounds.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const nx = (local.x - center.x) / rx;
  const ny = (local.y - center.y) / ry;
  return nx * nx + ny * ny <= 1;
}

/** Shortest distance from `p` to the segment `a–b`, in the same units. */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/**
 * Shortest distance from `p` to the polyline through `points`. Returns
 * Infinity for polylines with fewer than one finite point.
 */
export function pointPolylineDistance(p: Point, points: readonly Point[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) {
    return Number.isFinite(points[0]!.x) && Number.isFinite(points[0]!.y)
      ? Math.hypot(p.x - points[0]!.x, p.y - points[0]!.y)
      : Infinity;
  }
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    best = Math.min(best, pointSegmentDistance(p, points[i]!, points[i + 1]!));
    if (best === 0) return 0;
  }
  return best;
}

/**
 * True when segment ab touches or crosses a closed polygon (either
 * endpoint inside, or any proper edge crossing). Used by lasso selection
 * so sparse strokes crossing a marquee are selected even when no stored
 * sample falls inside it.
 */
export function segmentIntersectsPolygon(
  a: Point,
  b: Point,
  polygon: readonly Point[],
): boolean {
  if (polygon.length < 3) return false;
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return true;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (segmentsIntersect(a, b, polygon[j]!, polygon[i]!)) return true;
  }
  return false;
}

function orientation(p: Point, q: Point, r: Point): number {
  const value = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  return (
    q.x <= Math.max(p.x, r.x) + 1e-9 &&
    q.x >= Math.min(p.x, r.x) - 1e-9 &&
    q.y <= Math.max(p.y, r.y) + 1e-9 &&
    q.y >= Math.min(p.y, r.y) - 1e-9
  );
}

/** True when segments p1q1 and p2q2 touch or cross (inclusive). */
export function segmentsIntersect(p1: Point, q1: Point, p2: Point, q2: Point): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(p1, p2, q1)) ||
    (o2 === 0 && onSegment(p1, q2, q1)) ||
    (o3 === 0 && onSegment(p2, p1, q2)) ||
    (o4 === 0 && onSegment(p2, q1, q2))
  );
}

/**
 * True when segment ab comes within `radius` of point `center`
 * (segment-vs-disc intersection, inclusive of tangents).
 */
export function segmentIntersectsDisc(
  a: Point,
  b: Point,
  center: Point,
  radius: number,
): boolean {
  return pointSegmentDistance(center, a, b) <= Math.max(radius, 0);
}

/**
 * True when segment ab comes within `radius` of segment cd
 * (segment-vs-capsule intersection for precision-eraser ribbons).
 */
export function segmentIntersectsCapsule(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  radius: number,
): boolean {
  return segmentSegmentDistance(a, b, c, d) <= Math.max(radius, 0);
}

/** Shortest distance between segments ab and cd. */
export function segmentSegmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}
/**
 * Ray-casting containment for a closed polygon (implicit closing edge).
 * Deterministic and host-free; used by lasso selection.
 */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Deterministic estimated bounds for text objects, used only for
 * hit-testing and culling — renderers draw real text metrics. `(x, y)`
 * is the top-left of a nominal line box `1.25em` tall; renderers place
 * the baseline at `y + size`. Width assumes an average glyph advance of
 * 0.6em.
 *
 * Single-line estimate. `textV2EstBounds` adds explicit `\n` breaks and
 * `wrapWidth` soft breaks while keeping the same unwrapped estimate.
 */
export function textEstBounds(
  geo: { x: number; y: number; size?: unknown },
  text: string,
): Bounds {
  const size =
    typeof geo.size === 'number' && Number.isFinite(geo.size)
      ? geo.size
      : TEXT_DEFAULT_SIZE;
  const width = text.length * TEXT_AVG_ADVANCE_FACTOR * size;
  const height = size * TEXT_LINE_HEIGHT_FACTOR;
  return { x: geo.x, y: geo.y, width, height };
}

/**
 * Deterministic Surface text bounds. Canonical measurements use the headless
 * estimate so culling and hit areas remain stable across renderers; a
 * provider may supply display metrics through `measureLineWidth` without
 * changing canonical records. The envelope has no renderer padding.
 *
 * Rules:
 * - Per-line height = `1.25 × effectiveSize`.
 * - Explicit `\n` always breaks (handles `\r\n` deterministically).
 *   Valid `wrapWidth` additionally soft-breaks via greedy word-wrap
 *   (char fallback for long words) using the estimate metrics.
 * - `boxWidth` = `wrapWidth` when valid, else longest explicit-line
 *   estimate width. Total height = `lineCount × 1.25 × effectiveSize`.
 * - `align` MUST NOT move `(x, y)` or resize the envelope (align-invariant).
 * - `(x, y)` is the top-left of the first line box (pre-rotation);
 *   rotation pivots around the CENTER of this envelope (see
 *   `rotatedBoundsAabb` / backend `centerOfBounds`).
 */
export function estimateTextLineWidth(
  line: string,
  effectiveSize: number,
): number {
  return line.length * TEXT_AVG_ADVANCE_FACTOR * effectiveSize;
}

/** Split on `\n`, stripping a trailing `\r` per line (deterministic CRLF). */
export function splitTextLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function maxCharsForWidth(wrapWidth: number, effectiveSize: number): number {
  const perChar = TEXT_AVG_ADVANCE_FACTOR * effectiveSize;
  if (!(perChar > 0) || !Number.isFinite(perChar)) return 1;
  return Math.max(1, Math.floor(wrapWidth / perChar));
}

/**
 * Greedy word-wrap of one explicit line to fit `wrapWidth` (estimate
 * metrics). Words split on single spaces with collapsing (preserved
 * verbatim in the record; only layout normalizes); words longer than
 * the line are char-split. Returns sub-lines in order (never empty).
 */
export function wrapTextLine(
  line: string,
  effectiveSize: number,
  wrapWidth: number,
  measureLineWidth: (line: string, effectiveSize: number) => number = estimateTextLineWidth,
): string[] {
  if (line === '') return [''];
  if (measureLineWidth(line, effectiveSize) <= wrapWidth) return [line];
  const maxChars = maxCharsForWidth(wrapWidth, effectiveSize);
  const fits = (candidate: string): boolean =>
    measureLineWidth === estimateTextLineWidth
      ? candidate.length <= maxChars
      : measureLineWidth(candidate, effectiveSize) <= wrapWidth;
  const words: string[] = [];
  for (const word of line.split(' ')) {
    if (word === '') continue;
    if (fits(word)) {
      words.push(word);
      continue;
    }
    // Find the longest fitting prefix using the same metrics as the line.
    // Code points keep surrogate pairs together when a word needs splitting.
    const chars = Array.from(word);
    let start = 0;
    while (start < chars.length) {
      let low = 1;
      let high = chars.length - start;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(chars.slice(start, start + middle).join(''))) low = middle;
        else high = middle - 1;
      }
      words.push(chars.slice(start, start + low).join(''));
      start += low;
    }
  }
  if (words.length === 0) return [''];
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
    } else {
      if (current !== '') out.push(current);
      current = word;
    }
  }
  if (current !== '') out.push(current);
  return out.length > 0 ? out : [''];
}

/** All laid-out sub-lines in order (explicit breaks + soft wraps). */
export function textV2Lines(
  text: string,
  effectiveSize: number,
  wrapWidth: number | null,
  measureLineWidth?: (line: string, effectiveSize: number) => number,
): string[] {
  const explicit = splitTextLines(text);
  if (wrapWidth === null) return explicit;
  const out: string[] = [];
  for (const line of explicit) {
    for (const sub of wrapTextLine(line, effectiveSize, wrapWidth, measureLineWidth)) {
      out.push(sub);
    }
  }
  return out;
}

/**
 * Resolve `effectiveSize`: single-sourced via `effectiveSurfaceTextSizeOf`
 * (`model.ts`) — `appearance.size` when valid, else `size` via
 * `effectiveTextSizeOf`, else `TEXT_DEFAULT_SIZE`. Keeps bounds, compile,
 * overlay, and selection on one size so H1/H2 writes round-trip stably.
 */
function effectiveTextSize(size: unknown, appearance: unknown): number {
  return effectiveSurfaceTextSizeOf({ size, appearance });
}

/**
 * Resolve valid `wrapWidth` or `null`: single-sourced via
 * `textWrapWidthOf` (`model.ts`) — invalid values degrade layout-only to
 * unbounded (frozen contracts §1.2 rules 2+6).
 */
function effectiveTextWrapWidth(appearance: unknown): number | null {
  return textWrapWidthOf({ appearance });
}

export function textV2EstBounds(
  geo: { x: number; y: number; size?: unknown; appearance?: unknown },
  text: string,
  measureLineWidth?: (line: string, effectiveSize: number) => number,
): Bounds {
  const effectiveSize = effectiveTextSize(geo.size, geo.appearance);
  const wrapWidth = effectiveTextWrapWidth(geo.appearance);
  const lineHeight = effectiveSize * TEXT_LINE_HEIGHT_FACTOR;
  const measure = measureLineWidth ?? estimateTextLineWidth;
  if (wrapWidth === null) {
    const explicit = splitTextLines(text);
    let longest = 0;
    for (const line of explicit) {
      longest = Math.max(longest, measure(line, effectiveSize));
    }
    return {
      x: geo.x,
      y: geo.y,
      width: longest,
      height: explicit.length * lineHeight,
    };
  }
  const lines = textV2Lines(text, effectiveSize, wrapWidth, measure);
  return {
    x: geo.x,
    y: geo.y,
    width: wrapWidth,
    height: lines.length * lineHeight,
  };
}
