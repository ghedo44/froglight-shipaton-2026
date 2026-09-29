/**
 * Ink stroke conformance: the
 * `froglight.ink.stroke` core object type — canonical record shape,
 * structural validation, codec integration, limits, and draw-item
 * compilation. Engine-free throughout.
 */

import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  SURFACE_LIMITS,
  decodeSurfacePayload,
  encodeSurfacePayload,
} from './codec.js';
import {
  SURFACE_MAX_SAMPLE_DT_MS,
  SURFACE_OBJECT_TYPES,
  infiniteFrame,
  inkStrokeObject,
  isCoreSurfaceObjectType,
  isValidCoreSurfaceObject,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from './model.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  inkStrokeCompiledBounds,
} from './objects.js';
import { compileScene } from './render.js';

const STROKE_TYPE = 'froglight.ink.stroke';

function sample(x: number, y: number): { x: number; y: number } {
  return { x, y };
}

describe('stroke record shape', () => {
  it('joins the core surface object type set', () => {
    expect(SURFACE_OBJECT_TYPES.stroke).toBe(STROKE_TYPE);
    expect(isCoreSurfaceObjectType('froglight.ink.stroke')).toBe(true);
  });

  it('constructs a canonical record with deterministic field order', () => {
    const record = inkStrokeObject('s1', {
      points: [sample(0, 0), sample(4, 2)],
      rotation: Math.PI / 2,
      color: '#111111',
      width: 3,
      opacity: 1,
    });
    expect(Object.keys(record)).toEqual([
      'id',
      'type',
      'points',
      'rotation',
      'color',
      'width',
      'opacity',
    ]);
    expect(record.type).toBe(STROKE_TYPE);
    // Optional members stay absent when not provided.
    const minimal = inkStrokeObject('s2', { points: [sample(1, 1)] });
    expect(Object.keys(minimal)).toEqual(['id', 'type', 'points']);
  });

  it('preserves optional per-sample pressure/tilt/twist verbatim', () => {
    const record = inkStrokeObject('s1', {
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5, pressure: 0.75, tilt: { x: 0.3, y: 0.1 }, twist: 1.1 },
      ],
    });
    expect((record.points as unknown[])[1]).toEqual({
      x: 5,
      y: 5,
      pressure: 0.75,
      tilt: { x: 0.3, y: 0.1 },
      twist: 1.1,
    });
  });

  it('rejects scalar tilt in favor of the current vector shape', () => {
    const scalar = {
      id: 's',
      type: STROKE_TYPE,
      points: [{ x: 0, y: 0, tilt: 0.3 }],
    };
    expect(isValidCoreSurfaceObject(scalar as never)).toBe(false);
  });
});

