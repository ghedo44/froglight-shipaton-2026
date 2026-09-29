import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEYBOARD_INSET_EVENT_CHANNEL,
  keyboardInsetToken,
} from '@froglight/foundation';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  KEYBOARD_INSET_HIDE_COMMAND,
  KEYBOARD_INSET_SHOW_COMMAND,
  createNativeKeyboardInset,
  installNativeKeyboardEventForwarder,
} from './keyboard-inset.js';

describe('native viewport contract', () => {
  it('keeps interactive-widget=overlays-content and never resizes-content', () => {
    // A full-size WebView with the keyboard overlaying it and
    // `--fl-keyboard-inset-height` describing the occluded region. Using
    // `resizes-content` would introduce two competing layout systems
    // (WebKit resize + Froglight inset) and risk double keyboard avoidance.
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(resolve(here, '../index.html'), 'utf8');
    expect(html).toContain('interactive-widget=overlays-content');
    expect(html).not.toContain('resizes-content');
  });

  it('keeps the iOS viewport lock to session semantics', () => {
    // Source validation (no Swift test host): the KVO correction must be
    // synchronous (no deferred snap-back frame), the lock must model only
    // active-session vs inactive (lifecycle detail belongs in the plugin),
    // and no unused diagnostic surface may remain. The clamp target is
    // unconditionally zero because the outer document never scrolls.
    const here = dirname(fileURLToPath(import.meta.url));
    const lock = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/ios/Sources/KeyboardViewportLock.swift',
      ),
      'utf8',
    );
    expect(lock).toContain('beginSession');
    expect(lock).toContain('endSession');
    expect(lock).toContain('isSessionActive');
    expect(lock).not.toContain('sessionBaseline');
    expect(lock).toContain('return .zero');
    expect(lock).not.toMatch(/DispatchQueue\.main\.async/);
    expect(lock).toContain('isNormalizing = true');
    expect(lock).not.toContain('KeyboardViewportState');
    expect(lock).not.toContain('setState');
    expect(lock).not.toContain('ForDiagnostics');
    // KVO guard without seizing the scroll-view delegate:
    // the lock observes contentOffset and never assigns the delegate.
    expect(lock).toMatch(/delegate is never seized/i);
    expect(lock).not.toMatch(/\.delegate\s*=/);
  });

  it('owns and restores the outer WKWebView scroll configuration', () => {
    // Froglight outer WKWebView scroller is not an application
    // scroll owner. Disable it while mounted, hide its native indicators,
    // and restore every value on teardown. Internal DOM/editor scrollers
    // remain the web application's scroll owners.
    const here = dirname(fileURLToPath(import.meta.url));
    const lock = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/ios/Sources/KeyboardViewportLock.swift',
      ),
      'utf8',
    );
    expect(lock).toContain('originalIsScrollEnabled');
    expect(lock).toContain('originalShowsVerticalScrollIndicator');
    expect(lock).toContain('originalShowsHorizontalScrollIndicator');
    expect(lock).toContain('scrollView.isScrollEnabled = false');
    expect(lock).toContain('scrollView.isScrollEnabled = enabled');
    expect(lock).toContain('showsVerticalScrollIndicator = false');
    expect(lock).toContain('showsHorizontalScrollIndicator = false');
  });

  it('normalizes UIKit notifications into target/settled events', () => {
    // TS geometry proves the math; this pins the native conversion path
    // (Split View / Slide Over / Stage Manager) without pretending TS
    // proves UIKit behavior. State answers only: current target, last
    // settled emission — not one variable per UIKit notification.
    const here = dirname(fileURLToPath(import.meta.url));
    const plugin = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/ios/Sources/FroglightKeyboardInsetPlugin.swift',
      ),
      'utf8',
    );
    expect(plugin).toContain('coordinateSpace.convert');
    // Prefer the keyboard notification's UIScreen when iOS supplies it;
    // older/nil notifications still resolve through the WebView's scene.
    expect(plugin).toContain('notification.object as? UIScreen');
    expect(plugin).toContain('windowScene?.screen');
    expect(plugin).not.toMatch(/webView\.convert\(screenFrame, from: nil\)/);
    expect(plugin).toContain('currentTargetHeight');
    expect(plugin).toContain('lastSettledHeight');
    expect(plugin).not.toContain('lastWillHeight');
    expect(plugin).not.toContain('lastChangeHeight');
    expect(plugin).not.toContain('lastDidHeight');
    expect(plugin).toContain('emitTarget');
    expect(plugin).toContain('emitSettled');
    expect(plugin).toContain('"target"');
    expect(plugin).toContain('"settled"');
    // Suppress the WKWebView observer registrations that otherwise
    // compete with Froglight's own full-size-WebView inset model.
    expect(plugin).toContain(
      'disableWebViewAutomaticKeyboardObservers(webview)',
    );
    for (const notification of [
      'keyboardWillHideNotification',
      'keyboardWillShowNotification',
      'keyboardWillChangeFrameNotification',
      'keyboardDidChangeFrameNotification',
    ]) {
      expect(plugin).toMatch(
        new RegExp(
          `removeObserver\\(\\s*webView,\\s*name: UIResponder\\.${notification}`,
        ),
      );
    }
    // Did frames are confirm-only: a zero end-frame never cancels a
    // Will-established session (transient zeros must not collapse the
    // adopted inset); hide authority stays willHide/didHide plus the
    // WillChangeFrame-zero undock extension.
    expect(plugin).toContain('else if currentTargetHeight == 0');
    // Floating keyboards must not shift layout (bottom-edge rule).
    expect(plugin).toContain('Only bottom-edge occlusion counts');
  });

  it('maps non-animated Android zero insets to hide semantics', () => {
    // Source validation (no JVM host): the non-animated insets path must
    // never emit target(0)/settled(0) — a zero height is a close. Anchored
    // on semantic statements, not formatting, like the Swift checks above.
    const here = dirname(fileURLToPath(import.meta.url));
    const plugin = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/android/src/main/java/FroglightKeyboardInsetPlugin.kt',
      ),
      'utf8',
    );
    // Positive steady heights emit target + settled; zero takes the
    // prior-visibility-guarded hide branch instead of an open target(0).
    expect(plugin).toContain('if (steady > 0)');
    expect(plugin).toContain('} else if (wasVisible) {');
    expect(plugin).toContain('emit("willHide", "{\\"durationMs\\":0}")');
    expect(plugin).toContain('emit("didHide", "{}")');
  });
});

