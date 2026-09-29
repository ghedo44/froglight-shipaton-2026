/**
 * Worker-backed cold Ink compilation protocol.
 *
 * The synchronous `compileInkStroke()` pipeline is headless and
 * deterministic, but a single huge stroke compiles as one uninterruptible
 * main-thread block. Cold/background compilation therefore moves off the
 * main thread: the worker runs the SAME `compileInkStroke` implementation
 * (shared module, no geometry fork) over structured-cloneable canonical
 * input and returns serializable derived geometry.
 *
 * Live writing NEVER uses this path: pointer input stays on the
 * main-thread incremental compiler for minimum latency.
 *
 * Serializable boundary: `CompiledInkStroke.curve.segments` carry
 * `position`/`tangent`/`attributes` closures, which structured-clone
 * cannot transfer. The worker instead transfers the full tessellated
 * geometry verbatim (`nodes`, `polygon`, `bounds`, `mesh`) plus a curve
 * summary, and the main thread rehydrates segment closures by
 * interpolating the transferred tessellation at its own vertices:
 *
 * - `position(u)` at a transferred vertex `u` reproduces that vertex
 *   EXACTLY (interpolation hits vertices); between vertices it follows
 *   the tessellated polyline, which by the tessellation error budget
 *   tracks the true spline within tolerance;
 * - `nodes`/`polygon`/`bounds`/`mesh` — everything rendering,
 *   hit-testing, selection, and erasing consume — transfer VERBATIM;
 * - `translateCompiledInkStroke` only shifts positions, so it commutes
 *   with rehydrated closures exactly like the originals.
 *
 * Equivalence is pinned by the twin test (sync vs worker round-trip):
 * verbatim transfer compared exactly, closures compared at vertices
 * (1e-9) and mid-spans (tessellation tolerance).
 */

import type { Bounds, Point } from '../geometry.js';
import type { InkSample } from '../model.js';
import type { InkBrushSpec } from './brush.js';
import type { CompiledInkStroke, InkGeometryOptions } from './compiler.js';
import type { InkCurveSegment, InkInterpolatedAttributes } from './curve.js';

/** Cold compile request (main thread → worker). All members cloneable. */
export interface InkCompileRequest {
  readonly type: 'compile-ink';
  /** Matches the response; lets stale responses be ignored. */
  readonly requestId: string;
  /** Surface object id under compilation (diagnostics only). */
  readonly objectId: string;
  /** Model generation at enqueue time (staleness guard). */
  readonly generation: number;
  /** Canonical stroke samples (plain data). */
  readonly samples: readonly InkSample[];
  /** Resolved brush (plain data, resolved on the main thread). */
  readonly brush: InkBrushSpec;
  /** Geometry overrides (plain data); absent means defaults. */
  readonly options?: InkGeometryOptions;
}

/** Serializable compiled geometry (worker → main thread). */
export interface SerializableCompiledInk {
  /** Tessellated spine vertices (verbatim, render truth). */
  readonly nodes: SerializedInkNode[];
  /** Closed outline ring (verbatim). */
  readonly polygon: Point[];
  /** Axis-aligned bounds of the polygon (verbatim). */
  readonly bounds: Bounds;
  /** Variable-width outline mesh (verbatim; fan maps as entries). */
  readonly mesh: {
    readonly left: Point[];
    readonly right: Point[];
    readonly ring: Point[];
    readonly leftFans: [number, Point[]][];
    readonly rightFans: [number, Point[]][];
  };
  /** Curve summary (closures cannot transfer; see rehydration). */
  readonly curve: {
    readonly controlCount: number;
    readonly cornerCount?: number;
    readonly dot: {
      readonly x: number;
      readonly y: number;
      readonly attributes: InkInterpolatedAttributes;
    } | null;
    readonly segmentCount: number;
    /** Per-segment `startsRun` flags (corner splits). */
    readonly startsRun: boolean[];
  };
}

/** Plain-data spine vertex (matches `InkStrokeNode`, transfer-safe). */
export interface SerializedInkNode {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly pressure: number;
  readonly tiltX: number | null;
  readonly tiltY: number | null;
  readonly twist: number | null;
  readonly dt: number | null;
  readonly extras: Record<string, unknown>;
  readonly segmentIndex: number;
  readonly u: number;
  readonly controlArc: number;
  readonly corner?: {
    readonly inTx: number;
    readonly inTy: number;
    readonly outTx: number;
    readonly outTy: number;
  };
}

