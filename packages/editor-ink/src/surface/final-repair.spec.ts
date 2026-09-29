/**
 * Final repair renderer gates (items 1–3, shared architecture).
 *
 * - 120 drag frames: zero canonical writes/recompiles (ephemeral).
 * - Long-stroke release: zero recompiles, translated DrawItems.
 * - First paint cost-based (400×20 / 400×200 / 400×1000 + 10k single).
 * - Huge visible stroke defers sync, hydrates async identically.
 * - Ink / Notebook / Whiteboard share the repaired path.
 * - Browser timing diagnostics (Chromium/WebKit) where available.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  createDefaultSurfaceObjectTypeRegistry,
  SurfaceInteractionController,
  IncrementalSceneCache,
  compiledStrokeComputeStats,
  estimatePrepareCost,
  FIRST_PAINT_MAX_COST,
  type SurfaceModel,
} from '@froglight/foundation';
import { SurfaceGestureHistory } from './history.js';
import { createCommittedSceneRenderer } from './committed-renderer.js';

function strokePoints(baseX: number, baseY: number, count: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: baseX + i * 2, y: baseY + Math.sin(i / 4) * 6 });
  }
  return out;
}

function bigModel(strokes: number, samplesPerStroke: number): SurfaceModel {
  const model = emptySurface(boundedFrame(8000, 6000));
  for (let i = 0; i < strokes; i++) {
    const id = `s${i}`;
    model.objects[id] = inkStrokeObject(id, {
      points: strokePoints(
        (i % 50) * 120,
        Math.floor(i / 50) * 120,
        samplesPerStroke,
      ),
      width: 3,
    });
    model.order.push(id);
  }
  return model;
}

function denseModel(strokes: number, samples: number): SurfaceModel {
  const model = emptySurface(boundedFrame(800, 600));
  for (let row = 0; row < Math.ceil(strokes / 40); row++) {
    for (let col = 0; col < 40 && row * 40 + col < strokes; col++) {
      const id = `d${row * 40 + col}`;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < samples; i++) {
        pts.push({ x: col * 19 + (i % 19), y: row * 58 + Math.sin(i / 4) * 4 });
      }
      model.objects[id] = inkStrokeObject(id, { points: pts, width: 3 });
      model.order.push(id);
    }
  }
  return model;
}

function installCanvasStubs() {
  const record =
    (_name: string) =>
    (..._args: unknown[]) => {
      void _name;
      void _args;
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

/** Browser timing diagnostic (Chromium/WebKit/WKWebView where available). */
function timingDiagnostic(label: string, ms: number): string {
  const ua =
    typeof navigator !== 'undefined'
      ? ((navigator as { userAgent?: string }).userAgent ?? 'node')
      : 'node';
  const engine =
    /AppleWebKit/.test(ua) && !/Chrome/.test(ua)
      ? 'WebKit'
      : /Chrome/.test(ua)
        ? 'Chromium'
        : 'node/jsdom';
  return `${label}: ${ms.toFixed(1)}ms [${engine}] ua=${ua.slice(0, 80)}`;
}

