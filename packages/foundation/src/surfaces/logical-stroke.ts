/**
 * Logical-stroke chunking (long strokes over the 10k record limit).
 *
 * Canonical chunks each stay below `SURFACE_MAX_STROKE_POINTS`, but
 * internal chunk boundaries must never look or behave like real stroke
 * starts/ends: no internal caps, no taper restart, tangent-continuous,
 * one selection identity. Derived geometry compiles the logical
 * concatenation JOINTLY (one B-spline fit over the original sample
 * sequence), so chunked output is identical to the unsplit mathematical
 * gesture — sub-pixel agreement by construction, not by tolerance.
 *
 * - `groupLogicalChunks` orders chunks by `chunkIndex` (head first);
 * - `logicalSamples` concatenates chunk points (slices are contiguous and
 *   non-overlapping, so concatenation restores the original sequence);
 * - `expandLogicalIds` maps any chunk id to every chunk id of its logical
 *   stroke (move/select/delete/lock/duplicate treat chunks as one);
 * - erasure masks live on the head and preserve the complete logical source.
 */

import type { SurfaceModel, SurfaceObjectId, SurfaceObjectRecord } from './model.js';
import { chunkIndexOf, logicalIdOf, SURFACE_OBJECT_TYPES } from './model.js';
import type { InkSample } from './model.js';

export interface LogicalStrokeGroup {
  /** Stable head id (also the `logicalId` shared by every chunk). */
  readonly logicalId: string;
  /** Chunk record ids in gesture order (head first). */
  readonly chunkIds: readonly SurfaceObjectId[];
  /** Chunk records in gesture order (head first). */
  readonly records: readonly SurfaceObjectRecord[];
}

function isStrokeRecord(record: SurfaceObjectRecord): boolean {
  return record.type === SURFACE_OBJECT_TYPES.stroke;
}

/**
 * Group every multi-chunk logical stroke in the model. Chunks order by
 * `chunkIndex` (head first); corrupt indices degrade to paint-order.
 * Single-chunk logical ids (head alone) are still grouped (one member).
 */
export function groupLogicalChunks(
  model: Pick<SurfaceModel, 'objects' | 'order'>,
): Map<string, LogicalStrokeGroup> {
  const byLogical = new Map<string, SurfaceObjectRecord[]>();
  for (const id of model.order) {
    const record = model.objects[id];
    if (record === undefined || !isStrokeRecord(record)) continue;
    const logicalId = logicalIdOf(record);
    if (logicalId === null) continue;
    const list = byLogical.get(logicalId);
    if (list === undefined) byLogical.set(logicalId, [record]);
    else list.push(record);
  }
  const out = new Map<string, LogicalStrokeGroup>();
  for (const [logicalId, records] of byLogical) {
    const sorted = [...records].sort((a, b) => {
      const ai = chunkIndexOf(a);
      const bi = chunkIndexOf(b);
      if (ai !== null && bi !== null && ai !== bi) return ai - bi;
      return 0;
    });
    out.set(logicalId, {
      logicalId,
      chunkIds: sorted.map((r) => r.id),
      records: sorted,
    });
  }
  return out;
}

/** Logical id for a record id, or null when independent. */
export function logicalIdForObjectId(
  model: Pick<SurfaceModel, 'objects'>,
  id: SurfaceObjectId,
): string | null {
  const record = model.objects[id];
  if (record === undefined) return null;
  return logicalIdOf(record);
}

/**
 * Expand selection/verb ids across logical chunks: any chunk id expands to
 * every chunk id of its logical stroke (head first); independent ids pass
 * through. Order-preserving, deduplicated.
 */
export function expandLogicalIds(
  model: Pick<SurfaceModel, 'objects' | 'order'>,
  ids: readonly SurfaceObjectId[],
): SurfaceObjectId[] {
  const groups = groupLogicalChunks(model);
  const seen = new Set<SurfaceObjectId>();
  const out: SurfaceObjectId[] = [];
  for (const id of ids) {
    const logicalId = logicalIdForObjectId(model, id);
    if (logicalId === null) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      continue;
    }
    const group = groups.get(logicalId);
    if (group === undefined) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      continue;
    }
    for (const chunkId of group.chunkIds) {
      if (!seen.has(chunkId)) {
        seen.add(chunkId);
        out.push(chunkId);
      }
    }
  }
  return out;
}

/** Concatenated canonical samples of a logical stroke, in gesture order. */
export function logicalSamples(
  group: LogicalStrokeGroup,
): InkSample[] {
  const out: InkSample[] = [];
  for (const record of group.records) {
    const points = (record as Record<string, unknown>).points;
    if (!Array.isArray(points)) continue;
    for (const p of points) out.push(p as InkSample);
  }
  return out;
}

/** Head record of a logical group (owns style/brush/rotation identity). */
export function logicalHead(group: LogicalStrokeGroup): SurfaceObjectRecord {
  return group.records[0]!;
}
