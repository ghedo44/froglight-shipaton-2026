/**
 * Shared Surface-text toolbar grammar.
 *
 * Notebook, Ink, and Whiteboard surface text (`froglight.text` on bounded
 * pages via the shared ink engine) exposes one grouped text vocabulary —
 * Style selector (Body/H1/H2/H3), Font-size stepper, Bold/Italic toggles,
 * Align selector, Text-color picker, Wrap toggle — through separately
 * maintained Document Tools snapshots. This module owns that shareable
 * presentation subset behind the provider-neutral Document Tools seam: one
 * place for control shapes (label, icon, group, semantic role, activation
 * role), canonical ordering, and the selection-state contract, with
 * provider-owned control ids and provider-computed selection state passed
 * in at each call site.
 *
 * Presentation-only slice: this module performs no commands and
 * interprets no editor state beyond the plain-data
 * `SurfaceTextSelectionState` the provider derives from its selection. The
 * write path (role/appearance mutation, history, overlay read) lands in
 * ink/whiteboard adoption lands in. Providers omit the group
 * entirely when no text is selected — composition items stay unresolved
 * (never synthesized) — so the group is dormant where unsupported.
 *
 *  semantics preview (must match the write path):
 * - Body reads/writes `role: 'body'`; H1/H2/H3 read/write `role: 'heading'`
 *   (overlay/canvas render heading weight-only, never size/box).
 * - H1/H2/H3 split on effective size: `appearance.size` when valid, else
 *   the record `size`, else 16. At/above `SURFACE_TEXT_H1_MIN_SIZE` reads
 *   as H1; at/above `SURFACE_TEXT_H2_MIN_SIZE` reads as H2; below reads as
 *  H3. writes H1/H2/H3 as heading + H1/H2/H3 size; Body derivation
 *   ignores size (Body writes leave size alone).
 * - The size stepper reads the unanimous effective size (`'mixed'` on
 *   disagreement) and writes an explicit size additively without
 *   normalizing unknown roles or aligns.
 * - Bold/italic read additive `appearance` traits (`bold`/`italic` when
 *  exactly `true`); absent/other values read inactive. writes them
 *   additively without normalizing unknown roles or aligns.
 * - Align reads the effective alignment (unknown degrades to `start`,
 *   layout-only); text color reads the unanimous record `color`
 *   (absent reads `SURFACE_TEXT_DEFAULT_COLOR`, disagreement reads
 *   `'mixed'`); wrap reads valid `wrapWidth` (present means wrapped).
 *
 * No DOM, Canvas, or engine types cross this module — the provider copies
 * plain values into `SurfaceTextSelectionState`.
 */

import type { DocumentToolControl } from './tools.js';

/** Canonical text-style value (preview, adds H3).*/
export type SurfaceTextStyleValue = 'body' | 'h1' | 'h2' | 'h3';

/** Effective text alignment values (mirrors the surface `TextAlign`). */
export type SurfaceTextAlignValue = 'start' | 'center' | 'end';

/**
 * H1/H2/H3 size split:
 * a heading whose effective size is at/above `SURFACE_TEXT_H1_MIN_SIZE`
 * reads as H1; at/above `SURFACE_TEXT_H2_MIN_SIZE` reads as H2; below
 * that it reads as H3. The writer uses `SURFACE_TEXT_H1_SIZE` /
 * `SURFACE_TEXT_H2_SIZE` / `SURFACE_TEXT_H3_SIZE` so the round trip is
 * stable; Body writes leave size alone.
 */
export const SURFACE_TEXT_H1_MIN_SIZE = 24;
export const SURFACE_TEXT_H1_SIZE = 24;
export const SURFACE_TEXT_H2_MIN_SIZE = 20;
export const SURFACE_TEXT_H2_SIZE = 20;
export const SURFACE_TEXT_H3_SIZE = 18;

/** Fallback effective size when neither `appearance.size` nor `size` is valid. */
export const SURFACE_TEXT_DEFAULT_SIZE = 16;

/** Fallback text color when the record carries no color (matches pen default). */
export const SURFACE_TEXT_DEFAULT_COLOR = '#37352f';

/** Shared text-color swatches (same family palette as stroke color). */
export const SURFACE_TEXT_COLOR_SWATCHES: readonly string[] = [
  '#37352f',
  '#7c6cf0',
  '#c4554d',
  '#448361',
  '#a08430',
];

/** Font-size stepper bounds (surface units, step 1). */
export const SURFACE_TEXT_SIZE_MIN = 8;
export const SURFACE_TEXT_SIZE_MAX = 96;
export const SURFACE_TEXT_SIZE_STEP = 1;

/** Provider-computed toggle state for one text control. Absent/false reads inactive. */
export interface SurfaceTextToggleState {
  readonly active: boolean;
  readonly mixed: boolean;
}

