/**
 * Continuous derived centerline for the smooth-stroke pipeline:
 * corner-aware APPROXIMATING clamped uniform B-spline over arc-length
 * working observations.
 *
 * Why approximating (not interpolating): browser/WebView coordinates can
 * contain CSS-pixel quantization and sampling noise (1 CSS px = 0.125
 * surface units at 8×). An interpolating spline forced through every
 * noisy/resampled control faithfully preserves staircases; adaptive
 * tessellation then accurately renders the wrong curve. The final
 * handwriting geometry is therefore approximating rather than forced
 * through every observed/resampled point.
 *
 * - Uniform cubic B-spline (clamped, open): C2 interior continuity (no
 *   curvature jumps at joints, unlike C1 Catmull–Rom), convex-hull
 *   property (no overshoot/loops from ordinary handwriting),
 *   variation-diminishing (smoothing without mush), local support
 *   (each span reads 4 controls — the same ±2 locality that makes the
 *   live compiler's bounded tail rebuild exact), linear fit, O(1) span
 *   evaluation via de Boor.
 * - Corner-aware: intentional corners are detected (turning angle +
 *   side consistency + persistence across multiple observations, never a
 *   single quantized 90° transition) and preserved by splitting into
 *   separate clamped runs (C0 at the corner, C2 elsewhere). Endpoints of
 *   every run interpolate exactly (first/last controls preserved).
 * - Attributes: pressure/tilt ride the same B-spline basis (pressure
 *   clamped to [0,1]); twist unwrapped across ±π then re-wrapped; `dt`
 *   piecewise-linear between span endpoints so timing stays monotone
 *   (geometry and semantic interpolation use related but separate
 *   representations by design).
 * - Control-arc for the taper envelope evaluates the cumulative control
 *   arc with the same basis (endpoints exact); unknown extras take the
 *   nearer central control (endpoints preserved).
 *
 * Degenerate input (coincident controls) falls back to chord direction —
 * never NaN, never an exception.
 *
 * Headless, DOM-free, deterministic, zoom-independent. Fitting is linear;
 * `InkCurveBuilder` supports O(1) amortized append/pop for the
 * incremental live compiler (corner decisions stabilize with ±3
 * lookahead, covered by the tail window).
 */

import type { Point } from '../geometry.js';

/** Interpolated semantic attributes at a curve parameter. */
export interface InkInterpolatedAttributes {
  /** Filtered normalized pressure (always resolved, 0–1). */
  readonly pressure: number;
  readonly tiltX: number | null;
  readonly tiltY: number | null;
  readonly twist: number | null;
  readonly dt: number | null;
}

/** One fitted centerline segment, parameterized on t ∈ [0, 1]. */
export interface InkCurveSegment {
  /** Approximated centerline position (endpoints exact, interior smoothed). */
  position(t: number): Point;
  /** Unit tangent from the analytic curve derivative (never NaN). */
  tangent(t: number): Point;
  /** Interpolated semantic attributes. */
  attributes(t: number): InkInterpolatedAttributes;
  /** Absolute control-arc for the taper envelope (0..total). */
  arc?(t: number): number;
  /** Unknown per-sample members for preservation (nearer control). */
  extrasAt?(t: number): Record<string, unknown> | undefined;
  /**
   * True when this span starts a new clamped run after an intentional
   * corner split (C0 boundary with the previous span). The joint position
   * is shared exactly; tangents differ. Tessellation tags the joint node
   * so the mesh joins it explicitly instead of rounding it.
   */
  startsRun?: boolean;
}

/**
 * Continuous derived centerline: approximating B-spline spans plus a
 * degenerate-dot fallback. `dot` is non-null exactly when fewer than two
 * control samples survived. `cornerCount` reports intentional corners
 * preserved by splitting (diagnostics, not geometry).
 */
export interface InkCurve {
  readonly segments: readonly InkCurveSegment[];
  readonly controlCount: number;
  readonly cornerCount?: number;
  readonly dot: {
    readonly x: number;
    readonly y: number;
    readonly attributes: InkInterpolatedAttributes;
  } | null;
}

/** One curve control sample (post resample/fair, pressure pre-filtered). */
export interface InkCurveControl {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
  readonly tiltX: number | null;
  readonly tiltY: number | null;
  readonly twist: number | null;
  readonly dt: number | null;
}

/** Authoritative dense-source opinion for a coarse control index. */
export type CornerEvidenceAt = (globalControlIndex: number) => boolean;

/**
 * Authoritative control-arc definition shared by the committed and live
 * compilers: cumulative chord arc over the FAIRED controls actually fed
 * into the B-spline, plus its total. Taper envelopes in both paths resolve
 * from exactly this coordinate system (same controls, same cumulative
 * arc, same total) — the live path must never mix a faired numerator with
 * a pre-fair denominator. Batch form over a full array; the incremental
 * builder below maintains the identical definition across push/pop.
 */
