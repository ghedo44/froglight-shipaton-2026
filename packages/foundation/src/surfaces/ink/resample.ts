/**
 * True arc-length resampling for the continuous smooth-stroke pipeline.
 *
 * Device sampling is irregular: Apple Pencil, Android stylus, mouse, touch,
 * and coalesced batches all deliver different event frequencies, and fast
 * moves leave long sparse gaps while slow moves pile up dense jitter. The
 * old pipeline merely subdivided long gaps and left dense input untouched,
 * so the fitted path still followed raw event frequency.
 *
 * This stage normalizes to approximately uniform arc-distance working
 * observations on a fixed grid (`0, spacing, 2·spacing, …`) plus the exact
 * final endpoint:
 *
 * ```text
 * • ••• •      •• •••••       •   →   •   •   •   •   •   •   •   •
 * ```
 *
 * - preserves the first and last meaningful samples exactly;
 * - interpolates every semantic axis (x/y, pressure, tilt, twist, dt);
 * - carries unknown per-sample members from the nearer endpoint;
 * - is independent of source event frequency (fixed grid, not per-segment
 *   subdivision counts that shift with input density);
 * - is deterministic, DOM-free, and linear.
 *
 * Working observations are NOT final curve anchors: downstream trajectory
 * estimation treats them as noisy observations of the pen path (browser
 * coordinates can be CSS-pixel quantized) and fits an approximating
 * centerline through them rather than interpolating every one.
 *
 * The fixed grid (rather than `round(total/spacing)` intervals) is what
 * makes the live incremental compiler exact: continuation appends extend
 * the same grid instead of re-dividing history.
 */

import {
  lerp,
  lerpAngleNullable,
  lerpNullable,
  type WorkingSample,
} from './samples.js';

/** Arc distances below this collapse to a single grid position. */
const ARC_EPS = 1e-9;

/** Default control spacing from brush size (surface units). */
export function defaultControlSpacing(size: number): number {
  const base =
    typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 3;
  return Math.min(Math.max(base * 0.35, 0.75), 3);
}

function copySample(s: WorkingSample): WorkingSample {
  return { ...s, extras: { ...s.extras } };
}

function interpolateAt(
  a: WorkingSample,
  b: WorkingSample,
  t: number,
): WorkingSample {
  const clamped = Math.min(Math.max(t, 0), 1);
  const near = clamped < 0.5 ? a : b;
  return {
    x: lerp(a.x, b.x, clamped),
    y: lerp(a.y, b.y, clamped),
    pressure: lerpNullable(a.pressure, b.pressure, clamped),
    tiltX: lerpNullable(a.tiltX, b.tiltX, clamped),
    tiltY: lerpNullable(a.tiltY, b.tiltY, clamped),
    twist: lerpAngleNullable(a.twist, b.twist, clamped),
    dt: lerpNullable(a.dt, b.dt, clamped),
    extras: { ...near.extras },
  };
}

function cumulativeLengths(samples: readonly WorkingSample[]): number[] {
  const cumulative: number[] = [0];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return cumulative;
}

/**
 * Resample sanitized samples to uniform arc distance. Returns copies;
 * input is never mutated. Zero-length input (all samples coincident)
 * preserves the first and last samples so stationary pressure/tilt/twist
 * gestures still compile to a dot.
 */
export function arcLengthResample(
  samples: readonly WorkingSample[],
  spacing: number,
): WorkingSample[] {
  if (samples.length === 0) return [];
  if (samples.length === 1) return [copySample(samples[0]!)];
  const step =
    typeof spacing === 'number' && Number.isFinite(spacing) && spacing > 0
      ? spacing
      : defaultControlSpacing(3);
  const cumulative = cumulativeLengths(samples);
  const total = cumulative[cumulative.length - 1]!;
  if (!(total > ARC_EPS)) {
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    return samples.length === 2
      ? [copySample(first), copySample(last)]
      : [copySample(first), copySample(last)];
  }
  const out: WorkingSample[] = [copySample(samples[0]!)];
  let seg = 0;
  const lastSeg = samples.length - 2;
  for (let target = step; target < total - ARC_EPS; target += step) {
    while (seg < lastSeg && cumulative[seg + 1]! <= target) seg++;
    const segStart = cumulative[seg]!;
    const segEnd = cumulative[seg + 1]!;
    const span = segEnd - segStart;
    // Zero-length segments are coincident samples kept for their axes
    // (stationary pressure/tilt change): the later endpoint owns the mark.
    const t = span > ARC_EPS ? (target - segStart) / span : 1;
    out.push(interpolateAt(samples[seg]!, samples[seg + 1]!, t));
  }
  out.push(copySample(samples[samples.length - 1]!));
  return out;
}

