// @vitest-environment jsdom
/**
 * Production background-pack wiring regression.
 *
 * Proves the REAL production editor path configures the background Worker
 * without any test-only setter: this file never imports or calls
 * `setBackgroundPackWorkerFactory`. Mounting the real `mountInkSurface`
 * installs the package-level production facility (shared Ink Worker entry);
 * a real pointer gesture then schedules the background lane and obtains
 * retained packed geometry through that configured Worker.
 *
 * jsdom has no real Worker, so the test installs a DOM `Worker` global mock
 * (the production factory constructs `new Worker(new URL(...))` lazily on
 * first need). The mock runs the SAME canonical compiler/packer. No
 * Foundation background-pack setter is used.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  drainSurfaceDocumentWork,
  boundedFrame,
  emptySurface,
  jointPackedForChunk,
  packedCompiledForRecord,
  smoothSpineOfRecord,
  flushBackgroundPackQueueForTests,
  cancelBackgroundPackForTests,
  backgroundPackStats,
  BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
  compileInkStroke,
  packCompiledInk,
  unpackInkSamples,
  SURFACE_MAX_STROKE_POINTS,
  SURFACE_TOOL_IDS,
  type SurfaceModel,
  type SurfaceObjectRecord,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from '@froglight/foundation';
import {
  createTestErasurePreparation,
  installCanvasStub,
} from '@froglight/foundation/testing';
import { mountInkSurface, type InkSkeleton } from '../index.js';

/** DOM Worker mock: real canonical compile/pack off the (mock) thread. */
class FakeDomWorker {
  /** Requests posted through the production Worker adapter (per test). */
  static requests: PackedInkCompileRequest[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: PackedInkCompileRequest): void {
    FakeDomWorker.requests.push(message);
    // NOTE: no structuredClone here — jsdom structuredClone produces
    // cross-realm typed arrays that fail `instanceof Float64Array` in the
    // foundation module. The production transfer neuters buffers; the mock
    // passes the reference through (the job is parked awaiting the response
    // and never touches buffers after post).
    const request = message;
    queueMicrotask(() => {
      try {
        const compiled = compileInkStroke(
          unpackInkSamples(request.samples),
          request.brush,
          request.options ?? {},
        );
        const { packed, bytes } = packCompiledInk(compiled);
        this.onmessage?.({
          data: {
            type: 'compiled-ink',
            requestId: request.requestId,
            objectId: request.objectId,
            generation: request.generation,
            compiled: packed,
            workerUnpackMs: 0,
            compileMs: 1,
            packMs: 0,
            outputBytes: bytes,
          } as PackedInkCompileResponse,
        } as unknown as MessageEvent);
      } catch (error) {
        this.onmessage?.({
          data: {
            type: 'compile-error',
            requestId: request.requestId,
            objectId: request.objectId,
            generation: request.generation,
            error: error instanceof Error ? error.message : String(error),
          },
        } as unknown as MessageEvent);
      }
    });
  }
  terminate(): void {
    // No-op mock.
  }
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
  page.appendChild(pointerIndicator);
  page.appendChild(overlayRoot);
  root.appendChild(page);
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
    skeleton: { root, page, canvas, badge, pointerIndicator, overlayRoot },
    cleanup: () => root.remove(),
  };
}

