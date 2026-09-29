// @vitest-environment jsdom
/**
 * Mounted survivor-rendezvous regressions (delete + same-id non-stroke).
 *
 * Proves the MOUNTED orchestration — never a manual scheduler — for
 * destructive logical mutations:
 *
 * ```text
 * Foundation ownership (capture/invalidate, model-scoped WeakMap)
 *   -> backgroundPackRendezvousKeysForIds (old-first `l:L` emission)
 *   -> surface.ts pending commit set (publishGeometryCommit)
 *   -> committed renderer onContentPrepared (noteGeometryPrepared)
 *   -> rendezvous intersection on `l:L`
 *   -> resolvePreparedBackgroundPackUnitForLogical (scene preparation truth)
 *   -> scheduleBackgroundPackForPreparedUnit (ONE joint Worker job)
 *   -> Worker completes -> retainJointPackedForChunks (one shared joint)
 * ```
 *
 * Neither test calls `scheduleBackgroundPackForPreparedUnit`,
 * `scheduleBackgroundPackForRecords`, or `flushBackgroundPackQueueForTests`
 * as the scheduling driver: `flush…` only pumps the already-queued idle
 * lane while polling (the same pump helper the production spec uses), and
 * `resolve…` / `backgroundPackRendezvousKeysForIds` appear solely as
 * assertion probes. Scheduling itself is driven by the mounted rendezvous
 * (`mountInkSurface` + narrow mutation-notify seam + committed-renderer
 * frames) with the production Worker facility (a DOM `Worker` global mock
 * running the SAME canonical compiler/packer — this file never imports or
 * calls `setBackgroundPackWorkerFactory`).
 *
 * True destructive publication: each test performs the
 * destructive mutation itself and proves THAT mutation triggers the survivor
 * re-pack, with NO trailing scale/rotate/style verb. A post-destruction
 * scale would publish `l:L` on the commit side by itself and mask a broken
 * deletion-publication path, so both tests assert the fresh joint arrives
 * with zero handle verbs between the destruction and the drain.
 *
 * Destructive-mutation seam: `resolveGroupMembers` expands any
 * chunk id to every chunk of its logical on ALL verbs by design (one logical
 * stroke behaves as one selection identity), so no handle verb can delete
 * or replace a SINGLE chunk — selecting L-B would delete the whole L=A+B+C
 * and leave no survivors. The eraser whole-stroke path expands logical ids
 * the same way, and the eraser precision-split path deliberately drops
 * chunk/logical identity on its fragments, so no eraser verb can isolate one
 * chunk either. Both destructive mutations therefore capture pre-mutation ownership and
 * mutate through the real Foundation boundary every tool/controller mutation
 * funnels through (`#before` → captureGeometryOwnershipForIds, identical to
 * the foundation specs) while mounted, then notify the mounted surface of
 * THOSE ids through the narrow `handle.notifyCanonicalMutationForTests` seam
 * (mutation-notify only: controller index sync — which runs the single
 * post-mutation `#indexMutated` → `invalidateCompiledForIds`, exactly like
 * every tool's `#synced` path — plus committed invalidation +
 * geometry-commit publication + one render frame; never the background
 * scheduler). That
 * still proves the behavior under test:
 *
 * ```text
 * destructive ids
 *   -> mounted commit side
 *   -> prepared side
 *   -> rendezvous
 *   -> Worker
 * ```
 *
 * Setup uses small programmatic 3-chunk logicals (300 samples/chunk, the
 * same shape as the Foundation specs) instead of 20k-event pen gestures
 * so the suite stays fast and deterministic; every commit, preparation,
 * rendezvous, Worker job, and retention still flows through the real
 * mounted stack. A mounted warm-up verb (select-all + scale) retains the
 * initial joint first: a pre-existing model has no commit side yet, and the
 * warm-up mirrors a user editing a reopened/pasted logical. The warm-up
 * scale happens BEFORE the destruction; nothing mutates geometry after it.
 *
 * Same-id limitation: no `InkSurfaceHandle` verb changes a record's TYPE
 * under the same id (production has no such tool), so the rectangle
 * replacement itself uses the real Foundation capture/replace/invalidate
 * path (exactly as the foundation spec does) while mounted, then the
 * same narrow seam publishes `l:M` on the commit side for THOSE ids, the
 * committed renderer acknowledges it on the prepared side, and the Worker
 * re-packs WITHOUT any manual scheduler call and WITHOUT any trailing
 * geometry verb. A future type-changing tool verb should extend this test
 * to drive the replacement through the handle as well.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
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
  rectangleObject,
  resolvePreparedBackgroundPackUnit,
  resolvePreparedBackgroundPackUnitForLogical,
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

/** L = A+B+C: three canonical chunks sharing one logical id. */
function threeChunkModel(logicalId: string): SurfaceModel {
  const model = emptySurface(boundedFrame(60000, 6000));
  addChunk(model, `${logicalId}-A`, logicalId, 0, 0);
  addChunk(model, `${logicalId}-B`, logicalId, 1, 2000);
  addChunk(model, `${logicalId}-C`, logicalId, 2, 4000);
  return model;
}

