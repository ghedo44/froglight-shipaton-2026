/**
 * iOS WebKit visual-viewport pan compatibility guard.
 *
 * Background: shipping WebKit releases can pan the visual viewport when the
 * software keyboard presents even while document scroll positions remain
 * zero. Froglight's primary keyboard layout is `--fl-keyboard-inset-height`
 * (native `KeyboardViewportLock` keeps the outer WKWebView offset at zero);
 * this module is a narrowly scoped compatibility workaround for WebKit
 * versions that predate the July 2026 `interactive-widget=overlays-content`
 * fix.
 *
 * Constraints:
 * - Runs only on native iOS/iPadOS hosts while the keyboard inset is > 0.
 * - Completely inert when the viewport stays at its expected origin.
 * - Never translates `<html>` or `<body>`; the compatibility transform
 *   applies only to the application root (`#app`). The body-level overlay
 *   host (`.froglight-overlay-host`) must remain untransformed: a
 *   transformed ancestor establishes the containing block for fixed
 *   descendants and would detach global overlays from the real viewport.
 *   Visual-pan compensation for overlays applies on the fixed surface
 *   itself via `[data-fl-viewport-overlay]` (`translate` property driven
 *   by `--fl-visual-viewport-pan-y`), never via an ancestor transform.
 * - Correction is a platform environment value
 *   (`--fl-visual-viewport-pan-y`), never a theme variable.
 * - Reset synchronously when the keyboard closes.
 */

export const VISUAL_VIEWPORT_PAN_VAR = '--fl-visual-viewport-pan-y';

/**
 * Latest applied visual-viewport pan compensation in CSS px. Menu
 * positioning reads this (plus the keyboard inset) so JS clamping accounts
 * for the same post-layout self-translation the stylesheets paint —
 * without double-counting either value.
 */
let activePanCompensation = 0;

/** The pan compensation currently painted via `--fl-visual-viewport-pan-y`. */
export function currentVisualViewportPan(): number {
  return activePanCompensation;
}

export interface PanViewportLike {
  readonly offsetTop?: number;
  readonly pageTop?: number;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface PanGuardGate {
  readonly isNativeHost: boolean;
  readonly isIos: boolean;
  readonly keyboardInsetHeight: number;
}

/** Gate: native iOS host with a live keyboard inset. */
export function shouldRunPanGuard(gate: PanGuardGate): boolean {
  return gate.isNativeHost === true && gate.isIos === true && gate.keyboardInsetHeight > 0;
}

/**
 * Pure pan detection. Models the real WebKit failure case:
 *
 *   window.scrollY = 0, document/body scroll = 0,
 *   BUT visualViewport.pageTop = e.g. 80 (the visual viewport moved down
 *   into the layout viewport, so the application appears 80px too high).
 *
 * Compensation is `pageTop - window.scrollY` when `pageTop` is
 * finite/reliable, falling back to negated `offsetTop` for viewports that
 * only expose the layout-relative offset. The correction for content
 * visually displaced upward is a positive translation downward.
 */
export function panCompensationForViewport(
  viewport: PanViewportLike | null | undefined,
  windowScrollY = 0,
): number {
  if (viewport === null || viewport === undefined) return 0;
  const scrollY =
    typeof windowScrollY === 'number' && Number.isFinite(windowScrollY)
      ? windowScrollY
      : 0;
  const hasPageTop =
    typeof viewport.pageTop === 'number' &&
    Number.isFinite(viewport.pageTop);
  // Prefer pageTop (visual-viewport origin in layout space) whenever the
  // viewport exposes it — including zero, which means "at origin".
  if (hasPageTop) {
    return Math.round((viewport.pageTop as number) - scrollY);
  }
  const offsetTop =
    typeof viewport.offsetTop === 'number' &&
    Number.isFinite(viewport.offsetTop)
      ? viewport.offsetTop
      : 0;
  if (offsetTop !== 0) return Math.round(-offsetTop);
  return 0;
}

export interface PanGuardOptions {
  readonly doc?: Document;
  readonly viewport?: PanViewportLike | null;
  readonly isNativeHost?: () => boolean;
  readonly isIos?: () => boolean;
  readonly keyboardInsetHeight?: () => number;
  /** Injectable scrollY reader (tests); defaults to the document view. */
  readonly windowScrollY?: () => number;
}

function defaultIsIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  const platform = (navigator as Navigator & { platform?: string }).platform ?? '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (platform === 'MacIntel' &&
      typeof navigator.maxTouchPoints === 'number' &&
      navigator.maxTouchPoints > 1)
  );
}