/**
 * Provider-computed text selection state (plain data). The provider is the
 * sole interpreter of selection records; the builder only carries the
 * flags into control shapes. `hasText: false` means no text in the
 * selection — the builder emits nothing and composition stays dormant.
 */
export interface SurfaceTextSelectionState {
  readonly hasText: boolean;
  readonly style: SurfaceTextStyleValue | 'mixed';
  readonly size: number | 'mixed';
  readonly bold: SurfaceTextToggleState;
  readonly italic: SurfaceTextToggleState;
  readonly align: SurfaceTextAlignValue | 'mixed';
  readonly color: string | 'mixed';
  readonly wrap: SurfaceTextToggleState;
}

/** Dormant text state: no text selected, builder emits nothing. */
export const NO_SURFACE_TEXT_SELECTION: SurfaceTextSelectionState = {
  hasText: false,
  style: 'mixed',
  size: 'mixed',
  bold: { active: false, mixed: false },
  italic: { active: false, mixed: false },
  align: 'mixed',
  color: 'mixed',
  wrap: { active: false, mixed: false },
};

/** Canonical text slot: one entry per grouped text control. */
export type SharedSurfaceTextSlot =
  | 'style'
  | 'size'
  | 'bold'
  | 'italic'
  | 'align'
  | 'color'
  | 'wrap';

/** Canonical slot order: Style, Size, Bold, Italic, Align, Color, Wrap. */
export const SURFACE_TEXT_ORDER: readonly SharedSurfaceTextSlot[] = [
  'style',
  'size',
  'bold',
  'italic',
  'align',
  'color',
  'wrap',
];

interface SharedSurfaceTextPresentation {
  readonly label: string;
  readonly shortLabel?: string;
  readonly icon?: string;
  readonly semanticRole: string;
}

/**
 * Canonical text presentation (extended). Order follows
 * `SURFACE_TEXT_ORDER` so snapshot order, shelf order, and composition
 * order agree across Notebook, Ink, and Whiteboard once adopts the
 * builder.
 *
 * Icons use only approved registry names shared with the UI icon set.
 * Wrap carries no icon (none exists in the registry); it renders label-only.
 * Size (number stepper) and Color (color picker) carry no icon; the shared
 * renderer draws the numeric value / color dot.
 */
const SHARED_SURFACE_TEXT_TABLE: Record<
  SharedSurfaceTextSlot,
  SharedSurfaceTextPresentation
> = {
  style: {
    label: 'Text style',
    icon: 'heading',
    semanticRole: 'surface.text.style',
  },
  size: {
    label: 'Font size',
    semanticRole: 'surface.text.size',
  },
  bold: {
    label: 'Bold',
    shortLabel: 'B',
    icon: 'bold',
    semanticRole: 'surface.text.bold',
  },
  italic: {
    label: 'Italic',
    shortLabel: 'I',
    icon: 'italic',
    semanticRole: 'surface.text.italic',
  },
  align: {
    label: 'Text alignment',
    icon: 'align',
    semanticRole: 'surface.text.align',
  },
  color: {
    label: 'Text color',
    semanticRole: 'surface.text.color',
  },
  wrap: {
    label: 'Wrap text',
    shortLabel: 'Wrap',
    semanticRole: 'surface.text.wrap',
  },
};

/** Provider-owned control ids per canonical slot (the per-family dialect). */
export interface SurfaceTextControlIds {
  readonly style: string;
  readonly size: string;
  readonly bold: string;
  readonly italic: string;
  readonly align: string;
  readonly color: string;
  readonly wrap: string;
}

/** Provider-owned ids for one prefix (`${prefix}.text.style`, …). */
export function surfaceTextControlIds(prefix: string): SurfaceTextControlIds {
  return {
    style: `${prefix}.text.style`,
    size: `${prefix}.text.size`,
    bold: `${prefix}.text.bold`,
    italic: `${prefix}.text.italic`,
    align: `${prefix}.text.align`,
    color: `${prefix}.text.color`,
    wrap: `${prefix}.text.wrap`,
  };
}

function toggleFlags(state: SurfaceTextToggleState): {
  readonly active?: true;
  readonly mixed?: true;
} {
  return {
    ...(state.active === true ? { active: true as const } : {}),
    ...(state.mixed === true ? { mixed: true as const } : {}),
  };
}

/**
 * Build one Style selector from the provider-computed style value.
 * `mixed` (disagreement or unmapped roles) emits the indeterminate value
 * `''` — matching the arrange-align convention — so the renderer never
 * claims a style the selection does not unanimously hold.
 */
export function surfaceTextStyleControl(
  id: string,
  style: SurfaceTextStyleValue | 'mixed',
): DocumentToolControl {
  const presentation = SHARED_SURFACE_TEXT_TABLE.style;
  return {
    kind: 'choice',
    id,
    group: 'text',
    label: presentation.label,
    ...(presentation.icon !== undefined ? { icon: presentation.icon } : {}),
    value: style === 'mixed' ? '' : style,
    options: [
      { value: 'body', label: 'Body' },
      { value: 'h1', label: 'Heading 1' },
      { value: 'h2', label: 'Heading 2' },
      { value: 'h3', label: 'Heading 3' },
    ],
    semanticRole: presentation.semanticRole,
  };
}

