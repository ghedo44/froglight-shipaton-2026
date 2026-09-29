/**
 * Web stylus host adapter.
 *
 * The PWA has no native plugin: the shared ink engine already draws from
 * DOM Pointer Events, so the web host only reports browser API support as
 * host capabilities behind the same `stylusToken`. Observed hardware (real
 * pen attachments, pressure/tilt/twist sightings) is recorded separately
 * through `noteObservedPen` / diagnostics — never inferred from
 * `maxTouchPoints`. Graphics tablets exist on systems with
 * `maxTouchPoints === 0`, so touch-point counts are not pen evidence.
 */

import {
  createStylusHost,
  type StylusCapabilities,
  type StylusHost,
} from '@froglight/foundation';

export interface WebPointerProbe {
  readonly pointerEvent?: unknown;
  readonly getCoalescedEvents?: unknown;
  readonly maxTouchPoints?: unknown;
}

/**
 * Derive web-host capabilities from constructor/API presence. Pure and
 * DOM-free so tests and headless shells can inject a probe: pass nothing
 * on hosts without a window.
 *
 * Browser support only: `available` means the browser can deliver
 * pen-class PointerEvents, not that a stylus is connected. Touch-point
 * counts are ignored — tablets report `maxTouchPoints === 0`.
 */
export function probeWebStylusCapabilities(
  probe?: WebPointerProbe | null,
): StylusCapabilities {
  if (probe === undefined || probe === null) {
    return {
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
  }
  const pointer = typeof probe.pointerEvent === 'function';
  // `maxTouchPoints` is not pen evidence (graphics tablets report 0) and
  // is intentionally ignored here.
  return {
    // Input-path presence (see StylusCapabilities.available): the browser
    // can deliver pen-class pointer input. Not a hardware guarantee.
    available: pointer,
    pressure: pointer,
    tilt: pointer,
    twist: pointer,
    hover: pointer,
    // Standard PointerEvent button codes identify the barrel button as 2
    // and the eraser as 5; no native code is needed.
    eraser: pointer,
    barrelButton: pointer,
    // No web API exposes Pencil double-tap or squeeze; those stay false
    // until the native plugin reports them (native hosts only).
    doubleTap: false,
    squeeze: false,
  };
}

/** Host object for the web shell: capability definition for `extraPlugins`. */
export function createWebStylus(probe?: WebPointerProbe | null): StylusHost {
  return createStylusHost({
    initialCapabilities: probeWebStylusCapabilities(probe),
  });
}
