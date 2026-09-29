/**
 * Plain-data diagnostics seam for the smooth-stroke pipeline.
 *
 * Exposes every stage for one stroke — captured samples, sanitized,
 * resampled controls, stabilized, faired, fitted centerline samples,
 * tessellated spine, outline — so tests and tooling can pinpoint where a
 * visual defect first enters without screenshots or DOM.
 *
 * Headless, DOM-free, deterministic. Never persisted; never user-facing.
 */

import type { Point } from '../geometry.js';
import type { InkSample } from '../model.js';
import type { InkBrushSpec } from './brush.js';
import { filterPressureStream } from './curve-attributes.js';
import type { TessellatedSpinePoint } from './tessellation.js';
import type { InkCurve } from './curve.js';
import { fitCenterlineCurve, type InkCurveControl } from './curve.js';
import { controlArcLengths, compileInkStroke } from './compiler.js';
import { arcLengthResample, defaultControlSpacing } from './resample.js';
import { sanitizeSamples, type WorkingSample } from './samples.js';
import { fairControlPolygon, stabilizePositions } from './stabilization.js';

/** One pipeline stage snapshot (plain data, headless). */
export interface InkPipelineDiagnosis {
  /** Raw canonical input count. */
  readonly rawCount: number;
  /** After sanitation (minimal cleanup). */
  readonly cleaned: readonly WorkingSample[];
  /** Uniform working observations (device-frequency normalized). */
  readonly resampled: readonly WorkingSample[];
  /** After stabilization EMA. */
  readonly stabilized: readonly WorkingSample[];
  /** After streamline fairing. */
  readonly faired: readonly WorkingSample[];
  /** Final fitted centerline (approximating, not interpolating). */
  readonly curve: InkCurve;
  /** Dense centerline samples (for metrics, 16 per segment). */
  readonly centerline: readonly Point[];
  /** Tessellated spine with widths. */
  readonly spine: readonly TessellatedSpinePoint[];
  /** Final outline ring. */
  readonly polygon: readonly Point[];
}

/**
 * Run the committed pipeline stage-by-stage and return every intermediate.
 * Mirrors `compileInkStroke` exactly (same defaults, same order) so the
 * diagnosis explains the shipped geometry rather than a parallel path.
 */
export function diagnoseInkStroke(
  samples: readonly InkSample[],
  brush: InkBrushSpec,
  options: { spacing?: number; minDistance?: number } = {},
): InkPipelineDiagnosis {
  const spacing =
    typeof options.spacing === 'number' &&
    Number.isFinite(options.spacing) &&
    options.spacing > 0
      ? options.spacing
      : defaultControlSpacing(brush.size);
  const minDistance =
    typeof options.minDistance === 'number' &&
    Number.isFinite(options.minDistance) &&
    options.minDistance >= 0
      ? options.minDistance
      : 0;
  const cleaned = sanitizeSamples(samples, minDistance);
  const filtered = filterPressureStream(
    cleaned.map((s) => s.pressure),
    cleaned,
    brush,
  );
  const pressured: WorkingSample[] = cleaned.map((s, i) => ({
    ...s,
    pressure: filtered[i]!,
    extras: { ...s.extras },
  }));
  const resampled = arcLengthResample(pressured, spacing);
  const stabilized = stabilizePositions(resampled, brush.stabilization);
  const faired = fairControlPolygon(stabilized, brush.streamline);
  const controls: InkCurveControl[] = faired.map((s) => ({
    x: s.x,
    y: s.y,
    pressure: s.pressure ?? 0.5,
    tiltX: s.tiltX,
    tiltY: s.tiltY,
    twist: s.twist,
    dt: s.dt,
  }));
  const curve = fitCenterlineCurve(controls);
  const centerline: Point[] = [];
  for (const segment of curve.segments) {
    for (let k = 0; k <= 16; k++) {
      centerline.push(segment.position(k / 16));
    }
  }
  const compiled = compileInkStroke(samples, brush, options);
  return {
    rawCount: samples.length,
    cleaned,
    resampled,
    stabilized,
    faired,
    curve,
    centerline,
    spine: compiled.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      tx: 1,
      ty: 0,
      width: n.width,
      pressure: n.pressure,
      tiltX: n.tiltX,
      tiltY: n.tiltY,
      twist: n.twist,
      dt: n.dt,
      extras: { ...n.extras },
      controlArc: 0,
      segmentIndex: n.segmentIndex,
      u: n.u,
    })),
    polygon: compiled.polygon.map((p) => ({ ...p })),
  };
}

/** Count axis-aligned plateaus in a polyline (staircase signature). */
export function countAxisPlateaus(
  points: readonly Point[],
  /** Max transverse deviation to still count as axis-aligned. */
  tolerance = 1e-9,
  /** Minimum run length to count (surface units). */
  minLength = 0.2,
): { horizontal: number; vertical: number; longest: number } {
  let horizontal = 0;
  let vertical = 0;
  let longest = 0;
  let runAxis: 'h' | 'v' | null = null;
  let runLength = 0;
  const flush = (): void => {
    if (runAxis === 'h') horizontal++;
    if (runAxis === 'v') vertical++;
    if (runLength > longest) longest = runLength;
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const isH = dy <= tolerance && dx > 0;
    const isV = dx <= tolerance && dy > 0;
    const axis = isH ? 'h' : isV ? 'v' : null;
    if (axis !== null && axis === runAxis) {
      runLength += segLen;
    } else {
      if (runAxis !== null && runLength >= minLength) flush();
      else if (runAxis !== null && runLength > longest) longest = runLength;
      runAxis = axis;
      runLength = axis !== null ? segLen : 0;
    }
  }
  if (runAxis !== null && runLength >= minLength) flush();
  else if (runAxis !== null && runLength > longest) longest = runLength;
  // Count sub-threshold runs in longest only; return counts for significant runs.
  void tolerance;
  return { horizontal, vertical, longest };
}

/** Maximum turning-angle impulse between consecutive chords (radians). */
export function maxTurningImpulse(points: readonly Point[]): number {
  let worst = 0;
  for (let i = 2; i < points.length; i++) {
    const a = points[i - 2]!;
    const b = points[i - 1]!;
    const c = points[i]!;
    const l0 = Math.hypot(b.x - a.x, b.y - a.y);
    const l1 = Math.hypot(c.x - b.x, c.y - b.y);
    if (l0 < 1e-9 || l1 < 1e-9) continue;
    const dot = Math.min(
      Math.max(
        ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l0 * l1),
        -1,
      ),
      1,
    );
    worst = Math.max(worst, Math.acos(dot));
  }
  return worst;
}

/** Hausdorff-like distance between two polylines (subsampled, deterministic). */
export function polylineHausdorff(
  a: readonly Point[],
  b: readonly Point[],
): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const distTo = (p: Point, poly: readonly Point[]): number => {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const q = poly[i]!;
      best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    }
    return best;
  };
  let worst = 0;
  const stepA = Math.max(1, Math.floor(a.length / 500));
  const stepB = Math.max(1, Math.floor(b.length / 500));
  for (let i = 0; i < a.length; i += stepA)
    worst = Math.max(worst, distTo(a[i]!, b));
  for (let i = 0; i < b.length; i += stepB)
    worst = Math.max(worst, distTo(b[i]!, a));
  return worst;
}

export { controlArcLengths };
