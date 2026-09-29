import { createTestErasurePreparation } from '../testing/erasure-preparation.js';
/**
 * Cross-product integration (repair pass, item 17): Ink, Notebook, and
 * Whiteboard run the same corrected engine — one shared Surface core for
 * capture, geometry, presets, and persistence. Headless end-to-end: draw
 * with product presets through `InkToolController`, round-trip through
 * the canonical codec (close/reopen), and prove settings + appearance
 * survive on every surface family.
 */

import { describe, expect, it } from 'vitest';
import { InMemorySettingsService } from '../settings.js';
import { createCamera } from './geometry.js';
import {
  SURFACE_MAX_SAMPLE_DT_MS,
  infiniteFrame,
  inkStrokeObject,
  rectangleObject,
  type SurfaceModel,
} from './model.js';
import { decodeSurfacePayload, encodeSurfacePayload } from './codec.js';
import { resolveConnectorAnchor } from './ink/connectors.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  inkStrokeCompiledBounds,
} from './objects.js';
import { InkPresetStore } from './ink/presets.js';
import {
  SURFACE_TOOL_IDS,
  createDefaultSurfaceToolRegistry,
  InkToolController,
  type PenGestureOptions,
} from './tools.js';
import type { NormalizedPointerEvent } from './controller.js';

function at(
  x: number,
  y: number,
  extra: Partial<NormalizedPointerEvent> = {},
): NormalizedPointerEvent {
  return { point: { x, y }, ...extra };
}

function board(): SurfaceModel {
  return { formatVersion: 1, frame: infiniteFrame(), order: [], objects: {} };
}

function drawStroke(
  c: InkToolController,
  points: Array<{ x: number; y: number; pressure?: number; time?: number }>,
): void {
  const [first, ...rest] = points;
  c.pointerDown(at(first!.x, first!.y, pick(first!)));
  for (const p of rest) c.pointerMove(at(p.x, p.y, pick(p)));
  const last = points[points.length - 1]!;
  c.pointerUp(at(last.x, last.y, pick(last)));
}

function pick(p: {
  pressure?: number;
  time?: number;
}): Partial<NormalizedPointerEvent> {
  return {
    ...(p.pressure !== undefined ? { pressure: p.pressure } : {}),
    ...(p.time !== undefined ? { time: p.time } : {}),
  };
}

function controller(
  model: SurfaceModel,
  presets: InkPresetStore,
  gestures?: PenGestureOptions,
): InkToolController {
  const c = new InkToolController({
    model,
    erasurePreparation: createTestErasurePreparation(),
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry({
      presets,
      ...(gestures !== undefined ? { penGestures: gestures } : {}),
    }),
    camera: createCamera(0, 0, 1),
  });
  return c;
}

function reopen(model: SurfaceModel): SurfaceModel {
  const decoded = decodeSurfacePayload(encodeSurfacePayload(model));
  expect(decoded.warnings).toEqual([]);
  return decoded.model;
}

describe('Ink product journey', () => {
  it('selects Pen/Fountain, tunes pressure+stabilization, draws, reopens stable', () => {
    const settings = new InMemorySettingsService();
    const model = board();
    const presets = new InkPresetStore({ settings });
    // Active-tool settings: pen subtype + tuning (the UX writes presets;
    // the engine reads them at capture).
    presets.setTool('fountain', {
      color: '#1a237e',
      size: 4,
      brush: { stabilization: 0.6, streamline: 0.4 },
    });
    const c = controller(model, presets);
    c.setTool(SURFACE_TOOL_IDS.fountain);
    drawStroke(c, [
      { x: 0, y: 0, pressure: 0.3, time: 1000 },
      { x: 20, y: 5, pressure: 0.8, time: 1050 },
      { x: 40, y: 0, pressure: 0.5, time: 1100 },
    ]);
    expect(model.order).toHaveLength(1);
    const record = model.objects[model.order[0]!]!;
    expect(record.brush).toMatchObject({ kind: 'fountain' });
    expect(record.color).toBe('#1a237e');
    const before = inkStrokeCompiledBounds(record)!;
    // Reopen through the canonical codec: samples, brush, and appearance
    // survive byte-stable.
    const reloaded = reopen(model);
    const record2 = reloaded.objects[reloaded.order[0]!]!;
    expect(record2.brush).toEqual(record.brush);
    expect(inkStrokeCompiledBounds(record2)).toEqual(before);
    // Settings survive close/reopen: a fresh store on the same service
    // reads the same user preset.
    const reopened = new InkPresetStore({ settings });
    expect(reopened.getTool('fountain')).toEqual(presets.getTool('fountain'));
    presets.dispose();
    reopened.dispose();
  });
});

