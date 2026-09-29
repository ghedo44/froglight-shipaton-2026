/**
 * Ruler snap integration (slice 10): the ephemeral straightedge guides
 * pen-family gestures that start near the edge into ordinary canonical
 * ink, renders an overlay guide, and never touches history/dirty state
 * by itself.
 */

import { describe, expect, it } from 'vitest';
import { infiniteFrame, type SurfaceModel } from './model.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import {
  InkToolController,
  SURFACE_TOOL_IDS,
} from './tools.js';
import type { SurfaceRulerState } from './ruler.js';

function board(): SurfaceModel {
  return { formatVersion: 1, frame: infiniteFrame(), order: [], objects: {} };
}

function controller(ruler?: SurfaceRulerState | null): InkToolController {
  return new InkToolController({
    model: board(),
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    ...(ruler !== undefined ? { ruler } : {}),
  });
}

function strokePoints(model: SurfaceModel): { x: number; y: number }[] {
  const id = model.order[0];
  const record = (model.objects[id!] as { points?: { x: number; y: number }[] })
    .points;
  return (record ?? []).map((p) => ({ x: p.x, y: p.y }));
}

describe('ruler snap', () => {
  it('is hidden by default with no overlay and no snapping', () => {
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    expect(c.ruler()).toBeNull();
    expect(c.previewItems()).toEqual([]);
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown({ point: { x: 0, y: 5 } });
    c.pointerBatch([{ point: { x: 50, y: 9 } }]);
    c.pointerUp({ point: { x: 100, y: 3 } });
    expect(strokePoints(model).length).toBeGreaterThan(0);
  });

  it('snaps a pen stroke that starts near a horizontal edge', () => {
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.setRuler({ visible: true, x: 0, y: 100, angle: 0, length: 400 });
    c.pointerDown({ point: { x: 0, y: 105 } });
    c.pointerBatch([
      { point: { x: 50, y: 108 } },
      { point: { x: 100, y: 95 } },
    ]);
    c.pointerUp({ point: { x: 150, y: 103 } });
    for (const p of strokePoints(model)) {
      expect(p.y).toBeCloseTo(100, 6);
    }
  });

  it('leaves strokes that start far from the edge free', () => {
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.setRuler({ visible: true, x: 0, y: 100, angle: 0, length: 400 });
    c.pointerDown({ point: { x: 0, y: 200 } });
    c.pointerBatch([{ point: { x: 50, y: 210 } }]);
    c.pointerUp({ point: { x: 100, y: 190 } });
    const points = strokePoints(model);
    expect(points.some((p) => Math.abs(p.y - 100) > 20)).toBe(true);
  });

  it('does not snap eraser gestures even near the edge', () => {
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    c.setRuler({ visible: true, x: 0, y: 100, angle: 0, length: 400 });
    c.pointerDown({ point: { x: 0, y: 102 } });
    c.pointerBatch([{ point: { x: 40, y: 108 } }]);
    c.pointerCancel();
    expect(model.order).toEqual([]);
  });

  it('renders the ruler guide as an ephemeral overlay while idle', () => {
    const c = controller();
    c.setRuler({ visible: true, x: 0, y: 50, angle: 0, length: 200 });
    const overlay = c.previewItems();
    expect(overlay).toHaveLength(1);
    expect(overlay[0]).toMatchObject({
      kind: 'line',
      objectId: 'surface.ruler',
    });
    c.setRuler(null);
    expect(c.ruler()).toBeNull();
    expect(c.previewItems()).toEqual([]);
  });

  it('hides invalid ruler records instead of breaking drawing', () => {
    const c = controller();
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.setRuler({ visible: true, x: 0, y: 0, angle: 0, length: -1 });
    expect(c.ruler()).toBeNull();
    expect(c.previewItems()).toEqual([]);
  });

  it('keeps snapped ink as ordinary stroke records', () => {
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.setTool(SURFACE_TOOL_IDS.highlighter);
    c.setRuler({ visible: true, x: 0, y: 20, angle: 0, length: 400 });
    c.pointerDown({ point: { x: 5, y: 22 } });
    c.pointerUp({ point: { x: 60, y: 18 } });
    expect(model.order).toHaveLength(1);
    const record = model.objects[model.order[0]!] as { type: string };
    expect(record.type).toBe('froglight.ink.stroke');
  });
});
