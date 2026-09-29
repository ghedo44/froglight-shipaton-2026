/**
 * Continuous attribute interpolation support for the smooth-stroke
 * pipeline: pressure resolution/filtering plus variable-width evaluation.
 *
 * Position smoothing alone cannot carry handwriting quality — width must
 * vary smoothly along the curve unless the physical input itself jumps.
 * This module owns everything that turns interpolated attributes into a
 * nib width:
 *
 * - pressure resolution: raw data, velocity-derived from physical speed
 *   when the brush asks for it and hardware supplies none, neutral when
 *   time cannot establish speed — then a gentle fixed EMA for hardware or
 *   elapsed-time EMA for velocity (bounded lag, no global rescaling);
 * - the pressure→width curve (gamma + min/max factors over brush size);
 * - taper envelopes with normalized overlap (zones meet at most, the middle
 *   never pinches);
 * - stub-nib response (broad across the nib edge, floored hairline along
 *   it; barrel twist rotates the nib on top of its configured angle);
 * - pencil tilt widening.
 *
 * All functions are pure except the explicitly stateful
 * `PressureFilterCarry` used by the live compiler (O(1) per sample,
 * identical output to the batch filter over the same stream).
 */

import type { InkBrushSpec } from './brush.js';
import { clamp01 } from './samples.js';

/** Pressure reported when a sample (or the hardware) supplies none. */
export const NEUTRAL_PRESSURE = 0.5;
/** Fixed EMA weight for pressure jitter filtering (redesigned pipeline). */
export const PRESSURE_SMOOTHING = 0.65;
/**
 * Physical velocity scale for pressure fallback, in surface units/ms.
 * `p = 1 / (1 + speed / scale)`: a speed of `scale` resolves to pressure
 * 0.5, slower travel grows toward 1, and faster travel falls toward 0.
 */
export const VELOCITY_PRESSURE_SPEED_SCALE = 0.5;
/**
 * Time constant for velocity-pressure smoothing. The elapsed-time EMA uses
 * `alpha = 1 - exp(-dt / tau)`, so equivalent motion sampled at different
 * pointer-event rates settles identically in physical time.
 */
