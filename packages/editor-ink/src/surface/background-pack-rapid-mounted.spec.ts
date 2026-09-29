// @vitest-environment jsdom
/**
 * Mounted rapid-replacement regressions (multi-set + prepared scene).
 *
 * Proves the MOUNTED production rendezvous — never a manual scheduler — for
 * rapid logical replacements that outrun the prepared acknowledgement:
 *
 * ```text
 * Foundation capture/mutate/invalidate per move (model-scoped pending sets)
 *   -> handle.notifyCanonicalMutationForTests per move (commit side only;
 *      the coalesced render frame has not run, so no prepared ack yet)
 *   -> ONE coalesced committed frame (prepared side for the same ids)
 *   -> rendezvous intersection on `l:*` keys
 *   -> resolvePreparedBackgroundPackUnitForLogical (scene preparation truth)
 *   -> scheduleBackgroundPackForPreparedUnit (ONE joint Worker job per unit)
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
 * Single-slot failure mode (why the rapid test needs): a single
 * `replacedOldLogicalByRecordId` slot overwrites L with M on the second
 * invalidation of B:L→M→N, so the commit side can only publish `l:M,l:N`
 * and the surviving A+C joint is never re-queued (lost logical). The
 * per-record pending multi-set instead accumulates {L,M}, so the sync
 * pre-drain probe reads exactly `['l:L','l:M','l:N']` — oldest first,
 * deduped, deterministic. That probe fails on the single-slot design
 * before any Worker work runs.
 *
 * Prepared-scene interaction (why the scene-count assertions need):
 * the two synchronous notifies coalesce into ONE committed frame whose
 * `update(['B'])` resolves the previous prepared key (old ownership L via
 * `chunkToKey`) AND the current canonical key (N) — `newlyCompiledObjects`
 * is therefore 2 ({L,N}). The transient intermediate (B in M) is never
 * prepared by that frame, so M owes no scene invalidation and stays D-only
 * by reuse; its pack still flows from canonical truth. Without the
 * both-keys fix only the current key recompiles (`newlyCompiledObjects`
 * would be 1 and old L would render stale). Scene state is read through
 * the public `handle.diagnostics().scene` seam only — this file never
 * imports the scene cache or touches its internals.
 *
 * True replacement publication: each test performs the
 * replacement mutations themselves and proves THOSE mutations trigger the
 * re-packs, with NO trailing scale/rotate/style verb. A post-replacement
 * scale would publish fresh keys on the commit side by itself and mask a
 * broken replacement-publication path, so every test asserts the fresh
 * joints arrive with zero handle verbs between the last replacement and
 * the drain. Setup uses small programmatic 3-chunk logicals (300
 * samples/chunk, the same shape as the Foundation specs) instead of
 * 20k-event pen gestures so the suite stays fast and deterministic; every
 * commit, preparation, rendezvous, Worker job, and retention still flows
 * through the real mounted stack. A mounted warm-up verb (select-all +
 * scale) retains the initial joints first: a pre-existing model has no
 * commit side yet, and the warm-up mirrors a user editing a
 * reopened/pasted logical. The warm-up scale happens BEFORE the
 * replacements; nothing mutates geometry after them.
 *
 * Destructive-mutation seam: `resolveGroupMembers` expands any
 * chunk id to every chunk of its logical on ALL verbs by design (one logical
 * stroke behaves as one selection identity), so no handle verb can retarget
 * a SINGLE chunk — selecting L-B would scale the whole L=A+B+C. Both tests
 * therefore capture pre-mutation ownership and mutate through the real
 * Foundation boundary every tool/controller mutation funnels through
 * (`#before` → captureGeometryOwnershipForIds, as in the foundation specs)
 * while mounted, then notify the mounted surface of THOSE
 * ids through the narrow `handle.notifyCanonicalMutationForTests` seam
 * (mutation-notify only: controller index sync — which runs the single
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
 * Rapid fixture: L=A+B+C (bands 0/2000/4000), M=D (8000), N=E (12000).
 * B moves L→M→N across the test; every band stays distinct so joint
 * membership is observable through shared packed identities.
 */
function rapidModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(60000, 6000));
  addChunk(model, 'L-A', 'L', 0, 0);
  addChunk(model, 'L-B', 'L', 1, 2000);
  addChunk(model, 'L-C', 'L', 2, 4000);
  addChunk(model, 'M-D', 'M', 0, 8000);
  addChunk(model, 'N-E', 'N', 0, 12000);
  return model;
}

/** Two-leaver fixture: L=A+B+C only; B→M and C→N found new logicals. */
function leaverModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(60000, 6000));
  addChunk(model, 'L-A', 'L', 0, 0);
  addChunk(model, 'L-B', 'L', 1, 2000);
  addChunk(model, 'L-C', 'L', 2, 4000);
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
 * itself. Single-id groups prove a lone survivor re-retained its own joint.
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

