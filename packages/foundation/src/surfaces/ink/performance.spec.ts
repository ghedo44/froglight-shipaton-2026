/**
 * Performance gates: live appends scale with the tail (never history),
 * committed compiles scale linearly, and geometry output stays bounded
 * up to the canonical stroke sample cap (10,000).
 *
 * Operation counters (not wall-clock thresholds) pin the complexity so
 * these gates are deterministic; wall-clock assertions use generous
 * margins and only guard against pathological blowups.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { longStroke } from './fixtures.js';
import type { InkSample } from '../model.js';

function diagonal(count: number): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 0.7, y: i * 0.45, pressure: 0.5 });
  }
  return out;
}

describe('stroke performance gates', () => {
  it('appends 10k samples with zero full compiles during the gesture', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const samples = diagonal(10_000);
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    const batches: InkSample[][] = [];
    for (let i = 1; i < samples.length; i += 100) {
      batches.push(samples.slice(i, i + 100));
    }
    const started = performance.now();
    for (const batch of batches) compiler.append(batch);
    const elapsed = performance.now() - started;
    expect(liveCompilerStats().fullCompiles).toBe(0);
    expect(liveCompilerStats().tailUpdates).toBe(1 + batches.length);
    // Generous wall-clock bound against pathological blowups (an O(n²)
    // implementation spends seconds re-fitting history per batch).
    expect(elapsed).toBeLessThan(15000);
    const committed = compiler.finish();
    expect(liveCompilerStats().fullCompiles).toBe(1);
    expect(committed.polygon.length).toBeGreaterThan(0);
  });

  it('keeps batch latency flat as history grows (tail-bounded work)', () => {
    const compiler = new LiveInkStrokeCompiler();
    const samples = diagonal(4000);
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    const latencies: number[] = [];
    for (let i = 1; i < samples.length; i += 50) {
      const batch = samples.slice(i, i + 50);
      const start = performance.now();
      compiler.append(batch);
      latencies.push(performance.now() - start);
    }
    const firstQuarter = latencies.slice(0, 10);
    const lastQuarter = latencies.slice(-10);
    const avg = (xs: number[]): number =>
      xs.reduce((a, b) => a + b, 0) / xs.length;
    // Late batches (3k+ history) cost no more than ~10× early batches.
    // (Chunk publishes reference retained mesh state per batch, so only a
    // small history factor is expected; full re-fits would show 100×+.)
    expect(avg(lastQuarter)).toBeLessThan(Math.max(avg(firstQuarter) * 10, 5));
  });

  it('commits long strokes in linear time with bounded output', () => {
    const stroke = longStroke(10_000);
    const start = performance.now();
    const compiled = compileInkStroke(stroke, BALL_PEN_BRUSH);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(15000);
    // Output proportional to arc length, never explosive.
    expect(compiled.nodes.length).toBeLessThan(stroke.length * 10);
    expect(compiled.polygon.length).toBeLessThan(compiled.nodes.length * 6);
  });

  it('publishes previews without per-sample allocation blowup', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin({ x: 0, y: 0, pressure: 0.5 }, BALL_PEN_BRUSH);
    // 500 single-sample appends (worst-case event granularity).
    for (let i = 1; i <= 500; i++) {
      const update = compiler.append([
        { x: i * 0.7, y: i * 0.45, pressure: 0.5 },
      ]);
      expect(update.nodeCount).toBeGreaterThan(0);
    }
    expect(liveCompilerStats().fullCompiles).toBe(0);
    expect(liveCompilerStats().tailUpdates).toBe(501);
    const committed = compiler.finish();
    expect(committed.polygon.length).toBeGreaterThan(0);
  });
});