export const VELOCITY_PRESSURE_TIME_CONSTANT_MS = 16;
/** Taper never reaches absolute zero (keeps caps well-formed). */
export const TAPER_FLOOR = 0.12;
/** Hairline floor for flat nibs along the edge (never invisible). */
export const NIB_FLOOR = 0.15;
/** Maximum taper length in nib widths; each control scales this fixed zone. */
export const TAPER_ZONE_CAP_SIZE_MULTIPLE = 8;

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return 1;
  if (x <= edge0) return 0;
  if (x >= edge1) return 1;
  const t = (x - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

/** Normalize overlapping taper zones so they meet at most (no mid pinch). */
export function normalizeTaperZones(
  startLen: number,
  endLen: number,
): { startLen: number; endLen: number } {
  if (startLen + endLen > 1 && startLen + endLen > 0) {
    const scale = 1 / (startLen + endLen);
    return { startLen: startLen * scale, endLen: endLen * scale };
  }
  return { startLen, endLen };
}

/**
 * Nib-relative taper: extending the stroke cannot resize its start zone.
 * The end envelope follows only the tip, over a fixed, bounded distance.
 * Overlapping envelopes use the smaller scale rather than compounding
 * attenuation, including strokes shorter than a nib width.
 */
export function taperScaleAt(
  arcFromStart: number,
  totalLen: number,
  startLen: number,
  endLen: number,
  size: number,
): number {
  const { startLen: s, endLen: e } = normalizeTaperZones(startLen, endLen);
  const total = Math.max(totalLen, 0);
  const cap = TAPER_ZONE_CAP_SIZE_MULTIPLE * Math.max(size, 1e-9);
  const startZone = s * cap;
  const endZone = e * cap;
  const arc = Math.min(Math.max(arcFromStart, 0), total);
  const startScale = startZone > 0 ? smoothstep(0, startZone, arc) : 1;
  const endScale =
    endZone > 0 ? 1 - smoothstep(total - endZone, total, arc) : 1;
  return Math.max(Math.min(startScale, endScale), TAPER_FLOOR);
}

/** Width from normalized pressure through the brush response curve. */
export function pressureWidth(pressure: number, brush: InkBrushSpec): number {
  if (!brush.pressure.enabled) return brush.size;
  const curved = Math.pow(
    clamp01(pressure),
    Math.max(brush.pressure.curve, 1e-9),
  );
  return (
    brush.size *
    (brush.pressure.minFactor +
      (brush.pressure.maxFactor - brush.pressure.minFactor) * curved)
  );
}

/**
 * Stub-nib response from the unit travel direction: broad across the nib
 * edge, hairline along it. `aspect` 1 behaves round; 0 is a sharp flat.
 * The barrel twist rotates the nib on top of its configured angle.
 */
export function nibMultiplier(
  brush: InkBrushSpec,
  travelAngle: number,
  twist: number | null,
): number {
  if (brush.tip.shape === 'round') return 1;
  const aspect = brush.tip.aspect ?? 1;
  const rel = travelAngle - (brush.tip.angle ?? 0) - (twist ?? 0);
  const s = Math.sin(rel);
  const c = Math.cos(rel);
  return Math.max(Math.sqrt(s * s + aspect * aspect * c * c), NIB_FLOOR);
}

/** Pencil side shading: tilted barrels lay down a wider mark. */
export function tiltMultiplier(
  brush: InkBrushSpec,
  tiltX: number | null,
  tiltY: number | null,
): number {
  if (brush.tiltEffect <= 0 || tiltX === null || tiltY === null) return 1;
  const magnitude = Math.min(Math.hypot(tiltX, tiltY) / (Math.PI / 2), 1);
  return 1 + brush.tiltEffect * magnitude;
}

/**
 * The physical nib area at one confirmed input sample. This is the small,
 * compiler-owned geometry seam used by provider cursor previews: it reuses
 * the same pressure and tilt policy as stroke compilation without running a
 * stroke compiler for hover UI. Dimensions are surface units; providers
 * apply their surface-to-local-view transform exactly once.
 */
export interface InkBrushFootprint {
  readonly shape: 'circle' | 'ellipse';
  readonly width: number;
  readonly height: number;
  /** Clockwise-positive radians in the surface frame. */
  readonly rotation: number;
}

export function resolveBrushFootprint(
  brush: InkBrushSpec,
  input: {
    readonly pressure?: number;
    readonly tiltX?: number | null;
    readonly tiltY?: number | null;
    readonly twist?: number | null;
  } = {},
): InkBrushFootprint {
  const pressure = input.pressure ?? NEUTRAL_PRESSURE;
  const tiltX = input.tiltX ?? null;
  const tiltY = input.tiltY ?? null;
  const major = Math.max(
    pressureWidth(pressure, brush) * tiltMultiplier(brush, tiltX, tiltY),
    0,
  );
  if (brush.tip.shape === 'round') {
    return { shape: 'circle', width: major, height: major, rotation: 0 };
  }
  return {
    shape: 'ellipse',
    width: major,
    height: major * Math.min(Math.max(brush.tip.aspect ?? 1, 0), 1),
    rotation: (brush.tip.angle ?? 0) + (input.twist ?? 0),
  };
}

/**
 * Width without the taper envelope (pressure curve × nib × tilt). Dots
 * (single-sample strokes) use this directly: a tap has no stroke length
 * to taper along, so it stamps at full width like the old `taperScales`
 * short-circuit.
 */
export function resolveUntaperedWidth(
  pressure: number,
  brush: InkBrushSpec,
  travelAngle: number,
  twist: number | null,
  tiltX: number | null,
  tiltY: number | null,
): number {
  return Math.max(
    pressureWidth(pressure, brush) *
      nibMultiplier(brush, travelAngle, twist) *
      tiltMultiplier(brush, tiltX, tiltY),
    0,
  );
}

/**
 * Full variable-width evaluation at one tessellated spine point:
 * pressure curve × taper envelope × nib response × tilt shading. All
 * factors are continuous in their inputs, so width varies smoothly along
 * the curve — no discrete jumps between neighboring mesh vertices.
 * Taper resolves from absolute arc/total (capped zones, see above).
 */
export function resolveWidth(
  pressure: number,
  brush: InkBrushSpec,
  arcFromStart: number,
  totalLen: number,
  travelAngle: number,
  twist: number | null,
  tiltX: number | null,
  tiltY: number | null,
): number {
  return Math.max(
    resolveUntaperedWidth(pressure, brush, travelAngle, twist, tiltX, tiltY) *
      taperScaleAt(
        arcFromStart,
        totalLen,
        brush.taperStart,
        brush.taperEnd,
        brush.size,
      ),
    0,
  );
}

/**
 * Per-point speeds in units/ms; null unless every sample carries strictly
 * increasing timing (partial timing derives nothing).
 */
export function pointSpeeds(
  positions: readonly { x: number; y: number; dt: number | null }[],
): number[] | null {
  if (positions.length < 2) return null;
  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1]!.dt;
    const next = positions[i]!.dt;
    if (prev === null || next === null || !(next > prev)) return null;
  }
  const seg: number[] = [];
  for (let i = 0; i + 1 < positions.length; i++) {
    const a = positions[i]!;
    const b = positions[i + 1]!;
    seg.push(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(b.dt! - a.dt!, 1e-6));
  }
  return positions.map((_, i) => {
    if (i === 0) return seg[0]!;
    if (i === seg.length) return seg[seg.length - 1]!;
    return (seg[i - 1]! + seg[i]!) / 2;
  });
}

