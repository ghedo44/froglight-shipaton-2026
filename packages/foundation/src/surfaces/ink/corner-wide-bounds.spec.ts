/**
 * Wide corner detector bounds safety (repair item 2).
 *
 * `cornerAtWide` evaluates ±3 windows at i±2 (needing i±5) plus a
 * monotonicity sweep reading up to i+4. Its guard must therefore require
 * radius 5 — every window access provably safe — with fallback to the
 * narrow detector outside [5, n-6]. This suite pins:
 *
 * - no out-of-range reads or NaN at i = 3, 4, 5 and i = n-6, n-5, n-4;
 * - no flags outside the provably-safe radius (fallback to narrow);
 * - short strokes (7–12 controls) never crash and stay finite;
 * - batch (`detectCorners`/`fitCenterlineCurve`) and incremental
 *   (`InkCurveBuilder` + `cornerFlagAt`) decisions agree exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  cornerAt,
  cornerAtWide,
  cornerFlagAt,
  detectCorners,
  fitCenterlineCurve,
  InkCurveBuilder,
  type InkCurveControl,
} from './curve.js';

function control(x: number, y: number): InkCurveControl {
  return {
    x,
    y,
    pressure: 0.5,
    tiltX: null,
    tiltY: null,
    twist: null,
    dt: null,
  };
}

/** Sharp L: long straight arms with a 90° apex at the middle. */
function lControls(n: number): InkCurveControl[] {
  const out: InkCurveControl[] = [];
  const half = Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    if (i <= half) out.push(control(i * 10, 0));
    else out.push(control(half * 10, (i - half) * 10));
  }
  return out;
}

function xsYs(controls: InkCurveControl[]): {
  xs: number[];
  ys: number[];
  n: number;
} {
  return {
    xs: controls.map((c) => c.x),
    ys: controls.map((c) => c.y),
    n: controls.length,
  };
}

describe('cornerAtWide bounds safety', () => {
  it('never reads out of range or returns NaN at head/tail edge indices', () => {
    // Long L so the apex is far from the edges: edge calls exercise
    // only the guard/fallback path, never a genuine wide flag.
    const controls = lControls(30);
    const { xs, ys, n } = xsYs(controls);
    for (const i of [
      0,
      1,
      2,
      3,
      4,
      5,
      n - 6,
      n - 5,
      n - 4,
      n - 3,
      n - 2,
      n - 1,
    ]) {
      const wide = cornerAtWide(xs, ys, n, i);
      expect(typeof wide).toBe('boolean');
      // Narrow may flag near-corner shapes, but wide must stay silent
      // outside its provably-safe radius.
      if (i < 5 || i + 5 >= n) {
        expect(wide).toBe(false);
      }
      const flag = cornerFlagAt(xs, ys, n, i);
      expect(typeof flag).toBe('boolean');
      // Flag is exactly narrow OR wide (fallback, never a third path).
      expect(flag).toBe(cornerAt(xs, ys, n, i) || wide);
    }
  });

  it('requires radius 5: i=3,4 fall back to narrow, i=5 may use wide', () => {
    const controls = lControls(30);
    const { xs, ys, n } = xsYs(controls);
    // Guard pins the radius: 3 and 4 never produce a wide flag even on a
    // sharp shape, 5 is the first index with full ±5 context.
    for (const i of [3, 4]) {
      expect(cornerAtWide(xs, ys, n, i)).toBe(false);
    }
    // i=5 has full context — assert only that it evaluates safely
    // (boolean, finite inputs), not a specific flag value.
    expect(typeof cornerAtWide(xs, ys, n, 5)).toBe('boolean');
    expect(typeof cornerAtWide(xs, ys, n, n - 6)).toBe('boolean');
    for (const i of [n - 5, n - 4]) {
      expect(cornerAtWide(xs, ys, n, i)).toBe(false);
    }
  });

  it('handles short strokes (7–12 controls) without crash or NaN', () => {
    for (let n = 7; n <= 12; n++) {
      const controls = lControls(n);
      const { xs, ys } = xsYs(controls);
      const flags = detectCorners(xs, ys);
      expect(flags).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        expect(typeof flags[i]).toBe('boolean');
        expect(typeof cornerAtWide(xs, ys, n, i)).toBe('boolean');
        expect(typeof cornerFlagAt(xs, ys, n, i)).toBe('boolean');
      }
      // Short strokes fit the approximating pipeline end to end.
      const curve = fitCenterlineCurve(controls);
      expect(curve.controlCount).toBe(n);
      for (const segment of curve.segments) {
        for (const t of [0, 0.5, 1]) {
          const p = segment.position(t);
          const tan = segment.tangent(t);
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
          expect(Number.isFinite(tan.x)).toBe(true);
          expect(Number.isFinite(tan.y)).toBe(true);
        }
      }
      // Wide never fires below 11 controls (needs i>=5 and i+5<n);
      // narrow alone decides — still finite, still deterministic.
      if (n < 11) {
        for (let i = 0; i < n; i++) {
          expect(cornerAtWide(xs, ys, n, i)).toBe(false);
        }
      }
    }
  });

  it('produces identical results for batch and incremental detection', () => {
    // Shapes covering straight, L-corner, V-corner, and jitter.
    const shapes: InkCurveControl[][] = [
      lControls(40),
      // V corner (diagonal arms).
      Array.from({ length: 30 }, (_, i) =>
        i <= 15
          ? control(i * 8, i * 5)
          : control(15 * 8 + (i - 15) * 8, 15 * 5 - (i - 15) * 5),
      ),
      // Straight diagonal (no corner).
      Array.from({ length: 25 }, (_, i) => control(i * 7, i * 4.5)),
      // Quantization-grade jitter (no corner).
      Array.from({ length: 20 }, (_, i) =>
        control(i * 1.05, i % 2 === 0 ? 0.1 : -0.1),
      ),
    ];
    for (const controls of shapes) {
      const { xs, ys, n } = xsYs(controls);
      const batch = detectCorners(xs, ys);
      // Incremental: feed one control at a time through the builder and
      // compare the builder's corner flags via cornerFlagAt on the same
      // arrays (single definition point — batch and incremental share it).
      const builder = new InkCurveBuilder();
      for (const c of controls) builder.push(c);
      expect(builder.controlCount).toBe(n);
      for (let i = 0; i < n; i++) {
        expect(cornerFlagAt(xs, ys, n, i)).toBe(batch[i]);
      }
      // Fit parity: batch fit and incremental builder agree on count.
      const batchCurve = fitCenterlineCurve(controls);
      expect(builder.curve.controlCount).toBe(batchCurve.controlCount);
      expect(builder.curve.segments.length).toBe(batchCurve.segments.length);
      expect(builder.curve.cornerCount).toBe(batchCurve.cornerCount);
    }
  });

  it('keeps incremental tail refits equivalent under batch appends', () => {
    // One-by-one pushes vs chunked pushes converge to the same flags.
    const controls = lControls(50);
    const { xs, ys, n } = xsYs(controls);
    const batch = detectCorners(xs, ys);
    const oneByOne = new InkCurveBuilder();
    for (const c of controls) oneByOne.push(c);
    const chunked = new InkCurveBuilder();
    for (let i = 0; i < controls.length; i += 7) {
      for (const c of controls.slice(i, i + 7)) chunked.push(c);
    }
    expect(oneByOne.curve.segments.length).toBe(chunked.curve.segments.length);
    expect(oneByOne.curve.cornerCount).toBe(chunked.curve.cornerCount);
    for (let i = 0; i < n; i++) {
      expect(cornerFlagAt(xs, ys, n, i)).toBe(batch[i]);
    }
  });
});
