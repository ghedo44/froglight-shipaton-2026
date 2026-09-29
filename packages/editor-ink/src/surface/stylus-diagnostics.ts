/**
 * Stylus diagnostics snapshot.
 *
 * Pure, DOM-free collector behind the hidden Stylus Diagnostics view
 * (React-owned; providers never create visible DOM). It
 * merges one PointerEvent-class sample (pressure/tilt/twist/buttons plus
 * coalesced/predicted counts) with the latest `StylusCapabilities` and
 * recent `StylusAction` reports so physical-device testing can show
 * exactly what each WebView already exposes before native code grows.
 */

import {
  observedPenFlags,
  type StylusAction,
  type StylusCapabilities,
  type StylusObservedPenSample,
} from '@froglight/foundation';

export interface StylusPointerSample {
  readonly pointerType?: string;
  readonly button?: number;
  readonly buttons?: number;
  readonly pressure?: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly altitudeAngle?: number;
  readonly azimuthAngle?: number;
  readonly twist?: number;
  readonly coalescedCount?: number;
  readonly predictedCount?: number;
}

export interface StylusDiagnosticsSnapshot {
  readonly pointerType: string;
  readonly button: number | null;
  readonly buttons: number | null;
  readonly pressure: number | null;
  readonly tiltX: number | null;
  readonly tiltY: number | null;
  readonly altitudeAngle: number | null;
  readonly azimuthAngle: number | null;
  readonly twist: number | null;
  readonly coalescedCount: number | null;
  readonly predictedCount: number | null;
  readonly observed: {
    /** Device matrix promoted from real pen-class samples. */
    readonly pressure: boolean;
    readonly tilt: boolean;
    readonly twist: boolean;
    readonly hover: boolean;
    readonly barrelButton: boolean;
    readonly eraser: boolean;
    readonly coalesced: boolean;
    readonly predicted: boolean;
  };
  readonly native: {
    readonly capabilities: StylusCapabilities;
    readonly recentActions: readonly StylusAction[];
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Ring buffer of recent native accessory actions (diagnostics only). */
export class RecentStylusActions {
  readonly #actions: StylusAction[] = [];
  readonly #limit: number;

  constructor(limit = 8) {
    this.#limit = Math.max(limit, 1);
  }

  push(action: StylusAction): void {
    this.#actions.push(action);
    while (this.#actions.length > this.#limit) this.#actions.shift();
  }

  list(): readonly StylusAction[] {
    return [...this.#actions];
  }
}

export function collectStylusDiagnostics(
  sample: StylusPointerSample,
  capabilities: StylusCapabilities,
  recentActions: readonly StylusAction[],
): StylusDiagnosticsSnapshot {
  const isPen = sample.pointerType === 'pen';
  // Single-source predicates: the service device matrix and this snapshot
  // agree on what counts as observed hardware.
  const flags = observedPenFlags(sample);
  return {
    pointerType:
      typeof sample.pointerType === 'string' ? sample.pointerType : 'unknown',
    button: finiteOrNull(sample.button),
    buttons: finiteOrNull(sample.buttons),
    pressure: finiteOrNull(sample.pressure),
    tiltX: finiteOrNull(sample.tiltX),
    tiltY: finiteOrNull(sample.tiltY),
    altitudeAngle: finiteOrNull(sample.altitudeAngle),
    azimuthAngle: finiteOrNull(sample.azimuthAngle),
    twist: finiteOrNull(sample.twist),
    coalescedCount: finiteOrNull(sample.coalescedCount),
    predictedCount: finiteOrNull(sample.predictedCount),
    observed: {
      pressure: flags.pressure,
      tilt: flags.tilt,
      twist: flags.twist,
      hover: isPen,
      barrelButton: flags.barrelButton,
      eraser: flags.eraser,
      coalesced: flags.coalesced,
      predicted: flags.predicted,
    },
    native: {
      capabilities: { ...capabilities },
      recentActions: [...recentActions],
    },
  };
}

/**
 * Feed one real `pointerType === 'pen'` sample into the service's observed
 * device matrix. No-ops for non-pen samples so mouse/touch never promote
 * stylus hardware flags.
 */
export function observeStylusPenSample(
  note: (sample: StylusObservedPenSample) => void,
  sample: StylusPointerSample & { readonly hoverObserved?: boolean },
): void {
  if (sample.pointerType !== 'pen') return;
  note({
    pointerType: 'pen',
    ...(sample.pressure !== undefined ? { pressure: sample.pressure } : {}),
    ...(sample.tiltX !== undefined ? { tiltX: sample.tiltX } : {}),
    ...(sample.tiltY !== undefined ? { tiltY: sample.tiltY } : {}),
    ...(sample.twist !== undefined ? { twist: sample.twist } : {}),
    ...(sample.hoverObserved === true ? { hover: true as const } : {}),
    ...(sample.button !== undefined ? { button: sample.button } : {}),
    ...(sample.buttons !== undefined ? { buttons: sample.buttons } : {}),
    ...(sample.coalescedCount !== undefined
      ? { coalescedCount: sample.coalescedCount }
      : {}),
    ...(sample.predictedCount !== undefined
      ? { predictedCount: sample.predictedCount }
      : {}),
  });
}
