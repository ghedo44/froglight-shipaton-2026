// @vitest-environment jsdom
/**
 * Structural release benchmark — jsdom, Canvas and rAF STUBBED.
 *
 * This suite is NOT a rasterization or browser-frame benchmark. Canvas2D
 * calls are recorded no-ops and `requestAnimationFrame` is a manual queue:
 * its wall-clock numbers measure JS bookkeeping plus the jsdom stub, not
 * real painting. It exists to pin the structural release contract
 * end-to-end through the production mount/controller/renderer/committed
 * cache path:
 *
 * ```text
 * mountInkSurface → pointerdown → pointermove → pointerup
 * → canonical commit → committed cache update → next scheduled frame
 * ```
 *
 * Cases: 1k / 10k / 50k / 100k-sample single strokes, a dense document
 * (5000 unrelated objects + one long selected stroke), and a logical
 * stroke split across >10k-sample codec chunks.
 *
 * Timings are REPORTED for regression triage only — never asserted
 * (CI gates use structural counters: zero recompiles, zero derived
 * geometry copies, one drag promotion, exact repaint counts). Real
 * Canvas2D + `requestAnimationFrame` release timings come from the
 * Chromium Playwright benchmark
 * (`apps/web/tests/ink-release-bench.spec.ts`), which drives
 * `apps/web/bench/ink-release-bench.ts`; physical iPad/WKWebView numbers
 * require an actual device run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFrame,
  compiledStrokeComputeStats,
  decodeSurfacePayload,
  derivedTranslationStats,
  emptySurface,
  encodeSurfacePayload,
  inkStrokeObject,
  rectangleObject,
  SURFACE_TOOL_IDS,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  mountInkSurface,
  type InkSkeleton,
  type InkSurfaceHandle,
} from '../index.js';

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

const PAGE_W = 1600;
const PAGE_H = 1200;

/** Manual rAF queue: deterministic "next painted frame" without timers. */
function installRaf(): { flush: () => number; restore: () => void } {
  const queue: FrameRequestCallback[] = [];
  let nextId = 0;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let active = true;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    if (!active) return 0;
    queue.push(callback);
    nextId += 1;
    return nextId;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((_id: number) => {
    queue.length = 0;
  }) as typeof cancelAnimationFrame;
  return {
    flush: () => {
      let frames = 0;
      // Bound the drain: progressive fill reschedules itself per slice.
      for (let i = 0; i < 500 && queue.length > 0; i++) {
        const pending = queue.splice(0, queue.length);
        frames += pending.length;
        for (const callback of pending) {
          callback(now());
        }
      }
      return frames;
    },
    restore: () => {
      active = false;
      queue.length = 0;
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

function installCanvasStub(): { calls: string[]; restore: () => void } {
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

function makeHost(): { skeleton: InkSkeleton; cleanup: () => void } {
  const root = document.createElement('div');
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  const pointerIndicator = document.createElement('div');
  const overlayRoot = document.createElement('div');
  page.appendChild(canvas);
  page.appendChild(badge);
  page.appendChild(overlayRoot);
  root.appendChild(page);
  document.body.appendChild(root);
  const rect = {
    left: 0,
    top: 0,
    width: PAGE_W,
    height: PAGE_H,
    right: PAGE_W,
    bottom: PAGE_H,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect);
  return {
    skeleton: { root, page, canvas, badge, pointerIndicator, overlayRoot },
    cleanup: () => {
      root.remove();
    },
  };
}

function strokePoints(
  count: number,
  baseX = 0,
  baseY = 0,
): { x: number; y: number; pressure: number; dt: number }[] {
  const points: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      x: baseX + (i % 2000) * 2,
      y: baseY + Math.floor(i / 2000) * 40 + Math.sin(i / 7) * 5,
      pressure: 0.5,
      dt: i * 8,
    });
  }
  return points;
}

function singleStrokeModel(samples: number): SurfaceModel {
  // Content sits at frame center: fitToView centers the frame (subject
  // to MIN_ZOOM), so the grab point lands mid-viewport at any zoom.
  const model = emptySurface(boundedFrame(20000, 4000));
  model.objects['long-1'] = inkStrokeObject('long-1', {
    points: strokePoints(samples, 9000, 2000),
    width: 3.5,
  });
  model.order.push('long-1');
  return model;
}

function denseModel(unrelated: number, strokeSamples: number): SurfaceModel {
  const model = emptySurface(boundedFrame(30000, 30000));
  // The moved stroke leads paint order so first paint prepares it.
  model.objects['target'] = inkStrokeObject('target', {
    points: strokePoints(strokeSamples, 14000, 15000),
    width: 3.5,
  });
  model.order.push('target');
  for (let i = 0; i < unrelated; i++) {
    const id = `bg${i}`;
    model.objects[id] = rectangleObject(id, {
      x: (i % 100) * 260,
      y: 4000 + Math.floor(i / 100) * 260,
      width: 120,
      height: 80,
    });
    model.order.push(id);
  }
  return model;
}

/** Logical stroke split across >10k-sample codec chunks (real decode shape). */
function chunkedModel(total: number): { model: SurfaceModel; ids: string[] } {
  const oversized = emptySurface(boundedFrame(30000, 4000));
  oversized.objects['long-1'] = inkStrokeObject('long-1', {
    points: strokePoints(total, 13000, 2000),
    width: 3.5,
  });
  oversized.order.push('long-1');
  const decoded = decodeSurfacePayload(encodeSurfacePayload(oversized));
  return { model: decoded.model, ids: [...decoded.model.order] };
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

function pointerEvent(
  type: string,
  clientX: number,
  clientY: number,
  timeStamp: number,
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  Object.defineProperty(event, 'getCoalescedEvents', { value: () => [] });
  Object.defineProperty(event, 'getPredictedEvents', { value: () => [] });
  return event;
}

interface ReleaseReport {
  readonly label: string;
  readonly samples: number;
  readonly pointerUpMs: number;
  readonly commitRenderMs: number;
  readonly frames: number;
  readonly computes: number;
  readonly geometryCopies: number;
  readonly transformUpdates: number;
  readonly canonicalMs: number;
  readonly derivedMs: number;
  readonly dragPromotions: number;
  readonly translationFullRepaints: number;
  readonly committedItemsRepainted: number;
}

const reports: ReleaseReport[] = [];

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/**
 * Mount → select → drag → release → next painted frame through the real
 * production stack (engine + committed renderer + canvas stubs + manual
 * rAF). Returns the measured and asserts the structural
 * release invariants.
 */
async function releaseCase(
  label: string,
  model: SurfaceModel,
  grabId: string,
  expectedSamples: number,
  expectedMovedItems: number,
  dxView: number,
  dyView: number,
): Promise<void> {
  const raf = installRaf();
  const canvasStub = installCanvasStub();
  const { skeleton, cleanup } = makeHost();
  let handle: InkSurfaceHandle | null = null;
  try {
    handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    handle.setTool(SURFACE_TOOL_IDS.select);
    // Settle the mount: first paint + progressive fill drain.
    raf.flush();
    raf.flush();
    // Steady state before the gesture: the grabbed stroke is prepared
    // AND folded into the committed scene (over-budget strokes hydrate
    // asynchronously through the cold lane, then fold on the next frame;
    // drain real timers until the queue is empty — exactly what "the user
    // sees the stroke, then grabs it" means).
    for (
      let i = 0;
      i < 1000 &&
      (handle.diagnostics().scene.cachedObjects < 1 ||
        handle.diagnostics().committed.progressPending > 0);
      i++
    ) {
      raf.flush();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // One more frame to fold freshly hydrated geometry into the prepared
    // scene (the fold runs on non-drag renders only).
    raf.flush();
    await Promise.resolve();
    expect(handle.diagnostics().scene.cachedObjects).toBeGreaterThan(0);
    expect(handle.diagnostics().committed.progressPending).toBe(0);

    const statsBefore = handle.diagnostics();
    const grab = firstPointOf(model, grabId);

    // View-space grab point for the stroke start under the fitted camera.
    const camera = handle.camera();
    const clientX = (grab.x - camera.x) * camera.zoom;
    const clientY = (grab.y - camera.y) * camera.zoom;
    const canvas = skeleton.canvas;
    let clock = 1000;

    canvas.dispatchEvent(pointerEvent('pointerdown', clientX, clientY, clock));
    raf.flush();
    expect(handle.selectionIds().length).toBeGreaterThan(0);

    const moves = 5;
    for (let m = 1; m <= moves; m++) {
      clock += 8;
      canvas.dispatchEvent(
        pointerEvent(
          'pointermove',
          clientX + (dxView * m) / moves,
          clientY + (dyView * m) / moves,
          clock,
        ),
      );
    }
    raf.flush();

    // Release window starts at pointer-up: grab-time cold compiles (first
    // pointerdown on a not-yet-prepared stroke) belong to the cold-open
    // story, not the release path — baseline them away here.
    const baselineComputes = compiledStrokeComputeStats.computes;
    const baselineCopies = derivedTranslationStats.geometryCopies;
    const baselineTransforms = derivedTranslationStats.transformUpdates;

    const pointerUpStart = now();
    clock += 8;
    canvas.dispatchEvent(
      pointerEvent('pointerup', clientX + dxView, clientY + dyView, clock),
    );
    const pointerUpMs = now() - pointerUpStart;

    const commitStart = now();
    const frames = raf.flush();
    const commitRenderMs = now() - commitStart;
    raf.flush();

    const diagnostics = handle.diagnostics();
    const controller = diagnostics.controller;
    const committed = diagnostics.committed;
    const statsBase = statsBefore.controller;

    // Structural release invariants (machine-independent CI gates).
    expect(compiledStrokeComputeStats.computes - baselineComputes).toBe(0);
    expect(derivedTranslationStats.geometryCopies - baselineCopies).toBe(0);
    expect(
      derivedTranslationStats.transformUpdates - baselineTransforms,
    ).toBeLessThanOrEqual(Math.max(1, expectedMovedItems));
    expect(
      controller.canonicalSamplesTranslated -
        statsBase.canonicalSamplesTranslated,
    ).toBe(expectedSamples);
    expect(controller.dragCommits - statsBase.dragCommits).toBe(1);
    expect(controller.translationCommits - statsBase.translationCommits).toBe(
      1,
    );
    // Safe pure translation promotes the finished drag frame: no full
    // committed repaint, unrelated items untouched.
    expect(
      committed.dragPromotions - statsBefore.committed.dragPromotions,
    ).toBe(1);
    expect(
      committed.translationFullRepaints -
        statsBefore.committed.translationFullRepaints,
    ).toBe(0);
    expect(
      committed.committedItemsRepainted -
        statsBefore.committed.committedItemsRepainted,
    ).toBe(expectedMovedItems);
    // The stroke visibly moved: post-release hit lands on the selection.
    const moved = firstPointOf(model, grabId);
    expect(moved.x).not.toBeCloseTo(grab.x, 6);
    expect(handle.selectionIds().length).toBeGreaterThan(0);

    reports.push({
      label,
      samples: expectedSamples,
      pointerUpMs,
      commitRenderMs,
      frames,
      computes: compiledStrokeComputeStats.computes - baselineComputes,
      geometryCopies: derivedTranslationStats.geometryCopies - baselineCopies,
      transformUpdates:
        derivedTranslationStats.transformUpdates - baselineTransforms,
      canonicalMs:
        controller.canonicalTranslateMs - statsBase.canonicalTranslateMs,
      derivedMs: controller.derivedTranslateMs - statsBase.derivedTranslateMs,
      dragPromotions:
        committed.dragPromotions - statsBefore.committed.dragPromotions,
      translationFullRepaints:
        committed.translationFullRepaints -
        statsBefore.committed.translationFullRepaints,
      committedItemsRepainted:
        committed.committedItemsRepainted -
        statsBefore.committed.committedItemsRepainted,
    });
    void canvasStub;
  } finally {
    handle?.destroy();
    cleanup();
    canvasStub.restore();
    raf.restore();
  }
}

describe.each([
  { samples: 1_000, timeout: 60_000 },
  { samples: 10_000, timeout: 90_000 },
  { samples: 50_000, timeout: 150_000 },
  { samples: 100_000, timeout: 240_000 },
])(
  'release at $samples samples (full production path)',
  ({ samples, timeout }) => {
    it(
      'mounts, drags, commits, and paints the next frame with zero recompiles',
      async () => {
        await releaseCase(
          `${samples}-samples`,
          singleStrokeModel(samples),
          'long-1',
          samples,
          1,
          40,
          24,
        );
      },
      timeout,
    );
  },
);

describe('release in dense and chunked documents', () => {
  it('moves one stroke among 5000 unrelated objects without repainting them', async () => {
    await releaseCase(
      'dense-5000+1k',
      denseModel(5000, 1000),
      'target',
      1000,
      1,
      40,
      24,
    );
  }, 180_000);

  it('commits a logical stroke split across codec chunks as one stroke', async () => {
    const { model, ids } = chunkedModel(25_000);
    expect(ids.length).toBeGreaterThan(1);
    await releaseCase('chunked-25k', model, ids[0]!, 25_000, 1, 40, 24);
  }, 180_000);
});

describe('release report', () => {
  it('logs jsdom structural counters (not rasterization timings)', () => {
    expect(reports.length).toBe(6);
    for (const report of reports) {
      expect(report.computes).toBe(0);
      expect(report.geometryCopies).toBe(0);
      expect(report.dragPromotions).toBe(1);
      expect(report.translationFullRepaints).toBe(0);
    }
    // Visible in CI logs: jsdom-side per case. Canvas and
    // rAF are stubbed here, so these are JS bookkeeping numbers — real
    // Canvas2D/browser-frame numbers come from the Chromium Playwright
    // benchmark, and physical iPad/WKWebView numbers require a device run.
    // eslint-disable-next-line no-console
    console.log(
      `release-structural-jsdom (ms, Canvas/rAF stubbed): ${reports
        .map(
          (r) =>
            `${r.label}: pointerUp=${r.pointerUpMs.toFixed(1)} ` +
            `commitRender=${r.commitRenderMs.toFixed(1)} ` +
            `frames=${r.frames} canonical=${r.canonicalMs.toFixed(2)} ` +
            `derived=${r.derivedMs.toFixed(2)} ` +
            `repainted=${r.committedItemsRepainted}`,
        )
        .join(' | ')}`,
    );
  });
});
