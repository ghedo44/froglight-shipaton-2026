/**
 * Large-document freeze regression (live-writing repair §5–§8).
 *
 * Physical bug: with many existing lines, finishing a new line froze the
 * UI for seconds (full-document JSON undo snapshots + full scene recompile
 * + full committed repaint per stroke — all O(total samples)).
 *
 * This gate measures STRUCTURAL counters, not wall-clock time:
 *
 * - History: no full-model serializations, no unchanged-record copies,
 *   changed captures ≈ the new logical stroke only.
 * - Scene: no old-stroke recompiles/fingerprint scans, newly compiled ≈1.
 * - Committed: no full cache rebuild for a simple topmost append, newly
 *   drawn ≈1.
 *
 * A generous wall-clock benchmark is retained to catch GC/main-thread
 * stalls, but the structural counters are the deterministic gate.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  createDefaultSurfaceObjectTypeRegistry,
  IncrementalSceneCache,
  type SurfaceModel,
} from '@froglight/foundation';
import { SurfaceGestureHistory } from './history.js';
import { createCommittedSceneRenderer } from './committed-renderer.js';

function strokePoints(baseX: number, baseY: number, count: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    // Deterministic gentle curve (realistic handwriting-like deltas).
    out.push({ x: baseX + i * 2, y: baseY + Math.sin(i / 4) * 6 });
  }
  return out;
}

function bigModel(strokes: number, samplesPerStroke: number): SurfaceModel {
  const model = emptySurface(boundedFrame(4000, 3000));
  for (let i = 0; i < strokes; i++) {
    const id = `s${i}`;
    model.objects[id] = inkStrokeObject(id, {
      points: strokePoints((i % 50) * 60, Math.floor(i / 50) * 60, samplesPerStroke),
      width: 3,
    });
    model.order.push(id);
  }
  return model;
}

function installCanvasStubs() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      void args;
    };
  const context = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    rect: record('rect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    ellipse: record('ellipse'),
    translate: record('translate'),
    rotate: record('rotate'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    closePath: record('closePath'),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    canvas: null,
  };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return {
    calls,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    },
  };
}

function makePorts(model: SurfaceModel) {
  const page = document.createElement('div');
  page.style.width = '800px';
  page.style.height = '600px';
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    toJSON: () => ({}),
  } as DOMRect);
  const canvas = document.createElement('canvas');
  const root = document.createElement('div');
  document.body.appendChild(page);
  document.body.appendChild(canvas);
  document.body.appendChild(root);
  return {
    page,
    canvas,
    root,
    ports: {
      model,
      presentation: 'paint-stage' as const,
      page,
      canvas,
      root,
      backgroundItems: () => [],
      frameResizable: false,
    },
    cleanup: () => {
      page.remove();
      canvas.remove();
      root.remove();
    },
  };
}

describe('large-document freeze regression', () => {
  let stubs: ReturnType<typeof installCanvasStubs> | null = null;
  afterEach(() => {
    stubs?.restore();
    stubs = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([100, 500, 1000])(
    'adding one short stroke to a %s-stroke document touches only the newcomer',
    (count) => {
      const model = bigModel(count, 20);
      const totalSamples = count * 20;

      // --- History (patch, never full JSON) ---
      const history = new SurfaceGestureHistory(model);
      const beforeStats = history.historyStats();
      history.beginGesture();
      const newId = `new-${count}`;
      history.recordBefore(newId);
      model.objects[newId] = inkStrokeObject(newId, {
        points: strokePoints(10, 10, 20),
        width: 3,
      });
      model.order.push(newId);
      history.commitGesture();
      const afterStats = history.historyStats();
      expect(afterStats.fullModelSerializations).toBe(0);
      expect(afterStats.unchangedRecordsCopied).toBe(0);
      // Changed captures ≈ the new logical stroke only (before absent +
      // after clone = 1–2 clones, never O(totalSamples)). The order shell
      // (id list) is not counted as a record copy.
      const changedDelta =
        afterStats.changedRecordsCaptured - beforeStats.changedRecordsCaptured;
      expect(changedDelta).toBeLessThanOrEqual(2);
      expect(changedDelta).toBeGreaterThanOrEqual(1);
      void totalSamples;

      // Undo removes only the newcomer; redo restores it at its position.
      expect(history.undo()).toBe(true);
      expect(model.objects[newId]).toBeUndefined();
      expect(model.order).not.toContain(newId);
      // Pre-existing strokes untouched by undo (same count, same ids).
      expect(model.order).toHaveLength(count);
      expect(history.redo()).toBe(true);
      expect(model.objects[newId]).toBeDefined();
      expect(model.order[model.order.length - 1]).toBe(newId);
    },
  );

  it('scene compilation touches only the new logical stroke', () => {
    const model = bigModel(1000, 20);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const cache = new IncrementalSceneCache();
    cache.fullRebuild(model, registry);
    const base = cache.statsSnapshot();
    expect(base.cachedObjects).toBe(1000);

    // One short newcomer (20 samples) on top.
    const newId = 'new-scene';
    model.objects[newId] = inkStrokeObject(newId, {
      points: strokePoints(10, 10, 20),
      width: 3,
    });
    model.order.push(newId);
    const items = cache.update(model, registry, [newId]);
    const stats = cache.statsSnapshot();
    expect(stats.oldStrokeCompiles).toBe(0);
    expect(stats.oldStrokeFingerprintScans).toBe(0);
    expect(stats.newlyCompiledObjects).toBe(1);
    expect(items.length).toBe(1001);
  });

  it('simple append does not repaint the entire committed document', () => {
    stubs = installCanvasStubs();
    const model = bigModel(1000, 20);
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      const base = renderer.committedStats();
      expect(base.fullCacheRebuilds).toBeGreaterThanOrEqual(1);

      // One short topmost newcomer, same camera/viewport/background/order
      // prefix (simple append fast path).
      const newId = 'new-committed';
      model.objects[newId] = inkStrokeObject(newId, {
        points: strokePoints(10, 10, 20),
        width: 3,
      });
      model.order.push(newId);
      renderer.notifyContentMutated([newId]);
      renderer.render(camera, 2, [], []);
      const after = renderer.committedStats();
      // No full clear+redraw for the simple append.
      expect(after.fullCacheRebuilds - base.fullCacheRebuilds).toBe(0);
      // Exactly the newcomer painted (O(new), not O(document)).
      const drawnDelta =
        after.newlyDrawnCommittedItems - base.newlyDrawnCommittedItems;
      expect(drawnDelta).toBeGreaterThanOrEqual(1);
      expect(drawnDelta).toBeLessThanOrEqual(2);
      // Scene layer likewise compiled only the newcomer.
      expect(after.scene.oldStrokeCompiles).toBe(0);
      expect(after.scene.oldStrokeFingerprintScans).toBe(0);
      expect(after.scene.newlyCompiledObjects).toBe(1);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('finishing a 20-sample stroke stays close to small-document cost (benchmark)', () => {
    const small = bigModel(1, 20);
    const large = bigModel(1000, 20);
    const registry = createDefaultSurfaceObjectTypeRegistry();

    function timeNewStroke(model: SurfaceModel): number {
      const history = new SurfaceGestureHistory(model);
      const cache = new IncrementalSceneCache();
      cache.fullRebuild(model, registry);
      const id = `bench-${Math.random().toString(36).slice(2, 8)}`;
      const started = performance.now();
      history.beginGesture();
      history.recordBefore(id);
      model.objects[id] = inkStrokeObject(id, {
        points: strokePoints(5, 5, 20),
        width: 3,
      });
      model.order.push(id);
      history.commitGesture();
      cache.update(model, registry, [id]);
      // Undo/redo the newcomer (patch-only, no full rescan).
      history.undo();
      history.redo();
      return performance.now() - started;
    }

    const smallMs = timeNewStroke(small);
    // Clean up the bench stroke from the small model (not needed further).
    void smallMs;
    const largeMs = timeNewStroke(large);
    // Generous CI budget: the operation must remain interactive (no
    // multi-second freeze) and must not grow with total samples. The
    // structural gates above prove O(new); this pins the wall-clock tail
    // (GC/main-thread stalls) without being flaky on shared runners.
    expect(largeMs).toBeLessThan(5000);
    // Close to the small-document cost (within an order of magnitude —
    // the point is "not O(total samples)", not cycle-exact parity).
    // Small-doc times near zero are noisy; floor the denominator.
    const ratio = largeMs / Math.max(smallMs, 1);
    expect(ratio).toBeLessThan(25);
  });
});
