import { describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { replaceSlots } from './replace-slot.js';

describe('replace-slot helper', () => {
  it('removes probes before providers and registers providers before probes', async () => {
    const order: string[] = [];
    const runtime = {
      removeSlot: async (id: string) => {
        order.push(`remove:${id}`);
      },
      registerSlot: async (slot: { id: string }) => {
        order.push(`register:${slot.id}`);
      },
    } as unknown as Runtime;

    await replaceSlots(runtime, {
      providerSlotIds: ['provider'],
      probeSlotIds: ['probe'],
      clearCaptures: () => {
        order.push('clear');
      },
      registerProviders: async () => {
        await runtime.registerSlot({ id: 'provider', plugin: undefined as never });
      },
      registerProbes: async () => {
        await runtime.registerSlot({ id: 'probe', plugin: undefined as never });
      },
      afterReplace: () => {
        order.push('after');
      },
    });

    expect(order).toEqual([
      'remove:probe',
      'remove:provider',
      'clear',
      'register:provider',
      'register:probe',
      'after',
    ]);
  });

  it('tolerates absent slots and null replacements', async () => {
    const runtime = new Runtime();
    const after = vi.fn();
    await replaceSlots(runtime, {
      providerSlotIds: ['missing-provider'],
      probeSlotIds: ['missing-probe'],
      registerProviders: async () => {
        /* test double: nothing to register */
      },
      afterReplace: after,
    });
    expect(after).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('enforces one active registration after replacement', async () => {
    const runtime = new Runtime();
    let active = 0;
    const providerPlugin = (value: string) =>
      definePlugin({
        id: `test.provider.${value}`,
        activate: () => {
          active += 1;
        },
      });

    await runtime.registerSlot({ id: 'provider', plugin: providerPlugin('one') });
    await replaceSlots(runtime, {
      providerSlotIds: ['provider'],
      registerProviders: async () => {
        await runtime.registerSlot({
          id: 'provider',
          plugin: providerPlugin('two'),
        });
      },
    });
    const slots = runtime.inspect().slots.filter((slot) => slot.id === 'provider');
    expect(slots).toHaveLength(1);
    expect(slots[0]?.state).toBe('active');
    await runtime.dispose();
  });
});
