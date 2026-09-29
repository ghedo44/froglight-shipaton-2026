/**
 * Adaptive curve tessellation for the smooth-stroke pipeline.
 *
 * A continuous spline alone is insufficient if it is later sampled too
 * coarsely: fixed per-segment sampling either wastes vertices on long
 * straights or facets tight handwriting turns (the exact failure this
 * refactor removes). This stage samples each curve segment adaptively —
 * subdividing where curvature is high, width/pressure changes rapidly, or
 * the nib orientation swings, and emitting single spans for nearly
 * straight runs — so the mesh outline tracks the mathematical curve within
 * a formal maximum approximation error.
 *
 * Error budget: the tessellated polyline deviates from the analytic curve
 * by at most `TESSELLATION_TOLERANCE` surface units per subdivision test
 * (flatness, angle, and attribute deltas are all bounded at every emitted
 * span). The tolerance derives from the maximum supported zoom:
 *
 * ```text
 * surface_error <= desired_screen_error / MAX_ZOOM  →  0.05 <= 0.4px / 8
 * ```
 *
 * `TESSELLATION_DESIGN_ZOOM` mirrors the Ink editor's `MAX_ZOOM`
 * (foundation stays headless by owning the constant with this documented
 * derivation rather than importing editor code). At 8× the worst-case
 * facet sits 0.4 screen pixels off the true curve — sub-pixel, with no
 * fixed-vertex-count blowup: long straights still cost one span each.
 *
 * Deterministic, DOM-free. Linear in the emitted vertex count; subdivision
 * depth is capped (`TESSELLATION_MAX_DEPTH`) so pathological input cannot
 * loop forever.
 */

import type { InkBrushSpec } from './brush.js';
import { resolveWidth } from './curve-attributes.js';
import type { InkCurve } from './curve.js';

/**
 * Maximum surface-unit deviation of the tessellated spine from the
 * analytic centerline. Derived: 0.4 screen px at the design zoom 8.
 */
export const TESSELLATION_TOLERANCE = 0.05;
/**
 * Design zoom for the error budget (mirrors the Ink editor MAX_ZOOM;
 * see module docs). Tessellation detail is zoom-independent: one
 * tessellation serves every zoom level, and zoom never re-fits anything.
 */
export const TESSELLATION_DESIGN_ZOOM = 8;
/** Maximum tangent-angle change per emitted span (radians). */
export const TESSELLATION_MAX_ANGLE = (10 * Math.PI) / 180;
/** Maximum relative width change per emitted span. */
export const TESSELLATION_WIDTH_TOLERANCE = 0.12;
/** Maximum pressure change per emitted span. */
export const TESSELLATION_PRESSURE_TOLERANCE = 0.15;
/** Maximum nib-orientation swing per span for shaped nibs (radians). */
export const TESSELLATION_NIB_TOLERANCE = (12 * Math.PI) / 180;
/** Subdivision depth cap per curve segment (1/1024 of a span minimum). */
export const TESSELLATION_MAX_DEPTH = 10;

export interface TessellationOptions {
  readonly tolerance?: number;
  readonly maxAngle?: number;
  readonly widthTolerance?: number;
  readonly pressureTolerance?: number;
  readonly nibTolerance?: number;
  readonly maxDepth?: number;
}

/** One adaptively sampled spine vertex with resolved nib width. */
export interface TessellatedSpinePoint {
  readonly x: number;
  readonly y: number;
  /** Unit curve tangent (continuous — the outline normal derives here). */
  readonly tx: number;
  readonly ty: number;
  /** Resolved width in surface units (pressure + taper + nib + tilt). */
  readonly width: number;
  /** Filtered normalized pressure behind `width` (0–1). */
  readonly pressure: number;
  readonly tiltX: number | null;
  readonly tiltY: number | null;
  readonly twist: number | null;
  readonly dt: number | null;
  /** Unknown per-sample members from the nearer control (preservation). */
  readonly extras: Record<string, unknown>;
  /** Arc position on the control polygon (drives the taper envelope). */
  readonly controlArc: number;
  /** Owning curve segment index (head/tail splicing for live rebuilds). */
  readonly segmentIndex: number;
  /** Segment-local parameter of this vertex (deviation mapping). */
  readonly u: number;
  /**
   * Hard C0 corner joint: the incoming (previous-run end) and outgoing
   * (this-run start) unit tangents at a run-boundary node. Both describe
   * the same position; the single `tx`/`ty` carries the incoming side.
   * The mesh joins the two directions explicitly (true miter within the
   * limit, deterministic round fan past it) instead of rounding the
   * corner. Absent on smooth C2 joints.
   */
  readonly corner?: {
    readonly inTx: number;
    readonly inTy: number;
    readonly outTx: number;
    readonly outTy: number;
  };
}

