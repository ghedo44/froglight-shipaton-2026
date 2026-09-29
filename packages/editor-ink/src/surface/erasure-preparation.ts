import {
  FroglightError,
  type ErasurePreparation,
  type InkErasure,
  type PreparedInkRegion,
  type SurfaceObjectRecord,
  type InkRegionTransform,
} from '@froglight/foundation';

/** One outstanding worker message; unsent stages coalesce by job and object. */
export function createErasurePreparation(
  options: { measure?: boolean } = {},
): ErasurePreparation & {
  diagnostics(): {
    preparationMs: number;
    submissionMs: number;
    stages: number;
  };
} {
  const metrics = { preparationMs: 0, submissionMs: 0, stages: 0 };
  const makeWorker = () =>
    new Worker(new URL('./erasure.worker.ts', import.meta.url), {
      type: 'module',
      name: 'froglight-erasure',
    });
  let worker: Worker | undefined;
  const ensureWorker = () => {
    if (worker === undefined) {
      worker = makeWorker();
      attach();
    }
    return worker;
  };
  type Completion = {
    resolve(
      value: Readonly<Record<string, readonly PreparedInkRegion[]>>,
    ): void;
    reject(error: unknown): void;
  };
  const pending = new Map<number, Completion>();
  type Stage = {
    region: InkErasure;
    source: SurfaceObjectRecord;
    transform?: InkRegionTransform;
  };
  const stages = new Map<number, Map<string, Stage>>();
  const sentSources = new Set<string>();
  const errors = new Map<number, unknown>();
  const finishing = new Set<number>();
  const active = new Set<number>();
  let outstanding = false;
  let failed: unknown = null;
  let disposed = false;
  const vertices = (region: InkErasure) =>
    region.reduce((n, p) => n + p.reduce((n, r) => n + r.length, 0), 0);
  let queuedVertices = 0;
  function fail(error: unknown): void {
    failed =
      error instanceof FroglightError
        ? error
        : new FroglightError(
            'IO',
            'Precision eraser worker stopped; the last valid erased region is retained',
            { cause: error },
          );
    for (const request of pending.values()) request.reject(failed);
    pending.clear();
    stages.clear();
    finishing.clear();
    errors.clear();
    active.clear();
    sentSources.clear();
    queuedVertices = 0;
    outstanding = false;
    worker?.terminate();
  }
  function send(message: unknown): void {
    const started = options.measure === true ? performance.now() : 0;
    try {
      ensureWorker().postMessage(message);
    } catch (error) {
      fail(error);
    } finally {
      if (options.measure === true)
        metrics.submissionMs += performance.now() - started;
    }
  }
  function pump(): void {
    if (outstanding || disposed || failed !== null) return;
    for (const [job, records] of stages) {
      const first = records.entries().next().value;
      if (first === undefined) {
        stages.delete(job);
        continue;
      }
      const [id, stage] = first;
      const { region, source, transform } = stage;
      records.delete(id);
      queuedVertices -= vertices(region);
      if (records.size === 0) stages.delete(job);
      outstanding = true;
      send({
        type: 'stage',
        measure: options.measure,
        job,
        id,
        region,
        sourceId: source.id,
        source: sentSources.has(source.id) ? undefined : source,
        transform,
      });
      sentSources.add(source.id);
      return;
    }
    const job = finishing.values().next().value;
    if (job !== undefined) {
      finishing.delete(job);
      outstanding = true;
      send({ type: 'finish', job });
    }
  }
  function attach(): void {
    const lane = worker!;
    lane.onmessage = (
      event: MessageEvent<{
        job: number;
        staged?: boolean;
        preparationMs?: number;
        result?: Record<string, PreparedInkRegion[]>;
        error?: string;
      }>,
    ) => {
      if (worker !== lane || failed !== null || disposed) return;
      const response = event.data;
      if (options.measure === true && response.preparationMs !== undefined) {
        metrics.preparationMs += response.preparationMs;
        metrics.stages++;
      }
      outstanding = false;
      if (!active.has(response.job)) {
        pump();
        return;
      }
      if (!response.staged || response.error !== undefined) {
        const request = pending.get(response.job);
        if (response.error !== undefined) {
          const error = new FroglightError('IO', response.error);
          if (request === undefined) errors.set(response.job, error);
          else {
            request.reject(error);
            pending.delete(response.job);
            finishing.delete(response.job);
            active.delete(response.job);
          }
        } else {
          request?.resolve(response.result!);
          pending.delete(response.job);
          active.delete(response.job);
        }
      }
      pump();
    };
    lane.onerror = () => {
      if (worker === lane)
        fail(
          new FroglightError(
            'IO',
            'Precision eraser worker stopped; the last valid erased region is retained',
          ),
        );
    };
  }
  return {
    diagnostics: () => ({ ...metrics }),
    restart() {
      if (disposed)
        throw new FroglightError('ABORTED', 'Precision eraser owner disposed');
      worker?.terminate();
      for (const request of pending.values())
        request.reject(
          new FroglightError('ABORTED', 'Precision eraser worker restarted'),
        );
      pending.clear();
      stages.clear();
      errors.clear();
      finishing.clear();
      active.clear();
      sentSources.clear();
      queuedVertices = 0;
      outstanding = false;
      failed = null;
      worker = undefined;
    },
    stage(job, id, region, source, transform) {
      if (disposed || failed !== null)
        throw (
          failed ??
          new FroglightError('ABORTED', 'Precision eraser owner disposed')
        );
      if (!active.has(job) && active.size >= 64)
        throw new FroglightError(
          'FORMAT_LIMIT_EXCEEDED',
          'Precision eraser queue exceeds its resource budget',
        );
      active.add(job);
      const records = stages.get(job) ?? new Map<string, Stage>();
      const previous = records.get(id);
      const nextVertices =
        queuedVertices +
        vertices(region) -
        (previous ? vertices(previous.region) : 0);
      if (nextVertices * 16 > 64 * 1024 * 1024 || stages.size >= 64)
        throw new FroglightError(
          'FORMAT_LIMIT_EXCEEDED',
          'Precision eraser queue exceeds its resource budget',
        );
      queuedVertices = nextVertices;
      records.set(id, { region, source, transform });
      stages.set(job, records);
      pump();
    },
    finish(job) {
      const error = errors.get(job) ?? failed;
      errors.delete(job);
      if (disposed || error !== null) {
        active.delete(job);
        return Promise.reject(
          error ??
            new FroglightError('ABORTED', 'Precision eraser owner disposed'),
        );
      }
      if (pending.size >= 64)
        return Promise.reject(
          new FroglightError(
            'IO',
            'Precision eraser queue is full; the erased region is retained',
          ),
        );
      return new Promise((resolve, reject) => {
        pending.set(job, { resolve, reject });
        finishing.add(job);
        pump();
      });
    },
    cancel(job) {
      for (const stage of stages.get(job)?.values() ?? [])
        queuedVertices -= vertices(stage.region);
      stages.delete(job);
      errors.delete(job);
      finishing.delete(job);
      active.delete(job);
      if (!disposed && failed === null) send({ type: 'cancel', job });
    },
    releaseSource(id) {
      sentSources.delete(id);
      if (!disposed && failed === null && worker !== undefined)
        send({ type: 'release-source', sourceId: id });
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      for (const request of pending.values())
        request.reject(
          new FroglightError('ABORTED', 'Precision eraser owner disposed'),
        );
      pending.clear();
      errors.clear();
      stages.clear();
      finishing.clear();
      active.clear();
    },
  };
}
