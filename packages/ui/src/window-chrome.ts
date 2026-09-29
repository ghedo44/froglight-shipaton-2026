/**
 * Window chrome capability: how the app shell shares the top of the window
 * with the host platform.
 *
 * The shell owns one titlebar surface. A host adapter decides who draws the
 * window controls, which regions drag the window, and which pixels the OS
 * reserves inside that bar:
 *
 * - `none` — plain browser tab: the bar is an ordinary app header.
 * - `window-controls-overlay` — installed PWA: the OS draws caption buttons
 *   into the reclaimed titlebar strip. The strip is NOT draggable by itself:
 *   Chromium still requires `-webkit-app-region: drag` on the titlebar
 *   (the OS caption-button rect stays non-draggable automatically).
 * - `tauri` — native window: the app draws its own controls and marks empty
 *   regions with the host drag-region attribute.
 *
 * Hosts wire their adapter through `mountFroglightApp`; the shell never
 * imports host SDKs.
 */

export interface WindowChromeInsets {
  /** Pixels reserved at the left edge of the titlebar (e.g. macOS traffic lights). */
  left: number;
  /** Pixels reserved at the right edge (e.g. Windows/WCO caption buttons). */
  right: number;
}

export interface Disposable {
  dispose(): void;
}

export interface WindowChrome {
  /** Which host mechanism backs this chrome. */
  readonly kind: 'none' | 'tauri' | 'window-controls-overlay';
  /** The app draws its own minimize/maximize/close buttons. */
  readonly appControls: boolean;
  /** Empty titlebar regions must carry the host drag-region marker. */
  readonly dragRegion: boolean;
  /** Pixels the OS reserves inside the titlebar on each side. */
  readonly inset: () => WindowChromeInsets;
  /** Fires when the OS-reserved inset changes (WCO geometry, snap, fullscreen). */
  readonly onInsetChange?: ((listener: () => void) => Disposable) | undefined;
  /** Current maximized state, when the host can observe it. */
  readonly maximized?: (() => boolean) | undefined;
  /** Fires when the maximized state changes. */
  readonly onMaximizedChange?:
    | ((listener: () => void) => Disposable)
    | undefined;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** Begin a native window drag from non-interactive titlebar space. */
  startDragging?: (() => Promise<void>) | undefined;
  /**
   * Release host listeners (WCO geometry, Tauri resize). The mount owns this:
   * `mountFroglightApp` disposes the chrome it was given when unmounting.
   */
  dispose?(): void;
}

/** Plain-browser fallback: the bar is an ordinary app header. */
export function noWindowChrome(): WindowChrome {
  return {
    kind: 'none',
    appControls: false,
    dragRegion: false,
    inset: () => ({ left: 0, right: 0 }),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

interface WindowControlsOverlayLike extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect | null;
}

interface NavigatorOverlay {
  windowControlsOverlay?: WindowControlsOverlayLike;
}

/**
 * Adapter for an installed PWA running with
 * `display_override: ['window-controls-overlay']`. Returns `null` when the
 * API is unavailable or the overlay is not active (plain browser tab), so the
 * shell falls back to `noWindowChrome`.
 */
export function windowControlsOverlayChrome(): WindowChrome | null {
  const overlay = (navigator as NavigatorOverlay).windowControlsOverlay;
  if (overlay === undefined || !overlay.visible) return null;

  let listeners = new Set<() => void>();
  const geometryChange = (): void => {
    for (const listener of [...listeners]) listener();
  };
  overlay.addEventListener('geometrychange', geometryChange);

  return {
    kind: 'window-controls-overlay',
    // The OS draws the caption buttons. The titlebar still needs an explicit
    // drag region: Chromium does not make the overlay strip draggable on its
    // own (without it, an installed PWA cannot be moved by its header).
    appControls: false,
    dragRegion: true,
    inset(): WindowChromeInsets {
      const rect = overlay.getTitlebarAreaRect();
      if (rect === null) return { left: 0, right: 0 };
      return {
        left: Math.max(0, rect.left),
        right: Math.max(0, window.innerWidth - rect.right),
      };
    },
    onInsetChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    dispose() {
      overlay.removeEventListener('geometrychange', geometryChange);
      listeners = new Set();
    },
  };
}
