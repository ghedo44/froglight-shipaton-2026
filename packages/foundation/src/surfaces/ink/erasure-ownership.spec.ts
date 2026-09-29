import { describe, expect, it } from 'vitest';
import { createTestErasurePreparation } from '../../testing/erasure-preparation.js';
import {
  infiniteFrame,
  inkStrokeObject,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '../model.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  inkStrokeContoursOfRecord,
  inkStrokeEnvelope,
  compiledStrokeComputeStats,
} from '../objects.js';
import {
  InkToolController,
  createDefaultSurfaceToolRegistry,
  SURFACE_TOOL_IDS,
} from '../tools.js';
import { decodeSurfacePayload, encodeSurfacePayload } from '../codec.js';
import { hitVisible } from './erasure.js';
import { centerOfBounds, rotateAround } from '../geometry.js';
import { InkPresetStore } from './presets.js';

const stroke = (id: string, start: number, end: number): SurfaceObjectRecord =>
  inkStrokeObject(id, {
    points: [
      { x: start, y: 0, pressure: 0.7 },
      { x: end, y: 0, pressure: 0.7 },
    ],
    width: 10,
    brush: { kind: 'highlighter' },
    opacity: 0.3,
  });
function fixture(records: SurfaceObjectRecord[]) {
  const model: SurfaceModel = {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: records
      .filter((r) => r.type !== 'froglight.ink.source')
      .map((r) => r.id),
    objects: Object.fromEntries(records.map((r) => [r.id, r])),
  };
  const presets = new InkPresetStore();
  presets.setEraser({ mode: 'precision', radius: 3 });
  const controller = new InkToolController({
    model,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    erasurePreparation: createTestErasurePreparation(),
  });
  controller.setTool(SURFACE_TOOL_IDS.eraser);
  const cut = async (start: { x: number; y: number }, end = start) => {
    controller.pointerDown({ point: start });
    controller.pointerMove({ point: end });
    controller.pointerUp({ point: end });
    await controller.drainErasure();
  };
  return { model, controller, presets, cut };
}
describe('immutable eraser source ownership', () => {
  it.each([false, true])(
    'logical chunks share one lossless source (chunked=%s)',
    async (chunked) => {
      const records = chunked
        ? [
            { ...stroke('a', 0, 100), logicalId: 'a', chunkIndex: 0 },
            { ...stroke('b', 101, 200), logicalId: 'a', chunkIndex: 1 },
          ]
        : [stroke('a', 0, 200)];
      const f = fixture(records);
      await f.cut({ x: 100, y: -20 }, { x: 100, y: 20 });
      expect(f.model.order).toHaveLength(2);
      const sourceIds = new Set(
        f.model.order.map((id) => f.model.objects[id]!.sourceId),
      );
      expect(sourceIds.size).toBe(1);
      const source = f.model.objects[[...sourceIds][0] as string]!;
      expect(source.chunks).toEqual(records);
      expect(Object.isFrozen(source)).toBe(true);
      const reopened = fixture(
        Object.values(
          decodeSurfacePayload(encodeSurfacePayload(f.model)).model.objects,
        ),
      );
      expect(reopened.model.order).toHaveLength(2);
      for (const current of [f, reopened]) {
        expect(current.controller.hitTest({ x: 20, y: 0 })).not.toEqual(
          current.controller.hitTest({ x: 180, y: 0 }),
        );
        expect(current.controller.hitTest({ x: 100, y: 0 })).toBeNull();
        const other = JSON.stringify(
          current.model.objects[current.model.order[1]!]!,
        );
        current.controller.setSelection(['a']);
        current.controller.moveSelectionBy({ x: 0, y: 100 });
        expect(
          JSON.stringify(current.model.objects[current.model.order[1]!]!),
        ).toBe(other);
        expect(current.controller.hitTest({ x: 20, y: 100 })).not.toBeNull();
        current.presets.setEraser({ mode: 'stroke' });
        await current.cut({ x: 20, y: 100 });
        expect(current.model.order).toHaveLength(1);
        expect(current.model.objects[source.id]).toBeDefined();
        await current.cut({ x: 180, y: 0 });
        expect(current.model.order).toHaveLength(0);
        expect(current.model.objects[source.id]).toBeUndefined();
        current.controller.destroy();
      }
    },
  );
  it.each([0, Math.PI / 3, Math.PI / 2])(
    'rotation preserves fill and independent selection (%s)',
    async (rotation) => {
      const record = { ...stroke('a', 0, 200), rotation };
      const f = fixture([record]);
      const pivot = centerOfBounds(inkStrokeEnvelope(record)!);
      await f.cut(
        rotateAround({ x: 100, y: -20 }, pivot, rotation),
        rotateAround({ x: 100, y: 20 }, pivot, rotation),
      );
      expect(f.model.order).toHaveLength(2);
      const world = rotateAround({ x: 100, y: 0 }, pivot, rotation);
      expect(f.controller.hitTest(world)).toBeNull();
      const after = encodeSurfacePayload(f.model);
      const reopened = decodeSurfacePayload(after).model;
      expect(
        reopened.order.flatMap((id) =>
          inkStrokeContoursOfRecord(reopened.objects[id]!),
        ),
      ).toEqual(
        f.model.order.flatMap((id) =>
          inkStrokeContoursOfRecord(f.model.objects[id]!),
        ),
      );
      f.controller.destroy();
    },
  );
  it('groups own new fragments and source geometry never enters paint order', async () => {
    const f = fixture([
      stroke('a', 0, 200),
      { id: 'g', type: 'froglight.group', children: ['a'] },
    ]);
    await f.cut({ x: 100, y: -20 }, { x: 100, y: 20 });
    expect(f.model.objects.g!.children).toEqual(
      f.model.order.filter((id) => id !== 'g'),
    );
    expect(
      f.model.order.some(
        (id) => f.model.objects[id]!.type === 'froglight.ink.source',
      ),
    ).toBe(false);
    f.controller.destroy();
  });
  it('further shaving a moved fragment retains brush appearance and leaves siblings untouched', async () => {
    const f = fixture([stroke('a', 0, 200)]);
    await f.cut({ x: 100, y: -20 }, { x: 100, y: 20 });
    const sibling = JSON.stringify(f.model.objects[f.model.order[1]!]!);
    const computes = compiledStrokeComputeStats.computes;
    f.controller.setSelection(['a']);
    f.controller.moveSelectionBy({ x: 500, y: 100 });
    await f.cut({ x: 550, y: 100 });
    expect(
      hitVisible(inkStrokeContoursOfRecord(f.model.objects.a!), {
        x: 550,
        y: 100,
      }),
    ).toBe(false);
    expect(JSON.stringify(f.model.objects[f.model.order[1]!]!)).toBe(sibling);
    expect(compiledStrokeComputeStats.computes).toBe(computes);
    f.controller.destroy();
  });
});
