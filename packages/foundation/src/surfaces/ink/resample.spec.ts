/**
 * True arc-length resampling: irregular device sampling in, uniform
 * arc-distance control samples out. Deterministic, DOM-free, linear.
 */

import { describe, expect, it } from 'vitest';
import {
  appendResampled,
  arcLengthResample,
  defaultControlSpacing,
  initialResampleCarry,
} from './resample.js';
import { sanitizeSamples, type WorkingSample } from './samples.js';
import type { InkSample } from '../model.js';

function cleaned(samples: InkSample[]): WorkingSample[] {
  return sanitizeSamples(samples, 0.25);
}

function line(
  n: number,
  gap: number,
  extra: Partial<InkSample> = {},
): InkSample[] {
  return Array.from({ length: n }, (_, i) => ({ x: i * gap, y: 0, ...extra }));
}

describe('arc-length resampling', () => {
  it('preserves the first and last meaningful samples exactly', () => {
    const samples = cleaned([
      { x: 3, y: 7, pressure: 0.2 },
      { x: 23, y: 7, pressure: 0.8 },
      { x: 83, y: 7, pressure: 0.4 },
    ]);
    const out = arcLengthResample(samples, 10);
    expect(out[0]).toMatchObject({ x: 3, y: 7, pressure: 0.2 });
    const last = out[out.length - 1]!;
    expect(last.x).toBeCloseTo(83, 9);
    expect(last.y).toBeCloseTo(7, 9);
    expect(last.pressure).toBeCloseTo(0.4, 9);
  });

  it('normalizes irregular spacing to a uniform grid', () => {
    // Gaps of 2, 30, 3, 45: event-frequency artifacts, not pen intent.
    const samples = cleaned([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 32, y: 0 },
      { x: 35, y: 0 },
      { x: 80, y: 0 },
    ]);
    const out = arcLengthResample(samples, 10);
    expect(out.length).toBe(9); // anchor + marks at 10..70 + endpoint
    for (let i = 1; i < out.length; i++) {
      const gap = Math.hypot(
        out[i]!.x - out[i - 1]!.x,
        out[i]!.y - out[i - 1]!.y,
      );
      expect(gap).toBeLessThanOrEqual(10 + 1e-9);
      expect(gap).toBeGreaterThan(0);
    }
    // Interior marks sit exactly on the grid.
    for (let i = 0; i < 7; i++) {
      expect(out[i + 1]!.x).toBeCloseTo((i + 1) * 10, 9);
    }
  });

  it('subdivides sparse gaps and consolidates dense jitter alike', () => {
    const sparse = arcLengthResample(cleaned(line(2, 100)), 10);
    expect(sparse.length).toBe(11); // anchor + 10..90 + endpoint
    const dense = arcLengthResample(cleaned(line(201, 0.5)), 10);
    expect(dense.length).toBe(11); // same path, same grid
    for (let i = 0; i < sparse.length; i++) {
      expect(sparse[i]!.x).toBeCloseTo(dense[i]!.x, 6);
    }
  });

  it('interpolates every semantic axis at grid marks', () => {
    const samples = cleaned([
      {
        x: 0,
        y: 0,
        pressure: 0.2,
        tilt: { x: 0.1, y: 0.2 },
        twist: 0.5,
        dt: 0,
      },
      {
        x: 20,
        y: 0,
        pressure: 0.8,
        tilt: { x: 0.5, y: 0.6 },
        twist: 1.1,
        dt: 100,
      },
    ]);
    const out = arcLengthResample(samples, 10);
    expect(out).toHaveLength(3);
    const mid = out[1]!;
    expect(mid.x).toBeCloseTo(10, 9);
    expect(mid.pressure).toBeCloseTo(0.5, 9);
    expect(mid.tiltX).toBeCloseTo(0.3, 9);
    expect(mid.tiltY).toBeCloseTo(0.4, 9);
    expect(mid.twist).toBeCloseTo(0.8, 9);
    expect(mid.dt).toBeCloseTo(50, 9);
  });

  it('interpolates twist the short way across the ±π seam', () => {
    const samples = cleaned([
      { x: 0, y: 0, twist: Math.PI - 0.2 },
      { x: 20, y: 0, twist: -Math.PI + 0.2 },
    ]);
    const out = arcLengthResample(samples, 10);
    const mid = out[1]!.twist!;
    // Short-way interpolation passes through ±π, never through 0.
    expect(Math.abs(mid)).toBeGreaterThan(Math.PI - 0.3);
  });

  it('carries dropout axes forward and timing-neutral marks stay neutral', () => {
    const samples = cleaned([
      { x: 0, y: 0, pressure: 0.7 },
      { x: 20, y: 0 },
    ]);
    const out = arcLengthResample(samples, 10);
    expect(out[1]!.pressure).toBeCloseTo(0.7, 9);
    expect(out[1]!.dt).toBeNull();
  });

  it('collapses zero movement to first+last (stationary press survives)', () => {
    // Axis-only changes at identical coords survive sanitation when the
    // jitter floor is 0 (a press-down is intentional data); resampling
    // then preserves both ends so the dot keeps its pressure span.
    const samples = sanitizeSamples(
      [
        { x: 5, y: 5, pressure: 0.2 },
        { x: 5, y: 5, pressure: 0.9 },
      ],
      0,
    );
    expect(samples).toHaveLength(2);
    const out = arcLengthResample(samples, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.pressure).toBe(0.2);
    expect(out[1]!.pressure).toBe(0.9);
  });

  it('handles single samples and empty input', () => {
    expect(arcLengthResample([], 2)).toEqual([]);
    const one = arcLengthResample(cleaned([{ x: 1, y: 2 }]), 2);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ x: 1, y: 2 });
  });

  it('is deterministic and linear', () => {
    const samples = cleaned(line(10_000, 0.8));
    const first = arcLengthResample(samples, 1);
    const second = arcLengthResample(samples, 1);
    expect(second).toEqual(first);
    // ~8000 units at spacing 1: bounded output, no explosion.
    expect(first.length).toBeLessThan(10_000);
    expect(first.length).toBeGreaterThan(7_000);
  });

  it('defaults spacing from brush size', () => {
    expect(defaultControlSpacing(3)).toBeCloseTo(1.05, 9);
    expect(defaultControlSpacing(14)).toBe(3);
    expect(defaultControlSpacing(1)).toBe(0.75);
  });
});

