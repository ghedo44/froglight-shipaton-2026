/**
 * VisualViewport fallback source (keyboard coordinator split).
 *
 * Host-independent overlap math for web/PWA/desktop browsers without
 * native inset events. Synthesizes `change` reports from the occluded
 * height; the store reconciles, debounces, and persists them like native
 * settles. Subscribes to both `resize` and `scroll`: height alone misses
 * offsetTop shifts while the keyboard occludes.
 *
 * Deliberately settled-only (Model B): the browser has no native
 * transition intent, and measured viewport geometry can be noisy mid-
 * animation, so layout follows the debounced settled report rather than
 * every raw overlap. See the shell spec's settled-fallback coverage.
 */

import type { KeyboardInsetService } from '@froglight/foundation';

export interface VisualViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface VisualViewportSourceOptions {
  readonly store: KeyboardInsetService;
  readonly viewport?: VisualViewportLike | null;
  readonly innerHeight?: () => number;
}

/** Pure overlap: window height minus the visible viewport box. */
export function visualViewportOverlap(
  innerHeight: number,
  viewportHeight: number,
  offsetTop: number,
): number {
  return Math.max(0, Math.round(innerHeight - (viewportHeight + offsetTop)));
}

export function attachVisualViewportSource(
  options: VisualViewportSourceOptions,
): () => void {
  const viewport =
    options.viewport ??
    (typeof window === 'undefined' ? null : window.visualViewport);
  if (viewport === null || viewport === undefined) return () => undefined;
  const readInnerHeight =
    options.innerHeight ??
    (() => (typeof window === 'undefined' ? 0 : window.innerHeight));
  let last = -1;
  const update = () => {
    const overlap = visualViewportOverlap(
      readInnerHeight(),
      viewport.height,
      viewport.offsetTop,
    );
    if (overlap === last) return;
    last = overlap;
    options.store.handleNativeEvent('change', { height: overlap });
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
  };
}
