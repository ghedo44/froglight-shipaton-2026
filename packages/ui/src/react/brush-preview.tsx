/**
 * Reusable brush preview renderer.
 *
 * Reuses the real brush spec (`brushPresetForKind` + `resolveBrushSpec`)
 * for semantic fidelity — previews distinguish Ball/Fountain/Brush/Pencil/
 * Highlighter plus widths, colors, opacity, pressure profiles, tilt/taper,
 * tip shape/angle/aspect, and cap style —
 * but renders a tiny precomputed SVG ribbon instead of running the full
 * stroke compiler per card. Cheap by construction: pure geometry cached by
 * a stable key, memoized React component, no pointer listeners, no
 * rerender on pointer move.
 *
 * Cache keys cover only visually relevant parameters (kind, color, size,
 * opacity, pressure, tilt, taper, tip shape/angle/aspect/cap).
 * Non-visual tuning (stabilization,
 * streamline, velocity pressure, gestures) does not invalidate previews.
 */

import { memo, useMemo } from 'react';
import {
  brushPresetForKind,
  resolveBrushSpec,
  type InkBrushKind,
  type InkBrushOverrides,
  type SavedStylePresetData,
} from '@froglight/foundation';
import styles from './brush-preview.module.css';

export interface BrushPreviewInput {
  /** Preset tool id (`pen`/`fountain`/`brush`/`pencil`/`highlighter`). */
  readonly toolKind: string;
  readonly preset: SavedStylePresetData;
}

const TOOL_TO_BRUSH: Record<string, InkBrushKind> = {
  pen: 'ball',
  fountain: 'fountain',
  brush: 'brush',
  pencil: 'pencil',
  highlighter: 'highlighter',
};