export function controlArcLengths(
  controls: readonly { x: number; y: number }[],
): { cumulative: number[]; total: number } {
  const cumulative: number[] = [0];
  for (let i = 1; i < controls.length; i++) {
    const a = controls[i - 1]!;
    const b = controls[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return {
    cumulative,
    total: cumulative.length > 0 ? cumulative[cumulative.length - 1]! : 0,
  };
}

// --- Corner detection (centralized, calibrated, zoom-independent) ---

/**
 * Minimum sustained turning angle to count as an intentional corner.
 * 60°: well above quantization jitter (resampled staircase turns ≈10°)
 * and handwriting wobble, well below sharp V/L corners (75–135°).
 */
export const CORNER_MIN_ANGLE = (60 * Math.PI) / 180;
/**
 * Each side of a corner must be straight within this (direction
 * consistency): oscillating quantization fails, persistent pen motion
 * passes.
 */
export const CORNER_SIDE_CONSISTENCY = (25 * Math.PI) / 180;
/** Minimum supporting arc length per side (surface units, zoom-independent). */
export const CORNER_MIN_ARM = 0.5;
/**
 * Minimum peak prominence for the wide-window second opinion: the ±3
 * turn at the candidate must exceed both ±3 turns two controls away by
 * this. Concentrated direction changes (grid-straddled corners) stand
 * out from their straight arms; diffuse bends (bowls, loops, swells)
 * do not peak and stay smooth.
 */
export const CORNER_WIDE_PROMINENCE = (30 * Math.PI) / 180;
/** 1-steps turning less than this are neutral for monotonicity. */
const CORNER_MONOTONE_EPS = (5 * Math.PI) / 180;
/** Derivative magnitudes below this fall back to chord direction. */
const DERIV_EPS = 1e-12;

function clampParam(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.min(Math.max(t, 0), 1);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return 0;
  const dot = Math.min(Math.max((ax * bx + ay * by) / (la * lb), -1), 1);
  return Math.acos(dot);
}

/**
 * Evaluate one corner candidate at index i (O(1), reads ±3 context).
 * Requires a ±2 core window plus ±3 persistence lookahead: a corner is a
 * sustained direction change, never a single quantized transition. Missing
 * future context (i+3 beyond the current length) skips that persistence
 * check leniently, so tail flags may flicker until future points arrive —
 * callers must only freeze flags with complete windows (see the builder's
 * bounded tail zone). Indices outside [2, n-3] or runs shorter than 5
 * controls never flag (too short to distinguish intent from noise — small
 * hooks survive). Incremental callers use `cornerFlagAt` (this opinion
 * plus the wide second opinion).
 */
export function cornerAt(
  xs: readonly number[],
  ys: readonly number[],
  n: number,
  i: number,
): boolean {
  if (n < 5 || i < 2 || i + 2 >= n) return false;
  const bx = xs[i]! - xs[i - 2]!;
  const by = ys[i]! - ys[i - 2]!;
  const ax = xs[i + 2]! - xs[i]!;
  const ay = ys[i + 2]! - ys[i]!;
  const lenB = Math.hypot(bx, by);
  const lenA = Math.hypot(ax, ay);
  if (lenB < CORNER_MIN_ARM || lenA < CORNER_MIN_ARM) return false;
  const turn = angleBetween(bx, by, ax, ay);
  if (turn < CORNER_MIN_ANGLE) return false;
  // Side consistency: each 2-step side must itself be straight.
  const b1x = xs[i - 1]! - xs[i - 2]!;
  const b1y = ys[i - 1]! - ys[i - 2]!;
  const b2x = xs[i]! - xs[i - 1]!;
  const b2y = ys[i]! - ys[i - 1]!;
  if (angleBetween(b1x, b1y, b2x, b2y) > CORNER_SIDE_CONSISTENCY) return false;
  const a1x = xs[i + 1]! - xs[i]!;
  const a1y = ys[i + 1]! - ys[i]!;
  const a2x = xs[i + 2]! - xs[i + 1]!;
  const a2y = ys[i + 2]! - ys[i + 1]!;
  if (angleBetween(a1x, a1y, a2x, a2y) > CORNER_SIDE_CONSISTENCY) return false;
  // Persistence: the new direction must continue (and the old direction
  // must have history) — a single-sample spike does not persist.
  if (i + 3 < n) {
    const anx = xs[i + 3]! - xs[i + 1]!;
    const any = ys[i + 3]! - ys[i + 1]!;
    if (angleBetween(ax, ay, anx, any) > CORNER_SIDE_CONSISTENCY) return false;
  }
  if (i - 3 >= 0) {
    const pnx = xs[i - 1]! - xs[i - 3]!;
    const pny = ys[i - 1]! - ys[i - 3]!;
    if (angleBetween(bx, by, pnx, pny) > CORNER_SIDE_CONSISTENCY) return false;
  }
  return true;
}

/**
 * Detect intentional corners in a control run. Returns a boolean per
 * control (true = corner, split here). Batch form over all indices;
 * incremental callers should evaluate only their bounded tail zone via
 * `cornerFlagAt` (same decisions, O(tail) instead of O(history)).
 */
export function detectCorners(
  xs: readonly number[],
  ys: readonly number[],
): boolean[] {
  const n = xs.length;
  const out = new Array<boolean>(n).fill(false);
  if (n < 5) return out;
  for (let i = 2; i + 2 < n; i++) {
    out[i] = cornerFlagAt(xs, ys, n, i);
  }
  return out;
}

/** Turn angle and sign over a symmetric ±w window at i. */
function windowTurn(
  xs: readonly number[],
  ys: readonly number[],
  n: number,
  i: number,
  w: number,
): { turn: number; sign: number } | null {
  // Bounds-safe: every read is i±w, so require the full window.
  // Returns null when insufficient context exists — callers treat this as
  // "no second opinion" and fall back to the narrow detector.
  if (i - w < 0 || i + w >= n) return null;
  const ax = xs[i]! - xs[i - w]!;
  const ay = ys[i]! - ys[i - w]!;
  const bx = xs[i + w]! - xs[i]!;
  const by = ys[i + w]! - ys[i]!;
  if (
    !Number.isFinite(ax) ||
    !Number.isFinite(ay) ||
    !Number.isFinite(bx) ||
    !Number.isFinite(by)
  ) {
    return null;
  }
  return {
    turn: angleBetween(ax, ay, bx, by),
    sign: Math.sign(ax * by - ay * bx),
  };
}

/**
 * Wide-window second opinion (O(1), reads ±5 context). The resample grid
 * can straddle a corner apex between marks, smearing one sharp turn
 * across adjacent ±2 windows so no single window looks concentrated
 * (and pairwise side-straightness fails on the smeared steps). The ±3
 * window re-concentrates the turn; monotonicity (no oscillation) plus
 * peak prominence (a true apex, not a diffuse bend) plus the same arm,
 * persistence, and threshold guards keep bowls, loops, swells, and
 * quantization jitter smooth.
 *
 * Bounds safety: every window access is provably in range. The core ±3
 * turn needs i±3, but prominence reads ±3 windows at i±2 (needing i±5),
 * monotonicity reads 1-steps up to i+4, and non-maximum suppression
 * reads ±3 at i±1 (needing i±4). The required radius is therefore 5:
 * indices outside [5, n-6] or runs shorter than 11 controls never flag
 * wide and fall back to the narrow detector (see `cornerFlagAt`).
 * `windowTurn` additionally returns null on insufficient context, so
 * even a direct caller with a short array can never observe an
 * out-of-range read or NaN calculation.
 */
export function cornerAtWide(
  xs: readonly number[],
  ys: readonly number[],
  n: number,
  i: number,
): boolean {
  // Explicit required-radius guard with fallback to narrow detection:
  // insufficient context means "no wide opinion", never a partial read.
  if (n < 7 || i < 5 || i + 5 >= n) return false;
  if (xs.length < n || ys.length < n) return false;
  const bx = xs[i]! - xs[i - 3]!;
  const by = ys[i]! - ys[i - 3]!;
  const ax = xs[i + 3]! - xs[i]!;
  const ay = ys[i + 3]! - ys[i]!;
  if (
    !Number.isFinite(bx) ||
    !Number.isFinite(by) ||
    !Number.isFinite(ax) ||
    !Number.isFinite(ay)
  ) {
    return false;
  }
  const lenB = Math.hypot(bx, by);
  const lenA = Math.hypot(ax, ay);
  if (lenB < CORNER_MIN_ARM || lenA < CORNER_MIN_ARM) return false;
  const turn = angleBetween(bx, by, ax, ay);
  if (turn < CORNER_MIN_ANGLE) return false;
  // Non-maximum suppression: one split per apex. A straddled turn can
  // exceed the threshold in two adjacent windows; splitting twice would
  // plant a degenerate 2-control middle run and blunt the join into a
  // tiny roof. Keep the strongest window (ties break forward,
  // deterministically, so batch and incremental decisions agree).
  // Bounds-safe: windowTurn returns null without sufficient context;
  // a missing neighbor means "no suppression" (edge of the provably-safe
  // radius, already guarded above — null is defense-in-depth only).
  {
    const prev = windowTurn(xs, ys, n, i - 1, 3);
    if (prev !== null && prev.turn > turn) return false;
  }
  {
    const next = windowTurn(xs, ys, n, i + 1, 3);
    if (next !== null && next.turn >= turn) return false;
  }
  // Prominence: a straddled apex still peaks over its neighbors; a
  // diffuse bend of similar total turn does not. Missing context (null)
  // means "no wide opinion" — fall back to narrow.
  const prev = windowTurn(xs, ys, n, i - 2, 3);
  const next = windowTurn(xs, ys, n, i + 2, 3);
  if (prev === null || next === null) return false;
  if (turn - Math.max(prev.turn, next.turn) < CORNER_WIDE_PROMINENCE) {
    return false;
  }
  // Monotonicity: every non-trivial 1-step inside the window turns the
  // same way. Alternating quantization/smoothing wobble never passes,
  // however large individual steps get. Provably safe: the radius-5 guard
  // above guarantees k in [i-3, i+2] reads k+2 <= i+4 < n and k >= 0.
  // Defensive finite checks below ensure no NaN can escape even if a
  // caller passes truncated arrays.
  let sign = 0;
  for (let k = i - 3; k < i + 3; k++) {
    if (k < 0 || k + 2 >= n) return false;
    const x0 = xs[k]!;
    const x1 = xs[k + 1]!;
    const x2 = xs[k + 2]!;
    const y0 = ys[k]!;
    const y1 = ys[k + 1]!;
    const y2 = ys[k + 2]!;
    if (
      !Number.isFinite(x0) ||
      !Number.isFinite(x1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y0) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(y2)
    ) {
      return false;
    }
    const ex = x1 - x0;
    const ey = y1 - y0;
    const fx = x2 - x1;
    const fy = y2 - y1;
    const stepTurn = angleBetween(ex, ey, fx, fy);
    if (stepTurn < CORNER_MONOTONE_EPS) continue;
    const stepSign = Math.sign(ex * fy - ey * fx);
    if (stepSign === 0) continue;
    if (sign === 0) sign = stepSign;
    else if (stepSign !== sign) return false;
  }
  if (sign === 0) return false;
  // Persistence: same straight-continuation guards as the concentrated
  // opinion (a single-sample spike does not persist).
  if (i + 4 < n) {
    const anx = xs[i + 4]! - xs[i + 1]!;
    const any = ys[i + 4]! - ys[i + 1]!;
    if (angleBetween(ax, ay, anx, any) > CORNER_SIDE_CONSISTENCY) return false;
  }
  if (i - 4 >= 0) {
    const pnx = xs[i - 1]! - xs[i - 4]!;
    const pny = ys[i - 1]! - ys[i - 4]!;
    if (angleBetween(bx, by, pnx, pny) > CORNER_SIDE_CONSISTENCY) return false;
  }
  return true;
}

/**
 * Combined corner decision at index i: the concentrated ±2 opinion or
 * the wide ±3 second opinion. Single definition point shared by the
 * batch fitter and the incremental builder, so live previews converge
 * to commits exactly.
 */
export function cornerFlagAt(
  xs: readonly number[],
  ys: readonly number[],
  n: number,
  i: number,
): boolean {
  return cornerAt(xs, ys, n, i) || cornerAtWide(xs, ys, n, i);
}

// --- Attribute preparation (causal, global — matches live builder) ---

function fillCausal(values: readonly (number | null)[]): {
  filled: number[];
  allNull: boolean;
} {
  let firstKnown = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== null) {
      firstKnown = i;
      break;
    }
  }
  if (firstKnown === -1) return { filled: values.map(() => 0), allNull: true };
  const first = values[firstKnown]!;
  const filled: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v !== null) {
      filled[i] = v;
    } else if (i < firstKnown) {
      filled[i] = first;
    } else {
      filled[i] = filled[i - 1]!;
    }
  }
  return { filled, allNull: false };
}

