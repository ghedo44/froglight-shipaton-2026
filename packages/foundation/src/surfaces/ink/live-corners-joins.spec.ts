/**
 * Hard C0 corner join semantics: intentional corners split the B-spline
 * into clamped runs sharing exactly one position with two tangents. A
 * single tessellated tangent cannot describe the discontinuity, so the
 * joint node carries both directions and the mesh joins them explicitly
 * (true miter within the limit, deterministic round fan past it) instead
 * of rounding the corner.
 *
 * Verification is layered: structural tags (run-boundary segments, joint
 * nodes), exact mesh-side join vertices (indexed by spine position — no
 * arm-side contamination), and end-to-end outline tip proximity plus
 * finiteness across the product matrix (pressure, nib, taper, live).
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  BRUSH_PEN_BRUSH,
  FOUNTAIN_PEN_BRUSH,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  fitCenterlineCurve,
  controlArcLengths,
  type InkCurveControl,
} from './curve.js';
import {
  LiveInkStrokeCompiler,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { tessellateCurve } from './tessellation.js';
import { buildStrokeMesh, MITER_FALLBACK_ANGLE } from './outline.js';
import type { InkBrushSpec } from './brush.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

const cornerControl = (
  x: number,
  y: number,
  pressure = 0.5,
): InkCurveControl => ({
  x,
  y,
  pressure,
  tiltX: null,
  tiltY: null,
  twist: null,
  dt: null,
});

/**
 * Two straight 100-unit arms meeting at C with turn angle `turnDeg`
 * (travel direction rotates by turnDeg at the corner). Dense 5-unit
 * samples with steady timing, like the established corner fixtures.
 */
function cornerStroke(turnDeg: number, pressure = 0.5): InkSample[] {
  const turn = (turnDeg * Math.PI) / 180;
  const out: InkSample[] = [];
  let dt = 0;
  for (let i = 0; i <= 20; i++) {
    out.push({ x: i * 5, y: 0, pressure, dt });
    dt += 8;
  }
  const dx = Math.cos(turn);
  const dy = Math.sin(turn);
  for (let i = 1; i <= 20; i++) {
    out.push({ x: 100 + i * 5 * dx, y: i * 5 * dy, pressure, dt });
    dt += 8;
  }
  return out;
}

