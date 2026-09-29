/**
 * Eraser geometry: stroke footprint intersection and content-filter matching.
 * Precision sweeps the eraser path so fast moves leave no gaps.
 */

import { describe, expect, it } from 'vitest';
import {
  inkStrokeObject,
  rectangleObject,
  imageObject,
  textObject,
  lineObject,
  type SurfaceObjectRecord,
} from '../model.js';
import {
  matchesEraserFilter,
  segmentIntersectsBox,
} from './eraser-geometry.js';

describe('matchesEraserFilter', () => {
  const pen = inkStrokeObject('pen', { points: [{ x: 0, y: 0 }] });
  const marker = inkStrokeObject('m', {
    points: [{ x: 0, y: 0 }],
    brush: { kind: 'highlighter' },
  });
  const rect = rectangleObject('r', { x: 0, y: 0, width: 10, height: 10 });
  const image = imageObject('i', {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    src: 'assets/p.png',
    sha256: 'ab',
  });
  const text = textObject('t', { x: 0, y: 0, text: 'hi' });
  const connector = lineObject('l', { x: 0, y: 0, x2: 10, y2: 10 });

  it('matches handwriting, highlighter, shapes, and images distinctly', () => {
    const cases: Array<[SurfaceObjectRecord, string, boolean]> = [
      [pen, 'ink', true],
      [pen, 'highlighter', false],
      [pen, 'shapes', false],
      [pen, 'images', false],
      [marker, 'highlighter', true],
      [marker, 'ink', false],
      [rect, 'shapes', true],
      [rect, 'ink', false],
      [connector, 'shapes', true],
      [image, 'images', true],
      [image, 'shapes', false],
      [text, 'text', true],
      [text, 'ink', false],
      [text, 'all', true],
      [pen, 'all', true],
      [rect, 'all', true],
      [image, 'all', true],
    ];
    for (const [record, filter, expected] of cases) {
      expect(
        matchesEraserFilter(record, filter as never),
        `${record.id} vs ${filter}`,
      ).toBe(expected);
    }
  });

  it('rejects unknown filters instead of erasing', () => {
    expect(matchesEraserFilter(pen, 'acme.everything' as never)).toBe(false);
  });
});

describe('segmentIntersectsBox', () => {
  const box = { minX: 10, minY: 10, maxX: 20, maxY: 20 };

  it('hits segments crossing the box even with no endpoint inside', () => {
    expect(segmentIntersectsBox({ x: 0, y: 15 }, { x: 30, y: 15 }, box)).toBe(
      true,
    );
    expect(segmentIntersectsBox({ x: 15, y: 0 }, { x: 15, y: 30 }, box)).toBe(
      true,
    );
  });

  it('misses segments passing outside', () => {
    expect(segmentIntersectsBox({ x: 0, y: 0 }, { x: 30, y: 0 }, box)).toBe(
      false,
    );
    expect(segmentIntersectsBox({ x: 0, y: 0 }, { x: 5, y: 5 }, box)).toBe(
      false,
    );
  });

  it('hits touches on the boundary', () => {
    expect(segmentIntersectsBox({ x: 0, y: 10 }, { x: 10, y: 10 }, box)).toBe(
      true,
    );
  });
});
