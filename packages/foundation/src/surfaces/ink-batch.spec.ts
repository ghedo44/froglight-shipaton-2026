/**
 * Ink input batching (writing-experience upgrade, slice 1): tools consume
 * one normalized batch per provider dispatch instead of one event per
 * sample. Confirmed samples commit; predicted samples stay ephemeral and
 * never enter canonical data. Fully headless.
 */

import { describe, expect, it } from 'vitest';
import { createCamera } from './geometry.js';
import {
  SURFACE_MAX_SAMPLE_DT_MS,
  infiniteFrame,
  type SurfaceModel,
} from './model.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import type { NormalizedPointerEvent } from './controller.js';
import {
  createDefaultSurfaceToolRegistry,
  extendStrokeBounds,
  InMemorySurfaceToolRegistry,
  InkToolController,
  SURFACE_TOOL_IDS,
  type SurfaceTool,
} from './tools.js';
import { InkPresetStore } from './ink/presets.js';
import { materializeLiveMeshRing } from './draw.js';

function board(): SurfaceModel {
  return { formatVersion: 1, frame: infiniteFrame(), order: [], objects: {} };
}

function at(
  x: number,
  y: number,
  extra: Partial<NormalizedPointerEvent> = {},
): NormalizedPointerEvent {
  return { point: { x, y }, ...extra };
}

function penController(
  model: SurfaceModel,
  registry = createDefaultSurfaceToolRegistry(),
): InkToolController {
  const c = new InkToolController({
    model,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: registry,
    camera: createCamera(0, 0, 1),
  });
  c.setTool(SURFACE_TOOL_IDS.pen);
  return c;
}

function committedPoints(model: SurfaceModel): unknown[] {
  const id = model.order[0];
  const record = id === undefined ? undefined : model.objects[id];
  return (record?.points as unknown[] | undefined) ?? [];
}

describe('batch dispatch', () => {
  it('delivers one move batch to the tool in a single onBatch call, in order', () => {
    const seen: NormalizedPointerEvent[][] = [];
    const tool: SurfaceTool = {
      toolId: 'acme.batch',
      onBatch: (_ctx, events) => {
        seen.push([...events]);
      },
    };
    const registry = new InMemorySurfaceToolRegistry();
    registry.register({ toolId: SURFACE_TOOL_IDS.select, version: 1 });
    registry.register(tool);
    const c = new InkToolController({
      model: board(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
    });
    c.setTool('acme.batch');
    const batch = [at(0, 0), at(5, 0), at(10, 0), at(15, 0), at(20, 0)];
    c.pointerDown(at(0, 0));
    c.pointerBatch(batch);
    c.pointerUp(at(20, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((e) => e.point)).toEqual(batch.map((e) => e.point));
  });

  it('falls back to per-event onMove for tools without onBatch', () => {
    const moves: NormalizedPointerEvent[] = [];
    const tool: SurfaceTool = {
      toolId: 'acme.legacy',
      onMove: (_ctx, event) => {
        moves.push(event);
      },
    };
    const registry = new InMemorySurfaceToolRegistry();
    registry.register({ toolId: SURFACE_TOOL_IDS.select, version: 1 });
    registry.register(tool);
    const c = new InkToolController({
      model: board(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
    });
    c.setTool('acme.legacy');
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(1, 1), at(2, 2), at(3, 3)]);
    c.pointerUp(at(3, 3));
    expect(moves.map((e) => e.point)).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it('appends a whole pen batch and publishes one preview with full bounds', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0), at(10, 20)]);
    const preview = c.previewItems();
    expect(preview).toHaveLength(1);
    expect(preview[0]!.kind).toBe('stroke');
    if (preview[0]!.kind === 'stroke') {
      expect(preview[0]!.points).toHaveLength(3);
      // Preview bounds are the authoritative live-compiled outline bounds:
      // they agree exactly with the published outline (rendered pixels ⊆
      // bounds). Raw samples may sit marginally outside: stabilization
      // legitimately lags the newest sample, exactly as the committed
      // full compile does.
      const bounds = preview[0]!.bounds;
      // Chunk publish: no materialized ring on the hot path — the mesh
      // view materializes to the same ring the old path published.
      const mesh = preview[0]!.liveMesh;
      expect(mesh?.spineLength).toBeGreaterThan(0);
      expect(preview[0]!.outline).toHaveLength(0);
      const outline = materializeLiveMeshRing(mesh!);
      expect(outline.length).toBeGreaterThanOrEqual(8);
      for (const p of outline) {
        expect(p.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
        expect(p.x).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
        expect(p.y).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-9);
      }
      // Approximate coverage of the 0..10 × 0..20 path (within the
      // stabilization lag allowance of a few surface units).
      expect(bounds.x).toBeLessThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(9);
      expect(bounds.y).toBeLessThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(19);
    }
    c.pointerUp(at(10, 20));
    expect(committedPoints(model)).toHaveLength(3);
    expect(c.previewItems()).toEqual([]);
  });

  it('grows preview bounds incrementally across batches', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    const first = c.previewItems()[0];
    expect(first!.bounds.width).toBeGreaterThan(9);
    c.pointerBatch([at(10, 0), at(10, 20)]);
    const second = c.previewItems()[0];
    // The repeated (10,0) is a duplicate join, not a new sample.
    // Growth is monotone: the second envelope contains the first.
    expect(second!.bounds.width).toBeGreaterThanOrEqual(
      first!.bounds.width - 1e-9,
    );
    expect(second!.bounds.height).toBeGreaterThan(first!.bounds.height);
    c.pointerUp(at(10, 20));
    expect(committedPoints(model)).toHaveLength(3);
  });

  it('carries chunk geometry on live previews (outline on predicted tails)', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0), at(10, 20)]);
    const preview = c.previewItems();
    expect(preview).toHaveLength(1);
    expect(preview[0]!.kind).toBe('stroke');
    if (preview[0]!.kind === 'stroke') {
      // Live publishes mesh chunks, never a materialized ring; the chunks
      // materialize to a filled ring for the renderer.
      expect(preview[0]!.outline).toHaveLength(0);
      expect(preview[0]!.liveMesh?.spineLength).toBeGreaterThan(0);
      expect(
        materializeLiveMeshRing(preview[0]!.liveMesh!).length,
      ).toBeGreaterThanOrEqual(8);
      expect(preview[0]!.points).toHaveLength(3);
    }
    c.pointerPredicted([at(20, 20), at(30, 20)]);
    const tail = c.previewItems()[1]!;
    expect(tail.kind).toBe('stroke');
    if (tail.kind === 'stroke') {
      expect(tail.outline!.length).toBeGreaterThanOrEqual(8);
    }
    c.pointerUp(at(10, 20));
  });

  it('keeps one batch gesture inside one history transaction', () => {
    const model = board();
    let starts = 0;
    let ends = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      onGestureStart: () => {
        starts += 1;
      },
      onGestureEnd: () => {
        ends += 1;
      },
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(5, 0), at(10, 0)]);
    c.pointerBatch([at(15, 0)]);
    c.pointerUp(at(15, 0));
    expect(starts).toBe(1);
    expect(ends).toBe(1);
    expect(committedPoints(model)).toHaveLength(4);
  });
});

