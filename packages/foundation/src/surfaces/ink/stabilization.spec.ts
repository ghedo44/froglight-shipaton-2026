/**
 * Stabilization/streamline continuity gates: nearby settings must produce
 * nearby geometry, with no threshold-based quality jumps. Both controls
 * are continuous by construction (affine EMA weight, fixed-pass Laplacian
 * blend); these tests pin the behavior so a future threshold can never
 * sneak back in.
 */

import { describe, expect, it } from 'vitest';
import { compileInkStroke } from './compiler.js';
import { sanitizeSamples } from './samples.js';
import { stabilizePositions } from './stabilization.js';
import { resolveBrushSpec } from './brush.js';
import { sharpCorner } from './fixtures.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

const TUNED = (overrides: Parameters<typeof resolveBrushSpec>[0] = {}) =>
  resolveBrushSpec({
    stabilization: 0,
    streamline: 0,
    taperStart: 0,
    taperEnd: 0,
    ...overrides,
  });

function distToRing(p: Point, ring: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.min(Math.max(t, 0), 1);
    best = Math.min(
      best,
      Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)),
    );
  }
  return best;
}

/** Edge-based Hausdorff distance between outline rings (immune to
 *  tessellation vertex placement: measures geometry, not sampling). */
function hausdorff(a: readonly Point[], b: readonly Point[]): number {
  let worst = 0;
  for (const p of a) worst = Math.max(worst, distToRing(p, b));
  for (const p of b) worst = Math.max(worst, distToRing(p, a));
  return worst;
}

const NOISY: InkSample[] = Array.from({ length: 41 }, (_, i) => ({
  x: i * 5,
  y: i % 2 === 0 ? 3 : -3,
  pressure: 0.5,
}));

describe('stabilization continuity', () => {
  it('applies no correction at zero (unit: exact passthrough)', () => {
    const out = stabilizePositions(sanitizeSamples(NOISY, 0.25), 0);
    const input = sanitizeSamples(NOISY, 0.25);
    expect(out).toEqual(input);
    // …and returns copies, never aliases.
    expect(out[0]).not.toBe(input[0]);
  });

  it('anchors endpoints exactly at zero through the full pipeline', () => {
    const geometry = compileInkStroke(NOISY, TUNED(), { spacing: 10 });
    expect(geometry.nodes[0]).toMatchObject({ x: 0, y: 3 });
    const lastInput = NOISY[NOISY.length - 1]!;
    const lastNode = geometry.nodes[geometry.nodes.length - 1]!;
    expect(lastNode.x).toBeCloseTo(lastInput.x, 9);
    expect(lastNode.y).toBeCloseTo(lastInput.y, 9);
  });

  it('produces nearby geometry for nearby settings (no jumps)', () => {
    const rings: Point[][] = [];
    const steps = 21;
    for (let k = 0; k < steps; k++) {
      const brush = TUNED({ stabilization: k / (steps - 1) });
      rings.push([...compileInkStroke(NOISY, brush, { spacing: 10 }).polygon]);
    }
    let worstAdjacent = 0;
    for (let k = 1; k < rings.length; k++) {
      worstAdjacent = Math.max(
        worstAdjacent,
        hausdorff(rings[k - 1]!, rings[k]!),
      );
    }
    const total = hausdorff(rings[0]!, rings[rings.length - 1]!);
    // No single 0.05 step may jump more than a third of the total travel:
    // a threshold-based pass switch would concentrate the change in one
    // step near its boundary.
    expect(worstAdjacent).toBeLessThan(total / 3 + 1e-9);
    expect(total).toBeGreaterThan(0.5);
  });

  it('dampens sensor-scale jitter without startup lag', () => {
    // Dense sub-unit device noise: the first sample anchors exactly at
    // the pen, and high stabilization flattens the jitter band.
    const jitter: InkSample[] = Array.from({ length: 81 }, (_, i) => ({
      x: i * 1.2,
      y: i % 2 === 0 ? 0.4 : -0.4,
      pressure: 0.5,
    }));
    const brush = TUNED({ stabilization: 0.9 });
    const geometry = compileInkStroke(jitter, brush, { spacing: 2 });
    expect(geometry.nodes[0]).toMatchObject({ x: 0, y: 0.4 });
    const rest = geometry.nodes.slice(2);
    const peak = Math.max(...rest.map((n) => Math.abs(n.y)));
    expect(peak).toBeLessThan(0.35);
  });

  it('treats signal-scale wobble as intent at low settings, damped at high', () => {
    // ±3-unit wobble at ~6-unit spacing is handwriting-scale motion, not
    // sensor noise: low stabilization preserves it, high stabilization
    // progressively rounds it. (A 10-unit resample grid aliases the
    // 11.6-unit zigzag wavelength, so the high setting damps the aliased
    // wander rather than erasing it exactly — documented DSP tradeoff.)
    const low = compileInkStroke(NOISY, TUNED({ stabilization: 0.1 }), {
      spacing: 10,
    });
    const lowPeak = Math.max(...low.nodes.slice(2).map((n) => Math.abs(n.y)));
    expect(lowPeak).toBeGreaterThan(2);
    const high = compileInkStroke(NOISY, TUNED({ stabilization: 0.9 }), {
      spacing: 10,
    });
    const highPeak = Math.max(...high.nodes.slice(2).map((n) => Math.abs(n.y)));
    expect(highPeak).toBeLessThan(lowPeak);
    expect(highPeak).toBeLessThan(2.5);
  });
});

