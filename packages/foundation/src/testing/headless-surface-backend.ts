/**
 * Deterministic headless renderer backend: records every
 * seam call as plain data so tests can assert exact op streams and prove
 * renderer replacement without a browser. Test-support only; nothing in
 * the production surface imports this module.
 */

import type {
  RenderViewport,
  SurfaceRendererBackend,
} from '../surfaces/backend.js';
import type { DrawItem, PreparedTransform } from '../surfaces/draw.js';
import type { Camera, Bounds } from '../surfaces/geometry.js';

export type RecordedRenderOp =
  | { readonly op: 'begin'; readonly camera: Camera; readonly viewport: RenderViewport }
  | { readonly op: 'clip'; readonly frame: Bounds }
  | {
      readonly op: 'draw';
      readonly item: DrawItem;
      /**
       * Derived rigid translation passed with the draw. Recorded only
       * when nonzero so pre-existing op streams stay byte-identical;
       * translated draws carry the exact transform the Canvas backend
       * would apply through save/translate/restore.
       */
      readonly transform?: PreparedTransform;
    }
  | { readonly op: 'end' };

export class RecordingSurfaceBackend implements SurfaceRendererBackend {
  readonly #ops: RecordedRenderOp[] = [];

  get ops(): readonly RecordedRenderOp[] {
    return this.#ops;
  }

  begin(camera: Camera, viewport: RenderViewport): void {
    this.#ops.push({ op: 'begin', camera: { ...camera }, viewport: { ...viewport } });
  }

  clipToFrame(frame: Bounds): void {
    this.#ops.push({ op: 'clip', frame: { ...frame } });
  }

  draw(item: DrawItem, transform?: PreparedTransform): void {
    const tx = transform?.tx ?? 0;
    const ty = transform?.ty ?? 0;
    this.#ops.push(
      tx === 0 && ty === 0
        ? { op: 'draw', item }
        : { op: 'draw', item, transform: { tx, ty } },
    );
  }

  end(): void {
    this.#ops.push({ op: 'end' });
  }

  /** Convenience view for assertions: ids of dispatched items in order. */
  drawnItemIds(): string[] {
    return this.#ops
      .filter((entry): entry is { op: 'draw'; item: DrawItem } => entry.op === 'draw')
      .map((entry) => entry.item.objectId);
  }
}
