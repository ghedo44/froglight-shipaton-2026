/**
 * Native keyboard-inset host adapter.
 *
 * The trusted native plugin owns OS integration. Direct-eval target/settled
 * events are the fast path; `get_state` is only a cached-state recovery seam
 * for a lost JavaScript delivery. Geometry is never re-derived in this TS
 * adapter and native hosts do not run a second VisualViewport keyboard-height
 * detector.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  KEYBOARD_INSET_EVENT_CHANNEL,
  createKeyboardInset,
  type KeyboardInsetHost,
  type KeyboardInsetService,
} from '@froglight/foundation';

export const KEYBOARD_INSET_HIDE_COMMAND =
  'plugin:froglight-keyboard-inset|hide';
export const KEYBOARD_INSET_SHOW_COMMAND =
  'plugin:froglight-keyboard-inset|show';
export const KEYBOARD_INSET_STATE_COMMAND =
  'plugin:froglight-keyboard-inset|get_state';

export interface NativeKeyboardInsetState {
  /** Cached canonical native bottom occlusion in CSS-equivalent points. */
  readonly height: number;
  readonly isOpen: boolean;
  readonly isHiding: boolean;
}

export type NativeKeyboardInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** Tauri-invoke transport for the keyboard-inset store. */
export function createNativeKeyboardInsetTransport(
  call: NativeKeyboardInvoke = invoke,
) {
  return {
    hide: () => {
      void call(KEYBOARD_INSET_HIDE_COMMAND);
    },
    show: () => {
      void call(KEYBOARD_INSET_SHOW_COMMAND);
    },
  };
}

/** Host capability definition plus the store fed by native direct-eval. */
export function createNativeKeyboardInset(
  call: NativeKeyboardInvoke = invoke,
): KeyboardInsetHost {
  return createKeyboardInset({
    transport: createNativeKeyboardInsetTransport(call),
    storage:
      typeof localStorage === 'undefined'
        ? null
        : {
            getItem: (key) => localStorage.getItem(key),
            setItem: (key, value) => {
              localStorage.setItem(key, value);
            },
          },
  });
}

type EventHookTarget = Record<string, unknown>;

/**
 * Install the direct-eval entry point Android/iOS call into. Idempotent per
 * target and ownership-safe on uninstall/reload.
 */
export function installNativeKeyboardEventForwarder(
  store: KeyboardInsetService,
  target?: EventHookTarget,
): () => void {
  const scope =
    target ??
    (typeof window === 'undefined'
      ? null
      : (window as unknown as EventHookTarget));
  if (scope === null) return () => undefined;

  const previous = scope[KEYBOARD_INSET_EVENT_CHANNEL];
  const hook = (event: unknown, payload: unknown) => {
    if (typeof event !== 'string') return;
    store.handleNativeEvent(event, payload);
  };
  scope[KEYBOARD_INSET_EVENT_CHANNEL] = hook;

  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (scope[KEYBOARD_INSET_EVENT_CHANNEL] !== hook) return;
    if (previous === undefined) delete scope[KEYBOARD_INSET_EVENT_CHANNEL];
    else scope[KEYBOARD_INSET_EVENT_CHANNEL] = previous;
  };
}

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function readNativeKeyboardInsetState(
  value: unknown,
): NativeKeyboardInsetState | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const height = nonNegativeFinite(record.height);
  if (height === null) return null;
  const isHiding = record.isHiding === true;
  return {
    height,
    isOpen: record.isOpen === true || (!isHiding && height > 0),
    isHiding,
  };
}

/**
 * Reconcile the shared store with one trusted cached native readback.
 *
 * Positive geometry repairs a missed push. Zero deliberately remains
 * non-authoritative because the command is portable and unsupported targets
 * return a neutral zero state; normal willHide/didHide events own closing.
 */
export async function syncNativeKeyboardInsetState(
  store: KeyboardInsetService,
  call: NativeKeyboardInvoke = invoke,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await call(KEYBOARD_INSET_STATE_COMMAND);
  } catch {
    // Older binaries/transient IPC failures leave the direct event path intact.
    return;
  }

  const state = readNativeKeyboardInsetState(raw);
  if (state === null || state.isHiding || state.height <= 0) return;

  const snapshot = store.snapshot();
  if (!snapshot.isOpen || snapshot.height !== state.height) {
    store.handleNativeEvent('target', {
      height: state.height,
      durationMs: 0,
      measurement: 'exact',
    });
  }
  if (
    snapshot.reservedHeight !== state.height ||
    !snapshot.isOpen ||
    snapshot.height !== state.height
  ) {
    store.handleNativeEvent('settled', { height: state.height });
  }
}

export interface NativeKeyboardStateRecoveryOptions {
  /** Host-owned Tauri gate. Browser UA/platform strings do not gate IPC. */
  readonly enabled: boolean;
  readonly doc?: Document | null;
  readonly call?: NativeKeyboardInvoke;
  /** One settled verification after the normal keyboard animation window. */
  readonly settleDelayMs?: number;
}

function isKeyboardEditable(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return false;
  }
  return target.matches(
    'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  );
}

/**
 * Focus-triggered cached-state repair: one immediate read and one settled
 * read, never polling. Native direct events remain the normal animation path.
 */
export function installNativeKeyboardStateRecovery(
  store: KeyboardInsetService,
  options: NativeKeyboardStateRecoveryOptions,
): () => void {
  if (!options.enabled) return () => undefined;
  const doc =
    options.doc ?? (typeof document === 'undefined' ? null : document);
  if (doc === null) return () => undefined;
  const call = options.call ?? invoke;
  const settleDelayMs = options.settleDelayMs ?? 360;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const onFocusIn = (event: FocusEvent): void => {
    if (!isKeyboardEditable(event.target)) return;
    void syncNativeKeyboardInsetState(store, call);
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void syncNativeKeyboardInsetState(store, call);
    }, settleDelayMs);
  };

  doc.addEventListener('focusin', onFocusIn);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    doc.removeEventListener('focusin', onFocusIn);
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };
}
