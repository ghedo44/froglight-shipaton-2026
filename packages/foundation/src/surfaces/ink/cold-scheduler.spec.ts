/**
 * Cold-compile scheduler tests.
 *
 * The fake worker below runs the SAME `compileInkStroke` implementation
 * across a real `structuredClone` boundary, so the parity test exercises
 * the exact serialization contract the production worker uses — only the
 * thread hop itself is faked (deterministic, no wall-clock assertions).
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  packCompiledInk,
  unpackCompiledInk,
  unpackInkSamples,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
} from './packed-protocol.js';
import {
  ColdInkCompileScheduler,
  type ColdCompileWorker,
} from './cold-scheduler.js';
import { longStroke, sharpCorner } from './fixtures.js';
import type { InkSample } from '../model.js';

/**
 * Deterministic fake worker: real compile across a packed clone
 * boundary, mirroring the production worker (unpack → same
 * `compileInkStroke` → pack). Only the thread hop itself is faked.
 */
function fakeWorker(options: { failIds?: Set<string>; hang?: boolean } = {}): {
  worker: ColdCompileWorker;
  sent: PackedInkCompileRequest[];
  transfers: number[];
} {
  const sent: PackedInkCompileRequest[] = [];
  const transfers: number[] = [];
  let target: ColdCompileWorker | null = null;
  const worker: ColdCompileWorker = {
    postMessage(
      message: PackedInkCompileRequest,
      transfer?: readonly ArrayBuffer[],
    ) {
      transfers.push(transfer?.length ?? 0);
      sent.push(structuredClone(message));
      if (options.hang === true) return;
      const request = structuredClone(message);
      queueMicrotask(() => {
        if (target!.onmessage === null) return;
        if (options.failIds?.has(request.requestId) === true) {
          target!.onmessage({
            data: {
              type: 'compile-error',
              requestId: request.requestId,
              objectId: request.objectId,
              generation: request.generation,
              error: 'injected failure',
            },
          });
          return;
        }
        const start = Date.now();
        const compiled = compileInkStroke(
          unpackInkSamples(request.samples),
          request.brush,
          request.options ?? {},
        );
        const compileMs = Date.now() - start;
        const { packed, bytes } = packCompiledInk(compiled);
        target!.onmessage({
          data: structuredClone({
            type: 'compiled-ink',
            requestId: request.requestId,
            objectId: request.objectId,
            generation: request.generation,
            compiled: packed,
            workerUnpackMs: 0,
            compileMs,
            packMs: 0,
            outputBytes: bytes,
          }) as PackedInkCompileResponse,
        });
      });
    },
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
  };
  target = worker;
  return { worker, sent, transfers };
}

function samples(count = 300): InkSample[] {
  return longStroke(count);
}

/**
 * Parity comparison with absolute tolerance: packed transport carries
 * pressure/tilt/twist as Float32 (measured ≤3e-8 deviation end to end),
 * so every finite number must agree within 1e-6 while structure matches
 * exactly. Positions/timing are Float64 bit-exact underneath.
 */
const PARITY_TOLERANCE = 1e-6;

function expectParityClose(
  received: unknown,
  expected: unknown,
  path = '$',
): void {
  if (typeof received === 'number' && typeof expected === 'number') {
    if (Number.isNaN(received) && Number.isNaN(expected)) return;
    expect(
      Math.abs(received - expected),
      `${path}: ${String(received)} vs ${String(expected)}`,
    ).toBeLessThanOrEqual(PARITY_TOLERANCE);
    return;
  }
  if (Array.isArray(received) || Array.isArray(expected)) {
    expect(Array.isArray(received) && Array.isArray(expected), path).toBe(true);
    const a = received as unknown[];
    const b = expected as unknown[];
    expect(a.length, `${path}.length`).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expectParityClose(a[i], b[i], `${path}[${i}]`);
    }
    return;
  }
  if (
    typeof received === 'object' &&
    received !== null &&
    typeof expected === 'object' &&
    expected !== null
  ) {
    const a = received as Record<string, unknown>;
    const b = expected as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (key) => typeof a[key] !== 'function' && typeof b[key] !== 'function',
    );
    for (const key of keys) {
      expectParityClose(a[key], b[key], `${path}.${key}`);
    }
    return;
  }
  expect(received, path).toEqual(expected);
}

