import { packInkSamples, unpackInkSamples } from './packed-protocol.js';
import type { InkSample } from '../model.js';
import { FroglightError } from '../../errors.js';
import type { SurfaceObjectRecord } from '../model.js';
import { centerOfBounds, rotateAround, type Point } from '../geometry.js';
import {
  jointInkSourceRecord,
  inkStrokeOutlineOfRecord,
  inkStrokeEnvelope,
  rotationOf,
  invalidateCompiledForRecord,
} from '../objects.js';

const outlines = new WeakMap<SurfaceObjectRecord, readonly Point[]>();
/** Rebuildable geometry, shared by every fragment of one immutable sample source. */
export function inkSourceOutline(
  source: SurfaceObjectRecord,
): readonly Point[] {
  const cached = outlines.get(source);
  if (cached !== undefined) return cached;
  const records = source.chunks as SurfaceObjectRecord[];
  let record =
    records.length === 1
      ? records[0]!
      : jointInkSourceRecord({
          logicalId: records[0]!.id,
          records,
          chunkIds: records.map((r) => r.id),
        });
  if (source.sampleEncoding === 'packed')
    record = {
      ...record,
      points: unpackInkSamples(
        packInkSamples(record.points as InkSample[]).packed,
      ),
    };
  const outline = inkStrokeOutlineOfRecord(record);
  const rotation = rotationOf(record);
  const envelope = inkStrokeEnvelope(record);
  const world =
    rotation === 0 || envelope === null
      ? outline
      : outline.map((p) => rotateAround(p, centerOfBounds(envelope), rotation));
  if (
    source.outlineLength !== undefined &&
    source.outlineLength !== world.length
  )
    throw new FroglightError(
      'RECORD_CORRUPT',
      'Ink source outline revision does not match its fragment references',
    );
  outlines.set(source, world);
  return world;
}
export function retainInkSourceOutline(
  source: SurfaceObjectRecord,
  outline: readonly Point[],
): void {
  outlines.set(source, outline);
}

export function releaseInkSourceGeometry(source: SurfaceObjectRecord): void {
  outlines.delete(source);
  for (const record of source.chunks as SurfaceObjectRecord[])
    invalidateCompiledForRecord(record);
}
