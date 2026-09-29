/**
 * Variable-width outline construction for the smooth-stroke pipeline.
 *
 * The old builder offset each discrete spine point along a polygon-tangent
 * estimated from neighboring vertices (`directionAt`), so every pointer
 * segment became a visible facet and tight turns produced spikes, flipped
 * normals, and holes. Here each tessellated spine point carries its own
 * analytic curve tangent, and the outline derives from it directly:
 *
 * ```text
 * T = normalize(curve tangent)   (continuous along the stroke)
 * N = perpendicular(T)
 * left  = P + N · halfWidth
 * right = P − N · halfWidth
 * ```
 *
 * Smooth spans use analytic normals directly. Hard corners have explicit
 * miter/round joins. Folded inner offsets are repaired as local swept
 * triangles, so tight bends cannot subtract ink from the ribbon fill.
 * Caps are round (pen-like) or flush butt ends (marker-like).
 *
 * Every output point is finite-guarded; zero-width segments collapse to
 * the centerline instead of corrupting the ring. Deterministic, DOM-free.
 */

import type { Point } from '../geometry.js';
import type { TessellatedSpinePoint } from './tessellation.js';

/** Minimum round-cap resolution; wide nibs use a surface-space error budget. */
export const CAP_SEGMENTS = 8;
/** Dot (single-sample) outline resolution. */
export const DOT_SEGMENTS = 12;
/**
 * Miter limit: outer join vertices use the true offset-line intersection
 * (crisp, faithful corners) while the miter stays within this multiple of
 * the local half-width. Beyond it — turns past `MITER_FALLBACK_ANGLE` —
 * the deterministic fallback is a round fan, so extreme miters, spikes,
 * and inverted geometry cannot form.
 */
export const MITER_LIMIT = 4;
/** Turn angle past which the miter limit trips (2·acos(1/4) ≈ 151°). */
export const MITER_FALLBACK_ANGLE = 2 * Math.acos(1 / MITER_LIMIT);
const ROUND_EDGE_TOLERANCE = 0.025;

function arcSteps(radius: number, sweep: number, minimum: number): number {
  const angle =
    2 *
    Math.acos(Math.max(-1, 1 - ROUND_EDGE_TOLERANCE / Math.max(radius, 1e-9)));
  return Math.min(512, Math.max(minimum, Math.ceil(Math.abs(sweep) / angle)));
}

/**
 * Filled stroke mesh: offset sides, per-index joins/fold repairs, plus the
 * closed render ring. Fans are exposed spine-indexed so the incremental
 * live compiler can splice tail regions exactly instead of re-deriving
 * joins through a second implementation.
 */
export interface InkStrokeMesh {
  /** Left offsets in spine order (P + N·half, miter vertices inline). */
  readonly left: readonly Point[];
  /** Right offsets in spine order (P − N·half, miter vertices inline). */
  readonly right: readonly Point[];
  /** Forward side excursions per spine index: joins and fold repairs. */
  readonly leftFans: ReadonlyMap<number, Point[]>;
  /** Forward side excursions per spine index: joins and fold repairs. */
  readonly rightFans: ReadonlyMap<number, Point[]>;
  /** Closed outline ring: left forward, joins, right back, caps. */
  readonly ring: readonly Point[];
}

/** Empty mesh (no spine). Shared shape so callers stay total. */
export function emptyStrokeMesh(): InkStrokeMesh {
  return {
    left: [],
    right: [],
    leftFans: new Map(),
    rightFans: new Map(),
    ring: [],
  };
}

function finitePoint(p: Point, fallback: Point): Point {
  return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : { ...fallback };
}

/** Interior fan points from angle `from` to `to` through `through`. */
export function roundCapFan(
  center: Point,
  radius: number,
  from: number,
  to: number,
  through: number,
  segments: number = CAP_SEGMENTS,
): Point[] {
  return capFan(center, radius, from, to, through, segments);
}