describe('preview publish coalescing', () => {
  function publishingController() {
    let publishes = 0;
    const c = new InkToolController({
      model: board(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      onPreviewPublish: () => {
        publishes += 1;
      },
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    return { c, publishes: () => publishes };
  }

  it('publishes once per batch with new samples, never for duplicate-only batches', () => {
    const { c, publishes } = publishingController();
    c.pointerDown(at(0, 0));
    const baseline = publishes();
    c.pointerBatch([at(10, 0), at(20, 0)]);
    expect(publishes()).toBe(baseline + 1);
    // Repeat joins carry no new information: no recompile, no republish.
    c.pointerBatch([at(20, 0)]);
    expect(publishes()).toBe(baseline + 1);
    c.pointerBatch([at(20, 0), at(30, 0)]);
    expect(publishes()).toBe(baseline + 2);
    c.pointerUp(at(30, 0));
  });

  it('ignores live style changes on the active stroke', () => {
    // One stroke, one style: mid-gesture toolbar edits apply to the next
    // stroke, never to the active one.
    const liveStyle = { color: '#111111', width: 3 };
    const registry = createDefaultSurfaceToolRegistry({
      penStyle: liveStyle,
    });
    let publishCount = 0;
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
      onPreviewPublish: () => {
        publishCount += 1;
      },
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    const baseline = publishCount;
    liveStyle.color = '#ff0000';
    liveStyle.width = 9;
    c.pointerBatch([at(10, 0)]);
    // No new samples and no snapshot change: no republish.
    expect(publishCount).toBe(baseline);
    const preview = c.previewItems()[0]!;
    expect(preview.kind).toBe('stroke');
    if (preview.kind === 'stroke') {
      expect(preview.color).toBe('#111111');
      expect(preview.width).toBe(3);
    }
    c.pointerUp(at(10, 0));
    // The commit stores the pointer-down snapshot, not the later edit.
    const record = model.objects[model.order[model.order.length - 1]!]!;
    expect(record.color).toBe('#111111');
    expect(record.width).toBe(3);
  });

  it('ignores brush tuning changes on the active stroke', () => {
    const model = board();
    const presets = new InkPresetStore();
    let publishCount = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
      onPreviewPublish: () => {
        publishCount += 1;
      },
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    const before = c.previewItems()[0]!;
    const baseline = publishCount;
    // Same duplicate batch, but the nib tuning changed underneath: the
    // active stroke must not retune (no rebuild, no republish).
    presets.setTool('pen', { brush: { stabilization: 0.9 } });
    c.pointerBatch([at(10, 0)]);
    expect(publishCount).toBe(baseline);
    expect(c.previewItems()[0]).toEqual(before);
    c.pointerUp(at(10, 0));
    // Tuning edits land on the NEXT stroke instead.
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    c.pointerUp(at(10, 0));
    const record = model.objects[model.order[model.order.length - 1]!]!;
    expect(record.brush).toMatchObject({ stabilization: 0.9 });
  });
});

describe('tool presets and brush commits', () => {
  function presetController() {
    const model = board();
    const presets = new InkPresetStore();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    });
    return { model, presets, c };
  }

  function committedBrush(model: SurfaceModel): unknown {
    const id = model.order[model.order.length - 1];
    const record = id === undefined ? undefined : model.objects[id];
    return record?.brush;
  }

  it('stores the tool kind on every commit, starting with ball', () => {
    const { model, c } = presetController();
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    c.pointerUp(at(10, 0));
    expect(committedBrush(model)).toEqual({ kind: 'ball' });
    c.setTool(SURFACE_TOOL_IDS.fountain);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    c.pointerUp(at(10, 0));
    expect(committedBrush(model)).toEqual({ kind: 'fountain' });
  });

  it('keeps pen and highlighter colors independent across switches', () => {
    const { model, presets, c } = presetController();
    presets.setTool('pen', { color: '#ff0000' });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(0, 0));
    c.pointerUp(at(0, 0));
    c.setTool(SURFACE_TOOL_IDS.highlighter);
    c.pointerDown(at(20, 0));
    c.pointerUp(at(20, 0));
    const colors = model.order.map((id) => model.objects[id]!.color);
    // Highlighter ignores the pen color; pen red survives the switch.
    expect(colors[1]).not.toBe('#ff0000');
    expect(presets.getTool('pen').color).toBe('#ff0000');
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(40, 0));
    c.pointerUp(at(40, 0));
    expect(model.objects[model.order[2]!]!.color).toBe('#ff0000');
  });

  it('freezes committed strokes against later preset edits', () => {
    const { model, presets, c } = presetController();
    presets.setTool('pen', { color: '#111111', size: 2 });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    c.pointerUp(at(10, 0));
    presets.setTool('pen', { color: '#222222', size: 8 });
    const record = model.objects[model.order[0]!]!;
    expect(record.color).toBe('#111111');
    expect(record.width).toBe(2);
  });
});

