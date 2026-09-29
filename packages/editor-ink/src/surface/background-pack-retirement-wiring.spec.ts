// @vitest-environment jsdom
/**
 *  retirement wiring: the mounted commit/prepared rendezvous retires
 * Foundation pending replaced-away state only for CONSUMED keys.
 *
 * Proves the production path (never a manual scheduler, never manual
 * prepared keys):
 *
 * ```text
 * Foundation capture/replace/invalidate (pending {L} for B)
 *   -> handle.notifyCanonicalMutationForTests (commit l:L + r:B)
 *   -> committed-renderer frame (prepared l:L + r:B)
 *   -> scheduleBackgroundPackRendezvous consumes l:L (survivor scheduled)
 *      or drops it (no-survivor) -> acknowledgeBackgroundPackRendezvousKeys
 *   -> backgroundPackRendezvousKeysForIds no longer emits l:L via pending
 * ```
 *
 * Acceptance mapping:
 * - (2) consumed -> pending shrinks: after the drain, `l:L` is gone from
 *   B's keys while the current `r:B` remains.
 * - (3) unintersected/false keys do NOT retire: synchronously after notify
 *   (commit published, prepared frame not yet run, no intersection yet) the
 *   old `l:L` is still published; only the post-drain probe loses it.
 * - (1) root import: `acknowledgeBackgroundPackRendezvousKeys` is imported
 *   from '@froglight/foundation' (not a deep import) and asserted callable.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  acknowledgeBackgroundPackRendezvousKeys,
  backgroundPackRendezvousKeysForIds,
  backgroundPackStats,
  boundedFrame,
  cancelBackgroundPackForTests,
  captureGeometryOwnershipForIds,
  compileInkStroke,
  emptySurface,
  flushBackgroundPackQueueForTests,
  inkStrokeObject,
  jointPackedForChunk,
  packCompiledInk,
  unpackInkSamples,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { mountInkSurface, type InkSkeleton } from '../index.js';

/** DOM Worker mock: real canonical compile/pack off the (mock) thread. */
class FakeDomWorker {
  static requests: PackedInkCompileRequest[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: PackedInkCompileRequest): void {
    FakeDomWorker.requests.push(message);
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

function chunkSamples(
  count: number,
  xBase: number,
): { x: number; y: number; pressure: number; dt: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    x: xBase + i * 2,
    y: 200 + Math.sin((xBase + i) / 6) * 9,
    pressure: 0.5,
    dt: (xBase + i) * 6,
  }));
}

function addChunk(
  model: SurfaceModel,
  id: string,
  logicalId: string,
  chunkIndex: number,
  xBase: number,
): void {
  model.objects[id] = inkStrokeObject(id, {
    points: chunkSamples(300, xBase),
    width: 3,
    logicalId,
    chunkIndex,
  });
  model.order.push(id);
}

function threeChunkModel(logicalId: string): SurfaceModel {
  const model = emptySurface(boundedFrame(60000, 6000));
  addChunk(model, `${logicalId}-A`, logicalId, 0, 0);
  addChunk(model, `${logicalId}-B`, logicalId, 1, 2000);
  addChunk(model, `${logicalId}-C`, logicalId, 2, 4000);
  return model;
}

async function drainUntilSharedJoint(
  model: SurfaceModel,
  ids: readonly string[],
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flushBackgroundPackQueueForTests(300);
    const joints = ids.map((id) => {
      const record = model.objects[id];
      return record === undefined ? undefined : jointPackedForChunk(record);
    });
    if (joints[0] !== undefined && joints.every((j) => j === joints[0])) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function jointOf(model: SurfaceModel, id: string): unknown {
  const record: SurfaceObjectRecord | undefined = model.objects[id];
  if (record === undefined) return undefined;
  return jointPackedForChunk(record);
}

describe('retirement wiring (mounted rendezvous consumes -> pending shrinks)', () => {
  let restoreCanvas: (() => void) | null = null;
  let prevWorkerDesc: PropertyDescriptor | undefined;

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    try {
      if (prevWorkerDesc !== undefined) {
        Object.defineProperty(globalThis, 'Worker', prevWorkerDesc);
      } else {
        delete (globalThis as unknown as Record<string, unknown>).Worker;
      }
    } catch {
      // Restoration never breaks tests.
    }
    try {
      cancelBackgroundPackForTests();
    } catch {
      // Ignore.
    }
    FakeDomWorker.requests.length = 0;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('replacement L->single retires l:L from pending only after the rendezvous consumes it', async () => {
    // (1) ack is importable from the package root (no deep import).
    expect(typeof acknowledgeBackgroundPackRendezvousKeys).toBe('function');

    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model = threeChunkModel('W');
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      // Warm-up retains the initial joint through the real rendezvous.
      handle.setSelection(['W-A', 'W-B', 'W-C']);
      handle.scaleSelection(1.5);
      await drainUntilSharedJoint(model, ['W-A', 'W-B', 'W-C']);
      expect(jointOf(model, 'W-A')).toBeDefined();

      // Same-id single replacement under the live mount (real Foundation
      // capture/replace boundary; the post-mutation invalidation runs inside
      // the notify seam below, exactly once). The fresh single is
      // deliberately never warmed here.
      const oldPoints = (
        model.objects['W-B'] as unknown as {
          points: { x: number; y: number; pressure: number; dt: number }[];
        }
      ).points;
      captureGeometryOwnershipForIds(model, ['W-B']);
      model.objects['W-B'] = inkStrokeObject('W-B', {
        points: oldPoints.map((p) => ({ ...p, y: p.y + 500 })),
        width: 3,
      });

      // Pre-notify: the old survivor is still published (pending/remembered).
      expect(backgroundPackRendezvousKeysForIds(model, ['W-B'])).toEqual([
        'l:W',
        'r:W-B',
      ]);

      // Commit publication only (prepared frame has not run yet): no
      // intersection, so nothing is consumed and nothing retires — the old
      // survivor must still be published synchronously after notify.
      handle.notifyCanonicalMutationForTests(['W-B']);
      expect(backgroundPackRendezvousKeysForIds(model, ['W-B'])).toEqual([
        'l:W',
        'r:W-B',
      ]);

      // Drain the mounted rendezvous + Worker lane (no manual scheduler):
      // the surviving A+C re-retain one fresh joint...
      await drainUntilSharedJoint(model, ['W-A', 'W-C']);
      const fresh = jointOf(model, 'W-A');
      expect(fresh).toBeDefined();
      expect(jointOf(model, 'W-C')).toBe(fresh);

      // ...and the consumed l:W retired from Foundation pending state while
      // the current single key remains (false-kept singles also keep r:B;
      // either way the current unit is always emitted).
      expect(backgroundPackRendezvousKeysForIds(model, ['W-B'])).toEqual([
        'r:W-B',
      ]);
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);
});
