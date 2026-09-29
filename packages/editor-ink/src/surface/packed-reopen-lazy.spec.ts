// @vitest-environment jsdom
/**
 * Dense-document lazy packed-cache restore (item 1).
 *
 * A 1000-stroke cached document must NEVER synchronously unpack its whole
 * cache at mount/hydration. The committed renderer's viewport-first
 * preparation queue consults the restore source only for objects it
 * actually reaches:
 *
 * ```text
 * strict viewport (cost-bounded first paint) → prefetch margin →
 * bounded offscreen lookahead
 * ```
 *
 * These tests drive the REAL `createCommittedSceneRenderer` with a
 * controlled `queryVisible`, so "only viewport-priority entries unpack"
 * is structural, not timing-based.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFrame,
  compiledStrokeComputeStats,
  compiledStrokeForRecord,
  createCachedCompiledRestore,
  derivedCacheKey,
  emptySurface,
  inkStrokeObject,
  packCompiledInk,
  SurfaceDerivedCache,
  type Bounds,
  type Camera,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { createCommittedSceneRenderer } from './committed-renderer.js';

const DOC = 'doc-dense-lazy';
const REV = 'rev-1';
const STROKES = 1_000;
const SAMPLES = 40;

function denseModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(40_000, 40_000));
  for (let i = 0; i < STROKES; i++) {
    const id = `s${i}`;
    const points: { x: number; y: number; pressure: number; dt: number }[] = [];
    for (let k = 0; k < SAMPLES; k++) {
      points.push({
        x: 100 + (i % 100) * 300 + k * 2,
        y: 100 + Math.floor(i / 100) * 300 + Math.sin(k / 3) * 4,
        pressure: 0.5,
        dt: k * 8,
      });
    }
    model.objects[id] = inkStrokeObject(id, { points, width: 3 });
    model.order.push(id);
  }
  return model;
}

/** One packed template, cheaply stored under every object's key. */
function cachedDenseCache(): SurfaceDerivedCache {
  const cache = new SurfaceDerivedCache({
    maxCompiledEntries: STROKES + 100,
    maxCompiledBytes: 512 * 1024 * 1024,
  });
  const record = inkStrokeObject('template', {
    points: Array.from({ length: SAMPLES }, (_, k) => ({
      x: 10 + k * 2,
      y: 20 + k,
      pressure: 0.5,
      dt: k * 8,
    })),
    width: 3,
  });
  const compiled = compiledStrokeForRecord(record);
  expect(compiled).not.toBeNull();
  const packed = packCompiledInk(compiled!).packed;
  for (let i = 0; i < STROKES; i++) {
    cache.storeCompiled(derivedCacheKey(DOC, `s${i}`, REV), packed);
  }
  return cache;
}

function makeHost(): {
  page: HTMLElement;
  canvas: HTMLCanvasElement;
  root: HTMLElement;
  cleanup: () => void;
} {
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const root = document.createElement('div');
  page.appendChild(canvas);
  document.body.appendChild(root);
  const rect = {
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect);
  return {
    page,
    canvas,
    root,
    cleanup: () => root.remove(),
  };
}

const CAMERA_A: Camera = { x: 0, y: 0, zoom: 1 };
const CAMERA_B: Camera = { x: 20_000, y: 20_000, zoom: 1 };

describe('dense lazy packed-cache restore', () => {
  let restoreCanvas: (() => void) | null = null;

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('mount/first paint unpack only viewport-priority cached entries', () => {
    restoreCanvas = installCanvasStub();
    const model = denseModel();
    const cache = cachedDenseCache();
    const restore = createCachedCompiledRestore({
      documentId: DOC,
      revision: REV,
      cache,
    });
    const host = makeHost();
    const visibleBounds = { x: -1, y: -1, width: 1, height: 1 };
    const renderer = createCommittedSceneRenderer({
      model,
      presentation: 'paint-stage',
      page: host.page,
      canvas: host.canvas,
      root: host.root,
      frameResizable: false,
      compiledRestore: restore,
      // Every object is "visible" so only the first-paint cost budget can
      // bound the synchronous restore.
      queryVisible: () => model.order,
    });
    // Keep the bound reference (structural: nothing else uses it).
    void (visibleBounds as Bounds);
    try {
      const computesBefore = compiledStrokeComputeStats.computes;
      renderer.render(CAMERA_A, 1, [], []);
      const stats = restore.stats();
      // Bounded synchronous restore: only the cost-budgeted viewport head
      // unpacked; the rest stays packed for progressive preparation.
      expect(stats.restored).toBeGreaterThan(0);
      expect(stats.restored).toBeLessThan(120);
      expect(restore.pending()).toBeGreaterThan(STROKES - 120);
      expect(stats.misses).toBe(0);
      expect(stats.restoreMs).toBeGreaterThanOrEqual(0);
      // Cached restores never compile.
      expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
      // The progressive queue is bounded (viewport band + 512 lookahead).
      const committed = renderer.committedStats();
      expect(committed.progressPending).toBeLessThanOrEqual(STROKES);
    } finally {
      renderer.dispose();
      host.cleanup();
    }
  });

  it('panning reprioritizes cached restore work for newly visible objects', () => {
    restoreCanvas = installCanvasStub();
    const model = denseModel();
    const cache = cachedDenseCache();
    const restore = createCachedCompiledRestore({
      documentId: DOC,
      revision: REV,
      cache,
    });
    const host = makeHost();
    let camera: Camera = CAMERA_A;
    const renderer = createCommittedSceneRenderer({
      model,
      presentation: 'paint-stage',
      page: host.page,
      canvas: host.canvas,
      root: host.root,
      frameResizable: false,
      compiledRestore: restore,
      queryVisible: () =>
        camera === CAMERA_A
          ? model.order.slice(0, 100)
          : model.order.slice(500, 600),
    });
    try {
      renderer.render(camera, 1, [], []);
      const firstRestored = restore.stats().restored;
      expect(firstRestored).toBeGreaterThan(0);
      // First paint prepares the cost-bounded viewport head (3000 / 40).
      expect(firstRestored).toBe(75);
      expect(restore.pending()).toBe(STROKES - 75);

      camera = CAMERA_B;
      renderer.render(camera, 1, [], []);
      const afterPan = restore.stats().restored;
      expect(afterPan).toBeGreaterThan(firstRestored);
      expect(afterPan).toBeLessThanOrEqual(150);
      expect(restore.pending()).toBeLessThan(STROKES - 75);
    } finally {
      renderer.dispose();
      host.cleanup();
    }
  });
});
