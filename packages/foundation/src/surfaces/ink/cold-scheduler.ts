/**
 * Background cold Ink compilation scheduler.
 *
 * One bounded compilation lane: at most one active job, FIFO queue,
 * priority-reorderable, with generation-based staleness so an
 * old worker result can never overwrite newer derived state:
 *
 * ```text
 * cold open / progressive preparation
 *     ↓
 * ColdInkCompileScheduler (priority queue, 1 active)
 *     ↓
 * Worker (same compileInkStroke implementation, no fork)
 *     ↓
 * rehydrated derived geometry (verbatim nodes/polygon/bounds/mesh)
 * ```
 *
 * Live writing never enters this scheduler (main-thread incremental
 * compiler only). When no worker is available (unsupported platform,
 * construction failure, worker error), jobs run through the cooperative
 * main-thread async compiler instead — progressive across phases, never
 * a silent break of file opening. Cancellation never needs to interrupt
 * the worker: stale responses are discarded by request id + generation,
 * and queued jobs that have not started are removable.
 *
 * Headless and DOM-free: the worker is constructed through the injected
 * `createWorker` factory (hosts supply `new Worker(new URL(...))`;
 * tests inject fakes). Never throws: results are status-tagged.
 */

import type { InkBrushSpec } from './brush.js';
import type { InkSample } from '../model.js';
import type { CompiledInkStroke, InkGeometryOptions } from './compiler.js';
import { compileInkStrokeAsync, type InkYieldFn } from './async-compiler.js';
import {
  packInkSamples,
  packedRequestTransfer,
  type PackedCompiledInk,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from './packed-protocol.js';

/**
 * Minimal worker surface the scheduler drives (DOM `Worker` satisfies it).
 * Packed buffers transfer ownership via the second `postMessage` argument
 * instead of deep-cloning — no `samples: [...samples]` copies.
 */
export interface ColdCompileWorker {
  postMessage(
    message: PackedInkCompileRequest,
    transfer?: readonly ArrayBuffer[],
  ): void;
  onmessage: ((event: { data: PackedInkCompileResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

export interface ColdCompileJobInput {
  /** Surface object id under compilation (queue identity + priority). */
  readonly objectId: string;
  /** Caller model generation at enqueue (staleness guard). */
  readonly generation: number;
  /** Canonical stroke samples (cloned across the worker boundary). */
  readonly samples: readonly InkSample[];
  /** Resolved brush (plain data). */
  readonly brush: InkBrushSpec;
  /** Geometry overrides; absent means defaults. */
  readonly options?: InkGeometryOptions;
}

export type ColdCompileResult =
  | {
      readonly status: 'ready';
      /**
       * Rich compiled geometry (fallback main-thread compiles only).
       * Worker results stay packed (no `unpackCompiledInk` on the main
       * thread — committed rendering consumes `packed` directly).
       */
      readonly compiled: CompiledInkStroke | undefined;
      /**
       * Retained packed worker output when available: the SAME typed-array
       * representation persistence stores and packed rendering consumes, so
       * warm records never repack identical geometry (fallback results carry
       * none — background packing retains them later).
       */
      readonly packed: PackedCompiledInk | undefined;
      /** True when the main-thread fallback compiled this job. */
      readonly fallback: boolean;
      /** Worker-side compile time (0 for fallback). */
      readonly workerMs: number;
      /** Main-thread result-integration time (0 for packed-direct Worker). */
      readonly integrationMs: number;
      /** Main-side sample-pack time (0 for fallback). */
      readonly packMs: number;
      /** Packed input bytes transferred (0 for fallback). */
      readonly inputBytes: number;
      /** Packed output bytes received (0 for fallback). */
      readonly outputBytes: number;
    }
  | { readonly status: 'stale' }
  | { readonly status: 'failed'; readonly error: string };

export interface ColdSchedulerStats {
  /** Jobs currently queued (not started). */
  queued: number;
  /** Jobs started (0 or 1 by construction). */
  started: number;
  /** Jobs completed with usable geometry (worker + fallback). */
  completed: number;
  /** Responses discarded as stale (never installed). */
  discardedStale: number;
  /** Jobs that failed outright (worker error with no fallback recovery). */
  failed: number;
  /** Jobs compiled on the main-thread fallback path. */
  fallbacks: number;
  /** Total worker-side compile milliseconds. */
  workerMsTotal: number;
  /** Total main-thread integration (unpack) milliseconds. */
  integrationMsTotal: number;
  /** Total main-side sample-pack milliseconds (`workerPackMs`). */
  packMsTotal: number;
  /** Total packed input bytes transferred (`workerInputBytes`). */
  inputBytesTotal: number;
  /** Total packed output bytes received (`workerOutputBytes`). */
  outputBytesTotal: number;
  /** Total worker-side unpack milliseconds (`workerUnpackMs`). */
  workerUnpackMsTotal: number;
  /** Total spine nodes unpacked into JS object graphs (worker results). */
  outputNodesTotal: number;
  /** Total polygon/outline vertices unpacked (worker results). */
  outputVerticesTotal: number;
  /** Queue priority reorderings applied. */
  reorders: number;
}

export interface ColdSchedulerOptions {
  /**
   * Construct the compilation worker, or return null when workers are
   * unavailable. Called lazily on the first compile (never at
   * construction), at most once per scheduler lifetime. Throwing counts
   * as unavailable — the scheduler falls back permanently.
   */
  readonly createWorker?: () => ColdCompileWorker | null;
  /** Yield function for the main-thread fallback compiler. */
  readonly fallbackYield?: InkYieldFn;
  /** Clock for durations; defaults to `performance.now`/`Date.now`. */
  readonly now?: () => number;
}

interface QueuedJob extends ColdCompileJobInput {
  readonly requestId: string;
  readonly resolve: (result: ColdCompileResult) => void;
  /** Set when the job reaches any terminal state (guards worker/fallback races). */
  settled: boolean;
  /** Main-side pack cost for this job's request (diagnostics). */
  packMs: number;
  /** Packed input bytes for this job's request (diagnostics). */
  inputBytes: number;
}

const clock = (now?: () => number): (() => number) => {
  if (now !== undefined) return now;
  try {
    const perf = (globalThis as unknown as { performance?: { now(): number } })
      .performance;
    if (perf !== undefined && typeof perf.now === 'function') {
      return () => perf.now();
    }
  } catch {
    // Fall through to Date.now.
  }
  return () => Date.now();
};

let requestCounter = 0;

export class ColdInkCompileScheduler {
  readonly #createWorker: (() => ColdCompileWorker | null) | null;
  readonly #fallbackYield: InkYieldFn | undefined;
  readonly #now: () => number;
  #worker: ColdCompileWorker | null = null;
  #workerRequested = false;
  #workerDead = false;
  #disposed = false;
  #queue: QueuedJob[] = [];
  #active: QueuedJob | null = null;
  /** Highest generation seen per object (older responses are stale). */
  #maxGeneration = new Map<string, number>();
  /** In-flight/queued request ids cancelled before completion. */
  #deadRequests = new Set<string>();
  #stats: ColdSchedulerStats = {
    queued: 0,
    started: 0,
    completed: 0,
    discardedStale: 0,
    failed: 0,
    fallbacks: 0,
    workerMsTotal: 0,
    integrationMsTotal: 0,
    packMsTotal: 0,
    inputBytesTotal: 0,
    outputBytesTotal: 0,
    workerUnpackMsTotal: 0,
    outputNodesTotal: 0,
    outputVerticesTotal: 0,
    reorders: 0,
  };

  constructor(options: ColdSchedulerOptions = {}) {
    this.#createWorker = options.createWorker ?? null;
    this.#fallbackYield = options.fallbackYield;
    this.#now = clock(options.now);
  }

  statsSnapshot(): ColdSchedulerStats {
    return {
      ...this.#stats,
      queued: this.#queue.length,
      started: this.#active === null ? 0 : 1,
    };
  }

  get pendingCount(): number {
    return this.#queue.length + (this.#active === null ? 0 : 1);
  }

  /**
   * Enqueue one cold compile. Resolves `ready` with geometry, `stale`
   * when a newer generation, cancellation, or dispose superseded it, or
   * `failed` when neither worker nor fallback could compile it.
   */
  compile(job: ColdCompileJobInput): Promise<ColdCompileResult> {
    if (this.#disposed) return Promise.resolve({ status: 'stale' });
    const seen = this.#maxGeneration.get(job.objectId);
    if (seen === undefined || job.generation > seen) {
      this.#maxGeneration.set(job.objectId, job.generation);
    }
    requestCounter += 1;
    let resolve!: (result: ColdCompileResult) => void;
    const promise = new Promise<ColdCompileResult>((accept) => {
      resolve = accept;
    });
    this.#queue.push({
      ...job,
      requestId: `cold-${requestCounter}`,
      resolve,
      settled: false,
      packMs: 0,
      inputBytes: 0,
    });
    this.#pump();
    return promise;
  }

  /** Object ids currently queued (not active), in queue order. */
  queuedObjectIds(): readonly string[] {
    return this.#queue.map((job) => job.objectId);
  }

  /**
   * Re-prioritize queued (not active) jobs: jobs whose object id appears
   * earlier in `priorityIds` compile first; unlisted jobs keep stable
   * order at the back. Already-compiled geometry is never discarded.
   */
  reorderQueue(priorityIds: readonly string[]): void {
    if (this.#queue.length < 2) return;
    const rank = new Map<string, number>();
    for (let i = 0; i < priorityIds.length; i++) {
      if (!rank.has(priorityIds[i]!)) rank.set(priorityIds[i]!, i);
    }
    const back = priorityIds.length;
    this.#queue = this.#queue
      .map((job, index) => ({ job, index }))
      .sort((a, b) => {
        // Listed jobs first in priority order; unlisted jobs keep their
        // relative order behind all listed ones (stable).
        const ka = rank.get(a.job.objectId) ?? back + a.index;
        const kb = rank.get(b.job.objectId) ?? back + b.index;
        return ka - kb;
      })
      .map(({ job }) => job);
    this.#stats.reorders += 1;
  }

  /**
   * Drop queued jobs for `ids` and discard their in-flight responses on
   * arrival (edits, deletes, document close). Already-installed geometry
   * is the caller's to invalidate through the normal derived paths.
   */
  cancelForObjects(ids: readonly string[]): void {
    if (ids.length === 0) return;
    if (this.#queue.length === 0 && this.#active === null) return;
    const doomed = new Set(ids);
    const kept: QueuedJob[] = [];
    for (const job of this.#queue) {
      if (doomed.has(job.objectId)) {
        this.#deadRequests.add(job.requestId);
        job.settled = true;
        job.resolve({ status: 'stale' });
        this.#stats.discardedStale += 1;
      } else {
        kept.push(job);
      }
    }
    this.#queue = kept;
    if (this.#active !== null && doomed.has(this.#active.objectId)) {
      this.#deadRequests.add(this.#active.requestId);
    }
  }

  /** Terminate the worker and settle everything pending as stale. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const job of this.#queue) {
      this.#deadRequests.add(job.requestId);
      job.settled = true;
      job.resolve({ status: 'stale' });
    }
    this.#queue = [];
    if (this.#active !== null) {
      this.#deadRequests.add(this.#active.requestId);
      this.#active.settled = true;
      this.#active.resolve({ status: 'stale' });
      this.#active = null;
    }
    try {
      this.#worker?.terminate();
    } catch {
      // Termination never throws.
    }
    this.#worker = null;
  }

  #ensureWorker(): ColdCompileWorker | null {
    if (this.#worker !== null || this.#workerDead || this.#disposed) {
      return this.#worker;
    }
    if (this.#createWorker === null) {
      this.#workerDead = true;
      return null;
    }
    if (this.#workerRequested) return null;
    this.#workerRequested = true;
    try {
      const worker = this.#createWorker();
      if (worker === null || worker === undefined) {
        this.#workerDead = true;
        return null;
      }
      worker.onmessage = (event) => this.#onResponse(event.data);
      worker.onerror = () => this.#onWorkerError();
      this.#worker = worker;
      return worker;
    } catch {
      this.#workerDead = true;
      return null;
    }
  }

  #pump(): void {
    if (this.#disposed || this.#active !== null) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    if (this.#deadRequests.has(next.requestId)) {
      // Cancelled while queued (already resolved stale at cancel time):
      // drop without settling again and continue pumping.
      this.#deadRequests.delete(next.requestId);
      this.#pump();
      return;
    }
    this.#active = next;
    const worker = this.#ensureWorker();
    if (worker === null) {
      void this.#runFallback(next);
      return;
    }
    // Packed transferable input: typed arrays transfer ownership to the
    // worker (no `samples: [...samples]` copy, no object-graph clone).
    let request: PackedInkCompileRequest;
    try {
      const packStart = this.#now();
      const { packed, bytes } = packInkSamples(next.samples);
      const packMs = this.#now() - packStart;
      this.#stats.packMsTotal += packMs;
      this.#stats.inputBytesTotal += bytes;
      next.packMs = packMs;
      next.inputBytes = bytes;
      request = {
        type: 'compile-ink',
        requestId: next.requestId,
        objectId: next.objectId,
        generation: next.generation,
        samples: packed,
        brush: { ...next.brush } as InkBrushSpec,
        ...(next.options !== undefined ? { options: { ...next.options } } : {}),
        packMs,
        inputBytes: bytes,
      };
    } catch (error) {
      // Unpackable input (non-finite positions) fails over to the
      // cooperative fallback instead of wedging the queue.
      this.#runFallback(next, error);
      return;
    }
    try {
      worker.postMessage(request, packedRequestTransfer(request));
    } catch (error) {
      // Unserializable input (non-plain extras) or a dead port: fail this
      // job over to the fallback instead of wedging the queue.
      this.#runFallback(next, error);
    }
  }

  #isStale(job: QueuedJob): boolean {
    if (this.#deadRequests.has(job.requestId)) {
      this.#deadRequests.delete(job.requestId);
      return true;
    }
    const seen = this.#maxGeneration.get(job.objectId);
    if (seen !== undefined && job.generation < seen) return true;
    return this.#disposed;
  }

  #onResponse(response: PackedInkCompileResponse): void {
    const active = this.#active;
    if (
      active === null ||
      active.settled ||
      response.requestId !== active.requestId
    ) {
      // Unknown, already-settled, or superseded response: never installs.
      this.#stats.discardedStale += 1;
      return;
    }
    if (this.#isStale(active)) {
      active.settled = true;
      this.#active = null;
      active.resolve({ status: 'stale' });
      this.#stats.discardedStale += 1;
      this.#pump();
      return;
    }
    if (response.type === 'compile-error') {
      // One bad stroke must not wedge the queue: fail it over to the
      // cooperative fallback (identical math, main thread). Settles there.
      this.#runFallback(active, new Error(response.error));
      return;
    }
    // Packed-direct Worker integration (closure pass): cold Worker output
    // stays in typed-array form through committed rendering — NO
    // `unpackCompiledInk` into `SerializedInkNode`/`Point` object graphs on
    // the main thread (eliminates the ~5–10 ms per-stroke unpack cost and
    // the ~80 ms giant-stroke spike). Validation is structural (counts,
    // lengths) without materializing geometry; corrupt payloads fall back.
    try {
      const packed = response.compiled;
      if (
        packed.nodeCount < 0 ||
        !(packed.polygonXY instanceof Float64Array) ||
        !(packed.boundsXYWH instanceof Float64Array) ||
        packed.boundsXYWH.length !== 4
      ) {
        throw new Error('packed worker payload failed structural check');
      }
      active.settled = true;
      this.#active = null;
      this.#stats.completed += 1;
      this.#stats.workerMsTotal += response.compileMs;
      this.#stats.integrationMsTotal += 0;
      this.#stats.outputBytesTotal += response.outputBytes;
      this.#stats.workerUnpackMsTotal += response.workerUnpackMs;
      // Integration instrumentation: packed nodes/vertices received (no
      // object-graph materialization on the main thread).
      this.#stats.outputNodesTotal += packed.nodeCount;
      this.#stats.outputVerticesTotal +=
        packed.polygonXY.length / 2 +
        packed.meshLeftXY.length / 2 +
        packed.meshRightXY.length / 2 +
        packed.meshRingXY.length / 2;
      active.resolve({
        status: 'ready',
        compiled: undefined,
        packed,
        fallback: false,
        workerMs: response.compileMs,
        integrationMs: 0,
        packMs: active.packMs,
        inputBytes: active.inputBytes,
        outputBytes: response.outputBytes,
      });
    } catch (error) {
      this.#runFallback(
        active,
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }
    this.#pump();
  }

  #onWorkerError(): void {
    // The worker itself is broken: terminate, fall back permanently, and
    // requeue the active job through the fallback (queued jobs follow).
    try {
      this.#worker?.terminate();
    } catch {
      // Termination never throws.
    }
    this.#worker = null;
    this.#workerDead = true;
    const active = this.#active;
    this.#active = null;
    if (active !== null && !active.settled) {
      if (this.#isStale(active)) {
        active.settled = true;
        active.resolve({ status: 'stale' });
        this.#stats.discardedStale += 1;
      } else {
        void this.#runFallback(active, new Error('ink worker error'));
        return;
      }
    }
    this.#pump();
  }

  async #runFallback(job: QueuedJob, cause?: unknown): Promise<void> {
    if (job.settled || this.#isStale(job)) {
      this.#active = null;
      if (!job.settled) {
        job.settled = true;
        job.resolve({ status: 'stale' });
        this.#stats.discardedStale += 1;
      }
      this.#pump();
      return;
    }
    this.#stats.fallbacks += 1;
    try {
      const compiled = await compileInkStrokeAsync(
        job.samples,
        job.brush,
        job.options ?? {},
        this.#fallbackYield,
      );
      if (job.settled || this.#isStale(job)) {
        this.#active = null;
        if (!job.settled) {
          job.settled = true;
          job.resolve({ status: 'stale' });
          this.#stats.discardedStale += 1;
        }
      } else {
        this.#active = null;
        job.settled = true;
        this.#stats.completed += 1;
        job.resolve({
          status: 'ready',
          compiled,
          packed: undefined,
          fallback: true,
          workerMs: 0,
          integrationMs: 0,
          packMs: 0,
          inputBytes: 0,
          outputBytes: 0,
        });
      }
    } catch (error) {
      this.#active = null;
      if (!job.settled) {
        job.settled = true;
        this.#stats.failed += 1;
        job.resolve({
          status: 'failed',
          error:
            error instanceof Error
              ? error.message
              : cause instanceof Error
                ? cause.message
                : String(cause ?? error),
        });
      }
    }
    this.#pump();
  }
}