describe('stroke structural validation', () => {
  it('accepts well-formed strokes', () => {
    const record = inkStrokeObject('s', {
      points: [{ x: 0, y: 0, pressure: 0.5 }],
      width: 2.5,
      color: '#00ff00',
      opacity: 0.35,
      rotation: -0.25,
    });
    expect(isValidCoreSurfaceObject(record)).toBe(true);
  });

  it('rejects empty or non-array point lists', () => {
    expect(isValidCoreSurfaceObject(inkStrokeObject('s', { points: [] }))).toBe(
      false,
    );
    const noPoints = { id: 's', type: STROKE_TYPE };
    expect(isValidCoreSurfaceObject(noPoints as never)).toBe(false);
  });

  it('rejects malformed samples', () => {
    const bad = (points: unknown) =>
      isValidCoreSurfaceObject({ id: 's', type: STROKE_TYPE, points } as never);
    expect(bad([{ x: 0 }])).toBe(false); // missing y
    expect(bad([{ x: Number.NaN, y: 0 }])).toBe(false);
    expect(bad('nope')).toBe(false);
    expect(bad([{ x: 0, y: 0, pressure: 1.5 }])).toBe(false); // out of range
    expect(bad([{ x: 0, y: 0, tilt: { x: -2, y: 0 } }])).toBe(false);
    expect(bad([{ x: 0, y: 0, tilt: { x: 0.3 } }])).toBe(false);
    expect(bad([{ x: 0, y: 0, tilt: -0.1 }])).toBe(false);
    expect(bad([{ x: 0, y: 0, tilt: 2 }])).toBe(false);
    expect(bad([{ x: 0, y: 0, twist: 4 }])).toBe(false);
  });

  it('accepts an optional resolved brush member; strokes without one stay valid', () => {
    // The brush carries kind + geometry params so appearance reproduces
    // without the author's live preset. Absent = ball pen (back-compat).
    const brushed = inkStrokeObject('s', {
      points: [{ x: 0, y: 0 }],
      width: 4,
      brush: {
        kind: 'fountain',
        pressure: {
          enabled: true,
          minFactor: 0.55,
          maxFactor: 1.7,
          curve: 1.8,
        },
        stabilization: 0.25,
        tip: { shape: 'flat', angle: 0, aspect: 0.35 },
      },
    });
    expect(isValidCoreSurfaceObject(brushed)).toBe(true);
    expect(
      isValidCoreSurfaceObject(
        inkStrokeObject('s', { points: [{ x: 0, y: 0 }] }),
      ),
    ).toBe(true);
    const bad = (brush: unknown) =>
      isValidCoreSurfaceObject({
        id: 's',
        type: STROKE_TYPE,
        points: [{ x: 0, y: 0 }],
        brush,
      } as never);
    expect(bad({ kind: 'acme.calligraphy' })).toBe(false);
    expect(bad({ kind: 'ball', stabilization: 2 })).toBe(false);
    expect(bad({ kind: 'ball', tip: { shape: 'hex' } })).toBe(false);
    expect(bad({ kind: 'ball', pressure: { curve: 0 } })).toBe(false);
    expect(bad('fountain')).toBe(false);
  });

  it('accepts optional per-sample dt timing; samples without dt stay valid', () => {
    // dt is milliseconds since the stroke's first sample (monotonic,
    // relative — never a wall-clock timestamp).
    const timed = inkStrokeObject('s', {
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5, dt: 16.7 },
      ],
      width: 2,
    });
    expect(isValidCoreSurfaceObject(timed)).toBe(true);
    const bad = (dt: unknown) =>
      isValidCoreSurfaceObject({
        id: 's',
        type: STROKE_TYPE,
        points: [{ x: 0, y: 0, dt }],
      } as never);
    expect(bad(-1)).toBe(false);
    expect(bad(Number.NaN)).toBe(false);
    expect(bad('16')).toBe(false);
    expect(bad(SURFACE_MAX_SAMPLE_DT_MS + 1)).toBe(false);
  });

  it('rejects invalid style members', () => {
    const withMember = (member: Record<string, unknown>) =>
      isValidCoreSurfaceObject({
        id: 's',
        type: STROKE_TYPE,
        points: [sample(0, 0)],
        ...member,
      } as never);
    expect(withMember({ width: 0 })).toBe(false);
    expect(withMember({ width: -3 })).toBe(false);
    expect(withMember({ opacity: 1.5 })).toBe(false);
    expect(withMember({ opacity: -0.1 })).toBe(false);
    expect(withMember({ color: 42 })).toBe(false);
    expect(withMember({ rotation: 'x' })).toBe(false);
  });
});

function cleanInkModel(): SurfaceModel {
  return {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['s1'],
    objects: {
      s1: inkStrokeObject('s1', {
        points: [sample(0, 0), sample(10, 4)],
        width: 3,
        color: '#202124',
      }),
    },
  };
}

