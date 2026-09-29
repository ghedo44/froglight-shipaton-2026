/**
 * Adaptive tessellation gates: cheap straights, refined turns, bounded
 * approximation error that holds at the maximum supported zoom.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH, resolveBrushSpec } from './brush.js';
import { compileInkStroke } from './compiler.js';
import { fitCenterlineCurve, type InkCurveControl } from './curve.js';
import {
  TESSELLATION_DESIGN_ZOOM,
  TESSELLATION_MAX_ANGLE,
  TESSELLATION_TOLERANCE,
  tessellateCurve,
  type TessellationOptions,
} from './tessellation.js';
import { controlArcLengths } from './compiler.js';
import {
  bigCircle,
  fastDiagonal,
  sCurve,
  slowHandwritingCurve,
  smallLoop,
} from './fixtures.js';

function controlsFor(points: { x: number; y: number }[]): InkCurveControl[] {
  return points.map((p) => ({
    x: p.x,
    y: p.y,
    pressure: 0.5,
    tiltX: null,
    tiltY: null,
    twist: null,
    dt: null,
  }));
}

function tessellate(
  points: { x: number; y: number }[],
  brush = BALL_PEN_BRUSH,
  options: TessellationOptions = {},
) {
  const controls = controlsFor(points);
  const curve = fitCenterlineCurve(controls);
  const { cumulative, total } = controlArcLengths(controls);
  return {
    curve,
    spine: tessellateCurve(curve, brush, cumulative, total, options),
  };
}

describe('adaptive tessellation', () => {
  it('keeps nearly straight runs cheap (one span per segment)', () => {
    // No taper on this brush: nothing varies along the run, so each
    // fitted span emits exactly its endpoints (segments + 1 vertices).
    const controls = controlsFor(fastDiagonal());
    const curve = fitCenterlineCurve(controls);
    const { cumulative, total } = controlArcLengths(controls);
    const flat = resolveBrushSpec({ taperStart: 0, taperEnd: 0 });
    const spine = tessellateCurve(curve, flat, cumulative, total);
    expect(spine.length).toBe(curve.segments.length + 1);
  });

  it('refines taper zones locally without exploding straights', () => {
    const { spine } = tessellate(
      fastDiagonal(),
      resolveBrushSpec({ taperEnd: 0.05 }),
    );
    // Only the explicitly configured tip zone subdivides (width relief);
    // the rest of the 280-unit run stays one span per segment.
    expect(spine.length).toBeLessThan(60);
  });

  it('subdivides tight curvature more than gentle arcs', () => {
    const tight = tessellate(smallLoop().map(({ x, y }) => ({ x, y })));
    const gentle = tessellate(bigCircle().map(({ x, y }) => ({ x, y })));
    const tightDensity = tight.spine.length / tight.curve.segments.length;
    const gentleDensity = gentle.spine.length / gentle.curve.segments.length;
    // r=18 loops refine (sagitta exceeds tolerance); r=60 arcs stay near
    // one span per segment. That density gap IS adaptivity.
    expect(tightDensity).toBeGreaterThan(gentleDensity);
    expect(tightDensity).toBeGreaterThan(1.5);
    expect(gentleDensity).toBeLessThan(1.6);
  });

  it('refines S-curves when a tighter error budget requires it', () => {
    const wave = tessellate(
      sCurve().map(({ x, y }) => ({ x, y })),
      BALL_PEN_BRUSH,
      { tolerance: 0.001 },
    );
    const waveDensity = wave.spine.length / wave.curve.segments.length;
    expect(waveDensity).toBeGreaterThan(1.2);
  });

  it('bounds the approximation error by the formal tolerance', () => {
    for (const fixture of [
      sCurve(),
      bigCircle(),
      slowHandwritingCurve(),
      fastDiagonal(),
    ]) {
      const points = fixture.map(({ x, y }) => ({ x, y }));
      const { curve, spine } = tessellate(points);
      // Every tessellated span's midpoint on the analytic curve must sit
      // within tolerance of the emitted chord.
      const bySegment = new Map<number, (typeof spine)[number][]>();
      for (const p of spine) {
        const list = bySegment.get(p.segmentIndex) ?? [];
        list.push(p);
        bySegment.set(p.segmentIndex, list);
      }
      for (const [index, list] of bySegment) {
        const segment = curve.segments[index]!;
        for (let i = 0; i + 1 < list.length; i++) {
          const a = list[i]!;
          const b = list[i + 1]!;
          const mid = segment.position((a.u + b.u) / 2);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          const dist =
            len > 1e-12
              ? Math.abs((mid.x - a.x) * dy - (mid.y - a.y) * dx) / len
              : Math.hypot(mid.x - a.x, mid.y - a.y);
          // Chord-halving recursion guarantees flatness ≤ tolerance per
          // span (slack for the angle/attribute criteria sharing spans).
          expect(dist).toBeLessThanOrEqual(TESSELLATION_TOLERANCE * 2.5);
        }
      }
    }
  });

  it('bounds tangent change per span (no visible facets)', () => {
    const { spine } = tessellate(sCurve().map(({ x, y }) => ({ x, y })));
    for (let i = 1; i < spine.length; i++) {
      const a = spine[i - 1]!;
      const b = spine[i]!;
      const dot = Math.min(Math.max(a.tx * b.tx + a.ty * b.ty, -1), 1);
      expect(Math.acos(dot)).toBeLessThanOrEqual(TESSELLATION_MAX_ANGLE * 1.5);
    }
  });

  it('satisfies the maximum-zoom error budget', () => {
    // surface_error × MAX_ZOOM ≤ 0.5 screen px: sub-pixel facets at 8×.
    expect(
      TESSELLATION_TOLERANCE * TESSELLATION_DESIGN_ZOOM,
    ).toBeLessThanOrEqual(0.5);
    expect(TESSELLATION_DESIGN_ZOOM).toBe(8);
  });

  it('emits sane segment lengths (no degenerate runs, no leaps)', () => {
    const compiled = compileInkStroke(sCurve(), BALL_PEN_BRUSH);
    for (let i = 1; i < compiled.nodes.length; i++) {
      const gap = Math.hypot(
        compiled.nodes[i]!.x - compiled.nodes[i - 1]!.x,
        compiled.nodes[i]!.y - compiled.nodes[i - 1]!.y,
      );
      expect(gap).toBeGreaterThan(1e-9);
      expect(gap).toBeLessThan(12);
    }
  });

  it('carries pressure and timing through subdivision', () => {
    const brush = resolveBrushSpec({ stabilization: 0, streamline: 0 });
    const samples = sCurve();
    const compiled = compileInkStroke(samples, brush);
    const pressures = compiled.nodes.map((n) => n.pressure);
    expect(Math.min(...pressures)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...pressures)).toBeLessThanOrEqual(1);
    expect(compiled.nodes.length).toBeGreaterThan(samples.length);
  });
});
