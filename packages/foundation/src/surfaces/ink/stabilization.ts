/**
 * Input stabilization and streamline fairing for the continuous
 * smooth-stroke pipeline.
 *
 * The old pipeline mapped these controls through discrete thresholds
 * (`streamline >= 0.75 → two Chaikin passes`), so nudging a slider across a
 * threshold visibly jumped the geometry. Both controls are continuous here:
 *
 * - **stabilization** filters capture noise on the uniform resample
 *   grid, after resampling. `0` follows the pointer exactly (bit-identical
 *   passthrough), `1` corrects heavily. An anchored forward exponential
 *   moving average keeps latency low: the first sample anchors exactly on
 *   the pen (no startup lag), tip lag stays a fraction of one grid step,
 *   and every output is a continuous function of the setting — nearby
 *   values produce nearby geometry by construction (the EMA weight is
 *   affine in it). Uniform, device-independent shape smoothing with no
 *   lag at all lives one stage down (fairing on the same grid).
 *
 * - **streamline** fairs the resampled control polygon before fitting.
 *   `0` is maximally faithful (bit-identical passthrough), `1` strongly
 *   streamlines. A fixed two-pass Laplacian blend with per-pass weight
 *   `0.45 · streamline` (inside the explicit-Euler stability limit of 0.5)
 *   rounds handwriting corners progressively with no pass-count jumps.
 *   Endpoints are always preserved exactly.
 *
 * Pressure/tilt/twist ride along both stages (twist wrap-aware); `dt` and
 * unknown extras pass through untouched. Deterministic, DOM-free, linear.
 */

import {
  clamp01,
  lerpAngleNullable,
  lerpNullable,
  type WorkingSample,
} from './samples.js';

/** EMA weight↔setting map: alpha = 1 − 0.8·s (s = 0 → passthrough). */
export function stabilizationAlpha(stabilization: number): number {
  return 1 - 0.8 * clamp01(stabilization);
}

/** Per-pass Laplacian blend for a streamline setting (stability: < 0.5). */
export function streamlineBlend(streamline: number): number {
  return 0.45 * clamp01(streamline);
}

/** Fixed fairing passes (constant — continuity comes from the blend). */
export const STREAMLINE_PASSES = 2;

function copySample(s: WorkingSample): WorkingSample {
  return { ...s, extras: { ...s.extras } };
}

/**
 * Anchored forward EMA over positions; attributes pass through. The first
 * sample anchors exactly (no startup lag). `stabilization = 0` returns
 * exact copies, as do runs of fewer than three samples (two points define
 * unambiguous intent — smoothing needs neighborhood context, and there is
 * none). Linear, deterministic.
 */
export function stabilizePositions(
  samples: readonly WorkingSample[],
  stabilization: number,
): WorkingSample[] {
  const alpha = stabilizationAlpha(stabilization);
  if (alpha >= 1 || samples.length < 3) {
    return samples.map(copySample);
  }
  const out: WorkingSample[] = [copySample(samples[0]!)];
  let ex = samples[0]!.x;
  let ey = samples[0]!.y;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    ex = alpha * s.x + (1 - alpha) * ex;
    ey = alpha * s.y + (1 - alpha) * ey;
    out.push({ ...copySample(s), x: ex, y: ey });
  }
  return out;
}

/** Incremental EMA state retained across live batches. */
export interface StabilizerCarry {
  x: number;
  y: number;
  started: boolean;
  alpha: number;
}

export function initialStabilizerCarry(stabilization: number): StabilizerCarry {
  return {
    x: 0,
    y: 0,
    started: false,
    alpha: stabilizationAlpha(stabilization),
  };
}

/**
 * Stabilize one sanitized sample through retained state (O(1)). Output is
 * identical to the corresponding element of a clean full
 * `stabilizePositions` over the same stream. The first sample anchors.
 */
export function stabilizeOne(
  carry: StabilizerCarry,
  sample: WorkingSample,
): WorkingSample {
  if (carry.alpha >= 1) {
    if (!carry.started) {
      carry.x = sample.x;
      carry.y = sample.y;
      carry.started = true;
    }
    return copySample(sample);
  }
  if (!carry.started) {
    carry.x = sample.x;
    carry.y = sample.y;
    carry.started = true;
    return copySample(sample);
  }
  carry.x = carry.alpha * sample.x + (1 - carry.alpha) * carry.x;
  carry.y = carry.alpha * sample.y + (1 - carry.alpha) * carry.y;
  return { ...copySample(sample), x: carry.x, y: carry.y };
}

function fairPass(samples: WorkingSample[], blend: number): WorkingSample[] {
  if (samples.length < 3) return samples.map(copySample);
  const out: WorkingSample[] = [copySample(samples[0]!)];
  for (let i = 1; i + 1 < samples.length; i++) {
    const prev = samples[i - 1]!;
    const s = samples[i]!;
    const next = samples[i + 1]!;
    const mx = (prev.x + next.x) / 2;
    const my = (prev.y + next.y) / 2;
    out.push({
      ...copySample(s),
      x: s.x + blend * (mx - s.x),
      y: s.y + blend * (my - s.y),
      pressure: lerpNullable(
        s.pressure,
        lerpNullable(prev.pressure, next.pressure, 0.5),
        blend,
      ),
      tiltX: lerpNullable(
        s.tiltX,
        lerpNullable(prev.tiltX, next.tiltX, 0.5),
        blend,
      ),
      tiltY: lerpNullable(
        s.tiltY,
        lerpNullable(prev.tiltY, next.tiltY, 0.5),
        blend,
      ),
      twist: lerpAngleNullable(
        s.twist,
        lerpAngleNullable(prev.twist, next.twist, 0.5),
        blend,
      ),
    });
  }
  out.push(copySample(samples[samples.length - 1]!));
  return out;
}

/**
 * Continuous Laplacian fairing of the control polygon. `streamline = 0`
 * returns exact copies; endpoints are preserved at every setting. The
 * Laplacian has radius 1 per pass (`STREAMLINE_PASSES` fixed), so the live
 * compiler's bounded tail window always covers the fairing neighborhood.
 * Linear, deterministic.
 */
export function fairControlPolygon(
  samples: readonly WorkingSample[],
  streamline: number,
): WorkingSample[] {
  const blend = streamlineBlend(streamline);
  if (!(blend > 0) || samples.length < 3) {
    return samples.map(copySample);
  }
  let out: WorkingSample[] = samples.map(copySample);
  for (let pass = 0; pass < STREAMLINE_PASSES; pass++) {
    out = fairPass(out, blend);
  }
  return out;
}
