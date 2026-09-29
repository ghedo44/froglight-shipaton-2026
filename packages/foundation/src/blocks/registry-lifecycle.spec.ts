/**
 * Effect ownership of Block Type registrations:
 * activate → one registration, dispose → zero, reactivate → one.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { blockRegistryToken } from '../tokens.js';
import { InMemoryBlockRegistry } from './registry.js';
import type { BlockRegistry } from './registry.js';

describe('block registry effect ownership', () => {
  it('registrations follow the fiber lifecycle across slot replacement', async () => {
    const runtime = new Runtime();
    const registry = new InMemoryBlockRegistry();
    let live: BlockRegistry | null = null;

    const registryBinding = definePlugin({
      id: 'froglight.block-registry.binding',
      activate: (ctx) => {
        live = registry;
        ctx.provide(blockRegistryToken, registry);
      },
    });
    const blockTypesPlugin = definePlugin({
      id: 'acme.block-types',
      requirements: { requires: [blockRegistryToken] },
      activate: (ctx) => {
        const reg = ctx.require(blockRegistryToken);
        ctx.effect(() => reg.register({ typeId: 'acme.callout', version: 1 }).dispose);
      },
    });

    await runtime.registerSlot({ id: 'block-registry', plugin: registryBinding });
    const slot = await runtime.registerSlot({ id: 'acme-types', plugin: blockTypesPlugin });
    expect(live!.list()).toHaveLength(1);

    // Dispose → zero registrations.
    await runtime.removeSlot(slot.id);
    expect(live!.list()).toHaveLength(0);

    // Reactivate → exactly one registration again (hot-reload invariant).
    await runtime.registerSlot({ id: 'acme-types', plugin: blockTypesPlugin });
    expect(live!.list()).toEqual([expect.objectContaining({ typeId: 'acme.callout', version: 1 })]);

    await runtime.dispose();
  });

  it('presentation hints survive the fiber lifecycle and clear on dispose', async () => {
    const runtime = new Runtime();
    const registry = new InMemoryBlockRegistry();
    let live: BlockRegistry | null = null;

    const registryBinding = definePlugin({
      id: 'froglight.block-registry.binding',
      activate: (ctx) => {
        live = registry;
        ctx.provide(blockRegistryToken, registry);
      },
    });
    const blockTypesPlugin = definePlugin({
      id: 'acme.block-types',
      requirements: { requires: [blockRegistryToken] },
      activate: (ctx) => {
        const reg = ctx.require(blockRegistryToken);
        ctx.effect(
          () =>
            reg.register({
              typeId: 'acme.callout',
              version: 1,
              label: 'Callout',
              hint: 'Highlighted note block',
            }).dispose,
        );
      },
    });

    await runtime.registerSlot({ id: 'block-registry', plugin: registryBinding });
    const slot = await runtime.registerSlot({ id: 'acme-types', plugin: blockTypesPlugin });
    expect(live!.get('acme.callout')).toMatchObject({ label: 'Callout', hint: 'Highlighted note block' });

    await runtime.removeSlot(slot.id);
    expect(live!.list()).toHaveLength(0);

    await runtime.registerSlot({ id: 'acme-types', plugin: blockTypesPlugin });
    expect(live!.list()).toEqual([
      expect.objectContaining({ typeId: 'acme.callout', label: 'Callout' }),
    ]);

    await runtime.dispose();
  });
});