/** Distance from p to the nearest polygon vertex. */
function minVertexDist(polygon: readonly Point[], p: Point): number {
  let best = Infinity;
  for (const q of polygon) {
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return Infinity;
    best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return best;
}

/** Outer-bisector miter tip for a turn of turnDeg at C (travel-based). */
function miterTip(c: Point, half: number, turnDeg: number): Point {
  // Test corners turn left from +x by turnDeg; the outer side is right.
  const inAngle = 0;
  const outAngle = (turnDeg * Math.PI) / 180;
  const n0 = { x: -Math.sin(inAngle), y: Math.cos(inAngle) };
  const n1 = { x: -Math.sin(outAngle), y: Math.cos(outAngle) };
  // Outer (right-side) normals, bisected.
  const bx = -n0.x - n1.x;
  const by = -n0.y - n1.y;
  const len = Math.hypot(bx, by) || 1;
  const dist = half / Math.cos((turnDeg * Math.PI) / 180 / 2);
  return { x: c.x + (bx / len) * dist, y: c.y + (by / len) * dist };
}

describe('hard corner join semantics', () => {
  it('tags run-boundary joints with both tangent directions', () => {
    const controls = [
      cornerControl(0, 0),
      cornerControl(50, 0),
      cornerControl(100, 0),
      cornerControl(100, 50),
      cornerControl(100, 100),
    ];
    const curve = fitCenterlineCurve(controls);
    // The second run's first span starts a new clamped run at the corner.
    const starts = curve.segments.filter((s) => s.startsRun === true);
    expect(starts.length).toBe(1);
    expect(curve.cornerCount).toBe(1);
    // The joint node carries incoming (+x) and outgoing (+y) tangents.
    const { cumulative, total } = controlArcLengths(controls);
    const spine = tessellateCurve(curve, BALL_PEN_BRUSH, cumulative, total);
    const tagged = spine.filter((p) => p.corner !== undefined);
    expect(tagged).toHaveLength(1);
    const tag = tagged[0]!.corner!;
    expect(tag.inTx).toBeCloseTo(1, 6);
    expect(tag.inTy).toBeCloseTo(0, 6);
    expect(tag.outTx).toBeCloseTo(0, 6);
    expect(tag.outTy).toBeCloseTo(1, 6);
    // Joint position is the shared corner exactly.
    expect(tagged[0]!.x).toBeCloseTo(100, 9);
    expect(tagged[0]!.y).toBeCloseTo(0, 9);
  });

  it('leaves smooth joints untagged', () => {
    const controls: InkCurveControl[] = [];
    for (let i = 0; i <= 12; i++) {
      controls.push(cornerControl(i * 10, Math.sin(i / 2) * 8));
    }
    const curve = fitCenterlineCurve(controls);
    expect(curve.segments.some((s) => s.startsRun === true)).toBe(false);
    const { cumulative, total } = controlArcLengths(controls);
    const spine = tessellateCurve(curve, BALL_PEN_BRUSH, cumulative, total);
    expect(spine.some((p) => p.corner !== undefined)).toBe(false);
  });

  for (const turnDeg of [60, 90, 120]) {
    it(`places the true outer miter vertex for a ${turnDeg}° corner`, () => {
      // Mesh sides indexed by spine position: exact join verification
      // with no arm-side contamination.
      const arms: InkCurveControl[] = [];
      const turn = (turnDeg * Math.PI) / 180;
      for (let i = 0; i <= 10; i++) {
        arms.push(cornerControl(i * 10, 0));
      }
      for (let i = 1; i <= 10; i++) {
        arms.push(
          cornerControl(100 + i * 10 * Math.cos(turn), i * 10 * Math.sin(turn)),
        );
      }
      const curve = fitCenterlineCurve(arms);
      expect(curve.cornerCount).toBe(1);
      const { cumulative, total } = controlArcLengths(arms);
      const spine = tessellateCurve(curve, BALL_PEN_BRUSH, cumulative, total);
      const cornerIdx = spine.findIndex((p) => p.corner !== undefined);
      expect(cornerIdx).toBeGreaterThan(0);
      const mesh = buildStrokeMesh(spine, 'round');
      const node = spine[cornerIdx]!;
      const half = node.width / 2;
      // Outer side is right for left turns: the miter vertex sits at the
      // exact offset-line intersection.
      const expected = miterTip({ x: 100, y: 0 }, half, turnDeg);
      const outer = mesh.right[cornerIdx]!;
      expect(outer.x).toBeCloseTo(expected.x, 3);
      expect(outer.y).toBeCloseTo(expected.y, 3);
      // Inner side stays beveled (no spike through the corner).
      const inner = mesh.left[cornerIdx]!;
      expect(Math.hypot(inner.x - 100, inner.y)).toBeLessThan(half * 1.5);
      for (const p of mesh.ring) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    });
  }

  it('emits a round fallback fan past the miter limit (hairpin)', () => {
    const arms: InkCurveControl[] = [];
    const turn = (170 * Math.PI) / 180;
    for (let i = 0; i <= 10; i++) {
      arms.push(cornerControl(i * 10, 0));
    }
    for (let i = 1; i <= 10; i++) {
      arms.push(
        cornerControl(100 + i * 10 * Math.cos(turn), i * 10 * Math.sin(turn)),
      );
    }
    expect(turn).toBeGreaterThan(MITER_FALLBACK_ANGLE);
    const curve = fitCenterlineCurve(arms);
    const { cumulative, total } = controlArcLengths(arms);
    const spine = tessellateCurve(curve, BALL_PEN_BRUSH, cumulative, total);
    const cornerIdx = spine.findIndex((p) => p.corner !== undefined);
    expect(cornerIdx).toBeGreaterThan(0);
    const mesh = buildStrokeMesh(spine, 'round');
    const node = spine[cornerIdx]!;
    const half = node.width / 2;
    // The outer fan follows the forward side of the cusp at nib radius.
    const fan = mesh.leftFans.get(cornerIdx) ?? mesh.rightFans.get(cornerIdx);
    expect(fan).toBeDefined();
    expect(fan!.length).toBeGreaterThanOrEqual(2);
    expect(fan!.length).toBeLessThanOrEqual(32);
    expect(Math.max(...fan!.map((p) => p.x))).toBeGreaterThan(
      node.x + half * 0.9,
    );
    for (const p of fan!) {
      const dist = Math.hypot(p.x - node.x, p.y - node.y);
      expect(dist).toBeGreaterThan(half * 0.8);
      expect(dist).toBeLessThan(half * 1.3);
    }
    for (const p of mesh.ring) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('keeps end-to-end corner outlines crisp across the matrix', () => {
    // Outline tip proximity from the node's own corner tag: a vertex
    // exists at the mesh-computed miter tip (crisp assembly) rather than
    // short of it (rounded). Covers pressure ramps, flat nibs, and
    // above-threshold turns. Sub-threshold input documents threshold
    // discipline (smooths sanely, never spikes).
    const cases: { name: string; brush: InkBrushSpec; samples: InkSample[] }[] =
      [
        { name: 'ball 90', brush: BALL_PEN_BRUSH, samples: cornerStroke(90) },
        {
          name: 'pressure ramp 90',
          brush: BALL_PEN_BRUSH,
          samples: cornerStroke(90).map((s, i, all) => ({
            ...s,
            pressure: 0.2 + (0.7 * i) / (all.length - 1),
          })),
        },
        {
          name: 'flat nib 90',
          brush: FOUNTAIN_PEN_BRUSH,
          samples: cornerStroke(90),
        },
        { name: 'ball 75', brush: BALL_PEN_BRUSH, samples: cornerStroke(75) },
        { name: 'ball 120', brush: BALL_PEN_BRUSH, samples: cornerStroke(120) },
      ];
    for (const { name, brush, samples } of cases) {
      const compiled = compileInkStroke(samples, brush);
      expect(compiled.polygon.length, name).toBeGreaterThan(8);
      const tagged = compiled.nodes.filter((n) => n.corner !== undefined);
      // Above-threshold turns split and tag exactly once (NMS: no
      // degenerate adjacent double-splits).
      expect(tagged, name).toHaveLength(1);
      const node = tagged[0]!;
      const half = node.width / 2;
      const tag = node.corner!;
      const d0 = { x: tag.inTx, y: tag.inTy };
      const d1 = { x: tag.outTx, y: tag.outTy };
      const cross = d0.x * d1.y - d0.y * d1.x;
      const outerLeft = cross < 0;
      const sx = outerLeft ? 1 : -1;
      const sy = outerLeft ? 1 : -1;
      const n0 = { x: -d0.y, y: d0.x };
      const n1 = { x: -d1.y, y: d1.x };
      const bx = sx * n0.x + sy * n1.x;
      const by = sx * n0.y + sy * n1.y;
      const len = Math.hypot(bx, by) || 1;
      const dot = Math.min(Math.max(d0.x * d1.x + d0.y * d1.y, -1), 1);
      const dist = half / Math.max(Math.cos(Math.acos(dot) / 2), 1e-9);
      const tip = {
        x: node.x + (bx / len) * dist,
        y: node.y + (by / len) * dist,
      };
      expect(minVertexDist(compiled.polygon, tip), name).toBeLessThan(
        Math.max(half * 0.3, 0.05),
      );
      for (const p of compiled.polygon) {
        expect(Number.isFinite(p.x), name).toBe(true);
        expect(Number.isFinite(p.y), name).toBe(true);
      }
    }
    // Sub-threshold input (60° turn) smooths by design: no split, no
    // spike, finite ring — threshold discipline, not a missed corner.
    const smooth = compileInkStroke(cornerStroke(60), BALL_PEN_BRUSH);
    expect(
      smooth.nodes.some((n) => n.corner !== undefined),
      '60° stays untagged',
    ).toBe(false);
    for (const p of smooth.polygon) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('miters a corner inside the taper zone', () => {
    const brush: InkBrushSpec = BRUSH_PEN_BRUSH;
    const turn = Math.PI / 2;
    const out: InkSample[] = [];
    let dt = 0;
    for (let i = 0; i <= 4; i++) {
      out.push({ x: i * 5, y: 0, pressure: 0.6, dt });
      dt += 8;
    }
    for (let i = 1; i <= 40; i++) {
      out.push({
        x: 20 + i * 5 * Math.cos(turn),
        y: i * 5 * Math.sin(turn),
        pressure: 0.6,
        dt,
      });
      dt += 8;
    }
    const compiled = compileInkStroke(out, brush);
    const tagged = compiled.nodes.filter((n) => n.corner !== undefined);
    expect(tagged).toHaveLength(1);
    const node = tagged[0]!;
    const half = node.width / 2;
    const tag = node.corner!;
    const d0 = { x: tag.inTx, y: tag.inTy };
    const d1 = { x: tag.outTx, y: tag.outTy };
    const cross = d0.x * d1.y - d0.y * d1.x;
    const outerLeft = cross < 0;
    const sx = outerLeft ? 1 : -1;
    const sy = outerLeft ? 1 : -1;
    const n0 = { x: -d0.y, y: d0.x };
    const n1 = { x: -d1.y, y: d1.x };
    const bx = sx * n0.x + sy * n1.x;
    const by = sx * n0.y + sy * n1.y;
    const len = Math.hypot(bx, by) || 1;
    const dot = Math.min(Math.max(d0.x * d1.x + d0.y * d1.y, -1), 1);
    const dist = half / Math.max(Math.cos(Math.acos(dot) / 2), 1e-9);
    const tip = {
      x: node.x + (bx / len) * dist,
      y: node.y + (by / len) * dist,
    };
    expect(minVertexDist(compiled.polygon, tip)).toBeLessThan(
      Math.max(half * 0.35, 0.05),
    );
    for (const p of compiled.polygon) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('matches live and committed corner joins', () => {
    resetLiveCompilerStats();
    const samples = cornerStroke(90);
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    for (let i = 1; i < samples.length; i += 5) {
      compiler.append(samples.slice(i, i + 5));
    }
    const live = compiler.geometry();
    const committed = compiler.finish();
    const liveTagged = live.nodes.filter((n) => n.corner !== undefined);
    const commitTagged = committed.nodes.filter((n) => n.corner !== undefined);
    // The incremental path carries join semantics: same single tag.
    expect(commitTagged).toHaveLength(1);
    expect(liveTagged).toHaveLength(1);
    const node = commitTagged[0]!;
    const half = node.width / 2;
    const tag = node.corner!;
    const d0 = { x: tag.inTx, y: tag.inTy };
    const d1 = { x: tag.outTx, y: tag.outTy };
    const cross = d0.x * d1.y - d0.y * d1.x;
    const outerLeft = cross < 0;
    const sx = outerLeft ? 1 : -1;
    const sy = outerLeft ? 1 : -1;
    const n0 = { x: -d0.y, y: d0.x };
    const n1 = { x: -d1.y, y: d1.x };
    const bx = sx * n0.x + sy * n1.x;
    const by = sx * n0.y + sy * n1.y;
    const len = Math.hypot(bx, by) || 1;
    const dot = Math.min(Math.max(d0.x * d1.x + d0.y * d1.y, -1), 1);
    const dist = half / Math.max(Math.cos(Math.acos(dot) / 2), 1e-9);
    const tip = {
      x: node.x + (bx / len) * dist,
      y: node.y + (by / len) * dist,
    };
    expect(minVertexDist(live.polygon, tip)).toBeLessThan(
      Math.max(half * 0.3, 0.05),
    );
    expect(minVertexDist(committed.polygon, tip)).toBeLessThan(
      Math.max(half * 0.3, 0.05),
    );
  });
});
