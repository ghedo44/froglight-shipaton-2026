/**
 * Live incremental regression with intentional corners (follow-up).
 *
 * The approximating fitter splits clamped runs at detected corners. The
 * incremental builder MUST retain those corner decisions across the
 * pop-to-keepFaired + re-push cycle the live compiler runs on every
 * append: forgetting head corners renumbers tail spans, the tessellation
 * splice then joins mismatched spans, and the preview shows random
 * back-and-forth straight lines — or vanishes entirely until pointer-up
 * restores the (correct) full compile. Diagonal/S-curve convergence tests
 * cannot catch this (they contain no corners); these fixtures can.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import { fitCenterlineCurve, InkCurveBuilder } from './curve.js';
import type { InkCurveControl } from './curve.js';
import {
  LIVE_TAIL_REFRESH_SPANS,
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { sharpCorner, smallLoop } from './fixtures.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

function distToRing(p: Point, ring: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.min(Math.max(t, 0), 1);
    best = Math.min(
      best,
      Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)),
    );
  }
  return best;
}

function hausdorff(a: readonly Point[], b: readonly Point[]): number {
  let worst = 0;
  for (const p of a) worst = Math.max(worst, distToRing(p, b));
  for (const p of b) worst = Math.max(worst, distToRing(p, a));
  return worst;
}

function batchesOf(samples: InkSample[], size: number): InkSample[][] {
  const out: InkSample[][] = [];
  for (let i = 0; i < samples.length; i += size) {
    out.push(samples.slice(i, i + size));
  }
  return out;
}

function vShape(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 20; i++) {
    out.push({ x: i * 5, y: i * 3, pressure: 0.5, dt: i * 8 });
  }
  for (let i = 1; i <= 20; i++) {
    out.push({
      x: 100 + i * 5,
      y: 60 - i * 3,
      pressure: 0.5,
      dt: 160 + i * 8,
    });
  }
  return out;
}

/** Mouse-like stroke: integer surfaces, irregular timing, sparse jumps. */
function mouseLike(): InkSample[] {
  const out: InkSample[] = [];
  let dt = 0;
  for (let i = 0; i < 40; i++) {
    out.push({
      x: Math.round(i * 3.7),
      y: Math.round(20 + Math.sin(i / 5) * 14),
      pressure: 0.5,
      dt,
    });
    dt += i % 3 === 0 ? 32 : 8;
  }
  // Sharp reversal, then a sparse fast jump.
  out.push({ x: 150, y: 40, pressure: 0.5, dt: (dt += 8) });
  out.push({ x: 140, y: 60, pressure: 0.5, dt: (dt += 8) });
  out.push({ x: 200, y: 90, pressure: 0.5, dt: (dt += 40) });
  out.push({ x: 260, y: 95, pressure: 0.5, dt: (dt += 8) });
  return out;
}

/** Deterministic pressure path whose frozen head contains several corners. */
function cornerStressPath(): InkSample[] {
  let state = 6;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const out: InkSample[] = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  let dt = 0;
  for (let i = 0; i < 240; i++) {
    heading += (random() - 0.5) * 1.4;
    const step = 0.2 + random() * 7;
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    dt += 2 + Math.floor(random() * 24);
    out.push({ x, y, pressure: 0.08 + random() * 0.9, dt });
  }
  return out;
}

function checkLiveValid(compiler: LiveInkStrokeCompiler, label: string): void {
  const live = compiler.geometry();
  expect(
    live.polygon.length,
    `${label}: live polygon non-empty`,
  ).toBeGreaterThan(0);
  for (const p of live.polygon) {
    expect(Number.isFinite(p.x), `${label}: finite x`).toBe(true);
    expect(Number.isFinite(p.y), `${label}: finite y`).toBe(true);
  }
  expect(live.bounds.width, `${label}: sane bounds`).toBeGreaterThanOrEqual(0);
}

function cornerTags(geometry: ReturnType<typeof compileInkStroke>) {
  return geometry.nodes
    .filter((node) => node.corner !== undefined)
    .map((node) => ({
      segmentIndex: node.segmentIndex,
      u: node.u,
      corner: node.corner,
    }));
}