/**
 * Manually-released fake worker: the test decides exactly when each
 * posted request answers (and with what), deterministically driving
 * queue/staleness interleavings no timer could.
 */
function manualWorker(): {
  worker: ColdCompileWorker;
  posted: () => PackedInkCompileRequest[];
  respond: (index: number) => void;
  failActive: () => void;
} {
  const posted: PackedInkCompileRequest[] = [];
  const holders: Array<() => void> = [];
  const failers: Array<() => void> = [];
  let target: ColdCompileWorker | null = null;
  const worker: ColdCompileWorker = {
    postMessage(message: PackedInkCompileRequest) {
      const request = structuredClone(message);
      posted.push(request);
      holders.push(() => {
        const compiled = compileInkStroke(
          unpackInkSamples(request.samples),
          request.brush,
          request.options ?? {},
        );
        const { packed, bytes } = packCompiledInk(compiled);
        target!.onmessage?.({
          data: structuredClone({
            type: 'compiled-ink',
            requestId: request.requestId,
            objectId: request.objectId,
            generation: request.generation,
            compiled: packed,
            workerUnpackMs: 0,
            compileMs: 1,
            packMs: 0,
            outputBytes: bytes,
          }) as PackedInkCompileResponse,
        });
      });
      failers.push(() => {
        target!.onmessage?.({
          data: {
            type: 'compile-error',
            requestId: request.requestId,
            objectId: request.objectId,
            generation: request.generation,
            error: 'injected failure',
          },
        });
      });
    },
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
  };
  target = worker;
  return {
    worker,
    posted: () => [...posted],
    respond: (index: number) => holders[index]?.(),
    failActive: () => failers[failers.length - 1]?.(),
  };
}

describe('worker parity (twin test)', () => {
  it('same stroke → sync compile ≡ worker-lane compile', async () => {
    const fake = fakeWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => fake.worker,
    });
    const input = samples();
    const sync = compileInkStroke(input, BALL_PEN_BRUSH);
    const result = await scheduler.compile({
      objectId: 's1',
      generation: 1,
      samples: input,
      brush: BALL_PEN_BRUSH,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.fallback).toBe(false);
    // Packed-direct Worker (closure pass): main thread never unpacks for
    // rendering — parity is verified here via an explicit test-only unpack.
    // `compiled` stays undefined on the worker lane by contract (see
    // `ColdCompileResult`); `packed` is required there.
    expect(result.compiled).toBeUndefined();
    expect(result.packed).toBeDefined();
    expect(result.integrationMs).toBe(0);
    if (result.packed === undefined) {
      throw new Error('worker ready result must carry packed geometry');
    }
    const unpacked = unpackCompiledInk(result.packed);
    expectParityClose(unpacked.nodes, sync.nodes, 'nodes');
    expectParityClose(unpacked.polygon, sync.polygon, 'polygon');
    expectParityClose(unpacked.bounds, sync.bounds, 'bounds');
    expectParityClose(unpacked.mesh.ring, sync.mesh.ring, 'ring');
    // Packed buffers actually transferred (never object graphs).
    expect(fake.transfers[0]).toBeGreaterThan(0);
    expect(result.inputBytes).toBeGreaterThan(0);
    expect(result.outputBytes).toBeGreaterThan(0);
    scheduler.dispose();
  });

  it('corner strokes survive the lane with identical run flags', async () => {
    const { worker } = fakeWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => worker,
    });
    const input = sharpCorner();
    const sync = compileInkStroke(input, BALL_PEN_BRUSH);
    const result = await scheduler.compile({
      objectId: 'corner',
      generation: 1,
      samples: input,
      brush: BALL_PEN_BRUSH,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.packed).toBeDefined();
    if (result.packed === undefined) {
      throw new Error('worker ready result must carry packed geometry');
    }
    const unpacked = unpackCompiledInk(result.packed);
    expect(unpacked.curve.segments.map((s) => s.startsRun === true)).toEqual(
      sync.curve.segments.map((s) => s.startsRun === true),
    );
    scheduler.dispose();
  });
});