describe('mounted rapid replacement rendezvous', () => {
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

  it('rapid B:L→M→N before prepared ack re-retains L survivors, M, and N with no lost logical', async () => {
    restoreCanvas = installCanvasStub();
    // Install the DOM Worker mock BEFORE mounting: the production facility
    // constructs the Worker lazily on first background job, so the mock
    // must be in place when the queue drains — not at mount time.
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model = rapidModel();
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      // Mounted warm-up (real tool/history verb, BEFORE the replacements):
      // select-all + scale publishes every logical on the commit side; the
      // committed renderer prepares them and acknowledges the same keys; the
      // rendezvous schedules ONE joint Worker job per logical with no manual
      // scheduler call.
      handle.setSelection(['L-A', 'L-B', 'L-C', 'M-D', 'N-E']);
      const scaled = handle.scaleSelection(1.5);
      expect([...scaled].sort()).toEqual(['L-A', 'L-B', 'L-C', 'M-D', 'N-E']);
      await drainUntilAllGroups(model, [
        ['L-A', 'L-B', 'L-C'],
        ['M-D'],
        ['N-E'],
      ]);
      const oldJointL = jointOf(model, 'L-A');
      const oldJointM = jointOf(model, 'M-D');
      const oldJointN = jointOf(model, 'N-E');
      expect(oldJointL).toBeDefined();
      expect(jointOf(model, 'L-B')).toBe(oldJointL);
      expect(jointOf(model, 'L-C')).toBe(oldJointL);
      expect(oldJointM).toBeDefined();
      expect(oldJointN).toBeDefined();
      expect(bgpackRequests()).toHaveLength(3);
      expect(
        bgpackRequests()
          .map((request) => request.objectId)
          .sort(),
      ).toEqual(['L', 'M', 'N']);
      const rebuildsBefore = handle.diagnostics().scene.fullRebuilds;

      // Tripwires: any later scale/rotate/style verb would move these
      // canonical samples. Captured AFTER the warm-up, asserted unchanged
      // after the rapid re-packs to prove no masking mutation ran. B is
      // excluded: both replacements legitimately rewrite its samples.
      const survivorXBefore = new Map(
        ['L-A', 'M-D', 'N-E'].map((id) => [id, firstSampleX(model, id)]),
      );
      for (const x of survivorXBefore.values()) expect(x).not.toBeNull();

      // Rapid double move B:L→M→N, fully synchronous: each step is
      // capture→mutate→notify (single invalidation per mutation, owned by
      // the seam — never pre-invalidated), and the two notifies coalesce
      // into ONE render frame, so no prepared acknowledgement — and hence
      // no rendezvous consumption or Foundation ack — lands between them.
      // The post-mutation invalidation of each step runs inside its seam
      // call (mirroring `#synced` → `#indexMutated` →
      // `invalidateCompiledForIds`, exactly once per move).
      captureGeometryOwnershipForIds(model, ['L-B']);
      model.objects['L-B'] = inkStrokeObject('L-B', {
        points: chunkSamples(300, 6000),
        width: 3,
        logicalId: 'M',
        chunkIndex: 1,
      });
      handle.notifyCanonicalMutationForTests(['L-B']);

      captureGeometryOwnershipForIds(model, ['L-B']);
      model.objects['L-B'] = inkStrokeObject('L-B', {
        points: chunkSamples(300, 14000),
        width: 3,
        logicalId: 'N',
        chunkIndex: 1,
      });
      handle.notifyCanonicalMutationForTests(['L-B']);

      // Link 1 — multi-set probe (synchronous: no frame has run, so no
      // rendezvous consumption or ack could have retired anything): BOTH
      // historiques survive alongside the current unit, oldest first. A
      // single-tombstone design reads ['l:M','l:N'] here — L overwritten by
      // the intermediate M — and the survivor below never re-packs.
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:L',
        'l:M',
        'l:N',
      ]);

      // Link 2 — the seam invalidations cleared every affected joint
      // (synchronous: no frame has run yet, so no fresh joint can exist).
      for (const id of ['L-A', 'L-B', 'L-C', 'M-D', 'N-E']) {
        expect(jointOf(model, id)).toBeUndefined();
      }

      const jobsBefore = backgroundPackStats.jobsQueued;
      const workerJobsBefore = backgroundPackStats.workerJobs;
      const requestsBefore = bgpackRequests().length;

      // Links 3-5 — WITHOUT any manual scheduler call and WITHOUT any
      // further geometry mutation, the mounted commit side
      // (`l:L,l:M,l:N`) meets the committed renderer's prepared
      // acknowledgement (same keys) and the background scheduler queues
      // all three logicals; the Worker completes; every unit re-retains.
      await drainUntilAllGroups(model, [
        ['L-A', 'L-C'],
        ['M-D'],
        ['N-E', 'L-B'],
      ]);
      const freshL = jointOf(model, 'L-A');
      expect(freshL).toBeDefined();
      expect(freshL).not.toBe(oldJointL);
      expect(jointOf(model, 'L-C')).toBe(freshL);
      const freshM = jointOf(model, 'M-D');
      expect(freshM).toBeDefined();
      expect(freshM).not.toBe(oldJointM);
      const freshN = jointOf(model, 'N-E');
      expect(freshN).toBeDefined();
      expect(freshN).not.toBe(oldJointN);
      expect(jointOf(model, 'L-B')).toBe(freshN);

      // No lost logical: exactly one new joint job per unit — L survivors,
      // intermediate M back to D-only, current N as E+B — queued by the
      // mounted rendezvous from the rapid publication, not by this test.
      expect(backgroundPackStats.jobsQueued - jobsBefore).toBe(3);
      expect(backgroundPackStats.workerJobs - workerJobsBefore).toBe(3);
      const newRequests = bgpackRequests().slice(requestsBefore);
      expect(newRequests).toHaveLength(3);
      expect(newRequests.map((request) => request.objectId).sort()).toEqual([
        'L',
        'M',
        'N',
      ]);

      // Prepared ownership (probe): L is A+C, M is D-only, N is E+B.
      expect(preparedMemberIds(model, 'L')).toEqual(['L-A', 'L-C']);
      expect(preparedMemberIds(model, 'M')).toEqual(['M-D']);
      expect(preparedMemberIds(model, 'N')).toEqual(['L-B', 'N-E']);

      // No duplicate B: B is represented once, only in its new owner. No
      // Worker job ever addressed B as a single, and B's joint is N's joint
      // alone (neither L's nor M's).
      expect(
        bgpackRequests().some((request) => request.objectId === 'L-B'),
      ).toBe(false);
      expect(jointOf(model, 'L-B')).toBe(freshN);
      expect(jointOf(model, 'L-B')).not.toBe(freshL);
      expect(jointOf(model, 'L-B')).not.toBe(freshM);

      // Incremental retirement through the mounted rendezvous: both
      // historiques (L and M) retired when their survivor publications
      // crossed; only the current unit key remains.
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:N',
      ]);

      // Prepared-scene ownership (public diagnostics only): the single
      // coalesced frame recompiled exactly the previous key (L) and the
      // current key (N) — never a full rebuild. The transient intermediate
      // (B in M) was never prepared, so M owes no scene invalidation and
      // stays D-only by reuse while still re-packing from canonical truth.
      const scene = handle.diagnostics().scene;
      expect(scene.newlyCompiledObjects).toBe(2);
      expect(scene.fullRebuilds).toBe(rebuildsBefore);

      // No masking mutation ran: survivor canonical geometry is untouched
      // since the warm-up, and order is exactly the replaced model.
      for (const [id, x] of survivorXBefore) {
        expect(firstSampleX(model, id)).toBe(x);
      }
      expect([...model.order].sort()).toEqual([
        'L-A',
        'L-B',
        'L-C',
        'M-D',
        'N-E',
      ]);

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

  it('two records leaving L share l:L once and keep it until the survivor rendezvous', async () => {
    restoreCanvas = installCanvasStub();
    prevWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    prevWorker = (globalThis as Record<string, unknown>).Worker;
    (globalThis as Record<string, unknown>).Worker =
      FakeDomWorker as unknown as typeof Worker;

    const model = leaverModel();
    const { skeleton, cleanup } = makeHost();
    const handle = mountInkSurface({
      model,
      markDirty: () => undefined,
      host: skeleton,
    });
    try {
      // Same mounted warm-up (BEFORE the leavings): real verb retains the
      // initial L joint through the rendezvous (no manual scheduler).
      handle.setSelection(['L-A', 'L-B', 'L-C']);
      handle.scaleSelection(1.5);
      await drainUntilAllGroups(model, [['L-A', 'L-B', 'L-C']]);
      const oldJointL = jointOf(model, 'L-A');
      expect(oldJointL).toBeDefined();
      expect(jointOf(model, 'L-B')).toBe(oldJointL);
      expect(jointOf(model, 'L-C')).toBe(oldJointL);
      expect(bgpackRequests()).toHaveLength(1);
      expect(bgpackRequests()[0]?.objectId).toBe('L');
      const rebuildsBefore = handle.diagnostics().scene.fullRebuilds;

      const survivorXBefore = firstSampleX(model, 'L-A');
      expect(survivorXBefore).not.toBeNull();

      // Two records leave L synchronously — B:L→M, C:L→N — each as
      // capture→mutate→notify with no frame/ack between the publications.
      captureGeometryOwnershipForIds(model, ['L-B']);
      model.objects['L-B'] = inkStrokeObject('L-B', {
        points: chunkSamples(300, 6000),
        width: 3,
        logicalId: 'M',
        chunkIndex: 0,
      });
      handle.notifyCanonicalMutationForTests(['L-B']);

      captureGeometryOwnershipForIds(model, ['L-C']);
      model.objects['L-C'] = inkStrokeObject('L-C', {
        points: chunkSamples(300, 14000),
        width: 3,
        logicalId: 'N',
        chunkIndex: 0,
      });
      handle.notifyCanonicalMutationForTests(['L-C']);

      // Each leaver keeps its own pending {L} plus its current unit (sync:
      // no consumption yet, so no premature per-record retirement), and the
      // joint query dedups the shared L exactly once alongside both
      // currents.
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:L',
        'l:M',
      ]);
      expect(backgroundPackRendezvousKeysForIds(model, ['L-C'])).toEqual([
        'l:L',
        'l:N',
      ]);
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B', 'L-C'])).toEqual(
        ['l:L', 'l:M', 'l:N'],
      );

      // The seam invalidations cleared every affected joint synchronously.
      for (const id of ['L-A', 'L-B', 'L-C']) {
        expect(jointOf(model, id)).toBeUndefined();
      }

      const jobsBefore = backgroundPackStats.jobsQueued;
      const workerJobsBefore = backgroundPackStats.workerJobs;
      const requestsBefore = bgpackRequests().length;

      // WITHOUT any manual scheduler call, the mounted rendezvous queues
      // all three units; the Worker completes; the lone L survivor (A)
      // re-retains alongside the two founders. L stays pending until THIS
      // survivor publication succeeds.
      await drainUntilAllGroups(model, [['L-A'], ['L-B'], ['L-C']]);
      const freshA = jointOf(model, 'L-A');
      const freshB = jointOf(model, 'L-B');
      const freshC = jointOf(model, 'L-C');
      expect(freshA).toBeDefined();
      expect(freshB).toBeDefined();
      expect(freshC).toBeDefined();
      expect(freshA).not.toBe(oldJointL);
      expect(freshB).not.toBe(oldJointL);
      expect(freshC).not.toBe(oldJointL);
      // Three distinct owners now — no chunk shared, no logical merged.
      expect(new Set([freshA, freshB, freshC]).size).toBe(3);

      // No lost logical: exactly one new joint job per unit.
      expect(backgroundPackStats.jobsQueued - jobsBefore).toBe(3);
      expect(backgroundPackStats.workerJobs - workerJobsBefore).toBe(3);
      const newRequests = bgpackRequests().slice(requestsBefore);
      expect(newRequests).toHaveLength(3);
      expect(newRequests.map((request) => request.objectId).sort()).toEqual([
        'L',
        'M',
        'N',
      ]);

      // Prepared ownership (probe): L is A alone, M is B alone, N is C
      // alone — neither leaver lingers in its old owner.
      expect(preparedMemberIds(model, 'L')).toEqual(['L-A']);
      expect(preparedMemberIds(model, 'M')).toEqual(['L-B']);
      expect(preparedMemberIds(model, 'N')).toEqual(['L-C']);
      expect(
        bgpackRequests().some(
          (request) => request.objectId === 'L-B' || request.objectId === 'L-C',
        ),
      ).toBe(false);

      // Shared-logical retirement through the mounted rendezvous: after A's
      // survivor succeeds, BOTH holders retire L at once (satisfied
      // together), while their own currents remain.
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B'])).toEqual([
        'l:M',
      ]);
      expect(backgroundPackRendezvousKeysForIds(model, ['L-C'])).toEqual([
        'l:N',
      ]);
      expect(backgroundPackRendezvousKeysForIds(model, ['L-B', 'L-C'])).toEqual(
        ['l:M', 'l:N'],
      );

      // Prepared-scene ownership (public diagnostics only): the
      // coalesced frame recompiled the previous key (L) plus both current
      // keys (M, N) — never a full rebuild.
      const scene = handle.diagnostics().scene;
      expect(scene.newlyCompiledObjects).toBe(3);
      expect(scene.fullRebuilds).toBe(rebuildsBefore);

      // No masking mutation ran: the survivor's canonical geometry is
      // untouched since the warm-up.
      expect(firstSampleX(model, 'L-A')).toBe(survivorXBefore);
      expect([...model.order].sort()).toEqual(['L-A', 'L-B', 'L-C']);

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