function unwrapAngles(values: number[]): number[] {
  const out = values.slice();
  const tau = Math.PI * 2;
  for (let i = 1; i < out.length; i++) {
    let delta = out[i]! - out[i - 1]!;
    delta = ((((delta + Math.PI) % tau) + tau) % tau) - Math.PI;
    out[i] = out[i - 1]! + delta;
  }
  return out;
}

function wrapAngle(value: number): number {
  const tau = Math.PI * 2;
  return ((((value + Math.PI) % tau) + tau) % tau) - Math.PI;
}

interface PreparedControls {
  xs: number[];
  ys: number[];
  ps: number[];
  tx: number[];
  ty: number[];
  tw: number[];
  dt: number[];
  cum: number[];
  total: number;
  tiltNull: boolean;
  twistNull: boolean;
  dtNull: boolean;
}

function prepareControls(
  controls: readonly InkCurveControl[],
): PreparedControls {
  const tiltX = fillCausal(controls.map((c) => c.tiltX));
  const tiltY = fillCausal(controls.map((c) => c.tiltY));
  const twistRaw = fillCausal(controls.map((c) => c.twist));
  const dtRaw = fillCausal(controls.map((c) => c.dt));
  const xs = controls.map((c) => c.x);
  const ys = controls.map((c) => c.y);
  const cum: number[] = [0];
  for (let i = 1; i < xs.length; i++) {
    cum.push(
      cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!),
    );
  }
  return {
    xs,
    ys,
    ps: controls.map((c) =>
      Number.isFinite(c.pressure) ? clamp01(c.pressure) : 0.5,
    ),
    tx: tiltX.filled,
    ty: tiltY.filled,
    tw: twistRaw.allNull ? twistRaw.filled : unwrapAngles(twistRaw.filled),
    dt: dtRaw.allNull ? dtRaw.filled.map(() => 0) : dtRaw.filled,
    cum,
    total: cum.length > 0 ? cum[cum.length - 1]! : 0,
    tiltNull: tiltX.allNull || tiltY.allNull,
    twistNull: twistRaw.allNull,
    dtNull: dtRaw.allNull,
  };
}

