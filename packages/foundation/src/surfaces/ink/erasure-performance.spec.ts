import { encodeSurfacePayload } from '../codec.js';
import { createTestErasurePreparation } from '../../testing/erasure-preparation.js';
import { expect, it } from 'vitest';
import { boundedFrame, inkStrokeObject, type SurfaceModel } from '../model.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  inkStrokeContoursOfRecord,
} from '../objects.js';
import {
  InkToolController,
  createDefaultSurfaceToolRegistry,
  SURFACE_TOOL_IDS,
} from '../tools.js';
import { InkPresetStore } from './presets.js';

it('erases stacked fitted strokes without whole-outline clipping stalls', async () => {
  const model: SurfaceModel = {
    formatVersion: 1,
    frame: boundedFrame(1000, 800),
    order: [],
    objects: {},
  };
  for (let i = 0; i < 80; i++) {
    const id = `s${i}`;
    model.order.push(id);
    model.objects[id] = inkStrokeObject(id, {
      width: 3,
      points: Array.from({ length: 1000 }, (_, k) => ({
        x: 50 + k * 0.8,
        y: 400 + i * 0.02 + Math.sin(k / 2) * 4,
        pressure: 0.5,
        dt: k * 8,
      })),
    });
    inkStrokeContoursOfRecord(model.objects[id]!);
  }
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 14 });
  const controller = new InkToolController({
    model,
    erasurePreparation: createTestErasurePreparation(),
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  const start = performance.now();
  controller.pointerDown({ point: { x: 400, y: 400 } });
  controller.pointerMove({ point: { x: 410, y: 400 } });
  const movementMs = performance.now() - start;
  const releaseStart = performance.now();
  controller.pointerUp({ point: { x: 410, y: 400 } });
  const releaseMs = performance.now() - releaseStart;
  const preparationStart = performance.now();
  await controller.drainErasure();
  const preparationMs = performance.now() - preparationStart;
  console.info(
    JSON.stringify({
      movementMs,
      releaseMs,
      preparationMs,
      sourceBytes: Object.values(model.objects)
        .filter((r) => r.type === 'froglight.ink.source')
        .reduce((n, r) => n + JSON.stringify(r).length, 0),
      tokenCount: Object.values(model.objects)
        .filter((r) => r.visible)
        .flatMap((r) => (r.visible as unknown[][][]).flat(2)).length,
      fragments: model.order.length,
      compactBytes: JSON.stringify(model).length,
      ownedTokens: Object.values(model.objects)
        .filter((r) => r.visible)
        .reduce(
          (n, r) =>
            n +
            (r.visible as unknown[][][])
              .flat(2)
              .filter((t) => !Array.isArray(t)).length,
          0,
        ),
    }),
  );

  expect(
    model.order.some((id) => model.objects[id]!.visible !== undefined),
  ).toBe(true);
  const visibleTokens = Object.values(model.objects)
    .filter((r) => r.visible)
    .flatMap((r) => (r.visible as unknown[][][]).flat(2));
  console.info(
    JSON.stringify({ encodedBytes: encodeSurfacePayload(model).byteLength }),
  );
  expect(visibleTokens.filter((t) => !Array.isArray(t)).length).toBeLessThan(
    1000,
  );
  expect(visibleTokens.length).toBeLessThan(10_000);
  controller.destroy();
  // Broad CI smoke budget, not a frame-rate claim. The original path took
  // roughly 40 seconds, mostly sweeping whole outlines during the drag.
  expect(movementMs).toBeLessThan(15_000);
  expect(releaseMs).toBeLessThan(50);
}, 60_000);
