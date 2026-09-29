import { describe, expect, it } from 'vitest';
import { emptySurface, infiniteFrame, inkStrokeObject } from './model.js';
import {
  encodeSurfacePayload,
  decodeSurfacePayload,
  SURFACE_LIMITS,
} from './codec.js';
import { SurfaceDurabilityValidator } from './durability-validation.js';
import {
  applySurfaceDocumentDelta,
  SurfaceDeltaCollector,
} from '../surface-persistence.js';
import {
  InkToolController,
  createDefaultSurfaceToolRegistry,
  SURFACE_TOOL_IDS,
} from './tools.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import { InkPresetStore } from './ink/presets.js';
import { createTestErasurePreparation } from '../testing/erasure-preparation.js';

async function erased() {
  const model = emptySurface(infiniteFrame());
  model.objects.s = inkStrokeObject('s', {
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    width: 5,
  });
  model.order.push('s');
  const collector = new SurfaceDeltaCollector(model, false);
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 5 });
  const controller = new InkToolController({
    model,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    erasurePreparation: createTestErasurePreparation(),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  controller.pointerDown({ point: { x: 50, y: -20 } });
  controller.pointerMove({ point: { x: 50, y: 20 } });
  controller.pointerUp({ point: { x: 50, y: 20 } });
  await controller.drainErasure();
  const delta = collector.take();
  collector.dispose();
  controller.destroy();
  return { model, delta };
}
describe('durability admission uses normal reopen constraints', () => {
  it('rejects an unresolved fragment before changing the persistence mirror', async () => {
    const { model, delta } = await erased();
    const prior = decodeSurfacePayload(encodeSurfacePayload(model)).model;
    const invalid = {
      ...delta,
      surfaces: delta.surfaces.map((change) => ({
        ...change,
        order: [],
        objects: { s: { ...model.objects.s!, sourceId: 'missing' } },
      })),
    };
    const candidate = applySurfaceDocumentDelta(prior, invalid, false);
    expect(() =>
      new SurfaceDurabilityValidator().validate(candidate, invalid, false),
    ).toThrow('Unresolved');
    expect(prior.objects.s!.sourceId).toBe(model.objects.s!.sourceId);
    expect(() => encodeSurfacePayload(candidate as typeof model)).toThrow(
      'unresolved',
    );
  });
  it('rejects a false source outline revision in both admission and normal reopening', async () => {
    const { model, delta } = await erased();
    const id = model.objects.s!.sourceId as string;
    model.objects[id] = {
      ...model.objects[id]!,
      outlineLength: (model.objects[id]!.outlineLength as number) + 1,
    };
    expect(() =>
      new SurfaceDurabilityValidator().validate(model, delta, false),
    ).toThrow('outline revision');
    expect(() => encodeSurfacePayload(model)).toThrow('outline revision');
  });
  it('rejects draft fragments and invalid boundary ranges', async () => {
    const { model, delta } = await erased();
    model.objects.s = { ...model.objects.s!, visible: [[[[999999, 3, 1]]]] };
    expect(() =>
      new SurfaceDurabilityValidator().validate(model, delta, false),
    ).toThrow('Unresolved');
    expect(() => encodeSurfacePayload(model)).toThrow(
      'invalid ink source boundary',
    );
    delete model.objects.s.visible;
    model.objects.s.region = [
      [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
    ];
    expect(() =>
      new SurfaceDurabilityValidator().validate(model, delta, false),
    ).toThrow('Invalid journal ink fragment');
    expect(() => encodeSurfacePayload(model)).toThrow('invalid ink region');
  });
  it('rejects unsupported sample-plus-mask records before durability', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.s = {
      ...inkStrokeObject('s', {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        width: 3,
      }),
      erasure: [
        [
          [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 0, y: 2 },
          ],
        ],
      ],
    };
    model.order.push('s');
    expect(() =>
      new SurfaceDurabilityValidator().validate(
        model,
        { shell: null, surfaces: [] },
        false,
      ),
    ).toThrow('Unsupported stroke erasure mask');
    expect(() => encodeSurfacePayload(model)).toThrow();
  });
  it('agrees exactly on the file-byte boundary without weakening the cap', () => {
    const model = emptySurface(infiniteFrame());
    model.unknownFields = { padding: '' };
    const overhead = encodeSurfacePayload(model).byteLength;
    model.unknownFields.padding = 'x'.repeat(
      SURFACE_LIMITS.maxFileBytes - overhead,
    );
    const delta = { shell: null, surfaces: [] };
    new SurfaceDurabilityValidator().validate(model, delta, false);
    expect(encodeSurfacePayload(model).byteLength).toBe(
      SURFACE_LIMITS.maxFileBytes,
    );
    model.unknownFields = { padding: model.unknownFields.padding + 'x' };
    expect(() =>
      new SurfaceDurabilityValidator().validate(model, delta, false),
    ).toThrow('file-size limit');
    expect(() => encodeSurfacePayload(model)).toThrow('max file size');
  });
  it('preserves opaque plugin members named sourceId or region', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.plugin = {
      id: 'plugin',
      type: 'vendor.example',
      sourceId: 'external',
      region: { opaque: true },
    };
    model.order.push('plugin');
    new SurfaceDurabilityValidator().validate(
      model,
      { shell: null, surfaces: [] },
      false,
    );
    expect(
      decodeSurfacePayload(encodeSurfacePayload(model)).model.objects.plugin,
    ).toEqual(model.objects.plugin);
  });
  it('rejects a Whiteboard frame that its normal document codec cannot reopen', () => {
    const model = emptySurface({ kind: 'bounded', width: 100, height: 100 });
    expect(() =>
      new SurfaceDurabilityValidator().validate(
        model,
        { shell: null, surfaces: [] },
        false,
        'froglight.whiteboard',
      ),
    ).toThrow('must be infinite');
  });
});