function brushKindForTool(toolKind: string): InkBrushKind {
  return TOOL_TO_BRUSH[toolKind] ?? 'ball';
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isBrushKind(value: unknown): value is InkBrushKind {
  return (
    value === 'ball' ||
    value === 'fountain' ||
    value === 'brush' ||
    value === 'pencil' ||
    value === 'highlighter'
  );
}

function asTipShape(
  value: unknown,
): 'round' | 'flat' | 'ellipse' | undefined {
  return value === 'round' || value === 'flat' || value === 'ellipse'
    ? value
    : undefined;
}

function asCap(value: unknown): 'round' | 'butt' | undefined {
  return value === 'round' || value === 'butt' ? value : undefined;
}

function finiteSize(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Flatten one card preset to real `InkBrushOverrides` (flat, no wrapper).
 *
 * `InkToolPreset` stores top-level `color`/`size`/`opacity` plus nested
 * `brush` tuning; `resolveBrushSpec` takes them flat. Top-level wins for
 * color/size/opacity (record width stays canonical; stored `brush.size`
 * is preserved but ignored downstream), nested tuning spreads through.
 */
function toBrushOverrides(
  preset: SavedStylePresetData,
): InkBrushOverrides {
  const brush = preset.brush;
  const brushKind = brush?.kind;
  const brushColor = brush?.color;
  const brushSize = brush?.size;
  const brushOpacity = brush?.opacity;
  const stabilization = finiteNumber(brush?.stabilization);
  const streamline = finiteNumber(brush?.streamline);
  const tiltEffect = finiteNumber(brush?.tiltEffect);
  const taperStart = finiteNumber(brush?.taperStart);
  const taperEnd = finiteNumber(brush?.taperEnd);
  const velocityPressure = brush?.velocityPressure;
  const pressure = brush?.pressure;
  const tip = brush?.tip;
  const tipShape = asTipShape(tip?.shape);
  const tipAngle = finiteNumber(tip?.angle);
  const tipAspect = finiteNumber(tip?.aspect);
  const tipCap = asCap(tip?.cap);
  const topColor = nonEmptyString(preset.color);
  const nestedColor = nonEmptyString(brushColor);
  const topSize = finiteSize(preset.size);
  const nestedSize = finiteSize(brushSize);
  const topOpacity = finiteNumber(preset.opacity);
  const nestedOpacity = finiteNumber(brushOpacity);
  return {
    ...(brushKind !== undefined && isBrushKind(brushKind)
      ? { kind: brushKind }
      : {}),
    ...(topColor !== undefined
      ? { color: topColor }
      : nestedColor !== undefined
        ? { color: nestedColor }
        : {}),
    ...(topSize !== undefined
      ? { size: topSize }
      : nestedSize !== undefined
        ? { size: nestedSize }
        : {}),
    ...(topOpacity !== undefined
      ? { opacity: topOpacity }
      : nestedOpacity !== undefined
        ? { opacity: nestedOpacity }
        : {}),
    ...(pressure !== undefined
      ? {
          pressure: {
            ...(typeof pressure.enabled === 'boolean'
              ? { enabled: pressure.enabled }
              : {}),
            ...(finiteNumber(pressure.minFactor) !== undefined
              ? { minFactor: pressure.minFactor }
              : {}),
            ...(finiteNumber(pressure.maxFactor) !== undefined
              ? { maxFactor: pressure.maxFactor }
              : {}),
            ...(finiteNumber(pressure.curve) !== undefined
              ? { curve: pressure.curve }
              : {}),
          },
        }
      : {}),
    ...(stabilization !== undefined ? { stabilization } : {}),
    ...(streamline !== undefined ? { streamline } : {}),
    ...(typeof velocityPressure === 'boolean' ? { velocityPressure } : {}),
    ...(tiltEffect !== undefined ? { tiltEffect } : {}),
    ...(taperStart !== undefined ? { taperStart } : {}),
    ...(taperEnd !== undefined ? { taperEnd } : {}),
    ...(tip !== undefined
      ? {
          tip: {
            ...(tipShape !== undefined ? { shape: tipShape } : {}),
            ...(tipAngle !== undefined ? { angle: tipAngle } : {}),
            ...(tipAspect !== undefined ? { aspect: tipAspect } : {}),
            ...(tipCap !== undefined ? { cap: tipCap } : {}),
          },
        }
      : {}),
  };
}

/**
 * Stable cache key for one brush preview.
 *
 * Derived from the *resolved* visual spec (`toBrushOverrides` +
 * `resolveBrushSpec`), not from raw top-level fields: top-level
 * color/size/opacity win over nested `brush.*`, but nested values still
 * resolve when the top level is absent, so the key must reflect the same
 * resolution the renderer uses. Covers only visually relevant parameters
 * (kind, color, size, opacity, pressure, tilt, taper, tip shape/angle/
 * aspect/cap). Non-visual tuning (stabilization, streamline, velocity
 * pressure) never invalidates. Returns a JSON string with rounded numbers
 * so float churn never invalidates the cache.
 */
export function brushPreviewCacheKey(input: BrushPreviewInput): string {
  const fallbackKind = brushKindForTool(input.toolKind);
  const base = brushPresetForKind(fallbackKind);
  const spec = resolveBrushSpec(toBrushOverrides(input.preset), base);
  const key = {
    k: spec.kind,
    c: spec.color,
    s: round3(spec.size),
    o: round3(spec.opacity),
    pe: spec.pressure.enabled,
    pmin: round3(spec.pressure.minFactor),
    pmax: round3(spec.pressure.maxFactor),
    pc: round3(spec.pressure.curve),
    tilt: round3(spec.tiltEffect),
    ts: round3(spec.taperStart),
    te: round3(spec.taperEnd),
    tip: spec.tip.shape,
    angle: round3(spec.tip.angle ?? 0),
    aspect: round3(spec.tip.aspect ?? 1),
    cap: spec.tip.cap ?? 'round',
  };
  return JSON.stringify(key);
}

export interface BrushPreviewGeometry {
  /** Stable key this geometry was computed for. */
  readonly key: string;
  /** Filled ribbon path (`d`) for the preview stroke. */
  readonly d: string;
  /** Resolved display color. */
  readonly color: string;
  /** Resolved display opacity. */
  readonly opacity: number;
  /** End-cap style (round vs butt/square). */
  readonly cap: 'round' | 'butt';
  /** Whether the nib is non-round (flat/ellipse hint). */
  readonly flatNib: boolean;
}

const geometryCache = new Map<string, BrushPreviewGeometry>();

function pressureWidth(
  t: number,
  enabled: boolean,
  min: number,
  max: number,
  curve: number,
): number {
  if (!enabled) return 1;
  const p = Math.sin(Math.PI * Math.min(Math.max(t, 0), 1));
  const shaped = Math.pow(Math.max(p, 0), Math.max(curve, 0.01));
  return min + (max - min) * shaped;
}

function taperFactor(t: number, start: number, end: number): number {
  let factor = 1;
  if (start > 0 && t < start) {
    const u = start <= 0 ? 1 : t / start;
    factor *= 0.35 + 0.65 * Math.max(u, 0);
  }
  if (end > 0 && t > 1 - end) {
    const u = end <= 0 ? 1 : (1 - t) / end;
    factor *= 0.35 + 0.65 * Math.max(u, 0);
  }
  return factor;
}

/**
 * Cheap stub-nib response mirroring `nibMultiplier` (curve-attributes):
 * broad across the nib edge, floored hairline along it. Round nibs ignore
 * direction; flat/ellipse modulate by travel direction against the nib
 * angle. Floor (0.15) matches the compiler so shaped nibs never vanish.
 */
function nibPreviewFactor(
  travelAngle: number,
  tipAngle: number,
  aspect: number,
): number {
  const clamped = Math.min(Math.max(aspect, 0), 1);
  const rel = travelAngle - tipAngle;
  const s = Math.sin(rel);
  const c = Math.cos(rel);
  return Math.max(
    Math.sqrt(s * s + clamped * clamped * c * c),
    0.15,
  );
}

/**
 * Pure preview geometry for one resolved brush (deterministic, no DOM).
 * Cached by `brushPreviewCacheKey`: identical inputs return the identical
 * object without recomputation. No pixel snapshots — callers assert on
 * `d`/`color`/`opacity`/`cap` semantics.
 */
export function getBrushPreviewGeometry(
  input: BrushPreviewInput,
): BrushPreviewGeometry {
  const key = brushPreviewCacheKey(input);
  const cached = geometryCache.get(key);
  if (cached !== undefined) return cached;
  const fallbackKind = brushKindForTool(input.toolKind);
  const base = brushPresetForKind(fallbackKind);
  const overrides = toBrushOverrides(input.preset);
  const spec = resolveBrushSpec(overrides, base);
  // Centerline: gentle S-curve shared by all families so width/opacity/cap
  // carry the family distinction (isolates the variable under test).
  const steps = 24;
  const top: Array<[number, number]> = [];
  const bottom: Array<[number, number]> = [];
  const centers: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = 8 + 104 * t;
    const y = 18 + 7 * Math.sin(t * Math.PI * 1.1 - 0.35);
    // Derivative for the normal (finite difference on the analytic curve).
    const e = 0.001;
    const yAhead = 18 + 7 * Math.sin((t + e) * Math.PI * 1.1 - 0.35);
    const yBehind = 18 + 7 * Math.sin((t - e) * Math.PI * 1.1 - 0.35);
    const dx = 104 * 2 * e;
    const dy = yAhead - yBehind;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const travelAngle = Math.atan2(dy, dx);
    const pressure = pressureWidth(
      t,
      spec.pressure.enabled,
      spec.pressure.minFactor,
      spec.pressure.maxFactor,
      spec.pressure.curve,
    );
    const taper = taperFactor(t, spec.taperStart, spec.taperEnd);
    let width = spec.size * pressure * taper;
    // Tip shape modulates the ribbon directionally (stub-nib behavior):
    // flat/ellipse nibs read broad across the nib edge and hairline along
    // it; round stays full. Aspect scales the effect, angle rotates it.
    if (spec.tip.shape !== 'round') {
      width *= nibPreviewFactor(
        travelAngle,
        spec.tip.angle ?? 0,
        spec.tip.aspect ?? 1,
      );
    }
    // Tilt shading widens the mid-stroke for pencil-like nibs.
    if (spec.tiltEffect > 0) {
      width *= 1 + spec.tiltEffect * 0.35 * Math.sin(Math.PI * t);
    }
    // Clamp to the preview box; highlighter stays wide, pencil stays thin.
    const half = Math.max(Math.min(width, 26) * 0.55, 0.4);
    top.push([x + nx * half, y + ny * half]);
    bottom.push([x - nx * half, y - ny * half]);
    centers.push([x, y]);
  }
  const cap = spec.tip.cap ?? 'round';
  // Round caps extend past the endpoints by the nib radius (mirror
  // outline.ts: round fans past the endpoint, butt ends flush marker-like).
  // Butt keeps the ribbon flush; round shifts both end edges outward along
  // the centerline tangent by the end half-width, so `d` differs by cap.
  if (cap === 'round') {
    const firstCenter = centers[0]!;
    const secondCenter = centers[1]!;
    const beforeLast = centers[centers.length - 2]!;
    const lastCenter = centers[centers.length - 1]!;
    const startDx = firstCenter[0] - secondCenter[0];
    const startDy = firstCenter[1] - secondCenter[1];
    const endDx = lastCenter[0] - beforeLast[0];
    const endDy = lastCenter[1] - beforeLast[1];
    const startLen = Math.hypot(startDx, startDy) || 1;
    const endLen = Math.hypot(endDx, endDy) || 1;
    const startHalf = Math.hypot(
      top[0]![0] - firstCenter[0],
      top[0]![1] - firstCenter[1],
    );
    const endHalf = Math.hypot(
      top[top.length - 1]![0] - lastCenter[0],
      top[top.length - 1]![1] - lastCenter[1],
    );
    const sx = startDx / startLen;
    const sy = startDy / startLen;
    const ex = endDx / endLen;
    const ey = endDy / endLen;
    top[0] = [top[0]![0] + sx * startHalf, top[0]![1] + sy * startHalf];
    bottom[0] = [
      bottom[0]![0] + sx * startHalf,
      bottom[0]![1] + sy * startHalf,
    ];
    const last = top.length - 1;
    top[last] = [top[last]![0] + ex * endHalf, top[last]![1] + ey * endHalf];
    bottom[last] = [
      bottom[last]![0] + ex * endHalf,
      bottom[last]![1] + ey * endHalf,
    ];
  }
  let d = `M ${top[0]![0].toFixed(2)} ${top[0]![1].toFixed(2)}`;
  for (let i = 1; i < top.length; i++) d += ` L ${top[i]![0].toFixed(2)} ${top[i]![1].toFixed(2)}`;
  for (let i = bottom.length - 1; i >= 0; i--)
    d += ` L ${bottom[i]![0].toFixed(2)} ${bottom[i]![1].toFixed(2)}`;
  d += ' Z';
  const geometry: BrushPreviewGeometry = {
    key,
    d,
    color: spec.color,
    opacity: spec.opacity,
    cap,
    flatNib: spec.tip.shape !== 'round',
  };
  geometryCache.set(key, geometry);
  // Bound the cache: previews are per-style, styles are user-bounded.
  if (geometryCache.size > 500) {
    const oldest = geometryCache.keys().next().value;
    if (oldest !== undefined) geometryCache.delete(oldest);
  }
  return geometry;
}

/** Clear the module preview cache (tests only). */
export function clearBrushPreviewCacheForTests(): void {
  geometryCache.clear();
}

export interface BrushPreviewProps extends BrushPreviewInput {
  /** Accessible title (tooltip). Decorative by default (`aria-hidden`). */
  readonly title?: string;
  readonly className?: string;
}

/**
 * Memoized SVG brush preview.
 *
 * Renders the cached ribbon for one preset; re-renders only when the
 * stable cache key changes (never on pointer move — no listeners at all).
 * Decorative (`aria-hidden`) when nested in a labelled card; pass `title`
 * for a standalone labelled preview.
 */
export const BrushPreview = memo(function BrushPreview(
  props: BrushPreviewProps,
): React.ReactElement {
  const { toolKind, preset, title, className } = props;
  // Stable key memo: recompute only when visual params change (never on
  // pointer move — this component has no pointer listeners at all).
  const cacheKey = brushPreviewCacheKey({ toolKind, preset });
  const geometry = useMemo(
    () => getBrushPreviewGeometry({ toolKind, preset }),
    [cacheKey],
  );
  return (
    <svg
      viewBox="0 0 120 36"
      className={[styles['fl-brush-preview'], className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
      aria-label={title}
      focusable="false"
      data-brush-preview={geometry.key}
      data-brush-cap={geometry.cap}
    >
      {title !== undefined ? <title>{title}</title> : null}
      <path
        d={geometry.d}
        fill={geometry.color}
        fillOpacity={geometry.opacity}
        stroke="none"
      />
    </svg>
  );
});