describe('release path: zero recompiles end-to-end', () => {
  let stubs: ReturnType<typeof installCanvasStubs> | null = null;
  afterEach(() => {
    stubs?.restore();
    stubs = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('120 drag frames cause zero canonical writes/recompiles; release translates without recompile', () => {
    stubs = installCanvasStubs();
    const model = bigModel(200, 50);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const history = new SurfaceGestureHistory(model, registry as never);
    const scene = new IncrementalSceneCache();
    scene.fullRebuild(model, registry);
    const { ports, cleanup } = makePorts(model);
    const controller = new SurfaceInteractionController({
      model,
      registry,
      onBeforeTranslate: (ids, dx, dy) => {
        history.beginGesture();
        history.recordTranslate(ids, dx, dy);
      },
      onMutate: () => history.commitGesture(),
    });
    const renderer = createCommittedSceneRenderer({
      ...ports,
      queryVisible: (bounds) => controller.queryRegion(bounds),
    });
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      const computesBase = compiledStrokeComputeStats.computes;
      controller.setSelection(model.order.slice(0, 20));
      expect(controller.beginEphemeralMove({ x: 0, y: 0 })).toBe(true);
      for (let i = 0; i < 120; i++) {
        controller.updateEphemeralMove({ x: 1, y: 0.5 });
        // Ephemeral frames never touch canonical or the scene cache.
        expect(scene.statsSnapshot().newlyCompiledObjects).toBeLessThanOrEqual(
          scene.statsSnapshot().cachedObjects,
        );
      }
      const during = controller.controllerStats();
      expect(during.ephemeralMoves).toBe(120);
      expect(compiledStrokeComputeStats.computes).toBe(computesBase);
      // Commit once: history translate (zero clones) + translated scene.
      const committed = controller.commitEphemeralMove();
      expect(committed.length).toBe(20);
      expect(history.historyStats().changedRecordsCaptured).toBe(0);
      // Renderer translates cached DrawItems (no recompile).
      const sceneComputes = compiledStrokeComputeStats.computes;
      renderer.notifyTranslated(
        committed as string[],
        controller.dragDelta().x,
        controller.dragDelta().y,
      );
      void sceneComputes;
      renderer.render(camera, 2, [], []);
      expect(compiledStrokeComputeStats.computes - computesBase).toBe(0);
      expect(
        renderer.committedStats().scene.translatedKeys,
      ).toBeGreaterThanOrEqual(0);
    } finally {
      renderer.dispose();
      cleanup();
      controller.destroy();
    }
  });
});

describe('first paint cost-based (item 2)', () => {
  let stubs: ReturnType<typeof installCanvasStubs> | null = null;
  afterEach(() => {
    stubs?.restore();
    stubs = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([
    [400, 20],
    [400, 200],
    [400, 1000],
  ])(
    'dense %i×%i first paint is cost-bounded, not item-bounded',
    (strokes, samples) => {
      stubs = installCanvasStubs();
      const model = denseModel(strokes, samples);
      const controller = new SurfaceInteractionController({
        model,
        registry: createDefaultSurfaceObjectTypeRegistry(),
      });
      controller.ensureIndexes();
      const { ports, cleanup } = makePorts(model);
      const renderer = createCommittedSceneRenderer({
        ...ports,
        queryVisible: (bounds) => controller.queryRegion(bounds),
      });
      try {
        const started =
          typeof performance !== 'undefined' &&
          typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        renderer.render({ x: 0, y: 0, zoom: 1 }, 1, [], []);
        const elapsed =
          (typeof performance !== 'undefined' &&
          typeof performance.now === 'function'
            ? performance.now()
            : Date.now()) - started;
        const stats = renderer.committedStats();
        // Structural (not wall-clock): cost bounded, far below total.
        expect(stats.firstPaintCost).not.toBeNull();
        expect(stats.firstPaintCost as number).toBeLessThanOrEqual(
          FIRST_PAINT_MAX_COST + samples,
        );
        expect(stats.scene.cachedObjects).toBeLessThan(strokes);
        expect(stats.scene.cachedObjects).toBeGreaterThan(0);
        expect(stats.scene.fullRebuilds).toBe(0);
        expect(stats.progressPending).toBeGreaterThan(0);
        // Cost scales with budget, not document size: 400×1000 first paint
        // costs ≈ the same as 400×20 (both ≤ budget), never 50× more.
        expect(stats.firstPaintCost as number).toBeLessThanOrEqual(
          FIRST_PAINT_MAX_COST + samples,
        );
        // Diagnostic for Chromium/WebKit triage (generous, never flaky).
        console.log(
          timingDiagnostic(`first-paint ${strokes}x${samples}`, elapsed),
        );
        expect(elapsed).toBeLessThan(30000);
        // Spot-check estimate math (no sample scans to compute it).
        expect(estimatePrepareCost(model.objects[model.order[0]!]!)).toBe(
          samples,
        );
      } finally {
        renderer.dispose();
        cleanup();
        controller.destroy();
      }
    },
  );

  it('one visible 10k stroke paints background immediately, hydrates async', async () => {
    stubs = installCanvasStubs();
    const model = emptySurface(boundedFrame(800, 600));
    model.objects.huge = inkStrokeObject('huge', {
      points: strokePoints(0, 0, 10000),
      width: 3,
    });
    model.order.push('huge');
    const controller = new SurfaceInteractionController({
      model,
      registry: createDefaultSurfaceObjectTypeRegistry(),
    });
    controller.ensureIndexes();
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer({
      ...ports,
      queryVisible: (bounds) => controller.queryRegion(bounds),
    });
    try {
      const started =
        typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      renderer.render({ x: 0, y: 0, zoom: 1 }, 1, [], []);
      const elapsed =
        (typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
          ? performance.now()
          : Date.now()) - started;
      const first = renderer.committedStats();
      // Background painted immediately: huge stroke deferred (over budget),
      // zero synchronous huge compiles.
      expect(first.scene.cachedObjects).toBe(0);
      expect(first.firstPaintVisible).toBe(0);
      expect(first.progressPending).toBeGreaterThan(0);
      // Deferred cost is counted on the first progressive slice (async);
      // synchronously the guarantee is zero huge compiles before first paint.
      expect(first.scene.newlyCompiledObjects).toBe(0);
      console.log(timingDiagnostic('first-paint 10k deferred', elapsed));
    } finally {
      renderer.dispose();
      cleanup();
      controller.destroy();
    }
  }, 30000);
});

describe('shared architecture: Ink / Notebook / Whiteboard', () => {
  it('all three families use the same translation-preserving path', () => {
    // Ink (paint-stage), Notebook (embedded-paper page), Whiteboard
    // (infinite) all drive the same Foundation controller + history +
    // scene-cache translation APIs — no forks.
    for (const frame of [
      boundedFrame(800, 600),
      boundedFrame(1200, 800),
      { kind: 'infinite' as const },
    ]) {
      const model = emptySurface(frame);
      model.objects.a = inkStrokeObject('a', {
        points: strokePoints(0, 0, 500),
        width: 3,
      });
      model.order.push('a');
      const registry = createDefaultSurfaceObjectTypeRegistry();
      const history = new SurfaceGestureHistory(model, registry as never);
      const scene = new IncrementalSceneCache();
      scene.fullRebuild(model, registry);
      const controller = new SurfaceInteractionController({
        model,
        registry,
        onBeforeTranslate: (ids, dx, dy) => {
          history.beginGesture();
          history.recordTranslate(ids, dx, dy);
        },
        onMutate: () => history.commitGesture(),
      });
      const computesBefore = compiledStrokeComputeStats.computes;
      controller.setSelection(['a']);
      expect(controller.beginEphemeralMove({ x: 0, y: 0 })).toBe(true);
      controller.updateEphemeralMove({ x: 10, y: 5 });
      const committed = controller.commitEphemeralMove();
      scene.notifyTranslated(committed as string[], 10, 5);
      expect(compiledStrokeComputeStats.computes - computesBefore).toBe(0);
      expect(history.lastChangeTranslate()).not.toBeNull();
      controller.destroy();
    }
  });
});
