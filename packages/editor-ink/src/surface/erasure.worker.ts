/// <reference lib="webworker" />
import {
  releaseInkSourceGeometry,
  prepareInkRegion,
  packInkRegion,
  inkSourceOutline,
  inkSourceRetainedBytes,
  validInkVisible,
  type PreparedInkRegion,
  type InkRegionTransform,
  type InkErasure,
  type SurfaceObjectRecord,
} from '@froglight/foundation';

const jobs = new Map<number, Map<string, PreparedInkRegion[]>>();
const sources = new Map<string, SurfaceObjectRecord>();
let retainedTokens = 0;
let sourceBytes = 0;
const geometry = new Map<string, number>();
let geometryBytes = 0;
const cost = (regions: readonly PreparedInkRegion[]) =>
  regions.reduce(
    (n, r) =>
      n +
      r.visible.reduce((n, p) => n + p.reduce((n, r) => n + r.length, 0), 0),
    0,
  );
function release(job: number): void {
  for (const regions of jobs.get(job)?.values() ?? [])
    retainedTokens -= cost(regions);
  jobs.delete(job);
}
self.onmessage = (
  event: MessageEvent<{
    type: 'stage' | 'finish' | 'cancel' | 'release-source';
    job: number;
    id?: string;
    region?: InkErasure;
    measure?: boolean;
    sourceId?: string;
    source?: SurfaceObjectRecord;
    transform?: InkRegionTransform;
  }>,
) => {
  const message = event.data;
  const started = message.measure === true ? performance.now() : 0;
  try {
    if (message.type === 'release-source') {
      const source = sources.get(message.sourceId!);
      if (source) {
        sourceBytes -= inkSourceRetainedBytes(source);
        releaseInkSourceGeometry(source);
      }
      sources.delete(message.sourceId!);
      geometryBytes -= geometry.get(message.sourceId!) ?? 0;
      geometry.delete(message.sourceId!);
      return;
    }
    if (message.type === 'cancel') {
      release(message.job);
      return;
    }
    if (message.type === 'stage') {
      if (message.source !== undefined && !sources.has(message.source.id)) {
        const bytes = inkSourceRetainedBytes(message.source);
        if (sourceBytes + bytes > 64 * 1024 * 1024)
          throw new Error(
            'Precision eraser source cache exceeds its resource budget',
          );
        sources.set(message.source.id, message.source);
        sourceBytes += bytes;
      }
      const source = sources.get(message.sourceId!);
      if (source === undefined)
        throw new Error('Precision eraser source is missing');
      const outline = inkSourceOutline(source);
      geometryBytes -= geometry.get(source.id) ?? 0;
      geometry.delete(source.id);
      const bytes = outline.length * 96;
      geometry.set(source.id, bytes);
      geometryBytes += bytes;
      const polygonIndices = new Map(
        message.region!.map((polygon, index) => [polygon, index]),
      );
      const prepared = prepareInkRegion(message.region!).map((contours) => {
        const visible = packInkRegion(contours, outline, message.transform);
        if (!validInkVisible(visible, outline.length))
          throw new Error(
            'Precision eraser boundary exceeds its vertex or range limit',
          );
        return {
          visible,
          polygonIndices: contours.map(
            (polygon) => polygonIndices.get(polygon)!,
          ),
        };
      });
      const records =
        jobs.get(message.job) ?? new Map<string, PreparedInkRegion[]>();
      const previous = records.get(message.id!);
      const nextCost =
        retainedTokens - (previous ? cost(previous) : 0) + cost(prepared);
      if (nextCost > 1_000_000 || jobs.size > 64)
        throw new Error(
          'Precision eraser preparation queue exceeds its resource budget',
        );
      retainedTokens = nextCost;
      records.set(message.id!, prepared);
      jobs.set(message.job, records);
      // Geometry is disposable. Retain at most 32 MiB, independent of source ownership.
      for (const [id, bytes] of geometry) {
        if (geometryBytes <= 32 * 1024 * 1024) break;
        releaseInkSourceGeometry(sources.get(id)!);
        geometry.delete(id);
        geometryBytes -= bytes;
      }
      self.postMessage({
        job: message.job,
        staged: true,
        preparationMs:
          message.measure === true ? performance.now() - started : undefined,
      });
      return;
    }
    const records = jobs.get(message.job);
    if (records === undefined)
      throw new Error('Precision eraser operation has no staged regions');
    self.postMessage({ job: message.job, result: Object.fromEntries(records) });
    release(message.job);
  } catch (error) {
    release(message.job);
    self.postMessage({
      job: message.job,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