describe('queue discipline', () => {
  it('runs one job at a time in FIFO order', async () => {
    const { worker, sent } = fakeWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => worker,
    });
    const order: string[] = [];
    const jobs = ['a', 'b', 'c'].map((id) =>
      scheduler
        .compile({
          objectId: id,
          generation: 1,
          samples: samples(60),
          brush: BALL_PEN_BRUSH,
        })
        .then((result) => {
          if (result.status === 'ready') order.push(id);
          return result;
        }),
    );
    // Only the head is active; the rest queue.
    expect(scheduler.pendingCount).toBe(3);
    const results = await Promise.all(jobs);
    expect(results.map((r) => r.status)).toEqual(['ready', 'ready', 'ready']);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(sent.map((s) => s.objectId)).toEqual(['a', 'b', 'c']);
    const stats = scheduler.statsSnapshot();
    expect(stats.completed).toBe(3);
    expect(stats.discardedStale).toBe(0);
    scheduler.dispose();
  });

  it('reorderQueue promotes visible jobs without dropping queued work', async () => {
    const manual = manualWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => manual.worker,
    });
    // The head starts immediately; the other two queue behind it.
    const results = ['off1', 'off2', 'visible'].map((id) =>
      scheduler.compile({
        objectId: id,
        generation: 1,
        samples: samples(40),
        brush: BALL_PEN_BRUSH,
      }),
    );
    expect(scheduler.queuedObjectIds()).toEqual(['off2', 'visible']);
    scheduler.reorderQueue(['visible']);
    expect(scheduler.queuedObjectIds()).toEqual(['visible', 'off2']);
    expect(scheduler.statsSnapshot().reorders).toBe(1);
    // Drain in the new order: head, then visible, then off2. Note the
    // responders index POST order (off1, visible, off2 after the reorder).
    manual.respond(0);
    await expect(results[0]).resolves.toMatchObject({ status: 'ready' });
    manual.respond(1);
    await expect(results[2]).resolves.toMatchObject({ status: 'ready' });
    manual.respond(2);
    await expect(results[1]).resolves.toMatchObject({ status: 'ready' });
    expect(manual.posted().map((r) => r.objectId)).toEqual([
      'off1',
      'visible',
      'off2',
    ]);
    scheduler.dispose();
  });
});

describe('staleness', () => {
  it('a newer generation discards the older in-flight response', async () => {
    const manual = manualWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => manual.worker,
    });
    const oldResult = scheduler.compile({
      objectId: 's',
      generation: 1,
      samples: samples(60),
      brush: BALL_PEN_BRUSH,
    });
    // A newer generation for the same object is enqueued (edit); the old
    // response must never install even though it arrives first.
    const newResult = scheduler.compile({
      objectId: 's',
      generation: 2,
      samples: samples(60),
      brush: BALL_PEN_BRUSH,
    });
    manual.respond(0);
    await expect(oldResult).resolves.toEqual({ status: 'stale' });
    // The pump advanced to the newer job on the stale settle.
    expect(manual.posted().map((r) => r.objectId)).toEqual(['s', 's']);
    manual.respond(1);
    const settled = await newResult;
    expect(settled.status).toBe('ready');
    const stats = scheduler.statsSnapshot();
    expect(stats.discardedStale).toBe(1);
    expect(stats.completed).toBe(1);
    scheduler.dispose();
  });

  it('cancelForObjects drops queued jobs for deleted objects', async () => {
    const gate = fakeWorker({ hang: true });
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => gate.worker,
    });
    const keep = scheduler.compile({
      objectId: 'keep',
      generation: 1,
      samples: samples(40),
      brush: BALL_PEN_BRUSH,
    });
    const doomed = scheduler.compile({
      objectId: 'gone',
      generation: 1,
      samples: samples(40),
      brush: BALL_PEN_BRUSH,
    });
    scheduler.cancelForObjects(['gone']);
    expect(await doomed).toEqual({ status: 'stale' });
    scheduler.dispose();
    expect(await keep).toEqual({ status: 'stale' });
  });

  it('dispose settles everything without hanging', async () => {
    const { worker } = fakeWorker({ hang: true });
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => worker,
    });
    const p1 = scheduler.compile({
      objectId: 'a',
      generation: 1,
      samples: samples(40),
      brush: BALL_PEN_BRUSH,
    });
    const p2 = scheduler.compile({
      objectId: 'b',
      generation: 1,
      samples: samples(40),
      brush: BALL_PEN_BRUSH,
    });
    scheduler.dispose();
    expect(await p1).toEqual({ status: 'stale' });
    expect(await p2).toEqual({ status: 'stale' });
    // Post-dispose compiles resolve stale immediately.
    expect(
      await scheduler.compile({
        objectId: 'c',
        generation: 1,
        samples: samples(40),
        brush: BALL_PEN_BRUSH,
      }),
    ).toEqual({ status: 'stale' });
  });
});

