// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  inkStrokeObject,
  rectangleObject,
  textObject,
  cardObject,
  BALL_PEN_BRUSH,
  LiveInkStrokeCompiler,
  type DrawItem,
  type Bounds,
  type SurfaceModel,
} from '@froglight/foundation';
import { CanvasSurfaceRendererBackend } from '@froglight/surface-default';
import { createCommittedSceneRenderer } from './committed-renderer.js';

/**
 * Per-canvas context stubs with paint-stamp tracking: every fill/stroke
 * records the object id being drawn (attributed by the backend `draw`
 * seam), `drawImage` copies the source canvas's stamps (compositing),
 * and `clearRect` wipes them. Lets raster semantics — including stale
 * pixels surviving an uncleared blit — be asserted without real pixels.
 */
function installCanvasStubs() {
  const calls: string[] = [];
  const stampsByCanvas = new Map<
    HTMLCanvasElement,
    {
      objectId: string | null;
      tx: number;
      ty: number;
      strokeStyle: string;
      args: readonly unknown[];
    }[]
  >();
  let currentDraw: { objectId: string; tx: number; ty: number } | null = null;
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      void args;
    };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalDraw = CanvasSurfaceRendererBackend.prototype.draw;
  CanvasSurfaceRendererBackend.prototype.draw = function (
    item: Parameters<typeof originalDraw>[0],
    transform?: Parameters<typeof originalDraw>[1],
  ) {
    currentDraw = {
      objectId: item.objectId,
      tx: transform?.tx ?? 0,
      ty: transform?.ty ?? 0,
    };
    try {
      return originalDraw.call(this, item, transform);
    } finally {
      currentDraw = null;
    }
  };
  const contextFor = (canvas: HTMLCanvasElement) => {
    let stamps = stampsByCanvas.get(canvas);
    if (stamps === undefined) {
      stamps = [];
      stampsByCanvas.set(canvas, stamps);
    }
    let strokeStyleValue = '';
    const paint = (name: string, ...paintArgs: unknown[]) => {
      record(name)();
      stamps.push({
        objectId: currentDraw?.objectId ?? null,
        tx: currentDraw?.tx ?? 0,
        ty: currentDraw?.ty ?? 0,
        strokeStyle: strokeStyleValue,
        args: paintArgs,
      });
    };
    return {
      save: record('save'),
      restore: record('restore'),
      beginPath: record('beginPath'),
      clip: record('clip'),
      fill: () => paint('fill'),
      stroke: () => paint('stroke'),
      rect: record('rect'),
      fillRect: () => paint('fillRect'),
      strokeRect: (...args: unknown[]) => paint('strokeRect', ...args),
      fillText: () => paint('fillText'),
      ellipse: record('ellipse'),
      translate: record('translate'),
      rotate: record('rotate'),
      setTransform: record('setTransform'),
      setLineDash: record('setLineDash'),
      clearRect: () => {
        record('clearRect')();
        stamps.length = 0;
      },
      drawImage: (src: HTMLCanvasElement) => {
        record('drawImage')();
        for (const stamp of stampsByCanvas.get(src) ?? []) {
          stamps.push({ ...stamp });
        }
      },
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      closePath: record('closePath'),
      arc: record('arc'),
      fillStyle: '',
      get strokeStyle() {
        return strokeStyleValue;
      },
      set strokeStyle(value: string) {
        strokeStyleValue = value;
      },
      font: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      textAlign: 'left',
      textBaseline: 'alphabetic',
      canvas,
    } as unknown as CanvasRenderingContext2D;
  };
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return contextFor(this);
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return {
    calls,
    canvases: () => [...stampsByCanvas.keys()],
    /** Paint stamps recorded on one canvas (object id + derived transform). */
    drawsFor: (canvas: HTMLCanvasElement) => stampsByCanvas.get(canvas) ?? [],
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      CanvasSurfaceRendererBackend.prototype.draw = originalDraw;
    },
  };
}

function makeModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(800, 600));
  model.objects['r1'] = rectangleObject('r1', {
    x: 10,
    y: 10,
    width: 100,
    height: 50,
  });
  model.order.push('r1');
  return model;
}

function makePorts(
  model: SurfaceModel,
  overrides: Record<string, unknown> = {},
) {
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
      frameResizable: true,
      ...overrides,
    },
    cleanup: () => {
      page.remove();
      canvas.remove();
      root.remove();
    },
  };
}

