/**
 * Keyboard-inset capability contract.
 *
 * The OS soft keyboard overlays the full-size WebView; it never resizes it.
 * Native hosts report inset transitions and this contract carries them to
 * consumers behind `keyboardInsetToken` — no Tauri, DOM, or framework types
 * leak into the service surface. Hosts inject a `KeyboardInsetTransport`
 * for `hide()`/`show()`; the web host drives the same events from
 * `visualViewport`, headless uses noop.
 *
 * Behavior derived from `dash-chat/tauri-plugin-virtual-keyboard`
 * (MIT OR Apache-2.0); reimplemented as Froglight-owned code with no
 * dependency on that repository.
 */

export type KeyboardInsetMeasurement = 'exact' | 'hint';

/**
 * Keyboard target geometry: the height layout should adopt, with the
 * quality of the measurement and the animation timing when the host knows
 * it. Covers both initial appearance and mid-session resizes (rotation,
 * emoji/predictive/language keyboards, docking, Stage Manager) — one
 * concept, not one event per UIKit notification.
 */
export interface KeyboardInsetTargetEvent {
  /** Target keyboard height in CSS px. */
  readonly height: number;
  /** Native animation duration in milliseconds (0 when unknown). */
  readonly durationMs: number;
  /**
   * Geometry quality: `exact` (authoritative occlusion, never reconciled
   * against history) or `hint` (approximate animation-start geometry where
   * reconciliation with settled history is allowed). Missing/unknown values
   * default to `hint` for backwards compatibility with older native
   * payloads, tests, and Android hints.
   */
  readonly measurement: KeyboardInsetMeasurement;
}

export interface KeyboardInsetWillHideEvent {
  /** Native close-animation duration in milliseconds. */
  readonly durationMs: number;
}

export interface KeyboardInsetSnapshot {
  /** Live keyboard height in CSS px (0 while closed). */
  readonly height: number;
  readonly isOpen: boolean;
  /**
   * Latest accepted settled keyboard height, persisted across sessions,
   * or the fallback before any settled keyboard geometry has been
   * observed. Latest wins rather than a running maximum: one anomalously
   * tall settle must never stick forever. Layout reserves this while a
   * below-keyboard surface or dialog hold owns the bottom slot.
   */
  readonly reservedHeight: number;
}

/**
 * Host-provided native control. Implemented with Tauri invoke on native,
 * noop elsewhere. Focus management (blur before hide) is a DOM-layer
 * concern and lives in the UI binder, not here.
 */
export interface KeyboardInsetTransport {
  hide(): void | Promise<void>;
  show(): void | Promise<void>;
}

export const noopKeyboardInsetTransport: KeyboardInsetTransport = {
  hide: () => undefined,
  show: () => undefined,
};

/**
 * Native wire events. `target`/`settled` are the normalized names both
 * native adapters emit; `willShow`/`didShow` are legacy aliases for older
 * native builds and map to the same handling. `change` is the web
 * VisualViewport fallback: it updates the live snapshot and feeds the
 * settled debounce, but announces no native-style target intent because
 * the browser source has no reliable animation target.
 */
export type KeyboardInsetNativeEventName =
  | 'target'
  | 'settled'
  | 'willHide'
  | 'didHide'
  | 'change'
  | 'willShow'
  | 'didShow';

/** Direct-eval hook name the native hosts call into. */
export const KEYBOARD_INSET_EVENT_CHANNEL =
  '__FROGLIGHT_KEYBOARD_INSET_EVENT__';

/** Fallback slot height before any keyboard has been observed. */
export const KEYBOARD_INSET_FALLBACK_HEIGHT = 270;

/** Persisted settled-height key (fresh namespace; no poisoned legacy). */
export const KEYBOARD_INSET_STORAGE_KEY = 'froglight:keyboard-inset-height-v1';

/** Settle reports must survive this window to count (swap-gap guard). */
export const KEYBOARD_INSET_SETTLE_DEBOUNCE_MS = 120;

