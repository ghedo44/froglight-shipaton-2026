// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachIosViewportPanGuard,
  currentVisualViewportPan,
  panCompensationForViewport,
  resetPanGuard,
  shouldRunPanGuard,
  VISUAL_VIEWPORT_PAN_VAR,
} from './ios-viewport-pan-guard.js';

afterEach(() => {
  resetPanGuard(document);
  document.documentElement.style.removeProperty(VISUAL_VIEWPORT_PAN_VAR);
  document.getElementById('app')?.removeAttribute('style');
  document.querySelectorAll('.froglight-overlay-host').forEach((el) => el.remove());
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

describe('ios viewport pan guard gate', () => {
  it('runs only on native iOS hosts with a live inset', () => {
    expect(
      shouldRunPanGuard({ isNativeHost: true, isIos: true, keyboardInsetHeight: 300 }),
    ).toBe(true);
    expect(
      shouldRunPanGuard({ isNativeHost: false, isIos: true, keyboardInsetHeight: 300 }),
    ).toBe(false);
    expect(
      shouldRunPanGuard({ isNativeHost: true, isIos: false, keyboardInsetHeight: 300 }),
    ).toBe(false);
    expect(
      shouldRunPanGuard({ isNativeHost: true, isIos: true, keyboardInsetHeight: 0 }),
    ).toBe(false);
  });

  it('is inert at the expected origin', () => {
    expect(panCompensationForViewport(null)).toBe(0);
    expect(panCompensationForViewport({ pageTop: 0 }, 0)).toBe(0);
    expect(panCompensationForViewport({})).toBe(0);
  });

  it('compensates realistic WebKit displacement as pageTop - scrollY', () => {
    // Canonical failure: logical scroll is zero but the visual viewport
    // moved down into the layout viewport; the app appears 80px too high.
    expect(panCompensationForViewport({ pageTop: 80 }, 0)).toBe(80);
    expect(panCompensationForViewport({ pageTop: 120 }, 40)).toBe(80);
    expect(panCompensationForViewport({ pageTop: 0 }, 0)).toBe(0);
  });

  it('acceptance: window.scrollY 0, pageTop 84 displaces the shell -84', () => {
    // Shell apparent top = -84 → one +84 compensation shifts content back
    // down into place.
    expect(panCompensationForViewport({ pageTop: 84 }, 0)).toBe(84);
  });

  it('falls back to negated offsetTop when pageTop is unavailable', () => {
    expect(panCompensationForViewport({ offsetTop: -32 })).toBe(32);
    expect(panCompensationForViewport({ offsetTop: 12 })).toBe(-12);
  });

  it('ignores non-finite viewport values', () => {
    expect(panCompensationForViewport({ pageTop: NaN }, 0)).toBe(0);
    expect(
      panCompensationForViewport({ offsetTop: Infinity, pageTop: Infinity }, 0),
    ).toBe(0);
  });
});

describe('attachIosViewportPanGuard', () => {
  it('does nothing when the viewport stays at its origin', () => {
    const app = ensureApp();
    const listeners = new Map<string, () => void>();
    const viewport = {
      pageTop: 0,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const detach = attachIosViewportPanGuard({
      doc: document,
      viewport,
      isNativeHost: () => true,
      isIos: () => true,
      keyboardInsetHeight: () => 300,
      windowScrollY: () => 0,
    });
    listeners.get('scroll')?.();
    expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR)).toBe(
      '0px',
    );
    expect(app.style.transform).toBe('');
    detach();
  });

  it('applies exactly one compensation to the app root only', () => {
    const app = ensureApp();
    const overlay = document.createElement('div');
    overlay.className = 'froglight-overlay-host';
    document.body.append(overlay);
    const listeners = new Map<string, () => void>();
    const viewport = {
      pageTop: 84,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const detach = attachIosViewportPanGuard({
      doc: document,
      viewport,
      isNativeHost: () => true,
      isIos: () => true,
      keyboardInsetHeight: () => 300,
      windowScrollY: () => 0,
    });
    expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR)).toBe(
      '84px',
    );
    expect(app.style.transform).toBe('translateY(84px)');
    // The overlay host must keep the real viewport as the containing block
    // for its fixed descendants: never transformed. Fixed overlay surfaces
    // compensate via `[data-fl-viewport-overlay]` self-translation instead.
    expect(overlay.style.transform).toBe('');
    // Never touches html/body transforms.
    expect(document.documentElement.style.transform).toBe('');
    expect(document.body.style.transform).toBe('');
    detach();
  });

  it('never transforms the overlay host even under positive displacement', () => {
    ensureApp();
    const overlay = document.createElement('div');
    overlay.className = 'froglight-overlay-host';
    document.body.append(overlay);
    const viewport = {
      pageTop: 120,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const detach = attachIosViewportPanGuard({
      doc: document,
      viewport,
      isNativeHost: () => true,
      isIos: () => true,
      keyboardInsetHeight: () => 300,
      windowScrollY: () => 0,
    });
    expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR)).toBe(
      '120px',
    );
    expect(overlay.style.transform).toBe('');
    // Menu clamping reads the same painted value through the getter.
    expect(currentVisualViewportPan()).toBe(120);
    detach();
    expect(overlay.style.transform).toBe('');
    expect(currentVisualViewportPan()).toBe(0);
  });

  it('stays inert when native correction already holds the baseline', () => {
    // Native root offset = baseline, visual displacement = 0 → no transform.
    const app = ensureApp();
    const viewport = {
      pageTop: 0,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const detach = attachIosViewportPanGuard({
      doc: document,
      viewport,
      isNativeHost: () => true,
      isIos: () => true,
      keyboardInsetHeight: () => 300,
      windowScrollY: () => 0,
    });
    expect(app.style.transform).toBe('');
    expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR)).toBe(
      '0px',
    );
    detach();
  });

  it('stays inert off native iOS even when displaced', () => {
    ensureApp();
    const viewport = {
      pageTop: 84,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const detach = attachIosViewportPanGuard({
      doc: document,
      viewport,
      isNativeHost: () => false,
      isIos: () => true,
      keyboardInsetHeight: () => 300,
      windowScrollY: () => 0,
    });
    expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR)).toBe(
      '',
    );
    detach();
  });

  it('resets synchronously when the keyboard closes', () => {
    const app = ensureApp();
    const overlay = document.createElement('div');
    overlay.className = 'froglight-overlay-host';
    // Legacy stale transform from before the containing-block fix.
    overlay.style.transform = 'translateY(80px)';
    document.body.append(overlay);
    const viewport = {
      pageTop: 80,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const detach = attachIosViewportPanGuard({
      doc: document,
      viewport,
      isNativeHost: () => true,
      isIos: () => true,
      keyboardInsetHeight: () => 300,
      windowScrollY: () => 0,
    });
    expect(app.style.transform).toBe('translateY(80px)');
    resetPanGuard(document);
    expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR)).toBe(
      '0px',
    );
    expect(app.style.transform).toBe('');
    expect(overlay.style.transform).toBe('');
    detach();
  });
});
