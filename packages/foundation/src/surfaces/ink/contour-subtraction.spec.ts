import { describe, expect, it } from 'vitest';
import { compileInkStroke } from './compiler.js';
import { INK_BRUSH_KINDS, brushPresetForKind } from './brush.js';
import {
  addErasureBatch,
  capsuleFootprint,
  erasureContours,
  pointVisible,
} from './erasure.js';

// Probe the production fill rule directly: a retained point must be in the
// source and outside every confirmed capsule, including overlapping loops.
describe('local contour subtraction', () => {
  it.each(INK_BRUSH_KINDS)(
    '%s preserves nonzero winding through repeated loop cuts',
    (kind) => {
      const source = compileInkStroke(
        Array.from({ length: 201 }, (_, i) => ({
          x: 100 + 35 * Math.cos(i / 12),
          y: 100 + 30 * Math.sin(i / 12),
          pressure: 0.5 + 0.4 * Math.sin(i / 9),
          dt: i * 8,
        })),
        { ...brushPresetForKind(kind), size: 12 },
      ).polygon;
      const footprints = [
        capsuleFootprint({ x: 110, y: 60 }, { x: 110, y: 140 }, 3),
        capsuleFootprint({ x: 60, y: 110 }, { x: 140, y: 110 }, 4),
        capsuleFootprint({ x: 75, y: 75 }, { x: 125, y: 125 }, 2),
      ];
      const result = addErasureBatch(source, undefined, footprints);
      const rebuilt = erasureContours(source, result.erasure);
      for (let x = 55.137; x < 146; x += 2.93)
        for (let y = 55.379; y < 146; y += 3.17) {
          const p = { x, y };
          const expected =
            pointVisible([source], p) &&
            !footprints.some((f) => pointVisible([f], p));
          expect(pointVisible(result.contours, p), `${x},${y}`).toBe(expected);
          expect(pointVisible(rebuilt, p), `rebuilt ${x},${y}`).toBe(expected);
        }
    },
  );
});

it('matches source-minus-mask for seeded curved paths and repeated cuts', () => {
  let seed = 812379;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let run = 0; run < 24; run++) {
    const source = compileInkStroke(
      Array.from({ length: 30 }, (_, i) => ({
        x: 50 + i * 3,
        y: 80 + random() * 50,
        pressure: 0.2 + random() * 0.8,
        dt: i * 8,
      })),
      { ...brushPresetForKind('brush'), size: 8 },
    ).polygon;
    const footprints = Array.from({ length: 4 }, () =>
      capsuleFootprint(
        { x: 60 + random() * 60, y: 70 + random() * 60 },
        { x: 60 + random() * 60, y: 70 + random() * 60 },
        2 + random() * 5,
      ),
    );
    let previous: ReturnType<typeof addErasureBatch> | undefined;
    for (const footprint of footprints)
      previous = addErasureBatch(
        source,
        previous?.erasure,
        [footprint],
        previous?.contours,
      );
    const rebuilt = erasureContours(source, previous!.erasure);
    for (let i = 0; i < 100; i++) {
      const p = { x: 40 + random() * 110, y: 65 + random() * 80 };
      const expected =
        pointVisible([source], p) &&
        !footprints.some((f) => pointVisible([f], p));
      expect(pointVisible(previous!.contours, p), `seeded ${run}, ${i}`).toBe(
        expected,
      );
      expect(pointVisible(rebuilt, p), `rebuilt ${run}, ${i}`).toBe(expected);
    }
  }
});
