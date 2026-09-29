/**
 * Scene compilation, culling, and render dispatch.
 *
 * Objects compile to draw items through the registry in paint order;
 * unknown/unregistered/failed types become placeholder items; the
 * viewport-culling pass runs against item bounds before any backend call.
 * Rendering never mutates canonical data.
 */

import type { SurfaceRendererBackend, RenderViewport } from './backend.js';
import {
  frameBounds,
  type SurfaceFrame,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from './model.js';
import { groupLogicalChunks, logicalHead, logicalSamples, type LogicalStrokeGroup } from './logical-stroke.js';
import { placeholderFor } from './objects.js';
import type { SurfaceObjectTypeRegistry } from './registry.js';
import {
  type DrawItem,
  type PreparedItem,
} from './draw.js';
import {
  boundsIntersect,
  rotatedBoundsAabb,
  viewportSurfaceRect,
  type Camera,
} from './geometry.js';

/**
 * Compile every object of the model to draw items in paint order.
 * Unknown object types (including unregistered core types) compile to a
 * dashed-bounding-box placeholder — the render-side analogue of the
 * opaque wrapper. Nothing is ever dropped.
 */
export function compileScene(
  model: SurfaceModel,
  registry: SurfaceObjectTypeRegistry,
): readonly DrawItem[] {
  const items: DrawItem[] = [];
  // Logical-stroke chunking: chunks of one continuous gesture compile
  // JOINTLY (one B-spline fit over the concatenated sequence) and emit a
  // single draw item at the head's paint position. Internal boundaries
  // therefore carry no caps, no taper restart, and continuous tangents —
  // identical to the unsplit mathematical gesture. Each canonical chunk
  // still stays below the sample limit; only derived compilation joins.
  const groups = groupLogicalChunks(model);
  const emittedLogical = new Set<string>();
  const chunkToLogical = new Map<string, string>();
  for (const [logicalId, group] of groups) {
    for (const chunkId of group.chunkIds) chunkToLogical.set(chunkId, logicalId);
  }
  for (const id of model.order) {
    const record = model.objects[id];
    if (record === undefined) continue; // Codec recovery keeps these consistent.
    const logicalId = chunkToLogical.get(id);
    if (logicalId !== undefined) {
      if (emittedLogical.has(logicalId)) continue;
      emittedLogical.add(logicalId);
      const group = groups.get(logicalId)!;
      items.push(...compileObject(synthesizeLogicalRecord(group), registry));
      continue;
    }
    items.push(...compileObject(record, registry));
  }
  return items;
}

/**
 * Ephemeral joint record for a logical stroke: head style/brush/rotation
 * with the concatenated canonical sample sequence. Never stored; derived
 * compilation (caps, taper, B-spline fit) runs over the whole gesture, so
 * internal chunk boundaries vanish. The joint id is the head id (stable
 * selection/hit identity via `expandLogicalIds`).
 */
function synthesizeLogicalRecord(
  group: LogicalStrokeGroup,
): SurfaceObjectRecord {
  const head = logicalHead(group);
  return {
    ...head,
    id: group.logicalId,
    points: logicalSamples(group),
  };
}

function asItemList(compiled: DrawItem | readonly DrawItem[]): readonly DrawItem[] {
  // Array.isArray does not narrow `readonly DrawItem[]`, hence the casts.
  return Array.isArray(compiled) ? ((compiled as readonly DrawItem[]) ) : [compiled as DrawItem];
}

function compileObject(
  record: SurfaceObjectRecord,
  registry: SurfaceObjectTypeRegistry,
): readonly DrawItem[] {
  // A failed or missing compile degrades to a placeholder rather than
  // dropping content or crashing the frame; payloads never reach backends.
  const descriptor = registry.get(record.type);
  if (descriptor?.compile !== undefined) {
    try {
      const compiled = descriptor.compile(record);
      if (compiled !== null) return asItemList(compiled);
    } catch {
      // Fall through to placeholder.
    }
  }
  return [placeholderFor(record)];
}

/** Visible-surface AABB of a draw item (rotation-aware, local coords). */
export function itemAabb(item: DrawItem) {
  return rotatedBoundsAabb(item.bounds, item.rotation);
}

/**
 * Visible-surface AABB of a prepared entry: local item bounds shifted by
 * its derived rigid translation (rotation-aware). Culling, selection
 * chrome, and viewport queries consume this — never the unshifted local
 * bounds — so translated strokes cull/select exactly where they render.
 */
export function preparedAabb(prepared: PreparedItem) {
  const local = rotatedBoundsAabb(
    prepared.item.bounds,
    prepared.item.rotation,
  );
  const { tx, ty } = prepared.transform;
  if (tx === 0 && ty === 0) return local;
  return { ...local, x: local.x + tx, y: local.y + ty };
}

/** Optional scene-composition additions (notebook template paper). */
export interface RenderSceneOptions {
  /**
   * Background draw items rendered after clipping and before scene
   * objects, culled identically. Plain data only; never canonical content.
   */
  readonly backgroundItems?: readonly DrawItem[];
}

/**
 * Render one frame: compile, clip (bounded frames only), cull against
 * the camera viewport, dispatch in paint order.
 */
export function renderSurfaceScene(
  backend: SurfaceRendererBackend,
  model: SurfaceModel,
  registry: SurfaceObjectTypeRegistry,
  camera: Camera,
  viewport: RenderViewport,
  options: RenderSceneOptions = {},
): void {
  dispatchScene(
    backend,
    {
      frame: model.frame,
      items: compileScene(model, registry),
      ...(options.backgroundItems !== undefined
        ? { backgroundItems: options.backgroundItems }
        : {}),
    },
    camera,
    viewport,
  );
}

/** Precompiled scene bundle: compile once, dispatch per camera frame. */
export interface PreparedScene {
  readonly frame: SurfaceFrame;
  readonly items: readonly PreparedItem[];
  readonly backgroundItems?: readonly PreparedItem[];
}

/**
 * Dispatch input: accepts both freshly compiled `DrawItem[]` (zero
 * transform, legacy/stateless callers and specs) and prepared
 * `PreparedItem[]` (incremental cache with accumulated derived
 * translation). Normalizes per entry so old call sites keep working
 * while the committed renderer gets O(1) translation via transforms.
 */
export interface DispatchSceneInput {
  readonly frame: SurfaceFrame;
  readonly items: readonly (DrawItem | PreparedItem)[];
  readonly backgroundItems?: readonly (DrawItem | PreparedItem)[];
}

function isPreparedEntry(
  entry: DrawItem | PreparedItem,
): entry is PreparedItem {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'item' in entry &&
    'transform' in entry
  );
}