// --- de Boor evaluation for clamped uniform B-spline (frozen copies) ---

function clampedKnots(m: number, p: number): number[] {
  if (p === 1) return [0, 0, 1, 1];
  if (p === 2) return [0, 0, 0, 1, 1, 1];
  // p === 3, m >= 4
  const knots: number[] = [0, 0, 0, 0];
  for (let k = 1; k <= m - 4; k++) knots.push(k);
  const last = m - 3;
  knots.push(last, last, last, last);
  return knots;
}

/**
 * de Boor evaluation over a FROZEN local stencil: `values` holds exactly
 * the p+1 influencing controls (copied at segment creation, never live
 * references — frozen head segments must not observe later history), and
 * `window` holds the 2p+1 surrounding knots with the span at local index
 * p. `k` is the absolute knot value. The hot path keeps the evaluation
 * triangle in scalar locals.
 */
function deBoorLocal(
  values: readonly number[],
  window: readonly number[],
  p: number,
  k: number,
): number {
  // Degree is bounded to three. Keep the de Boor triangle in scalar
  // locals: this preserves its arithmetic order without allocating an
  // array for every coordinate, attribute and tangent sample.
  const weight = (i: number, r: number): number => {
    const denom = window[i + p - r + 1]! - window[i]!;
    const alpha = Math.abs(denom) < 1e-12 ? 0 : (k - window[i]!) / denom;
    return Math.min(Math.max(alpha, 0), 1);
  };
  const d0 = values[0]!;
  let d1 = values[1] ?? d0;
  let d2 = values[2] ?? d0;
  let d3 = values[3] ?? d0;
  if (p >= 3) {
    const a = weight(3, 1);
    d3 = (1 - a) * d2 + a * d3;
  }
  if (p >= 2) {
    const a = weight(2, 1);
    d2 = (1 - a) * d1 + a * d2;
  }
  if (p >= 1) {
    const a = weight(1, 1);
    d1 = (1 - a) * d0 + a * d1;
  }
  if (p >= 3) {
    const a = weight(3, 2);
    d3 = (1 - a) * d2 + a * d3;
  }
  if (p >= 2) {
    const a = weight(2, 2);
    d2 = (1 - a) * d1 + a * d2;
  }
  if (p >= 3) {
    const a = weight(3, 3);
    return (1 - a) * d2 + a * d3;
  }
  return p === 2 ? d2 : p === 1 ? d1 : d0;
}

interface SpanSpec {
  /** Control offset of span start (span stencil uses offset..offset+p). */
  offset: number;
  /** Knot span index `s` within `knots`. */
  s: number;
  /** Degree (1 linear, 2 quadratic, 3 cubic). */
  p: number;
  /** Knots for evaluation (immutable after creation — safe to share). */
  knots: number[];
  /**
   * True when the span starts a new clamped run after a corner split
   * (offset > 0 at a flagged control). Interior C2 joints are false.
   */
  startsRun: boolean;
}

/**
 * Exact cubic span construction with bounded flag walks (no run-length
 * walks, no total-length dependence). Clamped end conditions depend only
 * on the local multiplicity pattern, and uniform middles are
 * translation-invariant — so every case below resolves exactly:
 * - `both` (boundaries at o and o+3): the run IS [o..o+3] (4 controls) →
 *   exact Bézier, no walk needed;
 * - `first` (run starts at o): the run end is either within a bounded
 *   forward scan (exact run knots, O(m≤11)) or far (m≥12 — the fixed
 *   clamped-start window provably avoids the end clamp);
 * - `last`: mirror with a bounded backward scan;
 * - `uni` (deep interior or exactly bounded both sides): exact run knots
 *   when both bounds land nearby, a start-anchored exact prefix or a
 *   fixed synthetic run when one side is far, and the uniform window when
 *   both sides are far (clamp clearance proven by the scan caps).
 * Scan caps are O(1); knot builds are O(m≤20). Single source of truth for
 * batch and incremental emission, so live previews converge to commits.
 */
const UNI_KNOTS = [0, 1, 2, 3, 4, 5, 6];
const START_WIN = [0, 0, 0, 0, 1, 2, 3];
const END_WIN = [0, 1, 2, 3, 4, 4, 4];
/** Fixed synthetic run for far-start spans (length 20, shared, immutable). */
const SYN20_KNOTS = clampedKnots(20, 3);
/** Backward/forward flag-scan caps (O(1), generous vs the ±3 corner window). */
const BACK_SCAN = 7;
const FWD_SCAN = 8;

/** Nearest run boundary at-or-before o (0 counts), or null when far. */
function runStartBefore(
  o: number,
  flags: readonly boolean[],
  cap: number = BACK_SCAN,
): number | null {
  for (let i = o; i >= Math.max(0, o - cap); i--) {
    if (i === 0 || flags[i] === true) return i;
  }
  return null;
}

/** Nearest run boundary at-or-after o (n-1 counts), or null when far. */
function runEndAfter(
  o: number,
  n: number,
  flags: readonly boolean[],
  cap: number = FWD_SCAN,
): number | null {
  for (let i = o; i <= Math.min(n - 1, o + cap); i++) {
    if (i === n - 1 || flags[i] === true) return i;
  }
  return null;
}

