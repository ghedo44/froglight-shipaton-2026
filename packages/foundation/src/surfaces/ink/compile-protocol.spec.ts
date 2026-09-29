/**
 * Worker compile-protocol twin tests.
 *
 * The worker runs the SAME `compileInkStroke` implementation, but its
 * output crosses a structured-clone boundary that cannot carry the curve
 * segment closures. This suite pins the transfer contract:
 *
 * - render-consumed geometry (`nodes`/`polygon`/`bounds`/`mesh`)
 *   transfers VERBATIM (exact equality after a real `structuredClone`);
 * - curve summaries (control counts, dots, run flags) transfer exactly;
 * - rehydrated closures reproduce every transferred vertex EXACTLY
 *   (1e-9) and track mid-span positions within tessellation tolerance.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH, HIGHLIGHTER_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  rehydrateCompiledInk,
  serializeCompiledInk,
} from './compile-protocol.js';
import {
  fastDiagonal,
  longStroke,
  pressureRamp,
  sharpCorner,
  smallLoop,
} from './fixtures.js';
import type { InkBrushSpec } from './brush.js';
import type { InkSample } from '../model.js';

function roundTrip(samples: InkSample[], brush: InkBrushSpec) {
  const sync = compileInkStroke(samples, brush);
  // The real serialization boundary (structured-clone safe plain data).
  const cloned = structuredClone(serializeCompiledInk(sync));
  return { sync, worker: rehydrateCompiledInk(cloned) };
}

function expectVerbatimTransfer(samples: InkSample[], brush: InkBrushSpec) {
  const { sync, worker } = roundTrip(samples, brush);
  expect(worker.nodes).toEqual(sync.nodes);
  expect(worker.polygon).toEqual(sync.polygon);
  expect(worker.bounds).toEqual(sync.bounds);
  expect(worker.mesh.left).toEqual(sync.mesh.left);
  expect(worker.mesh.right).toEqual(sync.mesh.right);
  expect(worker.mesh.ring).toEqual(sync.mesh.ring);
  expect([...worker.mesh.leftFans.entries()]).toEqual([
    ...sync.mesh.leftFans.entries(),
  ]);
  expect([...worker.mesh.rightFans.entries()]).toEqual([
    ...sync.mesh.rightFans.entries(),
  ]);
  expect(worker.curve.controlCount).toBe(sync.curve.controlCount);
  expect(worker.curve.cornerCount).toBe(sync.curve.cornerCount);
  expect(worker.curve.dot).toEqual(sync.curve.dot);
  expect(worker.curve.segments.length).toBe(sync.curve.segments.length);
  expect(worker.curve.segments.map((s) => s.startsRun === true)).toEqual(
    sync.curve.segments.map((s) => s.startsRun === true),
  );
  return { sync, worker };
}

describe('worker transfer parity', () => {
  it.each([
    ['diagonal', () => fastDiagonal(), BALL_PEN_BRUSH],
    ['long stroke', () => longStroke(1200), BALL_PEN_BRUSH],
    ['corner', () => sharpCorner(), BALL_PEN_BRUSH],
    ['loop', () => smallLoop(), BALL_PEN_BRUSH],
    ['pressure ramp', () => pressureRamp(), BALL_PEN_BRUSH],
    ['highlighter', () => longStroke(400), HIGHLIGHTER_BRUSH],
  ])('%s transfers verbatim', (_name, make, brush) => {
    expectVerbatimTransfer(make(), brush);
  });

  it('dot strokes (fewer than two controls) round-trip', () => {
    const { sync, worker } = roundTrip(
      [{ x: 10, y: 10, pressure: 0.5 }],
      BALL_PEN_BRUSH,
    );
    expect(worker.nodes).toEqual(sync.nodes);
    expect(worker.polygon).toEqual(sync.polygon);
    expect(worker.bounds).toEqual(sync.bounds);
    expect(worker.curve.dot).toEqual(sync.curve.dot);
  });

  it('empty input round-trips', () => {
    const { sync, worker } = roundTrip([], BALL_PEN_BRUSH);
    expect(worker.nodes).toEqual([]);
    expect(worker.polygon).toEqual([]);
    expect(worker.curve.segments).toEqual([]);
    expect(sync.curve.segments).toEqual([]);
  });
});

describe('rehydrated closures', () => {
  it('reproduces every transferred vertex exactly', () => {
    for (const make of [fastDiagonal, () => longStroke(800), sharpCorner]) {
      const { worker } = roundTrip(make(), BALL_PEN_BRUSH);
      for (const node of worker.nodes) {
        const segment = worker.curve.segments[node.segmentIndex];
        expect(segment).toBeDefined();
        const at = segment!.position(node.u);
        expect(at.x).toBeCloseTo(node.x, 9);
        expect(at.y).toBeCloseTo(node.y, 9);
      }
    }
  });

  it('tracks mid-span positions within tessellation tolerance', () => {
    const samples = longStroke(600);
    const { sync, worker } = roundTrip(samples, BALL_PEN_BRUSH);
    expect(sync.curve.segments.length).toBeGreaterThan(0);
    expect(worker.curve.segments.length).toBe(sync.curve.segments.length);
    // Mid-span samples across several segments: rehydrated (polyline)
    // vs committed (spline) agree within the tessellation error budget.
    for (let s = 0; s < sync.curve.segments.length; s += 3) {
      for (const u of [0.25, 0.5, 0.75]) {
        const a = sync.curve.segments[s]!.position(u);
        const b = worker.curve.segments[s]!.position(u);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.6);
      }
    }
  });

  it('rehydrated tangents stay unit-length and consistent', () => {
    const { worker } = roundTrip(sharpCorner(), BALL_PEN_BRUSH);
    for (const segment of worker.curve.segments) {
      for (const u of [0, 0.5, 1]) {
        const t = segment.tangent(u);
        expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 6);
      }
    }
  });
});
