/**
 * Native keyboard compatibility guards.
 *
 * The native host owns two narrowly different repairs:
 * - cached native state readback, gated only by the trusted Tauri boundary;
 * - iOS WebKit visual-pan compensation, gated to Apple mobile WebKit.
 *
 * Keyboard height itself has one native source of truth. There is no second
 * native-host VisualViewport height detector or geometry arbitration layer.
 */

import type { KeyboardInsetService } from '@froglight/foundation';
import { attachIosViewportPanGuard } from '@froglight/ui';
import {
  installNativeKeyboardStateRecovery,
  type NativeKeyboardInvoke,
} from './keyboard-inset.js';
import { isAppleMobile, isTauriRuntime } from './window-chrome.js';

export interface NativeKeyboardGuardOptions {
  readonly store: KeyboardInsetService;
  readonly doc?: Document;
  readonly isNativeHost?: () => boolean;
  readonly isIos?: () => boolean;
  /** Injectable trusted command transport for tests. */
  readonly stateCall?: NativeKeyboardInvoke;
}

/** Attach all native keyboard guards under one host-owned lifecycle. */
export function attachNativeKeyboardGuards(
  options: NativeKeyboardGuardOptions,
): () => void {
  const isNativeHost = options.isNativeHost ?? (() => isTauriRuntime());
  const isIos = options.isIos ?? (() => isAppleMobile());

  const detachPanGuard = attachIosViewportPanGuard({
    ...(options.doc !== undefined ? { doc: options.doc } : {}),
    isNativeHost,
    isIos,
    keyboardInsetHeight: () => options.store.snapshot().height,
  });
  const detachStateRecovery = installNativeKeyboardStateRecovery(
    options.store,
    {
      enabled: isNativeHost(),
      ...(options.doc !== undefined ? { doc: options.doc } : {}),
      ...(options.stateCall !== undefined ? { call: options.stateCall } : {}),
    },
  );

  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    detachStateRecovery();
    detachPanGuard();
  };
}