describe('streamline continuity', () => {
  it('preserves endpoints exactly at zero stabilization, with bounded tip lag otherwise', () => {
    for (const streamline of [0, 0.25, 0.5, 0.75, 1]) {
      const geometry = compileInkStroke(sharpCorner(), TUNED({ streamline }), {
        spacing: 5,
      });
      expect(geometry.nodes[0]).toMatchObject({ x: 0, y: 0 });
      const last = geometry.nodes[geometry.nodes.length - 1]!;
      expect(last.x).toBeCloseTo(100, 6);
      expect(last.y).toBeCloseTo(100, 6);
    }
    // Forward EMA cannot see the future: the tip lags within a fraction
    // of one resample step at default handwriting stabilization.
    const lagged = compileInkStroke(
      sharpCorner(),
      TUNED({ stabilization: 0.15, streamline: 0 }),
      { spacing: 5 },
    );
    const last = lagged.nodes[lagged.nodes.length - 1]!;
    expect(Math.hypot(last.x - 100, last.y - 100)).toBeLessThan(1.5);
  });

  it('rounds the corner progressively with no discrete pass switch', () => {
    // Distance from the corner vertex to the nearest spine node grows
    // monotonically and without jumps as streamline increases.
    const corner = { x: 100, y: 0 };
    const cuts: number[] = [];
    const steps = 11;
    for (let k = 0; k < steps; k++) {
      const geometry = compileInkStroke(
        sharpCorner(),
        TUNED({ streamline: k / (steps - 1) }),
        { spacing: 5 },
      );
      let nearest = Infinity;
      for (const n of geometry.nodes) {
        nearest = Math.min(nearest, Math.hypot(n.x - corner.x, n.y - corner.y));
      }
      cuts.push(nearest);
    }
    expect(cuts[0]).toBeLessThan(0.6);
    for (let k = 1; k < cuts.length; k++) {
      // Monotone (up to tessellation sampling noise) and jump-free: no
      // step exceeds the total travel.
      expect(cuts[k]! - cuts[k - 1]!).toBeLessThan(
        cuts[steps - 1]! - cuts[0]! + 0.6,
      );
    }
    // Full streamline visibly rounds an untreated sharp corner.
    expect(cuts[steps - 1]!).toBeGreaterThan(cuts[0]! + 0.5);
  });

  it('keeps nearby streamline values near each other on curves', () => {
    const rings: Point[][] = [];
    const steps = 11;
    for (let k = 0; k < steps; k++) {
      rings.push([
        ...compileInkStroke(
          sharpCorner(),
          TUNED({ streamline: k / (steps - 1) }),
          {
            spacing: 5,
          },
        ).polygon,
      ]);
    }
    let worstAdjacent = 0;
    for (let k = 1; k < rings.length; k++) {
      worstAdjacent = Math.max(
        worstAdjacent,
        hausdorff(rings[k - 1]!, rings[k]!),
      );
    }
    const total = hausdorff(rings[0]!, rings[rings.length - 1]!);
    expect(worstAdjacent).toBeLessThan(total / 2 + 1e-9);
  });
});
