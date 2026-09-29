import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  compiledStrokeComputeStats,
  createDefaultSurfaceObjectTypeRegistry,
  emptySurface,
  FIRST_PAINT_MAX_COST,
  inkStrokeObject,
  IncrementalSceneCache,
  type SurfaceModel,
} from './index.js';
import type { ColdCompileResult } from './ink/cold-scheduler.js';

function points(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    x: offset + index * 2,
    y: Math.sin(index / 5) * 8,
  }));
}

function singleStrokeModel(count = 6000): SurfaceModel {
  const model = emptySurface(boundedFrame(20_000, 1000));
  model.objects.stroke = inkStrokeObject('stroke', {
    points: points(count),
    width: 3,
  });
  model.order.push('stroke');
  return model;
}

function logicalStrokeModel(): SurfaceModel {
  const model = emptySurface(boundedFrame(20_000, 1000));
  model.objects.logical = inkStrokeObject('logical', {
    points: points(6000),
    width: 3,
    logicalId: 'logical',
    chunkIndex: 0,
  });
  model.objects['logical#part2'] = inkStrokeObject('logical#part2', {
    points: points(6000, 12_000),
    width: 3,
    logicalId: 'logical',
    chunkIndex: 1,
  });
  model.order.push('logical', 'logical#part2');
  return model;
}

function readyResult(): ColdCompileResult {
  return {
    status: 'ready',
    compiled: undefined,
    packed: undefined,
    fallback: false,
    workerMs: 1,
    integrationMs: 0,
    packMs: 0,
    inputBytes: 0,
    outputBytes: 0,
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('incremental scene mutation compile budget', () => {
  it('defers a 6000-sample new stroke from mutation update, then prepares it asynchronously', async () => {
    const model = singleStrokeModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const scene = new IncrementalSceneCache();
    const before = compiledStrokeComputeStats.computes;

    const items = scene.update(
      model,
      registry,
      ['stroke'],
      FIRST_PAINT_MAX_COST,
    );

    expect(compiledStrokeComputeStats.computes).toBe(before);
    expect(scene.isPrepared('stroke')).toBe(false);
    expect(items.some((item) => item.item.objectId === 'stroke')).toBe(false);
    expect(await scene.prepareOneAsync(model, registry, 'stroke')).toBe(true);
    expect(scene.isPrepared('stroke')).toBe(true);
    expect(
      scene
        .update(model, registry, [], FIRST_PAINT_MAX_COST)
        .some((item) => item.item.objectId === 'stroke'),
    ).toBe(true);
  });

  it('defers a logical stroke whose two chunks total more than the budget, then prepares the joint key', async () => {
    const model = logicalStrokeModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const scene = new IncrementalSceneCache();
    scene.prepareVisible(model, registry, []);
    const before = compiledStrokeComputeStats.computes;

    const items = scene.update(
      model,
      registry,
      ['logical'],
      FIRST_PAINT_MAX_COST,
    );

    expect(compiledStrokeComputeStats.computes).toBe(before);
    expect(scene.isPrepared('logical')).toBe(false);
    expect(items.some((item) => item.item.objectId === 'logical')).toBe(false);
    expect(await scene.prepareOneAsync(model, registry, 'logical')).toBe(true);
    expect(scene.isPrepared('logical')).toBe(true);
  });

  it('keeps default mutation updates synchronous for existing callers', () => {
    const model = singleStrokeModel();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const scene = new IncrementalSceneCache();
    const before = compiledStrokeComputeStats.computes;

    scene.update(model, registry, ['stroke']);

    expect(compiledStrokeComputeStats.computes - before).toBe(1);
    expect(scene.isPrepared('stroke')).toBe(true);
  });

  it.each(['append', 'undo', 'delete'] as const)(
    'discards an in-flight worker result made stale by %s',
    async (mutation) => {
      const model = singleStrokeModel();
      const registry = createDefaultSurfaceObjectTypeRegistry();
      const scene = new IncrementalSceneCache();
      scene.update(model, registry, ['stroke'], FIRST_PAINT_MAX_COST);

      let release: ((result: ColdCompileResult) => void) | null = null;
      scene.setColdScheduler({
        compile: () =>
          new Promise<ColdCompileResult>((resolve) => {
            release = resolve;
          }),
        cancelForObjects: () => undefined,
      } as never);
      const preparing = scene.prepareOneAsync(model, registry, 'stroke');
      for (let attempt = 0; attempt < 10 && release === null; attempt++) {
        await tick();
      }
      expect(release).not.toBeNull();

      if (mutation === 'append') {
        const previous = model.objects.stroke!;
        const previousPoints = (
          previous as unknown as { points: ReturnType<typeof points> }
        ).points;
        model.objects.stroke = inkStrokeObject('stroke', {
          points: [...previousPoints, { x: 12_002, y: 1 }],
          width: 3,
        });
      } else if (mutation === 'undo') {
        // Undo replaces the mutated record with the saved before image.
        model.objects.stroke = inkStrokeObject('stroke', {
          points: points(20),
          width: 3,
        });
      } else {
        delete model.objects.stroke;
        model.order.length = 0;
      }
      scene.update(model, registry, ['stroke'], FIRST_PAINT_MAX_COST);
      const preparedAfterMutation = scene
        .update(model, registry, [], FIRST_PAINT_MAX_COST)
        .find((item) => item.item.objectId === 'stroke')?.item;
      release!(readyResult());

      expect(await preparing).toBe(false);
      const preparedAfterResult = scene
        .update(model, registry, [], FIRST_PAINT_MAX_COST)
        .find((item) => item.item.objectId === 'stroke')?.item;
      if (mutation === 'undo') {
        // The small restored record is correctly prepared synchronously by
        // update; the stale long-stroke result must not replace that item.
        expect(preparedAfterMutation).toBeDefined();
        expect(preparedAfterResult).toBe(preparedAfterMutation);
      } else {
        expect(preparedAfterMutation).toBeUndefined();
        expect(preparedAfterResult).toBeUndefined();
        expect(scene.isPrepared('stroke')).toBe(false);
      }
    },
  );
});