/**
 * Best guess of where the IME will settle. The `willShow` target comes
 * from the insets-animation hint, which some IMEs over-report relative to
 * the settled inset — gliding to it overshoots and visibly resettles once
 * `didShow` corrects. When the target is close to the last settled height,
 * trust the settled one; a clearly different target (another IME,
 * orientation change) wins.
 *
 * Applies to `hint` measurements only. `exact` UIKit geometry bypasses
 * reconciliation entirely (see the store): a persisted height must never
 * override exact iOS geometry.
 */
export function reconcileKeyboardInsetTarget(
  target: number,
  settled: number,
): number {
  if (settled > 0 && Math.abs(target - settled) < 60) return settled;
  return target;
}

/**
 * Read the semantic measurement from a native payload. Returns `exact`
 * only for the explicit string; every other value (missing, malformed,
 * unknown, older native builds, Android hints) defaults to `hint` so
 * reconciliation policy stays safe.
 */
export function readKeyboardInsetMeasurement(
  payload: unknown,
): KeyboardInsetMeasurement {
  if (typeof payload === 'object' && payload !== null) {
    const value = (payload as Record<string, unknown>).measurement;
    if (value === 'exact') return 'exact';
  }
  return 'hint';
}

/**
 * Bottom-edge occlusion of a WebView by a keyboard frame already expressed
 * in WebView coordinates (mirrors the iOS `keyboardInset` helper).
 *
 * `webView` is `{ height }`-style bounds with `maxY = y + height`;
 * `keyboard` is the keyboard rect in the same space. Floating keyboards
 * that do not reach the bottom edge produce 0 so the app is not shifted.
 */
export interface KeyboardInsetRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function computeKeyboardBottomInset(
  webView: KeyboardInsetRect,
  keyboardInWebView: KeyboardInsetRect,
): number {
  const ix0 = Math.max(webView.x, keyboardInWebView.x);
  const iy0 = Math.max(webView.y, keyboardInWebView.y);
  const ix1 = Math.min(
    webView.x + webView.width,
    keyboardInWebView.x + keyboardInWebView.width,
  );
  const iy1 = Math.min(
    webView.y + webView.height,
    keyboardInWebView.y + keyboardInWebView.height,
  );
  if (!(ix1 > ix0 && iy1 > iy0)) return 0;
  // Only bottom-edge occlusion shifts layout: a floating keyboard that
  // ends mid-WebView must produce zero even though it intersects.
  const webBottom = webView.y + webView.height;
  if (iy1 < webBottom - 1) return 0;
  return Math.max(0, webBottom - iy0);
}

export type KeyboardInsetListener = (snapshot: KeyboardInsetSnapshot) => void;
export type KeyboardInsetTargetListener = (
  event: KeyboardInsetTargetEvent,
) => void;
export type KeyboardInsetWillHideListener = (
  event: KeyboardInsetWillHideEvent,
) => void;
export type KeyboardInsetSettledListener = (height: number) => void;

/**
 * Stable keyboard-inset service behind `keyboardInsetToken`. Framework- and
 * host-free: feed it with `handleNativeEvent` from the Tauri direct-eval
 * hook, the `visualViewport` fallback, or tests.
 */
export interface KeyboardInsetService {
  snapshot(): KeyboardInsetSnapshot;
  /** Subscribe to every snapshot change; returns an unregister function. */
  subscribe(listener: KeyboardInsetListener): () => void;
  /**
   * Target geometry (initial appearance and mid-session resizes). Exact
   * targets update layout immediately; hints may reconcile/glide delayed.
   */
  onTargetChange(listener: KeyboardInsetTargetListener): () => void;
  onWillHide(listener: KeyboardInsetWillHideListener): () => void;
  /** Settled heights, which can differ from the glide target. */
  onSettled(listener: KeyboardInsetSettledListener): () => void;
  /**
   * Ingest one native event. Malformed payloads are ignored (a corrupt
   * height must never collapse layout). Invariant: height <= 0 always
   * means closed — zero-height targets are rejected, so the store can
   * never expose height = 0 with isOpen = true.
   */
  handleNativeEvent(
    event: KeyboardInsetNativeEventName | string,
    payload: unknown,
  ): void;
  /** Retract via the OS. No-op while closed. */
  hide(): void;
  /** Summon for the currently focused input. No-op off native. */
  show(): void;
}