function capFan(
  center: Point,
  radius: number,
  from: number,
  to: number,
  through: number,
  segments: number,
): Point[] {
  const tau = Math.PI * 2;
  let sweep = to - from;
  while (sweep <= 0) sweep += tau;
  let toThrough = through - from;
  while (toThrough < 0) toThrough += tau;
  if (toThrough > sweep) sweep -= tau;
  segments = arcSteps(radius, sweep, segments);
  const out: Point[] = [];
  for (let k = 1; k < segments; k++) {
    const angle = from + (sweep * k) / segments;
    out.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return out;
}

function dotRing(center: Point, radius: number): Point[] {
  const out: Point[] = [];
  const segments =
    Math.ceil(arcSteps(radius, Math.PI * 2, DOT_SEGMENTS) / 4) * 4;
  for (let k = 0; k < segments; k++) {
    const angle = (k / segments) * Math.PI * 2;
    out.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return out;
}

/** Square dot for butt-cap (marker) taps: flush sides, no round overhang. */
function buttDotRing(center: Point, half: number): Point[] {
  return [
    { x: center.x - half, y: center.y - half },
    { x: center.x + half, y: center.y - half },
    { x: center.x + half, y: center.y + half },
    { x: center.x - half, y: center.y + half },
  ];
}

/**
 * An offset folds when the nib is wider than the local bend radius. A
 * single ribbon then winds backwards over ink already laid down, punching
 * a hole in a nonzero fill. Decompose each side into local swept triangles
 * and reverse any folded triangle's contribution. The doubled reverse
 * excursion cancels its old winding and adds the intended winding.
 * Retraced bridges have zero area. Keeping these excursions spine-indexed
 * lets live tail splices and cached heads use exactly the same geometry.
 */
function repairFoldedSide(
  centers: readonly Point[],
  side: readonly Point[],
  fans: Map<number, Point[]>,
  winding: number,
): void {
  const ordered = new Map<number, Point[]>();
  for (let i = 0; i + 1 < side.length; i++) {
    const center = centers[i]!;
    const fan = fans.get(i) ?? [];
    const boundary = [side[i]!, ...fan, side[i + 1]!, centers[i + 1]!];
    const anchor = fan[fan.length - 1] ?? side[i]!;
    const repairs: Point[] = [];
    for (let j = 0; j + 1 < boundary.length; j++) {
      const a = boundary[j]!;
      const b = boundary[j + 1]!;
      const cross =
        (a.x - center.x) * (b.y - center.y) -
        (a.y - center.y) * (b.x - center.x);
      if (cross * winding >= -1e-12) continue;
      repairs.push(center, b, a, center, b, a, center, anchor);
    }
    if (fan.length > 0 || repairs.length > 0)
      ordered.set(i, [...fan, ...repairs]);
  }
  fans.clear();
  for (const [i, fan] of ordered) fans.set(i, fan);
}

/**
 * Build the filled outline mesh for a tessellated spine. Every offset
 * direction and every join turn derives from the analytic curve tangent
 * carried per spine point — never from neighboring polygon vertices, so
 * residual centerline noise cannot whipsaw joins into barbs (tangent
 * turns are bounded by the tessellation angle budget, while chord turns
 * on the same input can exceed 100°). Interior joins use true miter
 * vertices on the outer side (faithful sharp corners) with a
 * deterministic round-fan fallback past the miter limit, and bevel
 * offsets on the inner side. Round caps fan past the endpoints; butt
 * caps end the ribbon flush. Degenerate tangents fall back to the
 * chord direction, then to +x, so the ring stays well-formed.
 */
export function buildStrokeMesh(
  spine: readonly TessellatedSpinePoint[],
  cap: 'round' | 'butt' = 'round',
  startCap: 'round' | 'butt' = cap,
): InkStrokeMesh {
  if (spine.length === 0) return emptyStrokeMesh();
  if (spine.length === 1) {
    const only = spine[0]!;
    const center = finitePoint({ x: only.x, y: only.y }, { x: 0, y: 0 });
    const half = Math.max(only.width / 2, 0);
    const ring =
      cap === 'butt' ? buttDotRing(center, half) : dotRing(center, half);
    return {
      left: [center],
      right: [center],
      leftFans: new Map(),
      rightFans: new Map(),
      ring,
    };
  }
  const centers: Point[] = [];
  const halves: number[] = [];
  for (const node of spine) {
    centers.push(
      finitePoint(
        { x: node.x, y: node.y },
        centers[centers.length - 1] ?? { x: 0, y: 0 },
      ),
    );
    halves.push(Math.max(Number.isFinite(node.width) ? node.width : 0, 0) / 2);
  }
  // Unit tangents per spine point from the analytic curve tangent
  // field (the tessellated `tx`/`ty`); chord directions back up
  // degenerate tangents, then +x. Join turns measured on this field are
  // bounded by the tessellation angle budget — chord turns are not.
  const tangents: Point[] = [];
  for (let i = 0; i < centers.length; i++) {
    const node = spine[i]!;
    let tx = Number.isFinite(node.tx) ? node.tx : NaN;
    let ty = Number.isFinite(node.ty) ? node.ty : NaN;
    if (!(tx * tx + ty * ty > 1e-12)) {
      const a = centers[Math.max(i - 1, 0)]!;
      const b = centers[Math.min(i + 1, centers.length - 1)]!;
      tx = b.x - a.x;
      ty = b.y - a.y;
    }
    if (!(tx * tx + ty * ty > 1e-12)) {
      tx = 1;
      ty = 0;
    }
    const len = Math.hypot(tx, ty);
    tangents.push({ x: tx / len, y: ty / len });
  }
  const endNormal = (t: Point): Point => ({ x: -t.y, y: t.x });
  const left: Point[] = [];
  const right: Point[] = [];
  // Forward side excursions per spine index, per side.
  const leftFans = new Map<number, Point[]>();
  const rightFans = new Map<number, Point[]>();
  // Endpoints: plain offsets along the endpoint tangents (caps close
  // the ring).
  const nFirst = endNormal(tangents[0]!);
  const nLast = endNormal(tangents[tangents.length - 1]!);
  left.push({
    x: centers[0]!.x + nFirst.x * halves[0]!,
    y: centers[0]!.y + nFirst.y * halves[0]!,
  });
  right.push({
    x: centers[0]!.x - nFirst.x * halves[0]!,
    y: centers[0]!.y - nFirst.y * halves[0]!,
  });
  for (let i = 1; i + 1 < centers.length; i++) {
    const center = centers[i]!;
    const half = halves[i]!;
    const corner = spine[i]!.corner;
    if (corner !== undefined) {
      // Hard C0 corner: join the incoming and outgoing run tangents
      // explicitly. A single tessellated tangent cannot describe the
      // discontinuity (averaging would round the corner); the true
      // miter of the two offset lines preserves V/L corners, with the
      // same deterministic round-fan fallback past the miter limit.
      const d0 = { x: corner.inTx, y: corner.inTy };
      const d1 = { x: corner.outTx, y: corner.outTy };
      const n0 = { x: -d0.y, y: d0.x };
      const n1 = { x: -d1.y, y: d1.x };
      const cross = d0.x * d1.y - d0.y * d1.x;
      const dot = Math.min(Math.max(d0.x * d1.x + d0.y * d1.y, -1), 1);
      const turn = Math.acos(dot);
      let mx = n0.x + n1.x;
      let my = n0.y + n1.y;
      const mLen = Math.hypot(mx, my);
      const cosHalf = Math.max(Math.cos(turn / 2), 1e-9);
      const miterLen = half / cosHalf;
      const outerLeft = cross < 0;
      if (mLen > 1e-9 && miterLen <= MITER_LIMIT * half + 1e-9) {
        mx /= mLen;
        my /= mLen;
        if (outerLeft) {
          left.push({
            x: center.x + mx * miterLen,
            y: center.y + my * miterLen,
          });
          right.push({
            x: center.x - n1.x * half,
            y: center.y - n1.y * half,
          });
        } else {
          right.push({
            x: center.x - mx * miterLen,
            y: center.y - my * miterLen,
          });
          left.push({
            x: center.x + n1.x * half,
            y: center.y + n1.y * half,
          });
        }
      } else if (turn > 1e-9) {
        const fromN = outerLeft ? n0 : { x: -n0.x, y: -n0.y };
        const toN = outerLeft ? n1 : { x: -n1.x, y: -n1.y };
        const from = Math.atan2(fromN.y, fromN.x);
        const to = Math.atan2(toN.y, toN.x);
        const tau = Math.PI * 2;
        let sweep = to - from;
        while (sweep <= -Math.PI) sweep += tau;
        while (sweep > Math.PI) sweep -= tau;
        if (outerLeft ? sweep > 0 : sweep < 0) {
          sweep += outerLeft ? -tau : tau;
        }
        const steps = arcSteps(half, sweep, 3) - 1;
        const fan: Point[] = [];
        for (let k = 1; k <= steps; k++) {
          const angle = from + (sweep * k) / (steps + 1);
          fan.push({
            x: center.x + Math.cos(angle) * Math.max(half, 0),
            y: center.y + Math.sin(angle) * Math.max(half, 0),
          });
        }
        fan.push({ x: center.x + toN.x * half, y: center.y + toN.y * half });
        if (outerLeft) {
          left.push({
            x: center.x + fromN.x * half,
            y: center.y + fromN.y * half,
          });
          leftFans.set(i, fan);
          right.push({
            x: center.x - n1.x * half,
            y: center.y - n1.y * half,
          });
        } else {
          right.push({
            x: center.x + fromN.x * half,
            y: center.y + fromN.y * half,
          });
          rightFans.set(i, fan);
          left.push({
            x: center.x + n1.x * half,
            y: center.y + n1.y * half,
          });
        }
      } else {
        left.push({ x: center.x + n1.x * half, y: center.y + n1.y * half });
        right.push({ x: center.x - n1.x * half, y: center.y - n1.y * half });
      }
      continue;
    }
    // Smooth spans already carry the analytic normal. Re-averaging their
    // tangents and beveling only the inner side shifts the cross-section
    // whenever tessellation density changes, making curves visibly jagged.
    const normal = endNormal(tangents[i]!);
    left.push({ x: center.x + normal.x * half, y: center.y + normal.y * half });
    right.push({
      x: center.x - normal.x * half,
      y: center.y - normal.y * half,
    });
  }
  const lastIdx = centers.length - 1;
  left.push({
    x: centers[lastIdx]!.x + nLast.x * halves[lastIdx]!,
    y: centers[lastIdx]!.y + nLast.y * halves[lastIdx]!,
  });
  right.push({
    x: centers[lastIdx]!.x - nLast.x * halves[lastIdx]!,
    y: centers[lastIdx]!.y - nLast.y * halves[lastIdx]!,
  });
  repairFoldedSide(centers, left, leftFans, -1);
  repairFoldedSide(centers, right, rightFans, 1);
  // Assemble: left forward with its fans inline, end cap, right back with
  // its fans inline (reversed), start cap.
  const leftRun: Point[] = [];
  for (let i = 0; i < left.length; i++) {
    leftRun.push(left[i]!);
    const fan = leftFans.get(i);
    if (fan !== undefined) leftRun.push(...fan);
  }
  const rightForward: Point[] = [];
  for (let i = 0; i < right.length; i++) {
    rightForward.push(right[i]!);
    const fan = rightFans.get(i);
    if (fan !== undefined) rightForward.push(...fan);
  }
  rightForward.reverse();
  if (cap === 'butt' && startCap === 'butt') {
    return {
      left,
      right,
      leftFans,
      rightFans,
      ring: [...leftRun, ...rightForward],
    };
  }
  // Per-end caps: predicted continuations seam flush (butt start) under a
  // live tip cap, so translucent tools never double-paint the seam.
  const firstC = centers[0]!;
  const lastC = centers[lastIdx]!;
  const endFan =
    cap === 'butt'
      ? []
      : capFan(
          lastC,
          halves[lastIdx]!,
          Math.atan2(
            left[left.length - 1]!.y - lastC.y,
            left[left.length - 1]!.x - lastC.x,
          ),
          Math.atan2(
            right[right.length - 1]!.y - lastC.y,
            right[right.length - 1]!.x - lastC.x,
          ),
          Math.atan2(
            tangents[tangents.length - 1]!.y,
            tangents[tangents.length - 1]!.x,
          ),
          CAP_SEGMENTS,
        );
  const startFan =
    startCap === 'butt'
      ? []
      : capFan(
          firstC,
          halves[0]!,
          Math.atan2(right[0]!.y - firstC.y, right[0]!.x - firstC.x),
          Math.atan2(left[0]!.y - firstC.y, left[0]!.x - firstC.x),
          Math.atan2(-tangents[0]!.y, -tangents[0]!.x),
          CAP_SEGMENTS,
        );
  return {
    left,
    right,
    leftFans,
    rightFans,
    ring: [...leftRun, ...endFan, ...rightForward, ...startFan],
  };
}
