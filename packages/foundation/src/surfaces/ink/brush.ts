/**
 * Froglight-owned brush contract (writing-experience upgrade, slices 2–3).
 *
 * Headless, DOM-free, and serializable by value: a resolved `InkBrushSpec`
 * is everything the stroke geometry compiler needs to reproduce a stroke's
 * appearance later. Canonical strokes keep semantic samples; the resolved
 * spec travels with the stroke (per-stroke `brush` member) so preset edits
 * never mutate old handwriting.
 */

/** Width used for strokes and items that omit one; renderers may differ. */
export const INK_DEFAULT_WIDTH = 3;
/** Extra hit tolerance beyond half the stroke width, surface units. */
export const INK_HIT_TOLERANCE = 2;

/** Stable brush identities, one tuned preset each (slice 3). */
export const INK_BRUSH_KINDS = [
  'ball',
  'fountain',
  'brush',
  'pencil',
  'highlighter',
] as const;

export type InkBrushKind = (typeof INK_BRUSH_KINDS)[number];

/** How raw pressure maps to width (all factors relative to `size`). */
export interface InkPressureResponse {
  readonly enabled: boolean;
  /** Width factor at zero pressure (≥ 0, the collapse floor). */
  readonly minFactor: number;
  /** Width factor at full pressure (≥ minFactor). */
  readonly maxFactor: number;
  /** Gamma applied to normalized pressure before the factor lerp (> 0). */
  readonly curve: number;
}

/**
 * Physical nib shape. `round` ignores direction; `flat`/`ellipse` modulate
 * width by travel direction against `angle` (stub-nib behavior: broad
 * across the edge, hairline along it). `aspect` is minor/major (1 = round,
 * 0 = sharp flat). The sample's barrel `twist` rotates the nib further.
 * `cap` selects the stroke-end rendering: `round` fans a semicircle past
 * the endpoint (pen-like), `butt` ends the ribbon flush at the endpoint
 * (marker-like). Absent means `round`.
 */
export interface InkBrushTip {
  readonly shape: 'round' | 'flat' | 'ellipse';
  /** Nib edge direction in radians (surface frame, clockwise-positive). */
  readonly angle?: number;
  /** Nib aspect ratio, 0–1 (default 1). */
  readonly aspect?: number;
  /** End-cap style: round (default) or butt. */
  readonly cap?: 'round' | 'butt';
}

export interface InkBrushSpec {
  readonly kind: InkBrushKind;
  readonly color: string;
  /** Base width in surface units (before pressure/taper). */
  readonly size: number;
  readonly opacity: number;
  readonly pressure: InkPressureResponse;
  /** 0 = raw input, 1 = heavily corrected line work. */
  readonly stabilization: number;
  /** 0 = faithful jitter, 1 = maximum curve fairing. */
  readonly streamline: number;
  /** Derive pressure from velocity when samples carry no pressure data. */
  readonly velocityPressure: boolean;
  /**
   * Vector tilt shading: fractional extra width at full tilt
   * (0 = upright pen unaffected). Pencil shading without raster texture.
   */
  readonly tiltEffect: number;
  /** Start/end taper strength (0–1), over up to eight nib widths. */
  readonly taperStart: number;
  readonly taperEnd: number;
  readonly tip: InkBrushTip;
}

/**
 * Ball pen: the default handwriting tool. Mostly constant thickness with
 * a very mild pressure response, round tip, low stabilization — direct,
 * responsive writing that never collapses under normal pressure.
 * Calibrated for the continuous smooth-stroke pipeline:
 * faithful at production grid spacing with C1-continuous rendering.
 */
export const BALL_PEN_BRUSH: InkBrushSpec = {
  kind: 'ball',
  color: '#202124',
  size: INK_DEFAULT_WIDTH,
  opacity: 1,
  pressure: { enabled: true, minFactor: 0.85, maxFactor: 1.1, curve: 1 },
  stabilization: 0.15,
  streamline: 0.2,
  velocityPressure: false,
  tiltEffect: 0,
  taperStart: 0,
  taperEnd: 0,
  tip: { shape: 'round' },
};

/**
 * Fountain pen: nonlinear pressure swell with a flat stub nib —
 * directional line variation, orientation-aware.
 */
export const FOUNTAIN_PEN_BRUSH: InkBrushSpec = {
  kind: 'fountain',
  color: '#202124',
  size: 3.5,
  opacity: 1,
  pressure: { enabled: true, minFactor: 0.55, maxFactor: 1.7, curve: 1.8 },
  stabilization: 0.25,
  streamline: 0.3,
  velocityPressure: false,
  tiltEffect: 0,
  taperStart: 0,
  taperEnd: 0,
  tip: { shape: 'flat', angle: 0, aspect: 0.35 },
};

/**
 * Brush pen: strong pressure response, velocity response, heavy smoothing —
 * expressive swelling strokes for controlled line work.
 */
export const BRUSH_PEN_BRUSH: InkBrushSpec = {
  kind: 'brush',
  color: '#202124',
  size: 5,
  opacity: 1,
  pressure: { enabled: true, minFactor: 0.35, maxFactor: 2.4, curve: 1.4 },
  stabilization: 0.45,
  streamline: 0.5,
  velocityPressure: true,
  tiltEffect: 0,
  taperStart: 0,
  taperEnd: 0,
  tip: { shape: 'round' },
};

/**
 * Pencil: pressure plus barrel-tilt side shading through an elliptical
 * nib (vector approximation; raster grain/texture is a later layer that
 * must not change sample semantics).
 */
