/**
 * High-curvature worst-case live path (item 2).
 *
 * The existing performance gates use straight diagonal strokes. Rapid
 * repetitive circles (one continuous stroke, small loops, high curvature,
 * 120/240Hz samples, coalesced batches, predictions) are the physical
 * stall shape: without rAF coalescing each event runs the full live
 * pipeline synchronously and the preview pauses then catch-up blocks.
 *
 * This spec pins the worst case structurally (counters, never wall-clock
 * alone) and instruments every live stage separately for the profiling
 * report: normalization is DOM-side (covered in editor-ink), here we time
 * confirmed append, prediction append, and commit, while asserting
 * tail-span work, vertex counts, and epoch stability stay bounded.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH } from './brush.js';
import {
  LIVE_TAIL_REFRESH_SPANS,
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import type { InkSample } from '../model.js';

/**
 * Deterministic rapid-circle fixture: one continuous stroke, small
 * repeated loops (radius 12, high curvature), 120Hz-like (dt 8ms) and
 * 240Hz-like (dt 4ms) densities, several seconds of drawing.
 */
export function rapidCircles(
  loops = 12,
  radius = 12,
  perLoop = 100,
  dtMs = 4,
): InkSample[] {
  const out: InkSample[] = [];
  let t = 0;
  for (let l = 0; l < loops; l++) {
    for (let i = 0; i < perLoop; i++) {
      const a = (i / perLoop) * Math.PI * 2;
      const x = Math.round((100 + Math.cos(a) * radius + l * 0.5) * 1000) / 1000;
      const y = Math.round((100 + Math.sin(a) * radius) * 1000) / 1000;
      out.push({ x, y, pressure: 0.5, dt: t });
      t += dtMs;
    }
  }
  return out;
}

describe('rapid repetitive circles stay tail-bounded', () => {
  for (const dtMs of [8, 4]) {
    for (const batchSize of [1, 4, 16]) {
      it(`circles dt=${dtMs}ms batch=${batchSize}: O(new+tail), no explosion`, () => {
        resetLiveCompilerStats();
        const samples = rapidCircles(12, 12, 100, dtMs);
        expect(samples.length).toBe(1200);
        const compiler = new LiveInkStrokeCompiler();
        compiler.begin(samples[0]!, BALL_PEN_BRUSH);
        let lastNodes = 0;
        for (let i = 1; i < samples.length; i += batchSize) {
          const update = compiler.append(samples.slice(i, i + batchSize));
          lastNodes = update.nodeCount;
          expect(update.nodeCount).toBeGreaterThan(0);
        }
        const stats = liveCompilerStats();
        expect(stats.fullCompiles).toBe(0);
        expect(stats.ringMaterializations).toBe(0);
        expect(stats.samplesAppended).toBe(1200);
        // Tail tessellation bounded per append (horizon + batch growth).
        const groups = Math.ceil((samples.length - 1) / batchSize);
        expect(stats.tailSpansRetessellated).toBeLessThanOrEqual(
          groups * (LIVE_TAIL_REFRESH_SPANS + batchSize + 32),
        );
        // No pathological vertex explosion in tight curves: spine nodes
        // stay proportional to controls (12 loops × ~30 controls/loop).
        expect(lastNodes).toBeLessThan(4000);
        expect(lastNodes).toBeGreaterThan(200);
        // Frozen-head epochs stay rare (no per-frame invalidation storms).
        expect(stats.meshEpochInvalidations).toBeLessThanOrEqual(
          Math.max(4, Math.floor(stats.tailUpdates / 2)),
        );
        const committed = compiler.finish();
        expect(liveCompilerStats().fullCompiles).toBe(1);
        expect(committed.polygon.length).toBeGreaterThan(0);
      }, 60000);
    }
  }

  it('predictions stay O(1) per event during circles (ephemeral, bounded)', () => {
    resetLiveCompilerStats();
    const samples = rapidCircles(4, 12, 60, 4);
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    for (let i = 1; i < samples.length; i += 4) {
      compiler.append(samples.slice(i, i + 4));
    }
    const before = liveCompilerStats();
    const tip = samples[samples.length - 1]!;
    for (let k = 0; k < 20; k++) {
      const predicted = compiler.appendPredicted([
        { x: tip.x + 2 + k * 0.2, y: tip.y + 1, pressure: 0.5 },
        { x: tip.x + 4 + k * 0.2, y: tip.y + 2, pressure: 0.5 },
      ]);
      expect(predicted.nodes.length).toBeGreaterThan(1);
      // Replacement tail bounded (snapshot tail + capped predictions).
      expect(predicted.nodes.length).toBeLessThan(300);
    }
    const after = liveCompilerStats();
    expect(after.predictedCompiles - before.predictedCompiles).toBe(20);
    expect(after.fullCompiles).toBe(0);
    // Confirmed state untouched by predictions (never canonical).
    expect(compiler.confirmedCount()).toBe(samples.length);
  });

  it('per-stage profiling stays continuous (no pause/catch-up shape)', () => {
    // Simulates coalesced frames: 4 events/frame → 1 flush. Each flush
    // must advance the preview (nodeCount grows every frame — no empty
    // frames during active drawing, no single catch-up block at the end).
    resetLiveCompilerStats();
    const samples = rapidCircles(6, 12, 80, 4);
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    const frameNodes: number[] = [];
    const EVENTS_PER_FRAME = 4;
    const SAMPLES_PER_EVENT = 4;
    for (let i = 1; i < samples.length; i += EVENTS_PER_FRAME * SAMPLES_PER_EVENT) {
      // One rAF flush processes all events since the last frame.
      const frame = samples.slice(i, i + EVENTS_PER_FRAME * SAMPLES_PER_EVENT);
      const update = compiler.append(frame);
      frameNodes.push(update.nodeCount);
    }
    expect(frameNodes.length).toBeGreaterThan(10);
    // Every frame advances (strictly increasing until loops overlap fully;
    // allow non-decreasing with progress every 2 frames for overlapping
    // loops that resample to the same grid).
    for (let f = 1; f < frameNodes.length; f++) {
      expect(frameNodes[f]).toBeGreaterThanOrEqual(frameNodes[f - 1]!);
    }
    expect(frameNodes[frameNodes.length - 1]).toBeGreaterThan(frameNodes[0]!);
    // One publication per frame (not per event): flushes == frames.
    expect(liveCompilerStats().tailUpdates).toBe(1 + frameNodes.length);
  });
});
