import { describe, expect, it, vi } from 'vitest';
import polygonClipping from 'polygon-clipping';
import type { Point } from '../geometry.js';
import { BRUSH_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  addErasure,
  addErasureBatch,
  capsuleFootprint,
  erasureContours,
  hitVisible,
  pointVisible,
  validErasure,
  MAX_ERASURE_VERTICES,
  ERASURE_SAGITTA,
  type InkErasure,
} from './erasure.js';

function box(x: number, y: number, width: number, height: number): Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}
const source = box(0, 0, 100, 30);

describe('semantic ink erasure', () => {
  it('honors polygon roles regardless of stored mask ring orientation', () => {
    const exterior = box(20, 5, 60, 20),
      hole = box(40, 10, 20, 10);
    for (const outer of [exterior, [...exterior].reverse()])
      for (const inner of [hole, [...hole].reverse()]) {
        const contours = erasureContours(source, [[outer, inner]]);
        expect(pointVisible(contours, { x: 30, y: 15 })).toBe(false);
        expect(pointVisible(contours, { x: 50, y: 15 })).toBe(true);
        expect(pointVisible(contours, { x: 10, y: 15 })).toBe(true);
      }
  });

  it('recognizes a crossing of cached visible contours without another polygon intersection', () => {
    const first = addErasure(source, undefined, box(40, -20, 20, 70));
    const intersection = vi.spyOn(polygonClipping, 'intersection');
    try {
      const next = addErasureBatch(
        source,
        first.erasure,
        [box(70, -20, 10, 70)],
        first.contours,
      );
      expect(next.changed).toBe(true);
      expect(intersection).not.toHaveBeenCalled();
      expect(next.contours).toEqual(erasureContours(source, next.erasure));
      expect(pointVisible(next.contours, { x: 75, y: 15 })).toBe(false);
      expect(pointVisible(next.contours, { x: 65, y: 15 })).toBe(true);
    } finally {
      intersection.mockRestore();
    }
  });

  it('matches exact contact around holes, containment, tangencies and zero-area cuts', () => {
    const first = addErasure(source, undefined, box(40, 10, 20, 10));
    const ring = (points: readonly Point[]) =>
      points.map((p): [number, number] => [p.x, p.y]);
    const visible = polygonClipping.difference(
      [ring(source)],
      first.erasure.map((polygon) => polygon.map(ring)),
    );
    const footprints = [
      ...Array.from({ length: 45 }, (_, i) =>
        box((i % 9) * 15 - 10, Math.floor(i / 9) * 10 - 5, 12, 10),
      ),
      box(45, 12, 5, 5),
      box(100, 0, 10, 10),
      box(-10, -10, 120, 50),
      [
        { x: 50, y: -10 },
        { x: 50, y: 40 },
        { x: 50, y: -10 },
      ],
    ];
    for (const footprint of footprints) {
      const contact =
        polygonClipping.intersection(visible, [ring(footprint)]).length > 0;
      const next = addErasureBatch(
        source,
        first.erasure,
        [footprint],
        first.contours,
      );
      expect(next.changed).toBe(contact);
      expect(next.contours).toEqual(erasureContours(source, next.erasure));
      if (!contact) expect(next.erasure).toBe(first.erasure);
    }
  });

  it('unions densely overlapping capsules without losing a confirmed sweep', () => {
    const footprints = Array.from({ length: 20 }, (_, i) =>
      capsuleFootprint({ x: 50, y: -20 + i * 2 }, { x: 50, y: -18 + i * 2 }, 3),
    );
    const result = addErasureBatch(source, undefined, footprints);
    expect(result.changed).toBe(true);
    expect(pointVisible(result.contours, { x: 50, y: 15 })).toBe(false);
    expect(pointVisible(result.contours, { x: 30, y: 15 })).toBe(true);
    expect(erasureContours(source, result.erasure)).toEqual(result.contours);
  });

  it('erases a capsule chain at large coordinates without sweep-line errors', () => {
    const outline = box(540, 1400, 140, 120);
    let x = 608,
      y = 1447;
    const footprints = Array.from({ length: 30 }, (_, i) => {
      const next = { x: x + Math.sin(i * 1.7) * 0.4, y: y + 1.1 };
      const ring = capsuleFootprint({ x, y }, next, 5);
      x = next.x;
      y = next.y;
      return ring;
    });
    const saved = JSON.stringify({ outline, footprints });
    const result = addErasureBatch(outline, undefined, footprints);
    expect(result.changed).toBe(true);
    expect(pointVisible(result.contours, { x: 608, y: 1460 })).toBe(false);
    expect(pointVisible(result.contours, { x: 545, y: 1405 })).toBe(true);
    expect(erasureContours(outline, result.erasure)).toEqual(result.contours);
    expect(JSON.stringify({ outline, footprints })).toBe(saved);
  });

  it('keeps erasing when the cut union throws, without mutating inputs', () => {
    const union = vi.spyOn(polygonClipping, 'union');
    const outline = box(540, 1400, 140, 120);
    const footprints = [
      capsuleFootprint({ x: 600, y: 1440 }, { x: 602, y: 1450 }, 5),
      capsuleFootprint({ x: 602, y: 1450 }, { x: 604, y: 1460 }, 5),
    ];
    const saved = JSON.stringify({ outline, footprints });
    union.mockImplementation(() => {
      throw new Error(
        'Unable to find segment #1652904 [608.16, 1447.61] -> [608.25, 1445.95] in SweepLine tree.',
      );
    });
    try {
      const result = addErasureBatch(outline, undefined, footprints);
      expect(result.changed).toBe(true);
      expect(pointVisible(result.contours, { x: 602, y: 1452 })).toBe(false);
      expect(pointVisible(result.contours, { x: 545, y: 1405 })).toBe(true);
      // The un-normalized fallback mask still hides the same area on rebuild.
      expect(
        pointVisible(erasureContours(outline, result.erasure), {
          x: 602,
          y: 1452,
        }),
      ).toBe(false);
      expect(JSON.stringify({ outline, footprints })).toBe(saved);
    } finally {
      union.mockRestore();
    }
  });

  it('reuses one cut union for stacked strokes sharing footprint objects', () => {
    const union = vi.spyOn(polygonClipping, 'union');
    const strips = Array.from({ length: 6 }, (_, i) =>
      box(540, 1400 + i * 18, 140, 10),
    );
    const shared = [
      capsuleFootprint({ x: 600, y: 1395 }, { x: 612, y: 1520 }, 5),
      capsuleFootprint({ x: 612, y: 1520 }, { x: 604, y: 1530 }, 5),
    ];
    const callsBefore = union.mock.calls.length;
    const results = strips.map((outline) =>
      addErasureBatch(outline, undefined, shared),
    );
    for (const result of results) expect(result.changed).toBe(true);
    // One shared sweep for every stacked line: a single cut union.
    expect(union.mock.calls.length - callsBefore).toBe(1);
    union.mockRestore();
  });

  it('cuts a hole using nonzero contours, and honors tolerance at its boundary', () => {
    const cut = addErasure(source, undefined, box(40, 10, 20, 10));
    expect(cut.changed).toBe(true);
    expect(cut.contours).toHaveLength(2);
    expect(pointVisible(cut.contours, { x: 50, y: 15 })).toBe(false);
    expect(pointVisible(cut.contours, { x: 35, y: 15 })).toBe(true);
    expect(hitVisible(cut.contours, { x: 41, y: 15 }, 2)).toBe(true);
    expect(hitVisible(cut.contours, { x: 50, y: 15 }, 2)).toBe(false);
    expect(
      erasureContours(source, JSON.parse(JSON.stringify(cut.erasure))),
    ).toEqual(cut.contours);
  });

  it('preserves source boundaries and pressure/taper geometry away from a precise cut', () => {
    const original = compileInkStroke(
      Array.from({ length: 201 }, (_, x) => ({
        x,
        y: Math.sin(x / 13) * 20,
        pressure: 0.5 + Math.sin(x / 6) * 0.4,
        dt: x * 8,
      })),
      { ...BRUSH_PEN_BRUSH, size: 10 },
    );
    const saved = JSON.stringify(original);
    const footprint = capsuleFootprint(
      { x: 100, y: -30 },
      { x: 100, y: 30 },
      3,
    );
    const result = addErasure(original.polygon, undefined, footprint);
    expect(result.changed).toBe(true);
    const retained = result.contours.flat();
    for (const p of original.polygon.filter(
      (point) => point.x < 80 || point.x > 120,
    )) {
      expect(retained.some((other) => p.x === other.x && p.y === other.y)).toBe(
        true,
      );
    }
    expect(JSON.stringify(original)).toBe(saved);
    expect(pointVisible(result.contours, { x: 100, y: 20 })).toBe(false);
  });

  it('recognizes misses, edge touches, and already-erased cuts without changing identity', () => {
    const current: InkErasure = [[box(40, 0, 20, 30)]];
    for (const footprint of [
      box(45, 5, 5, 5),
      box(120, 0, 10, 10),
      box(100, 0, 10, 10),
    ]) {
      const result = addErasure(source, current, footprint);
      expect(result.changed).toBe(false);
      expect(result.erasure).toBe(current);
    }
  });

  it('stores complete tool footprints and stabilizes repeated cuts', () => {
    const footprint = box(40, -20, 20, 70);
    let result = addErasure(source, undefined, footprint);
    const first = result.erasure;
    expect(Math.min(...first.flat(2).map((point) => point.y))).toBe(-20);
    for (let i = 0; i < 50; i++) {
      result = addErasure(source, result.erasure, footprint);
      expect(result.changed).toBe(false);
      expect(result.erasure).toBe(first);
    }
    expect(result.contours).toHaveLength(2);
  });

  it('handles complete removal, zero-area source, and self-crossing nonzero source', () => {
    expect(
      addErasure(source, undefined, box(-1, -1, 102, 32)).contours,
    ).toEqual([]);
    expect(
      addErasure(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
        undefined,
        source,
      ).changed,
    ).toBe(false);
    const crossed = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ];
    const contours = erasureContours(crossed);
    expect(pointVisible(contours, { x: 5, y: 2 })).toBe(true);
    expect(pointVisible(contours, { x: 1, y: 5 })).toBe(false);
  });

  it('supports affine transformation of canonical footprints with the source', () => {
    const original = addErasure(
      source,
      undefined,
      capsuleFootprint({ x: 50, y: 15 }, { x: 50, y: 15 }, 5),
    );
    const transform = (p: Point): Point => ({ x: p.x * 3 + 7, y: p.y / 2 - 9 });
    const masks = original.erasure.map((polygon) =>
      polygon.map((ring) => ring.map(transform)),
    );
    const contours = erasureContours(source.map(transform), masks);
    expect(pointVisible(contours, transform({ x: 50, y: 15 }))).toBe(false);
    expect(pointVisible(contours, transform({ x: 40, y: 15 }))).toBe(true);
  });

  it('bounds disc/capsule chord error and validates finite input', () => {
    for (const radius of [0.001, 1, 100, 1000]) {
      const ring = capsuleFootprint({ x: 0, y: 0 }, { x: 30, y: 0 }, radius);
      const semicircle = ring.slice(0, ring.length / 2);
      for (let i = 1; i < semicircle.length; i++) {
        const a = semicircle[i - 1]!,
          b = semicircle[i]!;
        const sagitta =
          radius - Math.hypot((a.x + b.x) / 2 - 30, (a.y + b.y) / 2);
        expect(sagitta).toBeLessThanOrEqual(ERASURE_SAGITTA + 1e-10);
      }
    }
    expect(validErasure([])).toBe(true);
    for (const invalid of [
      null,
      [[]],
      [[[]]],
      [[[{ x: Infinity, y: 0 }]]],
      [[box(1e9, 0, 1, 1)]],
      [
        [
          Array.from({ length: MAX_ERASURE_VERTICES + 1 }, () => ({
            x: 0,
            y: 0,
          })),
        ],
      ],
    ]) {
      expect(validErasure(invalid)).toBe(false);
    }
    expect(() =>
      capsuleFootprint({ x: 0, y: 0 }, { x: 0, y: 0 }, 1e20),
    ).toThrow(expect.objectContaining({ code: 'FORMAT_LIMIT_EXCEEDED' }));
  });

  it('rejects union output above the vertex cap without mutating either input', () => {
    const current = Array.from({ length: 4000 }, (_, i) => [
      box(i * 3, 0, 1, 1),
    ]);
    const footprint = box(12001, 0, 1, 1);
    const saved = JSON.stringify(current);
    expect(validErasure(current)).toBe(true);
    expect(() => addErasure(box(-1, -1, 13000, 4), current, footprint)).toThrow(
      expect.objectContaining({ code: 'FORMAT_LIMIT_EXCEEDED' }),
    );
    expect(JSON.stringify(current)).toBe(saved);
    expect(footprint).toEqual(box(12001, 0, 1, 1));
  });
});
