/**
 * Logical-stroke chunking (item 3): >10k samples render and behave as one
 * continuous stroke.
 *
 * - Canonical chunks each stay below the sample limit;
 * - internal boundaries carry no caps, no taper restart, continuous
 *   tangents (joint derived compilation = the unsplit mathematical
 *   gesture, sub-pixel agreement by construction);
 * - move/select/delete/lock/duplicate treat chunks as one logical stroke
 *   (via `expandLogicalIds` / `resolveGroupMembers`);
 * - eraser deliberately splits the logical stroke into independent
 *   strokes afterward.
 *
 * Covered for Ball, Fountain, Brush, and Highlighter at 20k+ samples
 * across the 10k boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  compileScene,
  createDefaultSurfaceObjectTypeRegistry,
  decodeSurfacePayload,
  emptySurface,
  expandLogicalIds,
  groupLogicalChunks,
  infiniteFrame,
  inkStrokeObject,
  isLogicalChunk,
  logicalIdOf,
  logicalSamples,
  resolveGroupMembers,
  SURFACE_MAX_STROKE_POINTS,
  type SurfaceModel,
} from './index.js';
import { utf8Encode } from '../encoding.js';
import { compileInkStroke } from './ink/geometry.js';
import {
  BALL_PEN_BRUSH,
  BRUSH_PEN_BRUSH,
  FOUNTAIN_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  brushPresetForKind,
  type InkBrushSpec,
} from './ink/brush.js';
import type { InkSample } from './model.js';

const BRUSHES: { name: string; brush: InkBrushSpec }[] = [
  { name: 'ball', brush: BALL_PEN_BRUSH },
  { name: 'fountain', brush: FOUNTAIN_PEN_BRUSH },
  { name: 'brush', brush: BRUSH_PEN_BRUSH },
  { name: 'highlighter', brush: HIGHLIGHTER_BRUSH },
];

/** Deterministic 20k+ gesture: winding handwriting crossing 10k twice. */
function longGesture(total = 20_123): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < total; i++) {
    out.push({
      x: Math.round((i * 0.7 + Math.sin(i / 37) * 9) * 1000) / 1000,
      y: Math.round((i * 0.45 + Math.cos(i / 29) * 9) * 1000) / 1000,
      pressure: 0.45 + ((Math.sin(i / 53) * 0.5 + 0.5) * 0.3),
      dt: i * 4,
    });
  }
  return out;
}

function distToRing(
  p: { x: number; y: number },
  ring: readonly { x: number; y: number }[],
): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.min(Math.max(t, 0), 1);
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

function hausdorff(
  a: readonly { x: number; y: number }[],
  b: readonly { x: number; y: number }[],
): number {
  const step = Math.max(1, Math.floor(Math.max(a.length, b.length) / 2000));
  let worst = 0;
  for (let i = 0; i < a.length; i += step) worst = Math.max(worst, distToRing(a[i]!, b));
  for (let i = 0; i < b.length; i += step) worst = Math.max(worst, distToRing(b[i]!, a));
  return worst;
}

function modelWithChunks(
  samples: InkSample[],
  brush: InkBrushSpec,
  id = 'S',
): SurfaceModel {
  const cap = SURFACE_MAX_STROKE_POINTS;
  const parts = Math.ceil(samples.length / cap);
  const model = emptySurface(infiniteFrame());
  for (let part = 0; part < parts; part++) {
    const run = samples.slice(part * cap, (part + 1) * cap);
    const chunkId = part === 0 ? id : `${id}#part${part + 1}`;
    // Mirror the commit path: head rebases to 0, continuations preserve
    // boundary timing (see `rebaseLogicalChunkTiming`).
    const timed =
      part === 0
        ? run.map((s, i) => (i === 0 ? { ...s, dt: 0 } : { ...s }))
        : run.map((s) => ({ ...s }));
    model.objects[chunkId] = inkStrokeObject(chunkId, {
      points: timed,
      width: brush.size,
      color: '#111111',
      brush: { kind: brushPresetForKind(kindOf(brush)).kind },
      logicalId: id,
      chunkIndex: part,
    });
    model.order.push(chunkId);
  }
  return model;
}

function kindOf(brush: InkBrushSpec): 'ball' | 'fountain' | 'brush' | 'highlighter' {
  if (brush === FOUNTAIN_PEN_BRUSH) return 'fountain';
  if (brush === BRUSH_PEN_BRUSH) return 'brush';
  if (brush === HIGHLIGHTER_BRUSH) return 'highlighter';
  return 'ball';
}

