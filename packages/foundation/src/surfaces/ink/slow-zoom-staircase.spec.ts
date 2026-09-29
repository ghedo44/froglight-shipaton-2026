/**
 * Slow high-zoom quantized handwriting does not staircase.
 *
 * Physical reproduction: zoom to 8×, select the Ball Pen, draw a smooth
 * curve VERY slowly. The committed stroke must remain smooth — not
 * axis-aligned plateaus with angular transitions.
 *
 * Failure class: browser/WebView quantizes PointerEvent coordinates to the
 * CSS-pixel grid BEFORE `viewToSurface()`. At 8×, 1 CSS px = 0.125 surface
 * units. An interpolating fitter forced through every resampled control
 * preserves that quantization as visible stairs. The approximating
 * trajectory fitter must treat it as sampling noise.
 *
 * Geometric (never screenshot-only): Hausdorff vs the known ideal,
 * plateau dwell, curvature spikes.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import { diagnoseInkStroke } from './diagnostics.js';
import {
  idealArc,
  idealCircle,
  idealDiagonal,
  idealSCurve,
  slowQuantizedArc,
  transportQuantize,
} from './quantized-fixtures.js';
import type { Camera } from '../geometry.js';

function denseCenterline(
  samples: Parameters<typeof compileInkStroke>[0],
): { x: number; y: number }[] {
  const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
  const out: { x: number; y: number }[] = [];
  for (const segment of compiled.curve.segments) {
    for (let k = 0; k <= 12; k++) {
      out.push(segment.position(k / 12));
    }
  }
  return out;
}

function diagnoseForTest(samples: Parameters<typeof compileInkStroke>[0]) {
  return diagnoseInkStroke(samples, BALL_PEN_BRUSH);
}

function hausdorffToIdeal(
  fitted: readonly { x: number; y: number }[],
  ideal: readonly { x: number; y: number }[],
): number {
  let worst = 0;
  const step = Math.max(1, Math.floor(ideal.length / 400));
  for (const p of fitted) {
    let best = Infinity;
    for (let i = 0; i < ideal.length; i += step) {
      const q = ideal[i]!;
      best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** Fraction of fitted arc dwelling within 6° of an axis (plateau signature). */
function axisDwellFraction(
  points: readonly { x: number; y: number }[],
): number {
  let dwell = 0;
  let total = 0;
  const tol = (6 * Math.PI) / 180;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg < 1e-9) continue;
    total += seg;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    // Distance to nearest axis (0°, 90°, 180°, 270°).
    const norm = Math.atan2(Math.sin(2 * ang), Math.cos(2 * ang));
    const distToAxis = Math.min(
      Math.abs(norm),
      Math.abs(Math.abs(norm) - Math.PI / 2),
    );
    // Actually compute distance to 0/90: fold to [0, 90°).
    const folded = Math.abs(
      ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2),
    );
    const d = Math.min(folded, Math.PI / 2 - folded);
    if (d < tol) dwell += seg;
    void distToAxis;
  }
  return total > 0 ? dwell / total : 0;
}

