/**
 * Brush calibration gates for the continuous smooth-stroke pipeline.
 *
 * Preset values were re-derived on the new pipeline (pressure-first,
 * resample-then-stabilize on a uniform grid, continuous Laplacian
 * fairing) rather than blindly reused from the polyline renderer — where
 * the same numbers meant per-raw-sample smoothing instead of
 * device-independent per-grid-step smoothing. These tests pin the
 * resulting per-kind character so future tuning stays deliberate:
 *
 * - ball: faithful (sub-half-unit corner cut at production spacing),
 *   responsive, near-constant width;
 * - fountain: stronger fairing than ball, smooth nib transitions, no
 *   width spikes around tangents;
 * - brush: strongest fairing, expressive pressure range;
 * - pencil: mild fairing with tilt shading;
 * - highlighter: constant ribbon, flush ends.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  BRUSH_PEN_BRUSH,
  FOUNTAIN_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  PENCIL_BRUSH,
  type InkBrushSpec,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import { sCurve, sharpCorner, slowHandwritingCurve } from './fixtures.js';

/** Distance from the 90° corner vertex to the fitted centerline. */
function cornerCut(brush: InkBrushSpec): number {
  const compiled = compileInkStroke(sharpCorner(), brush);
  let best = Infinity;
  for (const segment of compiled.curve.segments) {
    for (let k = 0; k <= 16; k++) {
      const p = segment.position(k / 16);
      best = Math.min(best, Math.hypot(p.x - 100, p.y - 0));
    }
  }
  return best;
}

describe('brush calibration', () => {
  it('keeps the default ball pen faithful on sharp corners', () => {
    // Sub-half-unit cut at production spacing: sharp handwriting stays
    // sharp, while C1 continuity removes the angular facet.
    expect(cornerCut(BALL_PEN_BRUSH)).toBeLessThan(0.5);
  });

  it('orders fairing strength ball/pencil < fountain < brush', () => {
    const ball = cornerCut(BALL_PEN_BRUSH);
    const pencil = cornerCut(PENCIL_BRUSH);
    const fountain = cornerCut(FOUNTAIN_PEN_BRUSH);
    const brush = cornerCut(BRUSH_PEN_BRUSH);
    // Everyday writers stay faithful; expressive kinds round more.
    expect(ball).toBeLessThan(0.5);
    expect(pencil).toBeLessThan(0.6);
    expect(fountain).toBeGreaterThan(ball);
    expect(brush).toBeGreaterThan(fountain);
    // Even the strongest preset must not melt handwriting corners.
    expect(brush).toBeLessThan(4);
  });

  it('keeps ball width near-constant on steady handwriting', () => {
    const compiled = compileInkStroke(slowHandwritingCurve(), BALL_PEN_BRUSH);
    const widths = compiled.nodes.map((n) => n.width);
    // Mid-stroke (outside the end-taper tip): ordinary pressure wobble
    // moves width by a few percent, never collapses it.
    const mid = widths.slice(
      Math.floor(widths.length * 0.2),
      Math.floor(widths.length * 0.8),
    );
    for (const w of mid) {
      expect(w).toBeGreaterThan(BALL_PEN_BRUSH.size * 0.7);
      expect(w).toBeLessThan(BALL_PEN_BRUSH.size * 1.3);
    }
  });

  it('transitions fountain width smoothly around curve tangents', () => {
    const compiled = compileInkStroke(sCurve(), FOUNTAIN_PEN_BRUSH);
    const widths = compiled.nodes.map((n) => n.width);
    for (let i = 1; i < widths.length; i++) {
      const rel =
        Math.abs(widths[i]! - widths[i - 1]!) / Math.max(widths[i]!, 1e-9);
      expect(rel).toBeLessThan(0.35);
    }
  });

  it('holds the highlighter ribbon constant with flush ends', () => {
    const compiled = compileInkStroke(sCurve(), HIGHLIGHTER_BRUSH);
    for (const n of compiled.nodes) {
      expect(n.width).toBeCloseTo(HIGHLIGHTER_BRUSH.size, 6);
    }
    // Flush butt caps on a straight run: no round-cap overhang past the
    // endpoints along the stroke (perpendicular ribbon width overhangs
    // the sample bbox by exactly half the size — that is the marker).
    const straight = compileInkStroke(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      HIGHLIGHTER_BRUSH,
    );
    expect(straight.bounds.x).toBeCloseTo(0, 0);
    expect(straight.bounds.x + straight.bounds.width).toBeCloseTo(100, 0);
    expect(straight.bounds.height).toBeCloseTo(HIGHLIGHTER_BRUSH.size, 0);
  });
});
