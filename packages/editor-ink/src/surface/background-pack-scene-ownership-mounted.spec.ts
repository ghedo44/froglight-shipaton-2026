// @vitest-environment jsdom
/**
 * Mounted L→M prepared-scene ownership regression (survivor +
 * both-keys, proved end-to-end through the production rendezvous).
 *
 * Proves the MOUNTED orchestration — never a manual scheduler — for a
 * canonical chunk move between prepared logicals:
 *
 * ```text
 * Foundation ownership (capture/invalidate, model-scoped WeakMap)
 *   -> backgroundPackRendezvousKeysForIds (old-first `l:L,l:M` emission)
 *   -> surface.ts pending commit set (publishGeometryCommit)
 *   -> committed renderer onContentPrepared (noteGeometryPrepared)
 *   -> rendezvous intersection on BOTH keys
 *   -> resolvePreparedBackgroundPackUnitForLogical (scene preparation truth)
 *   -> scheduleBackgroundPackForPreparedUnit (ONE joint Worker job per unit)
 *   -> Worker completes -> retainJointPackedForChunks (one shared joint)
 * ```
 *
 * This test never calls `scheduleBackgroundPackForPreparedUnit`,
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
 * Prepared ownership, proved indirectly (no scene-cache internals — this
 * file never imports the scene cache or touches its private maps):
 *
 * - old L refresh: the coalesced frame recompiles the previous key, so the
 *   public `handle.diagnostics().scene.newlyCompiledObjects` reads 2 (L+M),
 *  never 1 (M alone, the older behavior that left old L rendering its
 *   stale A+B+C joint) and never a full-rebuild fallback;
 * - M refresh: the same frame recompiles the current key, and the Worker
 *   packs B+D as one joint job;
 * - rendezvous complete: both keys intersect commit/prepared, so exactly
 *   two joint Worker jobs queue from the replacement publication itself;
 * - no duplicate B: B's packed identity is M's joint alone, and no Worker
 *   job ever addresses B as a single.
 *
 * True replacement publication: the test performs the
 * B:L→M replacement itself and proves THAT mutation triggers both
 * re-packs, with NO trailing scale/rotate/style verb. A post-replacement
 * scale would publish fresh keys on the commit side by itself and mask a
 * broken replacement-publication path, so the test asserts both fresh
 * joints arrive with zero handle verbs between the replacement and the
 * drain. Setup uses small programmatic chunks (300 samples/chunk, the same
 * shape as the Foundation specs) instead of 20k-event pen gestures so
 * the suite stays fast and deterministic; every commit, preparation,
 * rendezvous, Worker job, and retention still flows through the real
 * mounted stack. A mounted warm-up verb (select-all + scale) retains the
 * initial joints first: a pre-existing model has no commit side yet, and
 * the warm-up mirrors a user editing a reopened/pasted logical. The
 * warm-up scale happens BEFORE the replacement; nothing mutates geometry
 * after it.
 *
 * Replacement seam: `resolveGroupMembers` expands any chunk id
 * to every chunk of its logical on ALL verbs by design (one logical stroke
 * behaves as one selection identity), so no handle verb can retarget a
 * SINGLE chunk — selecting L-B would scale the whole L=A+B+C. The test
 * therefore captures pre-mutation ownership and mutates through the real
 * Foundation boundary every tool/controller mutation funnels through
 * (`#before` → captureGeometryOwnershipForIds, as in the foundation specs)
 * while mounted, then notifies the mounted surface of
 * THOSE ids through the narrow `handle.notifyCanonicalMutationForTests`
 * seam (mutation-notify only: controller index sync — which runs the single
 * post-mutation `#indexMutated` → `invalidateCompiledForIds`, exactly like
 * every tool's `#synced` path — plus committed invalidation +
 * geometry-commit publication + one render frame; never the background
 * scheduler). That still proves the behavior under test:
 *
 * ```text
 * replacement ids
 *   -> mounted commit side
 *   -> prepared side
 *   -> rendezvous
 *   -> Worker
 * ```
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

/**
 * L→M fixture: L=A+B+C (bands 0/2000/4000), M=D (8000). B moves L→M; both
 * bands stay distinct so joint membership is observable through shared
 * packed identities.
 */
function ownershipModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(60000, 6000));
  addChunk(model, 'L-A', 'L', 0, 0);
  addChunk(model, 'L-B', 'L', 1, 2000);
  addChunk(model, 'L-C', 'L', 2, 4000);
  addChunk(model, 'M-D', 'M', 0, 8000);
  return model;
}

