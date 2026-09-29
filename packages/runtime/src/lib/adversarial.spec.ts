/**
 * Adversarial hardening tests: races, cancellation, stale contexts, staged
 * bindings, dependency-safe teardown, exception-safe disposal, and typed
 * configuration. These tests exercise transitions and races, not just final
 * states; all async control uses deferred promises (no timer races).
 */

import { describe, expect, it } from 'vitest';

import {
  AggregateRuntimeError,
  EffectScope,
  EffectScopeDisposedError,
  FiberNotActiveError,
  MissingRequirementsError,
  Runtime,
  RuntimeDisposedError,
  createServiceToken,
  definePlugin,
  type Context,
  type FiberHandle,
} from '../index.js';

import {
  deferred,
  makeConsumer,
  makeGatedActivation,
  makeLeaf,
  makeOptionalConsumer,
  makeProvider,
  makeResolvingCleanupConsumer,
  makeSlowCleanupConsumer,
  makeThrowingCleanup,
  makeTryConsumer,
  tokenA,
  tokenB,
  tokenC,
  tokenX,
  tokenY,
  tokenZ,
} from '../test/fixtures.js';

describe('dependency-safe teardown', () => {
  it('consumerCleanupRunsBeforeProviderCleanup', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeConsumer('consumer-b', [tokenA], tokenB, { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeConsumer('consumer-c', [tokenB], tokenC, { log }),
    });

    await runtime.removeSlot('provider-a');

    // Consumers are disposed before their provider, deepest first. The
    // order must not depend on accidental Map iteration order.
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'activate:consumer-c',
      'dispose:consumer-c',
      'dispose:consumer-b',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });
});

describe('stale contexts', () => {
  async function captureContext(
    runtime: Runtime,
  ): Promise<{ ctx: Context; slotId: string }> {
    let ctx: Context | undefined;
    const plugin = {
      id: 'probe',
      activate(c: Context) {
        ctx = c;
        return () => undefined;
      },
    };
    const slot = await runtime.registerSlot({ id: 'probe', plugin });
    return { ctx: ctx as Context, slotId: slot.id };
  }

  it('staleContextCannotProvideAfterDispose', async () => {
    const runtime = new Runtime();
    const { ctx } = await captureContext(runtime);
    await runtime.removeSlot('probe');

    expect(() => ctx.provide(tokenB, { label: 'late' })).toThrow(
      FiberNotActiveError,
    );
    expect(runtime.inspect().counts.bindings).toBe(0);

    await runtime.dispose();
  });

  it('staleContextCannotSubscribeAfterDispose', async () => {
    const runtime = new Runtime();
    const { ctx } = await captureContext(runtime);
    await runtime.removeSlot('probe');

    expect(() => ctx.on('fixture.ping', () => undefined)).toThrow(
      FiberNotActiveError,
    );
    expect(runtime.bus.subscriptionCount).toBe(0);

    await runtime.dispose();
  });

  it('staleContextCannotRegisterEffectAfterDispose', async () => {
    const runtime = new Runtime();
    const { ctx } = await captureContext(runtime);
    await runtime.removeSlot('probe');

    expect(() => ctx.effect({ dispose: () => undefined })).toThrow(
      FiberNotActiveError,
    );

    await runtime.dispose();
  });

  it('staleContextCannotMountAfterDispose', async () => {
    const runtime = new Runtime();
    const { ctx } = await captureContext(runtime);
    await runtime.removeSlot('probe');

    expect(() =>
      ctx.mount({
        id: 'late-child',
        plugin: makeProvider('late', tokenB, 'x'),
      }),
    ).toThrow(FiberNotActiveError);

    await runtime.dispose();
  });

  it('rejects new slots after the runtime is disposed', async () => {
    const runtime = new Runtime();
    await runtime.dispose();

    await expect(
      runtime.registerSlot({
        id: 'late',
        plugin: makeProvider('late', tokenA, 'x'),
      }),
    ).rejects.toBeInstanceOf(RuntimeDisposedError);
  });

  it('exposes a frozen read-only fiber handle', async () => {
    const runtime = new Runtime();
    let handle: FiberHandle | undefined;
    const plugin = {
      id: 'probe',
      activate(ctx: Context) {
        handle = ctx.fiber;
        return () => undefined;
      },
    };
    await runtime.registerSlot({ id: 'probe', plugin });

    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle?.id).toBeTypeOf('string');
    expect(handle?.state).toBe('active');

    await runtime.dispose();
  });
});

describe('effect scope state machine', () => {
  it('effectScopeRejectsAddAfterDispose', async () => {
    const scope = new EffectScope();
    scope.add({ dispose: () => undefined });
    await scope.dispose();

    expect(scope.disposed).toBe(true);
    expect(() => scope.add({ dispose: () => undefined })).toThrow(
      EffectScopeDisposedError,
    );
  });

  it('effectScopeDisposalIsIdempotent', async () => {
    const scope = new EffectScope();
    const cleanups: string[] = [];
    scope.add({ dispose: () => void cleanups.push('a') });
    scope.add({ dispose: () => void cleanups.push('b') });

    const first = await scope.dispose();
    const second = await scope.dispose();

    expect(cleanups).toEqual(['b', 'a']);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(scope.size).toBe(0);
  });
});