describe('live incremental geometry with corners', () => {
  for (const [name, samples, batch] of [
    ['sharp L corner', sharpCorner(), 5],
    ['sharp V corner', vShape(), 3],
    ['small loop', smallLoop(), 4],
    ['mouse-like sparse', mouseLike(), 1],
  ] as const) {
    it(`never blanks or scrambles the preview (${name})`, () => {
      resetLiveCompilerStats();
      const compiler = new LiveInkStrokeCompiler();
      compiler.begin(samples[0]!, BALL_PEN_BRUSH);
      checkLiveValid(compiler, `${name} after begin`);
      for (const [index, chunk] of batchesOf(
        samples.slice(1),
        batch,
      ).entries()) {
        compiler.append(chunk);
        checkLiveValid(compiler, `${name} batch ${index}`);
      }
      const live = compiler.geometry();
      const committed = compiler.finish();
      const clean = compileInkStroke(samples, BALL_PEN_BRUSH);
      expect(committed.polygon).toEqual(clean.polygon);
      // Unified arc plus settled head widths: cornered strokes converge
      // within the visual budget (0.5 screen px at 8x zoom).
      expect(hausdorff(live.polygon, committed.polygon)).toBeLessThan(0.0625);
    });
  }

  it('keeps builder corner decisions across pop/re-push cycles', () => {
    const controls: InkCurveControl[] = sharpCorner().map((s) => ({
      x: s.x,
      y: s.y,
      pressure: 0.5,
      tiltX: null,
      tiltY: null,
      twist: null,
      dt: s.dt ?? null,
    }));
    const batch = fitCenterlineCurve(controls);
    expect(batch.cornerCount ?? 0).toBeGreaterThanOrEqual(1);
    const builder = new InkCurveBuilder();
    for (const c of controls) builder.push(c);
    expect(builder.curve.segments.length).toBe(batch.segments.length);
    expect(builder.curve.cornerCount ?? 0).toBe(batch.cornerCount ?? 0);
    // Pop the tail and re-push identical values (what the live compiler
    // does every append): the refit must reproduce the batch exactly.
    const tail = controls.slice(-8);
    for (let i = 0; i < 8; i++) builder.pop();
    for (const c of tail) builder.push(c);
    const rebuilt = builder.curve;
    expect(rebuilt.segments.length).toBe(batch.segments.length);
    expect(rebuilt.cornerCount ?? 0).toBe(batch.cornerCount ?? 0);
    for (let s = 0; s < batch.segments.length; s++) {
      for (const t of [0, 0.5, 1]) {
        const a = batch.segments[s]!.position(t);
        const b = rebuilt.segments[s]!.position(t);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.y).toBeCloseTo(a.y, 9);
      }
    }
  });

  it('keeps frozen corner joins authoritative across event batching', () => {
    const samples = cornerStressPath();
    const compileLive = (
      partition: (index: number) => number,
      checkFrozenPrefixes = false,
    ) => {
      resetLiveCompilerStats();
      const compiler = new LiveInkStrokeCompiler();
      compiler.begin(samples[0]!, BALL_PEN_BRUSH);
      let index = 1;
      let maxSpansPerAppend = 0;
      const frozenPrefixChecks = new Set([179, 200, samples.length]);
      while (index < samples.length) {
        const before = liveCompilerStats().tailSpansRetessellated;
        const size = Math.max(1, partition(index));
        compiler.append(samples.slice(index, index + size));
        const after = liveCompilerStats().tailSpansRetessellated;
        maxSpansPerAppend = Math.max(maxSpansPerAppend, after - before);
        index += size;
        if (checkFrozenPrefixes && frozenPrefixChecks.has(index)) {
          const prefix = samples.slice(0, Math.min(index, samples.length));
          const livePrefix = compiler.geometry();
          const fullPrefix = compileInkStroke(prefix, BALL_PEN_BRUSH);
          expect(
            hausdorff(livePrefix.polygon, fullPrefix.polygon),
            `frozen prefix ${prefix.length}`,
          ).toBeLessThan(0.0625);
          expect(
            cornerTags(livePrefix),
            `frozen prefix ${prefix.length} corner tags`,
          ).toEqual(cornerTags(fullPrefix));
        }
      }
      return { geometry: compiler.geometry(), maxSpansPerAppend };
    };
    const one = compileLive(() => 1, true);
    const all = compileLive(() => samples.length);
    const random = compileLive((index) => 1 + ((6 * 17 + index * 13) % 47));
    const full = compileInkStroke(samples, BALL_PEN_BRUSH);

    for (const result of [one, all, random]) {
      expect(hausdorff(result.geometry.polygon, full.polygon)).toBeLessThan(
        0.0625,
      );
      expect(cornerTags(result.geometry)).toEqual(cornerTags(full));
    }
    // One extra lookbehind span repairs the joint without turning the
    // append path into history-sized work.
    expect(one.maxSpansPerAppend).toBeLessThanOrEqual(
      LIVE_TAIL_REFRESH_SPANS + 16,
    );
  }, 30_000);
});
