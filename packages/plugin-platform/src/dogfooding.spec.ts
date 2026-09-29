import { describe, it, expect } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  commandsToken,
  createMemoryVault,
  settingsToken,
  vaultToken,
} from '@froglight/foundation';
import { CommunityPluginManager, type PluginCodeLoader } from './community.js';
import { DOGFOOD_MANIFEST, createDogfoodActivate } from './dogfooding.js';

function createCommandRegistry() {
  const registered = new Set<string>();
  return {
    register(command: { id: string }) {
      registered.add(command.id);
      return { dispose: () => registered.delete(command.id) };
    },
    ids: () => [...registered],
  };
}

describe('SDK dogfooding — first-party feature via @froglight/sdk only', () => {
  it('loads through the vault-backed manager and withdraws its SDK capability', async () => {
    const runtime = new Runtime();
    const vault = createMemoryVault().vault;
    const commands = createCommandRegistry();
    await runtime.registerSlot({
      id: 'plugin-services',
      plugin: definePlugin({
        id: 'test.plugin-services',
        activate: (ctx) => {
          ctx.provide(vaultToken, vault);
          ctx.provide(commandsToken, commands as never);
          ctx.provide(settingsToken, { get: () => undefined } as never);
        },
      }),
    });

    const manager = new CommunityPluginManager({ runtime });
    await manager.attach(vault);
    const activate = createDogfoodActivate();
    const loader: PluginCodeLoader = async () => (facades) =>
      activate({ facades } as never);
    manager.setLoader(loader);
    await manager.install({ manifestJson: DOGFOOD_MANIFEST, code: 'dogfood' });
    await manager.enable(DOGFOOD_MANIFEST.id);

    expect(manager.list()[0]?.state).toBe('active');
    expect(commands.ids()).toEqual(['froglight.dogfood.ping']);
    expect(
      runtime
        .inspect()
        .slots.find((slot) => slot.id === `community:${DOGFOOD_MANIFEST.id}`)
        ?.state,
    ).toBe('active');

    await manager.disable(DOGFOOD_MANIFEST.id);
    expect(commands.ids()).toEqual([]);
    await manager.enable(DOGFOOD_MANIFEST.id);
    expect(manager.list()[0]?.state).toBe('active');
    expect(commands.ids()).toEqual(['froglight.dogfood.ping']);

    await manager.detach();
    await runtime.dispose();
  });
});
