/**
 * Committed pipeline integration: sanitation → arc-length resampling →
 * stabilization → fairing → pressure → centripetal centerline → adaptive
 * tessellation → curve-tangent mesh. Behavioral coverage for the whole
 * compiler plus the brush families that ride it.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  PENCIL_BRUSH,
  brushPresetForKind,
  resolveBrushSpec,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  denseBatch,
  fastDiagonal,
  longStroke,
  pressureRamp,
  sharpCorner,
  slowHandwritingCurve,
} from './fixtures.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

const FLAT_BRUSH = () =>
  resolveBrushSpec({
    stabilization: 0,
    streamline: 0,
    taperStart: 0,
    taperEnd: 0,
  });

function polygonArea(polygon: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

describe('sample sanitation', () => {
  it('drops duplicates, invalid axes, and sub-minimum jitter', () => {
    const samples: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0, y: 0, pressure: 0.5 },
      { x: Number.NaN, y: 0 },
      { x: 0.1, y: 0 },
      { x: 10, y: 0, pressure: 0.5 },
    ];
    const geometry = compileInkStroke(samples, FLAT_BRUSH(), {
      minDistance: 1,
      spacing: 100,
    });
    expect(geometry.nodes.length).toBeGreaterThanOrEqual(2);
    expect(geometry.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(geometry.polygon.length).toBeGreaterThan(0);
  });

  it('returns empty geometry when no usable sample survives', () => {
    const geometry = compileInkStroke(
      [
        { x: Number.NaN, y: 0 },
        { x: 0, y: Number.POSITIVE_INFINITY },
      ],
      FLAT_BRUSH(),
    );
    expect(geometry.nodes).toEqual([]);
    expect(geometry.polygon).toEqual([]);
    expect(geometry.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(geometry.curve.dot).toBeNull();
  });

  it('preserves tilt-only changes at identical coords (zero jitter floor)', () => {
    const geometry = compileInkStroke(
      [
        { x: 0, y: 0, pressure: 0.5, tilt: { x: 0.1, y: 0 } },
        { x: 0, y: 0, pressure: 0.5, tilt: { x: 0.3, y: 0 } },
        { x: 20, y: 0, pressure: 0.5 },
      ],
      FLAT_BRUSH(),
      { minDistance: 0, spacing: 100 },
    );
    expect(geometry.nodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('pipeline integration', () => {
  it('normalizes a fast diagonal to near-uniform node spacing', () => {
    const geometry = compileInkStroke(fastDiagonal(), FLAT_BRUSH(), {
      spacing: 4,
    });
    // ~285 units of travel at 4-unit grid steps plus adaptive refinement.
    expect(geometry.nodes.length).toBeGreaterThan(40);
    expect(geometry.nodes.length).toBeLessThan(160);
    for (let i = 1; i < geometry.nodes.length; i++) {
      const gap = Math.hypot(
        geometry.nodes[i]!.x - geometry.nodes[i - 1]!.x,
        geometry.nodes[i]!.y - geometry.nodes[i - 1]!.y,
      );
      // Clamped B-spline end spans cover slightly more arc than interior
      // uniform spans (endpoint interpolation); bound at 2× spacing.
      expect(gap).toBeLessThanOrEqual(4 * 2);
    }
  });

  it('consolidates already-dense input instead of exploding detail', () => {
    const dense = denseBatch();
    const geometry = compileInkStroke(dense, FLAT_BRUSH(), { spacing: 10 });
    // ~14 units of travel: a handful of controls, not 48 jitter nodes.
    expect(geometry.nodes.length).toBeLessThan(dense.length);
    expect(geometry.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('exposes the continuous centerline and mesh alongside the ring', () => {
    const geometry = compileInkStroke(sCurveFixture(), BALL_PEN_BRUSH);
    expect(geometry.curve.segments.length).toBeGreaterThan(10);
    expect(geometry.mesh.ring).toBe(geometry.polygon);
    expect(geometry.mesh.left.length).toBeGreaterThan(0);
    expect(geometry.mesh.right.length).toBe(geometry.mesh.left.length);
  });

  it('keeps the fitted curve inside the nib-expanded envelope', () => {
    const geometry = compileInkStroke(sharpCorner(), FLAT_BRUSH(), {
      spacing: 5,
    });
    const pad = 3 / 2 + 1;
    expect(geometry.bounds.x).toBeGreaterThanOrEqual(0 - pad);
    expect(geometry.bounds.y).toBeGreaterThanOrEqual(0 - pad);
    expect(geometry.bounds.x + geometry.bounds.width).toBeLessThanOrEqual(
      100 + pad,
    );
    expect(geometry.bounds.y + geometry.bounds.height).toBeLessThanOrEqual(
      100 + pad,
    );
  });

  it('compiles deterministically and scales linearly on long strokes', () => {
    const stroke = longStroke();
    const first = compileInkStroke(stroke, BALL_PEN_BRUSH);
    const second = compileInkStroke(stroke, BALL_PEN_BRUSH);
    // Plain-data views are bit-identical; the curve holds closures, so it
    // compares by dense sampling instead of reference equality.
    expect(second.nodes).toEqual(first.nodes);
    expect(second.polygon).toEqual(first.polygon);
    expect(second.bounds).toEqual(first.bounds);
    expect(second.curve.segments.length).toBe(first.curve.segments.length);
    for (let s = 0; s < first.curve.segments.length; s += 7) {
      for (const t of [0, 0.5, 1]) {
        const a = first.curve.segments[s]!.position(t);
        const b = second.curve.segments[s]!.position(t);
        expect(b.x).toBe(a.x);
        expect(b.y).toBe(a.y);
      }
    }
    // Linear scaling guard: node count follows arc length (winding
    // handwriting packs many arc units per sample), and the mesh stays
    // proportional to the tessellated spine.
    expect(first.nodes.length).toBeLessThanOrEqual(stroke.length * 10);
    expect(first.polygon.length).toBeGreaterThan(first.nodes.length);
  });

  it('handles slow handwriting without degenerate segments', () => {
    const geometry = compileInkStroke(slowHandwritingCurve(), BALL_PEN_BRUSH);
    expect(geometry.nodes.length).toBeGreaterThanOrEqual(2);
    expect(polygonArea(geometry.polygon)).toBeGreaterThan(0);
  });

  it('builds a closed filled ring around a fast diagonal', () => {
    const geometry = compileInkStroke(fastDiagonal(), BALL_PEN_BRUSH);
    expect(geometry.polygon.length).toBeGreaterThanOrEqual(8);
    expect(polygonArea(geometry.polygon)).toBeGreaterThan(0);
    for (const p of geometry.polygon) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(geometry.bounds.x).toBeLessThanOrEqual(0);
    expect(geometry.bounds.y).toBeLessThanOrEqual(0);
    expect(geometry.bounds.x + geometry.bounds.width).toBeGreaterThanOrEqual(
      220,
    );
    expect(geometry.bounds.y + geometry.bounds.height).toBeGreaterThanOrEqual(
      154,
    );
  });
});

function sCurveFixture(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    out.push({
      x: t * 120,
      y: 40 + Math.sin(t * Math.PI * 2) * 22,
      pressure: 0.55,
      dt: i * 8,
    });
  }
  return out;
}

describe('pressure filtering', () => {
  const rampBrush = () =>
    resolveBrushSpec({
      size: 4,
      stabilization: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
      pressure: { enabled: true, minFactor: 0.5, maxFactor: 2, curve: 2 },
    });

  it('maps the pressure ramp through the curve without collapsing', () => {
    const geometry = compileInkStroke(pressureRamp(), rampBrush(), {
      spacing: 100,
    });
    expect(geometry.nodes[0]!.width).toBeCloseTo(4 * (0.5 + 1.5 * 0.01), 0);
    const last = geometry.nodes[geometry.nodes.length - 1]!;
    expect(Math.abs(last.width - 8)).toBeLessThan(0.3);
    for (const node of geometry.nodes) {
      expect(node.width).toBeCloseTo(
        4 * (0.5 + 1.5 * Math.pow(node.pressure, 2)),
        6,
      );
    }
    const mid = geometry.nodes[Math.floor(geometry.nodes.length / 2)]!;
    expect(mid.width).toBeGreaterThan(4 * 0.5);
  });

  it('holds constant width when pressure response is disabled', () => {
    const brush = resolveBrushSpec({
      stabilization: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
      pressure: { enabled: false, minFactor: 0.2, maxFactor: 3, curve: 1 },
    });
    const geometry = compileInkStroke(pressureRamp(), brush, { spacing: 100 });
    for (const node of geometry.nodes) {
      expect(node.width).toBeCloseTo(3, 6);
    }
  });

  it('derives lighter widths for faster motion when velocity pressure is on', () => {
    const samples: InkSample[] = [
      { x: 0, y: 0, dt: 0 },
      { x: 10, y: 0, dt: 100 },
      { x: 50, y: 0, dt: 110 },
    ];
    const brush = resolveBrushSpec({
      stabilization: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
      velocityPressure: true,
      pressure: { enabled: true, minFactor: 0.5, maxFactor: 1.5, curve: 1 },
    });
    const geometry = compileInkStroke(samples, brush, { spacing: 100 });
    const first = geometry.nodes[0]!.width;
    const last = geometry.nodes[geometry.nodes.length - 1]!.width;
    expect(first).toBeGreaterThan(last);
  });

  it('falls back to neutral width without timing under velocity pressure', () => {
    const samples: InkSample[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 50, y: 0 },
    ];
    const brush = resolveBrushSpec({
      stabilization: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
      velocityPressure: true,
      pressure: { enabled: true, minFactor: 0.5, maxFactor: 1.5, curve: 1 },
    });
    const geometry = compileInkStroke(samples, brush, { spacing: 100 });
    for (const node of geometry.nodes) {
      expect(node.width).toBeCloseTo(3, 6);
    }
  });
});

describe('taper', () => {
  it('narrows both ends while the middle holds full width', () => {
    const samples: InkSample[] = Array.from({ length: 101 }, (_, i) => ({
      x: i,
      y: 0,
      pressure: 0.5,
    }));
    const brush = resolveBrushSpec({
      stabilization: 0,
      streamline: 0,
      taperStart: 0.2,
      taperEnd: 0.2,
      pressure: { enabled: true, minFactor: 1, maxFactor: 1, curve: 1 },
    });
    const geometry = compileInkStroke(samples, brush);
    const mid = geometry.nodes[Math.floor(geometry.nodes.length / 2)]!;
    expect(mid.width).toBeCloseTo(3, 1);
    expect(geometry.nodes[0]!.width).toBeLessThan(mid.width * 0.5);
    const last = geometry.nodes[geometry.nodes.length - 1]!;
    expect(last.width).toBeLessThan(mid.width * 0.5);
    // Taper varies smoothly along the run (no width stair-steps).
    const widths = geometry.nodes.map((n) => n.width);
    for (let i = 1; i < widths.length; i++) {
      const rel =
        Math.abs(widths[i]! - widths[i - 1]!) / Math.max(widths[i]!, 1e-9);
      expect(rel).toBeLessThan(0.3);
    }
  });

  it('does not pinch the middle when tapers overlap', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    const brush = { ...BALL_PEN_BRUSH, taperStart: 1, taperEnd: 1 };
    const geometry = compileInkStroke(line, brush, { spacing: 100 });
    const widths = geometry.nodes.map((n) => n.width);
    const mid = widths[Math.floor(widths.length / 2)]!;
    const max = Math.max(...widths);
    expect(mid).toBeGreaterThan(max * 0.9);
  });
});

describe('flat nibs and tilt', () => {
  const flatBrush = () =>
    resolveBrushSpec({
      size: 4,
      stabilization: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
      pressure: { enabled: true, minFactor: 1, maxFactor: 1, curve: 1 },
      tip: { shape: 'flat', angle: 0, aspect: 0 },
    });
  const horizontal: InkSample[] = [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 100, y: 0, pressure: 0.5 },
  ];
  const vertical: InkSample[] = [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 0, y: 100, pressure: 0.5 },
  ];

  it('draws broad strokes across the nib edge and hairlines along it', () => {
    const across = compileInkStroke(vertical, flatBrush(), { spacing: 100 });
    const along = compileInkStroke(horizontal, flatBrush(), { spacing: 100 });
    const midAcross = across.nodes[Math.floor(across.nodes.length / 2)]!;
    const midAlong = along.nodes[Math.floor(along.nodes.length / 2)]!;
    expect(midAcross.width).toBeCloseTo(4, 6);
    expect(midAlong.width).toBeGreaterThan(0);
    expect(midAlong.width).toBeLessThan(midAcross.width * 0.3);
  });

  it('rotates the nib with barrel twist', () => {
    const twisted: InkSample[] = horizontal.map((s) => ({
      ...s,
      twist: Math.PI / 2,
    }));
    const geometry = compileInkStroke(twisted, flatBrush(), { spacing: 100 });
    const mid = geometry.nodes[Math.floor(geometry.nodes.length / 2)]!;
    expect(mid.width).toBeCloseTo(4, 6);
  });

  it('widens pencil marks when the barrel tilts', () => {
    const upright: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 100, y: 0, pressure: 0.5 },
    ];
    const tilted: InkSample[] = upright.map((s) => ({
      ...s,
      tilt: { x: 0.7, y: 0 },
    }));
    const plain = compileInkStroke(upright, PENCIL_BRUSH, { spacing: 100 });
    const shaded = compileInkStroke(tilted, PENCIL_BRUSH, { spacing: 100 });
    const midPlain = plain.nodes[Math.floor(plain.nodes.length / 2)]!;
    const midShaded = shaded.nodes[Math.floor(shaded.nodes.length / 2)]!;
    expect(midShaded.width / midPlain.width).toBeCloseTo(
      1 + 0.8 * (0.7 / (Math.PI / 2)),
      2,
    );
  });

  it('ignores tilt for brushes with no tilt response', () => {
    const tilted: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5, tilt: { x: 0.7, y: 0.4 } },
      { x: 100, y: 0, pressure: 0.5, tilt: { x: 0.7, y: 0.4 } },
    ];
    const geometry = compileInkStroke(tilted, BALL_PEN_BRUSH, {
      spacing: 100,
    });
    const plain = compileInkStroke(
      tilted.map(({ tilt, ...rest }) => rest),
      BALL_PEN_BRUSH,
      { spacing: 100 },
    );
    expect(geometry.nodes.map((n) => n.width)).toEqual(
      plain.nodes.map((n) => n.width),
    );
  });
});

describe('brush families', () => {
  it('compiles S-curves through every brush without invalid geometry', () => {
    for (const kind of [
      'ball',
      'fountain',
      'brush',
      'pencil',
      'highlighter',
    ] as const) {
      const brush = brushPresetForKind(kind);
      const geometry = compileInkStroke(sCurveFixture(), brush);
      expect(geometry.nodes.length).toBeGreaterThan(2);
      expect(geometry.polygon.length).toBeGreaterThanOrEqual(8);
      for (const p of geometry.polygon) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      for (const n of geometry.nodes) {
        expect(Number.isFinite(n.width)).toBe(true);
        expect(n.width).toBeGreaterThanOrEqual(0);
      }
      expect(polygonArea(geometry.polygon)).toBeGreaterThan(0);
    }
  });

  it('holds highlighter ribbons at constant width with flush ends', () => {
    const spine = (pressure: number): InkSample[] => [
      { x: 0, y: 0, pressure },
      { x: 100, y: 0, pressure },
    ];
    const light = compileInkStroke(spine(0), HIGHLIGHTER_BRUSH);
    const heavy = compileInkStroke(spine(1), HIGHLIGHTER_BRUSH);
    expect(light.bounds.height).toBeCloseTo(heavy.bounds.height, 6);
    expect(light.bounds.height).toBeCloseTo(HIGHLIGHTER_BRUSH.size, 0);
    expect(light.bounds.x).toBeCloseTo(0, 0);
    expect(light.bounds.x + light.bounds.width).toBeCloseTo(100, 0);
    const dot = compileInkStroke([{ x: 5, y: 5 }], HIGHLIGHTER_BRUSH);
    expect(dot.polygon).toHaveLength(4);
    expect(dot.bounds).toEqual({ x: -2, y: -2, width: 14, height: 14 });
  });
});