/** Start-anchored exact prefix knots for a run starting at a (dL = o-a). */
function prefixKnots(dL: number): number[] {
  const out = [0, 0, 0, 0];
  for (let k = 1; k <= dL + 3; k++) out.push(k);
  return out;
}

/**
 * Cubic span spec for stencil [o..o+3], or null when a corner strictly
 * inside belongs to adjacent runs (their boundary spans cover both sides).
 */
function cubicSpanSpec(
  o: number,
  n: number,
  flags: readonly boolean[],
): SpanSpec | null {
  if (flags[o + 1] === true || flags[o + 2] === true) return null;
  const first = o === 0 || flags[o] === true;
  const last = o + 3 === n - 1 || flags[o + 3] === true;
  // A span starts a new clamped run exactly at a flagged control past
  // the stroke start (C0 boundary with the previous span).
  const startsRun = o > 0 && flags[o] === true;
  if (first && last) {
    return { offset: o, s: 3, p: 3, knots: clampedKnots(4, 3), startsRun };
  }
  if (first && !last) {
    const b = runEndAfter(o + 4, n, flags);
    if (b !== null) {
      const m = b - o + 1;
      return { offset: o, s: 3, p: 3, knots: clampedKnots(m, 3), startsRun };
    }
    return { offset: o, s: 3, p: 3, knots: START_WIN, startsRun };
  }
  if (!first && last) {
    const a = runStartBefore(o - 1, flags);
    if (a !== null) {
      const m = o + 3 - a + 1;
      return {
        offset: o,
        s: 3 + (o - a),
        p: 3,
        knots: clampedKnots(m, 3),
        startsRun,
      };
    }
    return { offset: o, s: 3, p: 3, knots: END_WIN, startsRun };
  }
  const a = runStartBefore(o - 1, flags);
  const b = runEndAfter(o + 4, n, flags);
  if (a !== null && b !== null) {
    const m = b - a + 1;
    return {
      offset: o,
      s: 3 + (o - a),
      p: 3,
      knots: clampedKnots(m, 3),
      startsRun,
    };
  }
  if (a !== null) {
    const dL = o - a;
    return { offset: o, s: 3 + dL, p: 3, knots: prefixKnots(dL), startsRun };
  }
  if (b !== null) {
    return {
      offset: o,
      s: 3 + (o - (b - 19)),
      p: 3,
      knots: SYN20_KNOTS,
      startsRun,
    };
  }
  return { offset: o, s: 3, p: 3, knots: UNI_KNOTS, startsRun };
}

/**
 * When a short run (2–3 controls) starts at o. A short run has boundaries
 * at both ends within 3 steps, otherwise cubic rules apply. Returns the
 * run length (2|3) or 0. Bounded forward scan only.
 */
function shortRunAt(
  o: number,
  n: number,
  flags: readonly boolean[],
): 2 | 3 | 0 {
  if (!(o === 0 || flags[o] === true)) return 0;
  for (let b = o + 1; b <= Math.min(o + 3, n - 1); b++) {
    if (b === n - 1 || flags[b] === true) {
      const m = b - o + 1;
      return m === 2 ? 2 : m === 3 ? 3 : 0;
    }
  }
  return 0;
}

function linearSpanSpec(o: number, startsRun: boolean): SpanSpec {
  return { offset: o, s: 1, p: 1, knots: clampedKnots(2, 1), startsRun };
}

function quadraticSpanSpec(o: number, startsRun: boolean): SpanSpec {
  return { offset: o, s: 2, p: 2, knots: clampedKnots(3, 2), startsRun };
}

function spanKnotRange(span: SpanSpec): { k0: number; k1: number } {
  const k0 = span.knots[span.s]!;
  const k1 = span.knots[span.s + 1]!;
  return { k0, k1 };
}

function copyStencil(
  values: readonly number[],
  offset: number,
  p: number,
): number[] {
  const out: number[] = [];
  for (let j = 0; j <= p; j++) out.push(values[offset + j] ?? 0);
  return out;
}

function copyKnotWindow(
  knots: readonly number[],
  s: number,
  p: number,
): number[] {
  const out: number[] = [];
  for (let t = s - p; t <= s + p; t++) out.push(knots[t] ?? 0);
  return out;
}