export const PENCIL_BRUSH: InkBrushSpec = {
  kind: 'pencil',
  color: '#4a4a4a',
  size: 2.5,
  opacity: 1,
  pressure: { enabled: true, minFactor: 0.5, maxFactor: 1.5, curve: 1.2 },
  stabilization: 0.2,
  streamline: 0.25,
  velocityPressure: false,
  tiltEffect: 0.8,
  taperStart: 0,
  taperEnd: 0,
  tip: { shape: 'ellipse', angle: 0, aspect: 0.85 },
};

/**
 * Highlighter: constant wide translucent ribbon, independent of pen
 * pressure and pen color/size state. A round ribbon with butt caps
 *  gives the marker footprint — direction-independent
 * full width with flush square ends — instead of reusing ball-pen round
 * pressure geometry. Straight-line mode and overlap behavior unchanged.
 */
export const HIGHLIGHTER_BRUSH: InkBrushSpec = {
  kind: 'highlighter',
  color: '#ffd54f',
  size: 14,
  opacity: 0.35,
  pressure: { enabled: false, minFactor: 1, maxFactor: 1, curve: 1 },
  stabilization: 0.15,
  streamline: 0.2,
  velocityPressure: false,
  tiltEffect: 0,
  taperStart: 0,
  taperEnd: 0,
  tip: { shape: 'round', cap: 'butt' },
};

/** Tuned base per kind; presets resolve over these, never over globals. */
export const INK_BRUSH_PRESETS: Record<InkBrushKind, InkBrushSpec> = {
  ball: BALL_PEN_BRUSH,
  fountain: FOUNTAIN_PEN_BRUSH,
  brush: BRUSH_PEN_BRUSH,
  pencil: PENCIL_BRUSH,
  highlighter: HIGHLIGHTER_BRUSH,
};

/** Base spec for one kind (unknown kinds fall back to ball). */
export function brushPresetForKind(kind: InkBrushKind): InkBrushSpec {
  return INK_BRUSH_PRESETS[kind] ?? BALL_PEN_BRUSH;
}

/** Sparse caller overrides; nested pressure/tip patches are partial. */
export interface InkBrushOverrides {
  readonly kind?: InkBrushKind;
  readonly color?: string;
  readonly size?: number;
  readonly opacity?: number;
  readonly pressure?: Partial<InkPressureResponse>;
  readonly stabilization?: number;
  readonly streamline?: number;
  readonly velocityPressure?: boolean;
  readonly tiltEffect?: number;
  readonly taperStart?: number;
  readonly taperEnd?: number;
  readonly tip?: Partial<InkBrushTip>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve caller overrides over a base spec, clamping every range into
 * its documented bound so geometry always receives sane parameters.
 */
export function resolveBrushSpec(
  overrides: InkBrushOverrides,
  base: InkBrushSpec = BALL_PEN_BRUSH,
): InkBrushSpec {
  const kind =
    overrides.kind !== undefined && INK_BRUSH_KINDS.includes(overrides.kind)
      ? overrides.kind
      : base.kind;
  const color =
    typeof overrides.color === 'string' && overrides.color.trim() !== ''
      ? overrides.color
      : base.color;
  const size = finiteOr(overrides.size, base.size);
  const pressureBase = overrides.pressure ?? {};
  let minFactor = finiteOr(pressureBase.minFactor, base.pressure.minFactor);
  let maxFactor = finiteOr(pressureBase.maxFactor, base.pressure.maxFactor);
  minFactor = Math.max(minFactor, 0);
  maxFactor = Math.max(maxFactor, 0);
  if (minFactor > maxFactor) [minFactor, maxFactor] = [maxFactor, minFactor];
  const curve = finiteOr(pressureBase.curve, base.pressure.curve);
  const tipShape = overrides.tip?.shape;
  const aspect = finiteOr(overrides.tip?.aspect, base.tip.aspect ?? 1);
  const tipCap = overrides.tip?.cap;
  return {
    kind,
    color,
    size: size > 0 ? size : base.size,
    opacity: clamp(finiteOr(overrides.opacity, base.opacity), 0, 1),
    pressure: {
      enabled: pressureBase.enabled ?? base.pressure.enabled,
      minFactor,
      maxFactor,
      curve: curve > 0 ? curve : base.pressure.curve,
    },
    stabilization: clamp(
      finiteOr(overrides.stabilization, base.stabilization),
      0,
      1,
    ),
    streamline: clamp(finiteOr(overrides.streamline, base.streamline), 0, 1),
    velocityPressure: overrides.velocityPressure ?? base.velocityPressure,
    tiltEffect: clamp(finiteOr(overrides.tiltEffect, base.tiltEffect), 0, 1),
    taperStart: clamp(finiteOr(overrides.taperStart, base.taperStart), 0, 1),
    taperEnd: clamp(finiteOr(overrides.taperEnd, base.taperEnd), 0, 1),
    tip: {
      shape:
        tipShape === 'round' || tipShape === 'flat' || tipShape === 'ellipse'
          ? tipShape
          : base.tip.shape,
      ...(overrides.tip?.angle !== undefined &&
      Number.isFinite(overrides.tip.angle)
        ? { angle: overrides.tip.angle }
        : base.tip.angle !== undefined
          ? { angle: base.tip.angle }
          : {}),
      ...(overrides.tip?.aspect !== undefined || base.tip.aspect !== undefined
        ? { aspect: clamp(aspect, 0, 1) }
        : {}),
      ...(tipCap === 'round' || tipCap === 'butt'
        ? { cap: tipCap }
        : base.tip.cap !== undefined
          ? { cap: base.tip.cap }
          : {}),
    },
  };
}
