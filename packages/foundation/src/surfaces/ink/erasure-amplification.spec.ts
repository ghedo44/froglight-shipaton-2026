import { createTestErasurePreparation } from '../../testing/erasure-preparation.js';
import { expect, it } from 'vitest';
import {
  infiniteFrame,
  inkStrokeObject,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '../model.js';
import { createDefaultSurfaceObjectTypeRegistry } from '../objects.js';
import {
  InkToolController,
  createDefaultSurfaceToolRegistry,
  SURFACE_TOOL_IDS,
} from '../tools.js';
import { InkPresetStore } from './presets.js';

it('a precision cut never duplicates complete source samples for its components', async () => {
  const samples = Array.from({ length: 1000 }, (_, x) => ({
    x,
    y: 50,
    pressure: 0.5,
    dt: x,
  }));
  const model: SurfaceModel = {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['s'],
    objects: { s: inkStrokeObject('s', { points: samples, width: 5 }) },
  };
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 8 });
  const controller = new InkToolController({
    model,
    erasurePreparation: createTestErasurePreparation(),
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  controller.pointerDown({ point: { x: 500, y: 30 } });
  controller.pointerMove({ point: { x: 500, y: 70 } });
  controller.pointerUp({ point: { x: 500, y: 70 } });
  await controller.drainErasure();
  const countSamples = (value: unknown): number => {
    if (!value || typeof value !== 'object') return 0;
    if (Array.isArray(value))
      return value.reduce((n, v) => n + countSamples(v), 0);
    return Object.entries(value).reduce(
      (n, [k, v]) =>
        n + (k === 'points' && Array.isArray(v) ? v.length : countSamples(v)),
      0,
    );
  };
  expect(countSamples(model.objects)).toBe(samples.length);
  controller.destroy();
});

it('successive reversing cuts on dense curved logical chunks retain one stream per source', async () => {
  const model: SurfaceModel = {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: [],
    objects: {},
  };
  for (let stroke = 0; stroke < 8; stroke++)
    for (let chunk = 0; chunk < 2; chunk++) {
      const id = `s${stroke}-${chunk}`;
      model.order.push(id);
      model.objects[id] = {
        ...inkStrokeObject(id, {
          points: Array.from({ length: 256 }, (_, i) => ({
            x: chunk * 256 + i,
            y: stroke * 30 + Math.sin((chunk * 256 + i) / 15) * 8,
            pressure: 0.3 + (0.4 * (i % 17)) / 17,
            dt: i * 4,
          })),
          width: 6,
          brush: { kind: 'highlighter' },
          opacity: 0.3,
        }),
        logicalId: `s${stroke}`,
        chunkIndex: chunk,
      };
    }
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 4 });
  const controller = new InkToolController({
    model,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    erasurePreparation: createTestErasurePreparation(),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  for (const x of [100, 200, 300, 400, 150, 350]) {
    controller.pointerDown({ point: { x, y: -20 } });
    controller.pointerBatch([
      { point: { x: x + 3, y: 100 } },
      { point: { x: x - 2, y: 240 } },
      { point: { x: x + 2, y: 100 } },
      { point: { x, y: 240 } },
    ]);
    controller.pointerUp({ point: { x, y: 240 } });
    await controller.drainErasure();
    const sources = Object.values(model.objects).filter(
      (r) => r.type === 'froglight.ink.source',
    );
    expect(sources).toHaveLength(8);
    expect(
      sources.reduce(
        (n, r) =>
          n +
          (r.chunks as { points: unknown[] }[]).reduce(
            (n, c) => n + c.points.length,
            0,
          ),
        0,
      ),
    ).toBe(4096);
    expect(
      model.order.every(
        (id) =>
          model.objects[id]!.points === undefined &&
          model.objects[id]!.erasure === undefined,
      ),
    ).toBe(true);
  }
  expect(model.order.length).toBeGreaterThan(40);
  controller.destroy();
}, 30_000);

it('cold packed geometry keeps its exact attribute basis without expanding every source vertex', async () => {
  const { compileInkStroke } = await import('./compiler.js');
  const { packInkSamples, unpackInkSamples, packCompiledInk } = await import(
    './packed-protocol.js'
  );
  const {
    retainPackedOnlyForRecord,
    resolveStrokeBrush,
    inkStrokeContoursOfRecord,
  } = await import('../objects.js');
  const { encodeSurfacePayload, decodeSurfacePayload } = await import(
    '../codec.js'
  );
  const record = inkStrokeObject('s', {
    points: Array.from({ length: 1000 }, (_, x) => ({
      x,
      y: Math.sin(x / 13) * 8,
      pressure: 0.3 + (0.4 * (x % 17)) / 17,
      dt: x * 4,
    })),
    width: 5,
    brush: { kind: 'brush' },
  });
  const original = JSON.stringify(record);
  const { packed } = packCompiledInk(
    compileInkStroke(
      unpackInkSamples(
        packInkSamples(record.points as import('../model.js').InkSample[])
          .packed,
      ),
      resolveStrokeBrush(record),
    ),
  );
  retainPackedOnlyForRecord(record, packed);
  const model: SurfaceModel = {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['s'],
    objects: { s: record },
  };
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 4 });
  const controller = new InkToolController({
    model,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    erasurePreparation: createTestErasurePreparation(),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  controller.pointerDown({ point: { x: 500, y: -30 } });
  controller.pointerMove({ point: { x: 500, y: 30 } });
  controller.pointerUp({ point: { x: 500, y: 30 } });
  await controller.drainErasure();
  const source = model.objects[model.objects.s!.sourceId as string]!;
  expect(source.sampleEncoding).toBe('packed');
  expect(JSON.stringify(record)).toBe(original);
  expect((source.chunks as SurfaceObjectRecord[])[0]!.points).toEqual(
    record.points,
  );
  const tokens = model.order.flatMap((id) =>
    (
      model.objects[id]!.visible as import('./fragments.js').InkVisibleRegion
    ).flat(2),
  );
  expect(tokens.length).toBeLessThan(1000);
  const reopened = decodeSurfacePayload(encodeSurfacePayload(model)).model;
  expect(
    reopened.order.flatMap((id) =>
      inkStrokeContoursOfRecord(reopened.objects[id]!),
    ),
  ).toEqual(
    model.order.flatMap((id) => inkStrokeContoursOfRecord(model.objects[id]!)),
  );
  controller.destroy();
});