describe('stroke codec conformance', () => {
  it('round-trips unmodified strokes byte-stably', () => {
    const bytes = encodeSurfacePayload(cleanInkModel());
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      utf8Decode(bytes),
    );
    expect(utf8Decode(bytes)).toContain(`"${STROKE_TYPE}"`);
  });

  it('round-trips optional dt timing byte-stably', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [
            { x: 0, y: 0 },
            { x: 5, y: 5, dt: 16.5 },
          ],
          width: 3,
        }),
      },
    };
    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.objects.s!.points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5, dt: 16.5 },
    ]);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      utf8Decode(bytes),
    );
  });

  it('round-trips the resolved brush member byte-stably', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [{ x: 0, y: 0 }],
          width: 4,
          brush: { kind: 'fountain', stabilization: 0.25 },
        }),
      },
    };
    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.objects.s!.brush).toEqual({
      kind: 'fountain',
      stabilization: 0.25,
    });
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      utf8Decode(bytes),
    );
  });

  it('keeps unknown members inside strokes and samples verbatim', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['s'],
      objects: {
        s: {
          id: 's',
          type: STROKE_TYPE,
          points: [{ x: 1, y: 2, vendorGlide: 9 }],
          vendorNib: 'acme.calligraphy',
        },
      },
    };
    const decoded = decodeSurfacePayload(utf8Encode(JSON.stringify(raw)));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.objects.s).toEqual(raw.objects.s);
  });

  it('degrades structurally invalid core strokes to opaque with warnings', () => {
    const broken = { id: 'b', type: STROKE_TYPE, points: [] };
    const wrongId = {
      ...inkStrokeObject('w', { points: [sample(0, 0)] }),
      id: 'other',
    };
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: [],
      objects: { b: broken, w: wrongId },
    };
    const decoded = decodeSurfacePayload(utf8Encode(JSON.stringify(raw)));
    expect(decoded.model.objects.b).toEqual(broken);
    expect(decoded.model.objects.w).toEqual(wrongId);
    expect(decoded.warnings).toEqual([
      { code: 'INVALID_CORE_OBJECT_OPAQUE', objectId: 'b' },
      { code: 'INVALID_CORE_OBJECT_OPAQUE', objectId: 'w' },
      { code: 'OBJECT_MISSING_FROM_ORDER', objectId: 'b' },
      { code: 'OBJECT_MISSING_FROM_ORDER', objectId: 'w' },
    ]);
  });

  it('recovers over-limit strokes by splitting instead of refusing the document', () => {
    // A stroke beyond maxStrokePoints (genuine long capture —
    // the writers impose no per-stroke cap) opens via lossless sequential
    // split, never FORMAT_LIMIT_EXCEEDED. Every sample survives.
    const cap = SURFACE_LIMITS.maxStrokePoints ?? 0;
    expect(cap).toBeGreaterThan(0);
    const points = Array.from({ length: cap + 1 }, (_, i) => sample(i, i % 7));
    const payload = utf8Encode(
      JSON.stringify({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: ['big'],
        objects: {
          big: {
            id: 'big',
            type: STROKE_TYPE,
            points,
            width: 3,
            color: '#111111',
            brush: { kind: 'fountain' },
            vendorTag: 'kept',
          },
        },
      }),
    );
    const decoded = decodeSurfacePayload(payload);
    // Head keeps the original id (existing references stay pointed at the
    // stroke start); the tail takes a deterministic fragment id.
    expect(decoded.model.order).toEqual(['big', 'big#part2']);
    const head = decoded.model.objects.big!;
    const tail = decoded.model.objects['big#part2']!;
    const headPoints = head.points as unknown[];
    const tailPoints = tail.points as unknown[];
    expect(headPoints).toHaveLength(cap);
    expect(tailPoints).toHaveLength(1);
    // Sample sequence preserved losslessly across the split joint.
    expect([...headPoints, ...tailPoints]).toEqual(points);
    // Style, brush, and unknown members survive verbatim per fragment.
    for (const fragment of [head, tail]) {
      expect(fragment.type).toBe(STROKE_TYPE);
      expect(fragment.width).toBe(3);
      expect(fragment.color).toBe('#111111');
      expect(fragment.brush).toEqual({ kind: 'fountain' });
      expect((fragment as Record<string, unknown>).vendorTag).toBe('kept');
    }
    // Logical-stroke identity: one gesture, joint rendering.
    expect((head as Record<string, unknown>).logicalId).toBe('big');
    expect((head as Record<string, unknown>).chunkIndex).toBe(0);
    expect((tail as Record<string, unknown>).logicalId).toBe('big');
    expect((tail as Record<string, unknown>).chunkIndex).toBe(1);
    expect(decoded.warnings).toEqual([
      { code: 'STROKE_SPLIT_FOR_LIMIT', objectId: 'big' },
    ]);
    // Recovered fragments render through the same compiler (the document
    // opens AND draws — no unusable states).
    for (const id of decoded.model.order) {
      const bounds = inkStrokeCompiledBounds(decoded.model.objects[id]!);
      expect(bounds).not.toBeNull();
      expect(Number.isFinite(bounds!.width)).toBe(true);
    }
    // Recovery is stable and idempotent: re-encoding re-decodes cleanly
    // with no further warnings (fragments already satisfy the cap).
    const redecoded = decodeSurfacePayload(encodeSurfacePayload(decoded.model));
    expect(redecoded.warnings).toEqual([]);
    expect(redecoded.model.order).toEqual(['big', 'big#part2']);
  });

  it('splits very long strokes into sequential capped fragments with rebased timing', () => {
    const cap = SURFACE_LIMITS.maxStrokePoints ?? 0;
    const total = cap * 2 + 123;
    const points = Array.from({ length: total }, (_, i) => ({
      x: i,
      y: 0,
      pressure: 0.5,
      dt: 1000 + i * 8,
    }));
    const payload = utf8Encode(
      JSON.stringify({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: ['long'],
        objects: { long: { id: 'long', type: STROKE_TYPE, points } },
      }),
    );
    const decoded = decodeSurfacePayload(payload);
    expect(decoded.model.order).toEqual(['long', 'long#part2', 'long#part3']);
    const sizes = decoded.model.order.map(
      (id) => (decoded.model.objects[id]!.points as unknown[]).length,
    );
    expect(sizes).toEqual([cap, cap, 123]);
    expect(sizes.every((n) => n <= cap)).toBe(true);
    // Logical-stroke chunking: one continuous gesture, joint derived
    // compilation (no internal caps/taper restarts). Chunks share the head
    // id as logicalId with ascending chunkIndex.
    expect(
      (decoded.model.objects.long as Record<string, unknown>).logicalId,
    ).toBe('long');
    expect(
      (decoded.model.objects.long as Record<string, unknown>).chunkIndex,
    ).toBe(0);
    expect(
      (decoded.model.objects['long#part2'] as Record<string, unknown>)
        .logicalId,
    ).toBe('long');
    expect(
      (decoded.model.objects['long#part2'] as Record<string, unknown>)
        .chunkIndex,
    ).toBe(1);
    expect(
      (decoded.model.objects['long#part3'] as Record<string, unknown>)
        .logicalId,
    ).toBe('long');
    expect(
      (decoded.model.objects['long#part3'] as Record<string, unknown>)
        .chunkIndex,
    ).toBe(2);
    // Concatenated fragments reproduce every sample position in order.
    const joined = decoded.model.order.flatMap(
      (id) => decoded.model.objects[id]!.points as { x: number }[],
    );
    expect(joined.map((p) => p.x)).toEqual(points.map((p) => p.x));
    // Head restarts dt at 0; continuation chunks preserve boundary timing
    // so joint compilation restores the original sequence exactly.
    // Relatives preserved everywhere (8ms steps).
    const headDts = (
      decoded.model.objects.long!.points as { dt: number }[]
    ).map((p) => p.dt);
    expect(headDts[0]).toBe(0);
    for (let i = 1; i < headDts.length; i++) {
      expect(headDts[i]! - headDts[i - 1]!).toBe(8);
    }
    for (const id of ['long#part2', 'long#part3']) {
      const dts = (decoded.model.objects[id]!.points as { dt: number }[]).map(
        (p) => p.dt,
      );
      for (let i = 1; i < dts.length; i++) {
        expect(dts[i]! - dts[i - 1]!).toBe(8);
      }
    }
    // Boundary timing preserved: part2 starts where the original sequence
    // was (1000 + cap*8), part3 likewise — concatenation restores original.
    expect(
      (decoded.model.objects['long#part2']!.points as { dt: number }[])[0]!.dt,
    ).toBe(1000 + cap * 8);
    expect(
      (decoded.model.objects['long#part3']!.points as { dt: number }[])[0]!.dt,
    ).toBe(1000 + cap * 2 * 8);
    expect(decoded.warnings).toEqual([
      { code: 'STROKE_SPLIT_FOR_LIMIT', objectId: 'long' },
    ]);
  });

  it('keeps other security limits as hard errors', () => {
    // Only the stroke-point overflow converts to recovery (it is
    // lossless); text length and the remaining caps still refuse.
    const payload = utf8Encode(
      JSON.stringify({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: ['t'],
        objects: {
          t: {
            id: 't',
            type: 'froglight.text',
            x: 0,
            y: 0,
            text: 'x'.repeat((SURFACE_LIMITS.maxTextLength ?? 0) + 1),
          },
        },
      }),
    );
    try {
      decodeSurfacePayload(payload);
      expect.unreachable('expected FORMAT_LIMIT_EXCEEDED');
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
  });

  it('treats non-finite sample coordinates and ranges as hard security violations', () => {
    const infiniteX =
      '{"formatVersion":1,"frame":{"kind":"infinite"},"order":["n"],' +
      `"objects":{"n":{"id":"n","type":"${STROKE_TYPE}","points":[{"x":1e400,"y":0}]}}}`;
    try {
      decodeSurfacePayload(utf8Encode(infiniteX));
      expect.unreachable('expected FORMAT_LIMIT_EXCEEDED');
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
    const hugePressure =
      '{"formatVersion":1,"frame":{"kind":"infinite"},"order":["p"],' +
      `"objects":{"p":{"id":"p","type":"${STROKE_TYPE}","points":[{"x":0,"y":0,"pressure":1e400}]}}}`;
    try {
      decodeSurfacePayload(utf8Encode(hugePressure));
      expect.unreachable('expected FORMAT_LIMIT_EXCEEDED');
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
    const hugeTilt =
      '{"formatVersion":1,"frame":{"kind":"infinite"},"order":["t"],' +
      `"objects":{"t":{"id":"t","type":"${STROKE_TYPE}","points":[{"x":0,"y":0,"tilt":{"x":1e400,"y":0}}]}}}`;
    try {
      decodeSurfacePayload(utf8Encode(hugeTilt));
      expect.unreachable('expected FORMAT_LIMIT_EXCEEDED');
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
  });

  it('round-trips vector tilt byte-stably', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [
            { x: 0, y: 0, tilt: { x: 0.5, y: -0.25 } },
            { x: 10, y: 4, pressure: 0.6, tilt: { x: 0, y: 0.9 }, twist: 0.2 },
          ],
          width: 3,
        }),
      },
    };
    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      utf8Decode(bytes),
    );
    expect(decoded.model.objects.s).toEqual(model.objects.s);
  });
});