describe('async activation cancellation', () => {
  it('removeDuringAsyncActivationCannotResurrectFiber', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    let started = false;
    const slow = {
      id: 'slow',
      async activate(ctx: Context) {
        started = true;
        void ctx.signal;
        await gate.promise;
        return () => undefined;
      },
    };

    const slotPromise = runtime.registerSlot({ id: 'slow', plugin: slow });
    // Activation starts synchronously; the drain is now awaiting it.
    expect(started).toBe(true);

    // Resolve the gate before awaiting removal: removeSlot awaits
    // quiescence, which includes the in-flight activation.
    const removal = runtime.removeSlot('slow');
    gate.resolve();
    await removal;
    const slot = await slotPromise;

    // The slot is gone and no fiber was ever committed.
    expect(slot.state).toBe('inactive');
    expect(slot.fiberId).toBeNull();
    const inspection = runtime.inspect();
    expect(inspection.slots).toHaveLength(0);
    expect(inspection.counts.activeFibers).toBe(0);

    await runtime.dispose();
  });

  it('cancelledActivationReturnedDisposerRunsImmediately', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    const log: string[] = [];
    const slow = {
      id: 'slow',
      async activate(ctx: Context) {
        void ctx.signal;
        await gate.promise;
        return () => {
          log.push('disposed');
        };
      },
    };

    const slotPromise = runtime.registerSlot({ id: 'slow', plugin: slow });
    const removal = runtime.removeSlot('slow');
    gate.resolve();
    await removal;
    await slotPromise;

    // The disposer returned by the cancelled activation ran immediately.
    expect(log).toEqual(['disposed']);
    expect(runtime.inspect().counts.activeFibers).toBe(0);

    await runtime.dispose();
  });

  it('captures disposeStart at disposal start and completes disposal', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    const plugin = {
      id: 'slow-cleanup',
      activate(ctx: Context) {
        void ctx.signal;
        return () => gate.promise;
      },
    };
    await runtime.registerSlot({ id: 'slow-cleanup', plugin });

    const removal = runtime.removeSlot('slow-cleanup');
    // While disposal is in flight, the fiber is 'unloading' and disposeStart
    // is already captured (not lazily at the end).
    const inFlight = runtime
      .inspect()
      .fibers.find((f) => f.pluginId === 'slow-cleanup');
    expect(inFlight?.state).toBe('unloading');
    expect(inFlight?.diagnostics.timing.disposeStart).toBeGreaterThan(0);
    expect(inFlight?.diagnostics.timing.disposeEnd).toBe(0);

    gate.resolve();
    await removal;
    expect(runtime.inspect().counts.activeFibers).toBe(0);

    await runtime.dispose();
  });
});

describe('activation commit semantics', () => {
  it('loadingProviderDoesNotSatisfyConsumer', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    let started = false;
    const slowProvider = {
      id: 'slow-provider',
      async activate(ctx: Context) {
        started = true;
        void ctx.signal;
        ctx.provide(tokenA, { label: 'a' });
        await gate.promise;
        return () => undefined;
      },
    };

    const providerPromise = runtime.registerSlot({
      id: 'provider',
      plugin: slowProvider,
    });
    expect(started).toBe(true);

    const consumerPromise = runtime.registerSlot({
      id: 'consumer',
      plugin: makeConsumer('consumer', [tokenA], tokenB),
    });

    // While the provider is still loading, its staged binding must not
    // satisfy the consumer, and no binding is dependency-visible.
    let inspection = runtime.inspect();
    expect(inspection.slots.find((s) => s.id === 'consumer')?.state).toBe(
      'inactive',
    );
    expect(
      inspection.slots.find((s) => s.id === 'consumer')?.missingRequirements,
    ).toEqual(['fixture.serviceA']);
    expect(inspection.counts.bindings).toBe(0);

    gate.resolve();
    await providerPromise;
    await consumerPromise;

    inspection = runtime.inspect();
    expect(inspection.slots.find((s) => s.id === 'consumer')?.state).toBe(
      'active',
    );
    // Provider A and consumer B both committed bindings.
    expect(inspection.counts.bindings).toBe(2);

    await runtime.dispose();
  });

  it('failedProviderNeverMakesServiceActive', async () => {
    const runtime = new Runtime();
    const failing = {
      id: 'failing',
      activate(ctx: Context) {
        ctx.provide(tokenA, { label: 'a' });
        throw new Error('boom');
      },
    };
    const providerSlot = await runtime.registerSlot({
      id: 'provider',
      plugin: failing,
    });
    const consumerSlot = await runtime.registerSlot({
      id: 'consumer',
      plugin: makeConsumer('consumer', [tokenA], tokenB),
    });

    expect(providerSlot.state).toBe('failed');
    expect(consumerSlot.state).toBe('inactive');
    const inspection = runtime.inspect();
    expect(inspection.counts.bindings).toBe(0);
    expect(
      inspection.slots.find((s) => s.id === 'consumer')?.missingRequirements,
    ).toEqual(['fixture.serviceA']);

    await runtime.dispose();
  });
});

