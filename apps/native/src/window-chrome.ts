/** Tauri window-chrome adapter: the app draws its own titlebar controls. */

import { getCurrentWindow } from '@tauri-apps/api/window';
import { noWindowChrome, type WindowChrome } from '@froglight/ui';

/** Rough width of the macOS traffic-light cluster, used as the left inset. */
const MACOS_TRAFFIC_LIGHTS_INSET = 76;

/**
 * Shared Apple-mobile detection (also used by the keyboard pan-guard seam):
 * iPadOS may present as desktop Mac, so touch capability is part of the
 * test. Accepts an injectable navigator for specs; defaults to the global.
 */
export function isAppleMobile(
  nav: {
    platform?: string;
    userAgent?: string;
    maxTouchPoints?: number;
  } | null = typeof navigator === 'undefined' ? null : navigator,
): boolean {
  if (nav === null) return false;
  const platform = nav.platform ?? '';
  const ua = nav.userAgent ?? '';
  return (
    /iPhone|iPad|iPod/.test(platform) ||
    /iPhone|iPad|iPod/.test(ua) ||
    (/Mac/.test(platform) && (nav.maxTouchPoints ?? 0) > 1)
  );
}

function isAndroidMobile(): boolean {
  return /Android/.test(navigator.userAgent ?? '');
}

function isMacDesktop(): boolean {
  if (isAppleMobile()) return false;
  const platform = navigator.platform ?? '';
  const ua = navigator.userAgent ?? '';
  return /Mac/.test(platform) || /Macintosh/.test(ua);
}

/** Shared Tauri-host detection (also used by the keyboard pan-guard seam). */
export function isTauriRuntime(
  scope: Record<string, unknown> | null = typeof window === 'undefined'
    ? null
    : (window as unknown as Record<string, unknown>),
): boolean {
  return scope !== null && '__TAURI_INTERNALS__' in scope;
}

/**
 * Chrome for the native Tauri window (`decorations: false` on Windows/Linux;
 * macOS keeps its traffic lights over an overlay titlebar).
 *
 * iOS/iPadOS and Android own their window-management chrome. The webview must
 * reserve the CSS safe area, but it must not draw desktop window controls,
 * start native desktop dragging, or reserve the macOS traffic-light inset.
 *
 * Returns `null` outside Tauri (plain-browser `pnpm dev`), so hosts can fall
 * back to `noWindowChrome`.
 */
export function createTauriWindowChrome(): WindowChrome | null {
  if (!isTauriRuntime()) return null;

  const win = getCurrentWindow();
  const mac = isMacDesktop();
  const platformMobile = isAppleMobile() || isAndroidMobile();

  // Maximized state feeds the maximize/restore affordance. The initial read
  // covers windows that open maximized; resize events keep it current.
  let maximized = false;
  let unlisten: (() => void) | 'pending' | 'disposed' = 'pending';
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  void win
    .onResized(async () => {
      const next = await win.isMaximized().catch(() => false);
      if (next !== maximized) {
        maximized = next;
        notify();
      }
    })
    .then((stop) => {
      if (unlisten === 'disposed') stop();
      else unlisten = stop;
    })
    .catch(() => undefined);
  void win
    .isMaximized()
    .then((initial) => {
      if (initial !== maximized) {
        maximized = initial;
        notify();
      }
    })
    .catch(() => undefined);

  return {
    kind: 'tauri',
    // Windows/Linux draw their own controls; macOS and the mobile platforms
    // keep the platform-owned controls.
    appControls: !mac && !platformMobile,
    dragRegion: !platformMobile,
    inset: () =>
      mac
        ? { left: MACOS_TRAFFIC_LIGHTS_INSET, right: 0 }
        : { left: 0, right: 0 },
    maximized: () => maximized,
    onMaximizedChange(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    startDragging: () => win.startDragging(),
    dispose() {
      listeners.clear();
      if (unlisten === 'pending') unlisten = 'disposed';
      else if (unlisten !== 'disposed') unlisten();
    },
  };
}

/** The chrome the native host mounts with: Tauri when present, else fallback. */
export function nativeWindowChrome(): WindowChrome {
  return createTauriWindowChrome() ?? noWindowChrome();
}