function bgpackRequests(): PackedInkCompileRequest[] {
  return FakeDomWorker.requests.filter((request) =>
    request.requestId.startsWith('bgpack-'),
  );
}

/**
 * Drain the background lane until EVERY listed group shares ONE joint
 * packed identity (or the budget expires). Pumps the already-queued idle
 * lane and lets committed-renderer frames land; never schedules anything
 * itself.
 */
async function drainUntilAllGroups(
  model: SurfaceModel,
  groups: readonly (readonly string[])[],
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flushBackgroundPackQueueForTests(300);
    let complete = true;
    for (const ids of groups) {
      const joints = ids.map((id) => {
        const record = model.objects[id];
        return record === undefined ? undefined : jointPackedForChunk(record);
      });
      if (
        joints[0] === undefined ||
        !joints.every((joint) => joint === joints[0])
      ) {
        complete = false;
        break;
      }
    }
    if (complete) return;
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

/** Prepared-unit member ids for one logical (probe only, never a driver). */
function preparedMemberIds(model: SurfaceModel, logicalId: string): string[] {
  const unit = resolvePreparedBackgroundPackUnitForLogical(model, logicalId);
  expect(unit?.kind).toBe('logical');
  if (unit?.kind !== 'logical')
    throw new Error(`expected logical ${logicalId}`);
  return unit.records.map((record) => record.id).sort();
}

describe('mounted L→M prepared-scene ownership', () => {
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

  it('B:L→M refreshes old L and M, completes the rendezvous, and represents B once', async () => {
    restoreCanvas = installCanvasStub();
    // Install the DOM Worker mock BEFORE mounting: the production facility
    // constructs the Worker lazily on first background job, so the mock
    // must be in place when the queue drains — not at mount time.
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model = ownershipModel();
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      // Mounted warm-up (real tool/history verb, BEFORE the replacement):
      // select-all + scale publishes both logicals on the commit side; the
      // committed renderer prepares them and acknowledges the same keys;
      // the rendezvous schedules ONE joint Worker job per logical with no
      // manual scheduler call.
      handle.setSelection(['L-A', 'L-B', 'L-C', 'M-D']);
      const scaled = handle.scaleSelection(1.5);
      expect([...scaled].sort()).toEqual(['L-A', 'L-B', 'L-C', 'M-D']);
      await drainUntilAllGroups(model, [['L-A', 'L-B', 'L-C'], ['M-D']]);
      const oldJointL = jointOf(model, 'L-A');
      const oldJointM = jointOf(model, 'M-D');
      expect(oldJointL).toBeDefined();
      expect(jointOf(model, 'L-B')).toBe(oldJointL);
      expect(jointOf(model, 'L-C')).toBe(oldJointL);
      expect(oldJointM).toBeDefined();
      expect(oldJointL).not.toBe(oldJointM);
      expect(bgpackRequests()).toHaveLength(2);
      expect(
        bgpackRequests()
          .map((request) => request.objectId)
          .sort(),
      ).toEqual(['L', 'M']);
      const rebuildsBefore = handle.diagnostics().scene.fullRebuilds;

      // Tripwires: any later scale/rotate/style verb would move these
      // canonical samples. Captured AFTER the warm-up, asserted unchanged
      // after the ownership re-packs to prove no masking mutation ran. B is
      // excluded: the replacement legitimately rewrites its samples.
      const survivorXBefore = new Map(
        ['L-A', 'L-C', 'M-D'].map((id) => [id, firstSampleX(model, id)]),
      );
      for (const [, x] of survivorXBefore) expect(x).not.toBeNull();

      // Ownership move B:L→M through the real Foundation boundary
      // (`#before` → captureGeometryOwnershipForIds, as in the foundation
      // specs). The post-mutation invalidation runs inside the
      // seam below (mirroring `#synced` → `#indexMutated` →
      // `invalidateCompiledForIds`, exactly once: a second invalidation
      // would retire the survivor tombstone — see the seam docs).
      captureGeometryOwnershipForIds(model, ['L-B']);
      model.objects['L-B'] = inkStrokeObject('L-B', {
        points: chunkSamples(300, 6000),
        width: 3,
        logicalId: 'M',
        chunkIndex: 1,
      });

      // Link 1 — Foundation ownership emits the old logical FIRST alongside
      // the current unit (probe only, not a scheduling driver; served from
      // the pre-mutation capture above).
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:L',
        'l:M',
      ]);

      // Replacement publication itself (seam, mutation-notify
      // only — never the background scheduler): notify the mounted surface
      // that THESE replacement ids mutated. The seam runs the single
      // post-mutation invalidation (clearing the old joints from both
      // logicals through the model-scoped membership index), publishes
      // `l:L,l:M` on the commit side, and schedules one render frame; the
      // committed renderer's frame acknowledges the same keys on the
      // prepared side and the rendezvous queues both units. NO trailing
      // scale/rotate/style verb runs after this point.
      const jobsBefore = backgroundPackStats.jobsQueued;
      const workerJobsBefore = backgroundPackStats.workerJobs;
      const requestsBefore = bgpackRequests().length;
      handle.notifyCanonicalMutationForTests(['L-B']);

      // Link 2 — the seam's invalidation cleared the old joints from BOTH
      // logicals (synchronous: no frame has run yet, so no fresh joint can
      // exist here).
      for (const id of ['L-A', 'L-B', 'L-C', 'M-D']) {
        expect(jointOf(model, id)).toBeUndefined();
      }

      // Links 3-5 — WITHOUT any manual scheduler call and WITHOUT any
      // second geometry mutation, the mounted commit side (`l:L,l:M`) meets
      // the committed renderer's prepared acknowledgement (same keys) and
      // the background scheduler queues both units; the Worker completes;
      // old L (A+C) and new M (B+D) each share one fresh joint.
      await drainUntilAllGroups(model, [
        ['L-A', 'L-C'],
        ['L-B', 'M-D'],
      ]);
      const freshL = jointOf(model, 'L-A');
      expect(freshL).toBeDefined();
      expect(freshL).not.toBe(oldJointL);
      expect(jointOf(model, 'L-C')).toBe(freshL);
      const freshM = jointOf(model, 'L-B');
      expect(freshM).toBeDefined();
      expect(freshM).not.toBe(oldJointM);
      expect(jointOf(model, 'M-D')).toBe(freshM);
      // Two owners now — the survivor and its new home never share a joint.
      expect(freshL).not.toBe(freshM);

      // Rendezvous complete: exactly one new joint job per unit — queued by
      // the mounted rendezvous from the replacement publication, not by
      // this test and not by a later masking verb.
      expect(backgroundPackStats.jobsQueued - jobsBefore).toBe(2);
      expect(backgroundPackStats.workerJobs - workerJobsBefore).toBe(2);
      const newRequests = bgpackRequests().slice(requestsBefore);
      expect(newRequests).toHaveLength(2);
      expect(newRequests.map((request) => request.objectId).sort()).toEqual([
        'L',
        'M',
      ]);

      // Prepared ownership (probe): old L is A+C, new M is B+D in
      // chunk-index order — B left its old owner.
      expect(preparedMemberIds(model, 'L')).toEqual(['L-A', 'L-C']);
      expect(preparedMemberIds(model, 'M')).toEqual(['L-B', 'M-D']);

      // No duplicate B: B is represented once, only in its new owner. No
      // Worker job ever addressed B as a single, B's joint is M's joint
      // alone, and the old L unit excludes it.
      expect(
        bgpackRequests().some((request) => request.objectId === 'L-B'),
      ).toBe(false);
      expect(jointOf(model, 'L-B')).toBe(freshM);
      expect(jointOf(model, 'L-B')).not.toBe(freshL);

      // Incremental retirement through the mounted rendezvous: the consumed
      // survivor key retired while the current unit key remains.
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:M',
      ]);

      // Prepared-scene ownership (public diagnostics only): the
      // replacement frame recompiled exactly the previous key (L) and the
      // current key (M) — never a full-rebuild fallback.
      const scene = handle.diagnostics().scene;
      expect(scene.newlyCompiledObjects).toBe(2);
      expect(scene.fullRebuilds).toBe(rebuildsBefore);

      // No masking mutation ran: survivor canonical geometry is untouched
      // since the warm-up (a scale would have moved it), and order is
      // exactly the replaced model.
      for (const [id, x] of survivorXBefore) {
        expect(firstSampleX(model, id)).toBe(x);
      }
      expect([...model.order].sort()).toEqual(['L-A', 'L-B', 'L-C', 'M-D']);

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
