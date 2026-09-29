import type { Point } from '@froglight/foundation';
import { NAVIGATION_PHYSICS } from './config.js';

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Signed rubber-band displacement with a finite asymptote.
 * The response is monotonic and increasingly resistant as excess grows.
 */
export function rubberBand(
  excess: number,
  extent: number = NAVIGATION_PHYSICS.rubberBandExtentPx,
): number {
  if (!Number.isFinite(excess) || !Number.isFinite(extent) || extent <= 0)
    return 0;
  const magnitude = Math.abs(excess);
  if (magnitude === 0) return 0;
  const resisted =
    (extent * NAVIGATION_PHYSICS.rubberBandCoefficient * magnitude) /
    (extent + NAVIGATION_PHYSICS.rubberBandCoefficient * magnitude);
  return Math.sign(excess) * resisted;
}

/**
 * Algebraic inverse of {@link rubberBand} for visual values within the
 * asymptotic range (`|value| < extent`).
 *
 * `rubberBand` maps excess `[0, +inf)` onto resisted `[0, extent)` via
 * `resisted = (extent * c * excess) / (extent + c * excess)`.
 * Solving for excess gives `excess = (resisted * extent) /
 * (c * (extent - resisted))`, applied per sign here.
 *
 * Boundary policy mirrors the pager consumer (`cancelPagerMotion(false)`):
 * non-finite `value`/`extent` or non-positive `extent` yield `0`, zero
 * magnitude yields `0`, and magnitudes at/above `extent` (outside the
 * invertible range, including the asymptote) pass through unchanged.
 * Uses the same `NAVIGATION_PHYSICS` coefficient/extent policy as
 * `rubberBand`. Pure; no DOM.
 */
export function inverseRubberBand(
  value: number,
  extent: number = NAVIGATION_PHYSICS.rubberBandExtentPx,
): number {
  if (!Number.isFinite(value) || !Number.isFinite(extent) || extent <= 0)
    return 0;
  const magnitude = Math.abs(value);
  if (magnitude === 0) return 0;
  if (magnitude >= extent) return value;
  const coefficient = NAVIGATION_PHYSICS.rubberBandCoefficient;
  if (!Number.isFinite(coefficient) || coefficient <= 0) return value;
  const restored =
    (magnitude * extent) / (coefficient * (extent - magnitude));
  if (!Number.isFinite(restored)) return value;
  return Math.sign(value) * restored;
}

export interface ElasticZoomResult {
  readonly rawZoom: number;
  readonly visualZoom: number;
  readonly settledZoom: number;
}

/** Apply symmetric resistance in logarithmic zoom space. */
export function elasticZoom(
  requestedZoom: number,
  minimumZoom: number,
  maximumZoom: number,
): ElasticZoomResult {
  const validBounds =
    Number.isFinite(minimumZoom) &&
    Number.isFinite(maximumZoom) &&
    minimumZoom > 0 &&
    maximumZoom >= minimumZoom;
  const minimum = validBounds ? minimumZoom : 0.25;
  const maximum = validBounds ? maximumZoom : 8;
  const rawZoom =
    Number.isFinite(requestedZoom) && requestedZoom > 0
      ? requestedZoom
      : minimum;
  const settledZoom = Math.min(Math.max(rawZoom, minimum), maximum);
  if (rawZoom === settledZoom)
    return { rawZoom, visualZoom: rawZoom, settledZoom };

  const bound = rawZoom < minimum ? minimum : maximum;
  const logBound = Math.log(bound);
  const logExcess = Math.log(rawZoom) - logBound;
  const visualZoom = Math.exp(
    logBound + rubberBand(logExcess, NAVIGATION_PHYSICS.elasticZoomLogExtent),
  );
  return {
    rawZoom,
    visualZoom: finite(visualZoom, settledZoom),
    settledZoom,
  };
}

export interface DecayStep {
  readonly displacement: Point;
  readonly velocity: Point;
  readonly active: boolean;
}

/** Exact exponential integration, independent of the display frame rate. */
export function stepDecay(velocity: Point, deltaTimeMs: number): DecayStep {
  const vx = finite(velocity.x);
  const vy = finite(velocity.y);
  if (!Number.isFinite(deltaTimeMs) || deltaTimeMs <= 0) {
    return {
      displacement: { x: 0, y: 0 },
      velocity: { x: vx, y: vy },
      active: Math.hypot(vx, vy) >= NAVIGATION_PHYSICS.decayStopVelocityPxPerMs,
    };
  }
  const seconds = deltaTimeMs / 1000;
  const rate = NAVIGATION_PHYSICS.decayRatePerSecond;
  const multiplier = Math.exp(-rate * seconds);
  const distanceFactor = (1000 * (1 - multiplier)) / rate;
  const nextVelocity = { x: vx * multiplier, y: vy * multiplier };
  return {
    displacement: { x: vx * distanceFactor, y: vy * distanceFactor },
    velocity: nextVelocity,
    active:
      Math.hypot(nextVelocity.x, nextVelocity.y) >=
      NAVIGATION_PHYSICS.decayStopVelocityPxPerMs,
  };
}

export interface SpringStep {
  readonly value: number;
  readonly velocity: number;
  readonly active: boolean;
}

/** Exact critically-damped spring step with crossing clamped to the target. */
export function stepSpring(
  value: number,
  velocity: number,
  target: number,
  deltaTimeMs: number,
): SpringStep {
  const safeTarget = finite(target);
  const safeValue = finite(value, safeTarget);
  const safeVelocity = finite(velocity);
  if (!Number.isFinite(deltaTimeMs) || deltaTimeMs <= 0) {
    return {
      value: safeValue,
      velocity: safeVelocity,
      active: safeValue !== safeTarget || safeVelocity !== 0,
    };
  }
  const seconds = deltaTimeMs / 1000;
  const omega = NAVIGATION_PHYSICS.springAngularFrequencyPerSecond;
  const offset = safeValue - safeTarget;
  // The public motion vocabulary is CSS px/ms (matching pointer timestamps,
  // VelocityTracker, and decay). Convert only for the per-second spring math.
  const velocityPerSecond = finite(safeVelocity * 1000);
  const coefficient = velocityPerSecond + omega * offset;
  const decay = Math.exp(-omega * seconds);
  let nextOffset = (offset + coefficient * seconds) * decay;
  let nextVelocity =
    ((velocityPerSecond - omega * coefficient * seconds) * decay) / 1000;

  nextOffset = finite(nextOffset);
  nextVelocity = finite(nextVelocity);

  if (offset !== 0 && Math.sign(nextOffset) !== Math.sign(offset)) {
    nextOffset = 0;
    nextVelocity = 0;
  }
  const active =
    Math.abs(nextOffset) > NAVIGATION_PHYSICS.springPositionEpsilon ||
    Math.abs(nextVelocity) > NAVIGATION_PHYSICS.springVelocityEpsilon;
  return active
    ? {
        value: finite(safeTarget + nextOffset, safeTarget),
        velocity: nextVelocity,
        active: true,
      }
    : { value: safeTarget, velocity: 0, active: false };
}