/** Fixed, device-frequency-independent pressure response for true speed. */
export function velocityPressureForSpeed(speed: number): number {
  if (Number.isNaN(speed)) return NEUTRAL_PRESSURE;
  return 1 / (1 + Math.max(speed, 0) / VELOCITY_PRESSURE_SPEED_SCALE);
}

function speedBetween(
  previous: { x: number; y: number; dt: number | null } | null,
  current: { x: number; y: number; dt: number | null },
): { speed: number; elapsed: number } | null {
  if (
    previous === null ||
    previous.dt === null ||
    current.dt === null ||
    !(current.dt > previous.dt)
  ) {
    return null;
  }
  const elapsed = current.dt - previous.dt;
  return {
    speed: Math.hypot(current.x - previous.x, current.y - previous.y) / elapsed,
    elapsed,
  };
}

/** Raw (unfiltered) effective pressure per control point. */
export function rawPressures(
  pressures: readonly (number | null)[],
  positions: readonly { x: number; y: number; dt: number | null }[],
  brush: InkBrushSpec,
): number[] {
  return pressures.map((pressure, index) => {
    if (pressure !== null) return pressure;
    if (!brush.velocityPressure) return NEUTRAL_PRESSURE;
    const motion = speedBetween(
      positions[index - 1] ?? null,
      positions[index]!,
    );
    return motion === null
      ? NEUTRAL_PRESSURE
      : velocityPressureForSpeed(motion.speed);
  });
}

/**
 * Batch pressure filter over the same causal observation state used live.
 * Hardware axes keep the fixed jitter EMA; velocity fallback uses physical
 * elapsed time. Deterministic and linear. `positions` carries x/y/dt.
 */
export function filterPressureStream(
  pressures: readonly (number | null)[],
  positions: readonly { x: number; y: number; dt: number | null }[],
  brush: InkBrushSpec,
): number[] {
  const carry = initialPressureFilterCarry();
  const out: number[] = [];
  for (let i = 0; i < pressures.length; i++) {
    out.push(
      filterPressureObservation(
        carry,
        pressures[i] ?? null,
        positions[i - 1] ?? null,
        positions[i]!,
        brush,
      ),
    );
  }
  return out;
}

/**
 * Incremental pressure-filter state shared by batch and live compilation.
 */
export interface PressureFilterCarry {
  running: number;
  started: boolean;
}

export function initialPressureFilterCarry(): PressureFilterCarry {
  return { running: NEUTRAL_PRESSURE, started: false };
}

/** Filter one raw (already resolved, non-null) pressure value: O(1). */
export function filterPressureOne(
  carry: PressureFilterCarry,
  raw: number,
): number {
  if (!carry.started) {
    carry.running = raw;
    carry.started = true;
    return raw;
  }
  carry.running =
    PRESSURE_SMOOTHING * raw + (1 - PRESSURE_SMOOTHING) * carry.running;
  return carry.running;
}

/**
 * Resolve and filter one dense cleaned observation. Hardware pressure,
 * including true 0, keeps the existing per-observation jitter EMA. Missing
 * pressure on a velocity brush uses the fixed physical speed response and
 * elapsed-time EMA above. Without two strictly timed points true speed is
 * unknowable, so the result resets to neutral pressure; event count never
 * substitutes for time.
 */
export function filterPressureObservation(
  carry: PressureFilterCarry,
  pressure: number | null,
  previous: { x: number; y: number; dt: number | null } | null,
  current: { x: number; y: number; dt: number | null },
  brush: InkBrushSpec,
): number {
  if (pressure !== null || !brush.velocityPressure) {
    return filterPressureOne(carry, pressure ?? NEUTRAL_PRESSURE);
  }
  const motion = speedBetween(previous, current);
  if (motion === null) {
    carry.running = NEUTRAL_PRESSURE;
    carry.started = true;
    return NEUTRAL_PRESSURE;
  }
  const raw = velocityPressureForSpeed(motion.speed);
  if (!carry.started) {
    carry.running = raw;
    carry.started = true;
    return raw;
  }
  const alpha =
    1 - Math.exp(-motion.elapsed / VELOCITY_PRESSURE_TIME_CONSTANT_MS);
  carry.running = alpha * raw + (1 - alpha) * carry.running;
  return carry.running;
}

/** Position-free raw resolution; velocity callers use
 * `filterPressureObservation` so physical speed and elapsed time are known. */
export function resolveRawPressure(
  pressure: number | null,
  brush: InkBrushSpec,
): number | null {
  if (pressure !== null) return pressure;
  if (brush.velocityPressure) return null;
  return NEUTRAL_PRESSURE;
}
