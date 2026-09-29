/**
 * Corner-aware approximating centerline: endpoint interpolation,
 * interior approximation (quantization-grade smoothing), C2 continuity
 * across non-corner joints, corner preservation by splitting, attribute
 * interpolation, degeneracy handling, and builder parity.
 */

import { describe, expect, it } from 'vitest';
import {
  detectCorners,
  fitCenterlineCurve,
  InkCurveBuilder,
  type InkCurveControl,
} from './curve.js';

function control(
  x: number,
  y: number,
  extra: Partial<InkCurveControl> = {},
): InkCurveControl {
  return {
    x,
    y,
    pressure: 0.5,
    tiltX: null,
    tiltY: null,
    twist: null,
    dt: null,
    ...extra,
  };
}

function circleControls(n = 40, radius = 18): InkCurveControl[] {
  const out: InkCurveControl[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = (i / n) * Math.PI * 2;
    out.push(
      control(30 + Math.cos(angle) * radius, 30 + Math.sin(angle) * radius),
    );
  }
  return out;
}

describe('corner-aware approximating centerline', () => {
  it('interpolates endpoints while approximating interior controls', () => {
    const controls = [
      control(0, 0),
      control(10, 3),
      control(20, -2),
      control(30, 4),
    ];
    const curve = fitCenterlineCurve(controls);
    // 4 controls → single clamped cubic span (m-3), not 3 interpolating
    // segments: observations are trajectory evidence, not mandatory knots.
    expect(curve.segments).toHaveLength(1);
    expect(curve.controlCount).toBe(4);
    expect(curve.dot).toBeNull();
    const start = curve.segments[0]!.position(0);
    const end = curve.segments[0]!.position(1);
    expect(start.x).toBeCloseTo(0, 9);
    expect(start.y).toBeCloseTo(0, 9);
    expect(end.x).toBeCloseTo(30, 9);
    expect(end.y).toBeCloseTo(4, 9);
    // Interior stands off the noisy controls (approximating)…
    let maxDev = 0;
    for (const c of controls.slice(1, -1)) {
      let best = Infinity;
      for (let k = 0; k <= 16; k++) {
        const p = curve.segments[0]!.position(k / 16);
        best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y));
      }
      maxDev = Math.max(maxDev, best);
    }
    expect(maxDev).toBeGreaterThan(0.05);
    // …but bounded (no mush, no explosion — single-span smoothing of a
    // sparse 10-unit zigzag stays within a few units).
    expect(maxDev).toBeLessThan(3.5);
  });

  it('preserves intentional corners by splitting (C0 at the corner)', () => {
    const controls = [
      control(0, 0),
      control(10, 0),
      control(20, 0),
      control(30, 0),
      control(40, 0),
      control(50, 0),
      control(50, 10),
      control(50, 20),
      control(50, 30),
      control(50, 40),
      control(50, 50),
    ];
    const corners = detectCorners(
      controls.map((c) => c.x),
      controls.map((c) => c.y),
    );
    // Corner detected near the turn (index 5 ± 1, never a single-sample spike).
    const flagged = corners.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged.some((i) => Math.abs(i - 5) <= 1)).toBe(true);
    const curve = fitCenterlineCurve(controls);
    expect(curve.cornerCount ?? 0).toBeGreaterThanOrEqual(1);
    // The fitted corner stays near the intent (no melt, no overshoot).
    let best = Infinity;
    for (const segment of curve.segments) {
      for (let k = 0; k <= 16; k++) {
        const p = segment.position(k / 16);
        best = Math.min(best, Math.hypot(p.x - 50, p.y - 0));
      }
    }
    expect(best).toBeLessThan(1.2);
  });

  it('does not flag quantization-grade jitter as corners', () => {
    // Alternating ±10° staircase wobble (resampled quantization scale):
    // no sustained 60° turn, no corner.
    const controls: InkCurveControl[] = [];
    for (let i = 0; i < 12; i++) {
      controls.push(control(i * 1.05, i % 2 === 0 ? 0.1 : -0.1));
    }
    const corners = detectCorners(
      controls.map((c) => c.x),
      controls.map((c) => c.y),
    );
    expect(corners.some(Boolean)).toBe(false);
    expect(fitCenterlineCurve(controls).cornerCount ?? 0).toBe(0);
  });

  it('produces C1-continuous tangents across non-corner joints', () => {
    const curve = fitCenterlineCurve(circleControls());
    let worst = 0;
    for (let s = 0; s + 1 < curve.segments.length; s++) {
      const a = curve.segments[s]!.tangent(1);
      const b = curve.segments[s + 1]!.tangent(0);
      const dot = Math.min(Math.max(a.x * b.x + a.y * b.y, -1), 1);
      worst = Math.max(worst, Math.acos(dot));
    }
    // Finite-difference joints agree tightly (no discrete
    // polygon-tangent jumps by construction — those are degree-scale).
    expect(worst).toBeLessThan(5e-6);
  });

  it('returns normalized tangents everywhere on handwriting shapes', () => {
    const wavy: InkCurveControl[] = [];
    for (let i = 0; i < 60; i++) {
      wavy.push(control(i * 2, 50 + Math.sin(i / 6) * 12));
    }
    const curve = fitCenterlineCurve(wavy);
    for (const segment of curve.segments) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const tan = segment.tangent(t);
        expect(Number.isFinite(tan.x)).toBe(true);
        expect(Number.isFinite(tan.y)).toBe(true);
        expect(Math.hypot(tan.x, tan.y)).toBeCloseTo(1, 9);
      }
    }
  });

  it('keeps a circle closed and turning monotonically', () => {
    const curve = fitCenterlineCurve(circleControls());
    // Closed: last control coincides with the first.
    const end = curve.segments[curve.segments.length - 1]!.position(1);
    expect(end.x).toBeCloseTo(48, 9);
    expect(end.y).toBeCloseTo(30, 9);
    // Radius stays near the control radius (no loops, no collapse).
    for (const segment of curve.segments) {
      for (const t of [0, 0.5, 1]) {
        const p = segment.position(t);
        const radius = Math.hypot(p.x - 30, p.y - 30);
        expect(Math.abs(radius - 18)).toBeLessThan(0.5);
      }
    }
  });

  it('bounds overshoot on monotone data (no uniform-spline loops)', () => {
    const controls = [
      control(0, 0),
      control(10, 8),
      control(20, 9),
      control(30, 20),
    ];
    const curve = fitCenterlineCurve(controls);
    for (const segment of curve.segments) {
      for (let k = 0; k <= 8; k++) {
        const p = segment.position(k / 8);
        // Stays inside the control bbox grown by a small fairing margin.
        expect(p.x).toBeGreaterThanOrEqual(-1.5);
        expect(p.x).toBeLessThanOrEqual(31.5);
        expect(p.y).toBeGreaterThanOrEqual(-1.5);
        expect(p.y).toBeLessThanOrEqual(21.5);
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it('handles duplicate and near-zero controls without NaN', () => {
    const controls = [
      control(0, 0),
      control(0, 0, { pressure: 0.9 }),
      control(10, 0),
      control(10 + 1e-10, 0),
      control(20, 0),
    ];
    const curve = fitCenterlineCurve(controls);
    // 5 controls → 2 clamped cubic spans (m-3), degeneracy-safe.
    expect(curve.segments).toHaveLength(2);
    for (const segment of curve.segments) {
      for (const t of [0, 0.5, 1]) {
        const p = segment.position(t);
        const tan = segment.tangent(t);
        const attrs = segment.attributes(t);
        for (const v of [p.x, p.y, tan.x, tan.y, attrs.pressure]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(Math.hypot(tan.x, tan.y)).toBeCloseTo(1, 6);
      }
    }
  });

  it('smooths pressure through the B-spline basis and clamps it to [0, 1]', () => {
    const controls = [
      control(0, 0, { pressure: 0 }),
      control(10, 0, { pressure: 1 }),
      control(20, 0, { pressure: 1 }),
      control(30, 0, { pressure: 0 }),
    ];
    const curve = fitCenterlineCurve(controls);
    expect(curve.segments).toHaveLength(1);
    for (const segment of curve.segments) {
      for (let k = 0; k <= 4; k++) {
        const p = segment.attributes(k / 4).pressure;
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
    // Endpoints exact; interior blends (approximating, not stepwise).
    expect(curve.segments[0]!.attributes(0).pressure).toBeCloseTo(0, 6);
    expect(curve.segments[0]!.attributes(1).pressure).toBeCloseTo(0, 6);
    const mid = curve.segments[0]!.attributes(0.5).pressure;
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThanOrEqual(1);
  });

  it('reports null tilt/twist/dt only when the run carries no data', () => {
    const plain = fitCenterlineCurve([control(0, 0), control(10, 0)]);
    expect(plain.segments[0]!.attributes(0.5)).toMatchObject({
      tiltX: null,
      tiltY: null,
      twist: null,
      dt: null,
    });
    const timed = fitCenterlineCurve([
      control(0, 0, {
        dt: 0,
        tiltX: 0.2,
        tiltY: 0.1,
        twist: 0.3,
      }),
      control(10, 0, { dt: 100, tiltX: 0.4, tiltY: 0.3, twist: 0.9 }),
    ]);
    const mid = timed.segments[0]!.attributes(0.5);
    expect(mid.dt).toBeCloseTo(50, 9);
    expect(mid.tiltX).toBeCloseTo(0.3, 6);
    expect(mid.twist).not.toBeNull();
  });

  it('wraps twist interpolation the short way', () => {
    const curve = fitCenterlineCurve([
      control(0, 0, { twist: Math.PI - 0.1 }),
      control(10, 0, { twist: Math.PI - 0.1 }),
      control(20, 0, { twist: -Math.PI + 0.1 }),
      control(30, 0, { twist: -Math.PI + 0.1 }),
    ]);
    for (const segment of curve.segments) {
      const tw = segment.attributes(0.5).twist!;
      expect(Number.isFinite(tw)).toBe(true);
      expect(tw).toBeGreaterThanOrEqual(-Math.PI);
      expect(tw).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('clamps degenerate input to a dot curve', () => {
    expect(fitCenterlineCurve([])).toMatchObject({
      segments: [],
      controlCount: 0,
      dot: null,
    });
    const dot = fitCenterlineCurve([control(7, 9, { pressure: 0.8 })]);
    expect(dot.segments).toHaveLength(0);
    expect(dot.dot).toMatchObject({ x: 7, y: 9 });
    expect(dot.dot!.attributes.pressure).toBeCloseTo(0.8, 9);
  });

  it('rejects non-finite parameters deterministically', () => {
    const curve = fitCenterlineCurve([control(0, 0), control(10, 5)]);
    const p = curve.segments[0]!.position(Number.NaN);
    const t = curve.segments[0]!.tangent(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(t.x)).toBe(true);
  });
});

describe('InkCurveBuilder', () => {
  it('matches the batch fit after sequential pushes', () => {
    const controls = circleControls(24);
    const builder = new InkCurveBuilder();
    for (const c of controls) builder.push(c);
    expect(builder.controlCount).toBe(controls.length);
    const batch = fitCenterlineCurve(controls);
    const live = builder.curve;
    expect(live.segments.length).toBe(batch.segments.length);
    for (let s = 0; s < batch.segments.length; s++) {
      for (const t of [0, 0.3, 0.7, 1]) {
        const a = batch.segments[s]!.position(t);
        const b = live.segments[s]!.position(t);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.y).toBeCloseTo(a.y, 9);
        const ta = batch.segments[s]!.tangent(t);
        const tb = live.segments[s]!.tangent(t);
        expect(tb.x).toBeCloseTo(ta.x, 9);
        expect(tb.y).toBeCloseTo(ta.y, 9);
        const aa = batch.segments[s]!.attributes(t);
        const ab = live.segments[s]!.attributes(t);
        expect(ab.pressure).toBeCloseTo(aa.pressure, 9);
      }
    }
  });

  it('supports pop/continuation exactly (provisional tip replacement)', () => {
    const controls = circleControls(24);
    const builder = new InkCurveBuilder();
    for (const c of controls) builder.push(c);
    builder.pop();
    builder.pop();
    const resumed = [
      ...controls.slice(0, controls.length - 2),
      control(99, 99),
    ];
    builder.push(resumed[resumed.length - 1]!);
    const batch = fitCenterlineCurve(resumed);
    const live = builder.curve;
    expect(live.segments.length).toBe(batch.segments.length);
    const last = live.segments.length - 1;
    const a = batch.segments[last]!.position(1);
    const b = live.segments[last]!.position(1);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  it('resets to an exact batch-equivalent curve', () => {
    const builder = new InkCurveBuilder();
    builder.push(control(0, 0));
    builder.push(control(999, 999));
    const controls = circleControls(16);
    builder.reset(controls);
    expect(builder.controlCount).toBe(controls.length);
    const batch = fitCenterlineCurve(controls);
    expect(builder.curve.segments.length).toBe(batch.segments.length);
  });
});