describe('reconciliation scheduling', () => {
  it('concurrentRegisterSlotWaitsForSettlement', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    const slow = {
      id: 'slow',
      async activate(ctx: Context) {
        void ctx.signal;
        await gate.promise;
        return () => undefined;
      },
    };

    const first = runtime.registerSlot({ id: 'slow', plugin: slow });
    const second = runtime.registerSlot({
      id: 'fast',
      plugin: makeProvider('fast', tokenB, 'b'),
    });

    // Neither registration settles while the first activation is in flight.
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await first;
    await second;
    expect(runtime.inspect().counts.activeFibers).toBe(2);

    await runtime.dispose();
  });

  it('mutationDuringReconciliationTriggersAnotherPass', async () => {
    const runtime = new Runtime();
    const parent = {
      id: 'parent',
      activate(ctx: Context) {
        ctx.mount({
          id: 'child',
          plugin: makeProvider('child', tokenB, 'child'),
        });
        return () => undefined;
      },
    };

    await runtime.registerSlot({ id: 'parent', plugin: parent });

    // The mount happened mid-pass; the drain ran another pass and the child
    // settled before registerSlot returned.
    const inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(2);
    expect(inspection.slots.find((s) => s.id === 'child')?.state).toBe(
      'active',
    );

    await runtime.dispose();
  });

  it('mountDuringActivationDoesNotDeadlock', async () => {
    const runtime = new Runtime();
    const parent = {
      id: 'parent',
      activate(ctx: Context) {
        ctx.mount({
          id: 'child',
          plugin: makeProvider('child', tokenB, 'child'),
        });
        return () => undefined;
      },
    };

    // registerSlot must settle even though the mount happened inside the
    // activation that the drain is awaiting.
    await expect(
      runtime.registerSlot({ id: 'parent', plugin: parent }),
    ).resolves.toBeDefined();

    await runtime.dispose();
  });
});

describe('exception-safe disposal', () => {
  it('removeSlotCleanupFailureStillDetachesSlot', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'dirty',
      plugin: makeThrowingCleanup('dirty'),
    });

    await expect(runtime.removeSlot('dirty')).rejects.toBeInstanceOf(
      AggregateRuntimeError,
    );

    // The slot is detached and nothing dangles despite the throwing cleanup.
    const inspection = runtime.inspect();
    expect(inspection.slots).toHaveLength(0);
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.effects).toBe(0);

    await runtime.dispose();
  });

  it('activationErrorPreservedWhenRollbackAlsoFails', async () => {
    const runtime = new Runtime();
    const plugin = {
      id: 'double-failure',
      activate(ctx: Context) {
        ctx.effect({
          dispose: () => {
            throw new Error('rollback boom');
          },
        });
        throw new Error('activation boom');
      },
    };

    const slot = await runtime.registerSlot({
      id: 'double-failure',
      plugin,
    });

    expect(slot.state).toBe('failed');
    expect(slot.failure?.phase).toBe('activation');
    // The most important diagnostic fact is what caused activation to fail.
    expect((slot.failure?.error as Error).message).toBe('activation boom');
    // Rollback failures are secondary but never lost.
    expect(slot.failure?.rollbackErrors).toHaveLength(1);

    await runtime.dispose();
  });
});

describe('typed configuration', () => {
  it('pluginReceivesTypedConfig', async () => {
    const runtime = new Runtime();
    let received: string | undefined;
    const plugin = definePlugin<{ greeting: string }>({
      id: 'typed-config',
      activate(ctx) {
        // Compile-time proof: ctx.config is typed as { greeting: string }.
        received = ctx.config.greeting;
        return () => undefined;
      },
    });

    const slot = await runtime.registerSlot({
      id: 'typed-config',
      plugin,
      config: { greeting: 'hello' },
    });

    expect(slot.state).toBe('active');
    expect(received).toBe('hello');

    await runtime.dispose();
  });
});

describe('reactivation', () => {
  it('reactivationCreatesFreshFiber', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a'),
    });
    const consumer = await runtime.registerSlot({
      id: 'consumer',
      plugin: makeConsumer('consumer', [tokenA], tokenB),
    });
    const firstFiberId = consumer.fiberId;

    await runtime.removeSlot('provider');
    await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a2'),
    });

    expect(consumer.state).toBe('active');
    expect(consumer.fiberId).not.toBe(firstFiberId);

    await runtime.dispose();
  });

  it('replacementAtoA2UsesFreshEntireDependentChain', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a'),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeConsumer('consumer-b', [tokenA], tokenB),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeConsumer('consumer-c', [tokenB], tokenC),
    });

    const oldIds = new Set(runtime.inspect().fibers.map((f) => f.id));
    expect(oldIds.size).toBe(3);

    await runtime.removeSlot('provider-a');
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a2'),
    });

    const newIds = new Set(runtime.inspect().fibers.map((f) => f.id));
    expect(newIds.size).toBe(3);
    for (const id of oldIds) {
      expect(newIds.has(id)).toBe(false);
    }

    await runtime.dispose();
  });
});

