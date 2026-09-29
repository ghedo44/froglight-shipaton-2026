/**
 * Render-scene geometry tests.
 *
 * Pure viewport/selection/page math separate from canvas binding.
 * Backends continue to consume draw items plus image resolution only.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  rectangleObject,
  createDefaultSurfaceObjectTypeRegistry,
} from '@froglight/foundation';
import {
  computeDotGrid,
  computePageViewRect,
  computeSelectionEnvelope,
  paintResizeHandles,
  paintSelectionChrome,
} from './render-scene.js';

describe('computePageViewRect', () => {
  it('maps the bounded frame into view coordinates', () => {
    expect(
      computePageViewRect({ x: 10, y: 20, zoom: 2 }, { width: 800, height: 600 }),
    ).toEqual({ x: -20, y: -40, width: 1600, height: 1200 });
  });

  it('returns null when no bounded frame exists', () => {
    expect(
      computePageViewRect({ x: 0, y: 0, zoom: 1 }, null),
    ).toBeNull();
  });
});

describe('computeDotGrid', () => {
  it('returns null when the grid would be invisible', () => {
    // zoom * spacing < 9 → no dots (matches engine threshold).
    expect(
      computeDotGrid(
        { x: 0, y: 0, zoom: 0.25 },
        { width: 800, height: 600 },
        { width: 800, height: 600 },
        26,
      ),
    ).toBeNull();
  });

  it('computes a bounded dot lattice inside the visible frame', () => {
    const grid = computeDotGrid(
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
      26,
    );
    expect(grid).not.toBeNull();
    expect(grid!.startX).toBe(0);
    expect(grid!.startY).toBe(0);
    expect(grid!.endX).toBeLessThanOrEqual(800);
    expect(grid!.endY).toBeLessThanOrEqual(600);
    expect(grid!.dotRadius).toBeCloseTo(1.1, 10);
    expect(grid!.spacing).toBe(26);
  });

  it('clips the lattice to the camera-visible rect', () => {
    const grid = computeDotGrid(
      { x: 400, y: 0, zoom: 1 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
      26,
    );
    expect(grid).not.toBeNull();
    // Visible x starts at 400 → floor(400/26)*26 = 390.
    expect(grid!.startX).toBe(390);
  });
});

describe('computeSelectionEnvelope', () => {
  it('unions bounds across selected objects', () => {
    const model = emptySurface(boundedFrame(800, 600));
    model.objects['a'] = rectangleObject('a', { x: 10, y: 10, width: 60, height: 30 });
    model.objects['b'] = rectangleObject('b', { x: 100, y: 100, width: 50, height: 40 });
    model.order.push('a', 'b');
    const envelope = computeSelectionEnvelope(
      model,
      ['a', 'b'],
      createDefaultSurfaceObjectTypeRegistry(),
    );
    expect(envelope).toEqual({ x: 10, y: 10, width: 140, height: 130 });
  });

  it('returns null when nothing is selectable', () => {
    const model = emptySurface(boundedFrame(800, 600));
    expect(
      computeSelectionEnvelope(model, [], createDefaultSurfaceObjectTypeRegistry()),
    ).toBeNull();
    expect(
      computeSelectionEnvelope(model, ['missing'], createDefaultSurfaceObjectTypeRegistry()),
    ).toBeNull();
  });
});

describe('paint helpers (canvas affordances)', () => {
  function recordingCtx() {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = {
      save: () => calls.push(['save']),
      restore: () => calls.push(['restore']),
      setTransform: (...args: unknown[]) => calls.push(['setTransform', ...args]),
      setLineDash: (segments: number[]) => calls.push(['setLineDash', segments]),
      strokeRect: (...args: unknown[]) => calls.push(['strokeRect', ...args]),
      fillRect: (...args: unknown[]) => calls.push(['fillRect', ...args]),
      beginPath: () => calls.push(['beginPath']),
      rect: (...args: unknown[]) => calls.push(['rect', ...args]),
      fill: () => calls.push(['fill']),
      stroke: () => calls.push(['stroke']),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
    };
    return { ctx, calls };
  }

  const token = () => '#7c6cf0';

  it('paints dashed selection chrome for selected objects', () => {
    const { ctx, calls } = recordingCtx();
    const model = emptySurface(boundedFrame(800, 600));
    model.objects['r1'] = rectangleObject('r1', { x: 10, y: 10, width: 60, height: 30 });
    model.order.push('r1');
    paintSelectionChrome(
      ctx as never,
      1,
      token,
      model,
      { x: 0, y: 0, zoom: 1 },
      ['r1'],
      createDefaultSurfaceObjectTypeRegistry(),
    );
    expect(calls.some(([name]) => name === 'setLineDash')).toBe(true);
    expect(calls.some(([name]) => name === 'strokeRect')).toBe(true);
  });

  it('does nothing when selection is empty', () => {
    const { ctx, calls } = recordingCtx();
    const model = emptySurface(boundedFrame(800, 600));
    paintSelectionChrome(
      ctx as never,
      1,
      token,
      model,
      { x: 0, y: 0, zoom: 1 },
      [],
      createDefaultSurfaceObjectTypeRegistry(),
    );
    expect(calls).toHaveLength(0);
  });

  it('paints resize handles for all four frame corners', () => {
    const { ctx, calls } = recordingCtx();
    paintResizeHandles(
      ctx as never,
      1,
      token,
      { x: 0, y: 0, width: 800, height: 600 },
      5,
    );
    expect(calls.filter(([name]) => name === 'rect')).toHaveLength(4);
    expect(calls.filter(([name]) => name === 'fill')).toHaveLength(4);
    expect(calls.filter(([name]) => name === 'stroke')).toHaveLength(4);
  });
});
