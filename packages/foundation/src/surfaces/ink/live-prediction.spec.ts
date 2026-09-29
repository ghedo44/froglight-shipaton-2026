/**
 * Predicted tails continue the actual live state (never a fresh-compile
 * seam) and publish mutable-tail replacement geometry (never confirmed
 * history, never canonical).
 *
 * Screen-space budgets (design zoom 8×, 1 surface unit = 8 screen px):
 * arc-aligned twin matching uses 0.05 surface units = 0.4 screen px
 * (sub-pixel, plausibly invisible) for arc correspondence plus
 * 1e-4-exact position/width/pressure agreement (twin-identical
 * subdivision, not visual equivalence — same incremental stage
 * composition, so digits agree). The A/B parity test holds the same
 * sub-pixel budget in the mutable region. Live→commit convergence
 * elsewhere stays at 0.5 screen px at 8× (0.0625 surface units).
 *
 * The centerpiece is the twin test: predictions fed to one compiler must
 * node-match the tail produced by confirming the same samples on an
 * identically-fed twin — proving resample grid phase, pressure-filter
 * settling, stabilization EMA, fairing and curve context are inherited
 * at the frontier rather than restarted.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  brushPresetForKind,
} from './brush.js';
import {
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { pressureRamp, sCurve } from './fixtures.js';
import type { InkBrushSpec } from './brush.js';
import type { InkSample } from '../model.js';

function feed(
  samples: InkSample[],
  batchSize: number,
  brush: InkBrushSpec,
): LiveInkStrokeCompiler {
  const compiler = new LiveInkStrokeCompiler();
  compiler.begin(samples[0]!, brush);
  for (let i = 1; i < samples.length; i += batchSize) {
    compiler.append(samples.slice(i, i + batchSize));
  }
  return compiler;
}

function diagonal(count: number): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 0.7, y: i * 0.45, pressure: 0.5 });
  }
  return out;
}

describe('predicted tails continue live state', () => {
  it('twin-matches the tail that confirming would produce', () => {
    resetLiveCompilerStats();
    const brush = brushPresetForKind('brush');
    const samples = sCurve();
    const last = samples[samples.length - 1]!;
    const predictedSamples: InkSample[] = [
      { x: last.x + 3, y: last.y - 4, pressure: 0.55 },
      { x: last.x + 6, y: last.y - 8, pressure: 0.6 },
      { x: last.x + 9, y: last.y - 12, pressure: 0.62 },
    ];
    const orig = feed(samples, 7, brush);
    const twin = feed(samples, 7, brush);
    const predicted = orig.appendPredicted(predictedSamples);
    twin.append(predictedSamples);
    const twinNodes = twin.geometry().nodes;
    const cont = predicted.nodes;
    // Replacement seam: head [0, replaceFrom) stays, replacement starts
    // with the exact live spine node before the seam (no gap, no overlap
    // area — single-fill safe for Highlighter).
    expect(cont.length).toBeGreaterThan(2);
    expect(predicted.replaceFromSpineIndex).toBeGreaterThan(0);
    expect(predicted.replacementTail).toBe(predicted.nodes);
    const liveNodes = orig.geometry().nodes;
    const seamAnchor = liveNodes[predicted.replaceFromSpineIndex - 1]!;
    expect(cont[0]!.x).toBe(seamAnchor.x);
    expect(cont[0]!.y).toBe(seamAnchor.y);
    expect(cont[0]!.controlArc).toBeCloseTo(seamAnchor.controlArc, 9);
    expect(predicted.replaceFromArc).toBeCloseTo(cont[1]!.controlArc, 1);
    // Arc-aligned comparison (twin re-tessellates its own tail density):
    // every replacement node matches the twin node at the same arc —
    // including the revised mutable tail, not just past-tip continuation.
    for (let i = 1; i < cont.length; i++) {
      const a = cont[i]!;
      let best = twinNodes[0]!;
      let bestD = Infinity;
      for (const b of twinNodes) {
        const d = Math.abs(b.controlArc - a.controlArc);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      expect(bestD).toBeLessThan(0.05);
      expect(a.x).toBeCloseTo(best.x, 4);
      expect(a.y).toBeCloseTo(best.y, 4);
      expect(a.width).toBeCloseTo(best.width, 4);
      expect(a.pressure).toBeCloseTo(best.pressure, 4);
    }
  });

  it('continues pressure ramps without restarting the filter', () => {
    resetLiveCompilerStats();
    const brush = BALL_PEN_BRUSH;
    const samples = pressureRamp();
    const orig = feed(samples, 5, brush);
    const twin = feed(samples, 5, brush);
    const last = samples[samples.length - 1]!;
    const predictedSamples: InkSample[] = [
      { x: last.x + 4, y: last.y + 1, pressure: 0.95 },
      { x: last.x + 8, y: last.y + 2, pressure: 0.97 },
    ];
    const predicted = orig.appendPredicted(predictedSamples);
    twin.append(predictedSamples);
    // Ramp continues through the seam twin-identically (a restarted
    // filter would sag back toward neutral/mid values and mismatch).
    const twinNodes = twin.geometry().nodes;
    expect(predicted.nodes.length).toBeGreaterThan(1);
    for (let i = 1; i < predicted.nodes.length; i++) {
      const a = predicted.nodes[i]!;
      let best = twinNodes[0]!;
      let bestD = Infinity;
      for (const b of twinNodes) {
        const d = Math.abs(b.controlArc - a.controlArc);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      expect(bestD).toBeLessThan(0.05);
      expect(a.pressure).toBeCloseTo(best.pressure, 4);
      expect(a.width).toBeCloseTo(best.width, 4);
    }
  });

  it('publishes mutable-tail replacement past the seam arc (never confirmed history)', () => {
    resetLiveCompilerStats();
    const compiler = feed(diagonal(300), 25, BALL_PEN_BRUSH);
    const before = compiler.geometry();
    const tipArc = before.nodes[before.nodes.length - 1]!.controlArc;
    const predicted = compiler.appendPredicted([
      { x: 220, y: 140, pressure: 0.5 },
      { x: 230, y: 146, pressure: 0.5 },
    ]);
    // Replacement starts before the tip (revised mutable tail) at the
    // explicit seam — head [0, replaceFrom) is stable confirmed context
    // the renderer keeps; old mutable tail at/after the seam is
    // suppressed (replaced, never repainted), so translucent tools
    // cannot darken history.
    expect(predicted.nodes.length).toBeGreaterThan(1);
    expect(predicted.replaceFromSpineIndex).toBeGreaterThan(0);
    expect(predicted.replaceFromSpineIndex).toBeLessThan(before.nodes.length);
    expect(predicted.replaceFromArc).toBeLessThanOrEqual(tipArc);
    expect(predicted.replacementTail).toBe(predicted.nodes);
    for (let i = 1; i < predicted.nodes.length; i++) {
      expect(predicted.nodes[i]!.controlArc).toBeGreaterThanOrEqual(
        predicted.replaceFromArc - 1e-6,
      );
    }
    // Past-tip continuation still exists (the truly new geometry).
    expect(predicted.nodes.some((n) => n.controlArc > tipArc + 1e-6)).toBe(
      true,
    );
    // Confirmed geometry is bit-identical with and without predictions.
    const after = compiler.geometry();
    expect(after.bounds).toEqual(before.bounds);
    expect(after.polygon).toEqual(before.polygon);
    expect(compiler.confirmedCount()).toBe(300);
  });

  it('keeps highlighter predictions overlap-free at the seam', () => {
    resetLiveCompilerStats();
    const compiler = feed(diagonal(200), 20, HIGHLIGHTER_BRUSH);
    const before = compiler.geometry();
    const predicted = compiler.appendPredicted([
      { x: 150, y: 96, pressure: 0.5 },
      { x: 160, y: 102, pressure: 0.5 },
    ]);
    expect(predicted.polygon.length).toBeGreaterThan(0);
    // Seam-exact replacement: the replacement starts at the live spine
    // before the mutable tail (head + replacement abut, no overlapping
    // area), and the confirmed head keeps its shape underneath (tools
    // suppress the old mutable tail while predicting; head + replacement
    // never double-paints).
    expect(predicted.replaceFromSpineIndex).toBeGreaterThan(0);
    const seamAnchor = before.nodes[predicted.replaceFromSpineIndex - 1]!;
    expect(predicted.nodes[0]!.x).toBe(seamAnchor.x);
    expect(predicted.nodes[0]!.y).toBe(seamAnchor.y);
    expect(predicted.frontier.x).toBeCloseTo(
      before.nodes[before.nodes.length - 1]!.x,
      9,
    );
    expect(predicted.frontier.y).toBeCloseTo(
      before.nodes[before.nodes.length - 1]!.y,
      9,
    );
    expect(compiler.geometry().polygon).toEqual(before.polygon);
  });

  it('matches committing the same points as real input in the mutable region (A/B parity)', () => {
    // A = confirmed state + predicted points (replacement tail).
    // B = same confirmed state + same points committed as real input.
    // The visible mutable region of A (replacement tail past the seam)
    // must closely match B's tail past the same seam — proving future
    // samples revise the mutable tail identically whether predicted or
    // confirmed (approximating B-spline locality, not append-only).
    resetLiveCompilerStats();
    const brush = brushPresetForKind('brush');
    const samples = sCurve();
    const last = samples[samples.length - 1]!;
    const extra: InkSample[] = [
      { x: last.x + 5, y: last.y - 6, pressure: 0.58 },
      { x: last.x + 10, y: last.y - 11, pressure: 0.6 },
      { x: last.x + 15, y: last.y - 15, pressure: 0.62 },
    ];
    const a = feed(samples, 7, brush);
    const b = feed(samples, 7, brush);
    const predicted = a.appendPredicted(extra);
    b.append(extra);
    const bNodes = b.geometry().nodes;
    // Seam shared: replacement starts at the same arc in both.
    expect(predicted.replaceFromSpineIndex).toBeGreaterThan(0);
    expect(predicted.replacementTail.length).toBeGreaterThan(2);
    // Every replacement node (past the seam anchor) matches B at the
    // same arc — mutable revision plus continuation, twin-identical.
    for (let i = 1; i < predicted.replacementTail.length; i++) {
      const node = predicted.replacementTail[i]!;
      let best = bNodes[0]!;
      let bestD = Infinity;
      for (const candidate of bNodes) {
        const d = Math.abs(candidate.controlArc - node.controlArc);
        if (d < bestD) {
          bestD = d;
          best = candidate;
        }
      }
      expect(bestD).toBeLessThan(0.05);
      expect(node.x).toBeCloseTo(best.x, 4);
      expect(node.y).toBeCloseTo(best.y, 4);
      expect(node.width).toBeCloseTo(best.width, 4);
      expect(node.pressure).toBeCloseTo(best.pressure, 4);
    }
    // Predicted data never entered canonical history: A still has the
    // original confirmed count, and committing A without predictions
    // equals B without the extra (predictions are ephemeral).
    expect(a.confirmedCount()).toBe(samples.length);
    expect(a.finish().polygon).toEqual(
      feed(samples, 7, brush).finish().polygon,
    );
  });

  it('replaces predictions ephemerally without touching confirmed state', () => {
    resetLiveCompilerStats();
    const compiler = feed(diagonal(200), 20, BALL_PEN_BRUSH);
    const clean = compiler.geometry();
    const first = compiler.appendPredicted([{ x: 500, y: 500, pressure: 1 }]);
    expect(first.polygon.length).toBeGreaterThan(0);
    const second = compiler.appendPredicted([
      { x: -100, y: -100, pressure: 0.2 },
      { x: -120, y: -110, pressure: 0.2 },
    ]);
    expect(second.polygon.length).toBeGreaterThan(0);
    expect(second.polygon).not.toEqual(first.polygon);
    // Neither prediction leaked into confirmed state or stats beyond
    // their own bounded compiles.
    expect(compiler.geometry().polygon).toEqual(clean.polygon);
    expect(compiler.confirmedCount()).toBe(200);
    expect(liveCompilerStats().predictedCompiles).toBe(2);
    expect(liveCompilerStats().fullCompiles).toBe(0);
    expect(liveCompilerStats().ringMaterializations).toBe(2);
    // Commit ignores predictions entirely.
    const ref = feed(diagonal(200), 20, BALL_PEN_BRUSH);
    expect(compiler.finish().polygon).toEqual(ref.finish().polygon);
  });

  it('tracks the live publish version it continues', () => {
    resetLiveCompilerStats();
    const compiler = feed(diagonal(100), 10, BALL_PEN_BRUSH);
    const last = compiler.append(diagonal(100).slice(90));
    const predicted = compiler.appendPredicted([
      { x: 80, y: 51, pressure: 0.5 },
    ]);
    expect(predicted.baseVersion).toBe(last.version);
  });
});
