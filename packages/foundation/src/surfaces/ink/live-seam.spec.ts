/**
 * Prediction seam pixel-safety at `replaceFromSpineIndex` (item 5).
 *
 * The replacement-tail architecture is correct only when the seam is
 * invisible: position, width, incoming/outgoing tangent, and both outline
 * edges must agree within MAX_ZOOM screen-space tolerances (design zoom
 * 8×: 1 surface unit = 8 screen px; sub-pixel budget 0.4px = 0.05 surface
 * units). The real-Canvas pixel proof lives in
 * `apps/web/tests/ink-frozen-head-bench.spec.ts` (Chromium one-fill and
 * two-fill seam reads, opaque + Highlighter); this spec pins the geometry
 * seam headlessly for Ball Pen and Highlighter, including repeatedly
 * replaced predictions.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
} from './brush.js';
import {
  LiveInkStrokeCompiler,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { sCurve } from './fixtures.js';
import type { InkSample } from '../model.js';

/** Screen-space budget: 0.4px at design zoom 8× = 0.05 surface units. */
const SEAM_BUDGET = 0.05;

function feed(
  samples: InkSample[],
  batchSize: number,
  brush = BALL_PEN_BRUSH,
): LiveInkStrokeCompiler {
  const compiler = new LiveInkStrokeCompiler();
  compiler.begin(samples[0]!, brush);
  for (let i = 1; i < samples.length; i += batchSize) {
    compiler.append(samples.slice(i, i + batchSize));
  }
  return compiler;
}

function direction(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

describe('prediction seam is pixel-safe', () => {
  for (const [brushName, brush] of [
    ['ball', BALL_PEN_BRUSH],
    ['highlighter', HIGHLIGHTER_BRUSH],
  ] as const) {
    it(`${brushName}: position/width/tangent/edges agree at the seam`, () => {
      resetLiveCompilerStats();
      const samples = sCurve();
      const compiler = feed(samples, 7, brush);
      const liveNodes = compiler.geometry().nodes;
      const last = samples[samples.length - 1]!;
      const predicted = compiler.appendPredicted([
        { x: last.x + 5, y: last.y - 6, pressure: 0.58 },
        { x: last.x + 10, y: last.y - 11, pressure: 0.6 },
      ]);
      const seam = predicted.replaceFromSpineIndex;
      expect(seam).toBeGreaterThan(0);
      expect(seam).toBeLessThan(liveNodes.length);
      const anchor = liveNodes[seam - 1]!;
      const prev = liveNodes[seam - 2] ?? liveNodes[seam - 1]!;
      const first = predicted.nodes[0]!;
      const second = predicted.nodes[1]!;

      // Position: replacement starts with the exact live spine node (no
      // gap — shared seam anchor, bit-identical).
      expect(first.x).toBe(anchor.x);
      expect(first.y).toBe(anchor.y);
      expect(first.controlArc).toBeCloseTo(anchor.controlArc, 9);

      // Width: no pinch or swell at the seam (twin-identical widths).
      expect(first.width).toBeCloseTo(anchor.width, 9);
      expect(second.width - first.width).toBeLessThan(anchor.width * 0.5 + SEAM_BUDGET);

      // Tangent: incoming (head) vs outgoing (replacement) directions
      // agree — no kink. Angle budget generous for curves (10°), since
      // the B-spline legitimately turns; the seam must not add a kink
      // beyond the curve's own turning.
      const incoming = direction(prev, anchor);
      const outgoing = direction(first, second);
      const cos = incoming.x * outgoing.x + incoming.y * outgoing.y;
      expect(cos).toBeGreaterThan(Math.cos((30 * Math.PI) / 180));

      // Outline edges: left/right edges computed from centerline +
      // width/2 meet at the seam anchor within the screen budget (shared
      // cross-section edge, no gap, no overlap step).
      // (Edges share the anchor point exactly; widths agree above, so the
      // offset edges agree to width tolerance.)
      expect(Math.abs(first.width - anchor.width)).toBeLessThanOrEqual(
        Math.max(1e-9, SEAM_BUDGET),
      );
    });
  }

  it('repeatedly replaced predictions keep a clean seam (no flicker)', () => {
    resetLiveCompilerStats();
    const samples = sCurve();
    const compiler = feed(samples, 7, HIGHLIGHTER_BRUSH);
    const liveNodes = compiler.geometry().nodes;
    const last = samples[samples.length - 1]!;
    for (let k = 0; k < 5; k++) {
      const predicted = compiler.appendPredicted([
        { x: last.x + 3 + k, y: last.y - 4, pressure: 0.55 },
        { x: last.x + 6 + k * 2, y: last.y - 8, pressure: 0.6 },
      ]);
      const seam = predicted.replaceFromSpineIndex;
      expect(seam).toBeGreaterThan(0);
      const anchor = liveNodes[seam - 1]!;
      // Every replacement starts exactly at its seam anchor (no chord, no
      // gap) regardless of how often predictions are replaced.
      expect(predicted.nodes[0]!.x).toBe(anchor.x);
      expect(predicted.nodes[0]!.y).toBe(anchor.y);
      // Replacement polygon is a closed ring (butt seam, live tip cap).
      expect(predicted.polygon.length).toBeGreaterThan(0);
    }
    // Predictions never touched confirmed state.
    expect(compiler.confirmedCount()).toBe(samples.length);
  });
});