interface TessellationParams {
  tolerance: number;
  maxAngle: number;
  widthTolerance: number;
  pressureTolerance: number;
  nibTolerance: number;
  maxDepth: number;
}

function resolveParams(options: TessellationOptions = {}): TessellationParams {
  const finiteOr = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  return {
    tolerance: finiteOr(options.tolerance, TESSELLATION_TOLERANCE),
    maxAngle: finiteOr(options.maxAngle, TESSELLATION_MAX_ANGLE),
    widthTolerance: finiteOr(
      options.widthTolerance,
      TESSELLATION_WIDTH_TOLERANCE,
    ),
    pressureTolerance: finiteOr(
      options.pressureTolerance,
      TESSELLATION_PRESSURE_TOLERANCE,
    ),
    nibTolerance: finiteOr(options.nibTolerance, TESSELLATION_NIB_TOLERANCE),
    maxDepth: Math.min(
      Math.max(Math.floor(options.maxDepth ?? TESSELLATION_MAX_DEPTH), 1),
      16,
    ),
  };
}

interface SampledPoint {
  x: number;
  y: number;
  tx: number;
  ty: number;
  pressure: number;
  tiltX: number | null;
  tiltY: number | null;
  twist: number | null;
  dt: number | null;
  extras: Record<string, unknown>;
  width: number;
  controlArc: number;
}

/**
 * Tessellate one fitted centerline. `controlLengths` is the cumulative
 * control-polygon arc (parallel to the curve's controls) with
 * `controlTotal` its length; both come from the compiler so batch and live
 * paths share one taper definition. `firstSegmentIndex` locates
 * `curve.segments[0]` in the global control run for incremental tail
 * rebuilds (0 for full compiles). `extraAt` carries unknown per-sample
 * members by global control index; each vertex takes the nearer endpoint's
 * members so spine→canonical conversion preserves them.
 * Returns spine vertices in order with no duplicate joints.
 */
