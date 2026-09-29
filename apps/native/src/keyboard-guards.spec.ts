// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { KeyboardInsetStore } from '@froglight/foundation';
import { attachNativeKeyboardGuards } from './keyboard-guards.js';
import { isAppleMobile, isTauriRuntime } from './window-chrome.js';
import { VISUAL_VIEWPORT_PAN_VAR } from '@froglight/ui';

afterEach(() => {
  document.documentElement.style.removeProperty(VISUAL_VIEWPORT_PAN_VAR);
  document.getElementById('app')?.removeAttribute('style');
  document
    .querySelectorAll('.froglight-overlay-host')
    .forEach((el) => el.remove());
});

function ensureApp(): HTMLElement {
  let app = document.getElementById('app');
  if (!app) {
    app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
  }
  return app as HTMLElement;
}

describe('native platform detectors (shared with window chrome)', () => {
  it('detects Tauri hosts without inferring from generic UI state', () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isTauriRuntime({})).toBe(false);
  });

  it('detects iOS/iPadOS including desktop-class iPad user agents', () => {
    expect(
      isAppleMobile({ platform: 'iPad', userAgent: 'iPad', maxTouchPoints: 5 }),
    ).toBe(true);
    expect(
      isAppleMobile({ platform: 'iPhone', userAgent: 'iPhone', maxTouchPoints: 5 }),
    ).toBe(true);
    expect(
      isAppleMobile({
        platform: 'MacIntel',
        userAgent: 'Macintosh',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
    expect(
      isAppleMobile({
        platform: 'MacIntel',
        userAgent: 'Macintosh',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
    expect(
      isAppleMobile({ platform: 'Linux', userAgent: 'Android', maxTouchPoints: 5 }),
    ).toBe(false);
  });
});

describe('attachNativeKeyboardGuards', () => {
  it('compensates real iOS visual displacement without moving overlay hosts', () => {
    const app = ensureApp();
    const overlay = document.createElement('div');
    overlay.className = 'froglight-overlay-host';
    document.body.append(overlay);
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const listeners = new Map<string, () => void>();
    Object.defineProperty(window, 'visualViewport', {
      value: {
        pageTop: 84,
        addEventListener: (type: string, fn: () => void) =>
          listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type),
      },
      configurable: true,
    });
    const detach = attachNativeKeyboardGuards({
      store,
      doc: document,
      isNativeHost: () => true,
      isIos: () => true,
      stateCall: async () => ({ height: 0, isOpen: false, isHiding: false }),
    });
    try {
      store.handleNativeEvent('target', {
        height: 300,
        durationMs: 250,
        measurement: 'exact',
      });
      listeners.get('scroll')?.();
      expect(
        document.documentElement.style.getPropertyValue(
          VISUAL_VIEWPORT_PAN_VAR,
        ),
      ).toBe('84px');
      expect(app.style.transform).toBe('translateY(84px)');
      expect(overlay.style.transform).toBe('');
    } finally {
      detach();
      store.dispose();
    }
  });

  it('keeps visual-pan compensation inert off native iOS', () => {
    for (const gate of [
      { isNativeHost: false, isIos: true },
      { isNativeHost: true, isIos: false },
    ]) {
      const app = ensureApp();
      const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
      const listeners = new Map<string, () => void>();
      Object.defineProperty(window, 'visualViewport', {
        value: {
          pageTop: 84,
          addEventListener: (type: string, fn: () => void) =>
            listeners.set(type, fn),
          removeEventListener: (type: string) => listeners.delete(type),
        },
        configurable: true,
      });
      const detach = attachNativeKeyboardGuards({
        store,
        doc: document,
        isNativeHost: () => gate.isNativeHost,
        isIos: () => gate.isIos,
        stateCall: async () => ({ height: 0, isOpen: false, isHiding: false }),
      });
      try {
        store.handleNativeEvent('target', {
          height: 300,
          durationMs: 250,
          measurement: 'exact',
        });
        listeners.get('scroll')?.();
        expect(
          document.documentElement.style.getPropertyValue(
            VISUAL_VIEWPORT_PAN_VAR,
          ),
        ).toBe('0px');
        expect(app.style.transform).toBe('');
      } finally {
        detach();
        store.dispose();
      }
      document.documentElement.style.removeProperty(VISUAL_VIEWPORT_PAN_VAR);
      app.removeAttribute('style');
    }
  });

  it('detach removes pan listeners and clears owned compensation', () => {
    const app = ensureApp();
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    let removed = 0;
    const listeners = new Map<string, () => void>();
    Object.defineProperty(window, 'visualViewport', {
      value: {
        pageTop: 84,
        addEventListener: (type: string, fn: () => void) =>
          listeners.set(type, fn),
        removeEventListener: (type: string) => {
          removed += 1;
          listeners.delete(type);
        },
      },
      configurable: true,
    });
    const detach = attachNativeKeyboardGuards({
      store,
      doc: document,
      isNativeHost: () => true,
      isIos: () => true,
      stateCall: async () => ({ height: 0, isOpen: false, isHiding: false }),
    });
    store.handleNativeEvent('target', {
      height: 300,
      durationMs: 250,
      measurement: 'exact',
    });
    listeners.get('scroll')?.();
    expect(
      document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR),
    ).toBe('84px');
    expect(app.style.transform).toBe('translateY(84px)');

    detach();
    expect(removed).toBe(2);
    expect(
      document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR),
    ).toBe('0px');
    expect(app.style.transform).toBe('');
    store.dispose();
  });
});