describe('scene integration', () => {
  function sceneModel() {
    const model = {
      formatVersion: 1 as const,
      frame: { kind: 'bounded' as const, width: 4000, height: 4000 },
      order: ['big'],
      objects: {
        big: {
          id: 'big',
          type: 'froglight.ink.stroke',
          points: longStroke(500).map((s) => ({ ...s })),
        },
      },
    };
    return model as unknown as import('../model.js').SurfaceModel;
  }

  it('prepareOneAsync installs worker geometry identical to the sync lane', async () => {
    const { createDefaultSurfaceObjectTypeRegistry } = await import(
      '../objects.js'
    );
    const { IncrementalSceneCache } = await import('../incremental-scene.js');
    const { unpackCompiledInk } = await import('./packed-protocol.js');
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const { worker } = fakeWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => worker,
    });
    // Sync lane reference (no scheduler, rich StrokeItem).
    const syncScene = new IncrementalSceneCache();
    const syncModel = sceneModel();
    await syncScene.prepareOneAsync(syncModel, registry, 'big');
    // Production `PreparedItem` elements directly: `update()` already
    // returns `readonly PreparedItem[]`, so no test-local structural cast
    // is needed — narrowing the `DrawItem` union below proves the kinds.
    const syncItems = syncScene.update(syncModel, registry, []);
    // Worker lane (packed-direct, PackedStrokeItem, no unpack on main).
    const scene = new IncrementalSceneCache();
    scene.setColdScheduler(scheduler);
    const model = sceneModel();
    expect(await scene.prepareOneAsync(model, registry, 'big')).toBe(true);
    const workerItems = scene.update(model, registry, []);
    const syncEntry = syncItems[0];
    const workerEntry = workerItems[0];
    expect(syncEntry).toBeDefined();
    expect(workerEntry).toBeDefined();
    if (syncEntry === undefined || workerEntry === undefined) {
      throw new Error('scene integration must prepare one item per lane');
    }
    expect(workerEntry.item.kind).toBe('packed-stroke');
    expect(syncEntry.item.kind).toBe('stroke');
    if (workerEntry.item.kind !== 'packed-stroke') {
      throw new Error('worker lane must produce a packed-stroke item');
    }
    if (syncEntry.item.kind !== 'stroke') {
      throw new Error('sync lane must produce a stroke item');
    }
    // Visual parity: packed polygonXY (verbatim compiler output) matches the
    // rich outline ring (same fill path, pixel-identical; Float32 pressure/
    // tilt quantization in transport allows ~1e-8, so assert 1e-6 like the
    // packed parity suites).
    const packedXY = workerEntry.item.packed.polygonXY;
    const outline = syncEntry.item.outline;
    expect(packedXY.length).toBe(outline.length * 2);
    for (let i = 0; i < outline.length; i++) {
      const point = outline[i];
      if (point === undefined) {
        throw new Error('outline point must exist');
      }
      expect(packedXY[i * 2]).toBeCloseTo(point.x, 6);
      expect(packedXY[i * 2 + 1]).toBeCloseTo(point.y, 6);
    }
    void unpackCompiledInk;
    expect(scheduler.statsSnapshot().fallbacks).toBe(0);
    expect(scheduler.statsSnapshot().completed).toBe(1);
    scheduler.dispose();
  });

  it('a mutation mid-flight discards the worker result (generation guard)', async () => {
    const { createDefaultSurfaceObjectTypeRegistry } = await import(
      '../objects.js'
    );
    const { IncrementalSceneCache } = await import('../incremental-scene.js');
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const manual = manualWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => manual.worker,
    });
    const scene = new IncrementalSceneCache();
    scene.setColdScheduler(scheduler);
    const model = sceneModel();
    const pending = scene.prepareOneAsync(model, registry, 'big');
    // Wait until the cold job is actually posted (dynamic imports first).
    for (let i = 0; i < 200 && manual.posted().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(manual.posted().length).toBe(1);
    // Content mutation while the worker compiles (bumps the generation).
    scene.update(model, registry, ['big']);
    manual.respond(0);
    expect(await pending).toBe(false);
    expect(scheduler.statsSnapshot().discardedStale).toBe(1);
    expect(scheduler.statsSnapshot().completed).toBe(0);
    scheduler.dispose();
  });

  it('a replaced record mid-flight discards the worker result (identity guard)', async () => {
    const { createDefaultSurfaceObjectTypeRegistry } = await import(
      '../objects.js'
    );
    const { IncrementalSceneCache } = await import('../incremental-scene.js');
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const manual = manualWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => manual.worker,
    });
    const scene = new IncrementalSceneCache();
    scene.setColdScheduler(scheduler);
    const model = sceneModel();
    const pending = scene.prepareOneAsync(model, registry, 'big');
    // Wait until the cold job is actually posted (dynamic imports first).
    for (let i = 0; i < 200 && manual.posted().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(manual.posted().length).toBe(1);
    // Swap the record object without touching the generation: the stale
    // geometry must not warm the NEW record's cache entry.
    model.objects['big'] = {
      ...(model.objects['big'] as object),
      id: 'big',
    } as never;
    manual.respond(0);
    expect(await pending).toBe(false);
    scheduler.dispose();
  });
});