describe('committed scene renderer', () => {
  let stubs: ReturnType<typeof installCanvasStubs> | null = null;
  afterEach(() => {
    stubs?.restore();
    stubs = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders a zoomed Retina page through a sharp bounded window and releases buffers', () => {
    stubs = installCanvasStubs();
    vi.stubGlobal('devicePixelRatio', 2);
    const { ports, page, canvas, cleanup } = makePorts(makeModel());
    vi.mocked(page.getBoundingClientRect).mockReturnValue({
      width: 6400,
      height: 4800,
      left: 0,
      top: 0,
    } as DOMRect);
    const renderViewport = document.createElement('div');
    vi.spyOn(renderViewport, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 600,
      left: 2000,
      top: 1500,
    } as DOMRect);
    const queried: Bounds[] = [];
    const renderer = createCommittedSceneRenderer({
      ...ports,
      renderViewport,
      queryVisible: (bounds) => {
        queried.push(bounds);
        return [];
      },
    });
    try {
      renderer.render({ x: 0, y: 0, zoom: 8 }, 1, [], []);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(4096 * 4096);
      expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(4096);
      expect(renderer.viewport()).toMatchObject({ width: 6400, height: 4800 });
      expect(renderer.viewport().dpr).toBe(2);
      expect(canvas.width).toBe((800 + 128) * 2);
      expect(stubs!.canvases()).toHaveLength(3);
      for (const buffer of stubs!.canvases()) {
        expect(buffer.width).toBe(canvas.width);
        expect(buffer.height).toBe(canvas.height);
      }
      expect(canvas.height).toBe((600 + 128) * 2);
      expect(canvas.style.left).toBe('1936px');
      expect(canvas.style.top).toBe('1436px');
      expect(queried).toContainEqual({
        x: 1936 / 8,
        y: 1436 / 8,
        width: 928 / 8,
        height: 728 / 8,
      });
      // Scrolling moves the raster camera without changing scale or fitting
      // the whole document inside the small window.
      vi.mocked(renderViewport.getBoundingClientRect).mockReturnValue({
        width: 800,
        height: 600,
        left: 2400,
        top: 1900,
      } as DOMRect);
      renderer.render({ x: 0, y: 0, zoom: 8 }, 1, [], []);
      expect(canvas.style.left).toBe('2336px');
      expect(canvas.style.top).toBe('1836px');
      expect(canvas.width).toBe(1856);
      expect(queried.some((b) => b.x === 2336 / 8 && b.y === 1836 / 8)).toBe(
        true,
      );
      renderer.dispose();
      for (const buffer of stubs!.canvases()) {
        expect(buffer.width * buffer.height).toBe(0);
      }
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });

  it('repairs changed and deleted pixels without repainting distant items', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    model.objects.overlap = rectangleObject('overlap', {
      x: 40,
      y: 20,
      width: 100,
      height: 50,
    });
    model.objects.far = rectangleObject('far', {
      x: 500,
      y: 400,
      width: 50,
      height: 50,
    });
    model.order.push('overlap', 'far');
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    const camera = { x: 0, y: 0, zoom: 1 };
    try {
      renderer.render(camera, 1, [], []);
      const draw = vi.spyOn(CanvasSurfaceRendererBackend.prototype, 'draw');
      const rebuilds = renderer.committedStats().fullCacheRebuilds;
      model.objects.r1 = { ...model.objects.r1!, fill: '#ff0000' };
      renderer.notifyContentMutated(['r1']);
      renderer.render(camera, 2, [], []);
      expect(draw.mock.calls.map(([item]) => item.objectId)).toEqual([
        'r1',
        'overlap',
      ]);
      expect(renderer.committedStats().fullCacheRebuilds).toBe(rebuilds);
      draw.mockClear();
      delete model.objects.r1;
      model.order.splice(0, 1);
      renderer.notifyContentMutated(['r1']);
      renderer.render(camera, 3, [], []);
      expect(draw.mock.calls.map(([item]) => item.objectId)).toEqual([
        'overlap',
      ]);
      expect(renderer.committedStats().fullCacheRebuilds).toBe(rebuilds);
      // Reordering intact entries must repaint their changed overlaps.
      model.order.reverse();
      renderer.render(camera, 4, [], []);
      expect(renderer.committedStats().fullCacheRebuilds).toBe(rebuilds + 1);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('syncs viewport/DPR and lifecycles backing stores', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      expect(renderer.syncSize()).toBe(true);
      const vp = renderer.viewport();
      expect(vp.width).toBe(800);
      expect(vp.height).toBe(600);
      expect(vp.dpr).toBeGreaterThanOrEqual(1);
      // Second sync without DOM change reports no resize.
      expect(renderer.syncSize()).toBe(false);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('rebuilds cache only when scene/camera/size change', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    let requests = 0;
    const { ports, cleanup } = makePorts(model, {
      imageCache: {
        requestSurface: () => {
          requests += 1;
        },
      },
    });
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      expect(requests).toBe(1);
      // Same key: no rebuild.
      renderer.render(camera, 1, [], []);
      expect(requests).toBe(1);
      // Scene bump: rebuild.
      renderer.render(camera, 2, [], []);
      expect(requests).toBe(2);
      // Camera move: rebuild.
      renderer.render({ x: 5, y: 0, zoom: 1 }, 2, [], []);
      expect(requests).toBe(3);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('recompiles committed items only when the scene version changes', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    let backgrounds = 0;
    const { ports, cleanup } = makePorts(model, {
      backgroundItems: () => {
        backgrounds += 1;
        return [];
      },
    });
    const renderer = createCommittedSceneRenderer(ports);
    try {
      renderer.render({ x: 0, y: 0, zoom: 1 }, 1, [], []);
      expect(backgrounds).toBe(1);
      // Camera move repaints the raster from cached items: no recompile,
      // no background re-read.
      renderer.render({ x: 40, y: 0, zoom: 1 }, 1, [], []);
      expect(backgrounds).toBe(1);
      // Scene bump recompiles.
      renderer.render({ x: 40, y: 0, zoom: 1 }, 2, [], []);
      expect(backgrounds).toBe(2);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('consumes image resolver cache and background items during rebuild', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    let requests = 0;
    let backgrounds = 0;
    const { ports, cleanup } = makePorts(model, {
      imageCache: {
        requestSurface: () => {
          requests += 1;
        },
      },
      backgroundItems: () => {
        backgrounds += 1;
        return [];
      },
    });
    const renderer = createCommittedSceneRenderer(ports);
    try {
      renderer.render({ x: 0, y: 0, zoom: 1 }, 1, [], []);
      expect(requests).toBe(1);
      expect(backgrounds).toBeGreaterThanOrEqual(1);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('composites cached scene and renders overlays without mutating canonical state', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    const before = JSON.stringify(model);
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      // Background + selection + frame overlays: must not throw.
      renderer.render(camera, 1, [], ['r1']);
      renderer.render(camera, 1, [], ['r1']);
      expect(JSON.stringify(model)).toBe(before);
      // Compositing happened (clear + drawImage recorded).
      expect(stubs!.calls).toContain('clearRect');
      expect(stubs!.calls).toContain('drawImage');
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('renders preview items and does not mutate on overlay-only changes', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    const before = JSON.stringify(model);
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      // Overlay-only change (selection) reuses the committed cache for the
      // scene but still composites overlays; canonical stays untouched.
      renderer.render(camera, 1, [], ['r1']);
      expect(JSON.stringify(model)).toBe(before);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('hands off a deferred long stroke preview in paint order and drops it on mutation', () => {
    stubs = installCanvasStubs();
    const model = emptySurface(boundedFrame(800, 600));
    const beforePoints = [
      { x: 10, y: 10, pressure: 0.5 },
      { x: 30, y: 10, pressure: 0.5 },
      { x: 50, y: 10, pressure: 0.5 },
    ];
    model.objects.before = inkStrokeObject('before', {
      points: beforePoints,
      width: 3,
    });
    model.order.push('before');
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    const camera = { x: 0, y: 0, zoom: 1 };
    try {
      renderer.render(camera, 1, [], []);
      const points = Array.from({ length: 4000 }, (_, i) => ({
        x: 100 + i * 0.1,
        y: 100 + Math.sin(i / 10),
        pressure: 0.5,
      }));
      const compiler = new LiveInkStrokeCompiler();
      compiler.begin(points[0]!, BALL_PEN_BRUSH);
      const update = compiler.append(points.slice(1));
      if (update.mesh === null) throw new Error('expected live preview mesh');
      const live: DrawItem = {
        kind: 'stroke',
        objectId: 'deferred',
        bounds: { x: 96, y: 96, width: 410, height: 10 },
        rotation: 0,
        points,
        width: 3,
        outline: [],
        liveMesh: update.mesh,
      };
      const headOnly: DrawItem = { ...live, liveHeadUpTo: 12 };
      const predicted: DrawItem = {
        ...live,
        objectId: 'deferred#predicted',
      };
      model.objects.deferred = inkStrokeObject('deferred', {
        points,
        width: 3,
      });
      model.order.push('deferred');
      renderer.notifyContentMutated(['deferred']);
      // The preview is captured after canonical creation, immediately
      // before the cold scene compile has completed.
      renderer.retainStrokePreviews([live, headOnly, predicted]);
      renderer.render(camera, 2, [], []);
      expect(
        stubs!
          .drawsFor(ports.canvas)
          .map((stamp) => stamp.objectId)
          .filter((id) => id === 'before' || id === 'deferred'),
      ).toEqual(['before', 'deferred']);
      expect(
        stubs!
          .drawsFor(ports.canvas)
          .some((stamp) => stamp.objectId === 'deferred#predicted'),
      ).toBe(false);

      // A pure translation mutates canonical samples in place and shifts
      // the retained live preview's derived transform until cold prepare.
      const canonical = model.objects.deferred!;
      for (const point of canonical.points as {
        x: number;
        y: number;
      }[]) {
        point.x += 20;
        point.y += 12;
      }
      renderer.notifyTranslated(['deferred'], 20, 12);
      renderer.render(camera, 3, [], []);
      expect(
        stubs!
          .drawsFor(ports.canvas)
          .filter((stamp) => stamp.objectId === 'deferred')
          .map(({ tx, ty }) => ({ tx, ty })),
      ).toEqual([{ tx: 20, ty: 12 }]);

      // A replacement under the same id supersedes the captured geometry;
      // the old preview must not cover or outlive that mutation.
      model.objects.deferred = inkStrokeObject('deferred', {
        points: points.map((point) => ({ ...point, y: point.y + 20 })),
        width: 3,
      });
      renderer.notifyContentMutated(['deferred']);
      renderer.render(camera, 4, [], []);
      expect(
        stubs!
          .drawsFor(ports.canvas)
          .some((stamp) => stamp.objectId === 'deferred'),
      ).toBe(false);

      delete model.objects.deferred;
      model.order.pop();
      renderer.notifyContentMutated(['deferred']);
      renderer.render(camera, 5, [], []);
      expect(
        stubs!
          .drawsFor(ports.canvas)
          .some((stamp) => stamp.objectId === 'deferred'),
      ).toBe(false);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('prepares visible remainder ahead of offscreen canonical heads', () => {
    stubs = installCanvasStubs();
    // 500 cheap offscreen strokes precede one huge visible stroke in
    // canonical order. The huge stroke exceeds the first-paint budget, so
    // it must head the progressive queue (visible band) instead of
    // waiting behind 500 irrelevant offscreen objects.
    const model = emptySurface(boundedFrame(20000, 2000));
    const boxes = new Map<string, Bounds>();
    for (let i = 0; i < 500; i++) {
      const id = `off${i}`;
      const points: { x: number; y: number }[] = [];
      for (let k = 0; k < 20; k++) {
        points.push({ x: 5000 + i * 10 + k, y: 100 });
      }
      model.objects[id] = inkStrokeObject(id, { points, width: 3 });
      model.order.push(id);
      boxes.set(id, { x: 5000 + i * 10 - 4, y: 96, width: 28, height: 8 });
    }
    const bigPoints: { x: number; y: number; pressure: number }[] = [];
    for (let k = 0; k < 5000; k++) {
      bigPoints.push({
        x: 10 + k * 0.05,
        y: 100 + Math.sin(k / 9) * 6,
        pressure: 0.5,
      });
    }
    model.objects['big-visible'] = inkStrokeObject('big-visible', {
      points: bigPoints,
      width: 3,
    });
    model.order.push('big-visible');
    boxes.set('big-visible', { x: 6, y: 90, width: 260, height: 20 });
    const queryVisible = (query: Bounds): readonly string[] => {
      const out: string[] = [];
      for (const [id, box] of boxes) {
        if (
          box.x < query.x + query.width &&
          box.x + box.width > query.x &&
          box.y < query.y + query.height &&
          box.y + box.height > query.y
        ) {
          out.push(id);
        }
      }
      return out;
    };
    const { ports, cleanup } = makePorts(model, {
      queryVisible,
      scheduleRender: () => undefined,
    });
    const renderer = createCommittedSceneRenderer(ports);
    try {
      renderer.render({ x: 0, y: 0, zoom: 1 }, 1, [], []);
      const stats = renderer.committedStats();
      // The huge visible stroke exceeds the first-paint budget (nothing
      // visible prepared synchronously) but heads the queue anyway.
      expect(stats.firstPaintVisible).toBe(0);
      expect(stats.progressPending).toBe(501);
      expect(stats.progressPendingHead[0]).toBe('big-visible');
      expect(stats.priorityReorders).toBe(0);
      // Canonical paint order is untouched by prioritization.
      expect(model.order[model.order.length - 1]).toBe('big-visible');

      // Pan to the offscreen region: an affordable slice of the newly
      // visible content prepares synchronously, the remainder heads the
      // bounded progressive queue (visible band first).
      renderer.render({ x: 5000, y: 0, zoom: 1 }, 1, [], []);
      const panned = renderer.committedStats();
      expect(panned.progressPendingHead[0]).toBe('off150');
      expect(panned.progressPendingHead).not.toContain('big-visible');
      // Viewport + bounded offscreen lookahead, never the whole document.
      expect(panned.progressPending).toBeLessThanOrEqual(513);
      // A second frame with the same camera queues nothing new.
      const pendingAfterPan = renderer.committedStats().progressPending;
      renderer.render({ x: 5000, y: 0, zoom: 1 }, 1, [], []);
      expect(renderer.committedStats().progressPending).toBe(pendingAfterPan);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('bounds the progressive queue for very dense offscreen documents', () => {
    stubs = installCanvasStubs();
    // 2000 offscreen strokes precede one visible stroke. The visible
    // stroke heads the queue; only a bounded lookahead of offscreen work
    // is queued (never all 2000), so opening cannot prepare/repaint the
    // whole document in the background.
    const model = emptySurface(boundedFrame(20000, 2000));
    const boxes = new Map<string, Bounds>();
    for (let i = 0; i < 2000; i++) {
      const id = `off${i}`;
      const points: { x: number; y: number }[] = [];
      for (let k = 0; k < 20; k++) {
        points.push({ x: 5000 + i * 10 + k, y: 100 });
      }
      model.objects[id] = inkStrokeObject(id, { points, width: 3 });
      model.order.push(id);
      boxes.set(id, { x: 5000 + i * 10 - 4, y: 96, width: 28, height: 8 });
    }
    const bigPoints: { x: number; y: number; pressure: number }[] = [];
    for (let k = 0; k < 5000; k++) {
      bigPoints.push({
        x: 10 + k * 0.05,
        y: 100 + Math.sin(k / 9) * 6,
        pressure: 0.5,
      });
    }
    model.objects['big-visible'] = inkStrokeObject('big-visible', {
      points: bigPoints,
      width: 3,
    });
    model.order.push('big-visible');
    boxes.set('big-visible', { x: 6, y: 90, width: 260, height: 20 });
    const queryVisible = (query: Bounds): readonly string[] => {
      const out: string[] = [];
      for (const [id, box] of boxes) {
        if (
          box.x < query.x + query.width &&
          box.x + box.width > query.x &&
          box.y < query.y + query.height &&
          box.y + box.height > query.y
        ) {
          out.push(id);
        }
      }
      return out;
    };
    const { ports, cleanup } = makePorts(model, {
      queryVisible,
      scheduleRender: () => undefined,
    });
    const renderer = createCommittedSceneRenderer(ports);
    try {
      renderer.render({ x: 0, y: 0, zoom: 1 }, 1, [], []);
      const stats = renderer.committedStats();
      expect(stats.progressPendingHead[0]).toBe('big-visible');
      // Visible + bounded lookahead only: far below the 2001 objects.
      expect(stats.progressPending).toBeLessThanOrEqual(513);
      expect(stats.progressPendingHead).not.toContain('off1999');
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('replaces canvas text with an inline editor without stale pixels or selection chrome', () => {
    stubs = installCanvasStubs();
    const model = emptySurface(boundedFrame(800, 600));
    model.objects['text'] = textObject('text', {
      x: 50,
      y: 60,
      text: 'Edit me',
    });
    model.order.push('text');
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], ['text']);
      expect(
        stubs.drawsFor(ports.canvas).some((draw) => draw.objectId === 'text'),
      ).toBe(true);
      renderer.render(camera, 1, [], [], {
        ids: ['text'],
        dx: 0,
        dy: 0,
        hidden: true,
      });
      expect(
        stubs.drawsFor(ports.canvas).some((draw) => draw.objectId === 'text'),
      ).toBe(false);
      const rebuilds = renderer.committedStats().dragBaseRebuilds;
      renderer.render(camera, 1, [], [], {
        ids: ['text'],
        dx: 0,
        dy: 0,
        hidden: true,
      });
      expect(renderer.committedStats().dragBaseRebuilds).toBe(rebuilds);
      renderer.render(camera, 1, [], ['text']);
      expect(
        stubs.drawsFor(ports.canvas).some((draw) => draw.objectId === 'text'),
      ).toBe(true);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('keeps the card background while its text is edited', () => {
    stubs = installCanvasStubs();
    const model = emptySurface(boundedFrame(800, 600));
    model.objects.card = cardObject('card', {
      x: 50,
      y: 60,
      width: 200,
      height: 100,
      text: 'Card title',
      fill: '#ffeebb',
    });
    model.order.push('card');
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const draw = vi.spyOn(CanvasSurfaceRendererBackend.prototype, 'draw');
      renderer.render({ x: 0, y: 0, zoom: 1 }, 1, [], [], {
        ids: ['card'],
        dx: 0,
        dy: 0,
        hidden: true,
      });
      expect(
        draw.mock.calls.some(
          ([item]) =>
            item.kind === 'card' && item.text === '' && item.fill === '#ffeebb',
        ),
      ).toBe(true);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('promotes the finished drag frame on pure-translation release', () => {
    stubs = installCanvasStubs();
    // Dense document: one moved stroke among thousands of unrelated rects.
    const model = emptySurface(boundedFrame(20000, 20000));
    for (let i = 0; i < 5000; i++) {
      const id = `bg${i}`;
      model.objects[id] = rectangleObject(id, {
        x: (i % 100) * 120,
        y: Math.floor(i / 100) * 120,
        width: 60,
        height: 40,
      });
      model.order.push(id);
    }
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      // Committed paint (full rebuild once).
      renderer.render(camera, 1, [], []);
      const painted = renderer.committedStats();
      expect(painted.fullCacheRebuilds).toBe(1);
      // Active drag: builds the base (without selection) once.
      renderer.render(camera, 1, [], ['bg0'], {
        ids: ['bg0'],
        dx: 24,
        dy: 12,
      });
      expect(renderer.committedStats().dragBaseRebuilds).toBe(1);
      // Pointer-up commit: canonical rewrite is the caller's job; the
      // renderer only shifts derived state, then promotes the finished
      // drag frame on the next render.
      renderer.notifyTranslated(['bg0'], 24, 12);
      renderer.render(camera, 2, [], ['bg0']);
      const released = renderer.committedStats();
      // The completed drag presentation is promoted: no full repaint,
      // and only the moved item repaints — never the 5000 unrelated ones.
      expect(released.dragPromotions).toBe(1);
      expect(released.translationFullRepaints).toBe(0);
      expect(released.committedItemsRepainted).toBe(1);
      expect(released.fullCacheRebuilds).toBe(1);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('does not leave ghost pixels when promoting the finished drag frame', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      // Committed paint includes r1 at its original position.
      renderer.render(camera, 1, [], []);
      // Active drag: the base deliberately excludes the moving selection.
      renderer.render(camera, 1, [], ['r1'], {
        ids: ['r1'],
        dx: 24,
        dy: 12,
      });
      renderer.notifyTranslated(['r1'], 24, 12);
      // Pointer-up: the finished drag frame is promoted into the
      // committed cache (blit of the base + moved selection).
      renderer.render(camera, 2, [], ['r1']);
      expect(renderer.committedStats().dragPromotions).toBe(1);
      // The base is transparent where the selection sat, so the promoted
      // cache must not retain the pre-drag r1 pixels as an unselectable
      // ghost: exactly one moved copy, at the committed translation.
      const drawn = stubs!
        .drawsFor(ports.canvas)
        .filter((stamp) => stamp.objectId === 'r1');
      expect(drawn).toHaveLength(1);
      expect(drawn[0]!.tx).toBe(24);
      expect(drawn[0]!.ty).toBe(12);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('promotes the first drag of a selection that was not yet prepared', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    // The viewport query sees nothing (cost-deferred dense viewport): the
    // selected object is absent from the prepared scene when the drag
    // starts. The drag-base build must prepare exactly the selection so
    // pointer-up promotion stays safe instead of falling back to a
    // whole-document repaint.
    const { ports, cleanup } = makePorts(model, {
      queryVisible: () => [],
      scheduleRender: () => undefined,
    });
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      renderer.render(camera, 1, [], ['r1'], {
        ids: ['r1'],
        dx: 24,
        dy: 12,
      });
      renderer.notifyTranslated(['r1'], 24, 12);
      renderer.render(camera, 2, [], ['r1']);
      const stats = renderer.committedStats();
      expect(stats.dragPromotions).toBe(1);
      expect(stats.translationFullRepaints).toBe(0);
      expect(stats.committedItemsRepainted).toBe(1);
      const moved = stubs!
        .drawsFor(ports.canvas)
        .filter((stamp) => stamp.objectId === 'r1');
      expect(moved).toHaveLength(1);
      expect(moved[0]!.tx).toBe(24);
      expect(moved[0]!.ty).toBe(12);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('keeps the page outline above the moved selection and paints it once', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    const outlineStyle = 'rgba(55, 53, 47, 0.16)';
    // The page outline is a full-frame stroke (800×600 at zoom 1); resize
    // handles share the token fallback color but are 10px squares.
    const isPageOutline = (stamp: { args: readonly unknown[] }) =>
      stamp.args[2] === 800 && stamp.args[3] === 600;
    const outlineStamps = (canvas: HTMLCanvasElement) =>
      stubs!
        .drawsFor(canvas)
        .map((stamp, index) => ({ stamp, index }))
        .filter(
          ({ stamp }) =>
            stamp.strokeStyle === outlineStyle && isPageOutline(stamp),
        );
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      // Active drag frame: the base excludes the moving selection and must
      // NOT carry the outline (it is painted on the active frame instead,
      // above the moved selection, exactly once).
      renderer.render(camera, 1, [], []);
      renderer.render(camera, 1, [], ['r1'], {
        ids: ['r1'],
        dx: 24,
        dy: 12,
      });
      const dragFrame = stubs!.drawsFor(ports.canvas);
      const movedInDrag = dragFrame.findIndex(
        (stamp) => stamp.objectId === 'r1',
      );
      const dragOutlines = outlineStamps(ports.canvas);
      expect(movedInDrag).toBeGreaterThanOrEqual(0);
      expect(dragOutlines).toHaveLength(1);
      expect(dragOutlines[0]!.index).toBeGreaterThan(movedInDrag);

      // Pointer-up promotion: base blit + final moved selection + outline
      // exactly once, last, so nothing can cover it.
      renderer.notifyTranslated(['r1'], 24, 12);
      renderer.render(camera, 2, [], ['r1']);
      expect(renderer.committedStats().dragPromotions).toBe(1);
      const committedFrame = stubs!.drawsFor(ports.canvas);
      const moved = committedFrame.filter((stamp) => stamp.objectId === 'r1');
      expect(moved).toHaveLength(1);
      expect(moved[0]!.tx).toBe(24);
      expect(moved[0]!.ty).toBe(12);
      const promotedOutlines = outlineStamps(ports.canvas);
      expect(promotedOutlines).toHaveLength(1);
      expect(promotedOutlines[0]!.index).toBeGreaterThan(
        committedFrame.lastIndexOf(moved[0]!),
      );
    } finally {
      renderer.dispose();
      cleanup();
    }
  });

  it('falls back to a full repaint when the camera moved during the drag', () => {
    stubs = installCanvasStubs();
    const model = makeModel();
    const { ports, cleanup } = makePorts(model);
    const renderer = createCommittedSceneRenderer(ports);
    try {
      const camera = { x: 0, y: 0, zoom: 1 };
      renderer.render(camera, 1, [], []);
      renderer.render(camera, 1, [], ['r1'], {
        ids: ['r1'],
        dx: 24,
        dy: 12,
      });
      renderer.notifyTranslated(['r1'], 24, 12);
      // Camera changed between drag frames and release: promotion unsafe.
      renderer.render({ x: 90, y: 0, zoom: 1 }, 2, [], ['r1']);
      const released = renderer.committedStats();
      expect(released.dragPromotions).toBe(0);
      expect(released.translationFullRepaints).toBe(1);
      expect(released.committedItemsRepainted).toBeGreaterThanOrEqual(1);
    } finally {
      renderer.dispose();
      cleanup();
    }
  });
});
