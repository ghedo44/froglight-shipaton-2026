import { describe, expect, it } from 'vitest';
import { compileInkStroke } from './compiler.js';
import { BRUSH_PEN_BRUSH } from './brush.js';
import {
  addErasureBatch,
  capsuleFootprint,
  erasureContours,
} from './erasure.js';

describe('profile very long strokes', () => {
  it('scales outline and history', () => {
    const samples = Array.from({ length: 15000 }, (_, i) => ({
      x: 50 + i * 1.2,
      y: 400 + Math.sin(i / 25) * 30 + Math.sin(i / 7) * 4,
      pressure: 0.5 + 0.3 * Math.sin(i / 40),
      dt: i * 8,
    }));
    const compiled = compileInkStroke(samples, {
      ...BRUSH_PEN_BRUSH,
      size: 10,
    });
    console.log('outline verts:', compiled.polygon.length);
    const outline = compiled.polygon;

    const footprints = [
      capsuleFootprint({ x: 1000, y: 300 }, { x: 1010, y: 500 }, 6),
      capsuleFootprint({ x: 1010, y: 500 }, { x: 1020, y: 350 }, 6),
    ];
    let t0 = performance.now();
    const r1 = addErasureBatch(outline, undefined, footprints);
    console.log(`first batch: ${(performance.now() - t0).toFixed(1)}ms`);

    // Force a huge history: 400 stored cuts spread along the stroke.
    let history = r1.erasure;
    let contours = r1.contours;
    t0 = performance.now();
    for (let i = 0; i < 400; i++) {
      const x = 100 + (i % 100) * 150;
      const far = capsuleFootprint(
        { x, y: 300 },
        { x: x + 8, y: 500 },
        5,
      );
      const step = addErasureBatch(outline, history, [far], contours);
      history = step.erasure;
      contours = step.contours;
    }
    console.log(
      `accumulate 400: ${(performance.now() - t0).toFixed(1)}ms polys=${history.length} verts=${history.flat(2).length}`,
    );

    const coveredCut = [
      capsuleFootprint({ x: 100, y: 300 }, { x: 108, y: 500 }, 5),
    ];
    t0 = performance.now();
    const r4 = addErasureBatch(outline, history, coveredCut, contours);
    console.log(
      `covered vs huge history: ${(performance.now() - t0).toFixed(1)}ms changed=${r4.changed}`,
    );

    const freshCut = [
      capsuleFootprint({ x: 60, y: 300 }, { x: 68, y: 500 }, 5),
    ];
    t0 = performance.now();
    const r5 = addErasureBatch(outline, history, freshCut, contours);
    console.log(
      `fresh cut vs huge history: ${(performance.now() - t0).toFixed(1)}ms changed=${r5.changed}`,
    );

    t0 = performance.now();
    const rebuilt = erasureContours(outline, history);
    console.log(
      `rebuild huge: ${(performance.now() - t0).toFixed(1)}ms contours=${rebuilt.length}`,
    );
    expect(true).toBe(true);
  });
});