describe('topological teardown', () => {
  it('diamondDependencyDisposesInTopologicalOrder', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    // A provides X; B requires X provides Y; C requires X+Y provides Z;
    // D requires Z.
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeConsumer('consumer-b', [tokenX], tokenY, { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeConsumer('consumer-c', [tokenX, tokenY], tokenZ, { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-d',
      plugin: makeLeaf('consumer-d', [tokenZ], { log }),
    });

    await runtime.removeSlot('provider-a');

    // Consumers first, deepest first. BFS depth would tie B and C at depth
    // 1; the true topological order disposes C before B (C consumes Y).
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'activate:consumer-c',
      'activate:consumer-d',
      'dispose:consumer-d',
      'dispose:consumer-c',
      'dispose:consumer-b',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });

  it('multiPathDependencyNeverDisposesProviderBeforeConsumer', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    // C depends on A through two paths: X directly, and Y via B. No valid
    // teardown may dispose C before B or A.
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeConsumer('consumer-b', [tokenX], tokenY, { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeConsumer('consumer-c', [tokenX, tokenY], tokenZ, { log }),
    });

    await runtime.removeSlot('provider-a');

    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'activate:consumer-c',
      'dispose:consumer-c',
      'dispose:consumer-b',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });

  it('dependencyCycleIsHandledDeterministically', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    // A mutual requirement pair with no external provider: neither slot can
    // ever load (activation requires already-committed bindings), so both
    // stay inactive forever. Cycles cannot arise from initially-declared
    // mutually-unsatisfied requirements; dynamic ctx.require() cycles are
    // covered by dynamicHardDependencyCycleTeardownIsDeterministic.
    const a = await runtime.registerSlot({
      id: 'a-cyc',
      plugin: makeConsumer('a-cyc', [tokenY], tokenX, { log }),
    });
    const b = await runtime.registerSlot({
      id: 'b-cyc',
      plugin: makeConsumer('b-cyc', [tokenX], tokenY, { log }),
    });

    expect(a.state).toBe('inactive');
    expect(b.state).toBe('inactive');
    expect(runtime.inspect().fibers).toHaveLength(0);
    expect(runtime.inspect().graphCycles).toEqual([]);
    expect(runtime.inspect().counts.bindings).toBe(0);

    await runtime.dispose();
  });
});

