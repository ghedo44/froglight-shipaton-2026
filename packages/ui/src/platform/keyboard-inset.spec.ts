// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KeyboardInsetStore,
  type KeyboardInsetService,
} from '@froglight/foundation';
import {
  attachKeyboardShell,
  attachVisualViewportSource,
  currentKeyboardInsetTarget,
  detachKeyboardShell,
  holdKeyboardSlot,
  registerAboveKeyboard,
  registerBelowKeyboard,
} from './keyboard-inset.js';

function attach(store?: KeyboardInsetService): {
  store: KeyboardInsetStore;
  detach: () => void;
} {
  const owned = new KeyboardInsetStore({ settleDebounceMs: 0 });
  const detach = attachKeyboardShell({
    store: store ?? owned,
    reduceMotion: true,
  });
  return { store: owned, detach };
}

afterEach(() => {
  detachKeyboardShell();
  document.documentElement.style.removeProperty('--fl-keyboard-inset-height');
  document.body.querySelectorAll('[data-fl-keyboard-band]').forEach((el) => {
    el.remove();
  });
});

describe('keyboard shell', () => {
  it('hides with the inset applied up front so content glides down at once', () => {
    const { store, detach } = attach();
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    store.handleNativeEvent('didShow', { height: 300 });
    store.handleNativeEvent('willHide', { durationMs: 200 });
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('0px');
    expect(currentKeyboardInsetTarget()).toBe(0);
    detach();
    store.dispose();
  });

  it('announces the show target synchronously at intent time', () => {
    const { store, detach } = attach();
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    expect(currentKeyboardInsetTarget()).toBe(300);
    detach();
    store.dispose();
  });

  it('applies exact iOS geometry immediately (logical first, glide second)', () => {
    const { store, detach } = attach();
    store.handleNativeEvent('target', {
      height: 346,
      durationMs: 250,
      measurement: 'exact',
    });
    // The editor scroll viewport already represents the final usable area
    // while the keyboard rises — no waiting for the animation end.
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('346px');
    expect(currentKeyboardInsetTarget()).toBe(346);
    detach();
    store.dispose();
  });

  it('defers hint geometry reflow to the animation end (Android late signal)', () => {
    const { store, detach } = attach();
    const node = document.createElement('div');
    document.body.append(node);
    const unregister = registerAboveKeyboard(node);
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    // Hint path: old layout persists through the glide; the reflow lands
    // under the risen keyboard at settle.
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).not.toBe('300px');
    unregister();
    node.remove();
    detach();
    store.dispose();
  });

  it('dedups identical targets into one layout target', () => {
    const { store, detach } = attach();
    store.handleNativeEvent('target', {
      height: 300,
      durationMs: 250,
      measurement: 'exact',
    });
    store.handleNativeEvent('target', {
      height: 300,
      durationMs: 250,
      measurement: 'exact',
    });
    expect(currentKeyboardInsetTarget()).toBe(300);
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('300px');
    detach();
    store.dispose();
  });

  it('didHide cancels a pending positive settle when willHide was missed', async () => {
    // Recovery path: willHide never arrived, so didHide alone must close
    // the store, drop the queued settle, and reset shell geometry — with
    // no stale positive callback restoring it afterward.
    vi.useFakeTimers();
    try {
      const store = new KeyboardInsetStore({ settleDebounceMs: 120 });
      const detach = attachKeyboardShell({ store, reduceMotion: true });
      try {
        const settled: number[] = [];
        store.onSettled((height) => {
          settled.push(height);
        });
        store.handleNativeEvent('target', {
          height: 300,
          durationMs: 250,
          measurement: 'exact',
        });
        store.handleNativeEvent('settled', { height: 300 });
        store.handleNativeEvent('didHide', {});
        expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
        await vi.advanceTimersByTimeAsync(500);
        expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
        expect(settled).toEqual([]);
        expect(
          document.documentElement.style.getPropertyValue(
            '--fl-keyboard-inset-height',
          ),
        ).toBe('0px');
        expect(currentKeyboardInsetTarget()).toBe(0);
      } finally {
        detach();
        store.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves between exact targets without resetting to zero', () => {
    const { store, detach } = attach();
    const seen: number[] = [];
    store.subscribe((snapshot) => {
      seen.push(snapshot.height);
    });
    store.handleNativeEvent('target', {
      height: 300,
      durationMs: 250,
      measurement: 'exact',
    });
    // Rotation/emoji while open: the production sequence is a mid-session
    // target, not a second appearance — the new exact target wins directly.
    store.handleNativeEvent('target', {
      height: 350,
      durationMs: 250,
      measurement: 'exact',
    });
    expect(store.snapshot()).toMatchObject({ height: 350, isOpen: true });
    expect(seen).not.toContain(0);
    expect(currentKeyboardInsetTarget()).toBe(350);
    detach();
    store.dispose();
  });

  it('applies a mid-session exact target immediately with no debounce wait', () => {
    const { store, detach } = attach();
    store.handleNativeEvent('target', {
      height: 300,
      durationMs: 250,
      measurement: 'exact',
    });
    store.handleNativeEvent('settled', { height: 300 });
    // The usable inset follows the new target synchronously: usable
    // geometry never waits for the settled-height debounce.
    store.handleNativeEvent('target', {
      height: 350,
      durationMs: 250,
      measurement: 'exact',
    });
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('350px');
    expect(currentKeyboardInsetTarget()).toBe(350);
    detach();
    store.dispose();
  });

  it('settles the show reflow under the risen keyboard', async () => {
    const { store, detach } = attach();
    const node = document.createElement('div');
    document.body.append(node);
    const unregister = registerAboveKeyboard(node);
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    store.handleNativeEvent('didShow', { height: 300 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('300px');
    expect(node.style.transform).toBe('');
    unregister();
    node.remove();
    detach();
    store.dispose();
  });

  it('paints and removes the background band with the keyboard', async () => {
    const { store, detach } = attach();
    expect(
      document.body.querySelector('[data-fl-keyboard-band]'),
    ).not.toBeNull();
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    const band = document.body.querySelector(
      '[data-fl-keyboard-band]',
    ) as HTMLElement;
    expect(band.style.height).toBe('300px');
    store.handleNativeEvent('willHide', { durationMs: 200 });
    expect(band.style.height).toBe('0px');
    detach();
    expect(document.body.querySelector('[data-fl-keyboard-band]')).toBeNull();
    store.dispose();
  });

  it('holds the slot for covering dialogs without collapsing layout', async () => {
    const { store, detach } = attach();
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    store.handleNativeEvent('didShow', { height: 300 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dismiss = holdKeyboardSlot();
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('300px');
    dismiss();
    await new Promise((resolve) => setTimeout(resolve, 50));
    detach();
    store.dispose();
  });

  it('docks a below-keyboard surface at the reserved height', () => {
    const { store, detach } = attach();
    const node = document.createElement('div');
    document.body.append(node);
    const surface = registerBelowKeyboard(node);
    surface.setOpen(true);
    expect(node.style.height).toBe('270px');
    expect(surface.isVisible()).toBe(true);
    surface.setOpen(false);
    expect(surface.isVisible()).toBe(false);
    surface.destroy();
    node.remove();
    detach();
    store.dispose();
  });

  it('lays out the web fallback through the settled report, not raw overlap', async () => {
    // Settled-only web model (Model B): the browser has no native
    // transition intent and measured overlap is noisy, so the store
    // snapshot follows immediately while shell layout waits for the
    // settled debounce.
    vi.useFakeTimers();
    try {
      const store = new KeyboardInsetStore({ settleDebounceMs: 120 });
      const detach = attachKeyboardShell({ store, reduceMotion: true });
      try {
        const listeners = new Map<string, () => void>();
        const viewport = {
          height: 500,
          offsetTop: 0,
          addEventListener: (name: string, listener: () => void) => {
            listeners.set(name, listener);
          },
          removeEventListener: (name: string) => {
            listeners.delete(name);
          },
        };
        const detachSource = attachVisualViewportSource({
          store,
          viewport,
          innerHeight: () => 800,
        });
        expect(store.snapshot()).toMatchObject({ height: 300, isOpen: true });
        expect(
          document.documentElement.style.getPropertyValue(
            '--fl-keyboard-inset-height',
          ),
        ).not.toBe('300px');
        await vi.advanceTimersByTimeAsync(120);
        expect(
          document.documentElement.style.getPropertyValue(
            '--fl-keyboard-inset-height',
          ),
        ).toBe('300px');
        viewport.height = 800;
        listeners.get('resize')?.();
        expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
        await vi.advanceTimersByTimeAsync(120);
        expect(
          document.documentElement.style.getPropertyValue(
            '--fl-keyboard-inset-height',
          ),
        ).toBe('0px');
        detachSource();
        expect(listeners.size).toBe(0);
      } finally {
        detach();
        store.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('drives inset changes from visualViewport without native events', () => {
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const listeners = new Map<string, () => void>();
    const viewport = {
      height: 500,
      offsetTop: 0,
      addEventListener: (name: string, listener: () => void) => {
        listeners.set(name, listener);
      },
      removeEventListener: (name: string) => {
        listeners.delete(name);
      },
    };
    const detachSource = attachVisualViewportSource({
      store,
      viewport,
      innerHeight: () => 800,
    });
    listeners.get('resize')?.();
    expect(store.snapshot()).toMatchObject({ height: 300, isOpen: true });
    viewport.height = 800;
    listeners.get('resize')?.();
    expect(store.snapshot()).toMatchObject({ height: 0, isOpen: false });
    detachSource();
    expect(listeners.size).toBe(0);
    store.dispose();
  });

  it('updates fallback inset on visualViewport scroll when height is unchanged', () => {
    const store = new KeyboardInsetStore({ settleDebounceMs: 0 });
    const listeners = new Map<string, () => void>();
    const viewport = {
      height: 500,
      offsetTop: 0,
      addEventListener: (name: string, listener: () => void) => {
        listeners.set(name, listener);
      },
      removeEventListener: (name: string) => {
        listeners.delete(name);
      },
    };
    const detachSource = attachVisualViewportSource({
      store,
      viewport,
      innerHeight: () => 800,
    });
    expect(store.snapshot()).toMatchObject({ height: 300, isOpen: true });
    // ChromeOS-style: height unchanged, offsetTop shifts as the keyboard
    // occludes from the bottom.
    viewport.offsetTop = 100;
    listeners.get('scroll')?.();
    expect(store.snapshot()).toMatchObject({ height: 200, isOpen: true });
    detachSource();
    expect(listeners.size).toBe(0);
    store.dispose();
  });

  it('helpers no-op without an attached shell', () => {
    expect(() =>
      registerAboveKeyboard(document.createElement('div')),
    ).not.toThrow();
    const surface = registerBelowKeyboard(document.createElement('div'));
    surface.setOpen(true);
    expect(surface.isVisible()).toBe(true);
    surface.destroy();
    expect(holdKeyboardSlot()()).toBeUndefined();
  });

  it('never modifies application root scroll state across show/hide', () => {
    const { store, detach } = attach();
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    store.handleNativeEvent('didShow', { height: 300 });
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    store.handleNativeEvent('willHide', { durationMs: 200 });
    store.handleNativeEvent('didHide', {});
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(
      document.documentElement.style.getPropertyValue('--fl-keyboard-inset-height'),
    ).toBe('0px');
    detach();
    store.dispose();
  });

  it('treats floating/hardware keyboards as zero bottom inset', () => {
    const { store, detach } = attach();
    // Floating keyboard: intersects mid-WebView on native → inset 0 arrives
    // as willHide/change with no height; the shell stays at zero.
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    store.handleNativeEvent('didShow', { height: 300 });
    store.handleNativeEvent('willHide', { durationMs: 200 });
    store.handleNativeEvent('didHide', {});
    expect(currentKeyboardInsetTarget()).toBe(0);
    expect(
      document.documentElement.style.getPropertyValue('--fl-keyboard-inset-height'),
    ).toBe('0px');
    detach();
    store.dispose();
  });

  it('resets visual-viewport compatibility compensation on hide', async () => {
    const { store, detach } = attach();
    document.documentElement.style.setProperty('--fl-visual-viewport-pan-y', '24px');
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    store.handleNativeEvent('willHide', { durationMs: 200 });
    expect(
      document.documentElement.style.getPropertyValue('--fl-visual-viewport-pan-y'),
    ).toBe('0px');
    detach();
    store.dispose();
  });

  it('keeps internal editable scrolling possible while the shell stays fixed', async () => {
    const { store, detach } = attach();
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const input = document.createElement('input');
    scroller.append(input);
    document.body.append(scroller);
    input.focus();
    input.getBoundingClientRect = () =>
      ({ bottom: 780, top: 760, left: 0, right: 100, width: 100, height: 20 }) as DOMRect;
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    store.handleNativeEvent('willShow', { height: 300, durationMs: 250 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Shell chrome never scrolls; the internal scroller absorbed the caret.
    expect(document.documentElement.scrollTop).toBe(0);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    scroller.remove();
    detach();
    store.dispose();
  });
});