describe('fallback', () => {
  it('compiles on the main thread when workers are unavailable', async () => {
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => null,
    });
    const input = samples(200);
    const sync = compileInkStroke(input, BALL_PEN_BRUSH);
    const result = await scheduler.compile({
      objectId: 's',
      generation: 1,
      samples: input,
      brush: BALL_PEN_BRUSH,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.fallback).toBe(true);
    // Main-thread fallback carries rich geometry (no packed); worker results
    // carry packed only. `ColdCompileResult` keeps `compiled` optional on
    // `ready` by contract, so narrow explicitly: fallback readiness
    // guarantees it here, but the type does not.
    expect(result.compiled).toBeDefined();
    expect(result.packed).toBeUndefined();
    if (result.compiled === undefined) {
      throw new Error('fallback ready result must carry compiled geometry');
    }
    expect(result.compiled.nodes).toEqual(sync.nodes);
    expect(scheduler.statsSnapshot().fallbacks).toBe(1);
    scheduler.dispose();
  });

  it('a throwing factory falls back permanently', async () => {
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => {
        throw new Error('no workers here');
      },
    });
    const first = await scheduler.compile({
      objectId: 'a',
      generation: 1,
      samples: samples(60),
      brush: BALL_PEN_BRUSH,
    });
    const second = await scheduler.compile({
      objectId: 'b',
      generation: 1,
      samples: samples(60),
      brush: BALL_PEN_BRUSH,
    });
    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    expect(scheduler.statsSnapshot().fallbacks).toBe(2);
    scheduler.dispose();
  });

  it('a worker error fails the active job over to the fallback', async () => {
    const manual = manualWorker();
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => manual.worker,
    });
    const pending = scheduler.compile({
      objectId: 's',
      generation: 1,
      samples: samples(120),
      brush: BALL_PEN_BRUSH,
    });
    // The active request errors on the worker lane: identical math runs
    // on the cooperative fallback instead of wedging the queue.
    manual.failActive();
    const result = await pending;
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.fallback).toBe(true);
    const sync = compileInkStroke(samples(120), BALL_PEN_BRUSH);
    // Fallback path carries rich geometry; `compiled` stays optional on the
    // `ready` contract (worker results carry `packed` only), so narrow
    // explicitly instead of asserting non-null.
    expect(result.compiled).toBeDefined();
    expect(result.packed).toBeUndefined();
    if (result.compiled === undefined) {
      throw new Error('fallback ready result must carry compiled geometry');
    }
    expect(result.compiled.nodes).toEqual(sync.nodes);
    scheduler.dispose();
  });

  it('worker onerror fails over permanently', async () => {
    const { worker } = fakeWorker({ hang: true });
    const scheduler = new ColdInkCompileScheduler({
      createWorker: () => worker,
    });
    const pending = scheduler.compile({
      objectId: 's',
      generation: 1,
      samples: samples(120),
      brush: BALL_PEN_BRUSH,
    });
    worker.onerror?.(new Error('boom'));
    const result = await pending;
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.fallback).toBe(true);
    const stats = scheduler.statsSnapshot();
    expect(stats.fallbacks).toBe(1);
    scheduler.dispose();
  });
});
