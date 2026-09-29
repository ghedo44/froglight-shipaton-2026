/**
 * Surface Object Type registry.
 *
 * Trusted-tier plugins register Object Types through this registry; the
 * permission gate (`workspace.surfaces.register`) lives on the trusted
 * side of the facade boundary, not here. Registration is a plain
 * reversible Disposer so runtime effect scopes own cleanup.
 */

import { FroglightError } from '../errors.js';
import {
  isValidNamespacedTypeId,
  type ConnectorAnchor,
  type SurfaceObjectRecord,
} from './model.js';
import type { DrawItem } from './draw.js';
import type { Bounds, Point } from './geometry.js';

/**
 * One registered object type. Every hook is optional so minimal types can
 * participate; missing hooks fall back to placeholder/box behavior in the
 * render and interaction pipelines. All hooks are headless-safe.
 */
export interface SurfaceObjectTypeDescriptor {
  /** Dot-namespaced id. */
  readonly typeId: string;
  readonly version: number;
  /** Structural validation above the codec (never mutates canonical data). */
  readonly isValidRecord?: (record: SurfaceObjectRecord) => boolean;
  /** Axis-aligned bounds for selection/culling; null when not derivable. */
  readonly boundsOf?: (record: SurfaceObjectRecord) => Bounds | null;
  /**
   * Surface-space connector anchor for a bound object (repair pass item
   * 10). Sized types resolve the named anchor in local object coordinates
   * and rotate it around the canonical pivot, so connectors stay visually
   * attached after move/resize/rotate/align/distribute/group. Null when
   * the record has no anchorable geometry. Types without this hook fall
   * back to the unrotated envelope anchor.
   */
  readonly connectorAnchor?: (
    record: SurfaceObjectRecord,
    anchor: ConnectorAnchor,
  ) => Point | null;
  /** Surface-space point containment; falls back to bounds when absent. */
  readonly hitTest?: (record: SurfaceObjectRecord, x: number, y: number) => boolean;
  /** Compile to plain-data draw items; backends never see raw payloads.
   *  Null (or a throw) means "cannot compile" — the pipeline falls back
   *  to a placeholder item. */
  readonly compile?: (
    record: SurfaceObjectRecord,
  ) => DrawItem | readonly DrawItem[] | null;
  /** Translate a record by a surface-space delta. Records without
   *  numeric x/y envelope members (e.g. ink strokes) declare this so the
   *  shared interaction semantics can move them; types that omit it are
   *  moved through their x/y origin like any sized envelope. */
  readonly translate?: (
    record: SurfaceObjectRecord,
    dx: number,
    dy: number,
  ) => void;
  /**
   * Geometrically resize a record toward a target bounds size (selection
   * transforms). Strokes scale samples about their center; sized types
   * usually need no hook (the controller writes width/height members).
   * Return true when handled; false (or absent) falls back to envelope
   * members. Must not throw for degenerate input — return false instead.
   */
  readonly resize?: (
    record: SurfaceObjectRecord,
    size: { readonly width?: number; readonly height?: number },
  ) => boolean;
}

export interface SurfaceObjectTypeRegistry {
  register(descriptor: SurfaceObjectTypeDescriptor): { dispose(): void };
  /** Registered descriptor or null — the renderer prefers placeholders over throws. */
  get(typeId: string): SurfaceObjectTypeDescriptor | null;
  list(): readonly SurfaceObjectTypeDescriptor[];
}

export class InMemorySurfaceObjectTypeRegistry implements SurfaceObjectTypeRegistry {
  readonly #types = new Map<string, SurfaceObjectTypeDescriptor>();

  register(descriptor: SurfaceObjectTypeDescriptor): { dispose(): void } {
    if (!isValidNamespacedTypeId(descriptor.typeId)) {
      throw new FroglightError(
        'INVALID_SURFACE_OBJECT_TYPE_ID',
        `surface object type id must be dot-namespaced: ${descriptor.typeId}`,
      );
    }
    if (this.#types.has(descriptor.typeId)) {
      throw new FroglightError(
        'DUPLICATE_SURFACE_OBJECT_TYPE',
        `surface object type already registered: ${descriptor.typeId}`,
      );
    }
    this.#types.set(descriptor.typeId, descriptor);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#types.delete(descriptor.typeId);
      },
    };
  }

  get(typeId: string): SurfaceObjectTypeDescriptor | null {
    return this.#types.get(typeId) ?? null;
  }

  list(): readonly SurfaceObjectTypeDescriptor[] {
    return [...this.#types.values()];
  }
}
