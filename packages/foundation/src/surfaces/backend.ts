/**
 * Renderer backend contract: the new seam.
 *
 * A backend receives the camera, optional frame clipping, and a flat
 * stream of draw items in paint order. Implementations range from the
 * production Canvas 2D provider to deterministic recording backends used
 * in tests; none of them read canonical payloads.
 */

import type { Camera, Bounds } from './geometry.js';
import type { DrawItem, PreparedTransform } from './draw.js';

export interface RenderViewport {
  width: number;
  height: number;
  /** Device pixel ratio of the target surface; defaults to 1. */
  readonly dpr?: number;
}

export interface SurfaceRendererBackend {
  begin(camera: Camera, viewport: RenderViewport): void;
  /** Invoked once before draws when the surface is bounded. */
  clipToFrame?(frame: Bounds): void;
  /**
   * Draw one immutable item with its derived rigid translation.
   * `transform` is (0, 0) for freshly built geometry; backends apply a
   * nonzero translation through save/translate/restore around the
   * immutable draw (never by rewriting item points). Absent means zero.
   */
  draw(item: DrawItem, transform?: PreparedTransform): void;
  end(): void;
}
