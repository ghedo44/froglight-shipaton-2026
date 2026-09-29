// @vitest-environment jsdom
/**
 * Native-host keyboard integration (physical iPad follow-up).
 *
 * One seam above the unit specs: the exact native direct-eval event travels
 * through the production forwarder into the host store, through the attached
 * keyboard shell, and lands on the `--fl-keyboard-inset-height` environment
 * variable — then hide events reset it. This catches disconnected native →
 * UI wiring that per-piece tests cannot see. It drives the real
 * `window.__FROGLIGHT_KEYBOARD_INSET_EVENT__` hook, never
 * `ShellController.onTarget()` directly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEYBOARD_INSET_EVENT_CHANNEL } from '@froglight/foundation';
import {
  attachKeyboardShell,
  detachKeyboardShell,
} from '@froglight/ui';
import {
  createNativeKeyboardInset,
  installNativeKeyboardEventForwarder,
} from './keyboard-inset.js';

afterEach(() => {
  detachKeyboardShell();
  document.documentElement.style.removeProperty('--fl-keyboard-inset-height');
  document.body.querySelectorAll('[data-fl-keyboard-band]').forEach((el) => {
    el.remove();
  });
  delete (window as unknown as Record<string, unknown>)[
    KEYBOARD_INSET_EVENT_CHANNEL
  ];
});

describe('native-host keyboard event path (target → shell → CSS var)', () => {
  it('drives an exact target through the direct-eval hook to the CSS inset, then hides', () => {
    const host = createNativeKeyboardInset(
      vi.fn().mockResolvedValue(undefined),
    );
    try {
      const uninstallForwarder = installNativeKeyboardEventForwarder(
        host.store,
      );
      try {
        const detachShell = attachKeyboardShell({
          store: host.store,
          reduceMotion: true,
        });
        try {
          const hook = (
            window as unknown as Record<
              string,
              (event: string, payload: unknown) => void
            >
          )[KEYBOARD_INSET_EVENT_CHANNEL];
          expect(typeof hook).toBe('function');

          hook('target', {
            height: 320,
            durationMs: 250,
            measurement: 'exact',
          });

          expect(host.store.snapshot().height).toBe(320);
          expect(
            document.documentElement.style.getPropertyValue(
              '--fl-keyboard-inset-height',
            ),
          ).toBe('320px');

          hook('willHide', { durationMs: 200 });
          hook('didHide', {});

          expect(host.store.snapshot()).toMatchObject({
            height: 0,
            isOpen: false,
          });
          expect(
            document.documentElement.style.getPropertyValue(
              '--fl-keyboard-inset-height',
            ),
          ).toBe('0px');
        } finally {
          detachShell();
        }
      } finally {
        uninstallForwarder();
      }
    } finally {
      host.store.dispose();
    }
    expect(
      (window as unknown as Record<string, unknown>)[
        KEYBOARD_INSET_EVENT_CHANNEL
      ],
    ).toBeUndefined();
  });
});