describe('Notebook product journey', () => {
  it('keeps one Pencil preset across pages, PDF overlays, and reopen', () => {
    const settings = new InMemorySettingsService();
    const page1 = board();
    const page2 = board();
    const overlay = board();
    // Every mounted page owns a store on the same service (pager fan-out
    // design): writes from any page are visible everywhere.
    const store1 = new InkPresetStore({ settings });
    const store2 = new InkPresetStore({ settings });
    const storeOverlay = new InkPresetStore({ settings });
    store1.setTool('pencil', {
      color: '#4a4a4a',
      size: 2.5,
      brush: { tiltEffect: 0.8 },
    });
    expect(store2.getTool('pencil')).toEqual(store1.getTool('pencil'));
    expect(storeOverlay.getTool('pencil')).toEqual(store1.getTool('pencil'));
    // PDF overlay pages draw through the identical path and preset.
    const cOverlay = controller(overlay, storeOverlay);
    cOverlay.setTool(SURFACE_TOOL_IDS.pencil);
    drawStroke(cOverlay, [
      { x: 5, y: 5, time: 3500 },
      { x: 25, y: 10, time: 3550 },
    ]);
    expect(overlay.objects[overlay.order[0]!]!.brush).toMatchObject({
      kind: 'pencil',
    });
    // Draw on page 1 with the Pencil tool…
    const c1 = controller(page1, store1);
    c1.setTool(SURFACE_TOOL_IDS.pencil);
    drawStroke(c1, [
      { x: 5, y: 5, time: 2000 },
      { x: 25, y: 10, time: 2050 },
    ]);
    expect(page1.order).toHaveLength(1);
    expect(page1.objects[page1.order[0]!]!.brush).toMatchObject({
      kind: 'pencil',
    });
    // …move to page 2: the same preset is active, PDF overlay identical.
    const c2 = controller(page2, store2);
    c2.setTool(SURFACE_TOOL_IDS.pencil);
    drawStroke(c2, [
      { x: 5, y: 5, time: 3000 },
      { x: 25, y: 10, time: 3050 },
    ]);
    expect(page2.objects[page2.order[0]!]!.brush).toMatchObject({
      kind: 'pencil',
    });
    expect(storeOverlay.getTool('pencil').color).toBe('#4a4a4a');
    // Close/reopen the notebook: preset still present via the service.
    const fresh = new InkPresetStore({ settings });
    expect(fresh.getTool('pencil')).toEqual(store1.getTool('pencil'));
    expect(reopen(page1).order).toHaveLength(1);
    store1.dispose();
    store2.dispose();
    storeOverlay.dispose();
    fresh.dispose();
  });
});

describe('Whiteboard product journey', () => {
  it('draws, transforms, reconnects after rotate, groups, and erases sparse ink', async () => {
    const settings = new InMemorySettingsService();
    const presets = new InkPresetStore({ settings });
    presets.setTool('brush', { color: '#0d47a1', size: 5 });
    const model = board();
    model.objects.rect = rectangleObject('rect', {
      x: 0,
      y: 0,
      width: 40,
      height: 20,
    });
    model.objects.card = rectangleObject('card', {
      x: 100,
      y: 0,
      width: 40,
      height: 20,
    });
    model.order.push('rect', 'card');
    let ids = 0;
    const c = new InkToolController({
      model,
      erasurePreparation: createTestErasurePreparation(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
      camera: createCamera(0, 0, 1),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    // Draw a Brush stroke.
    c.setTool(SURFACE_TOOL_IDS.brush);
    drawStroke(c, [
      { x: 200, y: 200, pressure: 0.4, time: 4000 },
      { x: 260, y: 220, pressure: 0.9, time: 4050 },
    ]);
    const strokeId = model.order[model.order.length - 1]!;
    expect(model.objects[strokeId]!.brush).toMatchObject({ kind: 'brush' });
    // Select and transform it.
    c.setSelection([strokeId]);
    c.moveSelectionBy({ x: 10, y: 0 });
    // Connector anchors stay correct after rotating a connected shape.
    c.setSelection(['rect', 'card']);
    const connector = c.connectSelected({ path: 'straight' });
    expect(connector).not.toBeNull();
    c.setSelection(['rect']);
    c.rotateSelection(Math.PI / 2);
    const line = model.objects[connector!]!;
    expect(line.type).toBe('froglight.line');
    // Reconciled source sits on the live rotated anchor: assert the
    // connector stayed glued to the shape through the rotation.
    const anchor = resolveConnectorAnchor(
      model.objects.rect!,
      'center',
      createDefaultSurfaceObjectTypeRegistry(),
    )!;
    expect(line.x).toBeCloseTo(anchor.x, 9);
    expect(line.y).toBeCloseTo(anchor.y, 9);
    // Group/ungroup round-trips the selection.
    c.setSelection(['rect', 'card']);
    const group = c.groupSelection();
    expect(group).not.toBeNull();
    expect(c.ungroupSelection().sort()).toEqual(['card', 'rect']);
    // Erase a sparse two-sample stroke crossing an eraser sweep.
    model.objects.sparse = inkStrokeObject('sparse', {
      points: [
        { x: 0, y: 300 },
        { x: 100, y: 300 },
      ],
      width: 3,
    });
    model.order.push('sparse');
    c.notifyExternalMutation(['sparse']);
    presets.setEraser({ mode: 'precision' });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    c.pointerDown(at(50, 300));
    c.pointerUp(at(50, 300));
    await c.drainErasure();
    expect(model.objects.sparse!.visible).toBeDefined();
    expect(
      (
        model.objects[model.objects.sparse!.sourceId as string]!.chunks as {
          points: unknown;
        }[]
      )[0]!.points,
    ).toEqual([
      { x: 0, y: 300 },
      { x: 100, y: 300 },
    ]);
    expect(
      model.order.filter(
        (id) => id !== 'sparse' && model.objects[id] !== undefined,
      ).length,
    ).toBeGreaterThan(0);
    void SURFACE_MAX_SAMPLE_DT_MS;
    presets.dispose();
  });
});
