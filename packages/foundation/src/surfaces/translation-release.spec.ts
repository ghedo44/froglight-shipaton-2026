/**
 * Long-stroke pointer-up translation at the controller level.
 *
 * STRUCTURAL UNIT TEST — not a full production release measurement. It
 * exercises `SurfaceInteractionController` only: no mounted Surface, no
 * committed renderer, no Canvas, no rAF, no cache update, no post-pointerup
 * paint. The jsdom structural release suite
 * (`packages/editor-ink/src/surface/release-benchmark.spec.ts`) stubs
 * Canvas/rAF and pins the mount → pointerup → committed-repaint structure;
 * REAL Canvas2D + browser `requestAnimationFrame` timings come from the
 * Chromium Playwright benchmark
 * (`apps/web/tests/ink-release-bench.spec.ts`), and physical
 * iPad/WKWebView numbers require an actual device run.
 *
 * This suite keeps the controller contract pinned: translation avoids Ink
 * recompilation, commits canonically exactly once per drag, and moves
 * multi-chunk logical strokes (> 10k samples, split at the 10k codec cap)
 * as ONE stroke. Wall-clock timings are REPORTED (console) for context,
 * never asserted: CI machines vary. All gates use deterministic
 * structural counters.
 */

import { describe, expect, it } from 'vitest';
import {
  compiledStrokeComputeStats,
  compiledStrokeForRecord,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  infiniteFrame,
  inkStrokeObject,
  SurfaceInteractionController,
  type SurfaceModel,
} from './index.js';

function now(): number {
  try {
    const perf = (globalThis as unknown as { performance?: { now(): number } })
      .performance;
    if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  } catch {
    // Fall through to Date.now.
  }
  return Date.now();
}

interface LongStroke {
  readonly model: SurfaceModel;
  /** All chunk ids in paint order (one id for single-record strokes). */
  readonly ids: string[];
  readonly totalSamples: number;
}

/**
 * One logical stroke with `total` samples: a single record at or below
 * the 10k codec cap, else sequential storage chunks sharing one
 * `logicalId` (the production long-stroke shape — one continuous
 * gesture, joint derived compilation, single selection identity).
 */
function longStroke(total: number): LongStroke {
  const model = emptySurface(infiniteFrame());
  const ids: string[] = [];
  const perChunk = 10_000;
  const chunks = Math.max(1, Math.ceil(total / perChunk));
  const logicalId = 'long-1';
  let made = 0;
  for (let c = 0; c < chunks; c++) {
    const id = chunks === 1 ? 'long-1' : `long-1#c${c}`;
    const count = Math.min(perChunk, total - made);
    const points: { x: number; y: number; pressure: number; dt: number }[] = [];
    for (let k = 0; k < count; k++) {
      const i = made + k;
      points.push({
        x: (i % 2000) * 2,
        y: Math.floor(i / 2000) * 40 + Math.sin(i / 7) * 5,
        pressure: 0.5,
        dt: i,
      });
    }
    made += count;
    model.objects[id] = inkStrokeObject(id, {
      points,
      width: 3.5,
      ...(chunks === 1 ? {} : { logicalId, chunkIndex: c }),
    });
    model.order.push(id);
    ids.push(id);
  }
  return { model, ids, totalSamples: made };
}

function firstPointOf(
  model: SurfaceModel,
  id: string,
): { x: number; y: number } {
  const points = (
    model.objects[id] as unknown as { points: { x: number; y: number }[] }
  ).points;
  return { x: points[0]!.x, y: points[0]!.y };
}

interface ReleaseReport {
  readonly samples: number;
  readonly chunks: number;
  readonly dragFramesMs: number;
  readonly canonicalMs: number;
  readonly derivedMs: number;
  readonly fullReleaseMs: number;
  readonly computes: number;
}

const reports: ReleaseReport[] = [];

