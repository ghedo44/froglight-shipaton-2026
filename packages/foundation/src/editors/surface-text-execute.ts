/**
 * Shared surface-text execute.
 *
 * Single mapping from grouped surface-text control ids onto the additive
 * `setSelectionStyle` text fields (foundation `tools.ts` owns the
 * verbatim-preserving merge; the shared engine owns the single history
 * gesture). Notebook, Ink, and Whiteboard share this implementation behind
 * their provider-owned id dialects (`${prefix}.text.*`); only the prefix
 * differs, never the value semantics or toggle direction.
 *
 * Dormant without text (`hasText: false` → false, no side effects) so
 * composition stays unresolved. H1/H2/H3 write `role: 'heading'` + H1/H2/H3
 * size (outline feed: the headings-only extractor consumes
 * `textRoleOf === 'heading'`); Body writes `role: 'body'` leaving size
 * alone; the size stepper writes an explicit `textSize` additively;
 * bold/italic toggle additively without normalizing unknowns; align sets
 * verbatim; text color sets the record `color` verbatim (existing
 * `SelectionStyle.color` path, which already applies to text); wrap
 * toggles the fixed default (never measured widths).
 *
 * No DOM, Canvas, or engine types cross here — the host supplies
 * provider-computed selection state and the `setSelectionStyle` bridge.
 */

import type { SelectionStyle } from '../surfaces/tools.js';
import {
  SURFACE_TEXT_H1_SIZE,
  SURFACE_TEXT_H2_SIZE,
  SURFACE_TEXT_H3_SIZE,
} from './surface-text-builder.js';

/** Narrow host seam for the shared text write path. */
export interface SurfaceTextExecuteHost {
  textSelectionState(): import('./surface-text-builder.js').SurfaceTextSelectionState;
  setSelectionStyle(style: SelectionStyle): unknown;
}

/**
 * Execute one grouped surface-text control for `prefix`
 * (`${prefix}.text.style` / `.size` / `.bold` / `.italic` / `.align` /
 * `.color` / `.wrap`). Returns true when handled, false for dormant
 * selections, unknown values, or ids outside the prefix dialect (never
 * mutates on false).
 */
export function executeSurfaceTextControl(
  host: SurfaceTextExecuteHost,
  prefix: string,
  id: string,
  value: unknown,
): boolean {
  const state = host.textSelectionState();
  if (state.hasText !== true) return false;
  if (id === `${prefix}.text.style`) {
    if (value === 'body') {
      host.setSelectionStyle({ textRole: 'body' });
      return true;
    }
    if (value === 'h1') {
      host.setSelectionStyle({
        textRole: 'heading',
        textSize: SURFACE_TEXT_H1_SIZE,
      });
      return true;
    }
    if (value === 'h2') {
      host.setSelectionStyle({
        textRole: 'heading',
        textSize: SURFACE_TEXT_H2_SIZE,
      });
      return true;
    }
    if (value === 'h3') {
      host.setSelectionStyle({
        textRole: 'heading',
        textSize: SURFACE_TEXT_H3_SIZE,
      });
      return true;
    }
    return false;
  }
  if (id === `${prefix}.text.size`) {
    const size = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(size) || size <= 0 || size > 1e9) return false;
    host.setSelectionStyle({ textSize: size });
    return true;
  }
  if (id === `${prefix}.text.bold`) {
    const turnOn = !(state.bold.active === true && state.bold.mixed === false);
    host.setSelectionStyle({ textBold: turnOn });
    return true;
  }
  if (id === `${prefix}.text.italic`) {
    const turnOn = !(
      state.italic.active === true && state.italic.mixed === false
    );
    host.setSelectionStyle({ textItalic: turnOn });
    return true;
  }
  if (id === `${prefix}.text.align`) {
    if (value === 'start' || value === 'center' || value === 'end') {
      host.setSelectionStyle({ textAlign: value });
      return true;
    }
    return false;
  }
  if (id === `${prefix}.text.color`) {
    if (typeof value === 'string' && value.length > 0) {
      host.setSelectionStyle({ color: value });
      return true;
    }
    return false;
  }
  if (id === `${prefix}.text.wrap`) {
    const turnOn = !(state.wrap.active === true && state.wrap.mixed === false);
    host.setSelectionStyle({ textWrap: turnOn });
    return true;
  }
  return false;
}
