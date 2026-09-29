/**
 * rAF-coalesced draw input (item 2): cheap per-event capture, one expensive
 * publication per frame, confirmed never dropped, predictions ephemeral.
 */

import { describe, expect, it } from 'vitest';
import { DrawInputCoalescer } from './input-coalescer.js';
import type { NormalizedPointerEvent } from '@froglight/foundation';

function sample(x: number, y: number, time = 0): NormalizedPointerEvent {
  return { point: { x, y }, time } as NormalizedPointerEvent;
}

describe('DrawInputCoalescer', () => {
  it('buffers many pushes into one flush without dropping confirmed', () => {
    const coalescer = new DrawInputCoalescer();
    // Simulate 240Hz events across one 60fps frame: 4 DOM events.
    // Split API: raw/confirmed via pushConfirmed, predictions via
    // replacePredictionSnapshot (move-owned, empty clears).
    coalescer.pushConfirmed([sample(0, 0, 1), sample(1, 0, 2)]);
    coalescer.replacePredictionSnapshot([]);
    coalescer.pushConfirmed([sample(2, 0, 3)]);
    coalescer.replacePredictionSnapshot([sample(10, 0, 100)]);
    coalescer.pushConfirmed([sample(3, 0, 4), sample(4, 0, 5)]);
    coalescer.replacePredictionSnapshot([sample(11, 0, 101)]);
    // The last move carries no lookahead: its empty snapshot explicitly
    // clears the previous tail (stale Q never survives).
    coalescer.pushConfirmed([sample(5, 0, 6)]);
    coalescer.replacePredictionSnapshot([]);
    expect(coalescer.hasPending()).toBe(true);
    expect(coalescer.pendingCount()).toBe(6);
    const flushed = coalescer.flush();
    expect(flushed?.confirmed.map((s) => s.point.x)).toEqual([0, 1, 2, 3, 4, 5]);
    // Empty final snapshot cleared the tail: nothing stale renders.
    expect(flushed?.predicted.map((s) => s.point.x)).toEqual([]);
    expect(coalescer.hasPending()).toBe(false);
    const stats = coalescer.statsSnapshot();
    expect(stats.pushes).toBe(4);
    expect(stats.flushes).toBe(1);
    expect(stats.confirmedBuffered).toBe(6);
    expect(stats.confirmedFlushed).toBe(6);
    expect(stats.predictedReplaced).toBe(2);
  });

  it('keeps the latest non-empty prediction when the frame ends with lookahead', () => {
    const coalescer = new DrawInputCoalescer();
    coalescer.push([sample(0, 0, 1), sample(1, 0, 2)], []);
    coalescer.push([sample(2, 0, 3)], [sample(10, 0, 100)]);
    coalescer.push([sample(3, 0, 4)], [sample(11, 0, 101)]);
    const flushed = coalescer.flush();
    expect(flushed?.confirmed.map((s) => s.point.x)).toEqual([0, 1, 2, 3]);
    // Latest snapshot wins while non-empty (replacement, never append).
    expect(flushed?.predicted.map((s) => s.point.x)).toEqual([11]);
  });

  it('empty prediction snapshots explicitly clear previous state', () => {
    const coalescer = new DrawInputCoalescer();
    coalescer.pushConfirmed([sample(0, 0, 1)]);
    coalescer.replacePredictionSnapshot([sample(99, 99, 50)]);
    expect(coalescer.hasPending()).toBe(true);
    // Event B with prediction [] clears event A's Q.
    coalescer.replacePredictionSnapshot([]);
    expect(coalescer.hasPending()).toBe(true); // confirmed still pending
    const flushed = coalescer.flush();
    expect(flushed?.confirmed).toHaveLength(1);
    expect(flushed?.predicted).toHaveLength(0);
  });

  it('raw confirmed pushes never touch prediction state', () => {
    const coalescer = new DrawInputCoalescer();
    coalescer.pushConfirmed([sample(0, 0, 1)]);
    coalescer.replacePredictionSnapshot([sample(99, 99, 50)]);
    // Raw path: confirmed only, prediction snapshot untouched.
    coalescer.pushConfirmed([sample(1, 0, 2)]);
    const flushed = coalescer.flush();
    expect(flushed?.confirmed).toHaveLength(2);
    expect(flushed?.predicted.map((s) => s.point.x)).toEqual([99]);
  });

  it('flush is idempotent and empty flushes are counted', () => {
    const coalescer = new DrawInputCoalescer();
    expect(coalescer.flush()).toBeNull();
    coalescer.push([sample(0, 0, 1)], []);
    expect(coalescer.flush()?.confirmed).toHaveLength(1);
    expect(coalescer.flush()).toBeNull();
    expect(coalescer.statsSnapshot().emptyFlushes).toBe(2);
  });

  it('dropPredictions keeps confirmed for pointerup commit', () => {
    const coalescer = new DrawInputCoalescer();
    coalescer.push([sample(0, 0, 1)], [sample(99, 99, 50)]);
    coalescer.dropPredictions();
    const flushed = coalescer.flush();
    expect(flushed?.confirmed).toHaveLength(1);
    expect(flushed?.predicted).toHaveLength(0);
  });

  it('preserves order across coalesced frames (no pause/catch-up loss)', () => {
    const coalescer = new DrawInputCoalescer();
    const seen: number[] = [];
    // Three frames of rapid circles: each frame buffers several events,
    // flushes once, and every sample arrives in order.
    let t = 0;
    for (let frame = 0; frame < 3; frame++) {
      for (let e = 0; e < 4; e++) {
        t += 1;
        coalescer.push([sample(t, t, t)], []);
      }
      const flushed = coalescer.flush();
      for (const s of flushed!.confirmed) seen.push(s.point.x);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const stats = coalescer.statsSnapshot();
    expect(stats.confirmedBuffered).toBe(stats.confirmedFlushed);
    expect(stats.flushes).toBe(3);
    expect(stats.pushes).toBe(12);
  });
});
