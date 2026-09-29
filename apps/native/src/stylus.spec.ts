// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  STYLUS_NATIVE_EVENT_CHANNEL,
  stylusToken,
} from '@froglight/foundation';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  createNativeStylus,
  installNativeStylusEventForwarder,
  seedStylusCapabilitiesFromNative,
  createNativeStylusInputContextAdapter,
  STYLUS_SET_INPUT_CONTEXT_COMMAND,
  installStylusTextEntryFocus,
} from './stylus.js';

describe('native stylus adapter', () => {
  it('forwards direct-eval native events into the service', () => {
    const host = createNativeStylus();
    const scope: Record<string, unknown> = {};
    const uninstall = installNativeStylusEventForwarder(host.service, scope);
    const hook = scope[STYLUS_NATIVE_EVENT_CHANNEL] as (
      event: string,
      payload: unknown,
    ) => void;
    expect(typeof hook).toBe('function');
    hook('capabilities', {
      available: true,
      pressure: true,
      tilt: true,
      twist: true,
      hover: true,
      eraser: true,
      barrelButton: true,
      doubleTap: true,
      squeeze: true,
    });
    expect(host.service.capabilities()).toMatchObject({
      available: true,
      squeeze: true,
    });
    const seen: string[] = [];
    host.service.onAction((action) => seen.push(action.type));
    hook('action', { type: 'doubleTap' });
    hook('action', { type: 'squeeze', phase: 'ended' });
    hook('bogus', { type: 'doubleTap' });
    expect(seen).toEqual(['doubleTap', 'squeeze']);
    uninstall();
    expect(scope[STYLUS_NATIVE_EVENT_CHANNEL]).toBeUndefined();
    uninstall();
  });

  it('provides the token binding through the runtime lifecycle', async () => {
    const runtime = new Runtime();
    const host = createNativeStylus();
    await runtime.registerSlot({
      id: 'stylus',
      plugin: host.definition,
    });
    let seen = false;
    await runtime.registerSlot({
      id: 'stylus-consumer',
      plugin: definePlugin({
        id: 'froglight.stylus.native-consumer',
        requirements: { requires: [stylusToken] },
        activate: (ctx) => {
          seen = ctx.require(stylusToken) === host.service;
        },
      }),
    });
    expect(seen).toBe(true);
    await runtime.dispose();
  });

  it('seeds capabilities via get_capabilities after late forwarder install', async () => {
    const host = createNativeStylus();
    // Native emitted during plugin load before the forwarder existed: the
    // service still holds defaults.
    expect(host.service.capabilities().available).toBe(false);
    const scope: Record<string, unknown> = {};
    const uninstall = installNativeStylusEventForwarder(host.service, scope);
    try {
      const seeded = await seedStylusCapabilitiesFromNative(
        host.service,
        async () => ({
          available: true,
          pressure: true,
          tilt: true,
          twist: false,
          hover: true,
          eraser: true,
          barrelButton: true,
          doubleTap: false,
          squeeze: false,
        }),
      );
      expect(seeded).toBe(true);
      expect(host.service.capabilities()).toMatchObject({
        available: true,
        twist: false,
      });
    } finally {
      uninstall();
    }
  });

  it('ignores malformed get_capabilities reports', async () => {
    const host = createNativeStylus();
    const seeded = await seedStylusCapabilitiesFromNative(
      host.service,
      async () => ({ available: true }),
    );
    expect(seeded).toBe(false);
    expect(host.service.capabilities().available).toBe(false);
  });
});

describe('native stylus input context', () => {
  it('seeds default on activation and deduplicates the same state', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const set = createNativeStylusInputContextAdapter(invoke);
    await set('default');
    await set('default');
    expect(invoke.mock.calls).toEqual([
      [STYLUS_SET_INPUT_CONTEXT_COMMAND, { context: 'default' }],
    ]);
  });

  it('sends validated transitions once, in order, including rapid changes', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const set = createNativeStylusInputContextAdapter(invoke);
    await Promise.all([
      set('drawing'),
      set('drawing'),
      set('text-entry'),
      set('default'),
    ]);
    expect(invoke.mock.calls).toEqual([
      [STYLUS_SET_INPUT_CONTEXT_COMMAND, { context: 'drawing' }],
      [STYLUS_SET_INPUT_CONTEXT_COMMAND, { context: 'text-entry' }],
      [STYLUS_SET_INPUT_CONTEXT_COMMAND, { context: 'default' }],
    ]);
    await expect(set('invalid' as never)).rejects.toThrow(
      'Invalid stylus input context',
    );
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('reports transport failures and permits retry without poisoning later transitions', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(undefined);
    const set = createNativeStylusInputContextAdapter(invoke);
    expect(await set('drawing')).toBe(false);
    expect(await set('drawing')).toBe(true);
    expect(await set('text-entry')).toBe(true);
    expect(await set('default')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('allows ordinary fields and contenteditable text while a drawing pane is mounted', () => {
    const host = createNativeStylus();
    const drawing = host.service.acquireInputContext('drawing');
    const input = document.createElement('input');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('contenteditable', 'true');
    editor.tabIndex = 0;
    const button = document.createElement('button');
    document.body.append(input, editor, button);
    const dispose = installStylusTextEntryFocus(host.service, document);
    try {
      input.focus();
      expect(host.service.inputContext()).toBe('text-entry');
      editor.focus();
      expect(host.service.inputContext()).toBe('text-entry');
      button.focus();
      expect(host.service.inputContext()).toBe('drawing');
      input.focus();
      dispose();
      dispose();
      expect(host.service.inputContext()).toBe('drawing');
    } finally {
      dispose();
      drawing();
      input.remove();
      editor.remove();
      button.remove();
    }
    expect(host.service.inputContext()).toBe('default');
  });

  it('binds policy publication to runtime activation and disposal', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const host = createNativeStylus(invoke);
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'stylus', plugin: host.definition });
    host.service.acquireInputContext('drawing');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(STYLUS_SET_INPUT_CONTEXT_COMMAND, {
        context: 'drawing',
      }),
    );
    await runtime.dispose();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(
        STYLUS_SET_INPUT_CONTEXT_COMMAND,
        { context: 'default' },
      ),
    );
    const count = invoke.mock.calls.length;
    host.service.acquireInputContext('text-entry');
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(count);
  });
});