/** Successful cold compile response. */
export interface InkCompiledResponse {
  readonly type: 'compiled-ink';
  readonly requestId: string;
  readonly objectId: string;
  readonly generation: number;
  readonly compiled: SerializableCompiledInk;
  /** Worker-side compile time in milliseconds (observability). */
  readonly compileMs: number;
}

/** Cold compile failure (worker stays alive for later jobs). */
export interface InkCompileErrorResponse {
  readonly type: 'compile-error';
  readonly requestId: string;
  readonly objectId: string;
  readonly generation: number;
  readonly error: string;
}

export type InkCompileResponse = InkCompiledResponse | InkCompileErrorResponse;

function copyPoint(p: Point): Point {
  return { x: p.x, y: p.y };
}

function copyExtras(extras: Record<string, unknown>): Record<string, unknown> {
  return { ...extras };
}

/** Flatten compiled geometry into structured-clone-safe plain data. */
export function serializeCompiledInk(
  compiled: CompiledInkStroke,
): SerializableCompiledInk {
  return {
    nodes: compiled.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      width: n.width,
      pressure: n.pressure,
      tiltX: n.tiltX,
      tiltY: n.tiltY,
      twist: n.twist,
      dt: n.dt,
      extras: copyExtras(n.extras),
      segmentIndex: n.segmentIndex,
      u: n.u,
      controlArc: n.controlArc,
      ...(n.corner !== undefined ? { corner: { ...n.corner } } : {}),
    })),
    polygon: compiled.polygon.map(copyPoint),
    bounds: { ...compiled.bounds },
    mesh: {
      left: compiled.mesh.left.map(copyPoint),
      right: compiled.mesh.right.map(copyPoint),
      ring: compiled.mesh.ring.map(copyPoint),
      leftFans: [...compiled.mesh.leftFans].map(([k, v]) => [
        k,
        v.map(copyPoint),
      ]),
      rightFans: [...compiled.mesh.rightFans].map(([k, v]) => [
        k,
        v.map(copyPoint),
      ]),
    },
    curve: {
      controlCount: compiled.curve.controlCount,
      ...(compiled.curve.cornerCount !== undefined
        ? { cornerCount: compiled.curve.cornerCount }
        : {}),
      dot:
        compiled.curve.dot === null
          ? null
          : {
              x: compiled.curve.dot.x,
              y: compiled.curve.dot.y,
              attributes: { ...compiled.curve.dot.attributes },
            },
      segmentCount: compiled.curve.segments.length,
      startsRun: compiled.curve.segments.map(
        (segment) => segment.startsRun === true,
      ),
    },
  };
}

interface RehydrateLane {
  /** Nodes of one segment, sorted by u. */
  readonly nodes: SerializedInkNode[];
  /**
   * Last emitted vertex of an earlier segment (the chord start when this
   * lane is sparse), or null at the curve start.
   */
  readonly prevAnchor: SerializedInkNode | null;
  /**
   * First emitted vertex of a later segment (the chord end when this
   * lane is sparse), or null at the curve end.
   */
  readonly nextAnchor: SerializedInkNode | null;
}

/** Clamp to [0, 1] (mirrors the committed segment parameterization). */
function clampParam(t: number): number {
  if (!Number.isFinite(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/** Linear interpolation helper. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface Bracket {
  readonly a: SerializedInkNode;
  readonly b: SerializedInkNode;
  /** Interpolation fraction from `a` to `b` (clamped). */
  readonly t: number;
}

/**
 * Surrounding emitted vertices for `(lane, u)` in tessellation order:
 * the last vertex at or before `u` (own lane preferred, else the
 * previous lane's tail) and the first at or after `u` (own lane
 * preferred, else the next lane's head). Same-lane pairs interpolate by
 * `u` fraction; cross-boundary chords use `u` as the segment-local
 * fraction along the chord.
 */
function bracket(lane: RehydrateLane, u: number): Bracket | null {
  const nodes = lane.nodes;
  if (nodes.length === 0) return null;
  let a: SerializedInkNode | null = lane.prevAnchor;
  let b: SerializedInkNode | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.u <= u) a = n;
    if (n.u >= u && b === null) b = n;
  }
  if (b === null) b = lane.nextAnchor;
  if (a === null) a = b;
  if (b === null) b = a;
  if (a === null || b === null) return null;
  if (a === b) return { a, b, t: 0 };
  const aOwn = a !== lane.prevAnchor;
  const bOwn = b !== lane.nextAnchor;
  const t =
    aOwn && bOwn && b.u > a.u
      ? (u - a.u) / (b.u - a.u)
      : // Cross-boundary chord: `u` is the segment-local fraction along
        // it (neighbor spans are micro-spans, so the chord uniformly
        // covers this segment within tolerance).
        u;
  return { a, b, t: t < 0 ? 0 : t > 1 ? 1 : t };
}

