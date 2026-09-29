/**
 * Live chunk-publish structural gate: per pointer batch the compiler must
 * do O(new samples + bounded tail) work with ZERO history-sized copies.
 *
 * The old preview path materialized a full outline ring per batch
 * (cumulative O(n²) over a stroke); `append()` now publishes a chunk view
 * over retained mesh state (frozen head refs + bounded mutable tail) and
 * a complete polygon is assembled only by explicit snapshot APIs. These
 * gates pin that with deterministic instrumentation counters — never
 * wall-clock alone — across batch shapes from 1 sample (worst-case event
 * granularity) to coalesced bursts.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH, brushPresetForKind } from './brush.js';
import { materializeLiveMeshRing } from '../draw.js';
import {
  LIVE_TAIL_REFRESH_SPANS,
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import type { LiveStrokeMeshView } from '../draw.js';
import { longHandwriting } from './fixtures.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

function diagonal(count: number): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 0.7, y: i * 0.45, pressure: 0.5 });
  }
  return out;
}

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
  // Subsampled for large rings (every kth vertex): still a valid upper
  // bound on outline disagreement, at full resolution for small rings.
  const step = Math.max(1, Math.floor(Math.max(a.length, b.length) / 2000));
  let worst = 0;
  for (let i = 0; i < a.length; i += step) {
    worst = Math.max(worst, distToRing(a[i]!, b));
  }
  for (let i = 0; i < b.length; i += step) {
    worst = Math.max(worst, distToRing(b[i]!, a));
  }
  return worst;
}

describe('live chunk-publish structural gate', () => {
  for (const [batchSize, count] of [
    [1, 1000],
    [4, 2000],
    [16, 2000],
  ] as const) {
    it(`materializes zero rings over ${count} samples in batches of ${batchSize}`, () => {
      resetLiveCompilerStats();
      const compiler = new LiveInkStrokeCompiler();
      const samples = diagonal(count);
      compiler.begin(samples[0]!, BALL_PEN_BRUSH);
      let lastMesh: LiveStrokeMeshView | null = null;
      for (let i = 1; i < samples.length; i += batchSize) {
        const update = compiler.append(samples.slice(i, i + batchSize));
        expect(update.nodeCount).toBeGreaterThan(0);
        if (update.mesh !== null) lastMesh = update.mesh;
      }
      const stats = liveCompilerStats();
      // No full compiles, no full-ring materializations during the
      // gesture — history-proportional preview work is zero, not
      // proportional to batch count.
      expect(stats.fullCompiles).toBe(0);
      expect(stats.ringMaterializations).toBe(0);
      expect(stats.samplesAppended).toBe(count);
      expect(lastMesh?.spineLength).toBeGreaterThan(0);
      // Exactly one authoritative clean compile at commit.
      const committed = compiler.finish();
      expect(liveCompilerStats().fullCompiles).toBe(1);
      expect(committed.polygon.length).toBeGreaterThan(0);
    }, 60000);
  }

  it('keeps per-append tessellation work independent of history length', () => {
    // Same batch shape at two history lengths: average re-tessellated
    // spans per append must not grow with n (O(n²) would multiply it).
    const averages: number[] = [];
    for (const count of [1000, 10000]) {
      resetLiveCompilerStats();
      const compiler = new LiveInkStrokeCompiler();
      const samples = diagonal(count);
      compiler.begin(samples[0]!, BALL_PEN_BRUSH);
      for (let i = 1; i < samples.length; i += 16) {
        compiler.append(samples.slice(i, i + 16));
      }
      const stats = liveCompilerStats();
      expect(stats.ringMaterializations).toBe(0);
      averages.push(stats.tailSpansRetessellated / stats.tailUpdates);
    }
    // Bounded tail work: ~refresh horizon per append at any length.
    expect(averages[0]).toBeLessThan(LIVE_TAIL_REFRESH_SPANS * 3);
    expect(averages[1]).toBeLessThan(LIVE_TAIL_REFRESH_SPANS * 3);
    expect(averages[1]).toBeLessThan(averages[0] * 2);
  });

  it('materializes chunk views to the committed ring', () => {
    resetLiveCompilerStats();
    const brush = brushPresetForKind('brush');
    const compiler = new LiveInkStrokeCompiler();
    const samples = longHandwriting(1500);
    compiler.begin(samples[0]!, brush);
    let lastMesh: LiveStrokeMeshView | null = null;
    for (let i = 1; i < samples.length; i += 25) {
      const update = compiler.append(samples.slice(i, i + 25));
      if (update.mesh !== null) lastMesh = update.mesh;
    }
    expect(liveCompilerStats().ringMaterializations).toBe(0);
    const committed = compiler.finish();
    // Chunks carry the full stroke: materialized view converges to the
    // commit within the screen-derived visual budget (1px at 8× zoom).
    expect(lastMesh).not.toBeNull();
    const ring = materializeLiveMeshRing(lastMesh!);
    expect(hausdorff(ring, committed.polygon)).toBeLessThan(0.125);
  }, 60000);

  it('pins frozen-head stability for backend caches', () => {
    // The (epoch, frozenSpine) contract: the frozen count may only ever
    // regress across an epoch bump. Backends rely on this to cache head
    // geometry without tearing.
    resetLiveCompilerStats();
    const brush = brushPresetForKind('brush');
    const compiler = new LiveInkStrokeCompiler();
    const samples = longHandwriting(2000);
    compiler.begin(samples[0]!, brush);
    let prevFrozen = 0;
    let prevEpoch = 0;
    let first = true;
    for (let i = 1; i < samples.length; i += 7) {
      const update = compiler.append(samples.slice(i, i + 7));
      const mesh = update.mesh;
      if (mesh === null) continue;
      if (!first) {
        if (mesh.frozenSpine < prevFrozen) {
          expect(mesh.epoch).toBeGreaterThan(prevEpoch);
        }
      }
      first = false;
      prevFrozen = mesh.frozenSpine;
      prevEpoch = mesh.epoch;
    }
    // The frozen head actually grows (caching is worthwhile) and epoch
    // invalidations stay rare against batch count.
    expect(prevFrozen).toBeGreaterThan(100);
    const stats = liveCompilerStats();
    expect(stats.meshEpochInvalidations).toBeLessThan(stats.tailUpdates / 4);
  });

  it('publishes bounded rings for dots and meshes past the dot phase', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin({ x: 0, y: 0, pressure: 0.5 }, BALL_PEN_BRUSH);
    const dot = compiler.append([]);
    expect(dot.mesh).toBeNull();
    expect((dot.ring ?? []).length).toBeLessThanOrEqual(32);
    const stroke = compiler.append([
      { x: 10, y: 0, pressure: 0.5 },
      { x: 20, y: 5, pressure: 0.5 },
    ]);
    expect(stroke.mesh?.spineLength).toBeGreaterThan(1);
    expect(stroke.ring).toBeNull();
    expect(liveCompilerStats().ringMaterializations).toBe(0);
  });

  it('reuses the publish version for duplicate-only appends', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const samples = diagonal(100);
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    for (let i = 1; i < samples.length; i += 10) {
      compiler.append(samples.slice(i, i + 10));
    }
    const update = compiler.append([]);
    expect(update.version).toBeGreaterThan(0);
    // Re-appending the last sample is a duplicate: no geometry work, same
    // version, so paints replay backend caches.
    const last = samples[samples.length - 1]!;
    const again = compiler.append([{ ...last }]);
    expect(again.version).toBe(update.version);
    expect(liveCompilerStats().ringMaterializations).toBe(0);
  });
});