describe('predicted samples', () => {
  it('never enter the canonical stroke but extend the live preview tail', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    c.pointerPredicted([at(20, 0), at(30, 0)]);
    const preview = c.previewItems();
    expect(preview).toHaveLength(2);
    if (preview[1]!.kind === 'stroke') {
      // The tail blends from the last confirmed sample into the prediction.
      expect(preview[1]!.points.map((p) => ({ x: p.x, y: p.y }))).toEqual([
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 },
      ]);
    } else {
      expect.unreachable('predicted tail must be a stroke preview item');
    }
    c.pointerUp(at(10, 0));
    // Only confirmed samples commit; the prediction vanishes with the gesture.
    expect(committedPoints(model)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(c.previewItems()).toEqual([]);
  });

  it('withdraws a prediction by restoring the exact confirmed preview', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(10, 0)]);
    const confirmed = c.previewItems();
    c.pointerPredicted([at(20, 0), at(30, 5)]);
    expect(c.previewItems()).toHaveLength(2);
    c.pointerPredicted([]);
    expect(c.previewItems()).toEqual(confirmed);
    expect(model.order).toEqual([]);
    c.pointerUp(at(10, 0));
    expect(committedPoints(model)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    c.destroy();
  });

  it('carries hardware axes on the predicted tail without committing them', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0, { time: 1000, pressure: 0.5 }));
    c.pointerBatch([at(10, 0, { time: 1016, pressure: 0.5 })]);
    c.pointerPredicted([
      at(20, 0, { time: 1024, pressure: 0.45, tilt: { x: 0.1, y: 0 } }),
    ]);
    const tail = c.previewItems()[1]!;
    expect(tail.kind).toBe('stroke');
    if (tail.kind === 'stroke') {
      expect(tail.points[tail.points.length - 1]).toMatchObject({
        x: 20,
        y: 0,
        pressure: 0.45,
        tilt: { x: 0.1, y: 0 },
      });
    }
    c.pointerUp(at(10, 0, { time: 1032, pressure: 0.5 }));
    // Canonical samples carry no trace of the prediction.
    expect(committedPoints(model)).toEqual([
      { x: 0, y: 0, dt: 0, pressure: 0.5 },
      { x: 10, y: 0, dt: 16, pressure: 0.5 },
    ]);
  });

  it('is a safe no-op without an active gesture or without tool support', () => {
    const model = board();
    const c = penController(model);
    expect(() => c.pointerPredicted([at(5, 5)])).not.toThrow();
    expect(c.previewItems()).toEqual([]);
    expect(model.order).toEqual([]);

    const seen: unknown[] = [];
    const tool: SurfaceTool = {
      toolId: 'acme.plain',
      onPredicted: (_ctx, events) => {
        seen.push(events.length);
      },
    };
    const registry = new InMemorySurfaceToolRegistry();
    registry.register({ toolId: SURFACE_TOOL_IDS.select, version: 1 });
    registry.register(tool);
    const c2 = new InkToolController({
      model: board(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
    });
    c2.setTool('acme.plain');
    // Select-tool routing never reaches tool hooks either.
    const c3 = new InkToolController({
      model: board(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
    });
    expect(() => c3.pointerPredicted([at(1, 1)])).not.toThrow();
    expect(seen).toEqual([]);
  });

  it('keeps predicted samples out of mutations, history, and dirty state', () => {
    const model = board();
    let mutates = 0;
    let starts = 0;
    let ends = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      onMutate: () => {
        mutates += 1;
      },
      onGestureStart: () => {
        starts += 1;
      },
      onGestureEnd: () => {
        ends += 1;
      },
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown(at(0, 0));
    expect([starts, ends, mutates]).toEqual([1, 0, 0]);
    // Predictions update the ephemeral tail only: no history edges,
    // no mutations (the surface dirty flag rides onMutate).
    c.pointerPredicted([at(20, 0)]);
    c.pointerPredicted([at(20, 0), at(30, 0)]);
    expect([starts, ends, mutates]).toEqual([1, 0, 0]);
    c.pointerBatch([at(10, 0)]);
    expect([starts, ends, mutates]).toEqual([1, 0, 0]);
    c.pointerUp(at(10, 0));
    // One gesture, one commit.
    expect([starts, ends, mutates]).toEqual([1, 1, 1]);
  });
});

