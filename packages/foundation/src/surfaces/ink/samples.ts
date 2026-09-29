/**
 * Canonical sample sanitation for the continuous smooth-stroke pipeline.
 *
 * Captured `InkSample` records are semantic data: hardware axes plus any
 * unknown per-sample members, which survive this stage verbatim (the
 * preservation contract). Sanitation only drops what geometry cannot use:
 * non-finite positions, exact duplicates across every axis, and
 * sub-minimum spatial jitter. Everything downstream — arc-length
 * resampling, stabilization, curve fitting — consumes `WorkingSample`.
 *
 * Headless, DOM-free, deterministic, linear complexity.
 */

import type { InkSample } from '../model.js';

/** Sanitized capture sample: finite position plus nullable semantic axes. */
export interface WorkingSample {
  x: number;
  y: number;
  /** Null means "no data" (neutral or velocity-derived later). */
  pressure: number | null;
  tiltX: number | null;
  tiltY: number | null;
  /** Barrel rotation in radians (null = unknown). */
  twist: number | null;
  dt: number | null;
  /** Unknown per-sample members, carried verbatim through every stage. */
  extras: Record<string, unknown>;
}

export function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpNullable(
  a: number | null,
  b: number | null,
  t: number,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * t;
}

/**
 * Wrap-aware interpolation for barrel rotation: rotation wraps at ±π, so
 * naive lerps across the seam would spin the nib the long way around.
 * Null follows the established dropout rule (the known side carries).
 */
export function lerpAngleNullable(
  a: number | null,
  b: number | null,
  t: number,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  let delta = b - a;
  const tau = Math.PI * 2;
  delta = ((((delta + Math.PI) % tau) + tau) % tau) - Math.PI;
  return a + delta * t;
}

/** Known numeric axes; everything else on a sample is opaque extras. */
const KNOWN_SAMPLE_KEYS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'pressure',
  'tilt',
  'twist',
  'dt',
]);

function extrasOf(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_SAMPLE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Convert one canonical sample; null when the position is unusable. */
export function toWorkingSample(sample: InkSample): WorkingSample | null {
  if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return null;
  const raw = sample as unknown as Record<string, unknown>;
  return {
    x: sample.x,
    y: sample.y,
    pressure:
      typeof sample.pressure === 'number' && Number.isFinite(sample.pressure)
        ? clamp01(sample.pressure)
        : null,
    tiltX: sample.tilt !== undefined ? finiteOrNull(sample.tilt.x) : null,
    tiltY: sample.tilt !== undefined ? finiteOrNull(sample.tilt.y) : null,
    twist: finiteOrNull(sample.twist),
    dt:
      typeof sample.dt === 'number' &&
      Number.isFinite(sample.dt) &&
      sample.dt >= 0
        ? sample.dt
        : null,
    extras: extrasOf(raw),
  };
}

function sameExtras(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.is(a[key], b[key]));
}

/** True when every axis matches: a stationary press/tilt/twist change at
 *  identical coords is intentional data and must survive. */
export function sameWorkingSample(a: WorkingSample, b: WorkingSample): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.pressure === b.pressure &&
    a.tiltX === b.tiltX &&
    a.tiltY === b.tiltY &&
    a.twist === b.twist &&
    a.dt === b.dt &&
    sameExtras(a.extras, b.extras)
  );
}

/**
 * Drop invalid axes and exact duplicates. Spatial micro-motion is
 * PRESERVED: any fixed surface-space jitter floor erases legitimate
 * high-zoom handwriting (1 CSS px = 0.125 surface units at 8×, so a 0.25
 * floor discards two pixels of slow pen travel before the trajectory
 * estimator can interpret it). Callers may pass an explicit `minDistance`
 * only with a documented zoom-independent justification; the default is 0
 * (exact duplicates across every axis only). Preserves the first and last
 * meaningful samples. Linear, deterministic, allocation-bounded.
 *
 * Architectural distinction: these are captured semantic OBSERVATIONS, not
 * final curve anchors. Downstream resampling normalizes device frequency
 * into uniform working observations; the approximating centerline fitter
 * treats them as noisy observations rather than mandatory interpolation
 * knots.
 */
export function sanitizeSamples(
  samples: readonly InkSample[],
  minDistance: number,
): WorkingSample[] {
  const floor =
    typeof minDistance === 'number' &&
    Number.isFinite(minDistance) &&
    minDistance > 0
      ? minDistance
      : 0;
  const out: WorkingSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const w = toWorkingSample(samples[i]!);
    if (w === null) continue;
    const last = out[out.length - 1];
    if (last !== undefined && sameWorkingSample(last, w)) continue;
    if (
      last !== undefined &&
      floor > 0 &&
      Math.hypot(w.x - last.x, w.y - last.y) < floor
    ) {
      continue;
    }
    out.push(w);
  }
  return out;
}

/** Rebuild a canonical sample from working state (commits, eraser cuts). */
export function workingSampleToInkSample(w: WorkingSample): InkSample {
  return {
    x: w.x,
    y: w.y,
    ...(w.pressure !== null ? { pressure: w.pressure } : {}),
    ...(w.tiltX !== null && w.tiltY !== null
      ? { tilt: { x: w.tiltX, y: w.tiltY } }
      : {}),
    ...(w.twist !== null ? { twist: w.twist } : {}),
    ...(w.dt !== null ? { dt: w.dt } : {}),
    ...w.extras,
  } as InkSample;
}