function pointerEvent(
  type: string,
  x: number,
  y: number,
  timeStamp: number,
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
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

async function drawStroke(
  canvas: HTMLCanvasElement,
  startX: number,
  startY: number,
  clock: number,
): Promise<void> {
  canvas.dispatchEvent(pointerEvent('pointerdown', startX, startY, clock));
  for (let i = 1; i <= 600; i++) {
    canvas.dispatchEvent(
      pointerEvent(
        'pointermove',
        startX + i * 0.5,
        startY + Math.sin(i / 8) * 10,
        clock + i * 4,
      ),
    );
  }
  canvas.dispatchEvent(
    pointerEvent('pointerup', startX + 300, startY, clock + 2404),
  );
  await Promise.resolve();
  // Let the real requestAnimationFrame-backed committed-render lifecycle
  // prepare the just-committed ids before draining the idle Worker lane.
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Production pen gesture exceeding `SURFACE_MAX_STROKE_POINTS` so the real
 * tool path emits multiple canonical logical chunks. Every sample is
 * distinct, so the coalescer cannot drop any as duplicates.
 */
async function drawLongStroke(
  canvas: HTMLCanvasElement,
  startX: number,
  startY: number,
  clock: number,
): Promise<void> {
  canvas.dispatchEvent(pointerEvent('pointerdown', startX, startY, clock));
  for (let i = 1; i <= SURFACE_MAX_STROKE_POINTS + 20; i++) {
    canvas.dispatchEvent(
      pointerEvent(
        'pointermove',
        startX + i * 0.1,
        startY + Math.sin(i / 50) * 3,
        clock + i,
      ),
    );
  }
  canvas.dispatchEvent(
    pointerEvent('pointerup', startX + 4, startY + 1, clock + 999999),
  );
  await Promise.resolve();
}

/**
 * Drain the background lane until `retained` observes committed geometry
 * for some current record (or the budget expires). The committed scene
 * prepares content on its next frame; polling keeps regressions
 * deterministic across rAF timing.
 */
async function drainUntilRetained(
  model: SurfaceModel,
  retained: (record: SurfaceObjectRecord) => boolean,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flushBackgroundPackQueueForTests(300);
    for (const id of model.order) {
      const record = model.objects[id];
      if (record !== undefined && retained(record)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function drainUntilJointRetained(
  model: SurfaceModel,
  timeoutMs = 20000,
): Promise<void> {
  await drainUntilRetained(
    model,
    (record) => jointPackedForChunk(record) !== undefined,
    timeoutMs,
  );
}

/** Poll a synchronous condition across rAF-backed frames. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

describe('production background-pack wiring', () => {
  let restoreCanvas: (() => void) | null = null;
  let prevWorker: unknown = undefined;
  let prevWorkerDesc: PropertyDescriptor | undefined;

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    // Restore the Worker global without touching the background-pack factory
    // (cancel preserves the production facility for file isolation).
    try {
      if (prevWorkerDesc !== undefined) {
        Object.defineProperty(globalThis, 'Worker', prevWorkerDesc);
      } else {
        delete (globalThis as unknown as Record<string, unknown>).Worker;
      }
      void prevWorker;
    } catch {
      // Restoration never breaks tests.
    }
    try {
      cancelBackgroundPackForTests();
    } catch {
      // Ignore.
    }
    FakeDomWorker.requests.length = 0;
    vi.restoreAllMocks();
  });

  it('one real gesture schedules and retains its own stroke', async () => {
    restoreCanvas = installCanvasStub();
    // Install the DOM Worker mock BEFORE mounting: the production facility
    // constructs the Worker lazily on first background job, so the mock
    // must be in place when the queue drains — not at mount time.
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    // Real production mount (installs the package-level background Worker
    // facility internally; this test never calls the Foundation setter).
    const model: SurfaceModel = emptySurface(boundedFrame(4000, 4000));
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      const completedBefore = backgroundPackStats.workerCompleted;
      await drawStroke(skeleton.canvas, 200, 300, 1000);
      expect(model.order).toHaveLength(1);
      const createdId = model.order[0]!;
      const record = model.objects[createdId]!;
      await flushBackgroundPackQueueForTests(100);

      expect(backgroundPackStats.workerCompleted).toBeGreaterThan(
        completedBefore,
      );
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
      expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
        BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
      );
      // Retained packed geometry through the configured Worker (not counters).
      const retained = packedCompiledForRecord(record);
      expect(retained).toBeDefined();
      const spine = smoothSpineOfRecord(record);
      expect(spine.length).toBeGreaterThan(0);
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);

  it('two gestures each schedule their newly-created stroke without lag', async () => {
    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model: SurfaceModel = emptySurface(boundedFrame(4000, 4000));
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      await drawStroke(skeleton.canvas, 200, 300, 1000);
      expect(model.order).toHaveLength(1);
      const first = model.objects[model.order[0]!]!;
      await flushBackgroundPackQueueForTests(100);
      expect(packedCompiledForRecord(first)).toBeDefined();

      await drawStroke(skeleton.canvas, 200, 500, 5000);
      expect(model.order).toHaveLength(2);
      const second = model.objects[model.order[1]!]!;
      await flushBackgroundPackQueueForTests(100);
      expect(packedCompiledForRecord(first)).toBeDefined();
      expect(packedCompiledForRecord(second)).toBeDefined();
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
      expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
        BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
      );
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);

  it('one real >10k pen gesture retains ONE shared joint packed result across all canonical chunks', async () => {
    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model: SurfaceModel = emptySurface(boundedFrame(4000, 4000));
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
      initialCamera: { x: 0, y: 0, zoom: 1 },
    });
    try {
      const completedBefore = backgroundPackStats.workerCompleted;
      const workerJobsBefore = backgroundPackStats.workerJobs;
      await drawLongStroke(skeleton.canvas, 100, 300, 1000);
      expect(model.order.length).toBeGreaterThanOrEqual(2);
      const chunks = model.order.map((id) => model.objects[id]!);

      // 1-2. Multiple canonical chunks sharing one logical id.
      const logicalIds = new Set(
        chunks.map((chunk) => (chunk as { logicalId?: unknown }).logicalId),
      );
      expect(logicalIds.size).toBe(1);
      const logicalId = [...logicalIds][0] as string;
      expect(typeof logicalId).toBe('string');
      expect(logicalId.length).toBeGreaterThan(0);

      // 3. chunkIndex values are present and orderable.
      const indices = chunks.map(
        (chunk) => (chunk as { chunkIndex?: unknown }).chunkIndex,
      );
      expect(indices.every((index) => typeof index === 'number')).toBe(true);
      expect(
        [...indices].sort((a, b) => (a as number) - (b as number)),
      ).toEqual(indices);
      expect(new Set(indices).size).toBe(indices.length);

      await drainUntilJointRetained(model);

      // 4-6. Every chunk retains the SAME packed joint with real geometry.
      const joint = jointPackedForChunk(chunks[0]!);
      expect(joint).toBeDefined();
      for (const chunk of chunks) {
        expect(jointPackedForChunk(chunk)).toBe(joint);
      }
      expect(joint!.boundsXYWH[2]).toBeGreaterThan(0);
      expect(joint!.boundsXYWH[3]).toBeGreaterThan(0);
      expect(smoothSpineOfRecord(chunks[0]!).length).toBeGreaterThan(0);

      // 7-8. Worker job completed; no main-thread full pack.
      expect(backgroundPackStats.workerCompleted).toBeGreaterThan(
        completedBefore,
      );
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);

      // 9. Canonical input copying stayed bounded.
      expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
        BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
      );

      // 10. ONE logical background job, not independent per-chunk jobs.
      const packRequests = FakeDomWorker.requests.filter((request) =>
        request.requestId.startsWith('bgpack-'),
      );
      expect(packRequests).toHaveLength(1);
      expect(packRequests[0]!.objectId).toBe(logicalId);
      expect(backgroundPackStats.workerJobs - workerJobsBefore).toBe(1);
      // One chunk's samples are not packed alone: the joint request carries
      // the full canonical logical length (> SURFACE_MAX_STROKE_POINTS).
      expect(packRequests[0]!.samples.count).toBeGreaterThan(
        SURFACE_MAX_STROKE_POINTS,
      );
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 120000);

  it('commit → prepared rendezvous schedules exactly once, only after scene preparation', async () => {
    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model: SurfaceModel = emptySurface(boundedFrame(4000, 4000));
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      const jobsBefore = backgroundPackStats.jobsQueued;
      // Inline gesture so commit and preparation can be observed separately
      // (the shared drawStroke helper already waits for the frame).
      const canvas = skeleton.canvas;
      canvas.dispatchEvent(pointerEvent('pointerdown', 200, 300, 1000));
      for (let i = 1; i <= 80; i++) {
        canvas.dispatchEvent(
          pointerEvent(
            'pointermove',
            200 + i,
            300 + Math.sin(i / 8) * 6,
            1000 + i * 8,
          ),
        );
      }
      canvas.dispatchEvent(pointerEvent('pointerup', 280, 300, 2000));
      await Promise.resolve();
      // Commit published; the committed scene has not prepared yet, so no
      // unit exists in both domains and NOTHING is scheduled.
      expect(backgroundPackStats.jobsQueued).toBe(jobsBefore);
      expect(model.order).toHaveLength(1);
      const record = model.objects[model.order[0]!]!;

      // Next committed frame: prepared ∩ commit → exactly one schedule.
      await waitFor(() => backgroundPackStats.jobsQueued > jobsBefore);
      expect(backgroundPackStats.jobsQueued).toBe(jobsBefore + 1);
      await flushBackgroundPackQueueForTests(100);
      expect(packedCompiledForRecord(record)).toBeDefined();
      expect(
        FakeDomWorker.requests.filter((request) =>
          request.requestId.startsWith('bgpack-'),
        ),
      ).toHaveLength(1);
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);

  it('prepared → commit: erasing retains packed source geometry through pointer-up', async () => {
    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model: SurfaceModel = emptySurface(boundedFrame(4000, 4000));
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      erasurePreparation: createTestErasurePreparation(),
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      const canvas = skeleton.canvas;
      await drawStroke(canvas, 200, 300, 1000);
      await flushBackgroundPackQueueForTests(100);
      const original = model.objects[model.order[0]!]!;
      expect(packedCompiledForRecord(original)).toBeDefined();

      // Precision eraser: mutations happen on pointermove while the history
      // gesture is still open, and the next frame prepares the masked
      // replacement BEFORE pointer-up commits.
      handle.setTool(SURFACE_TOOL_IDS.eraser);
      handle.setEraserPreset({ mode: 'precision', radius: 14 });
      const framesBefore = handle.diagnostics().renderFrames;
      const jobsBefore = backgroundPackStats.jobsQueued;
      canvas.dispatchEvent(pointerEvent('pointerdown', 350, 300, 5000));
      for (let i = 1; i <= 6; i++) {
        canvas.dispatchEvent(
          pointerEvent('pointermove', 350, 300 + i * 3, 5000 + i * 12),
        );
      }
      // Mid-gesture frame: the provisional filled region exists and the
      // scene has prepared the draft while the history commit is still pending.
      await waitFor(
        () => handle.diagnostics().renderFrames > framesBefore,
        5000,
      );
      expect(handle.diagnostics().renderFrames).toBeGreaterThan(framesBefore);

      canvas.dispatchEvent(pointerEvent('pointerup', 350, 318, 5400));
      await drainSurfaceDocumentWork(model);
      expect(model.order[0]).toBe(original.id);
      const retained = model.objects[original.id]!;
      expect(retained.points).toBeUndefined();
      expect(retained.visible).toBeDefined();
      const source = model.objects[retained.sourceId as string]!;
      const chunk = (source.chunks as SurfaceObjectRecord[])[0]!;
      expect(chunk.points).toEqual(original.points);
      // The source is already packed. Fragment edits must not repack it,
      // whether the replacement was prepared before or after pointer-up.
      expect(backgroundPackStats.jobsQueued - jobsBefore).toBe(0);
      expect(packedCompiledForRecord(chunk)).toBeDefined();
      await flushBackgroundPackQueueForTests(300);
      expect(packedCompiledForRecord(chunk)).toBeDefined();
      expect(smoothSpineOfRecord(chunk).length).toBeGreaterThan(0);
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);

  it('undo/redo and selection scale re-retain packed geometry through centralized commit publication', async () => {
    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model: SurfaceModel = emptySurface(boundedFrame(4000, 4000));
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      await drawStroke(skeleton.canvas, 200, 300, 1000);
      await flushBackgroundPackQueueForTests(100);
      const created = model.objects[model.order[0]!]!;
      expect(packedCompiledForRecord(created)).toBeDefined();

      // Undo removes the committed geometry; redo restores a fresh record
      // object whose derived caches are cold. The centralized non-pointer
      // commit publication + scene preparation must re-retain it.
      expect(handle.undo()).toBe(true);
      expect(model.order).toHaveLength(0);
      expect(handle.redo()).toBe(true);
      expect(model.order).toHaveLength(1);
      const restored = model.objects[model.order[0]!]!;
      expect(restored).not.toBe(created);
      await drainUntilRetained(
        model,
        (record) => packedCompiledForRecord(record) !== undefined,
      );
      expect(packedCompiledForRecord(restored)).toBeDefined();
      expect(jointPackedForChunk(restored)).toBeUndefined();
      expect(smoothSpineOfRecord(restored).length).toBeGreaterThan(0);

      // Selection scale is a geometry-changing selection transaction:
      // invalidate + prepare + commit publication re-retain packed geometry.
      handle.setSelection([restored.id]);
      const jobsBefore = backgroundPackStats.jobsQueued;
      handle.scaleSelection(1.5);
      expect(packedCompiledForRecord(restored)).toBeUndefined();
      await drainUntilRetained(
        model,
        (record) => packedCompiledForRecord(record) !== undefined,
      );
      expect(backgroundPackStats.jobsQueued).toBeGreaterThan(jobsBefore);
      expect(packedCompiledForRecord(restored)).toBeDefined();
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);
});
