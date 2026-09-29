import { createTestErasurePreparation } from '../testing/erasure-preparation.js';
/**
 * Ink tools: the host-free tool/input layer.
 * Normalized pointer events — optionally carrying pressure/tilt/twist —
 * flow through a tool registry into committed surface-model mutations
 * and ephemeral preview draw items. Selection/camera gestures delegate
 * to the shared interaction controller. Fully headless.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { FroglightError } from '../errors.js';
import { utf8Decode } from '../encoding.js';
import { createCamera, rotateAround } from './geometry.js';
import {
  groupObject,
  infiniteFrame,
  inkStrokeObject,
  imageObject,
  lineObject,
  rectangleObject,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from './model.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  inkStrokeContoursOfRecord,
  groupMembersOf,
  groupOfMember,
  resolveGroupMembers,
} from './objects.js';
import { resolveConnectorAnchor } from './ink/connectors.js';
import { surfaceToolRegistryToken } from '../tokens.js';
import { decodeSurfacePayload, encodeSurfacePayload } from './codec.js';
import { InkPresetStore, type EraserPreset } from './ink/presets.js';
import { hitVisible } from './ink/erasure.js';
import type { EraserFilter } from './ink/eraser-geometry.js';
import {
  createDefaultSurfaceToolRegistry,
  InMemorySurfaceToolRegistry,
  InkToolController,
  SURFACE_TOOL_IDS,
} from './tools.js';

function board(): SurfaceModel {
  return {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['r1'],
    objects: {
      r1: rectangleObject('r1', { x: 0, y: 0, width: 20, height: 20 }),
    },
  };
}

describe('tool registry', () => {
  it('registers, lists, and disposes tools like every effect-owned registry', () => {
    const registry = new InMemorySurfaceToolRegistry();
    const disposer = registry.register({ toolId: 'acme.brush' });
    expect(registry.get('acme.brush')?.toolId).toBe('acme.brush');
    disposer.dispose();
    expect(registry.get('acme.brush')).toBeNull();
  });

  it('rejects non-namespaced ids and duplicate registrations', () => {
    const registry = new InMemorySurfaceToolRegistry();
    try {
      registry.register({ toolId: 'not-namespaced' });
      expect.unreachable('expected INVALID_SURFACE_TOOL_ID');
    } catch (error) {
      expect((error as FroglightError).code).toBe('INVALID_SURFACE_TOOL_ID');
    }
    registry.register({ toolId: 'acme.brush' });
    try {
      registry.register({ toolId: 'acme.brush' });
      expect.unreachable('expected DUPLICATE_SURFACE_TOOL');
    } catch (error) {
      expect((error as FroglightError).code).toBe('DUPLICATE_SURFACE_TOOL');
    }
  });

  it('ships the v1 core tool set under froglight.* ids', () => {
    const registry = createDefaultSurfaceToolRegistry();
    expect(
      registry
        .list()
        .map((t) => t.toolId)
        .sort(),
    ).toEqual(
      [
        SURFACE_TOOL_IDS.select,
        SURFACE_TOOL_IDS.pen,
        SURFACE_TOOL_IDS.fountain,
        SURFACE_TOOL_IDS.brush,
        SURFACE_TOOL_IDS.pencil,
        SURFACE_TOOL_IDS.highlighter,
        SURFACE_TOOL_IDS.eraser,
        SURFACE_TOOL_IDS.lasso,
      ].sort(),
    );
  });
});

describe('tool routing', () => {
  it('starts on the select tool and switches tools explicitly', () => {
    const c = new InkToolController({
      model: board(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.select);
    c.setTool(SURFACE_TOOL_IDS.pen);
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
    try {
      c.setTool('acme.missing');
      expect.unreachable('expected UNKNOWN_SURFACE_TOOL');
    } catch (error) {
      expect((error as FroglightError).code).toBe('UNKNOWN_SURFACE_TOOL');
    }
  });

  it('delegates select gestures and camera to the shared interaction semantics', () => {
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      camera: createCamera(0, 0, 2),
    });
    // Camera zoom 2: view point (40,40) is surface (20,20) — the corner
    // of r1 proves events are mapped through the live camera.
    c.pointerDown({ point: { x: 40, y: 40 } });
    expect(c.selection()).toEqual(['r1']);
    c.wheel({ point: { x: 100, y: 100 }, factor: 2 });
    expect(c.camera().zoom).toBe(4);
  });

  it('keeps selection ephemeral through tool gestures', () => {
    const model = board();
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.pointerDown({ point: { x: 8, y: 8 } });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown({ point: { x: 50, y: 50 } });
    c.pointerUp({ point: { x: 60, y: 60 } });
    expect(JSON.parse(JSON.stringify(model)).objects.r1).toEqual(
      board().objects.r1,
    );
    expect(Object.keys(model.objects)).toHaveLength(2);
  });

  it('fires gesture end on pointer-up and gesture cancel on pointer-cancel', () => {
    const model = board();
    let starts = 0;
    let ends = 0;
    let cancels = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      onGestureStart: () => (starts += 1),
      onGestureEnd: () => (ends += 1),
      onGestureCancel: () => (cancels += 1),
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerUp({ point: { x: 10, y: 10 } });
    expect([starts, ends, cancels]).toEqual([1, 1, 0]);
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerCancel();
    expect([starts, ends, cancels]).toEqual([2, 1, 1]);
  });
});

describe('pen capture', () => {
  function pen() {
    const model = board();
    const mutated: string[][] = [];
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      camera: createCamera(0, 0, 2),
      onMutate: (ids) => mutated.push([...ids]),
      idFactory: (() => {
        let n = 0;
        return () => `gen-${++n}`;
      })(),
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    return { model, mutated, c };
  }

  it('commits one stroke object on pointer-up, mapped through the camera', () => {
    const { model, mutated, c } = pen();
    c.pointerDown({ point: { x: 10, y: 10 } });
    c.pointerMove({ point: { x: 30, y: 30 } });
    c.pointerMove({ point: { x: 50, y: 40 } });
    c.pointerUp({ point: { x: 70, y: 60 } });
    // View points map to surface /2: (5,5),(15,15),(25,20),(35,30).
    const committed = model.objects['gen-1']!;
    expect(committed.type).toBe('froglight.ink.stroke');
    expect(committed.points).toEqual([
      { x: 5, y: 5 },
      { x: 15, y: 15 },
      { x: 25, y: 20 },
      { x: 35, y: 30 },
    ]);
    expect(mutated).toEqual([['gen-1']]);
    expect(model.order).toEqual(['r1', 'gen-1']);
  });

  it('records pressure verbatim when hardware supplies it and omits it otherwise', () => {
    const { model, c } = pen();
    c.pointerDown({ point: { x: 0, y: 0 }, pressure: 0.25 });
    c.pointerMove({
      point: { x: 10, y: 0 },
      pressure: 0.9,
      tilt: { x: 0.2, y: 0 },
      twist: -1,
    });
    c.pointerUp({ point: { x: 20, y: 0 } });
    const points = model.objects['gen-1']!.points as Array<
      Record<string, unknown>
    >;
    expect(points[0]).toEqual({ x: 0, y: 0, pressure: 0.25 });
    expect(points[1]).toEqual({
      x: 5,
      y: 0,
      pressure: 0.9,
      tilt: { x: 0.2, y: 0 },
      twist: -1,
    });
    expect(points[2]).toEqual({ x: 10, y: 0 });
  });

  it('shows an in-progress preview that never enters canonical data until commit', () => {
    const { model, c } = pen();
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerMove({ point: { x: 8, y: 8 } });
    const preview = c.previewItems();
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({
      kind: 'stroke',
      objectId: 'gen-1',
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 4 },
      ],
    });
    // Nothing canonical yet.
    expect(model.order).toEqual(['r1']);
    c.pointerUp({ point: { x: 16, y: 16 } });
    expect(model.order).toEqual(['r1', 'gen-1']);
    expect(c.previewItems()).toEqual([]);
  });

  it('commits single taps as one-sample dot strokes', () => {
    const { model, c } = pen();
    c.pointerDown({ point: { x: 4, y: 4 } });
    c.pointerUp({ point: { x: 4, y: 4 } });
    const points = model.objects['gen-1']!.points as unknown[];
    expect(points).toEqual([{ x: 2, y: 2 }]);
  });

  it('pointercancel discards the capture gesture and commits nothing', () => {
    const { model, c } = pen();
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerMove({ point: { x: 10, y: 0 } });
    expect(c.previewItems()).toHaveLength(1);
    c.pointerCancel();
    expect(model.order).toEqual(['r1']);
    expect(model.objects['gen-1']).toBeUndefined();
    expect(c.previewItems()).toEqual([]);
    // Next gesture works normally.
    c.pointerDown({ point: { x: 20, y: 0 } });
    c.pointerUp({ point: { x: 30, y: 0 } });
    expect(model.order).toContain('gen-2');
  });

  it('writes the highlighter preset as ordinary style members', () => {
    const { model, c } = pen();
    c.setTool(SURFACE_TOOL_IDS.highlighter);
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerUp({ point: { x: 40, y: 0 } });
    const stroke = model.objects['gen-1']!;
    expect(stroke.width).toBeGreaterThan(3);
    expect(stroke.opacity).toBeLessThan(1);
    expect(typeof stroke.color).toBe('string');
  });

  it('paints highlighter strokes in the live pen color while keeping its wide translucent preset', () => {
    const model = board();
    const penStyle = { color: '#7c6cf0', width: 2 };
    const registry = createDefaultSurfaceToolRegistry({ penStyle });
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
      idFactory: (() => {
        let n = 0;
        return () => `gen-${++n}`;
      })(),
    });
    c.setTool(SURFACE_TOOL_IDS.highlighter);
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerUp({ point: { x: 40, y: 0 } });
    const stroke = model.objects['gen-1']!;
    expect(stroke.color).toBe('#7c6cf0');
    expect(stroke.width).toBe(14);
    expect(stroke.opacity).toBeCloseTo(0.35, 5);
  });
});

describe('pen gestures', () => {
  function gestureBoard(gestures?: {
    shape?: boolean;
    scribble?: boolean;
    circle?: boolean;
  }) {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: [],
      objects: {},
    };
    const starts: string[][] = [];
    const ends: string[][] = [];
    let ids = 0;
    const registry = createDefaultSurfaceToolRegistry({
      ...(gestures !== undefined ? { penGestures: gestures } : {}),
    });
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
      idFactory: () => `gen-${(ids += 1)}`,
      onGestureStart: () => starts.push([...model.order]),
      onGestureEnd: () => ends.push([...model.order]),
    });
    c.setTool(SURFACE_TOOL_IDS.pen);
    return { model, c, starts, ends };
  }

  function drawPath(
    c: InkToolController,
    points: Array<{ x: number; y: number }>,
  ): void {
    const [first, ...rest] = points as [
      { x: number; y: number },
      ...Array<{ x: number; y: number }>,
    ];
    c.pointerDown({ point: first });
    for (const point of rest) c.pointerMove({ point });
    c.pointerUp({ point: rest[rest.length - 1]! });
  }

  function rectPath(): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    const edge = (x1: number, y1: number, x2: number, y2: number) => {
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        out.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
      }
    };
    edge(0, 0, 40, 0);
    edge(40, 0, 40, 30);
    edge(40, 30, 0, 30);
    edge(0, 30, 0, 0);
    return out;
  }

  it('converts a held rectangle into one shape record', () => {
    const { model, c, starts, ends } = gestureBoard({ shape: true });
    c.pointerDown({ point: { x: 0, y: 0 } });
    for (const point of rectPath().slice(1)) c.pointerMove({ point });
    c.gestureHold();
    // Arming swaps the live preview to the recognized shape.
    const preview = c.previewItems();
    expect(preview).toHaveLength(1);
    expect(preview[0]!.kind).toBe('rect');
    c.pointerUp({ point: { x: 0, y: 0 } });
    expect(model.order).toEqual(['gen-1']);
    expect(model.objects['gen-1']).toMatchObject({
      type: 'froglight.rectangle',
      x: 0,
      y: 0,
      width: 40,
      height: 30,
    });
    // The armed shape preview unmounts with the conversion.
    expect(c.previewItems()).toEqual([]);
    // One gesture, one committed record, one history transaction.
    expect([starts.length, ends.length]).toEqual([1, 1]);
  });

  it('disarms when drawing continues after the hold', () => {
    const { model, c } = gestureBoard({ shape: true });
    c.pointerDown({ point: { x: 0, y: 0 } });
    for (const point of rectPath().slice(1)) c.pointerMove({ point });
    c.gestureHold();
    // Keep drawing past the hold: back to ordinary ink.
    c.pointerMove({ point: { x: 200, y: 200 } });
    c.pointerUp({ point: { x: 200, y: 200 } });
    expect(model.objects['gen-1']!.type).toBe('froglight.ink.stroke');
  });

  it('tolerates lift jitter without disarming the conversion', () => {
    const { model, c } = gestureBoard({ shape: true });
    c.pointerDown({ point: { x: 0, y: 0 } });
    for (const point of rectPath().slice(1)) c.pointerMove({ point });
    c.gestureHold();
    // The lifting pen wobbles a unit inside the armed bbox: still a shape.
    c.pointerUp({ point: { x: 1, y: 1 } });
    expect(model.objects['gen-1']!.type).toBe('froglight.rectangle');
  });

  it('erases scribbled-over strokes without committing the scribble', () => {
    const { model, c } = gestureBoard({ scribble: true });
    // An existing stroke to erase.
    drawPath(c, [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
    ]);
    expect(model.order).toEqual(['gen-1']);
    // A dense zigzag over it, no hold fired.
    c.pointerDown({ point: { x: 0, y: -4 } });
    for (let i = 1; i < 21; i++) {
      c.pointerMove({ point: { x: i * 3, y: i % 2 === 0 ? -4 : 4 } });
    }
    c.pointerUp({ point: { x: 60, y: -4 } });
    expect(model.order).toEqual([]);
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
  });

  it('converts a held circle into a selection without committing ink', () => {
    const { model, c } = gestureBoard({ circle: true });
    drawPath(c, [
      { x: 25, y: 30 },
      { x: 35, y: 30 },
    ]);
    expect(model.order).toEqual(['gen-1']);
    // A closed loop around the stroke, then hold, then lift.
    c.pointerDown({ point: { x: 45, y: 30 } });
    const loop: Array<{ x: number; y: number }> = [];
    for (let i = 1; i < 20; i++) {
      const a = (i / 19) * Math.PI * 2;
      loop.push({ x: 30 + Math.cos(a) * 15, y: 30 + Math.sin(a) * 15 });
    }
    for (const point of loop) c.pointerMove({ point });
    c.gestureHold();
    c.pointerUp({ point: { x: 45, y: 30 } });
    expect(model.order).toEqual(['gen-1']);
    expect(c.selection()).toEqual(['gen-1']);
    expect(c.previewItems()).toEqual([]);
  });

  it('leaves gestures disabled by default', () => {
    const { model, c } = gestureBoard();
    c.pointerDown({ point: { x: 0, y: 0 } });
    for (const point of rectPath().slice(1)) c.pointerMove({ point });
    c.gestureHold();
    c.pointerUp({ point: { x: 0, y: 0 } });
    expect(model.objects['gen-1']!.type).toBe('froglight.ink.stroke');
  });
});

describe('eraser', () => {
  function inkBoard() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['far', 'near'],
      objects: {
        far: inkStrokeObject('far', {
          points: [
            { x: 100, y: 0 },
            { x: 200, y: 0 },
          ],
          width: 4,
        }),
        near: inkStrokeObject('near', {
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
          ],
          width: 4,
        }),
      },
    };
    const mutated: string[][] = [];
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      onMutate: (ids) => mutated.push([...ids]),
    });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    return { model, mutated, c };
  }

  it('removes whole strokes under the eraser disc and reports them once per event', () => {
    const { model, mutated, c } = inkBoard();
    c.pointerDown({ point: { x: 25, y: 1 } }); // default radius 10 view units
    expect(model.objects.near).toBeUndefined();
    expect(model.objects.far).toBeDefined();
    expect(model.order).toEqual(['far']);
    expect(mutated).toEqual([['near']]);
    // Dragging the eraser along removes the next stroke too.
    c.pointerMove({ point: { x: 150, y: 0 } });
    expect(model.order).toEqual([]);
    expect(mutated).toEqual([['near'], ['far']]);
    c.pointerUp({ point: { x: 150, y: 0 } });
    expect(mutated).toHaveLength(2);
  });

  it('scales the eraser radius through the camera zoom', () => {
    const { model, c } = inkBoard();
    c.wheel({ point: { x: 0, y: 0 }, factor: 10 });
    // Zoom 10 → surface radius is 1 unit; nearest stroke surface point
    // sits 6 units away (view 60,60 → surface 6,6), beyond 1 + halfWidth.
    c.pointerDown({ point: { x: 60, y: 60 } });
    expect(model.order).toEqual(['far', 'near']);
  });

  it('erases non-stroke objects only on a direct registered hit', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['r1', 's1'],
      objects: {
        r1: rectangleObject('r1', { x: 0, y: 0, width: 20, height: 20 }),
        s1: inkStrokeObject('s1', {
          points: [
            { x: 40, y: 40 },
            { x: 60, y: 40 },
          ],
        }),
      },
    };
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    // Outside the rectangle (direct-hit rule keeps it) but within the
    // disc radius of the stroke's polyline.
    c.pointerDown({ point: { x: 32, y: 36 } });
    expect(model.objects.r1).toBeDefined();
    expect(model.objects.s1).toBeUndefined();
  });
});

describe('temporary tool stack', () => {
  function stacked() {
    const changes: string[] = [];
    const c = new InkToolController({
      model: {
        formatVersion: 1,
        frame: infiniteFrame(),
        order: [],
        objects: {},
      },
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      onActiveToolChange: (toolId) => changes.push(toolId),
    });
    return { c, changes };
  }

  it('enters and exits a temporary tool, restoring the previous one', () => {
    const { c, changes } = stacked();
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.eraser);
    expect(c.exitTemporaryTool()).toBe(true);
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
    expect(changes).toEqual([
      SURFACE_TOOL_IDS.pen,
      SURFACE_TOOL_IDS.eraser,
      SURFACE_TOOL_IDS.pen,
    ]);
  });

  it('nests temporary tools and reports an empty exit as false', () => {
    const { c } = stacked();
    c.setTool(SURFACE_TOOL_IDS.pen);
    expect(c.exitTemporaryTool()).toBe(false);
    c.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    c.enterTemporaryTool(SURFACE_TOOL_IDS.lasso);
    expect(c.exitTemporaryTool()).toBe(true);
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.eraser);
    expect(c.exitTemporaryTool()).toBe(true);
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
  });

  it('clears the stack on explicit setTool and rejects unknown tools', () => {
    const { c } = stacked();
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    c.setTool(SURFACE_TOOL_IDS.lasso);
    expect(c.exitTemporaryTool()).toBe(false);
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.lasso);
    expect(() => c.enterTemporaryTool('acme.missing')).toThrow();
  });
});

describe('stroke and precision erasing', () => {
  function eraserBoard(preset: Partial<EraserPreset>) {
    const points = [];
    for (let x = 0; x <= 100; x += 10) points.push({ x, y: 0, pressure: 0.5 });
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: {
          ...inkStrokeObject('s', {
            points,
            width: 4,
            color: '#111111',
            brush: { kind: 'fountain' },
          }),
          vendorNote: 'keep',
        },
      },
    };
    const presets = new InkPresetStore();
    presets.setEraser(preset);
    let ids = 0;
    const starts: number[] = [];
    const ends: number[] = [];
    const c = new InkToolController({
      model,
      erasurePreparation: createTestErasurePreparation(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
      idFactory: () => `gen-${(ids += 1)}`,
      onGestureStart: () => starts.push(1),
      onGestureEnd: () => ends.push(1),
    });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    return { model, presets, c, starts, ends };
  }

  function styles(model: SurfaceModel) {
    return model.order.map((id) => {
      const record = model.objects[id]!;
      return {
        color: record.color,
        width: record.width,
        brush: record.brush,
      };
    });
  }

  it('ignores the Precision size preset while erasing whole strokes', () => {
    const { model, presets, c } = eraserBoard({ mode: 'stroke', radius: 40 });
    c.pointerDown({ point: { x: 50, y: 30 } });
    c.pointerUp({ point: { x: 50, y: 30 } });
    expect(model.order).toEqual(['s']);
    presets.setEraser({ radius: 2 });
    c.pointerDown({ point: { x: 50, y: 0 } });
    c.pointerUp({ point: { x: 50, y: 0 } });
    expect(model.order).toEqual([]);
  });

  it('cuts a stroke at its paint index while retaining its source and style', async () => {
    const { model, c, starts, ends } = eraserBoard({ mode: 'precision' });
    const source = model.objects.s!.points;
    c.pointerDown({ point: { x: 50, y: 0 } });
    c.pointerUp({ point: { x: 50, y: 0 } });
    await c.drainErasure();
    expect(model.order).toHaveLength(2);
    expect(model.order[0]).toBe('s');
    expect(
      (
        model.objects[model.objects.s!.sourceId as string]!
          .chunks as SurfaceObjectRecord[]
      )[0]!.points,
    ).toEqual(source);
    expect(styles(model)).toEqual(
      Array.from({ length: 2 }, () => ({
        color: '#111111',
        width: 4,
        brush: { kind: 'fountain' },
      })),
    );
    expect(model.objects.s!.vendorNote).toBe('keep');
    const contours = model.order.flatMap((id) =>
      inkStrokeContoursOfRecord(model.objects[id]!),
    );
    expect(hitVisible(contours, { x: 50, y: 0 })).toBe(false);
    expect(hitVisible(contours, { x: 10, y: 0 })).toBe(true);
    expect(hitVisible(contours, { x: 90, y: 0 })).toBe(true);
    expect([starts.length, ends.length]).toEqual([1, 1]);
  });

  it('sweeps the actual precision footprint without changing retained source', async () => {
    const { model, c } = eraserBoard({ mode: 'precision' });
    const source = model.objects.s!.points;
    c.pointerDown({ point: { x: 30, y: 0 } });
    c.pointerMove({ point: { x: 70, y: 0 } });
    c.pointerUp({ point: { x: 70, y: 0 } });
    await c.drainErasure();
    expect(model.order).toHaveLength(2);
    expect(model.order[0]).toBe('s');
    expect(
      (
        model.objects[model.objects.s!.sourceId as string]!
          .chunks as SurfaceObjectRecord[]
      )[0]!.points,
    ).toEqual(source);
    const contours = model.order.flatMap((id) =>
      inkStrokeContoursOfRecord(model.objects[id]!),
    );
    for (let x = 21; x < 80; x++)
      expect(hitVisible(contours, { x, y: 0 })).toBe(false);
    expect(hitVisible(contours, { x: 10, y: 0 })).toBe(true);
    expect(hitVisible(contours, { x: 90, y: 0 })).toBe(true);
  });

  it('retains original timing and pressure context after a middle cut', async () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [
            { x: 0, y: 0, dt: 0 },
            { x: 30, y: 0, dt: 100 },
            { x: 60, y: 0, dt: 200 },
            { x: 100, y: 0, dt: 300 },
          ],
          width: 4,
        }),
      },
    };
    const presets = new InkPresetStore();
    presets.setEraser({ mode: 'precision' });
    const c = new InkToolController({
      model,
      erasurePreparation: createTestErasurePreparation(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    const source = model.objects.s!.points;
    c.pointerDown({ point: { x: 45, y: 0 } });
    c.pointerUp({ point: { x: 45, y: 0 } });
    await c.drainErasure();
    expect(model.order).toHaveLength(2);
    expect(model.order[0]).toBe('s');
    expect(
      (
        model.objects[model.objects.s!.sourceId as string]!
          .chunks as SurfaceObjectRecord[]
      )[0]!.points,
    ).toEqual(source);
    expect(
      (
        (
          model.objects[model.objects.s!.sourceId as string]!
            .chunks as SurfaceObjectRecord[]
        )[0]!.points as { dt: number }[]
      ).map((p) => p.dt),
    ).toEqual([0, 100, 200, 300]);
    expect(
      hitVisible(inkStrokeContoursOfRecord(model.objects.s!), { x: 45, y: 0 }),
    ).toBe(false);
  });

  it('honors content filters: images erase while strokes survive', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s', 'i'],
      objects: {
        s: inkStrokeObject('s', {
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
          ],
        }),
        i: imageObject('i', {
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          src: 'assets/p.png',
          sha256: 'ab',
        }),
      },
    };
    const presets = new InkPresetStore();
    presets.setEraser({ filter: 'images' });
    const c = new InkToolController({
      model,
      erasurePreparation: createTestErasurePreparation(),
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    // On the stroke: filtered out, survives.
    c.pointerDown({ point: { x: 40, y: 0 } });
    c.pointerUp({ point: { x: 40, y: 0 } });
    expect(model.order).toEqual(['s', 'i']);
    // On the image: direct hit erases.
    c.pointerDown({ point: { x: 10, y: 10 } });
    c.pointerUp({ point: { x: 10, y: 10 } });
    expect(model.order).toEqual(['s']);
  });

  it('auto-returns to the previous tool after a temporary eraser gesture', () => {
    const { c } = eraserBoard({ mode: 'stroke', autoReturn: true });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    c.pointerDown({ point: { x: 200, y: 200 } });
    c.pointerUp({ point: { x: 200, y: 200 } });
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
  });

  it('stays on a manually chosen eraser even with auto-return set', () => {
    const { c } = eraserBoard({ mode: 'stroke', autoReturn: true });
    c.setTool(SURFACE_TOOL_IDS.eraser);
    c.pointerDown({ point: { x: 200, y: 200 } });
    c.pointerUp({ point: { x: 200, y: 200 } });
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.eraser);
  });

  it('auto-returns when a temporary eraser gesture is cancelled', () => {
    const { c } = eraserBoard({ mode: 'stroke', autoReturn: true });
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.enterTemporaryTool(SURFACE_TOOL_IDS.eraser);
    c.pointerDown({ point: { x: 200, y: 200 } });
    c.pointerCancel();
    expect(c.activeToolId()).toBe(SURFACE_TOOL_IDS.pen);
  });
});

describe('lasso', () => {
  function lassoBoard() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['in', 'out', 'shape'],
      objects: {
        in: inkStrokeObject('in', {
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 10 },
          ],
        }),
        out: inkStrokeObject('out', {
          points: [
            { x: 500, y: 500 },
            { x: 520, y: 500 },
          ],
        }),
        shape: rectangleObject('shape', { x: 12, y: 8, width: 4, height: 4 }),
      },
    };
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.setTool(SURFACE_TOOL_IDS.lasso);
    return { model, c };
  }

  it('selects strokes with any sample inside the closed path and nothing else', () => {
    const { model, c } = lassoBoard();
    c.pointerDown({ point: { x: 5, y: 5 } });
    c.pointerMove({ point: { x: 25, y: 5 } });
    c.pointerMove({ point: { x: 25, y: 15 } });
    c.pointerMove({ point: { x: 5, y: 15 } });
    expect(c.previewItems()).toHaveLength(1);
    c.pointerUp({ point: { x: 5, y: 5 } });
    // Slice 6: freehand selection is content-general — the enclosed
    // rectangle selects alongside the stroke; only `out` stays out.
    expect(c.selection()).toEqual(['in', 'shape']);
    expect(c.previewItems()).toEqual([]);
    expect(model.order).toEqual(['in', 'out', 'shape']);
  });

  it('hands lasso selections to the existing move semantics', () => {
    const { model, c } = lassoBoard();
    c.pointerDown({ point: { x: 5, y: 5 } });
    c.pointerUp({ point: { x: 25, y: 15 } });
    // Degenerate two-point path selects nothing; use direct selection.
    c.setTool(SURFACE_TOOL_IDS.lasso);
    c.pointerDown({ point: { x: 5, y: 5 } });
    c.pointerMove({ point: { x: 25, y: 5 } });
    c.pointerMove({ point: { x: 25, y: 15 } });
    c.pointerUp({ point: { x: 5, y: 15 } });
    expect(c.selection()).toEqual(['in', 'shape']);
    c.setTool(SURFACE_TOOL_IDS.select);
    // Select-tool pointerDown would re-select; move via direct API instead.
    c.moveSelectionBy({ x: 100, y: 0 });
    expect((model.objects.in!.points as Array<{ x: number }>)[0]!.x).toBe(110);
    expect(model.objects.shape!.x).toBe(112);
  });
});

describe('rectangle lasso and content filters', () => {
  function mixedBoard(filter?: EraserFilter) {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['pen', 'marker', 'box', 'photo', 'far'],
      objects: {
        pen: inkStrokeObject('pen', {
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 10 },
          ],
        }),
        marker: inkStrokeObject('marker', {
          points: [
            { x: 12, y: 12 },
            { x: 18, y: 12 },
          ],
          brush: { kind: 'highlighter' },
        }),
        box: rectangleObject('box', { x: 30, y: 30, width: 10, height: 10 }),
        photo: imageObject('photo', {
          x: 32,
          y: 32,
          width: 8,
          height: 8,
          src: 'assets/p.png',
          sha256: 'ab',
        }),
        far: inkStrokeObject('far', {
          points: [
            { x: 500, y: 500 },
            { x: 520, y: 500 },
          ],
        }),
      },
    };
    const presets = new InkPresetStore();
    presets.setLasso({
      mode: 'rectangle',
      ...(filter !== undefined ? { filter } : {}),
    });
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry({ presets }),
    });
    c.setTool(SURFACE_TOOL_IDS.lasso);
    return { model, c };
  }

  it('selects every enclosed content kind in one drag', () => {
    const { c } = mixedBoard();
    c.pointerDown({ point: { x: 5, y: 5 } });
    c.pointerMove({ point: { x: 45, y: 45 } });
    expect(c.previewItems()).toHaveLength(1);
    c.pointerUp({ point: { x: 45, y: 45 } });
    expect(c.selection()).toEqual(['pen', 'marker', 'box', 'photo']);
  });

  it('restricts selection to ink strokes under the ink filter', () => {
    const { c } = mixedBoard('ink');
    c.pointerDown({ point: { x: 5, y: 5 } });
    c.pointerMove({ point: { x: 45, y: 45 } });
    c.pointerUp({ point: { x: 45, y: 45 } });
    expect(c.selection()).toEqual(['pen']);
  });

  it('treats a tiny drag as a tap that clears outside selections', () => {
    const { c } = mixedBoard();
    c.pointerDown({ point: { x: 5, y: 5 } });
    c.pointerMove({ point: { x: 45, y: 45 } });
    c.pointerUp({ point: { x: 45, y: 45 } });
    expect(c.selection()).not.toEqual([]);
    c.pointerDown({ point: { x: 400, y: 400 } });
    c.pointerUp({ point: { x: 400, y: 400 } });
    expect(c.selection()).toEqual([]);
  });
});

describe('selection transforms', () => {
  function transformBoard() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['r1', 's1', 'l1'],
      objects: {
        r1: rectangleObject('r1', {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          fill: '#ff0000',
        }),
        s1: inkStrokeObject('s1', {
          points: [
            { x: 20, y: 0 },
            { x: 30, y: 0 },
          ],
          width: 4,
          color: '#00ff00',
        }),
        l1: lineObject('l1', {
          x: 40,
          y: 0,
          x2: 50,
          y2: 0,
          width: 2,
        }),
      },
    };
    const mutated: string[][] = [];
    let ids = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      idFactory: () => `gen-${(ids += 1)}`,
      onMutate: (list) => mutated.push([...list]),
    });
    return { model, mutated, c };
  }

  it('duplicates the selection with new identities on top in one mutation', () => {
    const { model, mutated, c } = transformBoard();
    c.setSelection(['r1', 's1']);
    const copies = c.duplicateSelection();
    expect(copies).toEqual(['gen-1', 'gen-2']);
    expect(model.order).toEqual(['r1', 's1', 'l1', 'gen-1', 'gen-2']);
    // Content deep-copied; identities fresh; selection follows the copies.
    expect(model.objects['gen-1']).toEqual({
      ...model.objects.r1,
      id: 'gen-1',
    });
    expect(model.objects['gen-1']).not.toBe(model.objects.r1);
    expect(c.selection()).toEqual(['gen-1', 'gen-2']);
    expect(mutated).toEqual([['gen-1', 'gen-2']]);
  });

  it('deletes the selection and clears it in one mutation', () => {
    const { model, mutated, c } = transformBoard();
    c.setSelection(['s1']);
    expect(c.deleteSelection()).toEqual(['s1']);
    expect(model.order).toEqual(['r1', 'l1']);
    expect(c.selection()).toEqual([]);
    expect(mutated).toEqual([['s1']]);
    // Empty selection deletes nothing and mutates nothing.
    expect(c.deleteSelection()).toEqual([]);
    expect(mutated).toHaveLength(1);
  });

  it('uses the pointer-up position when a selection drag has no final move', () => {
    const { model, c } = transformBoard();
    c.setTool(SURFACE_TOOL_IDS.select);
    model.objects.r1!.width = 100;
    model.objects.r1!.height = 100;
    c.setSelection(['r1']);
    c.pointerDown({ point: { x: 20, y: 20 } });
    c.pointerUp({ point: { x: 60, y: 44 } });
    expect(model.objects.r1).toMatchObject({ x: 40, y: 24 });
  });

  it('recolors and restyles by type, ignoring inapplicable members', () => {
    const { model, mutated, c } = transformBoard();
    c.setSelection(['r1', 's1', 'l1']);
    const touched = c.setSelectionStyle({
      color: '#123456',
      width: 8,
      opacity: 0.5,
    });
    expect(touched.sort()).toEqual(['l1', 'r1', 's1']);
    // Rectangles recolor through fill; strokes and lines through color.
    expect(model.objects.r1!.fill).toBe('#123456');
    expect(model.objects.s1!.color).toBe('#123456');
    expect(model.objects.l1!.color).toBe('#123456');
    // Width/opacity land only where members exist.
    expect(model.objects.s1!.width).toBe(8);
    expect(model.objects.l1!.width).toBe(8);
    expect(model.objects.r1!.width).toBe(10);
    expect(model.objects.s1!.opacity).toBe(0.5);
    expect(model.objects.l1!.opacity).toBe(0.5);
    expect(mutated).toHaveLength(1);
    // Garbage values never corrupt records.
    c.setSelectionStyle({ color: 42 as never, width: -3, opacity: 7 });
    expect(model.objects.s1!.color).toBe('#123456');
    expect(model.objects.s1!.width).toBe(8);
    expect(mutated).toHaveLength(1);
  });

  it('switches selected geometry between filled and border-only styles', () => {
    const { model, c } = transformBoard();
    c.setSelection(['r1']);
    expect(c.selectionContext()?.shapeAppearance).toBe('fill');

    c.setSelectionStyle({ shapeAppearance: 'outline', width: 8 });
    expect(model.objects.r1).toMatchObject({
      stroke: '#ff0000',
      strokeWidth: 8,
    });
    expect(model.objects.r1!.fill).toBeUndefined();
    expect(c.selectionContext()).toMatchObject({
      shapeAppearance: 'outline',
      width: 8,
    });

    c.setSelectionStyle({ color: '#123456', shapeAppearance: 'fill' });
    expect(model.objects.r1!.fill).toBe('#123456');
    expect(model.objects.r1!.stroke).toBeUndefined();
  });

  it('reorders paint order forward, backward, front, and back', () => {
    const { model, c } = transformBoard();
    c.setSelection(['s1']);
    c.reorderSelection('forward');
    expect(model.order).toEqual(['r1', 'l1', 's1']);
    c.reorderSelection('backward');
    expect(model.order).toEqual(['r1', 's1', 'l1']);
    c.reorderSelection('front');
    expect(model.order).toEqual(['r1', 'l1', 's1']);
    c.reorderSelection('back');
    expect(model.order).toEqual(['s1', 'r1', 'l1']);
  });

  it('scales mixed selections about their center', () => {
    const { model, c } = transformBoard();
    // Selection union uses the conservative brush envelope (ball
    // maxFactor 1.1 → stroke x 17.8..32.2, y -2.2..2.2; union with the
    // rect → x 0..32.2, y -2.2..10 → center (16.1, 3.9)).
    c.setSelection(['r1', 's1']);
    c.scaleSelection(2);
    // Rectangle origin and box scale about (16.1, 3.9).
    expect(model.objects.r1!.x).toBeCloseTo(-16.1, 9);
    expect(model.objects.r1!.y).toBeCloseTo(-3.9, 9);
    expect(model.objects.r1!.width).toBe(20);
    expect(model.objects.r1!.height).toBe(20);
    // Stroke samples scale about the same pivot.
    const points = model.objects.s1!.points as Array<{ x: number; y: number }>;
    expect(points[0]!.x).toBeCloseTo(23.9, 9);
    expect(points[0]!.y).toBeCloseTo(-3.9, 9);
    expect(points[1]!.x).toBeCloseTo(43.9, 9);
    expect(points[1]!.y).toBeCloseTo(-3.9, 9);
  });

  it('rotates mixed selections a quarter turn about their center', () => {
    const { model, c } = transformBoard();
    c.setSelection(['s1']);
    // Stroke bbox center is (25, 0); +90° clockwise in y-down space.
    c.rotateSelection(Math.PI / 2);
    const source = model.objects.s1!.points as Array<{ x: number; y: number }>;
    const points = source.map((p) =>
      rotateAround(p, { x: 25, y: 0 }, model.objects.s1!.rotation as number),
    );
    expect(points[0]!.x).toBeCloseTo(25, 9);
    expect(points[0]!.y).toBeCloseTo(-5, 9);
    expect(points[1]!.x).toBeCloseTo(25, 9);
    expect(points[1]!.y).toBeCloseTo(5, 9);
  });

  it('reports union bounds and a semantic context snapshot', () => {
    const { c } = transformBoard();
    expect(c.selectionBounds()).toBeNull();
    expect(c.selectionContext()).toBeNull();
    c.setSelection(['r1', 's1']);
    expect(c.selectionBounds()).toEqual({
      x: 0,
      y: -2.2,
      width: 32.2,
      height: 12.2,
    });
    const context = c.selectionContext()!;
    expect(context.ids).toEqual(['r1', 's1']);
    expect(context.kinds).toEqual(['ink', 'shapes']);
    // Fill red vs stroke green: mixed color; the rectangle has no stroke
    // width, so width is mixed too; neither carries opacity.
    expect(context.colorMixed).toBe(true);
    expect(context.color).toBeUndefined();
    expect(context.widthMixed).toBe(true);
    expect(context.width).toBeUndefined();
    expect(context.opacityMixed).toBe(false);
    expect(context.opacity).toBeUndefined();
  });

  it('resizes a stroke geometrically to the requested bounds', () => {
    const { model, c } = transformBoard();
    // Samples span x 20..30 (width 10); request width 20.
    c.resizeObject('s1', { width: 20 });
    const points = model.objects.s1!.points as Array<{ x: number; y: number }>;
    expect(points[0]!.x).toBeCloseTo(15, 9);
    expect(points[1]!.x).toBeCloseTo(35, 9);
    // Thickness untouched by geometric resize.
    expect(model.objects.s1!.width).toBe(4);
  });
});

describe('connector reconciliation', () => {
  function connectedBoard() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'c'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 }),
        c: lineObject('c', {
          x: 20,
          y: 10,
          x2: 100,
          y2: 10,
          arrows: 'end',
          source: { objectId: 'a', anchor: 'e' },
        }),
      },
    };
    const mutated: string[][] = [];
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      onMutate: (ids) => mutated.push([...ids]),
    });
    return { model, mutated, c };
  }

  it('drags bound endpoints along in the same mutation batch', () => {
    const { model, mutated, c } = connectedBoard();
    c.setSelection(['a']);
    c.moveSelectionBy({ x: 10, y: 5 });
    expect(model.objects.a!.x).toBe(10);
    expect(model.objects.a!.y).toBe(5);
    // East anchor of the moved rect is now (30, 15).
    expect(model.objects.c!.x).toBe(30);
    expect(model.objects.c!.y).toBe(15);
    expect(model.objects.c!.x2).toBe(100);
    expect(mutated).toEqual([['a', 'c']]);
  });

  it('leaves free endpoints and dangling bindings alone', () => {
    const { model, mutated, c } = connectedBoard();
    c.setSelection(['c']);
    c.moveSelectionBy({ x: 5, y: 0 });
    // Moving the connector itself moves coords, not bindings.
    expect(model.objects.c!.x).toBe(25);
    expect(model.objects.c!.source).toEqual({ objectId: 'a', anchor: 'e' });
    expect(mutated).toEqual([['c']]);
  });

  it('creates bound connectors between objects with one call', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'b'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 }),
        b: rectangleObject('b', { x: 100, y: 0, width: 20, height: 20 }),
      },
    };
    let ids = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    const id = c.connectEndpoints(
      { objectId: 'a', anchor: 'e' },
      { objectId: 'b', anchor: 'w' },
      { path: 'orthogonal', arrows: 'end' },
    );
    expect(id).toBe('gen-1');
    expect(model.objects['gen-1']).toEqual({
      id: 'gen-1',
      type: 'froglight.line',
      x: 20,
      y: 10,
      x2: 100,
      y2: 10,
      arrows: 'end',
      path: 'orthogonal',
      source: { objectId: 'a', anchor: 'e' },
      target: { objectId: 'b', anchor: 'w' },
    });
  });

  it('reconciles connectors after transforms without a mutation listener', () => {
    // Reconciliation is canonical work, not a notification side effect:
    // headless controllers without onMutate still keep bindings glued.
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'b'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 }),
        b: rectangleObject('b', { x: 100, y: 0, width: 20, height: 20 }),
      },
    };
    let ids = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    c.setSelection(['a', 'b']);
    const id = c.connectSelected();
    expect(id).toBe('gen-1');
    c.setSelection(['a']);
    c.moveSelectionBy({ x: 10, y: 0 });
    // Source center anchor (10,10) moved with its object to (20,10).
    expect(model.objects['gen-1']!.x).toBe(20);
    c.rotateSelection(Math.PI / 2);
    const line = model.objects['gen-1']!;
    expect(line.type).toBe('froglight.line');
    // Still glued to the live (rotated) anchor after both transforms.
    const anchor = resolveConnectorAnchor(
      model.objects.a!,
      'center',
      createDefaultSurfaceObjectTypeRegistry(),
    )!;
    expect(line.x).toBeCloseTo(anchor.x, 9);
    expect(line.y).toBeCloseTo(anchor.y, 9);
  });

  it('connects the selected pair and rebinds ends', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'b'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 20, height: 20 }),
        b: rectangleObject('b', { x: 100, y: 0, width: 20, height: 20 }),
      },
    };
    let ids = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    c.setSelection(['a', 'b']);
    const id = c.connectSelected();
    expect(id).toBe('gen-1');
    // Centers by default, arrowed like the connector tool.
    expect(model.objects['gen-1']).toMatchObject({
      x: 10,
      y: 10,
      x2: 110,
      y2: 10,
      arrows: 'end',
      source: { objectId: 'a', anchor: 'center' },
    });
    expect(c.connectSelected()).toBe('gen-2');
    c.setSelection([]);
    expect(c.connectSelected()).toBeNull();
    // Rebind the target end to a free point, then unbind the source.
    expect(c.rebindConnector(id!, 'target', { point: { x: 5, y: 5 } })).toBe(
      true,
    );
    expect(model.objects[id!]!.target).toBeUndefined();
    expect(model.objects[id!]!.x2).toBe(5);
    expect(c.rebindConnector(id!, 'source', null)).toBe(true);
    expect(model.objects[id!]!.source).toBeUndefined();
    expect(c.rebindConnector('missing', 'source', null)).toBe(false);
  });
});

describe('group selection and verbs', () => {
  function groupBoard() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a', 'b', 'solo'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 10, height: 10 }),
        b: rectangleObject('b', { x: 30, y: 0, width: 10, height: 10 }),
        solo: rectangleObject('solo', {
          x: 100,
          y: 100,
          width: 10,
          height: 10,
        }),
      },
    };
    let ids = 0;
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      idFactory: () => `gen-${(ids += 1)}`,
    });
    return { model, c };
  }

  it('groups a multi-selection into one record and selects it', () => {
    const { model, c } = groupBoard();
    c.setSelection(['a', 'b']);
    const group = c.groupSelection();
    expect(group).toBe('gen-1');
    expect(model.objects['gen-1']).toEqual({
      id: 'gen-1',
      type: 'froglight.group',
      children: ['a', 'b'],
    });
    expect(c.selection()).toEqual(['gen-1']);
  });

  it('promotes member hits and member selections to the group', () => {
    const { c } = groupBoard();
    c.setSelection(['a', 'b']);
    c.groupSelection();
    // Direct member selection promotes.
    c.setSelection(['a']);
    expect(c.selection()).toEqual(['gen-1']);
    // Hit-testing a member resolves the group.
    expect(c.hitTest({ x: 35, y: 5 })).toBe('gen-1');
    expect(c.hitTest({ x: 105, y: 105 })).toBe('solo');
  });

  it('moves, duplicates, and deletes groups through their members', () => {
    const { model, c } = groupBoard();
    c.setSelection(['a', 'b']);
    c.groupSelection();
    c.setSelection(['gen-1']);
    c.moveSelectionBy({ x: 10, y: 0 });
    expect(model.objects.a!.x).toBe(10);
    expect(model.objects.b!.x).toBe(40);
    const copies = c.duplicateSelection();
    expect(copies).toHaveLength(3);
    expect(model.objects[copies[2]!]!.type).toBe('froglight.group');
    const deleted = c.deleteSelection();
    expect(model.order).toEqual(['a', 'b', 'solo', 'gen-1']);
    // The copied group and its copied members are gone; the original
    // group survives.
    expect(deleted.sort()).toEqual(['gen-2', 'gen-3', 'gen-4']);
  });

  it('ungroups back to members without moving them', () => {
    const { model, c } = groupBoard();
    c.setSelection(['a', 'b']);
    c.groupSelection();
    c.setSelection(['gen-1']);
    const members = c.ungroupSelection();
    expect(members).toEqual(['a', 'b']);
    expect(model.objects['gen-1']).toBeUndefined();
    expect(model.objects.a).toEqual(
      rectangleObject('a', { x: 0, y: 0, width: 10, height: 10 }),
    );
    expect(c.selection()).toEqual(['a', 'b']);
  });

  it('refuses nested groups and single selections', () => {
    const { c } = groupBoard();
    c.setSelection(['a']);
    expect(c.groupSelection()).toBeNull();
    c.setSelection(['a', 'b']);
    c.groupSelection();
    c.setSelection(['gen-1', 'solo']);
    expect(c.groupSelection()).toBeNull();
  });

  it('keeps malformed group data deterministic and side-effect free', () => {
    const { model, c } = groupBoard();
    // Manual canonical damage: self-reference, dangling child, double
    // membership across two groups, and a nested group id.
    model.objects.g1 = groupObject('g1', { children: ['a', 'g1', 'missing'] });
    model.objects.g2 = groupObject('g2', { children: ['a', 'b'] });
    model.objects.g3 = groupObject('g3', { children: ['g2'] });
    model.order.push('g1', 'g2', 'g3');
    // Self-references never leak the group id into member expansion.
    expect(groupMembersOf(model, 'g1')).toEqual(['a']);
    // Dangling children are skipped silently and preserved verbatim.
    expect(model.objects.g1!.children).toEqual(['a', 'g1', 'missing']);
    // Double membership resolves deterministically (paint order) and
    // expansion dedupes.
    expect(groupOfMember(model, 'a')).toBe('g1');
    expect(resolveGroupMembers(model, ['g1', 'g2'])).toEqual(['a', 'b']);
    // Nested group ids surface opaquely (never traversed into).
    expect(resolveGroupMembers(model, ['g3'])).toEqual(['g2']);
    // Hit-testing still promotes through the first group.
    expect(c.hitTest({ x: 5, y: 5 })).toBe('g1');
    // Duplicating a group rewires copied children only: originals are
    // never referenced from the copy (nested group ids copy to nothing).
    c.setSelection(['g3']);
    const copies = c.duplicateSelection();
    expect(copies).toHaveLength(1);
    const copy = model.objects[copies[0]!]!;
    expect(copy.type).toBe('froglight.group');
    expect(copy.children).toEqual([]);
    // Deleting a selected group removes the group record; members listed
    // through the group dissolve with it (explicit command semantics),
    // while uninvolved objects survive.
    c.setSelection(['g1']);
    c.deleteSelection();
    expect(model.objects.g1).toBeUndefined();
    expect(model.objects.a).toBeUndefined();
    expect(model.objects.solo).toBeDefined();
    expect(model.objects.g2).toBeDefined();
  });

  it('shelters grouped members behind a locked group', () => {
    const { model, c } = groupBoard();
    c.setSelection(['a', 'b']);
    c.groupSelection();
    // Locking the group (one canonical write on the group record)
    // locks interaction for its members without touching them.
    expect(c.setLocked(['gen-1'], true)).toEqual(['gen-1']);
    expect(model.objects.a!.locked).toBeUndefined();
    expect(c.hitTest({ x: 5, y: 5 })).toBeNull();
    c.setSelection(['gen-1']);
    c.moveSelectionBy({ x: 10, y: 0 });
    expect(model.objects.a!.x).toBe(0);
    // Unlocking restores member interaction.
    expect(c.setLocked(['gen-1'], false)).toEqual(['gen-1']);
    expect(c.hitTest({ x: 5, y: 5 })).toBe('gen-1');
  });
});

describe('snap guides in previews', () => {
  it('publishes guide items mid-drag and clears them on release', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['static', 'moving'],
      objects: {
        static: rectangleObject('static', {
          x: 100,
          y: 200,
          width: 40,
          height: 40,
        }),
        moving: rectangleObject('moving', {
          x: 0,
          y: 200,
          width: 40,
          height: 40,
        }),
      },
    };
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      snapThresholdView: 8,
    });
    c.setTool(SURFACE_TOOL_IDS.select);
    expect(c.previewItems()).toEqual([]);
    c.pointerDown({ point: { x: 10, y: 210 } });
    c.pointerMove({ point: { x: 86, y: 210 } });
    // Ephemeral: canonical unchanged during move, guides still publish.
    expect(model.objects.moving!.x).toBe(0);
    const guides = c.previewItems();
    expect(guides.length).toBeGreaterThanOrEqual(1);
    expect(guides[0]!.kind).toBe('line');
    c.pointerUp({ point: { x: 86, y: 210 } });
    expect(model.objects.moving!.x).toBe(80);
    expect(c.previewItems()).toEqual([]);
    // Guides never enter canonical data.
    expect(model.order).toEqual(['static', 'moving']);
  });
});

describe('tool registry effect ownership (lifecycle invariant)', () => {
  it('activate → one registration, dispose → zero, reactivate → one', async () => {
    const runtime = new Runtime();
    const toolCounts: number[] = [];
    const provider = definePlugin({
      id: 'froglight.tools',
      activate: (ctx) => {
        ctx.provide(
          surfaceToolRegistryToken,
          createDefaultSurfaceToolRegistry(),
        );
      },
    });
    const consumer = definePlugin({
      id: 'acme.brushes',
      requirements: { requires: [surfaceToolRegistryToken] },
      activate: (ctx) => {
        ctx.effect(() => {
          const registry = ctx.require(surfaceToolRegistryToken);
          const disposer = registry.register({ toolId: 'acme.calligraphy' });
          toolCounts.push(registry.list().length);
          return () => disposer.dispose();
        });
      },
    });

    await runtime.registerSlot({ id: 'tools', plugin: provider });
    await runtime.registerSlot({ id: 'brushes', plugin: consumer });
    expect(toolCounts).toEqual([9]); // 8 core + 1 plugin tool

    await runtime.removeSlot('brushes');
    // The disposed run removed its tool: the fresh consumer below again
    // counts 8 core tools + exactly one registration of its own.
    await runtime.registerSlot({ id: 'brushes-2', plugin: consumer });
    expect(toolCounts).toEqual([9, 9]);
    await runtime.dispose();
  });
});

describe('device independence (traceability invariant)', () => {
  it('capture → save → reload → edit on another input matches uninterrupted capture byte-for-byte', async () => {
    const stylusStream = (): Array<Record<string, number>> => [
      { pointX: 0, pointY: 0, pressure: 0.8 },
      { pointX: 20, pointY: 10, pressure: 0.4 },
    ];
    const capture = (events: Array<Record<string, number>>) => {
      const model: SurfaceModel = {
        formatVersion: 1,
        frame: infiniteFrame(),
        order: [],
        objects: {},
      };
      const c = new InkToolController({
        model,
          objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
        idFactory: () => 'stroke-1',
      });
      c.setTool(SURFACE_TOOL_IDS.pen);
      events.forEach((e, i) => {
        const event =
          e.pressure !== undefined
            ? { point: { x: e.pointX, y: e.pointY }, pressure: e.pressure }
            : { point: { x: e.pointX, y: e.pointY } };
        if (i === 0) c.pointerDown(event);
        else if (i === events.length - 1) c.pointerUp(event);
        else c.pointerMove(event);
      });
      return model;
    };

    // Session A: captured by stylus, saved, reloaded elsewhere.
    const savedBytes = encodeSurfacePayload(capture(stylusStream()));
    const reloaded = decodeSurfacePayload(savedBytes).model;
    const controllerB = new InkToolController({
      model: reloaded,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    // Session B edits with a plain pointer (no hardware axes at all).
    controllerB.setSelection(['stroke-1']);
    controllerB.moveSelectionBy({ x: 5, y: 5 });

    // Uninterrupted reference: same strokes, same final geometry.
    const reference = capture([
      { pointX: 5, pointY: 5, pressure: 0.8 },
      { pointX: 25, pointY: 15, pressure: 0.4 },
    ]);
    expect(JSON.parse(utf8Decode(encodeSurfacePayload(reloaded)))).toEqual(
      JSON.parse(utf8Decode(encodeSurfacePayload(reference))),
    );
    // The reload carries the original pressure data untouched.
    const points = reloaded.objects['stroke-1']!.points as Array<
      Record<string, number>
    >;
    expect(points[1]!.pressure).toBe(0.4);
    void controllerB;
  });
});

describe('tool refinements (review follow-ups)', () => {
  function styled() {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: [],
      objects: {},
    };
    const penStyle = { color: '#37352f' as string | undefined, width: 3 };
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      idFactory: (() => {
        let n = 0;
        return () => `gen-${++n}`;
      })(),
      toolRegistry: createDefaultSurfaceToolRegistry({ penStyle }),
    });
    return { model, penStyle, c };
  }

  it('pen commits with the live style source instead of a frozen preset', () => {
    const { model, penStyle, c } = styled();
    c.setTool(SURFACE_TOOL_IDS.pen);
    penStyle.color = '#c4554d';
    penStyle.width = 6;
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerUp({ point: { x: 10, y: 10 } });
    const stroke = model.objects['gen-1']!;
    expect(stroke.color).toBe('#c4554d');
    expect(stroke.width).toBe(6);
    // Live preview carries the same style so ink looks final while drawing.
    penStyle.width = 9;
    c.pointerDown({ point: { x: 50, y: 50 } });
    c.pointerMove({ point: { x: 58, y: 58 } });
    expect(c.previewItems()[0]).toMatchObject({ width: 9, color: '#c4554d' });
    c.pointerUp({ point: { x: 60, y: 60 } });
  });

  it('preview styling matches the committed stroke exactly', () => {
    const { model, c } = styled();
    c.setTool(SURFACE_TOOL_IDS.pen);
    c.pointerDown({ point: { x: 0, y: 0 } });
    c.pointerMove({ point: { x: 8, y: 8 } });
    const preview = c.previewItems()[0] as unknown as {
      width?: unknown;
      color?: unknown;
    };
    c.pointerUp({ point: { x: 16, y: 16 } });
    const committed = model.objects['gen-1']! as unknown as {
      width?: unknown;
      color?: unknown;
    };
    expect(preview.width).toBe(committed.width);
    expect(preview.color).toBe(committed.color);
  });

  it('lasso drags an existing selection and clears it on empty taps', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['a'],
      objects: {
        a: inkStrokeObject('a', {
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 10 },
          ],
        }),
      },
    };
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    });
    c.setSelection(['a']);
    c.setTool(SURFACE_TOOL_IDS.lasso);
    // Down inside the selection envelope starts a drag-move, not a lasso.
    c.pointerDown({ point: { x: 15, y: 10 } });
    c.pointerMove({ point: { x: 45, y: 30 } });
    c.pointerUp({ point: { x: 45, y: 30 } });
    expect((model.objects.a!.points as Array<{ x: number }>)[0]).toEqual({
      x: 40,
      y: 30,
    });
    expect(c.selection()).toEqual(['a']);
    // Tiny tap on empty space clears the selection.
    c.pointerDown({ point: { x: 500, y: 500 } });
    c.pointerUp({ point: { x: 500, y: 500 } });
    expect(c.selection()).toEqual([]);
  });

  it('exposes moveSelectionBy through the tool context for drag gestures', () => {
    const moved: string[][] = [];
    const registry = new InMemorySurfaceToolRegistry();
    registry.register({
      toolId: 'acme.mover',
      onDown: (ctx) => {
        moved.push([...ctx.moveSelectionBy({ x: 5, y: 0 })]);
      },
    });
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['r'],
      objects: { r: rectangleObject('r', { x: 0, y: 0, width: 4, height: 4 }) },
    };
    const c = new InkToolController({
      model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: registry,
    });
    c.setSelection(['r']);
    c.setTool('acme.mover');
    c.pointerDown({ point: { x: 2, y: 2 } });
    expect(moved).toEqual([['r']]);
    expect(model.objects.r!.x).toBe(5);
  });
});
