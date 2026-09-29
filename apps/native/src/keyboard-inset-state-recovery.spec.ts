// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachKeyboardShell, detachKeyboardShell } from '@froglight/ui';
import {
  KEYBOARD_INSET_STATE_COMMAND,
  createNativeKeyboardInset,
  syncNativeKeyboardInsetState,
} from './keyboard-inset.js';
import { attachNativeKeyboardGuards } from './keyboard-guards.js';

afterEach(() => {
  detachKeyboardShell();
  document.documentElement.style.removeProperty('--fl-keyboard-inset-height');
  document.body.replaceChildren();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('native keyboard cached-state recovery', () => {
  it('repairs a missed push through cached native state into shell CSS', async () => {
    const call = vi.fn().mockResolvedValue({
      height: 336,
      isOpen: true,
      isHiding: false,
    });
    const host = createNativeKeyboardInset(
      vi.fn().mockResolvedValue(undefined),
    );
    const detach = attachKeyboardShell({ store: host.store, reduceMotion: true });
    try {
      await syncNativeKeyboardInsetState(host.store, call);
      expect(call).toHaveBeenCalledWith(KEYBOARD_INSET_STATE_COMMAND);
      expect(host.store.snapshot()).toMatchObject({ height: 336, isOpen: true });
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-keyboard-inset-height',
        ),
      ).toBe('336px');
    } finally {
      detach();
      host.store.dispose();
    }
  });

  it('keeps portable zero readback non-authoritative', async () => {
    const host = createNativeKeyboardInset(
      vi.fn().mockResolvedValue(undefined),
    );
    host.store.handleNativeEvent('target', {
      height: 320,
      durationMs: 250,
      measurement: 'exact',
    });
    const call = vi.fn().mockResolvedValue({
      height: 0,
      isOpen: false,
      isHiding: false,
    });

    await syncNativeKeyboardInsetState(host.store, call);
    await syncNativeKeyboardInsetState(host.store, call);
    expect(host.store.snapshot()).toMatchObject({ height: 320, isOpen: true });
    host.store.dispose();
  });

  it('never reopens from a read taken while native hide is in progress', async () => {
    const host = createNativeKeyboardInset(
      vi.fn().mockResolvedValue(undefined),
    );
    const call = vi.fn().mockResolvedValue({
      height: 300,
      isOpen: false,
      isHiding: true,
    });

    await syncNativeKeyboardInsetState(host.store, call);
    expect(host.store.snapshot()).toMatchObject({ height: 0, isOpen: false });
    host.store.dispose();
  });

  it('does not gate trusted readback on browser iOS user-agent detection', async () => {
    const host = createNativeKeyboardInset(
      vi.fn().mockResolvedValue(undefined),
    );
    const call = vi.fn().mockResolvedValue({
      height: 318,
      isOpen: true,
      isHiding: false,
    });
    const input = document.createElement('input');
    document.body.append(input);
    const detach = attachNativeKeyboardGuards({
      store: host.store,
      doc: document,
      isNativeHost: () => true,
      // Simulate an unexpected WKWebView navigator identity. Readback must
      // still run because Tauri, not browser UA, is the trust boundary.
      isIos: () => false,
      stateCall: call,
    });
    try {
      input.focus();
      await tick();
      expect(call).toHaveBeenCalledWith(KEYBOARD_INSET_STATE_COMMAND);
      expect(host.store.snapshot()).toMatchObject({ height: 318, isOpen: true });
    } finally {
      detach();
      host.store.dispose();
    }
  });

  it('pins one canonical iOS geometry source plus cached get_state recovery', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const plugin = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/ios/Sources/FroglightKeyboardInsetPlugin.swift',
      ),
      'utf8',
    );
    const commands = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/src/commands.rs',
      ),
      'utf8',
    );
    const build = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/build.rs',
      ),
      'utf8',
    );
    const adapter = readFileSync(resolve(here, 'keyboard-inset.ts'), 'utf8');

    expect(plugin).toContain('notification.object as? UIScreen');
    expect(plugin).toContain('coordinateSpace.convert');
    expect(plugin).toContain('Only bottom-edge occlusion counts');
    expect(plugin).toContain('@objc public func getState');
    expect(plugin).toContain('KeyboardInsetStateResponse');
    expect(plugin).not.toContain('keyboardLayoutGuide');
    expect(plugin).not.toContain('screenSpaceKeyboardInset');
    expect(plugin).not.toContain('dockedPhoneFallbackInset');

    expect(commands).toContain('pub height: f64');
    expect(commands).not.toContain('layout_guide_height');
    expect(commands).not.toContain('effective_height');
    expect(commands).toContain('pub async fn get_state');
    expect(build).toContain('"get_state"');

    expect(adapter).not.toContain('installNativeKeyboardViewportFallback');
    expect(adapter).not.toContain('nativeVisualViewportKeyboardInset');
  });
});
