/**
 * Lifecycle unit tests: slot/fiber semantics, effect ownership, event
 * subscriptions, failure paths, and child scopes.
 */

import { describe, expect, it } from 'vitest';

import {
  AggregateRuntimeError,
  DuplicateBindingError,
  DuplicateSlotError,
  Runtime,
  createServiceToken,
} from '../index.js';

import {
  makeConsumer,
  makeFailing,
  makeLeaf,
  makePartialFailing,
  makeProvider,
  makeThrowingCleanup,
  tokenA,
  tokenB,
} from '../test/fixtures.js';

describe('plugin slots', () => {
  it('keeps a slot inactive while a required service is unavailable', async () => {
    const runtime = new Runtime();
    const slot = await runtime.registerSlot({
      id: 'consumer',
      plugin: makeConsumer('consumer', [tokenA], tokenB),
    });

    expect(slot.state).toBe('inactive');
    expect(runtime.inspect().slots).toHaveLength(1);
    expect(runtime.inspect().counts.activeFibers).toBe(0);
    expect(runtime.inspect().counts.bindings).toBe(0);

    await runtime.dispose();
  });

  it('rejects duplicate slot ids', async () => {
    const runtime = new Runtime();
    const plugin = makeProvider('provider', tokenA, 'a');
    await runtime.registerSlot({ id: 'slot', plugin });

    await expect(
      runtime.registerSlot({
        id: 'slot',
        plugin: makeProvider('other', tokenA, 'a2'),
      }),
    ).rejects.toBeInstanceOf(DuplicateSlotError);

    await runtime.dispose();
  });

  it('disposes the fiber and detaches the slot on removeSlot', async () => {
    const runtime = new Runtime();
    const slot = await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a'),
    });
    expect(slot.state).toBe('active');

    await runtime.removeSlot('provider');

    expect(runtime.inspect().slots).toHaveLength(0);
    expect(runtime.inspect().counts.activeFibers).toBe(0);
    expect(runtime.inspect().counts.bindings).toBe(0);

    await runtime.dispose();
  });
});

describe('fiber lifecycle', () => {
  it('activates when requirements appear and disposes when they disappear', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a'),
    });
    const consumer = await runtime.registerSlot({
      id: 'consumer',
      plugin: makeConsumer('consumer', [tokenA], tokenB),
    });

    expect(consumer.state).toBe('active');
    const firstFiberId = consumer.fiberId;
    expect(firstFiberId).not.toBeNull();

    // Requirement disappears: consumer fiber must be disposed, slot stays.
    await runtime.removeSlot('provider');
    expect(consumer.state).toBe('inactive');
    expect(consumer.fiberId).toBeNull();
    expect(runtime.inspect().counts.activeFibers).toBe(0);

    await runtime.dispose();
  });

  it('reactivates into a new fiber when the requirement returns', async () => {
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
    expect(consumer.fiberId).toBeNull();

    // Replacement provider: a new fiber must be created, not a reused one.
    const replacement = await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a2'),
    });

    expect(replacement.state).toBe('active');
    expect(consumer.state).toBe('active');
    expect(consumer.fiberId).not.toBeNull();
    expect(consumer.fiberId).not.toBe(firstFiberId);

    await runtime.dispose();
  });

  it('exposes the scoped context with the fiber view', async () => {
    const runtime = new Runtime();
    let seenContext: import('@froglight/runtime').Context | undefined;
    const plugin = {
      id: 'probe',
      activate(ctx: import('@froglight/runtime').Context) {
        seenContext = ctx;
        return () => undefined;
      },
    };
    const slot = await runtime.registerSlot({ id: 'probe', plugin });
    expect(slot.state).toBe('active');

    const ctx = seenContext as import('@froglight/runtime').Context;
    expect(ctx.fiber.id).toBe(slot.fiberId);
    expect(ctx.fiber.pluginId).toBe('probe');
    expect(ctx.fiber.state).toBe('active');

    await runtime.dispose();
  });
});