/**
 * Interpolate one segment lane at parameter `u`.
 *
 * Vertices reproduce EXACTLY; between vertices the lane follows the
 * emitted tessellation polyline, which the tessellator verified against
 * the true spline within its error budget — including sparse lanes via
 * their cross-boundary chords instead of collapsing to an end vertex.
 */
function lanePosition(lane: RehydrateLane, u: number): Point {
  const frame = bracket(lane, u);
  if (frame === null) return { x: Number.NaN, y: Number.NaN };
  return {
    x: lerp(frame.a.x, frame.b.x, frame.t),
    y: lerp(frame.a.y, frame.b.y, frame.t),
  };
}

function laneNumber(
  lane: RehydrateLane,
  u: number,
  pick: (node: SerializedInkNode) => number,
): number {
  const frame = bracket(lane, u);
  if (frame === null) return 0;
  return lerp(pick(frame.a), pick(frame.b), frame.t);
}

function laneNullable(
  lane: RehydrateLane,
  u: number,
  pick: (node: SerializedInkNode) => number | null,
): number | null {
  const frame = bracket(lane, u);
  if (frame === null) return null;
  const va = pick(frame.a);
  const vb = pick(frame.b);
  // Tilt/twist are categorical (null vs set) per stroke in practice:
  // interpolate only when both bracket ends agree on presence, else
  // take the nearer end (never invent a tilt from nothing).
  if (va === null || vb === null) {
    return frame.t < 0.5 ? va : vb;
  }
  return lerp(va, vb, frame.t);
}

/**
 * Rebuild transfer-safe segment closures from the transferred
 * tessellation. Total: segments without vertices (degenerate dots)
 * evaluate at the dot position, or the origin when even that is absent.
 */
function rehydrateSegment(
  index: number,
  startsRun: boolean,
  lanes: readonly RehydrateLane[],
  dot: SerializableCompiledInk['curve']['dot'],
): InkCurveSegment {
  const lane = lanes[index] ?? null;
  if (lane === null || lane.nodes.length === 0) {
    const fallback: Point =
      dot !== null ? { x: dot.x, y: dot.y } : { x: 0, y: 0 };
    const attributes: InkInterpolatedAttributes =
      dot !== null
        ? { ...dot.attributes }
        : {
            pressure: 0.5,
            tiltX: null,
            tiltY: null,
            twist: null,
            dt: null,
          };
    return {
      position: () => ({ ...fallback }),
      tangent: () => ({ x: 1, y: 0 }),
      attributes: () => ({ ...attributes }),
      arc: () => 0,
      ...(startsRun ? { startsRun: true as const } : {}),
    };
  }
  const positionAt = (u: number): Point => lanePosition(lane, u);
  return {
    position(t: number): Point {
      return positionAt(clampParam(t));
    },
    tangent(t: number): Point {
      // Central difference on the rehydrated position field (same eps
      // contract as the committed segments), so tangent stays consistent
      // with position by construction.
      const u = clampParam(t);
      const eps = 1e-5;
      const a = positionAt(Math.max(u - eps, 0));
      const b = positionAt(Math.min(u + eps, 1));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (Number.isFinite(len) && len > 1e-12) {
        return { x: dx / len, y: dy / len };
      }
      return { x: 1, y: 0 };
    },
    attributes(t: number): InkInterpolatedAttributes {
      const u = clampParam(t);
      return {
        pressure: laneNumber(lane, u, (n) => n.pressure),
        tiltX: laneNullable(lane, u, (n) => n.tiltX),
        tiltY: laneNullable(lane, u, (n) => n.tiltY),
        twist: laneNullable(lane, u, (n) => n.twist),
        dt: laneNullable(lane, u, (n) => n.dt),
      };
    },
    arc(t: number): number {
      return laneNumber(lane, clampParam(t), (n) => n.controlArc);
    },
    extrasAt(t: number): Record<string, unknown> | undefined {
      const u = clampParam(t);
      let best = lane.nodes[0]!;
      let bestDist = Math.abs(best.u - u);
      for (let i = 1; i < lane.nodes.length; i++) {
        const dist = Math.abs(lane.nodes[i]!.u - u);
        if (dist < bestDist) {
          bestDist = dist;
          best = lane.nodes[i]!;
        }
      }
      return { ...best.extras };
    },
    ...(startsRun ? { startsRun: true as const } : {}),
  };
}

