/**
 * Pen-gesture recognizers (writing-experience upgrade, slice 7): pure,
 * deterministic fits over confirmed samples — draw-and-hold shapes,
 * scribble-to-erase, circle-to-lasso. Thresholds are exported constants;
 * every boundary below is pinned by a test.
 */

import { describe, expect, it } from 'vitest';
import {
  GESTURE_THRESHOLDS,
  recognizeArrow,
  recognizeCircle,
  recognizeEllipse,
  recognizeLine,
  recognizeRectangle,
  recognizeScribble,
  recognizeShape,
} from './gestures.js';
import type { InkSample } from '../model.js';

function pts(list: Array<[number, number]>): InkSample[] {
  return list.map(([x, y]) => ({ x, y }));
}

function straight(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  n: number,
  wobble = 0,
): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const across = Math.sin(i * 2.1) * wobble;
    out.push({
      x: x1 + (x2 - x1) * t - across * (y2 - y1),
      y: y1 + (y2 - y1) * t + across * (x2 - x1),
    });
  }
  return out;
}

function circleSamples(
  cx: number,
  cy: number,
  r: number,
  n: number,
  sweep = Math.PI * 2,
): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(n - 1, 1)) * sweep;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

describe('recognizeLine', () => {
  it('fits a straight stroke to its endpoints', () => {
    const fit = recognizeLine(straight(0, 0, 100, 0, 9));
    expect(fit).toMatchObject({ kind: 'line', x: 0, y: 0, x2: 100, y2: 0 });
  });

  it('tolerates small handwriting wobble', () => {
    expect(recognizeLine(straight(0, 0, 100, 0, 9, 0.01))?.kind).toBe('line');
  });

  it('rejects short strokes and wobbly handwriting', () => {
    expect(recognizeLine(straight(0, 0, 5, 0, 4))).toBeNull();
    expect(recognizeLine(straight(0, 0, 100, 0, 21, 0.15))).toBeNull();
    expect(recognizeLine([])).toBeNull();
  });
});

describe('recognizeArrow', () => {
  // Shaft along x with a V head at the tip.
  const arrow = (): InkSample[] => [
    ...straight(0, 0, 90, 0, 10),
    { x: 94, y: -8 },
    { x: 100, y: 0 },
    { x: 94, y: 8 },
    { x: 100, y: 0 },
  ];

  it('fits a shaft plus a sharp head hook', () => {
    const fit = recognizeArrow(arrow());
    expect(fit).toMatchObject({ kind: 'arrow', x: 0, y: 0, x2: 100, y2: 0 });
  });

  it('rejects plain lines and wobble without a head', () => {
    expect(recognizeArrow(straight(0, 0, 100, 0, 12))).toBeNull();
    expect(recognizeArrow(straight(0, 0, 100, 0, 21, 0.15))).toBeNull();
  });
});

describe('recognizeRectangle', () => {
  const rect = (): InkSample[] => {
    const out: InkSample[] = [];
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
  };

  it('fits a closed rectangular path to its bounding box', () => {
    expect(recognizeRectangle(rect())).toMatchObject({
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 40,
      height: 30,
    });
  });

  it('rejects open U shapes, tiny boxes, and sloppy loops', () => {
    const open = rect().slice(0, 15); // three edges only
    expect(recognizeRectangle(open)).toBeNull();
    expect(recognizeRectangle(rect().map((s) => ({ x: s.x / 10, y: s.y / 10 })))).toBeNull();
    expect(recognizeRectangle(circleSamples(20, 20, 15, 24))).toBeNull();
  });
});

describe('recognizeEllipse', () => {
  it('fits a closed loop to its bounding box', () => {
    // 25 samples land exactly on the cardinal points.
    expect(recognizeEllipse(circleSamples(20, 20, 15, 25))).toMatchObject({
      kind: 'ellipse',
      x: 5,
      y: 5,
      width: 30,
      height: 30,
    });
  });

  it('rejects rectangles, open arcs, and tiny loops', () => {
    const box: InkSample[] = pts([
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
      [0, 0],
    ]);
    expect(recognizeEllipse(box)).toBeNull();
    expect(recognizeEllipse(circleSamples(20, 20, 15, 18, Math.PI * 1.5))).toBeNull();
    expect(recognizeEllipse(circleSamples(20, 20, 2, 12))).toBeNull();
  });
});

describe('recognizeShape', () => {
  it('routes each doodle to its best fit', () => {
    expect(recognizeShape(straight(0, 0, 100, 0, 9))?.kind).toBe('line');
    expect(recognizeShape(circleSamples(20, 20, 15, 24))?.kind).toBe('ellipse');
  });

  it('returns null for ordinary handwriting squiggles', () => {
    const squiggle = pts([
      [0, 10],
      [5, 0],
      [10, 10],
      [15, 0],
      [20, 10],
      [40, 8],
      [60, 12],
    ]);
    expect(recognizeShape(squiggle)).toBeNull();
  });
});

describe('recognizeScribble', () => {
  const scribble = (): InkSample[] => {
    const out: InkSample[] = [];
    for (let i = 0; i < 21; i++) {
      out.push({ x: i * 3, y: i % 2 === 0 ? 0 : 8 });
    }
    return out;
  };

  it('flags dense zigzag overdraw and reports its bounds', () => {
    const hit = recognizeScribble(scribble());
    expect(hit).not.toBeNull();
    expect(hit!.minX).toBeLessThanOrEqual(0);
    expect(hit!.maxX).toBeGreaterThanOrEqual(60);
  });

  it('stays conservative on w-like writing and gentle waves', () => {
    const w = pts([
      [0, 10],
      [5, 0],
      [10, 10],
      [15, 0],
      [20, 10],
    ]);
    expect(recognizeScribble(w)).toBeNull();
    expect(recognizeScribble(straight(0, 0, 100, 0, 21, 0.05))).toBeNull();
  });
});

describe('recognizeCircle', () => {
  it('fits a closed round loop for lasso conversion', () => {
    const hit = recognizeCircle(circleSamples(30, 30, 15, 20));
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(30, 0);
    expect(hit!.y).toBeCloseTo(30, 0);
    expect(hit!.radius).toBeCloseTo(15, 0);
  });

  it('rejects open arcs, tiny loops, and oblong loops', () => {
    expect(recognizeCircle(circleSamples(30, 30, 15, 18, Math.PI * 1.5))).toBeNull();
    expect(recognizeCircle(circleSamples(30, 30, 2, 12))).toBeNull();
    const oblong: InkSample[] = circleSamples(30, 30, 15, 24).map((s) => ({
      x: s.x,
      y: 30 + (s.y - 30) * 0.4,
    }));
    expect(recognizeCircle(oblong)).toBeNull();
  });
});

describe('GESTURE_THRESHOLDS', () => {
  it('exports every documented tuning constant', () => {
    expect(GESTURE_THRESHOLDS.holdMs).toBeGreaterThan(0);
    expect(GESTURE_THRESHOLDS.minShapeSpan).toBeGreaterThan(0);
    expect(GESTURE_THRESHOLDS.lineMaxDeviationRatio).toBeGreaterThan(0);
    expect(GESTURE_THRESHOLDS.scribbleMinReversals).toBeGreaterThanOrEqual(4);
    expect(GESTURE_THRESHOLDS.circleMinRoundness).toBeGreaterThan(0);
  });
});
