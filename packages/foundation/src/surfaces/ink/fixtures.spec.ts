/**
 * Fixture conformance: every deterministic stream is finite, non-empty,
 * time-ordered, and shaped as its name promises.
 */

import { describe, expect, it } from 'vitest';
import {
  bigCircle,
  denseBatch,
  fastDiagonal,
  handwritingSheet,
  longStroke,
  predictedTail,
  pressureOscillation,
  pressureRamp,
  sCurve,
  sharpCorner,
  slowDiagonal,
  slowHandwritingCurve,
  smallLoop,
  smallLoops,
  spiral,
  tiltRamp,
  tiltVariation,
} from './fixtures.js';
import type { InkSample } from '../model.js';

function assertStream(samples: InkSample[]): void {
  expect(samples.length).toBeGreaterThan(0);
  let lastDt = -Infinity;
  for (const s of samples) {
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.y)).toBe(true);
    if (s.dt !== undefined) {
      expect(s.dt).toBeGreaterThanOrEqual(lastDt);
      lastDt = s.dt;
    }
  }
}

describe('ink fixtures', () => {
  it('exposes finite, time-ordered streams', () => {
    for (const stream of [
      slowHandwritingCurve(),
      fastDiagonal(),
      slowDiagonal(),
      smallLoop(),
      smallLoops(),
      bigCircle(),
      spiral(),
      sCurve(),
      sharpCorner(),
      pressureRamp(),
      pressureOscillation(),
      tiltVariation(),
      tiltRamp(),
      longStroke(),
      denseBatch(),
      predictedTail(),
    ]) {
      assertStream(stream);
    }
  });

  it('shapes each stream as promised', () => {
    expect(slowHandwritingCurve()).toHaveLength(60);
    expect(fastDiagonal()).toHaveLength(12);
    // Loop closes back near its start.
    const loop = smallLoop();
    const first = loop[0]!;
    const last = loop[loop.length - 1]!;
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeLessThan(0.01);
    // Corner turns ninety degrees at (100, 0).
    const corner = sharpCorner();
    expect(corner[20]).toMatchObject({ x: 100, y: 0 });
    expect(corner[corner.length - 1]).toMatchObject({ x: 100, y: 100 });
    // S-curve spans two opposing arcs back to the midline.
    const s = sCurve();
    expect(s).toHaveLength(61);
    expect(s[0]!.y).toBeCloseTo(40, 0);
    expect(s[Math.floor(s.length / 2)]!.y).toBeCloseTo(40, 0);
    // Large circle closes; spiral winds inward.
    const big = bigCircle();
    expect(
      Math.hypot(
        big[big.length - 1]!.x - big[0]!.x,
        big[big.length - 1]!.y - big[0]!.y,
      ),
    ).toBeLessThan(0.01);
    const wound = spiral();
    const r0 = Math.hypot(wound[0]!.x - 100, wound[0]!.y - 100);
    const r1 = Math.hypot(
      wound[wound.length - 1]!.x - 100,
      wound[wound.length - 1]!.y - 100,
    );
    expect(r0).toBeGreaterThan(r1 * 3);
    // Lowercase loops chain four tight rings; slow diagonal advances steadily.
    expect(smallLoops().length).toBeGreaterThan(smallLoop().length * 2);
    const diag = slowDiagonal();
    expect(diag[diag.length - 1]!.x).toBeGreaterThan(diag[0]!.x + 100);
    // Tilt ramp sweeps both axes upward.
    const tilt = tiltRamp();
    expect(tilt[tilt.length - 1]!.tilt!.x).toBeGreaterThan(tilt[0]!.tilt!.x);
    // Ramp spans the full pressure range.
    const ramp = pressureRamp().map((s) => s.pressure!);
    expect(Math.min(...ramp)).toBeCloseTo(0.1, 2);
    expect(Math.max(...ramp)).toBeCloseTo(1, 2);
    // Long stroke and dense batch carry volume.
    expect(longStroke().length).toBeGreaterThanOrEqual(1000);
    const dense = denseBatch();
    expect(dense.length).toBeGreaterThan(10);
    const span = Math.max(...dense.map((s) => s.x)) - dense[0]!.x;
    expect(span).toBeLessThan(20);
    expect(predictedTail().length).toBeGreaterThanOrEqual(2);
  });

  it('covers the handwriting geometry sheet once per entry', () => {
    const sheet = handwritingSheet();
    const names = sheet.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [
      'straight',
      'shallow-wave',
      's-curve',
      'loops',
      'small-loop',
      'large-circle',
      'spiral',
      'digits',
      'fast-diagonal',
      'slow-diagonal',
      'sharp-corner',
      'pressure-ramp',
      'tilt-ramp',
      'long-handwriting',
    ]) {
      expect(names).toContain(name);
    }
    for (const { samples } of sheet) {
      expect(samples.length).toBeGreaterThan(1);
    }
  });
});
