/**
 * Authoritative committed stroke compiler for the continuous
 * smooth-stroke pipeline.
 *
 * ```text
 * captured semantic observations (dense, faithful to physical input)
 *         ↓  sanitizeSamples       (samples.ts — invalid/exact-duplicate only)
 * uniform working observations     (resample.ts — device-frequency grid)
 *         ↓  stabilizePositions    (stabilization.ts — continuous EMA)
 * low-latency input stabilization
 *         ↓  fairControlPolygon    (continuous Laplacian, no thresholds)
 * streamline fairing
 *         ↓  filterPressureStream  (curve-attributes.ts — jitter EMA)
 * pressure resolution
 *         ↓  fitCenterlineCurve    (curve.ts — corner-aware APPROXIMATING
 *                                    clamped uniform B-spline; treats tiny
 *                                    staircase motion as sampling noise,
 *                                    preserves intentional corners by splitting)
 * trajectory estimation (NOT interpolation through every observation)
 *         ↓  tessellateCurve       (tessellation.ts — adaptive, error-bound)
 * adaptive curve tessellation
 *         ↓  buildStrokeMesh       (outline.ts — curve-tangent offsets)
 * variable-width outline
 *         ↓  boundsOfPoints        (bounds.ts)
 * high-quality filled stroke mesh/path
 * ```
 *
 * Observation vs anchor contract: resampled points are working
 * observations for filters, velocity estimation, and numerical stability —
 * they are NOT mandatory final curve knots. The final centerline is
 * approximating rather than forced through every observed/resampled point,
 * because browser/stylus coordinates can contain quantization and sampling
 * noise. Endpoints are always preserved exactly; intentional corners are
 * preserved by corner-aware splitting.
 *
 * Canonical input stays semantic (samples + resolved brush); the visible
 * stroke is derived. Given the same canonical samples and resolved brush,
 * output is deterministic and zoom-independent: serialized/canonical state
 * never depends on view zoom or device pixel ratio, and zooming never
 * re-fits the mathematical centerline.
 */

import type { Bounds, Point } from '../geometry.js';
import type { InkSample } from '../model.js';
import type { InkBrushSpec } from './brush.js';
import { boundsOfPoints } from './bounds.js';
import {
  filterPressureStream,
  resolveUntaperedWidth,
} from './curve-attributes.js';
import {
  fitCenterlineCurve,
  controlArcLengths,
  type InkCurve,
  type InkCurveControl,
} from './curve.js';
import {
  CORNER_EVIDENCE_SPACING,
  hasSourceCornerEvidence,
  sourceArcLength,
} from './corner-evidence.js';
import {
  buildStrokeMesh,
  emptyStrokeMesh,
  type InkStrokeMesh,
} from './outline.js';
import { arcLengthResample, defaultControlSpacing } from './resample.js';
import { sanitizeSamples } from './samples.js';
import { fairControlPolygon, stabilizePositions } from './stabilization.js';
import {
  tessellateCurve,
  type TessellatedSpinePoint,
  type TessellationOptions,
} from './tessellation.js';

/** One tessellated spine vertex with its resolved nib width. */
export interface InkStrokeNode {
  readonly x: number;
  readonly y: number;
  /** Resolved width in surface units (pressure + taper applied). */
  readonly width: number;
  /** Filtered normalized pressure behind `width` (0–1). */
  readonly pressure: number;
  readonly tiltX: number | null;
  readonly tiltY: number | null;
  readonly twist: number | null;
  readonly dt: number | null;
  /** Unknown per-sample members from the nearer control (preservation). */
  readonly extras: Record<string, unknown>;
  /** Owning curve segment index (-1 for dots). */
  readonly segmentIndex: number;
  /** Segment-local parameter of this vertex. */
  readonly u: number;
  /**
   * Arc position on the faired control polygon (drives the taper
   * envelope). Committed and live compilers resolve this from the same
   * faired-control coordinate system, so head nodes agree exactly.
   */
  readonly controlArc: number;
  /**
   * Hard C0 corner joint (incoming/outgoing run tangents at a shared
   * run-boundary position). Mirrors the tessellated spine tag so outline
   * join correctness is inspectable on committed nodes; absent on smooth
   * joints.
   */
  readonly corner?: {
    readonly inTx: number;
    readonly inTy: number;
    readonly outTx: number;
    readonly outTy: number;
  };
}

/**
 * Derived render geometry for one stroke: the continuous fitted centerline
 * plus its tessellated mesh. Distinct from the canonical `InkStrokeGeometry`
 * record shape in model.js — compiler output is derived and never
 * persisted. `nodes`/`polygon` are the render-ready views (tessellated
 * spine + closed outline ring); `curve`/`mesh` carry the full derivation
 * for hit-testing, selection, and eraser alignment.
 */
export interface CompiledInkStroke {
  /** Continuous fitted centerline (position/tangent/attributes). */
  readonly curve: InkCurve;
  /** Variable-width outline mesh (offset sides + closed ring). */
  readonly mesh: InkStrokeMesh;
  /** Tessellated spine vertices with resolved widths. */
  readonly nodes: readonly InkStrokeNode[];
  /** Closed outline ring: the filled stroke path. */
  readonly polygon: readonly Point[];
  /** Axis-aligned bounds of the polygon. */
  readonly bounds: Bounds;
}

