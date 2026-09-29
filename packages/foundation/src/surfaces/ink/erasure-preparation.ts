import type { SurfaceObjectRecord } from '../model.js';
import type { PreparedInkRegion, InkRegionTransform } from './fragments.js';
import type { InkErasure } from './erasure.js';

/** Host-owned worker lane. stage is called during movement; finish sends only a job id. */
export interface ErasurePreparation {
  stage(
    job: number,
    id: string,
    region: InkErasure,
    source: SurfaceObjectRecord,
    transform?: InkRegionTransform,
  ): void;
  finish(
    job: number,
  ): Promise<Readonly<Record<string, readonly PreparedInkRegion[]>>>;
  cancel(job: number): void;
  releaseSource?(id: string): void;
  restart?(): void;
  dispose(): void;
}
export interface ErasureRefinement {
  readonly order: readonly import('../transactions.js').SurfaceOrderEdit[];
  readonly before: readonly SurfaceObjectRecord[];
  readonly after: readonly SurfaceObjectRecord[];
}
