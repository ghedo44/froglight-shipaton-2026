/**
 * Deterministic quantized slow-writing fixtures for the high-zoom
 * staircase regression.
 *
 * Physical failure class:
 *
 * ```text
 * ideal smooth trajectory (surface units)
 *   ↓  surfaceToView at high zoom (×8)
 *   ↓  CSS-pixel quantization (browser/WebView reports integers)
 *   ↓  viewToSurface back to canonical surface units
 *   ↓  Froglight compiler
 * ```
 *
 * Feeding already-perfect floating-point surface coordinates cannot
 * reproduce the defect — the staircase enters when `PointerEvent`
 * coordinates are quantized BEFORE `viewToSurface()`. These fixtures
 * emulate that transport faithfully and deterministically (no randomness,
 * no DOM).
 *
 * Zoom-independent canonical rule: the same ideal trajectory compiled at
 * 1×/2×/4×/8× must converge to the same smooth centerline within a small
 * geometric tolerance. Zoom reveals quality; it never alters canonical
 * geometry (the compiler never reads the camera).
 */

import type { Camera } from '../geometry.js';
import { surfaceToView, viewToSurface } from '../geometry.js';
import type { InkSample } from '../model.js';

/** Quantize a view coordinate to the CSS-pixel grid (browser transport). */
export function quantizeView(value: number, step = 1): number {
  return Math.round(value / step) * step;
}

/**
 * Push an ideal surface trajectory through simulated browser transport:
 * surface → view at `zoom` → pixel quantization → back to surface.
 * Returns canonical `InkSample`s as Froglight capture would store them.
 */
export function transportQuantize(
  ideal: readonly { x: number; y: number; pressure?: number; dt?: number }[],
  camera: Camera,
  step = 1,
): InkSample[] {
  return ideal.map((p, i) => {
    const view = surfaceToView(camera, { x: p.x, y: p.y });
    const qv = { x: quantizeView(view.x, step), y: quantizeView(view.y, step) };
    const surface = viewToSurface(camera, qv);
    return {
      x: surface.x,
      y: surface.y,
      ...(p.pressure !== undefined ? { pressure: p.pressure } : {}),
      ...(p.dt !== undefined ? { dt: p.dt } : {}),
      ...{ __idealIndex: i },
    } as unknown as InkSample;
  });
}

/** Ideal smooth arc (quarter circle) sampled densely in time (slow pen). */
export function idealArc(
  count = 400,
  radius = 40,
  center = { x: 100, y: 100 },
  span = Math.PI / 2,
): { x: number; y: number; pressure: number; dt: number }[] {
  const out: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const angle = t * span;
    out.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      pressure: 0.55,
      dt: i * 8,
    });
  }
  return out;
}

/** Ideal slow circle (roundness gate). */
export function idealCircle(
  count = 480,
  radius = 30,
  center = { x: 100, y: 100 },
): { x: number; y: number; pressure: number; dt: number }[] {
  const out: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const angle = t * Math.PI * 2;
    out.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      pressure: 0.55,
      dt: i * 6,
    });
  }
  return out;
}

/** Ideal slow S-curve (both curvature directions must survive). */
export function idealSCurve(
  count = 400,
): { x: number; y: number; pressure: number; dt: number }[] {
  const out: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push({
      x: t * 120,
      y: 40 + Math.sin(t * Math.PI * 2) * 22,
      pressure: 0.55,
      dt: i * 8,
    });
  }
  return out;
}

/** Ideal slow diagonal (must not become axis-aligned steps). */
export function idealDiagonal(
  count = 400,
): { x: number; y: number; pressure: number; dt: number }[] {
  const out: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push({
      x: t * 120,
      y: t * 90,
      pressure: 0.55,
      dt: i * 8,
    });
  }
  return out;
}

/**
 * Slow high-zoom quantized handwriting fixture at one zoom level.
 * Default camera looks at the trajectory start; zoom drives the
 * quantization severity (1 CSS px = 1/zoom surface units).
 */
export function slowQuantizedArc(
  zoom: number,
  step = 1,
  count = 400,
): { samples: InkSample[]; ideal: { x: number; y: number }[] } {
  const ideal = idealArc(count);
  const camera: Camera = { x: 80, y: 80, zoom };
  const samples = transportQuantize(ideal, camera, step);
  return { samples, ideal };
}

/** All required zoom variants (1×/2×/4×/8×). */
export function slowQuantizedZoomSuite(
  step = 1,
): { zoom: number; samples: InkSample[]; ideal: { x: number; y: number }[] }[] {
  return [1, 2, 4, 8].map((zoom) => ({
    zoom,
    ...slowQuantizedArc(zoom, step),
  }));
}
