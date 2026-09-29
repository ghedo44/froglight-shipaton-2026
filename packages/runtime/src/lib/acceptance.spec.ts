/**
 *  acceptance scenario: provider replacement with a dependency chain.
 *
 * ```text
 * Provider A  →  Service A
 * Consumer B requires A  →  provides Service B
 * Consumer C requires B  →  provides Service C
 * Consumer D requires C
 * ```
 *
 * Replacing Provider A with Provider A2 while the runtime process remains
 * alive must:
 *
 * - dispose affected consumers in dependency-safe order;
 * - remove all owned effects/services/listeners from old fibers;
 * - activate A2;
 * - activate new B/C/D fibers after requirements return;
 * - leave exactly one expected registration per token;
 * - leave no dangling binding/effect/fiber;
 * - leave the runtime in a consistent inspectable state after failed
 *   activation/cleanup cases.
 */

import { describe, expect, it } from 'vitest';

import { DuplicateBindingError, Runtime } from '../index.js';

import {
  makeConsumer,
  makeFailing,
  makeLeaf,
  makePartialFailing,
  makeProvider,
  makeThrowingCleanup,
  tokenA,
  tokenB,
  tokenC,
  tokenX,
  tokenY,
  tokenZ,
} from '../test/fixtures.js';

/** Assert the runtime holds no dangling resources. */
function expectClean(runtime: Runtime): void {
  const inspection = runtime.inspect();
  expect(inspection.counts.activeFibers).toBe(0);
  expect(inspection.counts.bindings).toBe(0);
  expect(inspection.counts.subscriptions).toBe(0);
  expect(inspection.counts.effects).toBe(0);
  expect(runtime.bus.subscriptionCount).toBe(0);
}

describe('acceptance: provider replacement', () => {
  it('reconciles the full dependency chain when the root provider is replaced', async () => {
    const runtime = new Runtime();
    const log: string[] = [];

    // Build the chain: A → B → C → D.
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a', {
        registerListeners: true,
        log,
      }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeConsumer('consumer-b', [tokenA], tokenB, {
        registerListeners: true,
        log,
      }),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeConsumer('consumer-c', [tokenB], tokenC, {
        registerListeners: true,
        log,
      }),
    });
    await runtime.registerSlot({
      id: 'consumer-d',
      plugin: makeLeaf('consumer-d', [tokenC], { log }),
    });

    // Steady state: every slot active, exactly one binding per token.
    let inspection = runtime.inspect();
    expect(inspection.slots.map((s) => s.state)).toEqual([
      'active',
      'active',
      'active',
      'active',
    ]);
    expect(inspection.counts.activeFibers).toBe(4);
    expect(inspection.counts.bindings).toBe(3);
    expect(inspection.counts.subscriptions).toBe(3); // A, B, and C register listeners
    expect(inspection.counts.effects).toBe(10); // 3 services + 3 listeners + 4 activation disposers

    const oldFiberIds = new Set(inspection.fibers.map((f) => f.id));
    expect(oldFiberIds.size).toBe(4);

    // Replace Provider A with Provider A2 while the process stays alive.
    await runtime.removeSlot('provider-a');
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a2', {
        registerListeners: true,
        log,
      }),
    });

    // Exact lifecycle order: activations cascade down the chain, teardown
    // runs consumers before providers (D↓C↓B↓A), and the replacement builds
    // a fresh chain in dependency order.
    expect(log).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'activate:consumer-c',
      'activate:consumer-d',
      'dispose:consumer-d',
      'dispose:consumer-c',
      'dispose:consumer-b',
      'dispose:provider-a',
      'activate:provider-a',
      'activate:consumer-b',
      'activate:consumer-c',
      'activate:consumer-d',
    ]);

    // New steady state: all slots active again, no duplicates, no dangling.
    inspection = runtime.inspect();
    expect(inspection.slots.map((s) => s.state)).toEqual([
      'active',
      'active',
      'active',
      'active',
    ]);
    expect(inspection.counts.activeFibers).toBe(4);
    expect(inspection.counts.bindings).toBe(3);
    expect(inspection.counts.subscriptions).toBe(3);
    expect(inspection.counts.effects).toBe(10);

    // Every fiber is a fresh instance; no old fiber survived.
    const newFiberIds = new Set(inspection.fibers.map((f) => f.id));
    expect(newFiberIds.size).toBe(4);
    for (const id of oldFiberIds) {
      expect(newFiberIds.has(id)).toBe(false);
    }

    // The new chain resolved the replacement provider's capability.
    const bindingA = inspection.bindings.find((b) => b.token.id === tokenA.id);
    const bindingB = inspection.bindings.find((b) => b.token.id === tokenB.id);
    const bindingC = inspection.bindings.find((b) => b.token.id === tokenC.id);
    expect((bindingA?.implementation as { label: string }).label).toBe('a2');
    expect((bindingB?.implementation as { label: string }).label).toBe(
      'consumer-b(a2)',
    );
    expect((bindingC?.implementation as { label: string }).label).toBe(
      'consumer-c(consumer-b(a2))',
    );

    // Exactly one binding per token.
    const tokenIds = inspection.bindings.map((b) => b.token.id);
    expect(tokenIds.filter((id) => id === tokenA.id)).toHaveLength(1);
    expect(tokenIds.filter((id) => id === tokenB.id)).toHaveLength(1);
    expect(tokenIds.filter((id) => id === tokenC.id)).toHaveLength(1);

    await runtime.dispose();
    expectClean(runtime);
  });

  it('disposes the whole chain when the root provider is removed', async () => {
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
    await runtime.registerSlot({
      id: 'consumer-d',
      plugin: makeLeaf('consumer-d', [tokenC]),
    });

    await runtime.removeSlot('provider-a');

    const inspection = runtime.inspect();
    // Slots remain configured; no fiber is active; nothing dangles.
    expect(inspection.slots).toHaveLength(3);
    expect(inspection.slots.every((s) => s.state === 'inactive')).toBe(true);
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);

    await runtime.dispose();
  });

  it('recovers when the replacement provider fails to activate', async () => {
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

    // Replace A with a failing provider: the chain must collapse cleanly and
    // the failure must be attributed to the provider slot.
    await runtime.removeSlot('provider-a');
    const failing = await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeFailing('provider-a'),
    });

    expect(failing.state).toBe('failed');
    expect(failing.failure?.message).toContain('fails on purpose');

    const inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);
    expect(inspection.slots.find((s) => s.id === 'consumer-b')?.state).toBe(
      'inactive',
    );
    expect(inspection.slots.find((s) => s.id === 'consumer-c')?.state).toBe(
      'inactive',
    );

    // A healthy replacement later restores the chain.
    await runtime.removeSlot('provider-a');
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a3'),
    });

    const restored = runtime.inspect();
    expect(restored.slots.every((s) => s.state === 'active')).toBe(true);
    expect(restored.counts.bindings).toBe(3);
    expect(
      (
        restored.bindings.find((b) => b.token.id === tokenB.id)
          ?.implementation as { label: string }
      ).label,
    ).toBe('consumer-b(a3)');

    await runtime.dispose();
    expectClean(runtime);
  });

  it('leaves a consistent inspectable state after partial activation failure', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a'),
    });
    const partial = await runtime.registerSlot({
      id: 'partial',
      plugin: makePartialFailing('partial'),
    });

    expect(partial.state).toBe('failed');
    const inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(1); // only provider-a
    expect(inspection.counts.bindings).toBe(1); // only service A
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(2); // service effect + activation disposer
    expect(runtime.bus.subscriptionCount).toBe(0);

    await runtime.dispose();
    expectClean(runtime);
  });

  it('reports cleanup failures without leaving dangling registrations', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a'),
    });
    await runtime.registerSlot({
      id: 'dirty',
      plugin: makeThrowingCleanup('dirty'),
    });

    await expect(runtime.dispose()).rejects.toThrow(/disposal failed/);

    const inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(0);
    expect(inspection.counts.bindings).toBe(0);
    expect(inspection.counts.subscriptions).toBe(0);
    expect(inspection.counts.effects).toBe(0);
  });

  it('rejects a duplicate provider for the same token and keeps the first', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a'),
    });
    const duplicate = await runtime.registerSlot({
      id: 'provider-a2',
      plugin: makeProvider('provider-a2', tokenA, 'a2'),
    });

    expect(duplicate.state).toBe('failed');
    expect(duplicate.failure?.error).toBeInstanceOf(DuplicateBindingError);

    const inspection = runtime.inspect();
    expect(inspection.counts.bindings).toBe(1);
    expect(
      (inspection.bindings[0]?.implementation as { label: string }).label,
    ).toBe('a');

    await runtime.dispose();
    expectClean(runtime);
  });

  it('keeps the runtime usable after a failed slot (no crash loop)', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'bad', plugin: makeFailing('bad') });
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenA, 'a'),
    });
    const consumer = await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeConsumer('consumer-b', [tokenA], tokenB),
    });

    expect(consumer.state).toBe('active');
    expect(runtime.inspect().counts.activeFibers).toBe(2);

    await runtime.dispose();
    expectClean(runtime);
  });
});

