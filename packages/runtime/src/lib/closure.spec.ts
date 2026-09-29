/**
 *  closure regressions: overlapping teardown, reentrant lifecycle
 * calls, SCC cleanup semantics, and concurrent failure aggregation.
 */

import { describe, expect, it } from 'vitest';

import {
  AggregateRuntimeError,
  MissingRequirementsError,
  Runtime,
  type Context,
} from '../index.js';
import {
  deferred,
  makeConsumer,
  makeProvider,
  tokenX,
  tokenY,
  tokenZ,
  type Deferred,
} from '../test/fixtures.js';

describe('overlapping teardown cascades', () => {
  it('overlappingCascadeWaitsForInFlightConsumerCleanup', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    const log: string[] = [];
    let cleanupResolution: string | undefined;

    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'provider-b',
      plugin: makeConsumer('provider-b', [tokenX], tokenY, { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: {
        id: 'consumer-c',
        requirements: { requires: [tokenY] },
        activate(ctx: Context) {
          ctx.require(tokenY);
          log.push('activate:consumer-c');
          return async () => {
            log.push('dispose:consumer-c:start');
            await gate.promise;
            cleanupResolution = ctx.require(tokenY).label;
            log.push('dispose:consumer-c:end');
          };
        },
      },
    });

    const removeA = runtime.removeSlot('provider-a');

    const trigger = runtime.registerSlot({
      id: 'unrelated',
      plugin: makeProvider('unrelated', tokenZ, 'z', { log }),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(log).toContain('dispose:consumer-c:start');
    expect(log).not.toContain('dispose:provider-b');

    gate.resolve();
    await Promise.all([removeA, trigger]);

    expect(cleanupResolution).toBe('provider-b(x)');
    expect(log.indexOf('dispose:consumer-c:end')).toBeLessThan(
      log.indexOf('dispose:provider-b'),
    );
    expect(
      log.filter((entry) => entry === 'dispose:consumer-c:end'),
    ).toHaveLength(1);

    await runtime.dispose();
  });

  it('concurrentRemovalOfTwoProvidersWithSharedConsumerIsSafe', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    const log: string[] = [];
    let cleanupCount = 0;

    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'provider-b',
      plugin: makeProvider('provider-b', tokenY, 'y', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: {
        id: 'consumer-c',
        requirements: { requires: [tokenX, tokenY] },
        activate(ctx: Context) {
          ctx.require(tokenX);
          ctx.require(tokenY);
          return async () => {
            cleanupCount += 1;
            log.push('dispose:consumer-c:start');
            await gate.promise;
            expect(ctx.require(tokenX).label).toBe('x');
            expect(ctx.require(tokenY).label).toBe('y');
            log.push('dispose:consumer-c:end');
          };
        },
      },
    });

    const removeA = runtime.removeSlot('provider-a');
    const removeB = runtime.removeSlot('provider-b');

    await Promise.resolve();
    expect(cleanupCount).toBe(1);
    expect(log).not.toContain('dispose:provider-a');
    expect(log).not.toContain('dispose:provider-b');

    gate.resolve();
    await Promise.all([removeA, removeB]);

    expect(cleanupCount).toBe(1);
    const cleanupEnd = log.indexOf('dispose:consumer-c:end');
    expect(cleanupEnd).toBeGreaterThan(-1);
    expect(log.indexOf('dispose:provider-a')).toBeGreaterThan(cleanupEnd);
    expect(log.indexOf('dispose:provider-b')).toBeGreaterThan(cleanupEnd);

    await runtime.dispose();
  });
});