describe('retirement window', () => {
  it('newConsumerCannotActivateAgainstRetiringProvider', async () => {
    const runtime = new Runtime();
    const cleanupGate = deferred();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeSlowCleanupConsumer('consumer-b', [tokenX], cleanupGate, {
        log,
      }),
    });

    // Retire A: B's cleanup is gated, so the retirement window stays open.
    const removal = runtime.removeSlot('provider-a');

    // C requires X while A's binding is retiring: it must NOT activate.
    const c = await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeLeaf('consumer-c', [tokenX], { log }),
    });
    expect(c.state).toBe('inactive');
    expect(
      runtime.inspect().slots.find((s) => s.id === 'consumer-c')
        ?.missingRequirements,
    ).toEqual(['fixture.serviceX']);
    expect(
      runtime.inspect().fibers.some((f) => f.slotId === 'consumer-c'),
    ).toBe(false);

    // Release B's cleanup; only then may a replacement provider restore X
    // and let C activate against the fresh capability.
    cleanupGate.resolve();
    await removal;
    await runtime.registerSlot({
      id: 'provider-a2',
      plugin: makeProvider('provider-a2', tokenX, 'x2', { log }),
    });

    expect(c.state).toBe('active');
    // B is a normal consumer of X: once A2 restores X, B reactivates, and
    // then C (which requires X) follows.
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'dispose:consumer-b:start',
      'dispose:consumer-b:end',
      'dispose:provider-a',
      'activate:provider-a2',
      'activate:consumer-b',
      'activate:consumer-c',
    ]);

    await runtime.dispose();
  });

  it('consumerCanFinishCleanupWhileProviderRetires', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeResolvingCleanupConsumer('consumer-b', [tokenX], { log }),
    });

    await runtime.removeSlot('provider-a');

    // B's cleanup resolves X through the retiring binding and finishes
    // before A's own cleanup runs.
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'dispose:consumer-b:x',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });

  it('loadingDeclaredDependentIsCancelledWhenProviderRetires', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });

    // B starts loading: its declared hard edge is registered synchronously,
    // but its activation is held open on the gate.
    const b = runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeGatedActivation('consumer-b', gate, {
        requires: [tokenX],
        provides: tokenY,
        log,
      }),
    });

    // A retires while B is loading. The loading-time edge makes the cascade
    // include B even though it never committed; B is aborted.
    const removal = runtime.removeSlot('provider-a');
    gate.resolve();
    await removal;
    await b;

    // B was cancelled: no fiber, no committed binding, and its disposer ran
    // through the late-disposer path instead of a commit. The disposer is
    // emitted before the provider's cleanup: the gate resolution is queued
    // ahead of the cascade's continuation, so the cancelled activation
    // settles first — deterministically, and still consumer-before-provider.
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'dispose:consumer-b',
      'dispose:provider-a',
    ]);
    expect(
      runtime.inspect().fibers.some((f) => f.slotId === 'consumer-b'),
    ).toBe(false);
    expect(runtime.inspect().counts.bindings).toBe(0);

    await runtime.dispose();
  });

  it('loadingConsumerCannotCommitAgainstRetiringProvider', async () => {
    const runtime = new Runtime();
    const gate = deferred();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });

    // B loads (declared requirement on X), stages Y, and waits on the gate.
    const b = runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeGatedActivation('consumer-b', gate, {
        requires: [tokenX],
        provides: tokenY,
        log,
      }),
    });
    // C depends on B's Y. It must never see Y active: B's activation is in
    // flight, and after the provider retires it must never commit.
    const c = runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeLeaf('consumer-c', [tokenY], { log }),
    });

    const removal = runtime.removeSlot('provider-a');
    gate.resolve();
    const [, consumer] = await Promise.all([b, c, removal]);

    expect(consumer.state).toBe('inactive');
    expect(
      runtime.inspect().slots.find((s) => s.id === 'consumer-c')
        ?.missingRequirements,
    ).toEqual(['fixture.serviceY']);
    expect(
      runtime
        .inspect()
        .bindings.some((binding) => binding.token.id === tokenY.id),
    ).toBe(false);
    expect(runtime.inspect().counts.bindings).toBe(0);

    await runtime.dispose();
  });

  it('dynamicHardDependencyProviderRetiresBeforeNewConsumersCanAttach', async () => {
    const runtime = new Runtime();
    const cleanupGate = deferred();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    // B has NO declared requirements; it dynamically requires X through
    // ctx.require during activation and provides Y. The hard edge is
    // created at runtime, not through `requirements.requires`.
    await runtime.registerSlot({
      id: 'provider-b',
      plugin: {
        id: 'provider-b',
        activate(ctx: Context) {
          log.push('activate:provider-b');
          const x = ctx.require(tokenX);
          ctx.provide(tokenY, { label: `provider-b(${x.label})` });
          return () => {
            log.push('dispose:provider-b');
          };
        },
      },
    });
    // C requires Y and has gated cleanup.
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeSlowCleanupConsumer('consumer-c', [tokenY], cleanupGate, {
        log,
      }),
    });

    // Remove A: the cascade is C → B → A. B is scheduled for teardown but
    // its own disposal has not started while C's cleanup is gated.
    const removal = runtime.removeSlot('provider-a');

    // D requires Y while B is mid-cascade: B's Y must already be retiring,
    // so D stays inactive and has no fiber.
    const d = await runtime.registerSlot({
      id: 'consumer-d',
      plugin: makeLeaf('consumer-d', [tokenY], { log }),
    });
    expect(d.state).toBe('inactive');
    expect(d.fiberId).toBeNull();
    const inspection = runtime.inspect();
    expect(
      inspection.slots.find((s) => s.id === 'consumer-d')?.missingRequirements,
    ).toEqual(['fixture.serviceY']);
    expect(
      inspection.retiringBindings.some((b) => b.token.id === tokenY.id),
    ).toBe(true);
    expect(inspection.fibers.some((f) => f.slotId === 'consumer-d')).toBe(
      false,
    );

    // After cleanup finishes and a fresh provider chain is restored, D may
    // activate against the fresh capability.
    cleanupGate.resolve();
    await removal;
    await runtime.registerSlot({
      id: 'provider-a2',
      plugin: makeProvider('provider-a2', tokenX, 'x2', { log }),
    });

    expect(d.state).toBe('active');
    expect(d.fiberId).not.toBeNull();
    expect(log).toEqual([
      'activate:provider-a',
      'activate:provider-b',
      'activate:consumer-c',
      'dispose:consumer-c:start',
      'dispose:consumer-c:end',
      'dispose:provider-b',
      'dispose:provider-a',
      // B's slot survives; with no declared requirements it retries before
      // A2 exists, its dynamic require finds X missing, and the slot waits
      // (retryable missing-requirements)...
      'activate:provider-b',
      // ...then A2 restores X and B commits, followed by C and D.
      'activate:provider-a2',
      'activate:provider-b',
      'activate:consumer-c',
      'activate:consumer-d',
    ]);

    await runtime.dispose();
  });

  it('childProviderRetiresWhenParentCascadeStarts', async () => {
    const runtime = new Runtime();
    const cleanupGate = deferred();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'parent',
      plugin: {
        id: 'parent',
        activate(ctx: Context) {
          log.push('activate:parent');
          ctx.mount({
            id: 'child',
            plugin: makeProvider('child', tokenY, 'y', { log }),
          });
          return () => {
            log.push('dispose:parent');
          };
        },
      },
    });
    // D requires the child's Y and has gated cleanup: it is disposed by the
    // child's cascade, and its cleanup holds the retirement window open.
    await runtime.registerSlot({
      id: 'consumer-d',
      plugin: makeSlowCleanupConsumer('consumer-d', [tokenY], cleanupGate, {
        log,
      }),
    });

    // Remove the parent: the child is scheduled for teardown with it, so
    // the child's Y must retire before D's cleanup even starts.
    const removal = runtime.removeSlot('parent');

    // While D's cleanup is gated, the child's Y is retiring: a new consumer
    // must not attach to a service whose owner is already scheduled for
    // destruction.
    const e = await runtime.registerSlot({
      id: 'consumer-e',
      plugin: makeLeaf('consumer-e', [tokenY], { log }),
    });
    expect(e.state).toBe('inactive');
    expect(e.fiberId).toBeNull();
    const inspection = runtime.inspect();
    expect(
      inspection.retiringBindings.some((b) => b.token.id === tokenY.id),
    ).toBe(true);
    expect(inspection.fibers.some((f) => f.slotId === 'consumer-e')).toBe(
      false,
    );

    cleanupGate.resolve();
    await removal;
    expect(runtime.inspect().counts.activeFibers).toBe(0);

    await runtime.dispose();
  });
});

describe('optional dependencies', () => {
  it('optionalTryDoesNotBecomeHardDependency', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    // B has no declared requirements; it observes X through ctx.try only.
    const b = await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeTryConsumer('consumer-b', [tokenX], tokenY, { log }),
    });
    const fiberId = b.fiberId;

    // Removing X must not dispose or reactivate B: a successful try() is a
    // soft observation, not a hard teardown dependency.
    await runtime.removeSlot('provider-a');

    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'dispose:provider-a',
    ]);
    expect(b.state).toBe('active');
    expect(b.fiberId).toBe(fiberId);
    const binding = runtime
      .inspect()
      .bindings.find((entry) => entry.token.id === tokenY.id);
    expect((binding?.implementation as { label: string }).label).toBe(
      'consumer-b(x)',
    );

    await runtime.dispose();
  });

  it('optionalDependencyDisappearanceDoesNotForceReactivation', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    // B declares X as optionallyRequires: a soft, declared dependency.
    const b = await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeOptionalConsumer('consumer-b', [tokenX], tokenY, { log }),
    });
    const fiberId = b.fiberId;

    await runtime.removeSlot('provider-a');

    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'dispose:provider-a',
    ]);
    expect(b.state).toBe('active');
    expect(b.fiberId).toBe(fiberId);
    // The soft requirement is still tracked for introspection, but it never
    // drove teardown.
    const fiber = runtime.inspect().fibers.find((f) => f.id === fiberId);
    expect(fiber?.softRequiredTokens).toEqual(['fixture.serviceX']);
    expect(fiber?.hardRequiredTokens).toEqual([]);

    await runtime.dispose();
  });
});

