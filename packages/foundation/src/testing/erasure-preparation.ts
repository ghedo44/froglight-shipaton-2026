import type { ErasurePreparation } from '../surfaces/ink/erasure-preparation.js';
import type { InkErasure } from '../surfaces/ink/erasure.js';
import { prepareInkRegion } from '../surfaces/ink/erasure.js';
import { inkSourceOutline } from '../surfaces/ink/source-geometry.js';
import {
  packInkRegion,
  type InkRegionTransform,
} from '../surfaces/ink/fragments.js';
import type { SurfaceObjectRecord } from '../surfaces/model.js';

/** Deterministic transport seam; browser acceptance tests use the actual worker. */
export function createTestErasurePreparation(): ErasurePreparation {
  const jobs = new Map<
    number,
    Map<
      string,
      {
        region: InkErasure;
        source: SurfaceObjectRecord;
        transform?: InkRegionTransform;
      }
    >
  >();
  return {
    stage(job, id, region, source, transform) {
      const records = jobs.get(job) ?? new Map();
      records.set(id, { region, source, transform });
      jobs.set(job, records);
    },
    finish(job) {
      return Promise.resolve().then(() => {
        const records = jobs.get(job);
        if (records === undefined)
          throw new Error('missing staged eraser operation');
        const result = Object.fromEntries(
          [...records].map(([id, { region, source, transform }]) => [
            id,
            prepareInkRegion(region).map((contours) => ({
              visible: packInkRegion(
                contours,
                inkSourceOutline(source),
                transform,
              ),
              contours,
            })),
          ]),
        );
        jobs.delete(job);
        return result;
      });
    },
    cancel(job) {
      jobs.delete(job);
    },
    dispose() {
      jobs.clear();
    },
  };
}