/**
 * Incremental resampling state for the live compiler. The grid is absolute
 * from the stroke start, so continuation appends emit exactly what a clean
 * full resample would emit: `nextMark` is the arc distance of the next
 * grid mark, `prev` the last consumed stabilized point, `prevArc` its
 * absolute arc distance. `provisional` tracks whether the last control
 * point is a tip endpoint (rather than a grid mark): the next append pops
 * it first, so interior history holds pure grid marks exactly like a clean
 * full resample, and the commit pass replaces it with the exact final
 * sample.
 */
export interface ResampleCarry {
  nextMark: number;
  prev: WorkingSample | null;
  prevArc: number;
  provisional: boolean;
}

export function initialResampleCarry(): ResampleCarry {
  return { nextMark: 0, prev: null, prevArc: 0, provisional: false };
}

function axesEqual(a: WorkingSample, b: WorkingSample): boolean {
  return (
    a.pressure === b.pressure &&
    a.tiltX === b.tiltX &&
    a.tiltY === b.tiltY &&
    a.twist === b.twist &&
    a.dt === b.dt
  );
}

/**
 * Extend `controls` with grid resampling of newly stabilized points, then
 * emit the current pen position as a provisional endpoint so the preview
 * stays glued to the pointer. The previous provisional endpoint (if any)
 * is popped first: interior history always holds pure grid marks,
 * bit-identical to the corresponding slice of a clean full
 * `arcLengthResample` over the same stabilized stream. The commit pass
 * pops the provisional tip and appends the exact final sample, reproducing
 * the clean full resample exactly. Parallel per-control state (pressure
 * EMA values, curve builder stack) must pop alongside when `popped` is
 * true. Updates `carry` in place. Linear in `fresh`.
 */
export function appendResampled(
  carry: ResampleCarry,
  fresh: readonly WorkingSample[],
  spacing: number,
  controls: WorkingSample[],
): { appended: number; popped: number } {
  const step =
    typeof spacing === 'number' && Number.isFinite(spacing) && spacing > 0
      ? spacing
      : defaultControlSpacing(3);
  let appended = 0;
  let popped = 0;
  if (fresh.length === 0) return { appended, popped };
  // The previous tip becomes interior history: drop it (it is always the
  // last control point — nothing is ever emitted after it) before extending
  // the grid, so interior holds pure grid marks like a clean full resample.
  // A fresh tip is emitted once at the end. At most one pop per call keeps
  // parallel per-control state (pressure EMA values, curve builder stack)
  // trivially in sync: truncate one entry when `popped` is 1.
  if (carry.provisional && controls.length > 0) {
    controls.pop();
    popped = 1;
    carry.provisional = false;
  }
  const emitMark = (s: WorkingSample): void => {
    controls.push(copySample(s));
    appended++;
  };
  for (let i = 0; i < fresh.length; i++) {
    const current = fresh[i]!;
    const prev = carry.prev;
    if (prev === null) {
      // Stroke anchor: grid mark 0 lands exactly on the pen.
      emitMark(current);
      carry.nextMark = step;
      carry.prev = copySample(current);
      carry.prevArc = 0;
      continue;
    }
    const segLen = Math.hypot(current.x - prev.x, current.y - prev.y);
    if (segLen > ARC_EPS) {
      const segStart = carry.prevArc;
      const segEnd = segStart + segLen;
      while (carry.nextMark <= segEnd + ARC_EPS) {
        // A mark coinciding with the segment end is covered once by the
        // provisional endpoint below — emitting both would plant a
        // degenerate tip segment (whose fallback tangent kinks the mesh).
        if (segEnd - carry.nextMark <= ARC_EPS) break;
        const t = (carry.nextMark - segStart) / segLen;
        emitMark(interpolateAt(prev, current, t));
        carry.nextMark += step;
      }
      carry.prevArc = segEnd;
    }
    carry.prev = copySample(current);
  }
  // Provisional endpoint: the preview must reach the pen. The next batch
  // pops it before extending the grid; the commit pass replaces it with
  // the exact final sample. Zero-length repeats with identical axes are
  // skipped so the tip never gains a degenerate segment.
  const tip = carry.prev!;
  const tail = controls[controls.length - 1];
  if (
    tail === undefined ||
    Math.hypot(tip.x - tail.x, tip.y - tail.y) > ARC_EPS ||
    !axesEqual(tip, tail)
  ) {
    controls.push(copySample(tip));
    appended++;
    carry.provisional = true;
  }
  return { appended, popped };
}
