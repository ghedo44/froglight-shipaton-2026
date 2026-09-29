/**
 * Hidden keyboard diagnostics (development only).
 *
 * Makes future iOS/WebKit regressions diagnosable without temporary console
 * logging. Never part of normal user-visible UI.
 */

import type { KeyboardInsetMeasurement } from '@froglight/foundation';
import { KEYBOARD_INSET_VAR } from '../keyboard-inset.js';
import { VISUAL_VIEWPORT_PAN_VAR } from './ios-viewport-pan-guard.js';

export interface KeyboardDiagnosticsViewport {
  readonly offsetTop?: number;
  readonly pageTop?: number;
}

export interface KeyboardDiagnosticsSnapshot {
  readonly keyboardInset: number;
  readonly measurement: KeyboardInsetMeasurement;
  readonly reservedHeight: number;
  readonly appliedInset: number;
  readonly visualViewportPageTop: number | null;
  readonly windowScrollY: number;
  readonly compatibilityCompensation: number;
  readonly editorViewportHeight: number | null;
}

export interface KeyboardDiagnosticsInput {
  readonly doc?: Document | null;
  readonly keyboardInset?: number;
  readonly measurement?: KeyboardInsetMeasurement;
  readonly reservedHeight?: number;
  readonly appliedInset?: number;
  readonly viewport?: KeyboardDiagnosticsViewport | null;
  readonly windowScrollY?: number;
  readonly editorViewportHeight?: number | null;
}

/** Pure collector: all DOM reads are injected so tests stay headless. */
export function collectKeyboardDiagnostics(
  input: KeyboardDiagnosticsInput = {},
): KeyboardDiagnosticsSnapshot {
  const doc = input.doc ?? (typeof document === 'undefined' ? null : document);
  const rawCompensation = doc?.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_PAN_VAR) ?? '';
  const compatibilityCompensation = Number.parseFloat(rawCompensation) || 0;
  const rawInset = doc?.documentElement.style.getPropertyValue(KEYBOARD_INSET_VAR) ?? '';
  const appliedInset =
    input.appliedInset ?? (Number.parseFloat(rawInset) || 0);
  return {
    keyboardInset: input.keyboardInset ?? 0,
    measurement: input.measurement ?? 'hint',
    reservedHeight: input.reservedHeight ?? 0,
    appliedInset,
    visualViewportPageTop:
      typeof input.viewport?.pageTop === 'number' && Number.isFinite(input.viewport.pageTop)
        ? input.viewport.pageTop
        : null,
    windowScrollY: input.windowScrollY ?? (typeof window === 'undefined' ? 0 : window.scrollY),
    compatibilityCompensation,
    editorViewportHeight: input.editorViewportHeight ?? null,
  };
}