describe('stroke object type descriptor', () => {
  const registry = () => createDefaultSurfaceObjectTypeRegistry();

  it('compiles strokes to stroke draw items with sample-derived bounds', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [
            { x: 10, y: 20 },
            { x: 40, y: 8, pressure: 0.5 },
          ],
          width: 4,
          color: '#1a73e8',
          opacity: 0.9,
        }),
      },
    };
    const items = compileScene(model, registry());
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe('stroke');
    if (item.kind !== 'stroke') return;
    const { outline, ...rest } = item;
    expect(rest).toEqual({
      kind: 'stroke',
      objectId: 's',
      // Conservative brush envelope: sample bbox expanded by the
      // pressure-aware rendered half-width (ball maxFactor 1.1 → 2.2),
      // so culling/selection/hit areas cover the actual outline.
      bounds: { x: 7.8, y: 5.8, width: 34.4, height: 16.4 },
      rotation: 0,
      points: [
        { x: 10, y: 20 },
        { x: 40, y: 8, pressure: 0.5 },
      ],
      width: 4,
      color: '#1a73e8',
      opacity: 0.9,
    });
    // The filled ball-pen outline travels with the semantic polyline so
    // renderers fill one polygon instead of stroking segments.
    expect(outline!.length).toBeGreaterThanOrEqual(8);
    for (const p of outline!) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('compiles pressure-responsive dot outlines from the ball-pen curve', () => {
    const dot = (pressure: number): SurfaceModel => ({
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [{ x: 0, y: 0, pressure }],
          width: 4,
        }),
      },
    });
    const outlineOf = (model: SurfaceModel): { x: number; y: number }[] => {
      const item = compileScene(model, registry())[0]!;
      expect(item.kind).toBe('stroke');
      if (item.kind !== 'stroke') return [];
      return [...(item.outline ?? [])];
    };
    const light = outlineOf(dot(0.2));
    const heavy = outlineOf(dot(1));
    expect(light.length).toBeGreaterThanOrEqual(12);
    expect(heavy.length).toBeGreaterThanOrEqual(light.length);
    const meanRadius = (polygon: { x: number; y: number }[]): number =>
      polygon.reduce((sum, p) => sum + Math.hypot(p.x, p.y), 0) /
      polygon.length;
    // Ball-pen curve: width = size·(0.85 + 0.25·pressure).
    expect(meanRadius(light) / meanRadius(heavy)).toBeCloseTo(0.9 / 1.1, 2);
  });

  it('applies defaults for absent style members in the compiled item', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', { points: [sample(5, 5), sample(6, 6)] }),
      },
    };
    const items = compileScene(model, registry());
    expect(items[0]).toMatchObject({ kind: 'stroke', width: 3, rotation: 0 });
    expect('color' in items[0]! && items[0].color !== undefined).toBe(false);
    expect('opacity' in items[0]! && items[0].opacity !== undefined).toBe(
      false,
    );
  });

  it('renders stored brush kinds through their own nib geometry', () => {
    const stroke = (brush: { kind: 'ball' } | { kind: 'fountain' }) =>
      inkStrokeObject('s', {
        points: [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 100, y: 0, pressure: 0.5 },
        ],
        width: 4,
        brush,
      });
    const outlineOf = (
      record: SurfaceObjectRecord,
    ): { x: number; y: number }[] => {
      const item = compileScene(
        {
          formatVersion: 1,
          frame: infiniteFrame(),
          order: ['s'],
          objects: { s: record },
        },
        registry(),
      )[0]!;
      expect(item.kind).toBe('stroke');
      if (item.kind !== 'stroke') return [];
      return [...(item.outline ?? [])];
    };
    // Ball is direction-blind: horizontal and vertical outlines match.
    // Fountain's flat nib is not: across beats along.
    const ballOutline = outlineOf(stroke({ kind: 'ball' }));
    const fountainOutline = outlineOf(stroke({ kind: 'fountain' }));
    expect(ballOutline.length).toBeGreaterThan(0);
    expect(fountainOutline.length).toBeGreaterThan(0);
    expect(fountainOutline).not.toEqual(ballOutline);
  });

  it('hit-tests near the polyline with a width-aware tolerance', () => {
    const record = inkStrokeObject('s', {
      points: [sample(0, 0), sample(100, 0)],
      width: 6,
    });
    const descriptor = registry().get(STROKE_TYPE)!;
    expect(descriptor.hitTest!(record, 50, 2)).toBe(true); // within width/2 + tolerance
    expect(descriptor.hitTest!(record, 50, -4)).toBe(true);
    expect(descriptor.hitTest!(record, 50, 10)).toBe(false);
    expect(descriptor.hitTest!(record, 101.5, 1)).toBe(true); // cap rounding
    expect(descriptor.hitTest!(record, 110, 0)).toBe(false);
  });

  it('rotates around the bounding-box center like every other core type', () => {
    // A vertical bar rotated 90° (clockwise, y-down) becomes horizontal
    // through its bbox center — hit-testing must follow that pivot.
    const record = inkStrokeObject('s', {
      points: [sample(0, 0), sample(0, 100)],
      width: 4,
      rotation: Math.PI / 2,
    });
    const descriptor = registry().get(STROKE_TYPE)!;
    // Center of the sample bbox is (0,50); +90° maps the bar onto the
    // horizontal segment from (-50,50) to (50,50).
    expect(descriptor.hitTest!(record, 48, 50)).toBe(true);
    expect(descriptor.hitTest!(record, -48, 50)).toBe(true);
    expect(descriptor.hitTest!(record, 0, 25)).toBe(false);
    // Conservative brush envelope (ball maxFactor 1.1 → half-width 2.2).
    expect(descriptor.boundsOf!(record)).toEqual({
      x: -2.2,
      y: -2.2,
      width: 4.4,
      height: 104.4,
    });
  });

  it('keeps the rendered outline inside the conservative envelope', () => {
    // Rendered ink, culling, hit-testing, and selection agree (repair
    // pass item 2): the compiled polygon never escapes boundsOf, across
    // brush kinds, pressure, tilt, and flat-nib direction.
    const brushes = [
      { kind: 'ball' },
      { kind: 'fountain' },
      { kind: 'brush' },
      { kind: 'pencil' },
      { kind: 'highlighter' },
    ] as const;
    for (const brush of brushes) {
      const record = inkStrokeObject('s', {
        points: [
          { x: 0, y: 0, pressure: 0.1, tilt: { x: 0.7, y: 0.2 }, twist: 1 },
          { x: 50, y: 30, pressure: 1, tilt: { x: -0.5, y: 0.6 }, twist: -2 },
          { x: 100, y: 0, pressure: 0.5 },
        ],
        width: 6,
        brush,
      });
      const descriptor = registry().get(STROKE_TYPE)!;
      const bounds = descriptor.boundsOf!(record)!;
      const compiled = inkStrokeCompiledBounds(record)!;
      expect(compiled.x).toBeGreaterThanOrEqual(bounds.x - 1e-9);
      expect(compiled.y).toBeGreaterThanOrEqual(bounds.y - 1e-9);
      expect(compiled.x + compiled.width).toBeLessThanOrEqual(
        bounds.x + bounds.width + 1e-9,
      );
      expect(compiled.y + compiled.height).toBeLessThanOrEqual(
        bounds.y + bounds.height + 1e-9,
      );
      // Hit-testing covers the rendered outline: every polygon vertex
      // hits, and points just outside the envelope miss.
      const item = compileScene(
        {
          formatVersion: 1,
          frame: infiniteFrame(),
          order: ['s'],
          objects: { s: record },
        },
        registry(),
      )[0]!;
      expect(item.kind).toBe('stroke');
      if (item.kind !== 'stroke') continue;
      for (const p of item.outline ?? []) {
        expect(descriptor.hitTest!(record, p.x, p.y)).toBe(true);
      }
      expect(descriptor.hitTest!(record, bounds.x - 10, bounds.y - 10)).toBe(
        false,
      );
    }
  });
});

