import { describe, expect, it } from 'vitest';
import type { Point } from '../geometry.js';
import type { InkSample } from '../model.js';
import { BRUSH_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  filterPressureStream,
  NEUTRAL_PRESSURE,
  VELOCITY_PRESSURE_SPEED_SCALE,
  velocityPressureForSpeed,
} from './curve-attributes.js';
import {
  LIVE_TAIL_REFRESH_SPANS,
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';

function distanceToRing(point: Point, ring: readonly Point[]): number {
  let best = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!;
    const b = ring[(index + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(
            Math.max(
              ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
              0,
            ),
            1,
          );
    best = Math.min(
      best,
      Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy),
    );
  }
  return best;
}

function hausdorff(a: readonly Point[], b: readonly Point[]): number {
  let worst = 0;
  for (const point of a) worst = Math.max(worst, distanceToRing(point, b));
  for (const point of b) worst = Math.max(worst, distanceToRing(point, a));
  return worst;
}

function xAt(time: number): number {
  const first = Math.min(time, 300) * 0.12;
  const second = Math.min(Math.max(time - 300, 0), 300) * 0.65;
  const third = Math.max(time - 600, 0) * 0.25;
  return first + second + third;
}

function timedPath(hz: 120 | 240, duration = 900): InkSample[] {
  const interval = 1000 / hz;
  const out: InkSample[] = [];
  for (let index = 0; index <= Math.round(duration / interval); index++) {
    const time = Math.min(index * interval, duration);
    out.push({
      x: xAt(time),
      y: 0,
      dt: time,
    });
  }
  return out;
}

function live(
  samples: readonly InkSample[],
  batchSize: (index: number) => number,
) {
  const compiler = new LiveInkStrokeCompiler();
  compiler.begin(samples[0]!, BRUSH_PEN_BRUSH);
  let index = 1;
  while (index < samples.length) {
    const size = Math.max(1, batchSize(index));
    compiler.append(samples.slice(index, index + size));
    index += size;
  }
  return compiler.geometry();
}

describe('causal velocity pressure', () => {
  it('uses a fixed physical speed response and neutral untimed fallback', () => {
    expect(velocityPressureForSpeed(0)).toBe(1);
    expect(velocityPressureForSpeed(VELOCITY_PRESSURE_SPEED_SCALE)).toBe(0.5);
    expect(
      filterPressureStream(
        [null, null],
        [
          { x: 0, y: 0, dt: null },
          { x: 100, y: 0, dt: null },
        ],
        BRUSH_PEN_BRUSH,
      ),
    ).toEqual([NEUTRAL_PRESSURE, NEUTRAL_PRESSURE]);
    expect(
      filterPressureStream(
        [0, 0],
        [
          { x: 0, y: 0, dt: 0 },
          { x: 1, y: 0, dt: 8 },
        ],
        BRUSH_PEN_BRUSH,
      ),
    ).toEqual([0, 0]);
  });

  it('keeps timed speed transitions stable across event rates and batches', () => {
    const byRate = [120, 240].map((hz) => {
      const samples = timedPath(hz as 120 | 240);
      const full = compileInkStroke(samples, BRUSH_PEN_BRUSH);
      const oneCompiler = new LiveInkStrokeCompiler();
      oneCompiler.begin(samples[0]!, BRUSH_PEN_BRUSH);
      const prefixChecks = new Set(
        [300, 600, 900].map((time) =>
          Math.min(Math.round((time * hz) / 1000) + 1, samples.length),
        ),
      );
      for (let index = 1; index < samples.length; index++) {
        oneCompiler.append([samples[index]!]);
        const count = index + 1;
        if (prefixChecks.has(count)) {
          const prefix = samples.slice(0, count);
          expect(
            hausdorff(
              oneCompiler.geometry().polygon,
              compileInkStroke(prefix, BRUSH_PEN_BRUSH).polygon,
            ),
          ).toBeLessThan(0.0625);
        }
      }
      const one = oneCompiler.geometry();
      const chunks = live(samples, (index) => 1 + ((index * 13) % 17));
      const all = live(samples, () => samples.length);
      for (const candidate of [one, chunks, all]) {
        expect(hausdorff(candidate.polygon, full.polygon)).toBeLessThan(0.0625);
      }
      return full;
    });
    expect(hausdorff(byRate[0]!.polygon, byRate[1]!.polygon)).toBeLessThan(
      0.04,
    );
  });

  it('continues timed velocity pressure through ephemeral prediction', () => {
    const samples = timedPath(120);
    const confirmed = samples.slice(0, 80);
    const predictedSamples = samples.slice(80, 90);
    const predictedCompiler = new LiveInkStrokeCompiler();
    const confirmedCompiler = new LiveInkStrokeCompiler();
    for (const compiler of [predictedCompiler, confirmedCompiler]) {
      compiler.begin(confirmed[0]!, BRUSH_PEN_BRUSH);
      compiler.append(confirmed.slice(1));
    }
    const predicted = predictedCompiler.appendPredicted(predictedSamples);
    confirmedCompiler.append(predictedSamples);
    const confirmedNodes = confirmedCompiler.geometry().nodes;
    for (const node of predicted.nodes.slice(1)) {
      const nearest = confirmedNodes.reduce((best, candidate) =>
        Math.abs(candidate.controlArc - node.controlArc) <
        Math.abs(best.controlArc - node.controlArc)
          ? candidate
          : best,
      );
      expect(Math.abs(nearest.controlArc - node.controlArc)).toBeLessThan(0.05);
      expect(node.pressure).toBeCloseTo(nearest.pressure, 4);
      expect(node.width).toBeCloseTo(nearest.width, 4);
    }
  });

  it('keeps missing-pressure long-stroke work bounded', () => {
    resetLiveCompilerStats();
    const samples = timedPath(240, 20_000);
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin(samples[0]!, BRUSH_PEN_BRUSH);
    for (let index = 1; index < samples.length; index += 4) {
      compiler.append(samples.slice(index, index + 4));
    }
    const stats = liveCompilerStats();
    expect(stats.ringMaterializations).toBe(0);
    expect(stats.fullCompiles).toBe(0);
    expect(stats.tailSpansRetessellated / stats.tailUpdates).toBeLessThan(
      LIVE_TAIL_REFRESH_SPANS * 3,
    );
  }, 30_000);
});