describe('incremental resampling', () => {
  it('extends the same grid continuation appends would (batch parity)', () => {
    const stream = cleaned(line(50, 3));
    const batch = arcLengthResample(stream, 5);
    const carry = initialResampleCarry();
    const controls: WorkingSample[] = [];
    // Feed in uneven chunks; interior marks must match the clean grid.
    appendResampled(carry, stream.slice(0, 7), 5, controls);
    appendResampled(carry, stream.slice(7, 23), 5, controls);
    appendResampled(carry, stream.slice(23), 5, controls);
    // Incremental output = batch marks + provisional tip (the exact final
    // sample); popping the tip reproduces the batch marks exactly.
    expect(controls.length).toBe(batch.length);
    for (let i = 0; i < batch.length - 1; i++) {
      expect(controls[i]!.x).toBeCloseTo(batch[i]!.x, 9);
    }
    const tip = controls[controls.length - 1]!;
    const end = batch[batch.length - 1]!;
    expect(tip.x).toBeCloseTo(end.x, 9);
  });

  it('pops at most one provisional tip per continuation', () => {
    const carry = initialResampleCarry();
    const controls: WorkingSample[] = [];
    const a = appendResampled(carry, cleaned(line(5, 10)), 7, controls);
    expect(a.popped).toBe(0);
    expect(carry.provisional).toBe(true);
    const before = controls.length;
    const b = appendResampled(carry, cleaned([{ x: 55, y: 0 }]), 7, controls);
    expect(b.popped).toBe(1);
    // Net growth is bounded (marks + one tip), never history-sized.
    expect(controls.length - before).toBeLessThanOrEqual(4);
  });
});