describe('native keyboard-inset adapter', () => {
  it('routes hide/show through the trusted plugin commands', () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const host = createNativeKeyboardInset(call);
    host.store.handleNativeEvent('willShow', {
      height: 300,
      durationMs: 250,
    });
    host.store.hide();
    expect(call).toHaveBeenCalledWith(KEYBOARD_INSET_HIDE_COMMAND);
    expect(call).toHaveBeenCalledTimes(1);
    host.store.show();
    expect(call).toHaveBeenCalledWith(KEYBOARD_INSET_SHOW_COMMAND);
    // Closed stores never invoke: focus must not drop needlessly.
    host.store.handleNativeEvent('willHide', { durationMs: 200 });
    host.store.hide();
    expect(call).toHaveBeenCalledTimes(2);
    host.store.dispose();
  });

  it('forwards direct-eval native events into the store', () => {
    const host = createNativeKeyboardInset(
      vi.fn().mockResolvedValue(undefined),
    );
    const scope: Record<string, unknown> = {};
    const uninstall = installNativeKeyboardEventForwarder(host.store, scope);
    const hook = scope[KEYBOARD_INSET_EVENT_CHANNEL] as (
      event: string,
      payload: unknown,
    ) => void;
    expect(typeof hook).toBe('function');
    hook('willShow', { height: 320, durationMs: 250, measurement: 'exact' });
    expect(host.store.snapshot()).toMatchObject({
      height: 320,
      isOpen: true,
    });
    hook('willHide', { durationMs: 200 });
    expect(host.store.snapshot()).toMatchObject({ height: 0, isOpen: false });
    uninstall();
    expect(scope[KEYBOARD_INSET_EVENT_CHANNEL]).toBeUndefined();
    uninstall();
    host.store.dispose();
  });

  it('provides the token binding through the runtime lifecycle', async () => {
    const runtime = new Runtime();
    const host = createNativeKeyboardInset(
      vi.fn().mockResolvedValue(undefined),
    );
    await runtime.registerSlot({
      id: 'keyboard-inset',
      plugin: host.definition,
    });
    let seen = 0;
    await runtime.registerSlot({
      id: 'keyboard-inset-consumer',
      plugin: definePlugin({
        id: 'froglight.keyboard-inset.native-consumer',
        requirements: { requires: [keyboardInsetToken] },
        activate: (ctx) => {
          seen = ctx.require(keyboardInsetToken).snapshot().height;
        },
      }),
    });
    expect(seen).toBe(0);
    await runtime.dispose();
    host.store.dispose();
  });
});