/**
 * Dispatch a precompiled scene: clip, cull against the camera viewport,
 * dispatch in paint order. Byte-identical to `renderSurfaceScene` for the
 * same scene/camera — the committed renderer replays cached items across
 * camera moves through this seam instead of recompiling per frame.
 */
export function dispatchScene(
  backend: SurfaceRendererBackend,
  scene: DispatchSceneInput | PreparedScene,
  camera: Camera,
  viewport: RenderViewport,
): void {
  backend.begin(camera, viewport);

  const frame = frameBounds(scene.frame);
  if (frame !== null) {
    backend.clipToFrame?.({ x: 0, y: 0, width: frame.width, height: frame.height });
  }

  const visible = viewportSurfaceRect(camera, viewport);
  const dispatchEntry = (entry: DrawItem | PreparedItem): void => {
    if (isPreparedEntry(entry)) {
      if (boundsIntersect(preparedAabb(entry), visible)) {
        backend.draw(entry.item, entry.transform);
      }
      return;
    }
    if (boundsIntersect(itemAabb(entry), visible)) {
      backend.draw(entry);
    }
  };
  if (scene.backgroundItems !== undefined) {
    for (const entry of scene.backgroundItems) dispatchEntry(entry);
  }
  for (const entry of scene.items) dispatchEntry(entry);

  backend.end();
}
