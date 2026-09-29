/**
 * Shared surface-text selection derivation.
 *
 * Pure plain-data derivation of `SurfaceTextSelectionState` from surface
 * records and live selection ids. Notebook, Ink, and Whiteboard share this
 * single implementation so style/bold/italic/align/wrap read identically
 * across dialects (`ink.tool.*` / `notebook.tool.*` / `whiteboard.tool.*`
 * differ only in provider-owned control ids, never in read semantics).
 *
 * The caller passes the live surface model and selection ids; group ids
 * expand to members (matching `selectionContext` semantics); unknown ids
 * and non-text records are ignored. Empty or text-free selections yield
 * `NO_SURFACE_TEXT_SELECTION` so the shared builder emits nothing and
 * composition stays dormant.
 *
 *  contract (must match the write path in `surface-text-execute.ts`
 * and the overlay read): Body reads `role: 'body'`; H1/H2/H3 read
 * `role: 'heading'` split on effective size (`appearance.size` when valid,
 * else record `size`, else 16) at `SURFACE_TEXT_H1_MIN_SIZE` /
 * `SURFACE_TEXT_H2_MIN_SIZE`; size reads the unanimous effective size
 * (`'mixed'` on disagreement); bold/italic read additive `appearance`
 * traits (exactly `true` counts); align reads the effective alignment;
 * color reads the unanimous record `color` (absent reads
 * `SURFACE_TEXT_DEFAULT_COLOR`, disagreement reads `'mixed'`); wrap reads
 * a valid `wrapWidth`.
 *
 * No DOM, Canvas, or engine types cross here — only tolerant record reads,
 * so unknown roles/aligns and malformed appearance degrade exactly as
 * rendering does (never a throw, never normalization of the record).
 */

import {
  effectiveTextSizeOf,
  SURFACE_OBJECT_TYPES,
  textAlignOf,
  textRoleOf,
  textWrapWidthOf,
  type SurfaceModel,
  type SurfaceObjectId,
  type SurfaceObjectRecord,
} from '../surfaces/model.js';
import { resolveGroupMembers } from '../surfaces/objects.js';
import {
  NO_SURFACE_TEXT_SELECTION,
  SURFACE_TEXT_DEFAULT_COLOR,
  SURFACE_TEXT_DEFAULT_SIZE,
  SURFACE_TEXT_H1_MIN_SIZE,
  SURFACE_TEXT_H2_MIN_SIZE,
  type SurfaceTextAlignValue,
  type SurfaceTextSelectionState,
  type SurfaceTextStyleValue,
  type SurfaceTextToggleState,
} from './surface-text-builder.js';

function appearanceRecord(
  record: SurfaceObjectRecord,
): Record<string, unknown> | null {
  const appearance = (record as { readonly appearance?: unknown }).appearance;
  return typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
    ? (appearance as Record<string, unknown>)
    : null;
}

/**
 * Effective text size for the H1/H2 split: `appearance.size` when it is a
 * valid size, else the record `size` via `effectiveTextSizeOf`, else
 * `SURFACE_TEXT_DEFAULT_SIZE`. Read-only — never writes, never normalizes.
 */
function effectiveSurfaceTextSize(record: SurfaceObjectRecord): number {
  const size = appearanceRecord(record)?.size;
  if (
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size > 0 &&
    size <= 20_000
  ) {
    return size;
  }
  const recordSize = (record as { readonly size?: unknown }).size;
  if (typeof recordSize === 'number' && Number.isFinite(recordSize)) {
    return effectiveTextSizeOf(record);
  }
  return SURFACE_TEXT_DEFAULT_SIZE;
}

function traitOf(record: SurfaceObjectRecord, key: 'bold' | 'italic'): boolean {
  return appearanceRecord(record)?.[key] === true;
}

function colorOf(record: SurfaceObjectRecord): string {
  const color = (record as { readonly color?: unknown }).color;
  return typeof color === 'string' && color.length > 0
    ? color
    : SURFACE_TEXT_DEFAULT_COLOR;
}

function isTextRecord(record: SurfaceObjectRecord | undefined): boolean {
  return record?.type === SURFACE_OBJECT_TYPES.text;
}

function toggleOf(values: readonly boolean[]): SurfaceTextToggleState {
  if (values.length === 0) return { active: false, mixed: false };
  const active = values.every((value) => value === true);
  const inactive = values.every((value) => value !== true);
  return { active, mixed: !active && !inactive };
}

/**
 * Derive text selection state from surface records and selection ids.
 * Group ids expand to members; unknown ids and non-text records are
 * ignored. Empty or text-free selections yield
 * `NO_SURFACE_TEXT_SELECTION` so the builder emits nothing.
 */
export function deriveSurfaceTextSelectionState(
  surface: Pick<SurfaceModel, 'order' | 'objects'> | null,
  ids: readonly SurfaceObjectId[],
): SurfaceTextSelectionState {
  if (surface === null || ids.length === 0) return NO_SURFACE_TEXT_SELECTION;
  const members = resolveGroupMembers(surface, ids);
  const texts = members
    .map((id) => surface.objects[id])
    .filter(isTextRecord);
  if (texts.length === 0) return NO_SURFACE_TEXT_SELECTION;
  const styles = texts.map((record): SurfaceTextStyleValue => {
    if (textRoleOf(record) !== 'heading') return 'body';
    const size = effectiveSurfaceTextSize(record);
    if (size >= SURFACE_TEXT_H1_MIN_SIZE) return 'h1';
    if (size >= SURFACE_TEXT_H2_MIN_SIZE) return 'h2';
    return 'h3';
  });
  const firstStyle = styles[0];
  const style: SurfaceTextStyleValue | 'mixed' =
    firstStyle === undefined ||
    !styles.every((value) => value === firstStyle)
      ? 'mixed'
      : firstStyle;
  const sizes = texts.map((record) => effectiveSurfaceTextSize(record));
  const firstSize = sizes[0];
  const size: number | 'mixed' =
    firstSize === undefined || !sizes.every((value) => value === firstSize)
      ? 'mixed'
      : firstSize;
  const aligns = texts.map((record): SurfaceTextAlignValue =>
    textAlignOf(record),
  );
  const firstAlign = aligns[0];
  const align: SurfaceTextAlignValue | 'mixed' =
    firstAlign === undefined ||
    !aligns.every((value) => value === firstAlign)
      ? 'mixed'
      : firstAlign;
  const colors = texts.map((record) => colorOf(record));
  const firstColor = colors[0];
  const color: string | 'mixed' =
    firstColor === undefined || !colors.every((value) => value === firstColor)
      ? 'mixed'
      : firstColor;
  const wrapped = texts.map(
    (record) => textWrapWidthOf(record) !== null,
  );
  return {
    hasText: true,
    style,
    size,
    bold: toggleOf(texts.map((record) => traitOf(record, 'bold'))),
    italic: toggleOf(texts.map((record) => traitOf(record, 'italic'))),
    align,
    color,
    wrap: toggleOf(wrapped),
  };
}