function makeSegment(
  prepared: PreparedControls,
  span: SpanSpec,
  tiltNull: boolean,
  twistNull: boolean,
  dtNull: boolean,
  extrasAt: (globalIndex: number) => Record<string, unknown> | undefined,
): InkCurveSegment {
  const { k0, k1 } = spanKnotRange(span);
  const p = span.p;
  // Freeze the influencing stencil (numbers, never live references).
  const lx = copyStencil(prepared.xs, span.offset, p);
  const ly = copyStencil(prepared.ys, span.offset, p);
  const lp = copyStencil(prepared.ps, span.offset, p);
  const ltx = tiltNull ? null : copyStencil(prepared.tx, span.offset, p);
  const lty = tiltNull ? null : copyStencil(prepared.ty, span.offset, p);
  const ltw = twistNull ? null : copyStencil(prepared.tw, span.offset, p);
  const ldt = dtNull ? null : copyStencil(prepared.dt, span.offset, p);
  const lcum = copyStencil(prepared.cum, span.offset, p);
  const window = copyKnotWindow(span.knots, span.s, p);
  const knotAt = (u: number): number => {
    const c = clampParam(u);
    return k0 + (k1 - k0) * c;
  };
  const evalAt = (values: readonly number[], u: number): number =>
    deBoorLocal(values, window, p, knotAt(u));
  // Chord fallback for degenerate tangents (stencil-anchored: the frozen
  // influencing stencil fully determines the span, so no run bounds needed).
  let fx = lx[p]! - lx[0]!;
  let fy = ly[p]! - ly[0]!;
  if (fx * fx + fy * fy < DERIV_EPS * DERIV_EPS) {
    fx = 1;
    fy = 0;
  } else {
    const len = Math.hypot(fx, fy);
    fx /= len;
    fy /= len;
  }
  const fallbackX = lx[0]!;
  const fallbackY = ly[0]!;
  const fallbackP = lp[0]!;
  const fallbackTx = ltx?.[0] ?? 0;
  const fallbackTy = lty?.[0] ?? 0;
  const fallbackTw = ltw?.[0] ?? 0;
  // Span-endpoint dt for monotone timing (frozen).
  const dt0 = ldt === null ? 0 : deBoorLocal(ldt, window, p, k0);
  const dt1 = ldt === null ? 0 : deBoorLocal(ldt, window, p, k1);
  const positionAt = (u: number): Point => {
    const x = evalAt(lx, u);
    const y = evalAt(ly, u);
    return {
      x: Number.isFinite(x) ? x : fallbackX,
      y: Number.isFinite(y) ? y : fallbackY,
    };
  };
  // Frozen extras for the span's candidate globals.
  const extrasCache = new Map<number, Record<string, unknown> | undefined>();
  const cachedExtras = (
    global: number,
  ): Record<string, unknown> | undefined => {
    if (!extrasCache.has(global)) {
      const e = extrasAt(global);
      extrasCache.set(global, e !== undefined ? { ...e } : undefined);
    }
    const hit = extrasCache.get(global);
    return hit !== undefined ? { ...hit } : undefined;
  };
  const extrasFor = (u: number): Record<string, unknown> | undefined => {
    // Nearer stencil control (endpoints exact: u=0 → offset, u=1 →
    // offset+p — matching run endpoints for first/last spans).
    const c = clampParam(u);
    let global: number;
    if (p === 1) {
      global = c < 0.5 ? span.offset : span.offset + 1;
    } else if (p === 2) {
      if (c < 0.25) global = span.offset;
      else if (c > 0.75) global = span.offset + 2;
      else global = span.offset + 1;
    } else {
      if (c < 0.25) global = span.offset;
      else if (c > 0.75) global = span.offset + 3;
      else global = span.offset + (c < 0.5 ? 1 : 2);
    }
    return cachedExtras(global);
  };
  return {
    position(t: number): Point {
      return positionAt(t);
    },
    tangent(t: number): Point {
      // Central difference on the frozen position field: guaranteed
      // consistent with position (no analytic/position mismatch), C2
      // interior keeps the difference accurate; degenerate spans fall
      // back to the frozen chord. Eps 1e-5 balances truncation (one-sided
      // O(eps) at joints) against floating-point cancellation.
      const u = clampParam(t);
      const eps = 1e-5;
      const a = positionAt(Math.max(u - eps, 0));
      const b = positionAt(Math.min(u + eps, 1));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (Number.isFinite(len) && len > DERIV_EPS) {
        return { x: dx / len, y: dy / len };
      }
      return { x: fx, y: fy };
    },
    attributes(t: number): InkInterpolatedAttributes {
      const u = clampParam(t);
      const pressure = evalAt(lp, u);
      const tiltX = ltx === null ? 0 : evalAt(ltx, u);
      const tiltY = lty === null ? 0 : evalAt(lty, u);
      const twist = ltw === null ? 0 : evalAt(ltw, u);
      return {
        pressure: clamp01(Number.isFinite(pressure) ? pressure : fallbackP),
        tiltX: tiltNull ? null : Number.isFinite(tiltX) ? tiltX : fallbackTx,
        tiltY: tiltNull ? null : Number.isFinite(tiltY) ? tiltY : fallbackTy,
        twist: twistNull
          ? null
          : Number.isFinite(twist)
            ? wrapAngle(twist)
            : wrapAngle(fallbackTw),
        dt: dtNull ? null : dt0 + (dt1 - dt0) * u,
      };
    },
    arc(t: number): number {
      const arc = evalAt(lcum, t);
      return Number.isFinite(arc) ? arc : 0;
    },
    extrasAt(t: number): Record<string, unknown> | undefined {
      return extrasFor(t);
    },
    startsRun: span.startsRun,
  };
}

/**
 * Fit a corner-aware approximating centerline through control samples.
 * Endpoints interpolate exactly; interior approximates (quantization-grade
 * smoothing); intentional corners split into C0 runs. Linear for 2
 * controls, quadratic for 3, clamped cubic B-spline for 4+.
 */
export function fitCenterlineCurve(
  controls: readonly InkCurveControl[],
  extrasAt?: (globalIndex: number) => Record<string, unknown> | undefined,
  cornerEvidenceAt?: CornerEvidenceAt,
): InkCurve {
  if (controls.length < 2) {
    const only = controls[0];
    const attributes: InkInterpolatedAttributes =
      only === undefined
        ? { pressure: 0.5, tiltX: null, tiltY: null, twist: null, dt: null }
        : {
            pressure: Number.isFinite(only.pressure)
              ? clamp01(only.pressure)
              : 0.5,
            tiltX: only.tiltX,
            tiltY: only.tiltY,
            twist: only.twist,
            dt: only.dt,
          };
    return {
      segments: [],
      controlCount: controls.length,
      cornerCount: 0,
      dot: only === undefined ? null : { x: only.x, y: only.y, attributes },
    };
  }
  const prepared = prepareControls(controls);
  const n = controls.length;
  const corners = detectCorners(prepared.xs, prepared.ys);
  if (cornerEvidenceAt !== undefined) {
    for (let i = 0; i < corners.length; i++) {
      corners[i] = corners[i] === true && cornerEvidenceAt(i);
    }
  }
  const extraFn = extrasAt ?? (() => undefined);
  const segments: InkCurveSegment[] = [];
  const emit = (spec: SpanSpec): void => {
    segments.push(
      makeSegment(
        prepared,
        spec,
        prepared.tiltNull,
        prepared.twistNull,
        prepared.dtNull,
        extraFn,
      ),
    );
  };
  // Unified per-offset emission (single source of truth shared with the
  // incremental builder): short runs first (mutually exclusive with cubic
  // — a short run's end corner always skips the overlapping cubic), then
  // cubic spans. Offset order keeps tessellation/live splicing stable.
  for (let o = 0; o <= n - 2; o++) {
    const m = shortRunAt(o, n, corners);
    if (m === 2) {
      emit(linearSpanSpec(o, o > 0));
      continue;
    }
    if (m === 3) {
      emit(quadraticSpanSpec(o, o > 0));
      continue;
    }
    if (o <= n - 4) {
      const spec = cubicSpanSpec(o, n, corners);
      if (spec !== null) emit(spec);
    }
  }
  return {
    segments,
    controlCount: controls.length,
    cornerCount: corners.filter(Boolean).length,
    dot: null,
  };
}