/**
 * Build one Font-size stepper from the provider-computed effective size.
 * `mixed` (disagreement) emits `SURFACE_TEXT_DEFAULT_SIZE` so the stepper
 * always shows a valid number — stepping from a mixed selection writes an
 * explicit size onto every selected text. Never claims unanimity it does
 * not hold; the renderer treats the default as indeterminate-adjacent.
 */
export function surfaceTextSizeControl(
  id: string,
  size: number | 'mixed',
): DocumentToolControl {
  const presentation = SHARED_SURFACE_TEXT_TABLE.size;
  return {
    kind: 'number',
    id,
    group: 'text',
    label: presentation.label,
    value: size === 'mixed' ? SURFACE_TEXT_DEFAULT_SIZE : size,
    min: SURFACE_TEXT_SIZE_MIN,
    max: SURFACE_TEXT_SIZE_MAX,
    step: SURFACE_TEXT_SIZE_STEP,
    suffix: 'px',
    semanticRole: presentation.semanticRole,
  };
}

/**
 * Build one text toggle (Bold, Italic, Wrap). Toggles are never exclusive
 * editing tools, so every control carries `activationRole: 'toggle'` and
 * never drives exclusive-tool reconciliation.
 */
export function surfaceTextToggleControl(
  id: string,
  slot: 'bold' | 'italic' | 'wrap',
  state: SurfaceTextToggleState,
): DocumentToolControl {
  const presentation = SHARED_SURFACE_TEXT_TABLE[slot];
  return {
    kind: 'button',
    id,
    group: 'text',
    label: presentation.label,
    ...(presentation.shortLabel !== undefined
      ? { shortLabel: presentation.shortLabel }
      : {}),
    ...(presentation.icon !== undefined ? { icon: presentation.icon } : {}),
    semanticRole: presentation.semanticRole,
    activationRole: 'toggle',
    ...toggleFlags(state),
  };
}

/**
 * Build one Align selector from the provider-computed alignment. `mixed`
 * emits the indeterminate value `''` (arrange-align convention) instead of
 * claiming an alignment the selection does not unanimously hold.
 */
export function surfaceTextAlignControl(
  id: string,
  align: SurfaceTextAlignValue | 'mixed',
): DocumentToolControl {
  const presentation = SHARED_SURFACE_TEXT_TABLE.align;
  return {
    kind: 'choice',
    id,
    group: 'text',
    label: presentation.label,
    ...(presentation.icon !== undefined ? { icon: presentation.icon } : {}),
    value: align === 'mixed' ? '' : align,
    options: [
      { value: 'start', label: 'Align start' },
      { value: 'center', label: 'Align center' },
      { value: 'end', label: 'Align end' },
    ],
    semanticRole: presentation.semanticRole,
  };
}

/**
 * Build one Text-color picker from the provider-computed color. `mixed`
 * (disagreement) emits `SURFACE_TEXT_DEFAULT_COLOR` so the picker always
 * shows a valid swatch — picking from a mixed selection writes that color
 * onto every selected text. Never claims unanimity it does not hold.
 */
export function surfaceTextColorControl(
  id: string,
  color: string | 'mixed',
  options: readonly string[] = SURFACE_TEXT_COLOR_SWATCHES,
): DocumentToolControl {
  const presentation = SHARED_SURFACE_TEXT_TABLE.color;
  return {
    kind: 'color',
    id,
    group: 'text',
    label: presentation.label,
    value: color === 'mixed' ? SURFACE_TEXT_DEFAULT_COLOR : color,
    options: [...options],
    semanticRole: presentation.semanticRole,
  };
}

/**
 * Build the grouped surface-text controls in canonical order. Returns `[]`
 * when the selection holds no text (`hasText: false`) so composition items
 * stay unresolved and the group is dormant where unsupported — never
 * synthesized, never disabled placeholders.
 */
export function buildSurfaceTextControls(
  ids: SurfaceTextControlIds,
  state: SurfaceTextSelectionState,
): DocumentToolControl[] {
  if (state.hasText !== true) return [];
  return [
    surfaceTextStyleControl(ids.style, state.style),
    surfaceTextSizeControl(ids.size, state.size),
    surfaceTextToggleControl(ids.bold, 'bold', state.bold),
    surfaceTextToggleControl(ids.italic, 'italic', state.italic),
    surfaceTextAlignControl(ids.align, state.align),
    surfaceTextColorControl(ids.color, state.color),
    surfaceTextToggleControl(ids.wrap, 'wrap', state.wrap),
  ];
}
