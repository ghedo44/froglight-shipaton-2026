/**
 * Stylus accessory capability contract.
 *
 * Semantic, device-neutral accessory events for Apple Pencil, Android
 * stylus (S Pen / USI), Surface Pen, and graphics tablets. High-frequency
 * stroke samples stay in the DOM `PointerEvent` pipeline and never cross
 * this contract: native hosts emit accessory actions only
 * (double-tap, squeeze, eraser, barrel buttons, proximity, capabilities).
 *
 * Host- and framework-free: no Tauri, DOM, React, or vendor SDK types
 * leak into the service surface. Hosts feed native accessory events via
 * `handleNativeAction`; the web host derives capabilities from
 * `PointerEvent` support; headless uses the noop provider.
 */

export interface StylusCapabilities {
  /**
   * The host has a stylus-capable input path: the native plugin is bound
   * (Tauri hosts) or the browser exposes pen-class PointerEvent APIs (web).
   * This is input-path presence, not a guarantee that pen hardware is
   * currently attached — live `pointerType` in diagnostics answers that.
   * Host capabilities describe API support, never observed hardware.
   */
  readonly available: boolean;
  readonly pressure: boolean;
  readonly tilt: boolean;
  readonly twist: boolean;
  readonly hover: boolean;
  readonly eraser: boolean;
  readonly barrelButton: boolean;
  readonly doubleTap: boolean;
  readonly squeeze: boolean;
}

/** Host capability: API/input-path support, not observed hardware. */
export type StylusHostCapabilities = StylusCapabilities;

export const DEFAULT_STYLUS_CAPABILITIES: StylusCapabilities = {
  available: false,
  pressure: false,
  tilt: false,
  twist: false,
  hover: false,
  eraser: false,
  barrelButton: false,
  doubleTap: false,
  squeeze: false,
};

/** Native-host query result: the current capability state as state. */
export type NativeStylusCapabilities = StylusCapabilities;

export type StylusDeviceFlag = boolean | 'unknown';

/**
 * Observed/device capability: what pen hardware has actually demonstrated.
 * Starts unknown; diagnostics and accessory actions promote flags to true
 * monotonically. `squeeze: true` therefore means a squeeze was observed,
 * never "the OS exposes a squeeze API".
 */
export interface StylusDeviceCapabilities {
  readonly connected: StylusDeviceFlag;
  readonly pressure: StylusDeviceFlag;
  readonly tilt: StylusDeviceFlag;
  readonly twist: StylusDeviceFlag;
  readonly hover: StylusDeviceFlag;
  readonly eraser: StylusDeviceFlag;
  readonly barrelButton: StylusDeviceFlag;
  readonly doubleTap: StylusDeviceFlag;
  readonly squeeze: StylusDeviceFlag;
}

export const DEFAULT_STYLUS_DEVICE_CAPABILITIES: StylusDeviceCapabilities = {
  connected: 'unknown',
  pressure: 'unknown',
  tilt: 'unknown',
  twist: 'unknown',
  hover: 'unknown',
  eraser: 'unknown',
  barrelButton: 'unknown',
  doubleTap: 'unknown',
  squeeze: 'unknown',
};

/** Minimal observed pen sample for device-capability promotion. */
export interface StylusObservedPenSample {
  readonly pointerType?: string;
  readonly pressure?: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly twist?: number;
  readonly hover?: boolean;
  readonly button?: number;
  readonly buttons?: number;
  readonly coalescedCount?: number;
  readonly predictedCount?: number;
}

/** Hardware evidence derived from one pen-class sample (all false for non-pen). */
export interface StylusObservedPenFlags {
  readonly connected: boolean;
  readonly pressure: boolean;
  readonly tilt: boolean;
  readonly twist: boolean;
  readonly hover: boolean;
  readonly eraser: boolean;
  readonly barrelButton: boolean;
  readonly coalesced: boolean;
  readonly predicted: boolean;
}

