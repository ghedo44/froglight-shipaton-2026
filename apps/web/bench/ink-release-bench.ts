import { runErasurePersistence } from './erasure-persistence.js';
/**
 * Real-Canvas release benchmark harness (final scalability pass, item 7).
 *
 * Runs the REAL production stack in Chromium with actual Canvas2D and
 * browser `requestAnimationFrame`:
 *
 * ```text
 * mountInkSurface → select → drag → pointerup → committed repaint
 * → next visible browser frame
 * ```
 *
 * The jsdom `release-benchmark.spec.ts` remains the structural release
 * gate, but its Canvas/rAF are stubbed: it cannot measure rasterization
 * or the browser frame pipeline. This page reports physical-machine
 * timings (pointer-up handler, canonical/derived translation, time to the
 * next painted frame) plus the structural counters CI asserts. Timings
 * are printed for physical-device comparison, never asserted absolutely.
 *
 * Page contract with `apps/web/tests/ink-release-bench.spec.ts`:
 * `window.__froglightInkBench = { done, results, errors }`.
 */

import {
  drainSurfaceDocumentWork,
  boundedFrame,
  compiledStrokeComputeStats,
  compiledStrokeForRecord,
  decodeSurfacePayload,
  derivedTranslationStats,
  DerivedReopenStore,
  emptySurface,
  encodeSurfacePayload,
  inkStrokeObject,
  isCompiledWarm,
  packCompiledInk,
  packedCompiledByteLength,
  packedCompiledForRecord,
  setCompiledForRecord,
  hasPersistablePacked,
  rectangleObject,
  timeBackgroundInputInit,
  SURFACE_TOOL_IDS,
  SURFACE_MAX_STROKE_POINTS,
  type Camera,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  createDerivedCachePackWorker,
  createErasurePreparation,
  mountInkSurface,
  type InkSkeleton,
  type InkSurfaceHandle,
} from '@froglight/editor-ink';
import { OpfsDerivedCacheStorage } from '@froglight/provider-opfs';

interface BenchCase {
  readonly label: string;
  readonly kind: 'single' | 'dense' | 'chunked';
  /** Canonical samples moved by the drag. */
  readonly expectedSamples: number;
  /** Committed prepared items repainted by promotion. */
  readonly expectedMovedItems: number;
  readonly zoom: number;
  readonly samples?: number;
  readonly unrelated?: number;
}

interface BenchResult {
  readonly label: string;
  readonly samples: number;
  readonly zoom: number;
  readonly pointerUpMs: number;
  readonly canonicalMs: number;
  readonly derivedMs: number;
  readonly paintedFrameMs: number;
  /** Mount → first painted frame (background work excluded). */
  readonly openToFirstPaintMs: number;
  /** Progressive queue immediately after first paint (bounded). */
  readonly firstProgressPending: number;
  readonly recompiles: number;
  readonly geometryCopies: number;
  readonly transformUpdates: number;
  readonly dragPromotions: number;
  readonly translationFullRepaints: number;
  readonly repaintedItems: number;
  readonly canonicalSamplesTranslated: number;
  readonly expectedSamples: number;
  readonly expectedMovedItems: number;
}

declare global {
  interface Window {
    __froglightInkBench?: {
      done: boolean;
      results: BenchResult[];
      errors: { label: string; message: string }[];
      precision?: Record<string, number>;
      /** Durable-reopen mode payload (item 4/6 reload proof). */
      reopen?: {
        mode: 'write' | 'read';
        hits: number;
        misses: number;
        computes: number;
        warmed: boolean;
      };
      /** Dense-Ink open/reopen suite payload (dense-document pass). */
      dense?: {
        mode: string;
        results: DenseBenchResult[];
      };
      /** Background-input initialization diagnostic. */
      backgroundInit?: {
        mode: string;
        results: BackgroundInitResult[];
      };
    };
  }
}

/**
 * One dense-Ink document measurement. Wall-clock fields are printed for
 * physical-device comparison; CI asserts structural invariants only.
 */
interface DenseBenchResult {
  readonly label: string;
  readonly strokes: number;
  readonly samplesPerStroke: number;
  /** Canonical encode/decode (session-open proxy) wall-clock ms. */
  readonly canonicalDecodeMs: number;
  readonly openToFirstPaintMs: number;
  /** Renderer-created → first useful paint (ms). */
  readonly rendererFirstPaintMs: number;
  /** Items prepared by the bounded first paint (null pre-paint). */
  readonly firstPaintVisible: number;
  /** Sample cost spent by the bounded first paint. */
  readonly firstPaintCost: number;
  /** Prepared items at first paint (bounded viewport work). */
  readonly firstPaintPrepared: number;
  /** Progressive queue immediately after first paint. */
  readonly firstPaintPending: number;
  /** Lazy cached vectors unpacked by first paint. */
  readonly firstPaintRestored: number;
  readonly firstPaintRestoreMisses: number;
  /** B-spline compiles performed by first paint. */
  readonly firstPaintComputes: number;
  readonly firstPaintFullRebuilds: number;
  /** Restored after the OPFS hydration continuation resolved. */
  readonly restoredAfterHydration: number;
  readonly totalRestored: number;
  readonly totalComputes: number;
  readonly workerCompiles: number;
  readonly workerIntegrationMs: number;
  readonly workerOutputBytes: number;
  /** Spine nodes unpacked on the main thread from Worker results. */
  readonly workerIntegrationNodes: number;
  /** Polygon/outline vertices unpacked from Worker results. */
  readonly workerIntegrationVertices: number;
  readonly cachedPackedRestoreMs: number;
  /** Packed bytes unpacked from the lazy cache restore. */
  readonly cachedPackedRestoredBytes: number;
  readonly progressiveMs: number;
  readonly totalPrepared: number;
  /** Packed bytes retained for warm records at teardown (write mode). */
  readonly packedBytesWarm: number;
  /** Records with installed compiled geometry (write mode). */
  readonly warmRecords: number;
  /** destroy() → persistence flush wall-clock ms (off-thread pack + write). */
  readonly persistMs: number;
}

