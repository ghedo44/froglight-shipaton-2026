/**
 * Required performance gates (§18): structural (counter-based, never
 * wall-clock alone) across stroke sizes and batch shapes, plus
 * derived-cache invalidation proving camera moves never re-fit.
 *
 * During every gesture: zero full geometry compiles, zero full-ring
 * materializations, tail work bounded per append, exactly one
 * authoritative clean compile at finish.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH } from './brush.js';
import {
  LIVE_TAIL_REFRESH_SPANS,
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { compiledStrokeForRecord } from '../objects.js';
import { inkStrokeObject } from '../model.js';
import type { InkSample } from '../model.js';

function diagonal(count: number): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 0.7, y: i * 0.45, pressure: 0.5 });
  }
  return out;
}

/** Deterministic mixed/coalesced burst pattern (no randomness). */
function mixedBatches(samples: InkSample[]): InkSample[][] {
  const pattern = [1, 7, 23, 4, 64, 13, 2, 48, 9, 31];
  const out: InkSample[][] = [];
  let i = 1;
  let k = 0;
  while (i < samples.length) {
    const size = pattern[k % pattern.length]!;
    out.push(samples.slice(i, i + size));
    i += size;
    k++;
  }
  return out;
}

function fixedBatches(samples: InkSample[], size: number): InkSample[][] {
  const out: InkSample[][] = [];
  for (let i = 1; i < samples.length; i += size) {
    out.push(samples.slice(i, i + size));
  }
  return out;
}

describe('performance gates across sizes and batch shapes', () => {
  const counts = [100, 1000, 5000, 10000];
  for (const count of counts) {
    const shapes: {
      name: string;
      batches: (s: InkSample[]) => InkSample[][];
    }[] = [
      { name: '1/batch', batches: (s) => fixedBatches(s, 1) },
      { name: '16/batch', batches: (s) => fixedBatches(s, 16) },
      { name: '100/batch', batches: (s) => fixedBatches(s, 100) },
      { name: 'mixed-bursts', batches: mixedBatches },
    ];
    // Smaller strokes also cover fine/medium/coarse batch extremes.
    const extra =
      count <= 1000
        ? [
            {
              name: '4/batch',
              batches: (s: InkSample[]) => fixedBatches(s, 4),
            },
            {
              name: '50/batch',
              batches: (s: InkSample[]) => fixedBatches(s, 50),
            },
            {
              name: '200/batch',
              batches: (s: InkSample[]) => fixedBatches(s, 200),
            },
          ]
        : [];
    for (const { name, batches } of [...shapes, ...extra]) {
      it(
        `${count} samples in ${name}: O(new+tail) per batch, one commit compile`,
        () => {
          resetLiveCompilerStats();
          const compiler = new LiveInkStrokeCompiler();
          const samples = diagonal(count);
          compiler.begin(samples[0]!, BALL_PEN_BRUSH);
          const groups = batches(samples);
          let maxBatch = 0;
          for (const batch of groups) {
            maxBatch = Math.max(maxBatch, batch.length);
            compiler.append(batch);
          }
          const stats = liveCompilerStats();
          expect(stats.fullCompiles).toBe(0);
          expect(stats.ringMaterializations).toBe(0);
          expect(stats.samplesAppended).toBe(count);
          expect(stats.tailUpdates).toBe(1 + groups.length);
          // Tail tessellation work scales with batches × horizon plus
          // batch-sized growth — never with history length.
          expect(stats.tailSpansRetessellated).toBeLessThanOrEqual(
            groups.length * (LIVE_TAIL_REFRESH_SPANS + maxBatch + 32),
          );
          // Stability-epoch invalidations stay rare against batch count.
          expect(stats.meshEpochInvalidations).toBeLessThanOrEqual(
            Math.max(4, Math.floor(groups.length / 2)),
          );
          const committed = compiler.finish();
          expect(liveCompilerStats().fullCompiles).toBe(1);
          expect(committed.polygon.length).toBeGreaterThan(0);
        },
        // 10k single-sample batches are ~13s of tail-bounded work;
        // everything else is far quicker.
        count >= 10000 ? 120000 : count >= 5000 ? 60000 : 30000,
      );
    }
  }
});

describe('derived geometry cache invalidation', () => {
  const record = () =>
    inkStrokeObject('s1', {
      points: diagonal(60),
      width: BALL_PEN_BRUSH.size,
      brush: { kind: 'ball' },
    });

  it('compiles once per canonical change no matter how often it is read', () => {
    const rec = record();
    const first = compiledStrokeForRecord(rec);
    const second = compiledStrokeForRecord(rec);
    expect(first).not.toBeNull();
    // Same canonical record: identical cached reference (rendering,
    // culling, hit-testing, and selection share one truth without
    // recompiling).
    expect(second).toBe(first);
  });

  it('never re-fits on camera-equivalent re-reads', () => {
    // The cache fingerprint covers canonical samples + width + brush
    // only: there is no camera input to compiling, so pans and zooms
    // cannot invalidate derived geometry by construction. Reading the
    // same record across simulated camera moves hits the cache.
    const rec = record();
    const before = compiledStrokeForRecord(rec);
    for (const camera of [
      { x: 0, y: 0, zoom: 1 },
      { x: 500, y: -200, zoom: 8 },
      { x: -30, y: 44, zoom: 2 },
    ]) {
      void camera;
      expect(compiledStrokeForRecord(rec)).toBe(before);
    }
  });

  it('invalidates exactly once on canonical mutation', () => {
    const rec = record();
    const before = compiledStrokeForRecord(rec);
    // Structural edit (new samples array): fingerprint changes, one
    // recompute, then stable again.
    const edited = {
      ...rec,
      points: [
        ...(rec.points as InkSample[]),
        { x: 100, y: 100, pressure: 0.5 },
      ],
    };
    const recomputed = compiledStrokeForRecord(edited);
    expect(recomputed).not.toBe(before);
    expect(recomputed?.polygon).not.toEqual(before?.polygon);
    expect(compiledStrokeForRecord(edited)).toBe(recomputed);
  });
});