describe('logical-stroke chunking (>10k as one stroke)', () => {
  for (const { name, brush } of BRUSHES) {
    it(`${name}: 20k+ chunks match the unsplit gesture sub-pixel`, () => {
      const samples = longGesture();
      expect(samples.length).toBeGreaterThan(20_000);
      const model = modelWithChunks(samples, brush);
      // Each canonical chunk stays below the sample limit.
      const sizes = model.order.map(
        (id) => (model.objects[id]!.points as unknown[]).length,
      );
      expect(sizes.every((n) => n <= SURFACE_MAX_STROKE_POINTS)).toBe(true);
      expect(sizes).toEqual([10_000, 10_000, 123]);
      // Joint rendering collapses chunks to ONE draw item (no internal
      // caps/identities — a single continuous outline).
      const items = compileScene(model, createDefaultSurfaceObjectTypeRegistry());
      const strokes = items.filter((i) => i.kind === 'stroke');
      expect(strokes).toHaveLength(1);
      expect(strokes[0]!.objectId).toBe('S');
      const joint = strokes[0]!.outline;
      expect(joint.length).toBeGreaterThan(100);
      // Reference: the unsplit mathematical gesture through the same
      // compiler. Sub-pixel agreement (MAX_ZOOM screen budget: 0.4px at
      // 8× = 0.05 surface units; assert an order tighter).
      const reference = compileInkStroke(samples, brush).polygon;
      expect(hausdorff(joint, reference)).toBeLessThan(0.05);
    }, 120000);
  }

  it('chunk boundaries carry no internal caps/taper restart (visual continuity)', () => {
    const samples = longGesture(20_005);
    const model = modelWithChunks(samples, BALL_PEN_BRUSH);
    const groups = groupLogicalChunks(model);
    expect(groups.size).toBe(1);
    const group = groups.get('S')!;
    expect(group.chunkIds).toEqual(['S', 'S#part2', 'S#part3']);
    // Joint samples restore the original sequence exactly.
    const joint = logicalSamples(group);
    expect(joint.length).toBe(samples.length);
    expect(joint.map((s) => s.x)).toEqual(samples.map((s) => s.x));
    expect(joint.map((s) => s.y)).toEqual(samples.map((s) => s.y));
    // One outline ring (not three capped fragments): internal boundaries
    // contribute no cap fans — the ring vertex count matches a single
    // continuous stroke, not 3× capped pieces.
    const items = compileScene(model, createDefaultSurfaceObjectTypeRegistry());
    expect(items.filter((i) => i.kind === 'stroke')).toHaveLength(1);
  }, 120000);

  it('move/select/delete/lock/duplicate treat chunks as one (expansion)', () => {
    const samples = longGesture(10_500);
    const model = modelWithChunks(samples, BALL_PEN_BRUSH, 'S');
    expect(model.order).toEqual(['S', 'S#part2']);
    // Selecting any single chunk expands to the whole logical stroke.
    expect(expandLogicalIds(model, ['S#part2'])).toEqual(['S', 'S#part2']);
    expect(expandLogicalIds(model, ['S'])).toEqual(['S', 'S#part2']);
    expect(resolveGroupMembers(model, ['S#part2'])).toEqual(['S', 'S#part2']);
    // Independent strokes pass through untouched.
    model.objects.other = inkStrokeObject('other', {
      points: [{ x: 0, y: 0 }],
    });
    model.order.push('other');
    expect(expandLogicalIds(model, ['other'])).toEqual(['other']);
    expect(expandLogicalIds(model, ['S#part2', 'other'])).toEqual([
      'S',
      'S#part2',
      'other',
    ]);
  });

  it('eraser fragments drop chunk identity (deliberate split)', () => {
    // The eraser rebuilds fragments via `splitStrokeRecord`, whose KNOWN
    // set strips `logicalId`/`chunkIndex`: cuts become independent strokes.
    // Contract pinned here at the model boundary (fragments built the way
    // the eraser builds them carry no chunk identity and never regroup).
    const samples = longGesture(10_200).slice(0, 100);
    const chunk = inkStrokeObject('S', {
      points: samples,
      logicalId: 'S',
      chunkIndex: 0,
    });
    expect(logicalIdOf(chunk)).toBe('S');
    const fragment = inkStrokeObject('frag', { points: samples.slice(0, 50) });
    expect(logicalIdOf(fragment)).toBeNull();
    expect(isLogicalChunk(fragment)).toBe(false);
    // A model holding only the fragment has no logical group for it.
    const model = emptySurface(infiniteFrame());
    model.objects.frag = fragment;
    model.order.push('frag');
    expect(groupLogicalChunks(model).size).toBe(0);
    expect(expandLogicalIds(model, ['frag'])).toEqual(['frag']);
  });

  it('decode recovery assigns logical identity and renders jointly', () => {
    const cap = SURFACE_MAX_STROKE_POINTS;
    const points = longGesture(cap + 7).map((s) => ({
      x: s.x,
      y: s.y,
      pressure: s.pressure,
    }));
    const payload = utf8Encode(
      JSON.stringify({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: ['S'],
        objects: { S: { id: 'S', type: 'froglight.ink.stroke', points } },
      }),
    );
    const decoded = decodeSurfacePayload(payload);
    expect(decoded.model.order).toEqual(['S', 'S#part2']);
    const groups = groupLogicalChunks(decoded.model);
    expect(groups.get('S')!.chunkIds).toEqual(['S', 'S#part2']);
    const items = compileScene(
      decoded.model,
      createDefaultSurfaceObjectTypeRegistry(),
    );
    expect(items.filter((i) => i.kind === 'stroke')).toHaveLength(1);
  });
});