/**
 * Rebuild a `CompiledInkStroke` from transferred plain data. Render
 * geometry (`nodes`/`polygon`/`bounds`/`mesh`) is verbatim; curve
 * closures interpolate the transferred tessellation (exact at vertices).
 */
export function rehydrateCompiledInk(
  data: SerializableCompiledInk,
): CompiledInkStroke {
  const lanes: RehydrateLane[] = [];
  for (let s = 0; s < data.curve.segmentCount; s++) {
    lanes.push({ nodes: [], prevAnchor: null, nextAnchor: null });
  }
  for (const node of data.nodes) {
    const lane = lanes[node.segmentIndex];
    if (lane !== undefined) (lane.nodes as SerializedInkNode[]).push(node);
  }
  for (const lane of lanes) {
    (lane.nodes as SerializedInkNode[]).sort((a, b) => a.u - b.u);
  }
  // Cross-boundary anchors in emission order: the last vertex of an
  // earlier segment and the first vertex of a later segment. Sparse
  // lanes interpolate along these chords (tessellation-verified).
  let trailing: SerializedInkNode | null = null;
  for (let s = 0; s < lanes.length; s++) {
    const lane = lanes[s]!;
    (lane as { prevAnchor: SerializedInkNode | null }).prevAnchor = trailing;
    if (lane.nodes.length > 0) trailing = lane.nodes[lane.nodes.length - 1]!;
  }
  let leading: SerializedInkNode | null = null;
  for (let s = lanes.length - 1; s >= 0; s--) {
    const lane = lanes[s]!;
    (lane as { nextAnchor: SerializedInkNode | null }).nextAnchor = leading;
    if (lane.nodes.length > 0) leading = lane.nodes[0]!;
  }
  const segments: InkCurveSegment[] = [];
  for (let s = 0; s < data.curve.segmentCount; s++) {
    segments.push(
      rehydrateSegment(
        s,
        data.curve.startsRun[s] === true,
        lanes,
        data.curve.dot,
      ),
    );
  }
  return {
    curve: {
      segments,
      controlCount: data.curve.controlCount,
      ...(data.curve.cornerCount !== undefined
        ? { cornerCount: data.curve.cornerCount }
        : {}),
      dot:
        data.curve.dot === null
          ? null
          : {
              x: data.curve.dot.x,
              y: data.curve.dot.y,
              attributes: { ...data.curve.dot.attributes },
            },
    },
    mesh: {
      left: data.mesh.left.map((p) => ({ ...p })),
      right: data.mesh.right.map((p) => ({ ...p })),
      leftFans: new Map(
        data.mesh.leftFans.map(([k, v]) => [k, v.map((p) => ({ ...p }))]),
      ),
      rightFans: new Map(
        data.mesh.rightFans.map(([k, v]) => [k, v.map((p) => ({ ...p }))]),
      ),
      ring: data.mesh.ring.map((p) => ({ ...p })),
    },
    nodes: data.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      width: n.width,
      pressure: n.pressure,
      tiltX: n.tiltX,
      tiltY: n.tiltY,
      twist: n.twist,
      dt: n.dt,
      extras: { ...n.extras },
      segmentIndex: n.segmentIndex,
      u: n.u,
      controlArc: n.controlArc,
      ...(n.corner !== undefined ? { corner: { ...n.corner } } : {}),
    })),
    polygon: data.polygon.map((p) => ({ ...p })),
    bounds: { ...data.bounds },
  };
}