function bgpackRequests(): PackedInkCompileRequest[] {
  return FakeDomWorker.requests.filter((request) =>
    request.requestId.startsWith('bgpack-'),
  );
}

/**
 * Drain the background lane until every listed id shares ONE joint packed
 * identity (or the budget expires). Pumps the already-queued idle lane and
 * lets committed-renderer frames land; never schedules anything itself.
 */
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
    if (
      joints[0] !== undefined &&
      joints.every((joint) => joint === joints[0])
    ) {
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

/** First canonical sample x of a stroke record (masking-verb tripwire). */
function firstSampleX(model: SurfaceModel, id: string): number | null {
  const record = model.objects[id];
  if (record === undefined || record.type !== 'froglight.ink.stroke') {
    return null;
  }
  const points = (record as unknown as { points?: unknown }).points;
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0] as { x?: unknown };
  return typeof first?.x === 'number' ? first.x : null;
}

describe('mounted survivor rendezvous', () => {
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
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('delete middle B re-retains one fresh shared joint on A+C via the destructive publication itself', async () => {
    restoreCanvas = installCanvasStub();
    // Install the DOM Worker mock BEFORE mounting: the production facility
    // constructs the Worker lazily on first background job, so the mock
    // must be in place when the queue drains — not at mount time.
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model = threeChunkModel('L');
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      // Mounted warm-up (real tool/history verb, BEFORE the destruction):
      // select-all + scale publishes `l:L` on the commit side; the committed
      // renderer prepares the chunks and acknowledges the same key; the
      // rendezvous schedules ONE joint Worker job with no manual scheduler
      // call.
      handle.setSelection(['L-A', 'L-B', 'L-C']);
      const scaled = handle.scaleSelection(1.5);
      expect([...scaled].sort()).toEqual(['L-A', 'L-B', 'L-C']);
      await drainUntilSharedJoint(model, ['L-A', 'L-B', 'L-C']);
      const oldJoint = jointOf(model, 'L-A');
      expect(oldJoint).toBeDefined();
      expect(jointOf(model, 'L-B')).toBe(oldJoint);
      expect(jointOf(model, 'L-C')).toBe(oldJoint);
      expect(bgpackRequests()).toHaveLength(1);
      expect(bgpackRequests()[0]?.objectId).toBe('L');

      // Tripwire: any later scale/rotate/style verb would move these
      // canonical samples. Captured AFTER the warm-up, asserted unchanged
      // after the survivor re-pack to prove no masking mutation ran.
      const survivorXBefore = firstSampleX(model, 'L-A');
      expect(survivorXBefore).not.toBeNull();

      // Destructive mutation: remove the middle chunk B.
      //
      // Single-chunk deletion cannot go through `handle.deleteSelection`:
      // `resolveGroupMembers` expands any chunk id to every chunk of its
      // logical on ALL verbs by design (objects.ts: one logical stroke
      // behaves as one selection identity), so selecting L-B would delete
      // the whole L=A+B+C and leave no survivors. The eraser whole-stroke
      // path expands logical ids the same way, and the eraser
      // precision-split path deliberately drops chunk/logical identity on
      // its fragments, so no eraser verb can isolate one chunk either.
      // This uses the real Foundation ownership boundary every
      // tool/controller mutation funnels through (`#before` →
      // captureGeometryOwnershipForIds) — identical to the foundation
      // spec's deletion path — then mutates. The post-mutation invalidation
      // itself runs inside the seam below (mirroring `#synced` →
      // `#indexMutated` → `invalidateCompiledForIds`, exactly once: a second
      // invalidation would retire the survivor tombstone — see the seam
      // docs). (History-undo recording for the deletion itself is
      // out of scope.)
      captureGeometryOwnershipForIds(model, ['L-B']);
      delete model.objects['L-B'];
      model.order.splice(model.order.indexOf('L-B'), 1);
      expect([...model.order].sort()).toEqual(['L-A', 'L-C']);
      expect(model.objects['L-B']).toBeUndefined();

      // Link 1 — Foundation ownership emits the old logical FIRST for the
      // deleted id (probe only, not a scheduling driver; served from the
      // pre-mutation capture above).
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:L',
      ]);

      // Link 2 — the surviving logical still resolves (probe only).
      const survivorProbe = resolvePreparedBackgroundPackUnitForLogical(
        model,
        'L',
      );
      expect(survivorProbe?.kind).toBe('logical');
      if (survivorProbe?.kind !== 'logical')
        throw new Error('expected logical survivor');
      expect(survivorProbe.records.map((r) => r.id).sort()).toEqual([
        'L-A',
        'L-C',
      ]);

      // Destructive publication itself (seam, mutation-notify
      // only — never the background scheduler): notify the mounted surface
      // that THESE destructive ids mutated. The seam runs the single
      // post-mutation invalidation (clearing the old joint from the
      // survivors through the model-scoped membership index), publishes
      // `l:L` on the commit side, and schedules one render frame; the
      // committed renderer's frame acknowledges `l:L` on the prepared side
      // and the rendezvous queues L. NO trailing scale/rotate/style verb
      // runs after this point.
      const jobsBefore = backgroundPackStats.jobsQueued;
      const workerJobsBefore = backgroundPackStats.workerJobs;
      const requestsBefore = bgpackRequests().length;
      handle.notifyCanonicalMutationForTests(['L-B']);

      // Link 3 — the seam's invalidation cleared the old joint from the
      // survivors (synchronous: no frame has run yet, so no fresh joint
      // can exist here).
      expect(jointOf(model, 'L-A')).toBeUndefined();
      expect(jointOf(model, 'L-C')).toBeUndefined();

      // Links 4-6 — WITHOUT any manual scheduler call and WITHOUT any
      // second geometry mutation, the mounted commit side (`l:L`) meets the
      // committed renderer's prepared acknowledgement (`l:L`) and the
      // background scheduler queues L; the Worker completes; A+C share one
      // fresh joint.
      await drainUntilSharedJoint(model, ['L-A', 'L-C']);
      const fresh = jointOf(model, 'L-A');
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(oldJoint);
      expect(jointOf(model, 'L-C')).toBe(fresh);

      // Exactly one new joint job for the surviving logical — queued by the
      // mounted rendezvous from the destructive publication, not by this
      // test and not by a later masking verb.
      expect(backgroundPackStats.jobsQueued - jobsBefore).toBe(1);
      expect(backgroundPackStats.workerJobs - workerJobsBefore).toBe(1);
      const newRequests = bgpackRequests().slice(requestsBefore);
      expect(newRequests).toHaveLength(1);
      expect(newRequests[0]?.objectId).toBe('L');
      expect(bgpackRequests()).toHaveLength(2);

      // No masking mutation ran: survivor canonical geometry is untouched
      // since the warm-up (a scale would have moved it), and membership is
      // exactly the two survivors.
      expect(firstSampleX(model, 'L-A')).toBe(survivorXBefore);
      expect([...model.order].sort()).toEqual(['L-A', 'L-C']);

      //  E3 gates: no main-thread full pack, bounded input slices.
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
      expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
        BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
      );
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);

  it('same-id rectangle replacement of B re-retains A+C via the replacement publication itself while the rectangle never packs', async () => {
    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model = threeChunkModel('M');
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      // Same mounted warm-up as the delete case (BEFORE the replacement):
      // real verb retains the initial joint through the rendezvous (no
      // manual scheduler).
      handle.setSelection(['M-A', 'M-B', 'M-C']);
      handle.scaleSelection(1.5);
      await drainUntilSharedJoint(model, ['M-A', 'M-B', 'M-C']);
      const oldJoint = jointOf(model, 'M-A');
      expect(oldJoint).toBeDefined();
      expect(bgpackRequests()).toHaveLength(1);

      // Tripwire against a masking verb after the replacement.
      const survivorXBefore = firstSampleX(model, 'M-A');
      expect(survivorXBefore).not.toBeNull();

      // Same-id non-stroke replacement under the live mount. No handle verb
      // changes a record's type under the same id, so this captures
      // pre-mutation ownership (mirroring `#before`) and replaces through
      // the real Foundation boundary (identical to the foundation spec).
      // The post-mutation invalidation runs inside the seam below (single
      // invalidation — see the seam docs and the delete case above).
      captureGeometryOwnershipForIds(model, ['M-B']);
      model.objects['M-B'] = rectangleObject('M-B', {
        x: 10,
        y: 10,
        width: 100,
        height: 50,
      });

      // Rendezvous names ONLY the surviving old logical — never the
      // rectangle (probe only, not a scheduling driver; served from the
      // pre-mutation capture above).
      expect(backgroundPackRendezvousKeysForIds(model, ['M-B'])).toEqual([
        'l:M',
      ]);

      // The rectangle itself is never an Ink background-pack unit (probe).
      expect(resolvePreparedBackgroundPackUnit(model, 'M-B')).toBeNull();
      expect(jointOf(model, 'M-B')).toBeUndefined();

      // Surviving A+C still resolve as one logical unit (probe).
      const survivorProbe = resolvePreparedBackgroundPackUnitForLogical(
        model,
        'M',
      );
      expect(survivorProbe?.kind).toBe('logical');
      if (survivorProbe?.kind !== 'logical')
        throw new Error('expected logical survivor');
      expect(survivorProbe.records.map((r) => r.id).sort()).toEqual([
        'M-A',
        'M-C',
      ]);

      // Replacement publication itself (seam, mutation-notify
      // only): notify the mounted surface that THESE replacement ids
      // mutated. The seam runs the single post-mutation invalidation
      // (clearing the old joint from the survivors), publishes `l:M` on the
      // commit side, and schedules one render frame for the prepared-side
      // acknowledgement. NO trailing scale/rotate/style verb runs after
      // this point.
      const jobsBefore = backgroundPackStats.jobsQueued;
      const workerJobsBefore = backgroundPackStats.workerJobs;
      const requestsBefore = bgpackRequests().length;
      handle.notifyCanonicalMutationForTests(['M-B']);

      // The seam's invalidation cleared the old joint from the survivors
      // (synchronous: no frame has run yet, so no fresh joint can exist).
      expect(jointOf(model, 'M-A')).toBeUndefined();
      expect(jointOf(model, 'M-C')).toBeUndefined();

      await drainUntilSharedJoint(model, ['M-A', 'M-C']);
      const fresh = jointOf(model, 'M-A');
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(oldJoint);
      expect(jointOf(model, 'M-C')).toBe(fresh);

      // Exactly one new joint job for the surviving logical.
      expect(backgroundPackStats.jobsQueued - jobsBefore).toBe(1);
      expect(backgroundPackStats.workerJobs - workerJobsBefore).toBe(1);
      const newRequests = bgpackRequests().slice(requestsBefore);
      expect(newRequests).toHaveLength(1);
      expect(newRequests[0]?.objectId).toBe('M');

      // The replacement never packed: no `r:M-B` key, no joint on the
      // rectangle, and no Worker job ever addressed it.
      expect(backgroundPackRendezvousKeysForIds(model, ['M-B'])).not.toContain(
        'r:M-B',
      );
      expect(jointOf(model, 'M-B')).toBeUndefined();
      expect(
        bgpackRequests().some((request) => request.objectId === 'M-B'),
      ).toBe(false);

      // No masking mutation ran: survivor canonical geometry is untouched
      // since the warm-up.
      expect(firstSampleX(model, 'M-A')).toBe(survivorXBefore);

      //  E3 gates: no main-thread full pack, bounded input slices.
      expect(backgroundPackStats.mainThreadFullPacks).toBe(0);
      expect(backgroundPackStats.maxInputSamplesPerSlice).toBeLessThanOrEqual(
        BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
      );
    } finally {
      handle.destroy();
      cleanup();
    }
  }, 60000);
});