describe('slow high-zoom quantized handwriting does not staircase', () => {
  it('fits the 8× quantized arc within the design-quality residual', () => {
    const { samples, ideal } = slowQuantizedArc(8);
    const fitted = denseCenterline(samples);
    expect(fitted.length).toBeGreaterThan(10);
    // Old interpolating behavior sits ~0.32 surface units (≈2.5 screen px
    // at 8×) off the ideal — visibly stepped. The approximating fitter
    // must halve that residual.
    expect(hausdorffToIdeal(fitted, ideal)).toBeLessThan(0.2);
  });

  it('does not dwell on axis-aligned plateaus at 8×', () => {
    const { samples } = slowQuantizedArc(8);
    const fitted = denseCenterline(samples);
    // A quarter-circle sweeps 90° uniformly: ~13% of arc naturally lies
    // within 6° of an axis. Staircased fits dwell far longer on flats.
    expect(axisDwellFraction(fitted)).toBeLessThan(0.22);
  });

  it('converges across zoom levels (zoom reveals, never alters)', () => {
    // Same canonical samples compile identically regardless of camera: the
    // compiler never reads zoom/pan/DPR. Different quantizations (different
    // canonical inputs) each stay close to the shared ideal, tighter as
    // the transport grid refines.
    const { samples } = slowQuantizedArc(8);
    const first = compileInkStroke(samples, BALL_PEN_BRUSH);
    const second = compileInkStroke(samples, BALL_PEN_BRUSH);
    expect(second.polygon).toEqual(first.polygon);
    const budgets: Record<number, number> = { 1: 0.7, 2: 0.45, 4: 0.3, 8: 0.2 };
    for (const zoom of [1, 2, 4, 8] as const) {
      const { samples: quantized, ideal } = slowQuantizedArc(zoom);
      const fitted = denseCenterline(quantized);
      expect(hausdorffToIdeal(fitted, ideal)).toBeLessThan(budgets[zoom]!);
    }
  });

  it('keeps slow quantized circles round and diagonals diagonal', () => {
    const camera: Camera = { x: 80, y: 80, zoom: 8 };
    const circle = transportQuantize(idealCircle(), camera);
    const circleFitted = denseCenterline(circle);
    // Roundness: radius variation around the fitted centroid stays tight.
    const cx = circleFitted.reduce((s, p) => s + p.x, 0) / circleFitted.length;
    const cy = circleFitted.reduce((s, p) => s + p.y, 0) / circleFitted.length;
    const radii = circleFitted.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    const maxDev = Math.max(...radii.map((r) => Math.abs(r - mean)));
    expect(maxDev).toBeLessThan(1.2);

    const diagonal = transportQuantize(idealDiagonal(), camera);
    const diagFitted = denseCenterline(diagonal);
    // Diagonal linearity: max deviation from the endpoint chord stays small.
    const a = diagFitted[0]!;
    const b = diagFitted[diagFitted.length - 1]!;
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    let worst = 0;
    for (const p of diagFitted) {
      const dist =
        chord > 1e-9
          ? Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) /
            chord
          : Math.hypot(p.x - a.x, p.y - a.y);
      worst = Math.max(worst, dist);
    }
    expect(worst).toBeLessThan(0.6);
  });

  it('preserves both curvature directions on a slow quantized S-curve', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 8 };
    const samples = transportQuantize(idealSCurve(), camera);
    const fitted = denseCenterline(samples);
    // Signed curvature must visit both signs with meaningful magnitude.
    let maxPos = 0;
    let maxNeg = 0;
    for (let i = 2; i < fitted.length; i++) {
      const a = fitted[i - 2]!;
      const b = fitted[i - 1]!;
      const c = fitted[i]!;
      const l0 = Math.hypot(b.x - a.x, b.y - a.y);
      const l1 = Math.hypot(c.x - b.x, c.y - b.y);
      if (l0 < 1e-9 || l1 < 1e-9) continue;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const curvature = cross / (l0 * l1 * ((l0 + l1) / 2));
      if (curvature > maxPos) maxPos = curvature;
      if (curvature < maxNeg) maxNeg = curvature;
    }
    expect(maxPos).toBeGreaterThan(0.005);
    expect(maxNeg).toBeLessThan(-0.005);
  });

  it('treats tiny staircase motion as noise on a near-straight slow run', () => {
    // Slow near-horizontal drift quantized at 8×: many events share Y.
    const camera: Camera = { x: 0, y: 0, zoom: 8 };
    const ideal = idealArc(300, 200, { x: 0, y: 0 }, 0.15);
    const samples = transportQuantize(ideal, camera);
    // Sanity: the fixture really does contain slow quantized repeats.
    let repeats = 0;
    for (let i = 1; i < samples.length; i++) {
      if (
        samples[i]!.x === samples[i - 1]!.x ||
        samples[i]!.y === samples[i - 1]!.y
      ) {
        repeats++;
      }
    }
    expect(repeats).toBeGreaterThan(20);
    const fitted = denseCenterline(samples);
    expect(hausdorffToIdeal(fitted, ideal)).toBeLessThan(0.25);
  });

  it('does not force the centerline through every noisy observation (approximating)', () => {
    // Structural gate for the fix: resampled controls are working
    // observations, not mandatory knots. An interpolating fitter sits
    // exactly on every interior control (distance 0); the approximating
    // trajectory estimator must deviate slightly (noise treated as noise)
    // while staying bounded (no mush).
    const { samples } = slowQuantizedArc(8);
    const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
    const diag = diagnoseForTest(samples);
    // Interior resampled controls (excluding endpoints and detected
    // corners, which interpolate exactly).
    const interior = diag.resampled.slice(2, -2);
    expect(interior.length).toBeGreaterThan(5);
    let maxDev = 0;
    for (const c of interior) {
      let best = Infinity;
      for (const seg of compiled.curve.segments) {
        for (let k = 0; k <= 8; k++) {
          const p = seg.position(k / 8);
          best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y));
        }
      }
      maxDev = Math.max(maxDev, best);
    }
    // Approximating: interior controls stand off the fitted curve…
    expect(maxDev).toBeGreaterThan(0.02);
    // …but bounded (no over-smoothing into mush).
    expect(maxDev).toBeLessThan(0.6);
    // Endpoints still interpolate exactly.
    const first = compiled.curve.segments[0]!.position(0);
    const lastSeg =
      compiled.curve.segments[compiled.curve.segments.length - 1]!;
    const last = lastSeg.position(1);
    expect(
      Math.hypot(first.x - diag.faired[0]!.x, first.y - diag.faired[0]!.y),
    ).toBeLessThan(1e-6);
    expect(
      Math.hypot(
        last.x - diag.faired[diag.faired.length - 1]!.x,
        last.y - diag.faired[diag.faired.length - 1]!.y,
      ),
    ).toBeLessThan(1e-6);
  });
});