describe('runtime disposal', () => {
  it('runtimeDisposeAbortsActivationWaitingForSignal', async () => {
    const runtime = new Runtime();
    const plugin = {
      id: 'signal-waiter',
      activate(ctx: Context) {
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }).then(() => () => undefined);
      },
    };

    // The activation never completes on its own; only the disposal abort
    // settles it. dispose() must abort before waiting for quiescence.
    const registration = runtime.registerSlot({
      id: 'signal-waiter',
      plugin,
    });
    await runtime.dispose();
    await registration;
  });

  it('runtimeDisposeDoesNotDeadlockWithInFlightActivation', async () => {
    const runtime = new Runtime();
    const makeSignalWaiter = (id: string) => ({
      id,
      activate(ctx: Context) {
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }).then(() => () => undefined);
      },
    });

    const a = runtime.registerSlot({
      id: 'signal-waiter-a',
      plugin: makeSignalWaiter('signal-waiter-a'),
    });
    const b = runtime.registerSlot({
      id: 'signal-waiter-b',
      plugin: makeSignalWaiter('signal-waiter-b'),
    });

    await runtime.dispose();
    await Promise.all([a, b]);

    const inspection = runtime.inspect();
    expect(inspection.runtimeState).toBe('disposed');
    expect(inspection.counts.slots).toBe(0);
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.effects).toBe(0);
  });

  it('abortedActivationNeverCommitsStagedBinding', async () => {
    const runtime = new Runtime();
    const disposerLog: string[] = [];
    const plugin = {
      id: 'abort-waiter',
      activate(ctx: Context) {
        // Stage a binding, then wait for the abort signal: the activation
        // wakes because of global shutdown and returns normally.
        ctx.provide(tokenX, { label: 'x' });
        return new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }).then(() => () => {
          disposerLog.push('disposed');
        });
      },
    };

    const registration = runtime.registerSlot({
      id: 'abort-waiter',
      plugin,
    });
    await runtime.dispose();
    await registration;

    // ServiceX was never committed; the fiber never became active; the
    // returned disposer ran immediately through the commit-fence rollback.
    const inspection = runtime.inspect();
    expect(inspection.runtimeState).toBe('disposed');
    expect(inspection.counts.slots).toBe(0);
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.effects).toBe(0);
    expect(inspection.bindings.some((b) => b.token.id === tokenX.id)).toBe(
      false,
    );
    expect(inspection.retiringBindings).toHaveLength(0);
    expect(disposerLog).toEqual(['disposed']);
  });

  it('concurrentDisposeCallsJoinSameShutdown', async () => {
    const runtime = new Runtime();
    const cleanupGate = deferred();
    await runtime.registerSlot({
      id: 'gated-cleanup',
      plugin: {
        id: 'gated-cleanup',
        activate(ctx: Context) {
          void ctx.signal;
          return () => cleanupGate.promise;
        },
      },
    });

    const d1 = runtime.dispose();
    const d2 = runtime.dispose();

    // Single-flight: both callers hold the same shutdown operation.
    expect(d1).toBe(d2);

    // Neither caller resolves while cleanup is in flight.
    let settled = false;
    void d1.then(() => {
      settled = true;
    });
    void d2.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanupGate.resolve();
    await d1;
    await d2;

    const inspection = runtime.inspect();
    expect(inspection.runtimeState).toBe('disposed');
    expect(inspection.counts.slots).toBe(0);
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);
  });

  it('concurrentDisposeDoesNotResolveBeforeCleanupCompletes', async () => {
    const runtime = new Runtime();
    const cleanupGate = deferred();
    await runtime.registerSlot({
      id: 'gated-cleanup',
      plugin: {
        id: 'gated-cleanup',
        activate(ctx: Context) {
          void ctx.signal;
          return () => cleanupGate.promise;
        },
      },
    });

    const d1 = runtime.dispose();
    const d2 = runtime.dispose();

    // While cleanup is gated, the runtime is mid-shutdown: no caller may
    // observe a completed disposal.
    let settled = false;
    void d1.then(() => {
      settled = true;
    });
    void d2.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.inspect().runtimeState).toBe('disposing');

    cleanupGate.resolve();
    await Promise.all([d1, d2]);
    expect(runtime.inspect().runtimeState).toBe('disposed');
  });

  it('concurrentDisposeCallersObserveSameFailure', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'throwing',
      plugin: makeThrowingCleanup('throwing'),
    });

    const d1 = runtime.dispose();
    const d2 = runtime.dispose();
    expect(d1).toBe(d2);

    // Both callers observe the same aggregated failure.
    await expect(d1).rejects.toBeInstanceOf(AggregateRuntimeError);
    await expect(d2).rejects.toBeInstanceOf(AggregateRuntimeError);
    expect(runtime.inspect().runtimeState).toBe('disposed');
  });

  it('concurrentRemoveSlotCallsJoinSameRemoval', async () => {
    const runtime = new Runtime();
    const cleanupGate = deferred();
    await runtime.registerSlot({
      id: 'gated',
      plugin: {
        id: 'gated',
        activate(ctx: Context) {
          void ctx.signal;
          return () => cleanupGate.promise;
        },
      },
    });

    const r1 = runtime.removeSlot('gated');
    const r2 = runtime.removeSlot('gated');

    // Neither caller resolves while the removal's cleanup is in flight.
    let settled = false;
    void r1.then(() => {
      settled = true;
    });
    void r2.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    cleanupGate.resolve();
    await r1;
    await r2;
    expect(runtime.inspect().counts.slots).toBe(0);

    await runtime.dispose();
  });
});

