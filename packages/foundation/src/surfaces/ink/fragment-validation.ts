import type { SurfaceObjectRecord } from '../model.js';
import type { InkVisibleRegion } from './fragments.js';
import { MAX_ERASURE_VERTICES, validErasure } from './erasure.js';
export const INK_SOURCE_TYPE = 'froglight.ink.source';
export function validInkVisible(
  value: unknown,
  outlineLength?: number,
): value is InkVisibleRegion {
  if (!Array.isArray(value) || value.length === 0) return false;
  let ownedVertices = 0,
    runs = 0,
    expanded = 0;
  for (const poly of value) {
    if (!Array.isArray(poly) || poly.length === 0) return false;
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length === 0) return false;
      let vertices = 0;
      for (const token of ring) {
        if (Array.isArray(token)) {
          const [start, count, step] = token;
          if (
            (token.length !== 3 && token.length !== 4) ||
            !Number.isInteger(start) ||
            start < 0 ||
            !Number.isInteger(count) ||
            count < 1 ||
            (step !== 1 && step !== -1)
          )
            return false;
          const basis = token[3];
          if (
            token.length === 4 &&
            basis !== 1 &&
            !(
              Array.isArray(basis) &&
              basis.length === 6 &&
              basis.every(
                (n) =>
                  typeof n === 'number' &&
                  Number.isFinite(n) &&
                  Math.abs(n) <= 1e9,
              ) &&
              basis[0] * basis[3] !== basis[1] * basis[2]
            )
          )
            return false;
          if (
            outlineLength !== undefined &&
            (start >= outlineLength || count > outlineLength)
          )
            return false;
          runs++;
          vertices += count;
        } else {
          if (!validErasure([[[token, token, token]]])) return false;
          ownedVertices++;
          vertices++;
        }
      }
      if (vertices < 3) return false;
      expanded += vertices;
    }
  }
  return (
    ownedVertices <= MAX_ERASURE_VERTICES &&
    runs <= MAX_ERASURE_VERTICES &&
    (outlineLength === undefined ||
      expanded <= outlineLength + MAX_ERASURE_VERTICES)
  );
}
/** Drafts are bounded by the worker queue, and never admitted to durable snapshots. */
export function validInkRegionRecord(record: SurfaceObjectRecord): boolean {
  return (
    typeof record.sourceId === 'string' &&
    record.sourceId.length > 0 &&
    record.points === undefined &&
    record.erasure === undefined &&
    record.logicalId === undefined &&
    record.chunkIndex === undefined &&
    validInkVisible(record.visible) &&
    record.region === undefined &&
    (record.regionTransform === undefined ||
      (Array.isArray(record.regionTransform) &&
        record.regionTransform.length === 6 &&
        record.regionTransform.every(
          (n) =>
            typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e9,
        ) &&
        (record.regionTransform[0] as number) *
          (record.regionTransform[3] as number) !==
          (record.regionTransform[1] as number) *
            (record.regionTransform[2] as number)))
  );
}