function appRoot(doc: Document): HTMLElement | null {
  const app = doc.getElementById('app');
  return app instanceof HTMLElement ? app : null;
}

/**
 * One-time migration cleanup: releases before this fix transformed the
 * overlay host alongside `#app`. New compensation never writes to the
 * host; reset clears any stale host transform so a fixed descendant keeps
 * the real viewport as its containing block.
 */
function clearLegacyOverlayHostTransforms(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('.froglight-overlay-host'))) {
    if (el instanceof HTMLElement && el.style.transform !== '') {
      el.style.transform = '';
    }
  }
}

function applyCompensation(doc: Document, compensation: number): void {
  activePanCompensation = compensation;
  doc.documentElement.style.setProperty(VISUAL_VIEWPORT_PAN_VAR, `${compensation}px`);
  const root = appRoot(doc);
  if (root !== null) {
    if (compensation === 0) {
      root.style.transform = '';
    } else {
      root.style.transform = `translateY(${compensation}px)`;
    }
  }
  // Deliberately never touches `.froglight-overlay-host`: transforming it
  // would reparent every fixed overlay's containing block. Fixed overlay
  // surfaces compensate via `[data-fl-viewport-overlay]` self-translation.
}

function resetCompensation(doc: Document): void {
  activePanCompensation = 0;
  doc.documentElement.style.setProperty(VISUAL_VIEWPORT_PAN_VAR, '0px');
  const root = appRoot(doc);
  if (root !== null) root.style.transform = '';
  clearLegacyOverlayHostTransforms(doc);
}

/**
 * Attach the compatibility guard. Returns a detach function. The guard
 * subscribes to `visualViewport` scroll/resize and applies exactly one
 * compensation per detected displacement; it resets synchronously via
 * `resetPanGuard` when the keyboard closes.
 */
export function attachIosViewportPanGuard(options: PanGuardOptions = {}): () => void {
  const globalDoc = typeof document === 'undefined' ? null : document;
  const doc = options.doc ?? globalDoc;
  if (!doc) return () => undefined;
  const viewport =
    options.viewport ??
    (typeof window === 'undefined' ? null : (window.visualViewport as unknown as PanViewportLike | null));
  if (!viewport || typeof viewport.addEventListener !== 'function') {
    return () => undefined;
  }
  const isNativeHost = options.isNativeHost ?? (() => false);
  const isIos = options.isIos ?? defaultIsIos;
  const insetHeight = options.keyboardInsetHeight ?? (() => 0);
  const readScrollY =
    options.windowScrollY ??
    (() => {
      const view = doc.defaultView;
      if (view && typeof view.scrollY === 'number' && Number.isFinite(view.scrollY)) {
        return view.scrollY;
      }
      if (typeof window !== 'undefined' && typeof window.scrollY === 'number') {
        return window.scrollY;
      }
      return 0;
    });

  const update = (): void => {
    const gate: PanGuardGate = {
      isNativeHost: isNativeHost(),
      isIos: isIos(),
      keyboardInsetHeight: insetHeight(),
    };
    if (!shouldRunPanGuard(gate)) {
      // Inert when the gate is closed; ensure no stale compensation lingers
      // if the keyboard just closed.
      if (gate.keyboardInsetHeight <= 0) resetCompensation(doc);
      return;
    }
    const compensation = panCompensationForViewport(viewport, readScrollY());
    if (compensation === 0) {
      // Exactly inert at the expected origin: no DOM writes beyond keeping
      // the var at zero. Native offset correction must not cause this guard
      // to oscillate — zero displacement means zero transform.
      resetCompensation(doc);
      return;
    }
    applyCompensation(doc, compensation);
  };

  viewport.addEventListener('scroll', update);
  viewport.addEventListener('resize', update);
  update();
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    viewport.removeEventListener?.('scroll', update);
    viewport.removeEventListener?.('resize', update);
    // Teardown restores everything the guard owns, without requiring a
    // keyboard-hide first: no stale transform survives a reload/unmount.
    resetCompensation(doc);
  };
}

/** Synchronous reset for keyboard-close paths (hide/detach). */
export function resetPanGuard(doc?: Document): void {
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  if (!target) return;
  resetCompensation(target);
}