describe.each([
  { samples: 1_000, timeout: 30_000 },
  { samples: 10_000, timeout: 30_000 },
  { samples: 50_000, timeout: 60_000 },
  { samples: 100_000, timeout: 120_000 },
])('release at $samples samples', ({ samples, timeout }) => {
  it(
    'translates with zero recompiles and reports the cost breakdown',
    () => {
      const { model, ids, totalSamples } = longStroke(samples);
      expect(totalSamples).toBe(samples);
      const registry = createDefaultSurfaceObjectTypeRegistry();

      // Warm compiled geometry + indexes OUTSIDE the measurement (cold
      // compile cost belongs to the cold-open story, not release).
      for (const id of ids) {
        compiledStrokeForRecord(model.objects[id]!);
      }
      const controller = new SurfaceInteractionController({
        model,
        registry,
      });
      controller.ensureIndexes();

      const computesBase = compiledStrokeComputeStats.computes;
      const grab = firstPointOf(model, ids[0]!);
      const statsBase = controller.controllerStats();

      // Drag frames: ephemeral only — canonical stays untouched no
      // matter how many pointer events a 120/240Hz device delivers.
      controller.pointerDown({ point: { x: grab.x, y: grab.y } });
      expect(controller.selection().length).toBeGreaterThan(0);
      const framesStart = now();
      const frames = 60;
      for (let f = 1; f <= frames; f++) {
        controller.pointerMove({ point: { x: grab.x + f, y: grab.y + f } });
      }
      const dragFramesMs = now() - framesStart;
      const midStats = controller.controllerStats();
      expect(
        midStats.canonicalSamplesTranslated -
          statsBase.canonicalSamplesTranslated,
      ).toBe(0);
      expect(midStats.ephemeralMoves - statsBase.ephemeralMoves).toBe(frames);
      controller.pointerCancel();
      expect(firstPointOf(model, ids[0]!)).toEqual(grab);

      // Canonical rewrite in isolation (direct type-owned translate).
      const dx = 40;
      const dy = 24;
      const canonicalStart = now();
      for (const id of ids) {
        const record = model.objects[id]!;
        registry.get(record.type)?.translate?.(record, dx, dy);
      }
      const canonicalMs = now() - canonicalStart;
      // Undo the isolated rewrite so the full-gesture measurement starts
      // from pristine coordinates (translate back exactly once).
      for (const id of ids) {
        const record = model.objects[id]!;
        registry.get(record.type)?.translate?.(record, -dx, -dy);
      }
      expect(firstPointOf(model, ids[0]!).x).toBeCloseTo(grab.x, 9);

      // Derived translation in isolation (no canonical rewrite here).
      const derivedStart = now();
      controller.translateDerived(ids, dx, dy);
      const derivedMs = now() - derivedStart;
      // Restore derived caches to match canonical (translate back).
      controller.translateDerived(ids, -dx, -dy);

      // Full controller gesture: down → moves → pointer-up commit.
      // (Re-based: the isolated canonical/derived phases above also
      // exercise the translation path by design. For the mounted,
      // rendered, painted production gesture see the release benchmark.)
      const originals = new Map(
        ids.map((id) => [id, firstPointOf(model, id)] as const),
      );
      const statsPre = controller.controllerStats();
      const fullStart = now();
      controller.pointerDown({ point: { x: grab.x, y: grab.y } });
      controller.pointerMove({ point: { x: grab.x + dx, y: grab.y + dy } });
      controller.pointerUp({ point: { x: grab.x + dx, y: grab.y + dy } });
      const fullReleaseMs = now() - fullStart;

      // Structural gates (machine-independent).
      const stats = controller.controllerStats();
      // No B-spline fitting, fairing, tessellation, or mesh rebuilds
      // anywhere in the release path (all phases above).
      expect(compiledStrokeComputeStats.computes - computesBase).toBe(0);
      // Exactly one canonical commit for the gesture…
      expect(stats.dragCommits - statsPre.dragCommits).toBe(1);
      expect(stats.translationCommits - statsPre.translationCommits).toBe(1);
      // …covering every sample exactly once (logical chunks included)…
      expect(
        stats.canonicalSamplesTranslated - statsPre.canonicalSamplesTranslated,
      ).toBe(samples);
      // …with derived bounds shifted, never rescanned.
      expect(
        stats.translatedBoundsUpdates - statsPre.translatedBoundsUpdates,
      ).toBeGreaterThanOrEqual(ids.length);
      // Post-release reads reuse translated geometry (still no compiles).
      const hit = controller.hitTest({ x: grab.x + dx, y: grab.y + dy });
      expect(hit).not.toBeNull();
      expect(compiledStrokeComputeStats.computes - computesBase).toBe(0);
      // Every chunk moved by exactly (dx, dy): one logical stroke.
      for (const id of ids) {
        const before = originals.get(id)!;
        const after = firstPointOf(model, id);
        expect(after.x).toBeCloseTo(before.x + dx, 9);
        expect(after.y).toBeCloseTo(before.y + dy, 9);
      }

      reports.push({
        samples,
        chunks: ids.length,
        dragFramesMs,
        canonicalMs,
        derivedMs,
        fullReleaseMs,
        computes: compiledStrokeComputeStats.computes - computesBase,
      });
      controller.destroy();
    },
    timeout,
  );
});

describe('release report', () => {
  it('logs controller-phase context timings (structural suite)', () => {
    expect(reports.length).toBe(4);
    for (const report of reports) {
      expect(report.computes).toBe(0);
    }
    // Visible in CI logs: the remaining O(N) cost, per phase, per size.
    // eslint-disable-next-line no-console
    console.log(
      `translation-release (ms): ${reports
        .map(
          (r) =>
            `${r.samples} samples/${r.chunks} chunks: ` +
            `dragFrames(60)=${r.dragFramesMs.toFixed(1)} ` +
            `canonical=${r.canonicalMs.toFixed(1)} ` +
            `derived=${r.derivedMs.toFixed(1)} ` +
            `full=${r.fullReleaseMs.toFixed(1)}`,
        )
        .join(' | ')}`,
    );
  });
});
