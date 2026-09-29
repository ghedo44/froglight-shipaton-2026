import { createTestErasurePreparation } from '../../testing/erasure-preparation.js';
import { describe, expect, it } from 'vitest';
import { decodeSurfacePayload, encodeSurfacePayload } from '../codec.js';
import {
  centerOfBounds,
  rotateAround,
  pointSegmentDistance,
} from '../geometry.js';
import { infiniteFrame, inkStrokeObject, type SurfaceModel } from '../model.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  compiledStrokeForRecord,
  inkStrokeContoursOfRecord,
  inkStrokeEnvelope,
} from '../objects.js';
import {
  InkToolController,
  createDefaultSurfaceToolRegistry,
  SURFACE_TOOL_IDS,
} from '../tools.js';
import { INK_BRUSH_KINDS } from './brush.js';
import { hitVisible, type InkErasure } from './erasure.js';
import { InkPresetStore } from './presets.js';

function setup(
  kind: (typeof INK_BRUSH_KINDS)[number],
  mode: 'precision' | 'stroke',
  rotation = 0,
) {
  const points = Array.from({ length: 201 }, (_, i) => ({
    x: i,
    y: 20 * Math.sin(i / 13),
    pressure: 0.5 + 0.4 * Math.sin(i / 6),
    dt: i * 8,
  }));
  const record = inkStrokeObject('s', {
    points,
    width: 10,
    brush: { kind },
    rotation,
  });
  const model: SurfaceModel = {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['s'],
    objects: { s: record },
  };
  const presets = new InkPresetStore();
  presets.setEraser({ mode, radius: 3 });
  const registry = createDefaultSurfaceObjectTypeRegistry();
  const controller = new InkToolController({
    model,
    erasurePreparation: createTestErasurePreparation(),
    objectRegistry: registry,
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  const cut = async (x: number, y: number) => {
    const world = rotateAround(
      { x, y },
      centerOfBounds(inkStrokeEnvelope(record)!),
      rotation,
    );
    controller.pointerDown({ point: world });
    controller.pointerUp({ point: world });
    await controller.drainErasure();
  };
  return { model, record, registry, controller, cut };
}

describe('production eraser preserves semantic source appearance', () => {
  for (const kind of INK_BRUSH_KINDS)
    for (const mode of ['precision'] as const) {
      it(`${kind} / ${mode}: repeated cuts, rebuild and serialization preserve surviving boundaries`, async () => {
        const { model, record, cut } = setup(kind, mode);
        const source = JSON.stringify(record);
        const original = compiledStrokeForRecord(record)!;
        await cut(100, 20 * Math.sin(100 / 13));
        expect(model.order[0]).toBe('s');
        expect(model.objects.s!.points).toBeUndefined();
        const storedSource =
          model.objects[model.objects.s!.sourceId as string]!;
        expect((storedSource.chunks as (typeof record)[])[0]!.points).toEqual(
          record.points,
        );
        expect(model.objects.s!.brush).toEqual(record.brush);
        expect(model.objects.s!.brush).not.toBe(record.brush);
        expect(JSON.stringify(record)).toBe(source);
        expect(model.objects.s!.visible).toBeDefined();
        const once = model.order.length;
        await cut(100, 20 * Math.sin(100 / 13));
        expect(model.order.length).toBe(once);
        await cut(160, 20 * Math.sin(160 / 13));
        const encoded = encodeSurfacePayload(model);
        const decoded = decodeSurfacePayload(encoded).model;
        expect(decoded.formatVersion).toBe(1);
        expect(encodeSurfacePayload(decoded)).toEqual(encoded);
        for (const currentModel of [model, decoded]) {
          const contours = currentModel.order.flatMap((id) =>
            inkStrokeContoursOfRecord(currentModel.objects[id]!),
          );
          const edges = contours.flatMap((ring) =>
            ring.map((p, i) => [p, ring[(i + 1) % ring.length]!] as const),
          );
          for (const point of original.polygon.filter(
            (p) => p.x < 70 || p.x > 185,
          )) {
            expect(
              Math.min(
                ...edges.map(([a, b]) => pointSegmentDistance(point, a, b)),
              ),
            ).toBeLessThan(1e-8);
          }
          for (const id of currentModel.order)
            expect(currentModel.objects[id]!.points).toBeUndefined();
        }
      });
    }
  it('does not read distant stroke samples during a precision gesture', async () => {
    const { model, controller, cut } = setup('ball', 'precision');
    const distant: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `distant-${i}`;
      model.objects[id] = inkStrokeObject(id, {
        points: [
          { x: 10000 + i * 100, y: 10000 },
          { x: 10050 + i * 100, y: 10000 },
        ],
        width: 4,
      });
      model.order.push(id);
      distant.push(id);
    }
    controller.notifyExternalMutation(distant);
    let sampleReads = 0;
    for (const id of distant) {
      const record = model.objects[id]!;
      const points = record.points;
      Object.defineProperty(record, 'points', {
        get: () => {
          sampleReads++;
          return points;
        },
      });
    }
    await cut(100, 20 * Math.sin(100 / 13));
    expect(model.objects.s!.visible).toBeDefined();
    expect(sampleReads).toBe(0);
    controller.destroy();
  });

  it('uses the original rotation pivot and does not hit an erased gap', async () => {
    const { model, record, cut, registry } = setup(
      'brush',
      'precision',
      Math.PI / 2,
    );
    const pivot = centerOfBounds(inkStrokeEnvelope(record)!);
    await cut(100, 20 * Math.sin(100 / 13));
    expect(model.objects.s!.rotation).toBe(0);
    expect(inkStrokeEnvelope(model.objects.s!)!.height).toBeGreaterThan(150);
    const world = rotateAround(
      { x: 100, y: 20 * Math.sin(100 / 13) },
      pivot,
      Math.PI / 2,
    );
    expect(
      registry.get(record.type)!.hitTest!(model.objects.s!, world.x, world.y),
    ).toBe(false);
  });
  it('a miss leaves the record and payload version unchanged', async () => {
    const { model, record, cut } = setup('brush', 'precision');
    await cut(1000, 1000);
    expect(model.objects.s).toBe(record);
    expect(
      decodeSurfacePayload(encodeSurfacePayload(model)).model.formatVersion,
    ).toBe(1);
  });
  it('precision shaves only its actual footprint from broad translucent ink', async () => {
    const { model, cut } = setup('highlighter', 'precision');
    const y = 20 * Math.sin(100 / 13);
    const before = inkStrokeContoursOfRecord(model.objects.s!);
    await cut(100, y + 4);
    const after = inkStrokeContoursOfRecord(model.objects.s!);
    expect(hitVisible(before, { x: 100, y: y - 3 })).toBe(true);
    expect(hitVisible(after, { x: 100, y: y - 3 })).toBe(true);
    expect(hitVisible(after, { x: 100, y: y + 4 })).toBe(false);
  });
  it('rejects malformed erasure masks', async () => {
    const { model, cut } = setup('brush', 'precision');
    await cut(100, 20 * Math.sin(100 / 13));
    model.objects.s!.visible = [
      [[{ x: Infinity, y: 0 }]],
    ] as unknown as InkErasure;
    expect(() => decodeSurfacePayload(encodeSurfacePayload(model))).toThrow(
      'invalid ink region',
    );
  });
});