import { lineObject } from './model.js';

describe('line object type (academic charts)', () => {
  const registry = () => createDefaultSurfaceObjectTypeRegistry();
  const LINE_TYPE = 'froglight.line';

  it('joins the closed core set and constructs canonical records', () => {
    expect(SURFACE_OBJECT_TYPES.line).toBe(LINE_TYPE);
    expect(isCoreSurfaceObjectType(LINE_TYPE)).toBe(true);
    const record = lineObject('l1', {
      x: 10,
      y: 10,
      x2: 60,
      y2: 40,
      color: '#37352f',
      width: 2,
      arrows: 'end',
    });
    expect(Object.keys(record)).toEqual([
      'id',
      'type',
      'x',
      'y',
      'x2',
      'y2',
      'color',
      'width',
      'arrows',
    ]);
    const minimal = lineObject('l2', { x: 0, y: 0, x2: 5, y2: 5 });
    expect(Object.keys(minimal)).toEqual(['id', 'type', 'x', 'y', 'x2', 'y2']);
  });

  it('validates structure: endpoints required, style members sane', () => {
    const bad = (member: Record<string, unknown>) =>
      isValidCoreSurfaceObject({
        id: 'l',
        type: LINE_TYPE,
        x: 0,
        y: 0,
        x2: 1,
        y2: 1,
        ...member,
      } as never);
    expect(bad({})).toBe(true);
    expect(bad({ x2: 'east' })).toBe(false);
    expect(bad({ width: 0 })).toBe(false);
    expect(bad({ opacity: 2 })).toBe(false);
    expect(bad({ arrows: 'sideways' })).toBe(false);
    expect(bad({ color: 7 })).toBe(false);
  });

  it('stores connector bindings and path as additive members', () => {
    const record = lineObject('c1', {
      x: 0,
      y: 0,
      x2: 100,
      y2: 50,
      path: 'orthogonal',
      source: { objectId: 'a', anchor: 'e' },
      target: { objectId: 'b', anchor: 'w' },
    });
    expect(Object.keys(record)).toEqual([
      'id',
      'type',
      'x',
      'y',
      'x2',
      'y2',
      'path',
      'source',
      'target',
    ]);
    expect(isValidCoreSurfaceObject(record)).toBe(true);
    // Unbound lines stay valid without any connector members.
    expect(
      isValidCoreSurfaceObject(lineObject('l', { x: 0, y: 0, x2: 1, y2: 1 })),
    ).toBe(true);
    const bad = (member: Record<string, unknown>) =>
      isValidCoreSurfaceObject({
        id: 'l',
        type: LINE_TYPE,
        x: 0,
        y: 0,
        x2: 1,
        y2: 1,
        ...member,
      } as never);
    expect(bad({ path: 'squiggle' })).toBe(false);
    expect(bad({ source: { objectId: '', anchor: 'e' } })).toBe(false);
    expect(bad({ source: { objectId: 'a', anchor: 'north-east' } })).toBe(
      false,
    );
    expect(bad({ source: 'a' })).toBe(false);
    expect(bad({ target: { objectId: 'b' } })).toBe(false);
  });

  it('round-trips bound connectors byte-stably', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['c'],
      objects: {
        c: lineObject('c', {
          x: 0,
          y: 0,
          x2: 100,
          y2: 50,
          path: 'curved',
          arrows: 'end',
          source: { objectId: 'a', anchor: 'center' },
        }),
      },
    };
    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.objects.c).toEqual(model.objects.c);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      utf8Decode(bytes),
    );
  });

  it('compiles straight lines without routed points', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['l'],
      objects: {
        l: lineObject('l', { x: 0, y: 0, x2: 100, y2: 50, width: 2 }),
      },
    };
    const item = compileScene(model, registry())[0]!;
    expect(item.kind).toBe('line');
    if (item.kind !== 'line') return;
    expect(item.path).toBeUndefined();
    expect(item.points).toBeUndefined();
  });

  it('compiles orthogonal connectors to elbow waypoints', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['c'],
      objects: {
        c: lineObject('c', {
          x: 0,
          y: 0,
          x2: 100,
          y2: 50,
          path: 'orthogonal',
          width: 2,
        }),
      },
    };
    const item = compileScene(model, registry())[0]!;
    expect(item.kind).toBe('line');
    if (item.kind !== 'line') return;
    expect(item.path).toBe('orthogonal');
    expect(item.points).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 50 },
    ]);
  });

  it('compiles curved connectors to sampled arcs covering the bulge', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['c'],
      objects: {
        c: lineObject('c', {
          x: 0,
          y: 0,
          x2: 100,
          y2: 0,
          path: 'curved',
          width: 2,
        }),
      },
    };
    const item = compileScene(model, registry())[0]!;
    expect(item.kind).toBe('line');
    if (item.kind !== 'line') return;
    expect(item.points!.length).toBeGreaterThan(2);
    expect(item.points![0]).toEqual({ x: 0, y: 0 });
    expect(item.points![item.points!.length - 1]).toEqual({ x: 100, y: 0 });
    // Bounds cover the perpendicular bulge, not just the endpoints.
    expect(item.bounds.y).toBeLessThan(0);
    expect(item.bounds.y + item.bounds.height).toBeGreaterThan(0);
  });

  it('round-trips through the shared codec byte-stably', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['l'],
      objects: {
        l: lineObject('l', { x: 5, y: 6, x2: 55, y2: 36, arrows: 'end' }),
      },
    };
    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      utf8Decode(bytes),
    );
  });

  it('compiles to a line draw item with endpoint bounds and hit-tests the segment', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['l'],
      objects: { l: lineObject('l', { x: 0, y: 0, x2: 100, y2: 0, width: 4 }) },
    };
    const items = compileScene(model, registry());
    expect(items[0]).toMatchObject({
      kind: 'line',
      objectId: 'l',
      x: 0,
      y: 0,
      x2: 100,
      y2: 0,
      width: 4,
    });
    const descriptor = registry().get(LINE_TYPE)!;
    expect(descriptor.hitTest!(model.objects.l!, 50, 3)).toBe(true);
    expect(descriptor.hitTest!(model.objects.l!, 50, 9)).toBe(false);
    // Translation moves both endpoints.
    descriptor.translate!(model.objects.l!, 5, 7);
    expect(model.objects.l!.x).toBe(5);
    expect(model.objects.l!.y).toBe(7);
    expect(model.objects.l!.x2).toBe(105);
    expect(model.objects.l!.y2).toBe(7);
  });
});