/**
 * Incremental curve builder for the live compiler. `push`/`pop` maintain
 * the full prepared attribute arrays plus a parallel corner-flag array;
 * flags for the frozen prefix never change (their ±3 window is fully
 * historic and values are frozen), so each refit recomputes only a bounded
 * tail zone and re-emits only spans overlapping it. Kept prefix spans are
 * untouched (stable absolute indices — the live tessellation splice stays
 * aligned). Per-append work is O(tail), memory O(history) like the live
 * compiler's other retained streams. `curve` is a live view — committed
 * and live share one fitting implementation (same per-offset emission
 * rules as the batch path, so previews converge to commits exactly).
 */
export class InkCurveBuilder {
  #controls: InkCurveControl[] = [];
  #xs: number[] = [];
  #ys: number[] = [];
  #ps: number[] = [];
  #tx: number[] = [];
  #ty: number[] = [];
  #tw: number[] = [];
  #dt: number[] = [];
  #cum: number[] = [];
  #knownTx = 0;
  #knownTy = 0;
  #knownTw = 0;
  #knownDt = 0;
  #extras: Record<string, unknown>[] = [];
  #segments: InkCurveSegment[] = [];
  /** Stencil-first control offset per segment (parallel to #segments). */
  #segOffset: number[] = [];
  /** Stencil-last control offset per segment (parallel to #segments). */
  #segLast: number[] = [];
  #corners: boolean[] = [];
  #cornerTotal = 0;
  #cornerEvidenceAt: CornerEvidenceAt | undefined;
  #controlIndexBase = 0;
  /**
   * Arc origin for the cumulative control arc: 0 for standalone curves;
   * a prediction scratch builder sets this to the live total minus its
   * snapshot arc so rebased snapshots keep GLOBAL arc coordinates (same
   * taper domain as the continued stroke — see `reset()`).
   */
  #arcBase = 0;

  get controlCount(): number {
    return this.#controls.length;
  }

  /** Install dense-source validation for production corner candidates. */
  setCornerEvidence(cornerEvidenceAt: CornerEvidenceAt | undefined): void {
    this.#cornerEvidenceAt = cornerEvidenceAt;
    this.#refitTail();
  }

  /**
   * Cumulative control-arc of the pushed (faired) controls, parallel to
   * the control history — the live half of the shared taper coordinate
   * system (see `controlArcLengths`). Live view: entries for the frozen
   * prefix never change (append-only positions), so tessellation may hold
   * the reference across one synchronous publish; copy it to retain.
   */
  controlArcLengths(): readonly number[] {
    return this.#cum;
  }

  /**
   * Total control-arc of the pushed (faired) controls — the live taper
   * denominator, identical in definition to the committed total over the
   * same faired controls.
   */
  controlTotal(): number {
    return this.#cum.length > 0 ? this.#cum[this.#cum.length - 1]! : 0;
  }

