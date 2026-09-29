import { describe, expect, it } from 'vitest';
import { Runtime } from './runtime.js';
import { createServiceToken } from './services.js';
import { definePlugin } from './types.js';
import { createServiceProbe } from './service-probe.js';

describe('service probe', () => {
  it('captures on activate, clears on dispose, and recaptures a replacement', async () => {
    const token = createServiceToken<string>('test.live-service');
    const runtime = new Runtime();
    const probe = createServiceProbe({ pluginId: 'test.live-probe', token });

    await runtime.registerSlot({ id: 'probe', plugin: probe.plugin });
    expect(probe.get()).toBeNull();

    await runtime.registerSlot({
      id: 'provider',
      plugin: definePlugin({
        id: 'test.provider.one',
        activate: (ctx) => ctx.provide(token, 'one'),
      }),
    });
    expect(probe.get()).toBe('one');

    await runtime.removeSlot('provider');
    expect(probe.get()).toBeNull();

    await runtime.registerSlot({
      id: 'provider',
      plugin: definePlugin({
        id: 'test.provider.two',
        activate: (ctx) => ctx.provide(token, 'two'),
      }),
    });
    expect(probe.get()).toBe('two');

    await runtime.dispose();
    expect(probe.get()).toBeNull();
  });

  it('keeps captures instance-owned', async () => {
    const token = createServiceToken<object>('test.isolated-service');
    const firstRuntime = new Runtime();
    const secondRuntime = new Runtime();
    const firstProbe = createServiceProbe({ pluginId: 'test.first-probe', token });
    const secondProbe = createServiceProbe({ pluginId: 'test.second-probe', token });
    const first = {};
    const second = {};

    await firstRuntime.registerSlot({ id: 'probe', plugin: firstProbe.plugin });
    await secondRuntime.registerSlot({ id: 'probe', plugin: secondProbe.plugin });
    await firstRuntime.registerSlot({
      id: 'provider',
      plugin: definePlugin({
        id: 'test.first-provider',
        activate: (ctx) => ctx.provide(token, first),
      }),
    });
    await secondRuntime.registerSlot({
      id: 'provider',
      plugin: definePlugin({
        id: 'test.second-provider',
        activate: (ctx) => ctx.provide(token, second),
      }),
    });

    expect(firstProbe.get()).toBe(first);
    expect(secondProbe.get()).toBe(second);
    await firstRuntime.dispose();
    expect(firstProbe.get()).toBeNull();
    expect(secondProbe.get()).toBe(second);
    await secondRuntime.dispose();
  });

  it('supports explicit capture release without touching provider ownership', async () => {
    const token = createServiceToken<string>('test.clear-service');
    const runtime = new Runtime();
    const probe = createServiceProbe({ pluginId: 'test.clear-probe', token });
    await runtime.registerSlot({
      id: 'provider',
      plugin: definePlugin({
        id: 'test.clear-provider',
        activate: (ctx) => ctx.provide(token, 'value'),
      }),
    });
    await runtime.registerSlot({ id: 'probe', plugin: probe.plugin });

    expect(probe.get()).toBe('value');
    probe.clear();
    expect(probe.get()).toBeNull();

    await runtime.dispose();
  });
});