describe('sample timing', () => {
  it('stamps dt relative to the gesture start', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0, { time: 1000 }));
    c.pointerBatch([at(5, 0, { time: 1016 }), at(10, 0, { time: 1032 })]);
    c.pointerUp(at(10, 0, { time: 1040 }));
    expect(committedPoints(model)).toEqual([
      { x: 0, y: 0, dt: 0 },
      { x: 5, y: 0, dt: 16 },
      { x: 10, y: 0, dt: 32 },
    ]);
  });

  it('omits dt when the provider supplies no timing', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0));
    c.pointerBatch([at(5, 0)]);
    c.pointerUp(at(5, 0));
    expect(committedPoints(model)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ]);
  });

  it('keeps committed dt non-decreasing when the provider clock jumps back', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0, { time: 1000 }));
    c.pointerBatch([at(5, 0, { time: 5000 }), at(10, 0, { time: 2000 })]);
    c.pointerUp(at(10, 0, { time: 6000 }));
    expect(committedPoints(model)).toEqual([
      { x: 0, y: 0, dt: 0 },
      { x: 5, y: 0, dt: 4000 },
      { x: 10, y: 0, dt: 4000 },
    ]);
  });

  it('clamps runaway dt into the canonical bound instead of failing validation', () => {
    const model = board();
    const c = penController(model);
    c.pointerDown(at(0, 0, { time: 0 }));
    c.pointerBatch([at(5, 0, { time: SURFACE_MAX_SAMPLE_DT_MS + 5000 })]);
    c.pointerUp(at(5, 0, { time: SURFACE_MAX_SAMPLE_DT_MS + 5000 }));
    const points = committedPoints(model) as Array<{ dt?: number }>;
    expect(points[1]!.dt).toBe(SURFACE_MAX_SAMPLE_DT_MS);
  });
});

describe('extendStrokeBounds', () => {
  it('starts from null and pads by half the stroke width', () => {
    const first = extendStrokeBounds(null, { x: 4, y: 6 }, 1.5);
    expect(first).toEqual({ minX: 2.5, minY: 4.5, maxX: 5.5, maxY: 7.5 });
    const grown = extendStrokeBounds(first, { x: 10, y: 6 }, 1.5);
    expect(grown).toEqual({ minX: 2.5, minY: 4.5, maxX: 11.5, maxY: 7.5 });
  });
});