  /** Append one control sample; refits only the bounded tail. */
  push(control: InkCurveControl, extras?: Record<string, unknown>): void {
    const i = this.#controls.length;
    this.#controls.push(control);
    this.#xs.push(control.x);
    this.#ys.push(control.y);
    this.#ps.push(
      Number.isFinite(control.pressure) ? clamp01(control.pressure) : 0.5,
    );
    this.#pushAxis('tx', control.tiltX, i);
    this.#pushAxis('ty', control.tiltY, i);
    this.#pushTwist(control.twist);
    if (control.dt !== null) {
      this.#knownDt++;
      this.#dt.push(control.dt);
    } else {
      this.#dt.push(this.#knownDt > 0 ? this.#dt[i - 1]! : 0);
    }
    const prevCum = i > 0 ? this.#cum[i - 1]! : this.#arcBase;
    this.#cum.push(
      i > 0
        ? prevCum +
            Math.hypot(
              control.x - this.#xs[i - 1]!,
              control.y - this.#ys[i - 1]!,
            )
        : this.#arcBase,
    );
    this.#extras.push(extras !== undefined ? { ...extras } : {});
    this.#corners.push(false);
    this.#refitTail();
  }

  /** Remove the last control sample; refits only the bounded tail. */
  pop(): InkCurveControl | null {
    const removed = this.#controls.pop() ?? null;
    if (removed === null) return null;
    this.#xs.pop();
    this.#ys.pop();
    this.#ps.pop();
    this.#tx.pop();
    this.#ty.pop();
    this.#tw.pop();
    this.#dt.pop();
    this.#cum.pop();
    this.#extras.pop();
    if (this.#corners.pop() === true) this.#cornerTotal--;
    if (removed.tiltX !== null) this.#knownTx--;
    if (removed.tiltY !== null) this.#knownTy--;
    if (removed.twist !== null) this.#knownTw--;
    if (removed.dt !== null) this.#knownDt--;
    this.#refitTail();
    return removed;
  }

  /** Replace all controls (counted full rebuilds only). */
  reset(
    controls: readonly InkCurveControl[],
    extrasAt?: (globalIndex: number) => Record<string, unknown> | undefined,
    arcBase = 0,
    controlIndexBase = 0,
  ): void {
    this.#controls = [];
    this.#xs = [];
    this.#ys = [];
    this.#ps = [];
    this.#tx = [];
    this.#ty = [];
    this.#tw = [];
    this.#dt = [];
    this.#cum = [];
    this.#extras = [];
    this.#knownTx = 0;
    this.#knownTy = 0;
    this.#knownTw = 0;
    this.#knownDt = 0;
    this.#segments = [];
    this.#segOffset = [];
    this.#segLast = [];
    this.#corners = [];
    this.#cornerTotal = 0;
    // Arc origin for snapshots continued from a longer history: global
    // arc coordinates keep the taper domain continuous (prediction
    // scratch builders). Standalone curves always use 0.
    this.#arcBase = arcBase;
    this.#controlIndexBase = controlIndexBase;
    for (let i = 0; i < controls.length; i++) {
      this.push(controls[i]!, extrasAt?.(i));
    }
  }

  /**
   * Bounded tail snapshot for prediction scratch builders: the last `n`
   * controls with their extras (copies). The live builder is never
   * touched; the scratch resets from this plus an arc base and continues
   * the frontier statefully.
   */
  tailSnapshot(
    n: number,
  ): { control: InkCurveControl; extras: Record<string, unknown> }[] {
    const start = Math.max(0, this.#controls.length - Math.max(n, 0));
    const out: { control: InkCurveControl; extras: Record<string, unknown> }[] =
      [];
    for (let i = start; i < this.#controls.length; i++) {
      out.push({
        control: { ...this.#controls[i]! },
        extras: { ...(this.#extras[i] ?? {}) },
      });
    }
    return out;
  }

  /** Live view: segments array identity is stable across tail refits. */
  get curve(): InkCurve {
    if (this.#controls.length < 2) {
      return fitCenterlineCurve(this.#controls);
    }
    return {
      segments: this.#segments,
      controlCount: this.#controls.length,
      cornerCount: this.#cornerTotal,
      dot: null,
    };
  }

  #pushAxis(kind: 'tx' | 'ty', value: number | null, index: number): void {
    const arr = kind === 'tx' ? this.#tx : this.#ty;
    const known = kind === 'tx' ? this.#knownTx : this.#knownTy;
    if (value !== null) {
      if (known === 0) {
        for (let k = 0; k < index; k++) arr[k] = value;
      }
      arr.push(value);
      if (kind === 'tx') this.#knownTx++;
      else this.#knownTy++;
    } else {
      arr.push(known > 0 ? arr[index - 1]! : 0);
    }
  }

  #pushTwist(value: number | null): void {
    if (value !== null) {
      if (this.#knownTw === 0) {
        for (let k = 0; k < this.#tw.length; k++) this.#tw[k] = value;
        this.#tw.push(value);
      } else {
        const prev = this.#tw[this.#tw.length - 1]!;
        const tau = Math.PI * 2;
        const turns = Math.round((prev - value) / tau);
        this.#tw.push(value + (Number.isFinite(turns) ? turns : 0) * tau);
      }
      this.#knownTw++;
    } else {
      this.#tw.push(this.#knownTw > 0 ? this.#tw[this.#tw.length - 1]! : 0);
    }
  }

  #preparedView(): PreparedControls {
    return {
      xs: this.#xs,
      ys: this.#ys,
      ps: this.#ps,
      tx: this.#tx,
      ty: this.#ty,
      tw: this.#tw,
      dt: this.#dt,
      cum: this.#cum,
      total: this.#cum.length > 0 ? this.#cum[this.#cum.length - 1]! : 0,
      tiltNull: this.#knownTx === 0 || this.#knownTy === 0,
      twistNull: this.#knownTw === 0,
      dtNull: this.#knownDt === 0,
    };
  }

  #refitTail(): void {
    const n = this.#controls.length;
    // Parallel invariant (push/pop maintain it; repair defensively without
    // ever discarding retained head flags).
    while (this.#corners.length < n) this.#corners.push(false);
    while (this.#corners.length > n) {
      if (this.#corners.pop() === true) this.#cornerTotal--;
    }
    if (n < 2) {
      this.#segments = [];
      this.#segOffset = [];
      this.#segLast = [];
      return;
    }
    // Recompute corner flags for the bounded tail zone only. The zone must
    // cover value volatility, not just the ±3 decision window: faired
    // values keep settling until ~24 controls behind the tip, so flags
    // frozen earlier would lock in corners decided on provisional values.
    // Zone width 32 exceeds decision window (3) + persistence lookahead
    // (3) + value settling (~24) with margin, so every flag aging out was
    // already recomputed with complete context and final values — frozen
    // head flags stay final. Full historic arrays back every read.
    const ZONE = 32;
    const z0 = Math.max(0, n - ZONE);
    for (let i = z0; i < n; i++) {
      const candidate = cornerFlagAt(this.#xs, this.#ys, n, i);
      const next =
        candidate &&
        (this.#cornerEvidenceAt?.(this.#controlIndexBase + i) ?? true);
      if (next !== this.#corners[i]) {
        this.#corners[i] = next;
        this.#cornerTotal += next ? 1 : -1;
      }
    }
    // Drop trailing spans past a flat offset horizon and re-emit everything
    // from there with identical rules to the batch path. Flat (never
    // break-on-first-keepable): a droppable cubic can hide behind a
    // keepable small run, so early-break scans under-drop. The horizon is
    // exact, not heuristic: kept cubic spans (offset ≤ n-45) read flags ≤
    // offset+12 < n-32 and values ≤ offset+3 < n-24 — all frozen final
    // forever — and kept small spans (offset ≤ n-45 ⇒ last ≤ n-43 < n-32)
    // likewise. Bounded (~46 spans) per refit.
    const OFROM = Math.max(0, n - 44);
    let keep = this.#segments.length;
    while (keep > 0 && this.#segOffset[keep - 1]! >= OFROM) {
      keep--;
    }
    this.#segments.length = keep;
    this.#segOffset.length = keep;
    this.#segLast.length = keep;
    const prepared = this.#preparedView();
    const extrasAt = (g: number): Record<string, unknown> | undefined =>
      this.#extras[g] !== undefined ? { ...this.#extras[g]! } : undefined;
    for (let o = OFROM; o <= n - 2; o++) {
      const m = shortRunAt(o, n, this.#corners);
      if (m === 2) {
        this.#pushBuilt(prepared, linearSpanSpec(o, o > 0), o, o + 1, extrasAt);
        continue;
      }
      if (m === 3) {
        this.#pushBuilt(
          prepared,
          quadraticSpanSpec(o, o > 0),
          o,
          o + 2,
          extrasAt,
        );
        continue;
      }
      if (o <= n - 4) {
        const spec = cubicSpanSpec(o, n, this.#corners);
        if (spec !== null) this.#pushBuilt(prepared, spec, o, o + 3, extrasAt);
      }
    }
  }

  #pushBuilt(
    prepared: PreparedControls,
    spec: SpanSpec,
    offset: number,
    last: number,
    extrasAt: (globalIndex: number) => Record<string, unknown> | undefined,
  ): void {
    this.#segments.push(
      makeSegment(
        prepared,
        spec,
        prepared.tiltNull,
        prepared.twistNull,
        prepared.dtNull,
        extrasAt,
      ),
    );
    this.#segOffset.push(offset);
    this.#segLast.push(last);
  }
}
