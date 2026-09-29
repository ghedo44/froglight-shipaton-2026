import { describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  createStylusMenuRegistry,
  stylusMenuRegistryPlugin,
  stylusMenuRegistryToken,
  type StylusMenuContext,
} from './stylus-menu-registry.js';

const context = (
  kindId: string | null = 'froglight.ink',
): StylusMenuContext => ({
  pane: 'main',
  documentId: 'doc-1',
  kindId,
});

const run = vi.fn();

describe('stylus menu registry', () => {
  it('owns reversible contextual contributions in deterministic order', () => {
    const created = createStylusMenuRegistry();
    const registration = created.registry.register({
      id: 'acme.stylus-tools',
      order: 2,
      when: ({ kindId }) => kindId === 'froglight.ink',
      entries: () => [{ label: 'Ink recipe', run }],
    });
    created.registry.register({
      id: 'acme.global-tools',
      order: 1,
      entries: () => [{ label: 'Global recipe', run }],
    });

    expect(created.registry.entries(context('froglight.markdown'))).toEqual([
      { label: 'Global recipe', run },
    ]);
    const ink = created.registry.entries(context('froglight.ink'));
    expect(
      ink.map((entry) => (entry === 'separator' ? entry : entry.label)),
    ).toEqual(['Global recipe', 'Ink recipe']);
    // Ownership resolves per entry index for diagnostics.
    expect(created.registry.ownerOf(context('froglight.ink'), 0)).toBe(
      'acme.global-tools',
    );
    expect(created.registry.ownerOf(context('froglight.ink'), 1)).toBe(
      'acme.stylus-tools',
    );
    expect(created.registry.ownerOf(context('froglight.ink'), 2)).toBeNull();

    registration.dispose();
    expect(created.registry.entries(context('froglight.ink'))).toEqual([
      { label: 'Global recipe', run },
    ]);
    created.dispose();
  });

  it('restores a shadowed contribution when its replacement disposes', () => {
    const created = createStylusMenuRegistry();
    const first = created.registry.register({
      id: 'acme.palette',
      entries: () => [{ label: 'First' }],
    });
    const replacement = created.registry.register({
      id: 'acme.palette',
      entries: () => [{ label: 'Second' }],
    });

    expect(created.registry.entries(context())[0]).toMatchObject({
      label: 'Second',
    });
    replacement.dispose();
    expect(created.registry.entries(context())[0]).toMatchObject({
      label: 'First',
    });
    first.dispose();
    expect(created.registry.entries(context())).toEqual([]);
  });

  it('notifies listeners on register and dispose', () => {
    const created = createStylusMenuRegistry();
    let calls = 0;
    const subscription = created.registry.onDidChange(() => {
      calls += 1;
    });
    const registration = created.registry.register({
      id: 'acme.palette',
      entries: () => [],
    });
    registration.dispose();
    subscription.dispose();
    expect(calls).toBe(2);
  });

  it('provides the token binding through the runtime lifecycle', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'stylus-menu-registry',
      plugin: stylusMenuRegistryPlugin,
    });
    let observed = false;
    await runtime.registerSlot({
      id: 'stylus-menu-consumer',
      plugin: definePlugin({
        id: 'froglight.stylus-menu.consumer',
        requirements: { requires: [stylusMenuRegistryToken] },
        activate: (ctx) => {
          const registry = ctx.require(stylusMenuRegistryToken);
          const registration = registry.register({
            id: 'acme.probe',
            entries: () => [{ label: 'Probe' }],
          });
          observed = registry.entries(context()).length === 1;
          ctx.effect(() => () => registration.dispose());
        },
      }),
    });
    expect(observed).toBe(true);
    await runtime.dispose();
  });
});