export function tessellateCurve(
  curve: InkCurve,
  brush: InkBrushSpec,
  controlLengths: readonly number[],
  controlTotal: number,
  options: TessellationOptions = {},
  firstSegmentIndex = 0,
  extraAt?: (controlIndex: number) => Record<string, unknown> | undefined,
): TessellatedSpinePoint[] {
  const params = resolveParams(options);
  const out: TessellatedSpinePoint[] = [];
  const shapedNib = brush.tip.shape !== 'round';
  const nibWeight = 1 - Math.min(Math.max(brush.tip.aspect ?? 1, 0), 1);
  for (let s = 0; s < curve.segments.length; s++) {
    const global = firstSegmentIndex + s;
    const segment = curve.segments[s]!;
    const base = controlLengths[global] ?? 0;
    const next = controlLengths[global + 1] ?? base;
    const span = Math.max(next - base, 0);
    // Hard C0 joint: this span starts a new clamped run, so its start
    // position coincides exactly with the previous span's end while the
    // tangents differ (incoming vs outgoing). Tag the joint node with
    // both directions for an explicit mesh join. The tag travels with
    // the previous span's end node (emitted below); smooth C2 joints
    // keep no tag.
    let corner: TessellatedSpinePoint['corner'] | undefined;
    if (s > 0 && segment.startsRun === true) {
      const prev = curve.segments[s - 1]!;
      const incoming = prev.tangent(1);
      const outgoing = segment.tangent(0);
      const inLen = Math.hypot(incoming.x, incoming.y) || 1;
      const outLen = Math.hypot(outgoing.x, outgoing.y) || 1;
      corner = {
        inTx: incoming.x / inLen,
        inTy: incoming.y / inLen,
        outTx: outgoing.x / outLen,
        outTy: outgoing.y / outLen,
      };
      // Tag the already-emitted joint node (the previous span's end):
      // it shares the run-boundary position exactly while carrying the
      // incoming tangent. Guards keep a silent structural drift from
      // forging corner joins (fallback: ordinary smooth join).
      const joint = out[out.length - 1];
      if (joint !== undefined && joint.segmentIndex === global - 1) {
        const start = segment.position(0);
        if (Math.hypot(start.x - joint.x, start.y - joint.y) < 1e-6) {
          out[out.length - 1] = { ...joint, corner };
        } else {
          corner = undefined;
        }
      } else {
        corner = undefined;
      }
    }
    const sample = (u: number): SampledPoint => {
      const p = segment.position(u);
      const tan = segment.tangent(u);
      const attrs = segment.attributes(u);
      const travelAngle = Math.atan2(tan.y, tan.x);
      // Approximating centerlines carry their own control-arc (B-spline
      // evaluated cumulative arc, endpoints exact); legacy interpolating
      // segments fall back to the control-interval lerp.
      const rawArc = segment.arc?.(u);
      const controlArc =
        typeof rawArc === 'number' && Number.isFinite(rawArc)
          ? rawArc
          : base + span * u;
      const fromSegment = segment.extrasAt?.(u);
      const nearExtras =
        fromSegment !== undefined
          ? fromSegment
          : (extraAt?.(u < 0.5 ? global : global + 1) ?? undefined);
      return {
        x: p.x,
        y: p.y,
        tx: tan.x,
        ty: tan.y,
        pressure: attrs.pressure,
        tiltX: attrs.tiltX,
        tiltY: attrs.tiltY,
        twist: attrs.twist,
        dt: attrs.dt,
        extras: nearExtras !== undefined ? { ...nearExtras } : {},
        width: resolveWidth(
          attrs.pressure,
          brush,
          controlArc,
          controlTotal,
          travelAngle,
          attrs.twist,
          attrs.tiltX,
          attrs.tiltY,
        ),
        controlArc,
      };
    };
    const start = sample(0);
    const end = sample(1);
    // Interior subdivision points for this segment (u-sorted, ends open).
    const interior: { u: number; point: SampledPoint }[] = [];
    subdivide(
      sample,
      0,
      1,
      start,
      end,
      0,
      params,
      shapedNib,
      nibWeight,
      interior,
    );
    if (s === 0) {
      out.push({ ...start, segmentIndex: global, u: 0 });
    }
    interior.sort((a, b) => a.u - b.u);
    for (const entry of interior) {
      out.push({ ...entry.point, segmentIndex: global, u: entry.u });
    }
    out.push({ ...end, segmentIndex: global, u: 1 });
  }
  return out;
}

function subdivide(
  sample: (u: number) => SampledPoint,
  u0: number,
  u1: number,
  p0: SampledPoint,
  p1: SampledPoint,
  depth: number,
  params: TessellationParams,
  shapedNib: boolean,
  nibWeight: number,
  interior: { u: number; point: SampledPoint }[],
): void {
  const um = (u0 + u1) / 2;
  const pm = sample(um);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const chordLen = Math.hypot(dx, dy);
  // Flatness: distance of the mid sample from the chord.
  const flatness =
    chordLen > 1e-12
      ? Math.abs((pm.x - p0.x) * dy - (pm.y - p0.y) * dx) / chordLen
      : Math.hypot(pm.x - p0.x, pm.y - p0.y);
  const dot = Math.min(Math.max(p0.tx * p1.tx + p0.ty * p1.ty, -1), 1);
  const angle = Math.acos(dot);
  const wMax = Math.max(p0.width, p1.width, 1e-9);
  const widthRel = Math.abs(p1.width - p0.width) / wMax;
  const pressureDelta = Math.abs(p1.pressure - p0.pressure);
  let nibDelta = 0;
  if (shapedNib && nibWeight > 1e-9) {
    const a0 = Math.atan2(p0.ty, p0.tx);
    const a1 = Math.atan2(p1.ty, p1.tx);
    let delta = Math.abs(a1 - a0) % (Math.PI * 2);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    nibDelta = delta * nibWeight;
  }
  const needsSplit =
    depth < params.maxDepth &&
    (flatness > params.tolerance ||
      angle > params.maxAngle ||
      widthRel > params.widthTolerance ||
      pressureDelta > params.pressureTolerance ||
      nibDelta > params.nibTolerance);
  if (!needsSplit) return;
  subdivide(
    sample,
    u0,
    um,
    p0,
    pm,
    depth + 1,
    params,
    shapedNib,
    nibWeight,
    interior,
  );
  interior.push({ u: um, point: pm });
  subdivide(
    sample,
    um,
    u1,
    pm,
    p1,
    depth + 1,
    params,
    shapedNib,
    nibWeight,
    interior,
  );
}