export interface InkGeometryOptions {
  /** Target resample spacing in surface units (default from brush size). */
  readonly spacing?: number;
  /**
   * Minimum kept distance between raw samples (default 0 = exact
   * duplicates only). Any positive floor must be justified against the
   * maximum supported zoom (1 CSS px = 0.125 units at 8×); the historic
   * 0.25 floor erased two pixels of slow high-zoom travel and is removed.
   */
  readonly minDistance?: number;
  /** Tessellation overrides (tests and tooling; default budget applies). */
  readonly tessellation?: TessellationOptions;
}

/** Control-polygon cumulative arc plus total (shared taper definition). */
export { controlArcLengths };

function toNode(point: TessellatedSpinePoint): InkStrokeNode {
  return {
    x: point.x,
    y: point.y,
    width: point.width,
    pressure: point.pressure,
    tiltX: point.tiltX,
    tiltY: point.tiltY,
    twist: point.twist,
    dt: point.dt,
    extras: { ...point.extras },
    segmentIndex: point.segmentIndex,
    u: point.u,
    controlArc: point.controlArc,
    ...(point.corner !== undefined ? { corner: { ...point.corner } } : {}),
  };
}

/**
 * Compile raw capture samples into a continuous fitted centerline plus a
 * filled outline mesh for one brush. Pure and deterministic: the same
 * samples and spec always produce the same geometry.
 */
export function compileInkStroke(
  samples: readonly InkSample[],
  brush: InkBrushSpec,
  options: InkGeometryOptions = {},
): CompiledInkStroke {
  const empty: CompiledInkStroke = {
    curve: { segments: [], controlCount: 0, dot: null },
    mesh: emptyStrokeMesh(),
    nodes: [],
    polygon: [],
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  };
  const minDistance =
    typeof options.minDistance === 'number' &&
    Number.isFinite(options.minDistance) &&
    options.minDistance >= 0
      ? options.minDistance
      : 0;
  const spacing =
    typeof options.spacing === 'number' &&
    Number.isFinite(options.spacing) &&
    options.spacing > 0
      ? options.spacing
      : defaultControlSpacing(brush.size);
  const cleaned = sanitizeSamples(samples, minDistance);
  if (cleaned.length === 0) return empty;
  const cornerSource = arcLengthResample(cleaned, CORNER_EVIDENCE_SPACING);
  const cornerSourceArc = sourceArcLength(cleaned);
  // Pressure resolves on the dense raw stream (the jitter EMA only
  // converges with raw sample density — filtering sparse controls would
  // lag ramps by most of the stroke). Stabilization runs on the uniform
  // resample grid: per-step smoothing with tip lag of a fraction of one
  // grid step (low latency by construction), while the continuous
  // Laplacian fairing below provides device-independent shape smoothing
  // with no lag at all (symmetric stencil).
  const filtered = filterPressureStream(
    cleaned.map((s) => s.pressure),
    cleaned,
    brush,
  );
  const pressured: typeof cleaned = cleaned.map((s, i) => ({
    ...s,
    pressure: filtered[i]!,
    extras: { ...s.extras },
  }));
  const resampled = arcLengthResample(pressured, spacing);
  const stabilized = stabilizePositions(resampled, brush.stabilization);
  const faired = fairControlPolygon(stabilized, brush.streamline);
  if (faired.length === 0) return empty;
  const controls: InkCurveControl[] = faired.map((s) => ({
    x: s.x,
    y: s.y,
    pressure: s.pressure ?? 0.5,
    tiltX: s.tiltX,
    tiltY: s.tiltY,
    twist: s.twist,
    dt: s.dt,
  }));
  if (controls.length === 1) {
    // Stationary tap/press: stamp the nib at full (untapered) width.
    const only = controls[0]!;
    const width = resolveUntaperedWidth(
      only.pressure,
      brush,
      0,
      only.twist,
      only.tiltX,
      only.tiltY,
    );
    const spine: TessellatedSpinePoint[] = [
      {
        x: only.x,
        y: only.y,
        tx: 1,
        ty: 0,
        width,
        pressure: only.pressure,
        tiltX: only.tiltX,
        tiltY: only.tiltY,
        twist: only.twist,
        dt: only.dt,
        extras: { ...faired[0]!.extras },
        controlArc: 0,
        segmentIndex: -1,
        u: 0,
      },
    ];
    const curve = fitCenterlineCurve(controls);
    const mesh = buildStrokeMesh(spine, brush.tip.cap ?? 'round');
    const nodes = spine.map(toNode);
    return {
      curve,
      mesh,
      nodes,
      polygon: mesh.ring,
      bounds: boundsOfPoints(mesh.ring),
    };
  }
  const { cumulative, total } = controlArcLengths(controls);
  const extraAt = (i: number): Record<string, unknown> | undefined =>
    faired[i]?.extras !== undefined ? { ...faired[i]!.extras } : undefined;
  const curve = fitCenterlineCurve(controls, extraAt, (controlIndex) =>
    hasSourceCornerEvidence(
      cornerSource,
      cornerSourceArc,
      controlIndex,
      spacing,
    ),
  );
  const spine = tessellateCurve(
    curve,
    brush,
    cumulative,
    total,
    options.tessellation,
    0,
    (i) => faired[i]?.extras,
  );
  const mesh = buildStrokeMesh(spine, brush.tip.cap ?? 'round');
  const nodes: InkStrokeNode[] = spine.map(toNode);
  return {
    curve,
    mesh,
    nodes,
    polygon: mesh.ring,
    bounds: boundsOfPoints(mesh.ring),
  };
}