describe('acceptance: non-linear topologies', () => {
  it('diamond: teardown in true dependency order, reactivation rebuilds the chain', async () => {
    const runtime = new Runtime();
    const log: string[] = [];

    // Non-linear chain:
    //   A provides X
    //   B requires X  provides Y
    //   C requires X+Y provides Z
    //   D requires Z
    // BFS depth would tie B and C at depth 1; the true topological order
    // disposes C before B, because C consumes B's Y.
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

    // Replacement reactivates the whole diamond into fresh fibers.
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x2', { log }),
    });
    expect(log.slice(8)).toEqual([
      'activate:provider-a',
      'activate:consumer-b',
      'activate:consumer-c',
      'activate:consumer-d',
    ]);
    const inspection = runtime.inspect();
    expect(inspection.counts.activeFibers).toBe(4);
    expect(inspection.counts.bindings).toBe(3); // X, Y, Z
    const zBinding = inspection.bindings.find(
      (entry) => entry.token.id === tokenZ.id,
    );
    expect((zBinding?.implementation as { label: string }).label).toBe(
      'consumer-c(x2,consumer-b(x2))',
    );

    await runtime.dispose();
    expectClean(runtime);
  });

  it('siblings: incomparable consumers dispose in deterministic order', async () => {
    const runtime = new Runtime();
    const log: string[] = [];

    // A provides X; B and C both consume X. B and C are incomparable in the
    // dependency order; the documented tie rule emits them in descending
    // fiber-id order (the reversal of the ascending Kahn ready queue), so
    // the sequence is fully deterministic.
    await runtime.registerSlot({
      id: 'provider-a',
      plugin: makeProvider('provider-a', tokenX, 'x', { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-b',
      plugin: makeLeaf('consumer-b', [tokenX], { log }),
    });
    await runtime.registerSlot({
      id: 'consumer-c',
      plugin: makeLeaf('consumer-c', [tokenX], { log }),
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
    expectClean(runtime);
  });
});