function isInformativeAxis(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

/**
 * Single-source pen-observation predicates shared by the service device
 * matrix (`noteObservedPen`) and the diagnostics snapshot, so the two can
 * never disagree about what counts as observed hardware. Non-pen samples
 * yield all-false flags; default-valued axes (pressure 0.5, zero tilt)
 * mean "no data", never evidence.
 */
export function observedPenFlags(
  sample: StylusObservedPenSample,
): StylusObservedPenFlags {
  if (sample.pointerType !== 'pen') {
    return {
      connected: false,
      pressure: false,
      tilt: false,
      twist: false,
      hover: false,
      eraser: false,
      barrelButton: false,
      coalesced: false,
      predicted: false,
    };
  }
  const pressure =
    typeof sample.pressure === 'number' &&
    Number.isFinite(sample.pressure) &&
    sample.pressure !== 0.5;
  const tilt =
    isInformativeAxis(sample.tiltX) || isInformativeAxis(sample.tiltY);
  const twist = isInformativeAxis(sample.twist);
  return {
    connected: true,
    pressure,
    tilt,
    twist,
    hover: sample.hover === true,
    eraser:
      sample.button === 5 ||
      (typeof sample.buttons === 'number' && (sample.buttons & 32) !== 0),
    barrelButton: sample.button === 2,
    coalesced:
      typeof sample.coalescedCount === 'number' && sample.coalescedCount > 0,
    predicted:
      typeof sample.predictedCount === 'number' && sample.predictedCount > 0,
  };
}

/**
 * Device-neutral preferred accessory action selected by the user in system
 * settings (e.g. iPad Settings → Apple Pencil → Double Tap / Squeeze).
 * Deliberately free of Apple-specific names (`ApplePencilAction`,
 * `UIPencilHoverPose` must never appear in foundation).
 */
export type StylusPreferredAction =
  | 'ignore'
  | 'switchEraser'
  | 'switchPrevious'
  | 'showColorPalette'
  | 'showInkAttributes'
  | 'showContextualPalette'
  | 'runSystemShortcut'
  | 'unknown';

/** Viewport anchor in CSS-pixel space (origin: top-left of the WebView). */
export interface StylusViewportAnchor {
  readonly x: number;
  readonly y: number;
}

export type StylusSqueezePhase = 'began' | 'changed' | 'ended' | 'cancelled';

export type StylusAction =
  | {
      readonly type: 'doubleTap';
      readonly preferredAction?: StylusPreferredAction;
      readonly anchor?: StylusViewportAnchor;
    }
  | {
      readonly type: 'squeeze';
      readonly phase?: StylusSqueezePhase;
      readonly preferredAction?: StylusPreferredAction;
      readonly anchor?: StylusViewportAnchor;
    }
  | { readonly type: 'primaryButton'; readonly pressed: boolean }
  | { readonly type: 'secondaryButton'; readonly pressed: boolean }
  | { readonly type: 'eraser'; readonly active: boolean }
  | { readonly type: 'proximity'; readonly active: boolean };

export type StylusActionListener = (action: StylusAction) => void;
export type StylusCapabilitiesListener = (
  capabilities: StylusCapabilities,
) => void;
export type StylusDeviceCapabilitiesListener = (
  capabilities: StylusDeviceCapabilities,
) => void;

/** Native event channel the Tauri hosts call into. */
export const STYLUS_NATIVE_EVENT_CHANNEL = '__FROGLIGHT_STYLUS_EVENT__';

export type StylusNativeEventName = 'action' | 'capabilities' | string;

/** Ephemeral authoring intent; hosts choose the platform input policy. */
export type StylusInputContext = 'default' | 'drawing' | 'text-entry';

export interface StylusInputPolicy {
  /** Text entry overrides drawing. Each owner releases its own claim once. */
  acquireInputContext(
    context: Exclude<StylusInputContext, 'default'>,
  ): () => void;
}

/**
 * Stable stylus service behind `stylusToken`. Framework- and host-free:
 * feed it with `handleNativeEvent` from the Tauri hook, the web
 * `PointerEvent` capability probe, diagnostics, or tests.
 */
export interface StylusService extends StylusInputPolicy {
  inputContext(): StylusInputContext;
  onInputContextChange(
    listener: (context: StylusInputContext) => void,
  ): () => void;
  capabilities(): StylusCapabilities;
  /** Subscribe to capability changes; returns an unregister function. */
  onCapabilitiesChange(listener: StylusCapabilitiesListener): () => void;
  /** Subscribe to accessory actions; returns an unregister function. */
  onAction(listener: StylusActionListener): () => void;
  /**
   * Ingest one native event. Malformed payloads are ignored (a corrupt
   * accessory report must never break drawing).
   */
  handleNativeEvent(event: StylusNativeEventName, payload: unknown): void;
  /** Observed device capabilities (monotonic `unknown` → `true`). */
  deviceCapabilities(): StylusDeviceCapabilities;
  onDeviceChange(listener: StylusDeviceCapabilitiesListener): () => void;
  /** Promote device flags from one observed pen-class sample. */
  noteObservedPen(sample: StylusObservedPenSample): void;
}
