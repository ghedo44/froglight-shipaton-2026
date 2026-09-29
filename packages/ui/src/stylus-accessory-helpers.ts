/**
 * Provider-neutral surface-tool matchers.
 *
 * Shared by the accessory binder and the preferred-action router so both
 * agree on what counts as the eraser. Explicit matching runs on semantic
 * `DocumentToolControl` metadata (`role = surface-tool`, `toolRole`); the
 * control-id suffix shapes below are isolated LEGACY for snapshots that
 * predate metadata. New presenters must use the `isExplicit*` /
 * `findExplicit*` helpers, never the `*ControlId` suffix matchers.
 */

import {
  SURFACE_TOOL_IDS,
  isExclusiveActiveToolControl,
  type DocumentToolSnapshot,
} from '@froglight/foundation';

/**
 * LEGACY: id-suffix shapes for snapshots that predate
 * semantic metadata. Isolated here; new code must match on `toolRole`
 * via `isExplicitSurfaceEraserControl` instead.
 */
const ERASER_CONTROL_SUFFIXES = [
  '.tool.eraser',
  `.tool.${SURFACE_TOOL_IDS.eraser}`,
] as const;

/**
 * LEGACY: id-shape probe for pre-metadata snapshots
 * (`ink/notebook/whiteboard.tool.*`). The final semantic presenter uses
 * explicit `role === 'surface-tool'` only; this remains for the binder's
 * legacy fallback path (see `findActiveSurfaceToolId` below).
 */
export function isSurfaceToolControlId(id: string): boolean {
  return /\.tool\.[^.]+/.test(id);
}

/** True when the control carries semantic surface-tool metadata. */
export function isSemanticSurfaceToolControl(
  control: DocumentToolSnapshot['controls'][number],
): boolean {
  return (
    control.kind === 'button' && control.role === 'surface-tool'
  );
}

/**
 * LEGACY: provider-neutral eraser matcher across control-id
 * dialects: Ink and Notebook embed the full surface tool id
 * (`ink.tool.froglight.ink.eraser`), Whiteboard uses short keys
 * (`whiteboard.tool.eraser`). Isolated for controls that predate semantic
 * metadata; metadata-bearing controls are matched on `toolRole` alone via
 * `isExplicitSurfaceEraserControl`.
 */
export function isSurfaceEraserControlId(id: string): boolean {
  return ERASER_CONTROL_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

/**
 * Explicit eraser match (final path): semantic metadata only,
 * never id-shape inference. True only for `role === 'surface-tool'` with
 * `toolRole === 'eraser'`.
 */
export function isExplicitSurfaceEraserControl(
  control: DocumentToolSnapshot['controls'][number],
): boolean {
  return (
    control.kind === 'button' &&
    control.role === 'surface-tool' &&
    control.toolRole === 'eraser'
  );
}

export function isSurfaceEraserControl(
  control: DocumentToolSnapshot['controls'][number],
): boolean {
  if (control.kind !== 'button') return false;
  // Metadata-bearing controls are authoritative: trust `toolRole`
  // exclusively so a `pen` tool can never match as an eraser by id shape.
  if (control.role === 'surface-tool') return control.toolRole === 'eraser';
  // LEGACY: isolated suffix fallback for pre-metadata
  // snapshots only. Explicit path is `isExplicitSurfaceEraserControl`.
  return isSurfaceEraserControlId(control.id);
}

/** Explicit eraser lookup (final path): metadata only.*/
export function findExplicitSurfaceEraserControlId(
  snapshot: DocumentToolSnapshot,
): string | null {
  for (const control of snapshot.controls) {
    if (control.kind !== 'button') continue;
    if (isExplicitSurfaceEraserControl(control)) return control.id;
  }
  return null;
}

/** Eraser control id in a provider snapshot, or null when absent. */
export function findSurfaceEraserControlId(
  snapshot: DocumentToolSnapshot,
): string | null {
  for (const control of snapshot.controls) {
    if (control.kind !== 'button') continue;
    if (isSurfaceEraserControl(control)) return control.id;
  }
  return null;
}

/** Currently active surface tool control id, or null when none/unknown. */
export function findActiveSurfaceToolId(
  snapshot: DocumentToolSnapshot,
): string | null {
  for (const control of snapshot.controls) {
    if (control.kind !== 'button') continue;
    // Exclusive-tool semantics only: toggle-active controls (Bold, …)
    // never count, even when a legacy id shape would otherwise match.
    // Absent activationRole keeps the historic fallback (see
    // `isExclusiveActiveToolControl`).
    if (!isExclusiveActiveToolControl(control)) continue;
    if (control.role !== undefined) {
      if (control.role === 'surface-tool') return control.id;
      continue;
    }
    // LEGACY: isolated id-shape fallback for pre-metadata
    // snapshots only. Explicit path is `findExplicitActiveSurfaceToolId`.
    if (isSurfaceToolControlId(control.id)) return control.id;
  }
  return null;
}

/**
 * Explicit active-tool lookup (final path): semantic metadata
 * plus exclusive-tool semantics only, never id-shape inference.
 */
export function findExplicitActiveSurfaceToolId(
  snapshot: DocumentToolSnapshot,
): string | null {
  for (const control of snapshot.controls) {
    if (control.kind !== 'button') continue;
    if (!isExclusiveActiveToolControl(control)) continue;
    if (control.role === 'surface-tool') return control.id;
  }
  return null;
}