describe('cleanup dependency restriction', () => {
  it('cleanupCanResolvePreviouslyHeldHardDependency', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    const resolved: string[] = [];
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: {
        id: 'consumer-b',
        requirements: { requires: [tokenX] },
        activate(ctx: Context) {
          log.push('activate:consumer-b');
          ctx.require(tokenX);
          return () => {
            // X was a hard dependency held before teardown: cleanup may
            // resolve it again through the retiring binding.
            resolved.push(ctx.require(tokenX).label);
            log.push('dispose:consumer-b');
          };
        },
      },
    });

    await runtime.removeSlot('provider-a');

    expect(resolved).toEqual(['x']);
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'dispose:consumer-b',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });

  it('cleanupCanResolvePreviouslyObservedSoftDependency', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'provider-c',
      plugin: makeProvider('provider-c', tokenY, 'y', { log }),
    });
    const observed: string[] = [];
    await runtime.registerSlot({
      id: 'observer-b',
      plugin: {
        id: 'observer-b',
        requirements: { requires: [tokenX] },
        activate(ctx: Context) {
          log.push('activate:observer-b');
          ctx.require(tokenX);
          // Y is observed softly; it never drives teardown.
          const y = ctx.try(tokenY);
          ctx.provide(tokenZ, { label: `observer-b(${y?.label ?? 'none'})` });
          return () => {
            // Y was observed before teardown: cleanup may observe it again.
            observed.push(ctx.try(tokenY)?.label ?? 'none');
            log.push('dispose:observer-b');
          };
        },
      },
    });

    // B is disposed by the hard X edge; its cleanup may still resolve Y,
    // which it observed softly before teardown.
    await runtime.removeSlot('provider-a');

    expect(observed).toEqual(['y']);
    expect(log).toEqual([
      'activate:provider-a',
      'activate:provider-c',
      'activate:observer-b',
      'dispose:observer-b',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });

  it('cleanupCannotRequireUnrelatedService', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'provider-c',
      plugin: makeProvider('provider-c', tokenY, 'y', { log }),
    });
    let cleanupError: unknown;
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: {
        id: 'consumer-b',
        requirements: { requires: [tokenX] },
        activate(ctx: Context) {
          log.push('activate:consumer-b');
          ctx.require(tokenX);
          return () => {
            try {
              // B never held Y: requiring it during cleanup must be a
              // structured lifecycle error, never a silent resolution.
              ctx.require(tokenY);
            } catch (error) {
              cleanupError = error;
            }
            log.push('dispose:consumer-b');
          };
        },
      },
    });

    await runtime.removeSlot('provider-a');

    expect(cleanupError).toBeInstanceOf(MissingRequirementsError);
    expect(log).toEqual([
      'activate:provider-a',
      'activate:provider-c',
      'activate:consumer-b',
      'dispose:consumer-b',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });

  it('cleanupCannotTryPreviouslyUnobservedService', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'provider-c',
      plugin: makeProvider('provider-c', tokenY, 'y', { log }),
    });
    const observed: string[] = [];
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: {
        id: 'consumer-b',
        requirements: { requires: [tokenX] },
        activate(ctx: Context) {
          log.push('activate:consumer-b');
          ctx.require(tokenX);
          return () => {
            // B never observed Y: cleanup-time try must not silently return
            // an unrelated service.
            observed.push(ctx.try(tokenY)?.label ?? 'none');
            log.push('dispose:consumer-b');
          };
        },
      },
    });

    await runtime.removeSlot('provider-a');

    expect(observed).toEqual(['none']);
    expect(log).toEqual([
      'activate:provider-a',
      'activate:provider-c',
      'activate:consumer-b',
      'dispose:consumer-b',
      'dispose:provider-a',
    ]);

    await runtime.dispose();
  });
});

