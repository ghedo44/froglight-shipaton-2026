import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  createSettingsSectionRegistry,
  settingsRegistryPlugin,
  settingsRegistryToken,
  type SettingsSectionDef,
} from './settings-registry.js';

function section(id: string, overrides: Partial<SettingsSectionDef> = {}): SettingsSectionDef {
  return {
    id,
    name: overrides.name ?? id,
    component: overrides.component ?? (() => null),
    ...overrides,
  };
}

describe('settings section registry (capability seam)', () => {
  it('is provided by its plugin slot and disposes with its fiber', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'settings-registry', plugin: settingsRegistryPlugin });
    expect(
      runtime.inspect().slots.find((slot) => slot.id === 'settings-registry')?.state,
    ).toBe('active');
    await runtime.dispose();
  });

  it('register → one; dispose → zero; reactivate → one', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'settings-registry', plugin: settingsRegistryPlugin });

    let captured: import('./settings-registry.js').SettingsSectionRegistry | null = null;
    const owner = definePlugin({
      id: 'test.section-owner',
      requirements: { requires: [settingsRegistryToken] },
      activate: (ctx) => {
        const registry = ctx.require(settingsRegistryToken);
        captured = registry;
        ctx.effect(() => registry.register(section('test.section')).dispose);
      },
    });

    await runtime.registerSlot({ id: 'section-owner', plugin: owner });
    expect(captured!.list().map((entry) => entry.id)).toEqual(['test.section']);

    await runtime.removeSlot('section-owner');
    expect(captured!.list()).toEqual([]);

    await runtime.registerSlot({ id: 'section-owner', plugin: owner });
    expect(captured!.list().map((entry) => entry.id)).toEqual(['test.section']);
    await runtime.dispose();
  });

  it('a same-id registration shadows the previous; disposing the replacement restores it', () => {
    const { registry } = createSettingsSectionRegistry();
    const first = section('shared.id', { name: 'First' });
    const second = section('shared.id', { name: 'Second' });

    const firstHandle = registry.register(first);
    const secondHandle = registry.register(second);
    expect(registry.get('shared.id')?.name).toBe('Second');

    secondHandle.dispose();
    expect(registry.get('shared.id')?.name).toBe('First');

    firstHandle.dispose();
    expect(registry.get('shared.id')).toBeUndefined();
  });

  it('lists Options first, then groups alphabetically, honoring order within a group', () => {
    const { registry } = createSettingsSectionRegistry();
    registry.register(section('z.plugin', { name: 'Zeta', group: 'Zeta Plugin' }));
    registry.register(section('editor', { name: 'Editor', group: 'Options', order: 1 }));
    registry.register(section('appearance', { name: 'Appearance', group: 'Options', order: 0 }));
    registry.register(section('about', { name: 'About', group: 'Options', order: 9 }));
    registry.register(section('a.plugin', { name: 'Alpha', group: 'Alpha Plugin' }));

    expect(registry.list().map((entry) => entry.id)).toEqual([
      'appearance',
      'editor',
      'about',
      'a.plugin',
      'z.plugin',
    ]);
  });

  it('defaults unordered sections into a Plugins group after ordered core sections', () => {
    const { registry } = createSettingsSectionRegistry();
    registry.register(section('core', { name: 'Core', group: 'Options', order: 0 }));
    registry.register(section('loose', { name: 'Loose' }));
    expect(registry.list().map((entry) => entry.id)).toEqual(['core', 'loose']);
  });

  it('notifies listeners on every membership change until the listener is disposed', () => {
    const { registry } = createSettingsSectionRegistry();
    const events: string[] = [];
    const subscription = registry.onDidChange(() => events.push('change'));

    const handle = registry.register(section('a.b'));
    expect(events).toEqual(['change']);
    handle.dispose();
    expect(events).toEqual(['change', 'change']);

    subscription.dispose();
    registry.register(section('c.d'));
    expect(events).toEqual(['change', 'change']);
  });
});