const PAGE_W = 1280;
const PAGE_H = 800;

const CASES: readonly BenchCase[] = [
  {
    label: '1k-samples',
    kind: 'single',
    samples: 1_000,
    expectedSamples: 1_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
  {
    label: '10k-samples',
    kind: 'single',
    samples: 10_000,
    expectedSamples: 10_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
  {
    label: '50k-samples',
    kind: 'single',
    samples: 50_000,
    expectedSamples: 50_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
  {
    label: '100k-samples',
    kind: 'single',
    samples: 100_000,
    expectedSamples: 100_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
  {
    label: '10k-samples@0.5x',
    kind: 'single',
    samples: 10_000,
    expectedSamples: 10_000,
    expectedMovedItems: 1,
    zoom: 0.5,
  },
  {
    label: 'dense-5000+1k',
    kind: 'dense',
    samples: 1_000,
    unrelated: 5_000,
    expectedSamples: 1_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
  {
    label: 'chunked-25k',
    kind: 'chunked',
    samples: 25_000,
    expectedSamples: 25_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
  {
    label: 'logical-50k',
    kind: 'chunked',
    samples: 50_000,
    expectedSamples: 50_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
  {
    label: 'logical-100k',
    kind: 'chunked',
    samples: 100_000,
    expectedSamples: 100_000,
    expectedMovedItems: 1,
    zoom: 1,
  },
];

function strokePoints(
  count: number,
  baseX: number,
  baseY: number,
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

function singleModel(samples: number): SurfaceModel {
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
  model.objects['target'] = inkStrokeObject('target', {
    points: strokePoints(strokeSamples, 14000, 15000),
    width: 3.5,
  });
  model.order.push('target');
  for (let i = 0; i < unrelated; i++) {
    const id = `bg${i}`;
    model.objects[id] = rectangleObject(id, {
      x: (i % 100) * 260,
      y: 14000 + Math.floor(i / 100) * 260,
      width: 120,
      height: 80,
    });
    model.order.push(id);
  }
  return model;
}

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

function createHost(): { skeleton: InkSkeleton; remove: () => void } {
  const root = document.createElement('div');
  root.className = 'fl-ink-root';
  const page = document.createElement('div');
  page.className = 'fl-ink-page';
  const canvas = document.createElement('canvas');
  canvas.className = 'fl-ink-canvas';
  // Synthetic pointer events have no active pointer id; capture calls
  // must no-op or the production handler aborts before the drag starts.
  canvas.setPointerCapture = () => undefined;
  canvas.releasePointerCapture = () => undefined;
  const badge = document.createElement('div');
  const pointerIndicator = document.createElement('div');
  page.appendChild(canvas);
  page.appendChild(badge);
  page.appendChild(pointerIndicator);
  root.appendChild(page);
  const mount = document.getElementById('bench-root');
  if (mount === null) throw new Error('missing #bench-root');
  mount.appendChild(root);
  return {
    skeleton: { root, page, canvas, badge, pointerIndicator },
    remove: () => root.remove(),
  };
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame((time) => resolve(time));
  });
}

async function waitForPaint(): Promise<void> {
  // First rAF runs the render callback registered by the release; the
  // second fires after that frame was composited.
  await nextFrame();
  await nextFrame();
}

function dispatchPointer(
  canvas: HTMLCanvasElement,
  type: string,
  clientX: number,
  clientY: number,
  buttons: number,
): void {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons,
      clientX,
      clientY,
    }),
  );
}

function cameraFor(model: SurfaceModel, grabId: string, zoom: number): Camera {
  const grab = firstPointOf(model, grabId);
  return {
    x: grab.x - PAGE_W / (2 * zoom),
    y: grab.y - PAGE_H / (2 * zoom),
    zoom,
  };
}

async function waitForPrepared(
  handle: InkSurfaceHandle,
  timeoutMs: number,
): Promise<void> {
  const start = performance.now();
  for (;;) {
    const diagnostics = handle.diagnostics();
    if (
      diagnostics.scene.cachedObjects > 0 &&
      diagnostics.committed.progressPending === 0
    ) {
      return;
    }
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `prepare timeout (cached=${diagnostics.scene.cachedObjects} pending=${diagnostics.committed.progressPending})`,
      );
    }
    await nextFrame();
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

async function runCase(spec: BenchCase): Promise<BenchResult> {
  const built =
    spec.kind === 'single'
      ? { model: singleModel(spec.samples!), ids: ['long-1'] }
      : spec.kind === 'dense'
        ? { model: denseModel(spec.unrelated!, spec.samples!), ids: ['target'] }
        : chunkedModel(spec.samples!);
  const model = built.model;
  const grabId = built.ids[0]!;
  const host = createHost();
  let handle: InkSurfaceHandle | null = null;
  try {
    const mountStart = performance.now();
    handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: host.skeleton,
      initialCamera: cameraFor(model, grabId, spec.zoom),
      presentation: 'paint-stage',
      navigationMode: 'standalone',
    });
    handle.setTool(SURFACE_TOOL_IDS.select);
    await waitForPaint();
    const openToFirstPaintMs = performance.now() - mountStart;
    const firstProgressPending = handle.diagnostics().committed.progressPending;
    await waitForPrepared(handle, 180_000);
    // Let the prepared geometry fold into the committed scene and settle.
    await waitForPaint();

    // Production-shape logical first interaction (FINAL §11): for chunked
    // logical strokes, first touch a NON-HEAD chunk region and prove zero
    // B-spline recompiles (joint packed geometry, not per-chunk compile).
    // Structural gate (CI), wall-clock printed for device comparison only.
    if (spec.kind === 'chunked' && built.ids.length > 1) {
      const nonHeadId = built.ids[Math.floor(built.ids.length / 2)]!;
      const nonHeadPt = firstPointOf(model, nonHeadId);
      const cam0 = handle.camera();
      const rect0 = host.skeleton.canvas.getBoundingClientRect();
      const nx = rect0.left + (nonHeadPt.x - cam0.x) * cam0.zoom;
      const ny = rect0.top + (nonHeadPt.y - cam0.y) * cam0.zoom;
      const computesBeforeNonHead = compiledStrokeComputeStats.computes;
      const nonHeadStart = performance.now();
      dispatchPointer(host.skeleton.canvas, 'pointerdown', nx, ny, 1);
      await nextFrame();
      const nonHeadHitMs = performance.now() - nonHeadStart;
      const nonHeadSelected = handle.selectionIds().length > 0;
      const nonHeadRecompiles =
        compiledStrokeComputeStats.computes - computesBeforeNonHead;
      // eslint-disable-next-line no-console
      console.log(
        `browser-logical-first-interaction ${spec.label}: ` +
          `nonHead=${nonHeadId} hitMs=${nonHeadHitMs.toFixed(2)}ms ` +
          `selected=${nonHeadSelected} recompiles=${nonHeadRecompiles}`,
      );
      if (!nonHeadSelected) {
        throw new Error(`non-head pointerdown did not select ${nonHeadId}`);
      }
      if (nonHeadRecompiles !== 0) {
        throw new Error(
          `non-head first interaction recompiled (${nonHeadRecompiles}) for ${spec.label}`,
        );
      }
      // Release the non-head selection so the release benchmark below starts clean.
      dispatchPointer(host.skeleton.canvas, 'pointerup', nx, ny, 0);
      await nextFrame();
    }

    const camera = handle.camera();
    const grab = firstPointOf(model, grabId);
    const rect = host.skeleton.canvas.getBoundingClientRect();
    const clientX = rect.left + (grab.x - camera.x) * camera.zoom;
    const clientY = rect.top + (grab.y - camera.y) * camera.zoom;
    const dxView = 40;
    const dyView = 24;

    dispatchPointer(host.skeleton.canvas, 'pointerdown', clientX, clientY, 1);
    await nextFrame();
    if (handle.selectionIds().length === 0) {
      throw new Error('pointerdown did not select the target');
    }
    const moves = 5;
    for (let m = 1; m <= moves; m++) {
      dispatchPointer(
        host.skeleton.canvas,
        'pointermove',
        clientX + (dxView * m) / moves,
        clientY + (dyView * m) / moves,
        1,
      );
    }
    await nextFrame();

    // Release-window baselines: grab-time cold compiles belong to the
    // cold-open story, not the release path (same contract as the jsdom
    // structural benchmark).
    const before = handle.diagnostics();
    const computesBefore = compiledStrokeComputeStats.computes;
    const copiesBefore = derivedTranslationStats.geometryCopies;
    const transformsBefore = derivedTranslationStats.transformUpdates;

    const pointerUpStart = performance.now();
    dispatchPointer(
      host.skeleton.canvas,
      'pointerup',
      clientX + dxView,
      clientY + dyView,
      0,
    );
    const pointerUpMs = performance.now() - pointerUpStart;
    await waitForPaint();
    const paintedFrameMs = performance.now() - pointerUpStart;

    const after = handle.diagnostics();
    return {
      label: spec.label,
      samples: spec.expectedSamples,
      zoom: camera.zoom,
      pointerUpMs,
      canonicalMs:
        after.controller.canonicalTranslateMs -
        before.controller.canonicalTranslateMs,
      derivedMs:
        after.controller.derivedTranslateMs -
        before.controller.derivedTranslateMs,
      paintedFrameMs,
      openToFirstPaintMs,
      firstProgressPending,
      recompiles: compiledStrokeComputeStats.computes - computesBefore,
      geometryCopies: derivedTranslationStats.geometryCopies - copiesBefore,
      transformUpdates:
        derivedTranslationStats.transformUpdates - transformsBefore,
      dragPromotions:
        after.committed.dragPromotions - before.committed.dragPromotions,
      translationFullRepaints:
        after.committed.translationFullRepaints -
        before.committed.translationFullRepaints,
      repaintedItems:
        after.committed.committedItemsRepainted -
        before.committed.committedItemsRepainted,
      canonicalSamplesTranslated:
        after.controller.canonicalSamplesTranslated -
        before.controller.canonicalSamplesTranslated,
      expectedSamples: spec.expectedSamples,
      expectedMovedItems: spec.expectedMovedItems,
    };
  } finally {
    handle?.destroy();
    host.remove();
  }
}

async function main(): Promise<void> {
  const report: Window['__froglightInkBench'] = {
    done: false,
    results: [],
    errors: [],
  };
  window.__froglightInkBench = report;
  const status = document.getElementById('bench-status');
  for (const spec of CASES) {
    if (status !== null) status.textContent = `running ${spec.label}…`;
    try {
      const result = await runCase(spec);
      report.results.push(result);
      // eslint-disable-next-line no-console
      console.log(
        `browser-release ${result.label}: ` +
          `openToFirstPaint=${result.openToFirstPaintMs.toFixed(2)}ms ` +
          `firstProgressPending=${result.firstProgressPending} ` +
          `pointerUp=${result.pointerUpMs.toFixed(2)}ms ` +
          `canonical=${result.canonicalMs.toFixed(2)}ms ` +
          `derived=${result.derivedMs.toFixed(2)}ms ` +
          `paintedFrame=${result.paintedFrameMs.toFixed(2)}ms ` +
          `recompiles=${result.recompiles} copies=${result.geometryCopies} ` +
          `promotions=${result.dragPromotions} fullRepaints=${result.translationFullRepaints} ` +
          `repainted=${result.repaintedItems}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ label: spec.label, message });
      // eslint-disable-next-line no-console
      console.error(`browser-release ${spec.label} failed: ${message}`);
    }
    // Yield between cases so the browser can reclaim canvases/memory.
    await new Promise((resolve) => setTimeout(resolve, 32));
  }
  report.done = true;
  if (status !== null) {
    status.textContent = `done (${report.results.length} ok, ${report.errors.length} failed)`;
  }
}

// ---------------------------------------------------------------------------
// Durable reopen proof (items 4 + 6): first page load warms + persists via
// real OPFS storage; a second page load (browser reload) restores with zero
// compiles. `apps/web/tests/ink-release-bench.spec.ts` drives the reload.
// ---------------------------------------------------------------------------

const REOPEN_DOC = 'bench/durable-reopen';
const REOPEN_REVISION = 'bench-rev-1';

function reopenBinding(store: DerivedReopenStore): {
  store: DerivedReopenStore;
  documentId: string;
  getContentRevision: () => string;
  isDirty: () => boolean;
} {
  return {
    store,
    documentId: REOPEN_DOC,
    getContentRevision: () => REOPEN_REVISION,
    isDirty: () => false,
  };
}

async function runReopenWrite(): Promise<void> {
  const report: NonNullable<Window['__froglightInkBench']> = {
    done: false,
    results: [],
    errors: [],
  };
  window.__froglightInkBench = report;
  const status = document.getElementById('bench-status');
  try {
    const storage = new OpfsDerivedCacheStorage();
    const store = new DerivedReopenStore(32, storage, {
      createPacker: createDerivedCachePackWorker,
    });
    const model = singleModel(1_000);
    const record = model.objects['long-1']!;
    const compiled = compiledStrokeForRecord(record);
    const warmed = compiled !== null;
    // Background packing completed (retained) so teardown persists without
    // sync packing (closure-pass ownership; production schedules this on an
    // idle lane after commit).
    if (compiled !== null) {
      setCompiledForRecord(record, compiled, packCompiledInk(compiled).packed);
    }
    const host = createHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: host.skeleton,
      initialCamera: cameraFor(model, 'long-1', 1),
      presentation: 'paint-stage',
      navigationMode: 'standalone',
      reopen: reopenBinding(store),
    });
    handle.destroy();
    host.remove();
    await store.flushPending();
    report.reopen = {
      mode: 'write',
      hits: 0,
      misses: 0,
      computes: 0,
      warmed,
    };
  } catch (error) {
    report.errors.push({
      label: 'reopen-write',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  report.done = true;
  if (status !== null) status.textContent = 'reopen-write done';
}

async function runReopenRead(): Promise<void> {
  const report: NonNullable<Window['__froglightInkBench']> = {
    done: false,
    results: [],
    errors: [],
  };
  window.__froglightInkBench = report;
  const status = document.getElementById('bench-status');
  try {
    // A restarted host hydrates its derived manifest from OPFS before the
    // surface mounts (cheap index only); viewport-priority preparation then
    // fetches ONLY the visible packed entry (truly lazy, packed rendering
    // with zero B-spline compiles and zero rich unpacks).
    const storage = new OpfsDerivedCacheStorage();
    const store = new DerivedReopenStore(32, storage, {
      createPacker: createDerivedCachePackWorker,
    });
    store.acquire(REOPEN_DOC, REOPEN_REVISION);
    await store.hydrate(REOPEN_DOC);

    const model = singleModel(1_000);
    const host = createHost();
    const computesBefore = compiledStrokeComputeStats.computes;
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: host.skeleton,
      initialCamera: cameraFor(model, 'long-1', 1),
      presentation: 'paint-stage',
      navigationMode: 'standalone',
      reopen: reopenBinding(store),
    });
    // Truly-lazy viewport restore: the visible packed entry loads on demand
    // (bounded, preparation priority), then renders packed-direct. Poll for
    // the packed restore (not just one paint) so the measurement is
    // deterministic, never timing-dependent.
    const deadline = performance.now() + 10_000;
    let diagnostics = handle.diagnostics();
    while (
      diagnostics.reopenCompiled.cachedPackedRestored < 1 &&
      performance.now() < deadline
    ) {
      await waitForPaint();
      diagnostics = handle.diagnostics();
    }
    // Packed retention (not rich warmth): cached committed rendering stays
    // in typed-array form (no `unpackCompiledInk` for first paint).
    const warmed = hasPersistablePacked(model.objects['long-1']!);
    report.reopen = {
      mode: 'read',
      hits: diagnostics.reopenCompiled.cachedPackedRestored,
      misses: diagnostics.reopenCompiled.cachedPackedRestoreMisses,
      computes: compiledStrokeComputeStats.computes - computesBefore,
      warmed,
    };
    handle.destroy();
    host.remove();
    // Clean up the disposable record so repeated runs start cold.
    store.evict(REOPEN_DOC);
    await store.flushPending();
  } catch (error) {
    report.errors.push({
      label: 'reopen-read',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  report.done = true;
  if (status !== null) status.textContent = 'reopen-read done';
}

// ---------------------------------------------------------------------------
// Dense-Ink suite (dense-document pass): real handwritten-document shapes.
//
// `dense-open`    uncached cold open;
// `dense-write`   warms + persists through OPFS with the Worker packer;
// `dense-read`    browser-reload reopen (hydration before mount);
// `dense-hydrate` async hydration after mount (no synchronous restore-all).
// ---------------------------------------------------------------------------

interface DenseCase {
  readonly label: string;
  readonly strokes: number;
  readonly samplesPerStroke: number;
  readonly documentId: string;
}

const DENSE_CASES: readonly DenseCase[] = [
  {
    label: 'dense-500x200',
    strokes: 500,
    samplesPerStroke: 200,
    documentId: 'bench/dense-500x200',
  },
  {
    label: 'dense-1000x60',
    strokes: 1_000,
    samplesPerStroke: 60,
    documentId: 'bench/dense-1000x60',
  },
  {
    label: 'dense-5x8k',
    strokes: 5,
    samplesPerStroke: 8_000,
    documentId: 'bench/dense-5x8k',
  },
  {
    // Packed-render pathological fixture (closure pass): one huge cached
    // stroke must first-paint packed-direct with zero rich unpacks (no ~80 ms
    // object-graph expansion spike on the UI thread).
    label: 'dense-1x8k-packed',
    strokes: 1,
    samplesPerStroke: 8_000,
    documentId: 'bench/dense-1x8k-packed',
  },
];

const DENSE_REVISION = 'dense-rev-1';

function denseStrokeModel(count: number, samples: number): SurfaceModel {
  const model = emptySurface(boundedFrame(4000, 3000));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(count)));
  for (let i = 0; i < count; i++) {
    const id = `d${i}`;
    const baseX = 150 + (i % perRow) * (3600 / perRow);
    const baseY = 150 + Math.floor(i / perRow) * (2600 / perRow);
    const points: { x: number; y: number; pressure: number; dt: number }[] = [];
    for (let k = 0; k < samples; k++) {
      points.push({
        x: baseX + (k % 25) * 4,
        y: baseY + Math.floor(k / 25) * 6 + Math.sin(k / 3) * 2,
        pressure: 0.5,
        dt: k * 8,
      });
    }
    model.objects[id] = inkStrokeObject(id, { points, width: 3 });
    model.order.push(id);
  }
  return model;
}

async function runDenseCase(
  spec: DenseCase,
  mode: 'open' | 'write' | 'read' | 'hydrate',
): Promise<DenseBenchResult> {
  const built = denseStrokeModel(spec.strokes, spec.samplesPerStroke);
  const decodeStart = performance.now();
  const decoded = decodeSurfacePayload(encodeSurfacePayload(built));
  const canonicalDecodeMs = performance.now() - decodeStart;
  const model = decoded.model;
  const host = createHost();
  const storage = new OpfsDerivedCacheStorage();
  const store = new DerivedReopenStore(32, storage, {
    createPacker: createDerivedCachePackWorker,
  });
  const binding = {
    store,
    documentId: spec.documentId,
    getContentRevision: () => DENSE_REVISION,
    isDirty: () => false,
  };
  let handle: InkSurfaceHandle | null = null;
  try {
    if (mode === 'read') {
      // Browser-reload shape: hydrate the durable cache before mounting.
      store.acquire(spec.documentId, DENSE_REVISION);
      await store.hydrate(spec.documentId);
    } else if (mode === 'hydrate') {
      // Trigger the async OPFS load, then mount immediately: hydration must
      // not synchronously restore the whole document.
      store.acquire(spec.documentId, DENSE_REVISION);
    }
    const computesBefore = compiledStrokeComputeStats.computes;
    const mountStart = performance.now();
    handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: host.skeleton,
      presentation: 'paint-stage',
      navigationMode: 'standalone',
      ...(mode === 'open' ? {} : { reopen: binding }),
    });
    await waitForPaint();
    const openToFirstPaintMs = performance.now() - mountStart;
    const first = handle.diagnostics();
    const firstPaintComputes =
      compiledStrokeComputeStats.computes - computesBefore;
    const afterFirstPaintAt = performance.now();

    let restoredAfterHydration = first.reopenCompiled.cachedPackedRestored;
    if (mode === 'hydrate') {
      await store.hydrate(spec.documentId);
      // Let the hydration continuation schedule its frame.
      await waitForPaint();
      restoredAfterHydration =
        handle.diagnostics().reopenCompiled.cachedPackedRestored;
    }

    await waitForPrepared(handle, 180_000);
    await waitForPaint();
    const progressiveMs = performance.now() - afterFirstPaintAt;
    const settled = handle.diagnostics();
    let packedBytesWarm = 0;
    let warmRecords = 0;
    for (const id of model.order) {
      const record = model.objects[id]!;
      // Persistable packed (rich-retained OR packed-only Worker/packed renders):
      // teardown persists without sync `packCompiledInk`.
      if (hasPersistablePacked(record)) warmRecords += 1;
      const packed = packedCompiledForRecord(record);
      if (packed !== undefined)
        packedBytesWarm += packedCompiledByteLength(packed);
    }
    // Closure-pass ownership: background packing retains sync-compiled visible
    // strokes before teardown so `dense-write` persists the full document
    // (not just Worker-packed offscreen). Production schedules this on an
    // idle lane after commit; the bench retains explicitly for determinism.
    if (mode === 'write') {
      for (const id of model.order) {
        const record = model.objects[id]!;
        if (hasPersistablePacked(record)) continue;
        const compiled = compiledStrokeForRecord(record);
        if (compiled !== null) {
          setCompiledForRecord(
            record,
            compiled,
            packCompiledInk(compiled).packed,
          );
          warmRecords += 1;
          packedBytesWarm += packedCompiledByteLength(
            packedCompiledForRecord(record)!,
          );
        }
      }
    }
    const result = {
      label: spec.label,
      strokes: spec.strokes,
      samplesPerStroke: spec.samplesPerStroke,
      canonicalDecodeMs,
      openToFirstPaintMs,
      rendererFirstPaintMs: first.committed.firstPaintMs ?? -1,
      firstPaintVisible: first.committed.firstPaintVisible ?? 0,
      firstPaintCost: first.committed.firstPaintCost ?? 0,
      firstPaintPrepared: first.scene.cachedObjects,
      firstPaintPending: first.committed.progressPending,
      firstPaintRestored: first.reopenCompiled.cachedPackedRestored,
      firstPaintRestoreMisses: first.reopenCompiled.cachedPackedRestoreMisses,
      firstPaintComputes,
      firstPaintFullRebuilds: first.committed.fullCacheRebuilds,
      restoredAfterHydration,
      totalRestored: settled.reopenCompiled.cachedPackedRestored,
      totalComputes: compiledStrokeComputeStats.computes - computesBefore,
      workerCompiles: settled.cold.completed,
      workerIntegrationMs: settled.cold.integrationMsTotal,
      workerOutputBytes: settled.cold.outputBytesTotal,
      workerIntegrationNodes: settled.cold.outputNodesTotal,
      workerIntegrationVertices: settled.cold.outputVerticesTotal,
      cachedPackedRestoreMs: settled.reopenCompiled.cachedPackedRestoreMs,
      cachedPackedRestoredBytes:
        settled.reopenCompiled.cachedPackedRestoredBytes,
      progressiveMs,
      totalPrepared: settled.scene.cachedObjects,
      packedBytesWarm,
      warmRecords,
      persistMs: 0,
    };
    // Teardown: persistence (destroy enqueues; flush awaits the off-thread
    // pack + host write) is timed separately for physical-device comparison.
    const persistStart = performance.now();
    handle.destroy();
    handle = null;
    host.remove();
    // Durable records are left in place: `dense-read` and `dense-hydrate`
    // intentionally consume what `dense-write` persisted, and each write
    // run overwrites them (disposable cache data).
    await store.flushPending();
    return { ...result, persistMs: performance.now() - persistStart };
  } finally {
    handle?.destroy();
    host.remove();
    await store.flushPending();
  }
}

async function runDenseSuite(
  mode: 'open' | 'write' | 'read' | 'hydrate',
): Promise<void> {
  const report: NonNullable<Window['__froglightInkBench']> = {
    done: false,
    results: [],
    errors: [],
    dense: { mode: `dense-${mode}`, results: [] },
  };
  window.__froglightInkBench = report;
  const status = document.getElementById('bench-status');
  for (const spec of DENSE_CASES) {
    if (status !== null) {
      status.textContent = `dense ${mode} ${spec.label}…`;
    }
    try {
      const result = await runDenseCase(spec, mode);
      report.dense!.results.push(result);
      // eslint-disable-next-line no-console
      console.log(
        `browser-dense ${mode} ${result.label}: ` +
          `decode=${result.canonicalDecodeMs.toFixed(2)}ms ` +
          `firstPaint=${result.openToFirstPaintMs.toFixed(2)}ms ` +
          `visible=${result.firstPaintVisible} cost=${result.firstPaintCost} ` +
          `prepared=${result.firstPaintPrepared} pending=${result.firstPaintPending} ` +
          `restored=${result.firstPaintRestored} ` +
          `firstPaintComputes=${result.firstPaintComputes} ` +
          `afterHydrateRestored=${result.restoredAfterHydration} ` +
          `totalRestored=${result.totalRestored} totalComputes=${result.totalComputes} ` +
          `workerCompiles=${result.workerCompiles} ` +
          `unpackMs=${result.cachedPackedRestoreMs.toFixed(2)} ` +
          `restoredBytes=${result.cachedPackedRestoredBytes} ` +
          `workerIntegrate=${result.workerIntegrationMs.toFixed(2)}ms ` +
          `workerNodes=${result.workerIntegrationNodes} ` +
          `workerVerts=${result.workerIntegrationVertices} ` +
          `progressive=${result.progressiveMs.toFixed(2)}ms ` +
          `packedBytes=${result.packedBytesWarm} warm=${result.warmRecords} ` +
          `persist=${result.persistMs.toFixed(1)}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ label: `${mode}:${spec.label}`, message });
      // eslint-disable-next-line no-console
      console.error(`browser-dense ${mode} ${spec.label} failed: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 32));
  }
  report.done = true;
  if (status !== null) {
    status.textContent = `dense ${mode} done (${report.dense!.results.length} ok, ${report.errors.length} failed)`;
  }
}

const mode = new URLSearchParams(window.location.search).get('mode');
if (mode === 'erasure-persistence') {
  const report: NonNullable<Window['__froglightInkBench']> = {
    done: false,
    results: [],
    errors: [],
  };
  window.__froglightInkBench = report;
  void runErasurePersistence()
    .then((result) => Object.assign(report, { done: true, precision: result }))
    .catch((error) => {
      report.errors.push({ label: 'persistence', message: String(error) });
      report.done = true;
    });
} else if (mode === 'reopen-write') void runReopenWrite();
else if (mode === 'reopen-read') void runReopenRead();
else if (mode === 'dense-open') void runDenseSuite('open');
else if (mode === 'dense-write') void runDenseSuite('write');
else if (mode === 'dense-read') void runDenseSuite('read');
else if (mode === 'dense-hydrate') void runDenseSuite('hydrate');
else if (mode === 'precision') void runPrecisionBench();
else if (mode === 'background-init') void runBackgroundInitSuite();
else void main();

/**
 * Focused background-input initialization diagnostic.
 *
 * Isolates the one-shot O(N) typed-array allocation/zero-initialization in
 * `createBackgroundInputJob()` from bounded sliced copying (≤2000
 * samples/slice) and Worker compilation. Runs in real Chromium with actual
 * typed-array allocation behavior (jsdom/Node numbers do not represent
 * browser memory initialization). Reports `initMs` separately — never
 * folded into another bucket.
 */
interface BackgroundInitResult {
  readonly label: string;
  readonly samples: number;
  /** One-shot buffer allocation/zero-init ms (the measured remaining O(N)). */
  readonly initMs: number;
  /** Bounded sliced canonical copying ms (≤2000 samples/slice). */
  readonly copyMs: number;
  readonly copySlices: number;
  readonly maxSliceSamples: number;
  readonly inputBytes: number;
}

function backgroundInitModel(total: number): {
  model: SurfaceModel;
  records: SurfaceModel['order'] extends never
    ? never
    : import('@froglight/foundation').SurfaceObjectRecord[];
  logicalId: string;
} {
  const model = emptySurface(boundedFrame(500000, 5000));
  const logicalId = `BGINIT${total}`;
  let remaining = total;
  let index = 0;
  let xBase = 100;
  const cap = SURFACE_MAX_STROKE_POINTS;
  while (remaining > 0) {
    const count = Math.min(cap, remaining);
    const points: { x: number; y: number; pressure: number; dt: number }[] = [];
    for (let i = 0; i < count; i++) {
      const global = index * cap + i;
      points.push({
        x: xBase + i * 1.5,
        y: 300 + Math.sin(global / 7) * 10,
        pressure: 0.5,
        dt: global * 4,
      });
    }
    const chunkId = index === 0 ? logicalId : `${logicalId}#part${index + 1}`;
    model.objects[chunkId] = inkStrokeObject(chunkId, {
      points,
      width: 3.5,
      logicalId,
      chunkIndex: index,
    });
    model.order.push(chunkId);
    remaining -= count;
    xBase += count * 1.5;
    index += 1;
  }
  const records = model.order.map((id) => model.objects[id]!);
  return { model, records, logicalId };
}

async function runBackgroundInitSuite(): Promise<void> {
  const report: NonNullable<Window['__froglightInkBench']> = {
    done: false,
    results: [],
    errors: [],
    backgroundInit: { mode: 'background-init', results: [] },
  };
  window.__froglightInkBench = report;
  const status = document.getElementById('bench-status');
  for (const total of [100_000, 500_000]) {
    const label = `background-init-${total}`;
    if (status !== null) status.textContent = `running ${label}…`;
    try {
      const { records, logicalId } = backgroundInitModel(total);
      // Multiple runs to separate JIT warmup from steady-state allocation;
      // each run reports init separately from copying.
      const runs: BackgroundInitResult[] = [];
      for (let run = 0; run < 3; run++) {
        const timed = timeBackgroundInputInit(records, logicalId);
        if (timed === null) throw new Error('diagnostic returned null');
        runs.push({
          label: run === 0 ? `${label}-cold` : `${label}-warm${run}`,
          samples: timed.totalSamples,
          initMs: timed.initMs,
          copyMs: timed.copyMs,
          copySlices: timed.copySlices,
          maxSliceSamples: timed.maxSliceSamples,
          inputBytes: timed.inputBytes,
        });
        // Yield so the browser can reclaim the ~5–20MB buffers between runs.
        await new Promise((resolve) => setTimeout(resolve, 32));
      }
      for (const r of runs) {
        report.backgroundInit!.results.push(r);
        // eslint-disable-next-line no-console
        console.log(
          `browser-background-init ${r.label}: ` +
            `initMs=${r.initMs.toFixed(2)}ms ` +
            `copyMs=${r.copyMs.toFixed(2)}ms slices=${r.copySlices} ` +
            `maxSlice=${r.maxSliceSamples} bytes=${r.inputBytes}`,
        );
      }
      // Explicit GC hint when available (Chromium --expose-gc in CI?) — best
      // effort only, never required.
      try {
        (globalThis as { gc?: () => void }).gc?.();
      } catch {
        // Ignore.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ label, message });
      // eslint-disable-next-line no-console
      console.error(`browser-background-init ${label} failed: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 32));
  }
  report.done = true;
  if (status !== null) {
    status.textContent = `background-init done (${report.backgroundInit!.results.length} ok, ${report.errors.length} failed)`;
  }
}

/** Dense visible ink: opening and a precision erase across one row. */
async function runPrecisionBench(): Promise<void> {
  const report = {
    done: false,
    results: [],
    errors: [] as { label: string; message: string }[],
  };
  window.__froglightInkBench = report;
  const params = new URLSearchParams(window.location.search);
  const stacked = params.get('size') === 'stacked';
  const diagonal = stacked || params.get('size') === 'diagonal';
  const strokes = stacked
    ? 80
    : diagonal
      ? 60
      : params.get('size') === 'small'
        ? 100
        : 500;
  const samples = params.get('size') === 'small' ? 60 : 200;
  const model = diagonal
    ? emptySurface(boundedFrame(1000, 800))
    : denseStrokeModel(strokes, samples);
  if (diagonal) {
    for (let i = 0; i < strokes; i++) {
      const id = `d${i}`;
      model.objects[id] = inkStrokeObject(id, {
        width: 3,
        points: Array.from({ length: stacked ? 1000 : 400 }, (_, k) => ({
          x: stacked ? 50 + k * 0.8 : 50 + k * 2 + Math.sin(k / 2) * 5,
          y: stacked
            ? 400 + i * 0.02 + Math.sin(k / 2) * 4
            : 60 + i * 10 + Math.cos(k / 2) * 4,
          pressure: 0.5,
          dt: k * 8,
        })),
      });
      model.order.push(id);
    }
  }
  if (strokes === 100) {
    // Overlapping, rotated translucent ink must survive region repairs.
    model.objects.d1 = {
      ...model.objects.d0!,
      id: 'd1',
      opacity: 0.35,
      rotation: 0.12,
      color: '#f0b000',
    };
  }
  const host = createHost();
  const start = performance.now();
  const preparation = createErasurePreparation({ measure: true });
  const handle = mountInkSurface({
    erasurePreparation: preparation,
    model,
    markDirty: () => undefined,
    host: host.skeleton,
    presentation: diagonal ? 'embedded-paper' : 'paint-stage',
    navigationMode: diagonal ? 'embedded' : 'standalone',
    ...(diagonal ? { initialCamera: { x: 0, y: 0, zoom: 1 } } : {}),
  });
  try {
    await waitForPaint();
    const first = handle.diagnostics();
    await waitForPrepared(handle, 180_000);
    await waitForPaint();
    const openMs = performance.now() - start;
    const before = handle.diagnostics();
    const readPixels = () =>
      host.skeleton.canvas
        .getContext('2d')!
        .getImageData(
          0,
          0,
          host.skeleton.canvas.width,
          host.skeleton.canvas.height,
        ).data;
    const pixelDifference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let differences = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences++;
      return differences;
    };
    const originalPixels = readPixels();
    handle.setTool(SURFACE_TOOL_IDS.eraser);
    handle.setEraserPreset({
      mode: 'precision',
      radius: params.get('size') === 'small' ? 3 : 14,
    });
    const camera = handle.camera();
    const rect = host.skeleton.canvas.getBoundingClientRect();
    const x =
      rect.left +
      ((stacked ? 400 : diagonal ? 100 : 150) - camera.x) * camera.zoom;
    const y =
      rect.top +
      ((stacked ? 400 : diagonal ? 40 : 160) - camera.y) * camera.zoom;
    const moves: number[] = [];
    const frames: number[] = [];
    const eraseStart = performance.now();
    dispatchPointer(host.skeleton.canvas, 'pointerdown', x, y, 1);
    for (let i = 1; i <= (stacked ? 1 : 80); i++) {
      const t = performance.now();
      for (let sample = 0; sample < (diagonal ? 12 : 1); sample++) {
        const fraction = diagonal ? i - 1 + (sample + 1) / 12 : i;
        dispatchPointer(
          host.skeleton.canvas,
          'pointermove',
          x + fraction * (stacked ? 10 : 8),
          y + (diagonal && !stacked ? fraction * 8 : 0),
          1,
        );
      }
      moves.push(performance.now() - t);
      await nextFrame();
      frames.push(performance.now() - t);
    }
    const releaseStart = performance.now();
    dispatchPointer(
      host.skeleton.canvas,
      'pointerup',
      x + (stacked ? 10 : 640),
      y + (diagonal && !stacked ? 640 : 0),
      0,
    );
    const releaseMs = performance.now() - releaseStart;
    const pendingStart = performance.now();
    await drainSurfaceDocumentWork(model);
    const refinementWaitMs = performance.now() - pendingStart;
    await waitForPaint();
    const after = handle.diagnostics();
    const measurements = {
      workerPreparationMs: preparation.diagnostics().preparationMs,
      workerSubmissionMs: preparation.diagnostics().submissionMs,
      workerStages: preparation.diagnostics().stages,
      refinementWaitMs,
      releaseMs,
      eraseMs: performance.now() - eraseStart,
      openMs,
      firstPrepared: first.scene.cachedObjects,
      strokes,
      initialDraws: before.committed.newlyDrawnCommittedItems,
      fullEraseRepaints:
        after.committed.fullCacheRebuilds - before.committed.fullCacheRebuilds,
      eraseDraws:
        after.committed.newlyDrawnCommittedItems -
        before.committed.newlyDrawnCommittedItems,
      historyEntries: after.history.entries - before.history.entries,
      removed: strokes - model.order.length,
      moveMaxMs: Math.max(...moves),
      moveMeanMs: moves.reduce((a, b) => a + b, 0) / moves.length,
      frameMaxMs: Math.max(...frames),
      frameMeanMs: frames.reduce((a, b) => a + b, 0) / frames.length,
      erased: model.order.filter(
        (id) => model.objects[id]?.sourceId !== undefined,
      ).length,
    };
    const erasedPixels = readPixels();
    handle.refresh();
    await waitForPaint();
    const repairPixelDifference = pixelDifference(erasedPixels, readPixels());
    handle.undo();
    await drainSurfaceDocumentWork(model);
    await waitForPaint();
    await waitForPrepared(handle, 180_000);
    await waitForPaint();
    const undoPixelDifference = pixelDifference(originalPixels, readPixels());
    handle.redo();
    await drainSurfaceDocumentWork(model);
    await waitForPaint();
    await waitForPrepared(handle, 180_000);
    await waitForPaint();
    const redoPixels = readPixels();
    const redoPixelDifference = pixelDifference(erasedPixels, redoPixels);
    let redoMaxChannelDifference = 0;
    for (let i = 0; i < erasedPixels.length; i++)
      redoMaxChannelDifference = Math.max(
        redoMaxChannelDifference,
        Math.abs(erasedPixels[i]! - redoPixels[i]!),
      );
    const cold = decodeSurfacePayload(encodeSurfacePayload(model)).model;
    const coldHost = createHost();
    const reopened = mountInkSurface({
      model: cold,
      markDirty: () => undefined,
      host: coldHost.skeleton,
      presentation: diagonal ? 'embedded-paper' : 'paint-stage',
      navigationMode: diagonal ? 'embedded' : 'standalone',
      initialCamera: handle.camera(),
    });
    let reopenPixelDifference: number;
    try {
      await waitForPaint();
      await waitForPrepared(reopened, 180_000);
      await waitForPaint();
      const pixels = coldHost.skeleton.canvas
        .getContext('2d')!
        .getImageData(
          0,
          0,
          coldHost.skeleton.canvas.width,
          coldHost.skeleton.canvas.height,
        ).data;
      reopenPixelDifference = pixelDifference(erasedPixels, pixels);
    } finally {
      reopened.destroy();
      coldHost.remove();
    }
    Object.assign(report, {
      precision: {
        ...measurements,
        repairPixelDifference,
        reopenPixelDifference,
        undoPixelDifference,
        redoPixelDifference,
        redoMaxChannelDifference,
      },
    });
  } catch (error) {
    report.errors.push({ label: 'precision', message: String(error) });
  } finally {
    handle.destroy();
    host.remove();
    report.done = true;
  }
}