describe('dynamic dependency cycles', () => {
  it('dynamicHardDependencyCycleTeardownIsDeterministic', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    let ctxA: Context | undefined;
    let ctxB: Context | undefined;

    // B registers first so its fiber id sorts before A's: the cascade root
    // (A) is not the first SCC member by sort order.
    await runtime.registerSlot({
      id: 'provider-b',
      plugin: {
        id: 'provider-b',
        activate(ctx: Context) {
          ctxB = ctx;
          log.push('activate:provider-b');
          ctx.provide(tokenY, { label: 'y' });
          return () => {
            log.push('dispose:provider-b');
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
          log.push('activate:provider-a');
          ctx.provide(tokenX, { label: 'x' });
          return () => {
            log.push('dispose:provider-a');
          };
        },
      },
    });

    // Both active with no edges yet.
    expect(runtime.inspect().graphCycles).toEqual([]);

    // Dynamic hard edges after activation: A ⇄ B. This is a runtime-created
    // hard cycle — reachable only through ctx.require, never through
    // initially-declared requirements.
    ctxA?.require(tokenY);
    ctxB?.require(tokenX);

    const fibers = runtime.inspect().fibers;
    const fiberA = fibers.find((f) => f.slotId === 'provider-a')?.id;
    const fiberB = fibers.find((f) => f.slotId === 'provider-b')?.id;
    expect(runtime.inspect().graphCycles).toEqual([[fiberB, fiberA]]);

    // Remove A: the SCC must tear down deterministically — each member
    // disposed exactly once, no hang, no leaks. The root (A) is not the
    // first SCC member by sort order (B sorts first), so this also proves
    // the root is not double-disposed and the group order is deterministic.
    await runtime.removeSlot('provider-a');

    expect(log).toEqual([
      'activate:provider-b',
      'activate:provider-a',
      'dispose:provider-b',
      'dispose:provider-a',
      // B's slot survives the cascade and has no declared requirements, so
      // it reactivates into a fresh fiber (no edges, no cycle).
      'activate:provider-b',
    ]);
    const afterCascade = runtime.inspect();
    expect(afterCascade.graphCycles).toEqual([]);
    expect(afterCascade.retiringBindings).toHaveLength(0);
    expect(afterCascade.counts.bindings).toBe(1);

    // Global shutdown: no leaked effects, services, or subscriptions.
    await runtime.dispose();
    const inspection = runtime.inspect();
    expect(inspection.runtimeState).toBe('disposed');
    expect(inspection.counts.slots).toBe(0);
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.effects).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.retiringBindings).toHaveLength(0);
  });
});

describe('reconciliation order', () => {
  it('reconciliationCompletesTeardownBeforeNewActivation', async () => {
    const runtime = new Runtime();
    const cleanupGate = deferred();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeSlowCleanupConsumer('consumer-b', [tokenX], cleanupGate, {
        log,
      }),
    });

    // Start teardown; B's cleanup is gated so the retirement window is open.
    const removal = runtime.removeSlot('provider-a');

    // A new consumer registered while teardown is in flight must stay
    // inactive: its requirement is still retiring.
    const consumer = await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeConsumer('consumer-c', [tokenX], tokenZ, { log }),
    });
    expect(consumer.state).toBe('inactive');
    expect(runtime.inspect().counts.bindings).toBe(0);

    // Finish teardown, then restore the provider. The consumer activates
    // only after the old chain is fully gone and resolves the FRESH
    // capability — never the retiring one.
    cleanupGate.resolve();
    await removal;
    await runtime.registerSlot({
      id: 'provider-a2',
      plugin: makeProvider('provider-a2', tokenX, 'x2', { log }),
    });

    expect(consumer.state).toBe('active');
    const binding = runtime
      .inspect()
      .bindings.find((entry) => entry.token.id === tokenZ.id);
    expect((binding?.implementation as { label: string }).label).toBe(
      'consumer-c(x2)',
    );
    const teardownEnd = log.indexOf('dispose:consumer-b:end');
    const activation = log.indexOf('activate:consumer-c');
    expect(teardownEnd).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(teardownEnd);

    await runtime.dispose();
  });
});

describe('typed configuration soundness', () => {
  it('requiredConfigCannotBeSilentlyOmitted', async () => {
    const runtime = new Runtime();
    const plugin = definePlugin<{ greeting: string }>({
      id: 'typed-config',
      activate(ctx) {
        void ctx.config.greeting.toUpperCase();
        return () => undefined;
      },
    });

    // Compile-time: omitting `config` for a concrete config type is a type
    // error. If the API ever regresses to making config optional, TS2578
    // ("unused @ts-expect-error") fails the typecheck target.
    // @ts-expect-error — config is required for concrete config types
    await runtime.registerSlot({ id: 'typed-config-omitted', plugin });

    // Runtime defense for JS callers (or cast callers): a missing config
    // fails activation loudly instead of silently binding an unusable
    // service.
    const slot = await runtime.registerSlot({
      id: 'typed-config-undefined',
      plugin,
      config: undefined as never,
    });
    expect(slot.state).toBe('failed');
    expect(slot.failure?.phase).toBe('activation');

    await runtime.dispose();
  });
});

describe('replacement semantics', () => {
  it('replacementAfterRetirementReactivatesFreshConsumers', async () => {
    const runtime = new Runtime();
    const log: string[] = [];
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    const consumer = await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeConsumer('consumer-b', [tokenX], tokenY, { log }),
    });
    const firstFiberId = consumer.fiberId;

    await runtime.removeSlot('provider-a');
    await runtime.registerSlot({
      id: 'provider-a2',
      plugin: makeProvider('provider-a2', tokenX, 'x2', { log }),
    });

    // The consumer was torn down and reactivated into a fresh fiber bound to
    // the replacement provider's capability.
    expect(consumer.state).toBe('active');
    expect(consumer.fiberId).not.toBe(firstFiberId);
    const binding = runtime
      .inspect()
      .bindings.find((entry) => entry.token.id === tokenY.id);
    expect((binding?.implementation as { label: string }).label).toBe(
      'consumer-b(x2)',
    );
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'dispose:consumer-b',
      'dispose:provider-a',
      'activate:provider-a2',
      'activate:consumer-b',
    ]);

    await runtime.dispose();
  });
});

describe('token validation', () => {
  it('rejects obviously invalid token ids', () => {
    expect(() => createServiceToken('')).toThrow(TypeError);
    expect(() => createServiceToken('valid.id')).not.toThrow();
  });
});
