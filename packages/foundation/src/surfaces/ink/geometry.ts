/**
 * Stroke geometry compiler seam (continuous smooth-stroke architecture).
 *
 * This module is intentionally thin: the pipeline lives in focused
 * headless stages — `samples` (minimal sanitation), `resample` (true
 * arc-length working observations, NOT final anchors), `stabilization`
 * (continuous EMA + Laplacian fairing), `curve-attributes`
 * (pressure/width), `curve` (corner-aware APPROXIMATING clamped B-spline
 * trajectory estimation), `tessellation` (adaptive, error-bounded),
 * `outline` (curve-tangent variable-width mesh), `bounds`, and `compiler`
 * (authoritative commit path). Import stage modules directly when you need
 * stage behavior or incremental state; import here for the commit API and
 * shared geometry types.
 */

export {
  compileInkStroke,
  controlArcLengths,
  type CompiledInkStroke,
  type InkGeometryOptions,
  type InkStrokeNode,
} from './compiler.js';
export type { InkBrushSpec } from './brush.js';
export type {
  InkCurve,
  InkCurveControl,
  InkCurveSegment,
  InkInterpolatedAttributes,
} from './curve.js';
export type { InkStrokeMesh } from './outline.js';
export type { TessellatedSpinePoint } from './tessellation.js';
