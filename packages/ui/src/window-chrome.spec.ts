// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  noWindowChrome,
  windowControlsOverlayChrome,
  type WindowChrome,
} from './window-chrome.js';

interface FakeOverlay extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect | null;
}

/** Install a mock `navigator.windowControlsOverlay` and return its handles. */
function installOverlay(init: { visible: boolean; rect: DOMRect | null }): {
  overlay: FakeOverlay;
  dispatchGeometryChange(): void;
} {
  const overlay = new EventTarget() as FakeOverlay;
  overlay.visible = init.visible;
  overlay.getTitlebarAreaRect = () => init.rect;
  Object.defineProperty(navigator, 'windowControlsOverlay', {
    value: overlay,
    configurable: true,
  });
  return {
    overlay,
    dispatchGeometryChange: () =>
      overlay.dispatchEvent(new Event('geometrychange')),
  };
}

describe('window chrome contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as { windowControlsOverlay?: unknown })
      .windowControlsOverlay;
  });

  describe('noWindowChrome — plain browser fallback', () => {
    it('draws no controls, marks no drag region, reserves no inset', () => {
      const chrome = noWindowChrome();
      expect(chrome.kind).toBe('none');
      expect(chrome.appControls).toBe(false);
      expect(chrome.dragRegion).toBe(false);
      expect(chrome.inset()).toEqual({ left: 0, right: 0 });
      expect(chrome.maximized).toBeUndefined();
      expect(chrome.onInsetChange).toBeUndefined();
    });

    it('window operations resolve without host effects', async () => {
      const chrome = noWindowChrome();
      await expect(chrome.minimize()).resolves.toBeUndefined();
      await expect(chrome.toggleMaximize()).resolves.toBeUndefined();
      await expect(chrome.close()).resolves.toBeUndefined();
    });
  });

  describe('windowControlsOverlayChrome — installed PWA', () => {
    it('returns null when the API is unavailable (plain browser tab)', () => {
      expect(windowControlsOverlayChrome()).toBeNull();
    });

    it('returns null when the overlay is not visible', () => {
      installOverlay({ visible: false, rect: null });
      expect(windowControlsOverlayChrome()).toBeNull();
    });

    it('reports the OS-reserved inset from the titlebar area rect', () => {
      installOverlay({
        visible: true,
        rect: new DOMRect(0, 0, 1024 - 138, 38),
      });
      const chrome = windowControlsOverlayChrome();
      expect(chrome).not.toBeNull();
      expect(chrome!.kind).toBe('window-controls-overlay');
      // The OS draws the caption buttons and the app draws none. Chromium
      // does NOT make the overlay strip draggable on its own, so the shell
      // must mark the titlebar as a drag region (regression: installed PWAs
      // could not be moved by their header).
      expect(chrome!.appControls).toBe(false);
      expect(chrome!.dragRegion).toBe(true);
      expect(chrome!.inset()).toEqual({ left: 0, right: 138 });
    });

    it('republishes geometrychange as inset-change notifications until disposed', () => {
      const rect = { value: new DOMRect(0, 0, 886, 38) };
      const { overlay, dispatchGeometryChange } = installOverlay({
        visible: true,
        rect: rect.value,
      });
      const chrome = windowControlsOverlayChrome()!;
      const listener = vi.fn();
      const subscription = chrome.onInsetChange!(listener);

      rect.value = new DOMRect(0, 0, 900, 38);
      overlay.getTitlebarAreaRect = () => rect.value;
      dispatchGeometryChange();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(chrome.inset()).toEqual({ left: 0, right: 124 });

      subscription.dispose();
      dispatchGeometryChange();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('survives a null rect (overlay reported between geometries)', () => {
      installOverlay({ visible: true, rect: null });
      const chrome = windowControlsOverlayChrome()!;
      expect(chrome.inset()).toEqual({ left: 0, right: 0 });
    });

    it('dispose detaches the geometry listener: zero notifications after it', () => {
      const { dispatchGeometryChange } = installOverlay({
        visible: true,
        rect: new DOMRect(0, 0, 886, 38),
      });
      const chrome = windowControlsOverlayChrome()!;
      const listener = vi.fn();
      chrome.onInsetChange!(listener);

      chrome.dispose!();
      dispatchGeometryChange();
      expect(listener).not.toHaveBeenCalled();

      // Disposing twice stays safe.
      chrome.dispose!();
    });
  });

  describe('contract shape', () => {
    it('every chrome exposes the window operation trio', async () => {
      const chromes: WindowChrome[] = [
        noWindowChrome(),
        windowControlsOverlayChrome() ?? noWindowChrome(),
      ];
      for (const chrome of chromes) {
        await chrome.minimize();
        await chrome.toggleMaximize();
        await chrome.close();
      }
    });
  });
});