describe('effect scopes', () => {
  it('runs effect cleanups in reverse registration order', async () => {
    const runtime = new Runtime();
    const order: string[] = [];
    const plugin = {
      id: 'ordering',
      activate(ctx: import('@froglight/runtime').Context) {
        ctx.effect({ dispose: () => void order.push('e1') });
        ctx.effect({ dispose: () => void order.push('e2') });
        ctx.effect({ dispose: () => void order.push('e3') });
        return () => undefined;
      },
    };
    await runtime.registerSlot({ id: 'ordering', plugin });

    await runtime.dispose();
    expect(order).toEqual(['e3', 'e2', 'e1']);
  });

  it('runs every cleanup even when one fails, and reports the failure', async () => {
    const runtime = new Runtime();
    const cleanups: string[] = [];
    const plugin = {
      id: 'cleanup-failure',
      activate(ctx: import('@froglight/runtime').Context) {
        ctx.effect({
          dispose: () => {
            throw new Error('boom');
          },
        });
        ctx.effect({ dispose: () => void cleanups.push('ok') });
        return () => undefined;
      },
    };
    const slot = await runtime.registerSlot({ id: 'cleanup-failure', plugin });
    expect(slot.state).toBe('active');

    await expect(runtime.dispose()).rejects.toBeInstanceOf(
      AggregateRuntimeError,
    );
    // Both cleanups ran; the throwing one did not stop the other.
    expect(cleanups).toEqual(['ok']);
  });
});

describe('event bus', () => {
  it('removes subscriptions when the owning fiber is disposed', async () => {
    const runtime = new Runtime();
    const plugin = {
      id: 'listener',
      activate(ctx: import('@froglight/runtime').Context) {
        ctx.on('fixture.ping', () => undefined);
        return () => undefined;
      },
    };
    await runtime.registerSlot({ id: 'listener', plugin });
    expect(runtime.bus.subscriptionCount).toBe(1);

    await runtime.dispose();
    expect(runtime.bus.subscriptionCount).toBe(0);
    expect(runtime.inspect().subscriptions).toHaveLength(0);
  });

  it('broadcasts events to active subscribers', async () => {
    const runtime = new Runtime<{ 'fixture.ping': string }>();
    const received: string[] = [];
    const plugin = {
      id: 'listener',
      activate(
        ctx: import('@froglight/runtime').Context<
          import('@froglight/runtime').PluginConfig,
          { 'fixture.ping': string }
        >,
      ) {
        ctx.on('fixture.ping', (payload) => {
          received.push(payload);
        });
        return () => undefined;
      },
    };
    await runtime.registerSlot({ id: 'listener', plugin });

    runtime.bus.emit('fixture.ping', 'one');
    expect(received).toEqual(['one']);

    await runtime.dispose();
  });
});

describe('service registry', () => {
  it('rejects a second active binding for a single-valued token', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'first',
      plugin: makeProvider('first', tokenA, 'a'),
    });
    const slot = await runtime.registerSlot({
      id: 'second',
      plugin: makeProvider('second', tokenA, 'a2'),
    });

    expect(slot.state).toBe('failed');
    expect(slot.failure?.error).toBeInstanceOf(DuplicateBindingError);
    expect(runtime.inspect().bindings).toHaveLength(1);

    await runtime.dispose();
  });

  it('waits for a dynamically-required service instead of failing permanently', async () => {
    const runtime = new Runtime();
    const plugin = {
      id: 'requires-missing',
      activate(ctx: import('@froglight/runtime').Context) {
        ctx.require(tokenA);
        return () => undefined;
      },
    };
    const slot = await runtime.registerSlot({ id: 'requires-missing', plugin });
    // A dynamic ctx.require that finds its service missing is a wait, not a
    // permanent failure: the slot stays inactive and is retried when the
    // service becomes available.
    expect(slot.state).toBe('inactive');
    expect(slot.failure).toBeNull();
    expect(
      runtime.inspect().slots.find((s) => s.id === 'requires-missing')
        ?.missingRequirements,
    ).toEqual(['fixture.serviceA']);

    // Once the service appears, the slot activates without re-registration.
    await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a'),
    });
    expect(slot.state).toBe('active');
    expect(slot.fiberId).not.toBeNull();

    await runtime.dispose();
  });

  it('withdraws bindings on disposal', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a'),
    });
    expect(runtime.inspect().counts.bindings).toBe(1);

    await runtime.dispose();
    expect(runtime.inspect().counts.bindings).toBe(0);
  });
});

