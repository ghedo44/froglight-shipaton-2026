/**
 * Frame-resize unit tests.
 *
 * Hit testing, min/max clamping, coordinate conversion, and frame mutation
 * live here. The module must not own camera state or rendering.
 */

import { describe, expect, it } from 'vitest';
import {
  borderHitMode,
  computeResizedFrame,
  frameRectView,
  HANDLE_CURSORS,
} from './frame-resize.js';
import { MAX_FRAME_SIZE, MIN_FRAME_SIZE } from './camera.js';

describe('frameRectView', () => {
  it('maps the bounded frame into view coordinates', () => {
    const rect = frameRectView(
      { x: 10, y: 20, zoom: 2 },
      { width: 800, height: 600 },
    );
    expect(rect).toEqual({ x: -20, y: -40, width: 1600, height: 1200 });
  });

  it('returns a degenerate rect when no bounded frame exists', () => {
    expect(
      frameRectView({ x: 0, y: 0, zoom: 1 }, null),
    ).toEqual({ x: -1, y: -1, width: 0, height: 0 });
  });
});

describe('borderHitMode', () => {
  const rect = { x: 0, y: 0, width: 800, height: 600 };

  it('returns null when resizing is disabled', () => {
    expect(borderHitMode({ x: 0, y: 0 }, rect, false)).toBeNull();
  });

  it('prefers corners over edges', () => {
    expect(borderHitMode({ x: 0, y: 0 }, rect, true)).toBe('nw');
    expect(borderHitMode({ x: 800, y: 600 }, rect, true)).toBe('se');
    expect(borderHitMode({ x: 800, y: 0 }, rect, true)).toBe('ne');
    expect(borderHitMode({ x: 0, y: 600 }, rect, true)).toBe('sw');
  });

  it('detects edges and misses interior points', () => {
    expect(borderHitMode({ x: 800, y: 300 }, rect, true)).toBe('e');
    expect(borderHitMode({ x: 400, y: 0 }, rect, true)).toBe('n');
    expect(borderHitMode({ x: 400, y: 300 }, rect, true)).toBeNull();
  });

  it('uses enlarged screen-space touch zones for all eight handles', () => {
    for (const [mode, point] of [
      ['n', { x: 400, y: 18 }],
      ['s', { x: 400, y: 582 }],
      ['e', { x: 782, y: 300 }],
      ['w', { x: 18, y: 300 }],
      ['nw', { x: 18, y: 18 }],
      ['ne', { x: 782, y: 18 }],
      ['sw', { x: 18, y: 582 }],
      ['se', { x: 782, y: 582 }],
    ] as const) {
      expect(borderHitMode(point, rect, true, 'touch')).toBe(mode);
      expect(borderHitMode(point, rect, true, 'mouse')).toBeNull();
      expect(borderHitMode(point, rect, true, 'pen')).toBeNull();
      expect(borderHitMode(point, rect, false, 'touch')).toBeNull();
    }
    expect(borderHitMode({ x: 5, y: 18 }, rect, true, 'touch')).toBe('nw');
    expect(borderHitMode({ x: 23, y: 300 }, rect, true, 'touch')).toBeNull();
  });

  it('exposes a cursor for every resize mode', () => {
    for (const mode of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
      expect(typeof HANDLE_CURSORS[mode]).toBe('string');
    }
  });
});

describe('computeResizedFrame', () => {
  it('grows east/south and clamps to min/max limits', () => {
    const start = { width: 800, height: 600 };
    const next = computeResizedFrame(start, 'se', 100, 50);
    expect(next.frame).toEqual({ width: 900, height: 650 });
    expect(next.changed).toBe(true);

    const clamped = computeResizedFrame(start, 'e', 100_000, 0);
    expect(clamped.frame.width).toBe(MAX_FRAME_SIZE);
    const tiny = computeResizedFrame(start, 'w', 100_000, 0);
    expect(tiny.frame.width).toBe(MIN_FRAME_SIZE);
  });

  it('keeps the opposite edge anchored while resizing west/north', () => {
    const start = { width: 800, height: 600 };
    const direct = computeResizedFrame(start, 'nw', 20, 10);
    // w shrinks by dx, n shrinks by dy
    expect(direct.frame.width).toBe(780);
    expect(direct.frame.height).toBe(590);
    expect(direct.originAdjustX).toBe(20);
    expect(direct.originAdjustY).toBe(10);
  });

  it('leaves unrelated object coordinates unchanged (pure math)', () => {
    const start = { width: 800, height: 600 };
    const frozen = { ...start };
    computeResizedFrame(start, 'e', 50, 0);
    expect(start).toEqual(frozen);
  });
});
