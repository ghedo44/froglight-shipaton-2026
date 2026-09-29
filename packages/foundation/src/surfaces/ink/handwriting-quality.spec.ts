/**
 * Slow-writing quality gates: physical handwriting shapes (§11) plus
 * browser/WebView quantization transport (§12) plus capture-path audit
 * (§13) plus sanitation contract (§2).
 *
 * All geometric (never screenshot-only), deterministic, headless,
 * zoom-independent (compiler never reads the camera).
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH, brushPresetForKind } from './brush.js';
import { compileInkStroke } from './compiler.js';
import { viewToSurface } from '../geometry.js';
import { sanitizeSamples } from './samples.js';
import {
  idealArc,
  idealCircle,
  idealDiagonal,
  idealSCurve,
  slowQuantizedArc,
  transportQuantize,
} from './quantized-fixtures.js';
import {
  fastDiagonal,
  pressureRamp,
  sharpCorner,
  slowDiagonal,
  smallLoop,
} from './fixtures.js';
import type { Camera } from '../geometry.js';
import type { InkSample } from '../model.js';

function centerlineOf(samples: InkSample[]): { x: number; y: number }[] {
  const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
  const out: { x: number; y: number }[] = [];
  for (const segment of compiled.curve.segments) {
    for (let k = 0; k <= 10; k++) out.push(segment.position(k / 10));
  }
  return out;
}

describe('slow-writing shapes', () => {
  it('keeps a slow circle round (not polygonal or staircased)', () => {
    const camera: Camera = { x: 80, y: 80, zoom: 8 };
    const samples = transportQuantize(idealCircle(360, 30), camera);
    const fitted = centerlineOf(samples);
    const cx = fitted.reduce((s, p) => s + p.x, 0) / fitted.length;
    const cy = fitted.reduce((s, p) => s + p.y, 0) / fitted.length;
    const radii = fitted.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    expect(Math.max(...radii.map((r) => Math.abs(r - mean)))).toBeLessThan(0.5);
  });

  it('keeps a slow diagonal diagonal (never axis-stepped)', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 8 };
    const samples = transportQuantize(idealDiagonal(300), camera);
    const fitted = centerlineOf(samples);
    const a = fitted[0]!;
    const b = fitted[fitted.length - 1]!;
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    let worst = 0;
    for (const p of fitted) {
      worst = Math.max(
        worst,
        Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / chord,
      );
    }
    expect(worst).toBeLessThan(0.6);
  });

  it('keeps small handwriting loops open (e/a/o/g shapes)', () => {
    const compiled = compileInkStroke(smallLoop(), BALL_PEN_BRUSH);
    expect(compiled.polygon.length).toBeGreaterThanOrEqual(8);
    // Loop encloses area (not collapsed to a line by smoothing).
    let area = 0;
    const ring = compiled.polygon;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const c = ring[(i + 1) % ring.length]!;
      area += a.x * c.y - c.x * a.y;
    }
    expect(Math.abs(area) / 2).toBeGreaterThan(50);
  });

  it('retains an intentional sharp V corner', () => {
    const samples: InkSample[] = [];
    for (let i = 0; i <= 20; i++) {
      samples.push({ x: i * 5, y: i * 3, pressure: 0.5, dt: i * 8 });
    }
    for (let i = 1; i <= 20; i++) {
      samples.push({
        x: 100 + i * 5,
        y: 60 - i * 3,
        pressure: 0.5,
        dt: 160 + i * 8,
      });
    }
    const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
    // Apex (100,60) survives: the fitted curve passes near it. This
    // ~62° input turn measures under the 60° split threshold after
    // resampling/stabilization/fairing, so it smooths by design (no C0
    // split) rather than melting away — proximity, not sharpness, is the
    // gate here. Sharper observed turns split and miter; see
    // live-corners-joins.spec.ts.
    let best = Infinity;
    for (const segment of compiled.curve.segments) {
      for (let k = 0; k <= 16; k++) {
        const p = segment.position(k / 16);
        best = Math.min(best, Math.hypot(p.x - 100, p.y - 60));
      }
    }
    expect(best).toBeLessThan(0.6);
  });

  it('retains an intentional L corner (90°)', () => {
    const compiled = compileInkStroke(sharpCorner(), BALL_PEN_BRUSH);
    let best = Infinity;
    for (const segment of compiled.curve.segments) {
      for (let k = 0; k <= 16; k++) {
        const p = segment.position(k / 16);
        best = Math.min(best, Math.hypot(p.x - 100, p.y - 0));
      }
    }
    expect(best).toBeLessThan(0.9);
  });

  it('does not over-smooth a tiny hook', () => {
    // 8-unit hook at the end of a 60-unit run: must survive as a visible
    // direction change, not vanish into the straight.
    const samples: InkSample[] = [];
    for (let i = 0; i <= 30; i++) {
      samples.push({ x: i * 2, y: 0, pressure: 0.5, dt: i * 8 });
    }
    for (let i = 1; i <= 8; i++) {
      samples.push({
        x: 60 + i * 1,
        y: -i * 1,
        pressure: 0.5,
        dt: 240 + i * 8,
      });
    }
    const fitted = centerlineOf(samples);
    const end = fitted[fitted.length - 1]!;
    // Hook tip deviates from the straight baseline by several units.
    expect(Math.abs(end.y)).toBeGreaterThan(3);
    expect(end.x).toBeGreaterThan(62);
  });

  it('does not overshoot fast sparse curves', () => {
    const compiled = compileInkStroke(fastDiagonal(), BALL_PEN_BRUSH);
    // Stays inside the control bbox grown by a nib-scale margin (no
    // uniform-spline loops past the endpoints).
    expect(compiled.bounds.x).toBeGreaterThanOrEqual(-3);
    expect(compiled.bounds.y).toBeGreaterThanOrEqual(-3);
    expect(compiled.bounds.x + compiled.bounds.width).toBeLessThanOrEqual(225);
    expect(compiled.bounds.y + compiled.bounds.height).toBeLessThanOrEqual(160);
  });

  it('stays stable and finite on dense nearly stationary input', () => {
    const samples: InkSample[] = Array.from({ length: 200 }, (_, i) => ({
      x: 50 + Math.sin(i) * 0.05,
      y: 50 + Math.cos(i) * 0.05,
      pressure: 0.5,
      dt: i * 8,
    }));
    const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
    for (const p of compiled.polygon) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    for (const n of compiled.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.width)).toBe(true);
    }
    expect(compiled.polygon.length).toBeGreaterThan(0);
  });

  it('keeps geometry and width smooth on a slow pressure ramp', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 8 };
    const ideal = pressureRamp().map((s, i) => ({
      x: s.x,
      y: s.y,
      pressure: s.pressure,
      dt: i * 8,
    }));
    const samples = transportQuantize(ideal, camera);
    const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
    const widths = compiled.nodes.map((n) => n.width);
    for (let i = 1; i < widths.length; i++) {
      const rel =
        Math.abs(widths[i]! - widths[i - 1]!) / Math.max(widths[i]!, 1e-9);
      expect(rel).toBeLessThan(0.4);
    }
    // Width grows with pressure overall (responsive, not collapsed).
    // Compare outside the end-taper zone (last 5% tapers to the floor).
    const q1 = widths.slice(
      Math.floor(widths.length * 0.1),
      Math.floor(widths.length * 0.2),
    );
    const q3 = widths.slice(
      Math.floor(widths.length * 0.7),
      Math.floor(widths.length * 0.8),
    );
    const first = q1.reduce((s, w) => s + w, 0) / q1.length;
    const last = q3.reduce((s, w) => s + w, 0) / q3.length;
    expect(last).toBeGreaterThan(first);
  });

  it('keeps slow handwriting smooth at production defaults', () => {
    const compiled = compileInkStroke(slowDiagonal(), BALL_PEN_BRUSH);
    expect(compiled.polygon.length).toBeGreaterThanOrEqual(8);
    expect(BALL_PEN_BRUSH.stabilization).toBeLessThanOrEqual(0.2);
    expect(BALL_PEN_BRUSH.streamline).toBeLessThanOrEqual(0.3);
  });

  it('keeps brush families distinct on the same S-curve', () => {
    const { samples } = slowQuantizedArc(4);
    const rings = (
      ['ball', 'fountain', 'brush', 'pencil', 'highlighter'] as const
    ).map(
      (kind) => compileInkStroke(samples, brushPresetForKind(kind)).polygon,
    );
    // At least ball vs highlighter differ markedly (round nib vs ribbon).
    const area = (ring: readonly { x: number; y: number }[]): number => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        a += p.x * q.y - q.x * p.y;
      }
      return Math.abs(a) / 2;
    };
    const areas = rings.map(area);
    expect(Math.max(...areas) - Math.min(...areas)).toBeGreaterThan(10);
  });
});

describe('quantized transport', () => {
  it('handles 0.5px and 1px quantization without staircases', () => {
    for (const step of [0.5, 1]) {
      const { samples, ideal } = slowQuantizedArc(8, step);
      const fitted = centerlineOf(samples);
      let worst = 0;
      for (const p of fitted) {
        let best = Infinity;
        for (const q of ideal)
          best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        worst = Math.max(worst, best);
      }
      expect(worst).toBeLessThan(step === 1 ? 0.25 : 0.2);
    }
  });

  it('survives repeated positions, irregular intervals, and coalesced batches', () => {
    const base = slowQuantizedArc(8).samples;
    // Repeated positions (slow pen dwelling).
    const repeated: InkSample[] = [];
    for (const s of base.slice(0, 60)) {
      repeated.push(s, { ...s });
    }
    expect(() => compileInkStroke(repeated, BALL_PEN_BRUSH)).not.toThrow();
    const r = compileInkStroke(repeated, BALL_PEN_BRUSH);
    expect(r.polygon.length).toBeGreaterThan(0);
    // Irregular event intervals (dt jitter, same timestamps, sparse jumps).
    const irregular: InkSample[] = base.slice(0, 80).map((s, i) => ({
      ...s,
      dt:
        i % 7 === 0
          ? i > 0
            ? base[i - 1]!.dt
            : 0
          : i * (i % 3 === 0 ? 24 : 4),
    }));
    const c = compileInkStroke(irregular, BALL_PEN_BRUSH);
    for (const p of c.polygon) {
      expect(Number.isFinite(p.x)).toBe(true);
    }
    // Same timestamp with different positions (coalesced batch edge).
    const sameTime: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5, dt: 100 },
      { x: 5, y: 1, pressure: 0.5, dt: 100 },
      { x: 10, y: 0, pressure: 0.5, dt: 100 },
      { x: 20, y: 5, pressure: 0.5, dt: 108 },
    ];
    expect(() => compileInkStroke(sameTime, BALL_PEN_BRUSH)).not.toThrow();
  });
});

describe('capture path audit (no FrogLight-side rounding)', () => {
  it('maps view to surface without pixel snapping', () => {
    // Fractional view coords survive: no Math.round/integer coercion
    // between PointerEvent coordinates and canonical capture.
    const camera: Camera = { x: 10.3, y: -4.7, zoom: 8 };
    const p = viewToSurface(camera, { x: 100.6, y: 200.4 });
    expect(p.x).toBeCloseTo(100.6 / 8 + 10.3, 12);
    expect(p.y).toBeCloseTo(200.4 / 8 - 4.7, 12);
    expect(Number.isInteger(p.x)).toBe(false);
  });

  it('documents upstream quantization as the noise source', () => {
    // The estimator (not capture) owns quantization robustness: identical
    // canonical input compiles identically, so any staircase in committed
    // geometry comes from the transport grid, which the approximating
    // fitter treats as sampling noise (see slow-zoom-staircase.spec).
    const { samples } = slowQuantizedArc(8);
    const a = compileInkStroke(samples, BALL_PEN_BRUSH);
    const b = compileInkStroke(
      samples.map((s) => ({ ...s })),
      BALL_PEN_BRUSH,
    );
    expect(b.polygon).toEqual(a.polygon);
  });
});

describe('sanitation contract (minimal, zoom-justified)', () => {
  it('preserves legitimate high-zoom micro-motion (no 0.25 floor)', () => {
    // At 8×, 1 CSS px = 0.125 surface units: slow-handwriting steps of
    // 0.13–0.2 units are real pen travel, not jitter.
    const samples: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5, dt: 0 },
      { x: 0.13, y: 0.02, pressure: 0.5, dt: 8 },
      { x: 0.26, y: 0.05, pressure: 0.5, dt: 16 },
      { x: 10, y: 0, pressure: 0.5, dt: 24 },
    ];
    const cleaned = sanitizeSamples(samples, 0);
    expect(cleaned.length).toBe(4);
    // The historic 0.25 floor would have erased the two micro-steps.
    const legacy = sanitizeSamples(samples, 0.25);
    expect(legacy.length).toBeLessThan(cleaned.length);
  });

  it('still drops exact duplicates and non-finite coordinates', () => {
    const samples: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0, y: 0, pressure: 0.5 },
      { x: Number.NaN, y: 0 },
      { x: 5, y: 0, pressure: 0.5 },
    ];
    const cleaned = sanitizeSamples(samples, 0);
    expect(cleaned.length).toBe(2);
    expect(cleaned[0]).toMatchObject({ x: 0, y: 0 });
    expect(cleaned[1]).toMatchObject({ x: 5, y: 0 });
  });

  it('defaults the committed compiler to exact-duplicate-only sanitation', () => {
    const samples: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5, dt: 0 },
      { x: 0.13, y: 0, pressure: 0.5, dt: 8 },
      { x: 20, y: 0, pressure: 0.5, dt: 16 },
    ];
    const def = compileInkStroke(samples, BALL_PEN_BRUSH);
    const floored = compileInkStroke(samples, BALL_PEN_BRUSH, {
      minDistance: 0.25,
    });
    // Default preserves the micro-step (longer fitted curve) vs the floor.
    const len = (pts: readonly { x: number; y: number }[]): number => {
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(
          pts[i]!.x - pts[i - 1]!.x,
          pts[i]!.y - pts[i - 1]!.y,
        );
      }
      return total;
    };
    const defPts = def.nodes.map((n) => ({ x: n.x, y: n.y }));
    const floorPts = floored.nodes.map((n) => ({ x: n.x, y: n.y }));
    expect(len(defPts)).toBeGreaterThanOrEqual(len(floorPts) - 1e-9);
  });
});

describe('trajectory matrix (symmetric ideal-fitted gates)', () => {
  // Failure mechanism under test: ideal surface trajectory -> view
  // transform -> CSS-pixel quantization -> surface transform -> compiler.
  // Every gate measures SYMMETRICALLY (fitted -> ideal AND ideal ->
  // fitted): one direction alone hides dropouts and overshoots. Budgets
  // are screen-derived: ~1px quantization plus fitting headroom at the
  // transport zoom (fractional control: tight absolute budget).
  type Ideal = { x: number; y: number; pressure: number; dt: number };

  const shallowH = (): Ideal[] => {
    const out: Ideal[] = [];
    for (let i = 0; i < 400; i++) {
      const t = i / 399;
      out.push({
        x: t * 120,
        y: 40 + t * 4 + Math.sin(t * Math.PI * 4) * 1.5,
        pressure: 0.55,
        dt: i * 8,
      });
    }
    return out;
  };
  const shallowV = (): Ideal[] => {
    const out: Ideal[] = [];
    for (let i = 0; i < 400; i++) {
      const t = i / 399;
      out.push({
        x: 40 + t * 4 + Math.sin(t * Math.PI * 4) * 1.5,
        y: t * 120,
        pressure: 0.55,
        dt: i * 8,
      });
    }
    return out;
  };
  const tinyLoop = (): Ideal[] => {
    // Lowercase-like loop: entry tail, r=6 loop, exit tail.
    const out: Ideal[] = [];
    let dt = 0;
    for (let i = 0; i <= 40; i++) {
      out.push({ x: 60 + i * 0.8, y: 100, pressure: 0.55, dt });
      dt += 8;
    }
    for (let i = 1; i <= 80; i++) {
      const a = -Math.PI / 2 + (i / 80) * Math.PI * 2;
      out.push({
        x: 92 + 6 + 6 * Math.cos(a),
        y: 100 + 6 * Math.sin(a),
        pressure: 0.55,
        dt,
      });
      dt += 6;
    }
    for (let i = 1; i <= 40; i++) {
      out.push({ x: 98 + i * 0.8, y: 94 - i * 0.2, pressure: 0.55, dt });
      dt += 8;
    }
    return out;
  };
  const hookStroke = (): Ideal[] => {
    const out: Ideal[] = [];
    let dt = 0;
    for (let i = 0; i <= 60; i++) {
      out.push({ x: i * 2, y: 0, pressure: 0.55, dt });
      dt += 8;
    }
    for (let i = 1; i <= 16; i++) {
      out.push({ x: 120 + i * 1.2, y: -i * 1.2, pressure: 0.55, dt });
      dt += 8;
    }
    return out;
  };
  const slowFast = (): Ideal[] => {
    // Alternating density within one stroke: dense crawl, sparse run.
    const out: Ideal[] = [];
    let dt = 0;
    for (let i = 0; i <= 300; i++) {
      out.push({ x: i * 0.2, y: i * 0.15, pressure: 0.55, dt });
      dt += 8;
    }
    for (let i = 1; i <= 20; i++) {
      out.push({ x: 60 + i * 3, y: 45 + i * 2.25, pressure: 0.55, dt });
      dt += 8;
    }
    return out;
  };
  const pressureDiagonal = (): Ideal[] =>
    idealDiagonal(400).map((p, i) => ({
      ...p,
      pressure: 0.1 + (0.9 * i) / 399,
    }));

  const shapes: {
    name: string;
    ideal: () => Ideal[];
    budget?: number;
    endBudget?: number;
  }[] = [
    { name: 'quarter-arc', ideal: () => idealArc(400) },
    // Closed circle: the causal stabilization tip lag leaves a ~1px seam
    // between the exact anchor start and the lagging end (shared
    // live/commit exactly, so no pointer-up jump; round caps cover
    // sub-width seams). Outline gates stay tight.
    { name: 'circle', ideal: () => idealCircle(480), endBudget: 0.25 },
    { name: 's-curve', ideal: () => idealSCurve(400) },
    { name: 'diagonal', ideal: () => idealDiagonal(400) },
    { name: 'shallow-h', ideal: shallowH },
    { name: 'shallow-v', ideal: shallowV },
    // Tight r=6 loop: systematic inward inset (~0.23u) from causal
    // stabilization/fairing plus the approximating cut on tight radius.
    // Shared live/commit exactly; openness is gated separately below.
    { name: 'tiny-loop', ideal: tinyLoop, budget: 0.3 },
    // Fast flick: causal smoothing rounds the flick tip (~0.24u); the
    // straight run tracks tightly and tip presence is gated separately.
    { name: 'hook', ideal: hookStroke, budget: 0.3 },
    { name: 'slow-fast', ideal: slowFast },
    { name: 'pressure-diagonal', ideal: pressureDiagonal },
  ];

  const transports: {
    name: string;
    zoom: number;
    budget: number;
    run: (ideal: Ideal[]) => InkSample[];
  }[] = [
    {
      name: '1px@8x',
      zoom: 8,
      budget: 1 / 8 + 0.05,
      run: (ideal) => transportQuantize(ideal, { x: 80, y: 80, zoom: 8 }, 1),
    },
    {
      name: '1px@1x',
      zoom: 1,
      budget: 1 / 1 + 0.05,
      run: (ideal) => transportQuantize(ideal, { x: 80, y: 80, zoom: 1 }, 1),
    },
    {
      name: '0.5px@8x',
      zoom: 8,
      budget: 0.5 / 8 + 0.05,
      run: (ideal) => transportQuantize(ideal, { x: 80, y: 80, zoom: 8 }, 0.5),
    },
    {
      name: 'fractional',
      zoom: 8,
      budget: 0.125,
      run: (ideal) => ideal.map((p) => ({ ...p })),
    },
  ];

  const symmetric = (
    fittedCurve: readonly { position(t: number): { x: number; y: number } }[],
    ideal: readonly { x: number; y: number }[],
  ): { fwd: number; bwd: number } => {
    // Dense fitted samples (the analytic curve, not sparse tessellation
    // nodes) against ideal points, point-to-segment both ways. Measured
    // over the MIDDLE 90% by index: the causal tip transient (lag/hook
    // at the stroke end, shared live/commit exactly) is gated separately
    // by the endpoint budget below, so it cannot pollute steady-state
    // tracking quality.
    const fitted: { x: number; y: number }[] = [];
    for (const segment of fittedCurve) {
      for (let k = 0; k <= 20; k++) fitted.push(segment.position(k / 20));
    }
    const lo = (q: readonly unknown[]): number => Math.floor(q.length * 0.05);
    const hi = (q: readonly unknown[]): number => Math.ceil(q.length * 0.95);
    const segDist = (
      p: { x: number; y: number },
      q: readonly { x: number; y: number }[],
    ): number => {
      let best = Infinity;
      const step = Math.max(1, Math.floor(q.length / 1500));
      for (let i = 0; i < q.length; i += step) {
        const a = q[i]!;
        const b = q[(i + step) % q.length]!;
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
    };
    let fwd = 0;
    for (let i = lo(fitted); i < hi(fitted); i++) {
      fwd = Math.max(fwd, segDist(fitted[i]!, ideal));
    }
    let bwd = 0;
    for (let i = lo(ideal); i < hi(ideal); i++) {
      bwd = Math.max(bwd, segDist(ideal[i]!, fitted));
    }
    return { fwd, bwd };
  };

  for (const { name, ideal, budget, endBudget } of shapes) {
    it(`tracks ${name} through quantized transport (symmetric)`, () => {
      const ref = ideal();
      for (const t of transports) {
        const samples = t.run(ref);
        const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
        expect(
          compiled.nodes.length,
          `${name}/${t.name}: nodes`,
        ).toBeGreaterThan(4);
        const fitted = compiled.curve.segments;
        const plain = ref.map((p) => ({ x: p.x, y: p.y }));
        const { fwd, bwd } = symmetric(fitted, plain);
        // Shape floors never undercut transport budgets (quantization
        // dominates at low zoom).
        const shapeBudget = Math.max(budget ?? 0, t.budget);
        expect(fwd, `${name}/${t.name}: fitted->ideal`).toBeLessThan(
          shapeBudget,
        );
        expect(bwd, `${name}/${t.name}: ideal->fitted`).toBeLessThan(
          shapeBudget,
        );
        // Endpoints: causal tip lag/hook plus quantization. Shared
        // live/commit exactly (no pointer-up jump); round caps cover
        // sub-width seams on closed shapes.
        const spine = compiled.nodes;
        const f0 = spine[0]!;
        const f1 = spine[spine.length - 1]!;
        expect(
          Math.hypot(f0.x - plain[0]!.x, f0.y - plain[0]!.y),
          `${name}/${t.name}: start`,
        ).toBeLessThan(Math.max(t.budget, 0.3));
        expect(
          Math.hypot(
            f1.x - plain[plain.length - 1]!.x,
            f1.y - plain[plain.length - 1]!.y,
          ),
          `${name}/${t.name}: end`,
        ).toBeLessThan(Math.max(endBudget ?? 0, t.budget, 0.3));
      }
    });
  }

  it('keeps tiny loops open after transport', () => {
    const camera = { x: 80, y: 80, zoom: 8 };
    const samples = transportQuantize(tinyLoop(), camera, 1);
    const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
    let area = 0;
    const ring = compiled.polygon;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const c = ring[(i + 1) % ring.length]!;
      area += a.x * c.y - c.x * a.y;
    }
    // r=6 loop encloses ~113 units²; smoothing must not collapse it.
    expect(Math.abs(area) / 2).toBeGreaterThan(40);
  });
});