describe('failure paths', () => {
  it('marks the slot failed and leaves the runtime consistent when activation throws', async () => {
    const runtime = new Runtime();
    const slot = await runtime.registerSlot({
      id: 'bad',
      plugin: makeFailing('bad'),
    });
    expect(slot.state).toBe('failed');
    expect(slot.failure?.message).toContain('fails on purpose');
    expect(slot.fiberId).toBeNull();

    const inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);

    await runtime.dispose();
  });

  it('rolls back effects registered before a partial activation failure', async () => {
    const runtime = new Runtime();
    const slot = await runtime.registerSlot({
      id: 'partial',
      plugin: makePartialFailing('partial'),
    });

    expect(slot.state).toBe('failed');
    const inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);
    expect(runtime.bus.subscriptionCount).toBe(0);

    await runtime.dispose();
  });

  it('reports cleanup failures during disposal and still completes', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'dirty',
      plugin: makeThrowingCleanup('dirty'),
    });

    await expect(runtime.dispose()).rejects.toBeInstanceOf(
      AggregateRuntimeError,
    );
    expect(runtime.inspect().counts.activeFibers).toBe(0);
    expect(runtime.inspect().counts.bindings).toBe(0);
  });
});

describe('child scopes', () => {
  it('disposes children when the parent fiber is disposed', async () => {
    const runtime = new Runtime();
    let childSlot: import('@froglight/runtime').PluginSlot | undefined;
    const parent = {
      id: 'parent',
      async activate(ctx: import('@froglight/runtime').Context) {
        childSlot = await ctx.mount({
          id: 'child',
          plugin: makeProvider('child', tokenB, 'child'),
        });
        return () => undefined;
      },
    };
    await runtime.registerSlot({ id: 'parent', plugin: parent });
    expect(childSlot?.state).toBe('active');
    expect(runtime.inspect().counts.activeFibers).toBe(2);

    await runtime.dispose();

    expect(runtime.inspect().counts.activeFibers).toBe(0);
    expect(runtime.inspect().counts.bindings).toBe(0);
    expect(runtime.inspect().slots).toHaveLength(0);
  });

  it('keeps a child inactive while its requirements are unavailable', async () => {
    const runtime = new Runtime();
    let childSlot: import('@froglight/runtime').PluginSlot | undefined;
    const parent = {
      id: 'parent',
      async activate(ctx: import('@froglight/runtime').Context) {
        childSlot = await ctx.mount({
          id: 'child',
          plugin: makeConsumer('child', [tokenA], tokenB),
        });
        return () => undefined;
      },
    };
    await runtime.registerSlot({ id: 'parent', plugin: parent });

    expect(childSlot?.state).toBe('inactive');
    expect(runtime.inspect().counts.activeFibers).toBe(1);

    await runtime.dispose();
  });

  it('activates a child once a provider appears in the shared registry', async () => {
    const runtime = new Runtime();
    let childSlot: import('@froglight/runtime').PluginSlot | undefined;
    const parent = {
      id: 'parent',
      async activate(ctx: import('@froglight/runtime').Context) {
        childSlot = await ctx.mount({
          id: 'child',
          plugin: makeConsumer('child', [tokenA], tokenB),
        });
        return () => undefined;
      },
    };
    await runtime.registerSlot({ id: 'parent', plugin: parent });
    expect(childSlot?.state).toBe('inactive');

    await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a'),
    });

    expect(childSlot?.state).toBe('active');

    await runtime.dispose();
  });
});

describe('typed tokens', () => {
  it('carries stable identity and compiles with typed contracts', () => {
    const token = createServiceToken<{ readonly value: string }>('typed.test');
    expect(token.id).toBe('typed.test');

    const same = createServiceToken<{ readonly value: string }>('typed.test');
    // Identity is by stable id, not object identity.
    expect(same.id).toBe(token.id);
    // Type-level usage compiles:
    const value: { readonly value: string } = { value: 'ok' };
    const _typed: typeof token extends import('@froglight/runtime').ServiceToken<{
      readonly value: string;
    }>
      ? true
      : never = true;
    void value;
    void _typed;
  });

  it('leaf consumer resolves its required capability', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider',
      plugin: makeProvider('provider', tokenA, 'a'),
    });
    const leaf = await runtime.registerSlot({
      id: 'leaf',
      plugin: makeLeaf('leaf', [tokenA]),
    });
    expect(leaf.state).toBe('active');
    await runtime.dispose();
  });
});
