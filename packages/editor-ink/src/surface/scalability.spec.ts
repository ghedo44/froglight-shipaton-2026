/**
 * Surface scalability gates for the editor layer (Slices 2, 3, 7, 8, 11).
 *
 * - History translate commands clone zero sample arrays (one drag = one undo).
 * - Drag rendering reuses cached geometry (no full redraw per frame, no ghosts).
 * - Opening compiles only visible geometry before first paint.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
// Direct surfaces imports (bypass the package root barrel so this gate
// stays green while unrelated cloud-sync work is in progress).
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  createDefaultSurfaceObjectTypeRegistry,
  SurfaceInteractionController,
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

function installCanvasStubs() {
  const record =
    (_name: string) =>
    (..._args: unknown[]): void => {
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

describe('history translate commands', () => {
  it('200-stroke translate records zero sample clones and stays one undo step', () => {
    const model = bigModel(1000, 250);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const history = new SurfaceGestureHistory(model, registry as never);
    const selected = model.order.slice(0, 200);
    const beforeStats = history.historyStats();
    const beforeFirst = JSON.stringify(
      (model.objects[selected[0]!] as unknown as { points: unknown }).points,
    );

    history.beginGesture();
    history.recordTranslate(selected, 10, 5);
    // Controller-equivalent mutation (one canonical transform, no clones).
    for (const id of selected) {
      const record = model.objects[id]!;
      const translate = registry.get(record.type)?.translate;
      if (translate !== undefined) translate(record, 10, 5);
    }
    history.commitGesture();

    const afterStats = history.historyStats();
    expect(
      afterStats.changedRecordsCaptured - beforeStats.changedRecordsCaptured,
    ).toBe(0);
    expect(afterStats.entries - beforeStats.entries).toBe(1);
    expect(
      JSON.stringify(
        (model.objects[selected[0]!] as unknown as { points: unknown }).points,
      ),
    ).not.toBe(beforeFirst);

    // Undo restores without clones (within floating-point tolerance:
    // (y+dy)-dy may differ by 1 ULP); redo reapplies.
    const undoClones = history.historyStats().changedRecordsCaptured;
    expect(history.undo()).toBe(true);
    expect(history.historyStats().changedRecordsCaptured).toBe(undoClones);
    const undone = (
      model.objects[selected[0]!] as unknown as {
        points: Array<{ x: number; y: number }>;
      }
    ).points;
    const orig = JSON.parse(beforeFirst) as Array<{ x: number; y: number }>;
    expect(undone.length).toBe(orig.length);
    for (let i = 0; i < undone.length; i++) {
      expect(
        Math.abs((undone[i] as { x: number }).x - (orig[i] as { x: number }).x),
      ).toBeLessThan(1e-9);
      expect(
        Math.abs((undone[i] as { y: number }).y - (orig[i] as { y: number }).y),
      ).toBeLessThan(1e-9);
    }
    expect(history.redo()).toBe(true);
    expect(history.historyStats().changedRecordsCaptured).toBe(undoClones);
  }, 30000);
});

describe('created stroke history', () => {
  it('does not serialize a new stroke to compare it with an absent before image', () => {
    const model = emptySurface(boundedFrame(8000, 6000));
    const history = new SurfaceGestureHistory(model);
    const points = strokePoints(0, 0, 10_000);
    const stringify = vi.spyOn(JSON, 'stringify');

    history.beginGesture();
    history.recordBefore('new-stroke');
    model.objects['new-stroke'] = inkStrokeObject('new-stroke', {
      points,
      width: 3,
    });
    model.order.push('new-stroke');
    history.commitGesture();

    expect(
      stringify.mock.calls.some(
        ([value]) =>
          typeof value === 'object' &&
          value !== null &&
          'id' in value &&
          value.id === 'new-stroke',
      ),
    ).toBe(false);
    expect(history.historyStats().changedRecordsCaptured).toBe(1);

    const committed = model.objects['new-stroke'] as unknown as {
      points: Array<{ x: number; y: number }>;
    };
    committed.points[0]!.x = 1234;
    expect(history.undo()).toBe(true);
    expect(model.objects['new-stroke']).toBeUndefined();
    expect(history.redo()).toBe(true);
    expect(
      (model.objects['new-stroke'] as unknown as { points: { x: number }[] })
        .points[0]!.x,
    ).toBe(0);
  });
});

describe('drag rendering layer', () => {
  let stubs: ReturnType<typeof installCanvasStubs> | null = null;
  afterEach(() => {
    stubs?.restore();
    stubs = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('active drag composites without full redraws per frame', () => {
    stubs = installCanvasStubs();
    const model = bigModel(200, 20);
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      const base = renderer.committedStats();

      // Simulate an active selection drag (50 strokes) over 30 frames.
      // Canonical model stays put (ephemeral); sceneVersion never bumps.
      const dragIds = model.order.slice(0, 50);
      for (let frame = 1; frame <= 30; frame++) {
        renderer.render(camera, 1, [], [...dragIds], {
          ids: [...dragIds],
          dx: frame,
          dy: frame * 0.5,
          translatedBounds: {
            x: frame,
            y: frame * 0.5,
            width: 100,
            height: 100,
          },
        });
      }
      const after = renderer.committedStats();
      // The committed cache is never touched by drag frames (separate drag
      // canvas): zero full rebuilds across all 30 frames; exactly one
      // drag-base build (ghosts avoided, highlighter painted once).
      expect(after.fullCacheRebuilds - base.fullCacheRebuilds).toBe(0);
      expect(after.dragBaseRebuilds - base.dragBaseRebuilds).toBe(1);
      // Scene layer compiled nothing new per drag frame (ephemeral):
      // newlyCompiledObjects still reflects the initial full build (no
      // additional compiles during drag frames).
      expect(after.scene.newlyCompiledObjects).toBe(
        base.scene.newlyCompiledObjects,
      );
      expect(after.scene.oldStrokeCompiles).toBe(0);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('tap-select leaves the committed cache intact (no disappearance)', () => {
    // Per-canvas recording contexts: the committed cache canvas must see
    // zero paint calls during drag frames (only the drag canvas paints).
    const noop = (): void => undefined;
    const contexts = new Map<HTMLCanvasElement, { clearRectCalls: number }>();
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
    ) {
      let rec = contexts.get(this);
      if (rec === undefined) {
        rec = { clearRectCalls: 0 };
        contexts.set(this, rec);
        return {
          save: noop,
          restore: noop,
          beginPath: noop,
          clip: noop,
          fill: noop,
          stroke: noop,
          rect: noop,
          fillRect: noop,
          strokeRect: noop,
          fillText: noop,
          ellipse: noop,
          translate: noop,
          rotate: noop,
          setTransform: noop,
          setLineDash: noop,
          clearRect: () => {
            rec!.clearRectCalls += 1;
          },
          drawImage: noop,
          moveTo: noop,
          lineTo: noop,
          arc: noop,
          closePath: noop,
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
        } as unknown as CanvasRenderingContext2D;
      }
      return rec as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      const model = bigModel(50, 20);
      const { ports, cleanup } = makePorts(model);
      // NOTE: makePorts allocates page/canvas/root (no contexts yet).
      const renderer = createCommittedSceneRenderer(ports);
      try {
        const camera = { x: 0, y: 0, zoom: 1 };
        const viewCanvas = ports.canvas;
        // Context creation order inside the renderer is deterministic:
        // view canvas, committed cache, drag canvas.
        const offscreenPaints = (): number[] => {
          const counts: number[] = [];
          for (const [canvas, rec] of contexts) {
            if (canvas !== viewCanvas) counts.push(rec.clearRectCalls);
          }
          return counts;
        };
        renderer.render(camera, 1, [], []);
        // Exactly one offscreen canvas painted so far: the committed cache
        // (the drag canvas context exists but is never painted outside drags).
        expect(offscreenPaints()).toEqual([1, 0]);

        // Tap-select: drag frames with zero delta (a frame runs between
        // pointer-down and pointer-up on real devices), then release with
        // no commit (same sceneVersion).
        const selected = model.order.slice(0, 1);
        const dragState = {
          ids: [...selected],
          dx: 0,
          dy: 0,
          translatedBounds: { x: 0, y: 0, width: 10, height: 10 },
        };
        renderer.render(camera, 1, [], [...selected], dragState);
        renderer.render(camera, 1, [], [...selected], dragState);
        // The committed cache canvas saw ZERO additional paints (only the
        // drag canvas painted once); no full rebuilds for drag frames.
        expect(offscreenPaints()).toEqual([1, 1]);
        const stats = renderer.committedStats();
        expect(stats.fullCacheRebuilds).toBe(1);
        expect(stats.dragBaseRebuilds).toBe(1);

        // Release: same version, no drag. Must composite the INTACT full
        // scene with zero rebuilds (previously the cache held the base
        // WITHOUT the selection → the tapped object disappeared).
        renderer.render(camera, 1, [], [...selected]);
        const released = renderer.committedStats();
        expect(released.fullCacheRebuilds).toBe(1);
        expect(released.dragBaseRebuilds).toBe(1);
        expect(offscreenPaints()).toEqual([1, 1]);
      } finally {
        renderer.dispose();
        cleanup();
      }
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});

describe('viewport lazy open', () => {
  let stubs: ReturnType<typeof installCanvasStubs> | null = null;
  afterEach(() => {
    stubs?.restore();
    stubs = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([100, 500, 1000])(
    'first paint prepares visible only (%s strokes)',
    (count) => {
      stubs = installCanvasStubs();
      const model = bigModel(count, 20);
      // Controller owns the spatial index (cheap bounds, one build).
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
        // Viewport at origin sees only the first rows (~50 strokes with
        // prefetch margin); the rest are offscreen.
        const camera = { x: 0, y: 0, zoom: 1 };
        renderer.render(camera, 1, [], []);
        const stats = renderer.committedStats();
        // Visible + prefetch compiled, offscreen untouched (<< total).
        expect(stats.scene.cachedObjects).toBeLessThan(count);
        expect(stats.scene.cachedObjects).toBeGreaterThan(0);
        expect(stats.scene.viewportPrepares).toBeGreaterThanOrEqual(1);
        expect(stats.scene.fullRebuilds).toBe(0);
      } finally {
        renderer.dispose();
        cleanup();
        controller.destroy();
      }
    },
  );

  it('dense single-viewport document paints a cost-bounded first subset, then fills', async () => {
    stubs = installCanvasStubs();
    // 400 strokes ALL inside the 800×600 viewport: the old path compiled
    // all 400 before first paint; the cost-bounded path paints a
    // geometry-cost subset (item 2 — 20 samples × N ≤ FIRST_PAINT_MAX_COST),
    // then fills progressively. Paper/background paints immediately.
    const model = emptySurface(boundedFrame(800, 600));
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 40; col++) {
        const id = `d${row * 40 + col}`;
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < 20; i++) {
          pts.push({
            x: col * 19 + i,
            y: row * 58 + Math.sin(i / 4) * 4,
          });
        }
        model.objects[id] = inkStrokeObject(id, { points: pts, width: 3 });
        model.order.push(id);
      }
    }
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
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      const first = renderer.committedStats();
      // Cost-bounded first paint: far fewer than the 400 visible strokes
      // (cost ≤ budget, not a fixed 120-item count), no full rebuild,
      // remainder queued for progressive fill.
      expect(first.scene.cachedObjects).toBeLessThan(400);
      expect(first.scene.cachedObjects).toBeGreaterThan(0);
      expect(first.scene.fullRebuilds).toBe(0);
      expect(first.progressPending).toBeGreaterThan(0);
      expect(first.firstPaintVisible).toBeLessThan(400);
      // Cost bound (item 2): 20 samples × cached ≤ budget + one stroke.
      expect(first.firstPaintCost).not.toBeNull();
      expect(first.firstPaintCost as number).toBeLessThanOrEqual(3000 + 20);
      // Let idle/rAF slices run to completion (real timers).
      const deadline = Date.now() + 25000;
      while (
        renderer.committedStats().progressPending > 0 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const done = renderer.committedStats();
      expect(done.progressPending).toBe(0);
      expect(done.scene.cachedObjects).toBe(400);
    } finally {
      renderer.dispose();
      cleanup();
      controller.destroy();
    }
  }, 30000);
});
