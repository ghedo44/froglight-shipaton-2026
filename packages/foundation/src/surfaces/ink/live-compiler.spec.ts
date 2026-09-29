/**
 * Incremental live-stroke compiler over the continuous smooth-stroke
 * pipeline.
 *
 * Proves live ink updates are no longer cumulative O(n²): appending
 * confirmed batches performs zero full geometry compiles, predicted
 * input never touches confirmed state, and the commit-time `finish()`
 * matches a clean full `compileInkStroke()` pass exactly. Operation
 * counters (not wall-clock thresholds) make an O(n²) regression fail
 * deterministically, up to the canonical 10,000-point cap.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  brushPresetForKind,
} from './brush.js';
import { compileInkStroke } from './geometry.js';
import {
  LIVE_COMPILER_TAIL_WINDOW,
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import type { InkSample } from '../model.js';

function diagonal(count: number, pressure = 0.5): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 0.7, y: i * 0.45, pressure });
  }
  return out;
}

function batchesOf(samples: InkSample[], size: number): InkSample[][] {
  const out: InkSample[][] = [];
  for (let i = 0; i < samples.length; i += size) {
    out.push(samples.slice(i, i + size));
  }
  return out;
}

describe('LiveInkStrokeCompiler', () => {
  it('appends batches with zero full compiles during the live gesture', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const samples = diagonal(1000);
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    for (const batch of batchesOf(samples.slice(1), 25)) {
      const update = compiler.append(batch);
      expect(update.nodeCount).toBeGreaterThan(0);
      // Chunk publish, never a materialized ring on the hot path: the
      // mesh view carries the stroke, the ring stays null past the dot
      // phase.
      expect(update.mesh?.spineLength).toBeGreaterThan(0);
      expect(update.ring).toBeNull();
    }
    const stats = liveCompilerStats();
    expect(stats.fullCompiles).toBe(0);
    expect(stats.tailUpdates).toBe(1 + batchesOf(samples.slice(1), 25).length);
    // One clean full compile at commit — and only one.
    const committed = compiler.finish();
    expect(liveCompilerStats().fullCompiles).toBe(1);
    expect(committed.polygon.length).toBeGreaterThan(0);
  });

  it('commits geometry identical to a clean full compileInkStroke pass', () => {
    for (const kind of [
      'ball',
      'fountain',
      'brush',
      'pencil',
      'highlighter',
    ] as const) {
      resetLiveCompilerStats();
      const brush = brushPresetForKind(kind);
      const samples = diagonal(500).map((s, i) => ({
        ...s,
        pressure: (i % 100) / 100,
        tilt: { x: 0.3, y: -0.2 },
        twist: (i % 40) / 40 - 0.5,
      }));
      const compiler = new LiveInkStrokeCompiler();
      compiler.begin(samples[0]!, brush);
      for (const batch of batchesOf(samples.slice(1), 17)) {
        compiler.append(batch);
      }
      const committed = compiler.finish();
      const clean = compileInkStroke(samples, brush);
      expect(committed.bounds).toEqual(clean.bounds);
      expect(committed.polygon).toEqual(clean.polygon);
      expect(committed.nodes).toHaveLength(clean.nodes.length);
    }
  });

  it('scales to the canonical 10,000-point cap without full recompiles', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const samples = diagonal(10_000);
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    const batches = batchesOf(samples.slice(1), 100);
    for (const batch of batches) compiler.append(batch);
    const stats = liveCompilerStats();
    expect(stats.fullCompiles).toBe(0);
    expect(stats.tailUpdates).toBe(1 + batches.length);
    const committed = compiler.finish();
    expect(liveCompilerStats().fullCompiles).toBe(1);
    // Live preview converged on the committed result: same unified arc
    // and settled head widths, so bounds agree within the visual budget
    // (0.5 screen px at 8x zoom).
    const live = compiler.geometry();
    expect(Math.abs(live.bounds.x - committed.bounds.x)).toBeLessThan(0.0625);
    expect(Math.abs(live.bounds.width - committed.bounds.width)).toBeLessThan(
      0.0625,
    );
  });

  it('keeps per-batch work proportional to new/tail input, not history', () => {
    // Tail recomputation is bounded by the fixed window: appending one
    // sample to a long stroke touches O(window) spine nodes however long
    // the history grows. Pin the bound through node deltas.
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const history = diagonal(2000);
    compiler.begin(history[0]!, BALL_PEN_BRUSH);
    for (const batch of batchesOf(history.slice(1), 100)) {
      compiler.append(batch);
    }
    const before = compiler.geometry().nodes.length;
    compiler.append([{ x: 1400.7, y: 900.45, pressure: 0.5 }]);
    const after = compiler.geometry().nodes.length;
    // One new sample (plus resample subdivision of its segment) adds a
    // small bounded node delta — never a history-proportional rebuild.
    expect(after - before).toBeLessThanOrEqual(LIVE_COMPILER_TAIL_WINDOW * 4);
    expect(liveCompilerStats().fullCompiles).toBe(0);
  });

  it('never lets predicted input perturb confirmed geometry', () => {
    const samples = diagonal(200);
    const clean = new LiveInkStrokeCompiler();
    clean.begin(samples[0]!, BALL_PEN_BRUSH);
    for (const batch of batchesOf(samples.slice(1), 20)) clean.append(batch);
    const cleanGeometry = clean.geometry();

    const withPrediction = new LiveInkStrokeCompiler();
    withPrediction.begin(samples[0]!, BALL_PEN_BRUSH);
    for (const batch of batchesOf(samples.slice(1), 20)) {
      withPrediction.append(batch);
    }
    const predicted = withPrediction.appendPredicted([
      { x: 500, y: 500, pressure: 1 },
      { x: 600, y: 600, pressure: 1 },
    ]);
    expect(predicted.polygon.length).toBeGreaterThan(0);
    // Confirmed state untouched: same nodes, bounds, and count.
    expect(withPrediction.geometry().bounds).toEqual(cleanGeometry.bounds);
    expect(withPrediction.geometry().polygon).toEqual(cleanGeometry.polygon);
    expect(withPrediction.confirmedCount()).toBe(samples.length);
    // Confirming over the prediction converges to the prediction-free
    // result: earlier confirmed geometry is not perturbed.
    withPrediction.append([{ x: 140.7, y: 90.45, pressure: 0.5 }]);
    const overtaken = withPrediction.geometry();
    clean.append([{ x: 140.7, y: 90.45, pressure: 0.5 }]);
    expect(overtaken.bounds).toEqual(clean.geometry().bounds);
    expect(overtaken.polygon).toEqual(clean.geometry().polygon);
    // Commit ignores predictions entirely.
    expect(withPrediction.finish().polygon).toEqual(clean.finish().polygon);
  });

  it('freezes one resolved brush per stroke (no mid-gesture updates)', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const samples = diagonal(300);
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    for (const batch of batchesOf(samples.slice(1, 150), 25)) {
      compiler.append(batch);
    }
    // The gesture brush is the begin snapshot: no API exists to mutate it
    // mid-gesture, so a size/subtype change can only affect the NEXT
    // stroke. Appending the rest of the gesture keeps the frozen brush.
    expect(compiler.brush()).toEqual(BALL_PEN_BRUSH);
    for (const batch of batchesOf(samples.slice(150), 25)) {
      compiler.append(batch);
    }
    expect(compiler.brush()).toEqual(BALL_PEN_BRUSH);
    expect(liveCompilerStats().fullCompiles).toBe(0);
    // Commit resolves the begin brush exactly: zero geometry-grid change
    // at pointer-up by construction.
    const committed = compiler.finish();
    expect(committed.polygon).toEqual(
      compileInkStroke(samples, BALL_PEN_BRUSH).polygon,
    );
    expect(liveCompilerStats().fullCompiles).toBe(1);
    // The next stroke snapshots its own (possibly edited) preset.
    const second = new LiveInkStrokeCompiler();
    const edited = { ...BALL_PEN_BRUSH, size: 8 };
    second.begin(samples[0]!, edited);
    expect(second.brush()).toEqual(edited);
  });

  it('resets cleanly between gestures', () => {
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin({ x: 0, y: 0 }, BALL_PEN_BRUSH);
    compiler.append(diagonal(50).slice(1));
    expect(compiler.confirmedCount()).toBe(50);
    compiler.reset();
    expect(compiler.confirmedCount()).toBe(0);
    expect(compiler.brush()).toBeNull();
    expect(compiler.geometry().polygon).toEqual([]);
    compiler.begin({ x: 5, y: 5 }, BALL_PEN_BRUSH);
    expect(compiler.confirmedCount()).toBe(1);
  });
});

describe('highlighter nib', () => {
  it('holds constant width independent of pressure', () => {
    const spine = (pressure: number): InkSample[] => [
      { x: 0, y: 0, pressure },
      { x: 100, y: 0, pressure },
    ];
    const light = compileInkStroke(spine(0), HIGHLIGHTER_BRUSH);
    const heavy = compileInkStroke(spine(1), HIGHLIGHTER_BRUSH);
    expect(light.bounds.height).toBeCloseTo(heavy.bounds.height, 6);
    expect(light.bounds.height).toBeCloseTo(HIGHLIGHTER_BRUSH.size, 0);
  });

  it('renders a marker ribbon with flush butt caps, not pen geometry', () => {
    const horizontal = compileInkStroke(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      HIGHLIGHTER_BRUSH,
    );
    const ball = compileInkStroke(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      { ...BALL_PEN_BRUSH, size: HIGHLIGHTER_BRUSH.size },
    );
    expect(horizontal.polygon).not.toEqual(ball.polygon);
    // Full marker width across the stroke…
    expect(horizontal.bounds.height).toBeCloseTo(HIGHLIGHTER_BRUSH.size, 0);
    // …with flush square ends (no round-cap overhang past the endpoints).
    expect(horizontal.bounds.x).toBeCloseTo(0, 0);
    expect(horizontal.bounds.x + horizontal.bounds.width).toBeCloseTo(100, 0);
    // A diagonal keeps full width too (direction-independent ribbon).
    const diagonalStroke = compileInkStroke(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      HIGHLIGHTER_BRUSH,
    );
    expect(diagonalStroke.polygon.length).toBeGreaterThan(0);
    expect(diagonalStroke.bounds.width).toBeGreaterThan(90);
    // Marker taps stamp square dots, not round ones.
    const dot = compileInkStroke([{ x: 5, y: 5 }], HIGHLIGHTER_BRUSH);
    expect(dot.polygon).toHaveLength(4);
    expect(dot.bounds).toEqual({ x: -2, y: -2, width: 14, height: 14 });
  });
});