describe('reentrant lifecycle single-flight publication', () => {
  it('abortListenerReentrantDisposeJoinsExistingShutdown', async () => {
    const runtime = new Runtime();
    let reentrant: Promise<void> | undefined;

    await runtime.registerSlot({
      id: 'probe',
      plugin: {
        id: 'probe',
        activate(ctx: Context) {
          ctx.signal.addEventListener(
            'abort',
            () => {
              reentrant = runtime.dispose();
            },
            { once: true },
          );
          return () => undefined;
        },
      },
    });

    const outer = runtime.dispose();
    expect(reentrant).toBe(outer);
    await outer;
    expect(runtime.inspect().runtimeState).toBe('disposed');
  });

  it('reentrantRemoveSlotDoesNotStartSecondRemoval', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    let reentrant: Promise<void> | undefined;
    let cleanupCount = 0;

    await runtime.registerSlot({
      id: 'probe',
      plugin: {
        id: 'probe',
        activate(ctx: Context) {
          ctx.signal.addEventListener(
            'abort',
            () => {
              reentrant = runtime.removeSlot('probe');
            },
            { once: true },
          );
          return async () => {
            cleanupCount += 1;
            await gate.promise;
          };
        },
      },
    });

    const outer = runtime.removeSlot('probe');
    expect(reentrant).toBeDefined();

    let reentrantSettled = false;
    void reentrant?.then(() => {
      reentrantSettled = true;
    });
    await Promise.resolve();
    expect(reentrantSettled).toBe(false);
    expect(cleanupCount).toBe(1);

    gate.resolve();
    await Promise.all([outer, reentrant]);
    expect(cleanupCount).toBe(1);
    expect(runtime.inspect().counts.slots).toBe(0);

    await runtime.dispose();
  });
});

describe('dynamic SCC cleanup semantics', () => {
  it('cleanupResolutionInsideSccIsDeterministicButOrderDependent', async () => {
    const runtime = new Runtime();
    let ctxA: Context | undefined;
    let ctxB: Context | undefined;
    let bResolvedA: string | undefined;
    let aError: unknown;
    let bShouldResolvePeer = true;

    await runtime.registerSlot({
      id: 'provider-b',
      plugin: {
        id: 'provider-b',
        activate(ctx: Context) {
          ctxB = ctx;
          ctx.provide(tokenY, { label: 'y' });
          return () => {
            // The original SCC member resolves its peer during the SCC
            // teardown. The persistent B slot later reactivates without the
            // cycle; its final shutdown disposer should not pretend it still
            // holds that old dynamic dependency.
            if (bShouldResolvePeer) {
              bResolvedA = ctx.require(tokenX).label;
            }
          };
        },
      },
    });
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: {
        id: 'provider-a',
        activate(ctx: Context) {
          ctxA = ctx;
          ctx.provide(tokenX, { label: 'x' });
          return () => {
            try {
              ctx.require(tokenY);
            } catch (error) {
              aError = error;
            }
          };
        },
      },
    });

    ctxA?.require(tokenY);
    ctxB?.require(tokenX);
    await runtime.removeSlot('provider-a');

    expect(bResolvedA).toBe('x');
    expect(aError).toBeInstanceOf(MissingRequirementsError);

    bShouldResolvePeer = false;
    await runtime.dispose();
  });
});

describe('shutdown failure aggregation', () => {
  it('shutdownCollectsEveryConcurrentRemovalFailure', async () => {
    const runtime = new Runtime();
    const gateA = deferred();
    const gateB = deferred();

    const throwingAfter = (id: string, gate: Deferred<void>) => ({
      id,
      activate() {
        return async () => {
          await gate.promise;
          throw new Error(`${id} cleanup failed`);
        };
      },
    });

    await runtime.registerSlot({
      id: 'a',
      plugin: throwingAfter('a', gateA),
    });
    await runtime.registerSlot({
      id: 'b',
      plugin: throwingAfter('b', gateB),
    });

    const removeA = runtime.removeSlot('a');
    const removeB = runtime.removeSlot('b');
    void removeA.catch(() => undefined);
    void removeB.catch(() => undefined);

    const shutdown = runtime.dispose();
    gateA.resolve();
    gateB.resolve();

    let failure: AggregateRuntimeError | undefined;
    try {
      await shutdown;
    } catch (error) {
      failure = error as AggregateRuntimeError;
    }

    expect(failure).toBeInstanceOf(AggregateRuntimeError);
    expect(failure?.errors).toHaveLength(2);
    await Promise.allSettled([removeA, removeB]);
    expect(runtime.inspect().runtimeState).toBe('disposed');
  });
});
