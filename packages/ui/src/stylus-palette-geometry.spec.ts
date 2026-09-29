import { describe, expect, it } from 'vitest';
import {
  placeStylusPalette,
  placeCenteredSqueezeArc,
  placeSqueezeCrescent,
  SQUEEZE_TIP_CLEARANCE,
} from './stylus-palette-geometry.js';

const PALETTE = { width: 280, height: 200 };
const VIEWPORT = { width: 1024, height: 768 };
const SAFE = { top: 20, bottom: 20, left: 0, right: 0 };

describe('placeStylusPalette', () => {
  it('centers on the anchor in open space', () => {
    const placed = placeStylusPalette({ x: 512, y: 384 }, PALETTE, VIEWPORT, SAFE, 0);
    expect(placed.left).toBe(372);
    expect(placed.top).toBe(284);
    expect(placed.marker).toEqual({ x: 0, y: 0 });
  });

  it.each([
    ['top edge', { x: 512, y: 30 }],
    ['bottom edge', { x: 512, y: 750 }],
    ['left edge', { x: 8, y: 384 }],
    ['right edge', { x: 1016, y: 384 }],
    ['top-left', { x: 8, y: 24 }],
    ['top-right', { x: 1016, y: 24 }],
    ['bottom-left', { x: 8, y: 750 }],
    ['bottom-right', { x: 1016, y: 750 }],
  ])('keeps every target inside for %s', (_label, anchor) => {
    const placed = placeStylusPalette(anchor as { x: number; y: number }, PALETTE, VIEWPORT, SAFE, 0);
    expect(placed.left).toBeGreaterThanOrEqual(SAFE.left);
    expect(placed.left + PALETTE.width).toBeLessThanOrEqual(VIEWPORT.width - SAFE.right);
    expect(placed.top).toBeGreaterThanOrEqual(SAFE.top);
    expect(placed.top + PALETTE.height).toBeLessThanOrEqual(VIEWPORT.height - SAFE.bottom);
  });

  it('respects the visible keyboard region', () => {
    const placed = placeStylusPalette({ x: 512, y: 700 }, PALETTE, VIEWPORT, SAFE, 300);
    expect(placed.top + PALETTE.height).toBeLessThanOrEqual(768 - 20 - 300);
  });

  it('preserves the marker relationship when shifted', () => {
    const placed = placeStylusPalette({ x: 8, y: 384 }, PALETTE, VIEWPORT, SAFE, 0);
    expect(placed.marker.x).not.toBe(0);
    // Marker points from the rendered center back to the raw anchor.
    expect(placed.center.x + placed.marker.x).toBe(8);
  });
});

describe('placeSqueezeCrescent (radial palette)', () => {
  it('rests above the tip with clearance in open space, never covering it', () => {
    const placed = placeSqueezeCrescent(
      { x: 512, y: 384 },
      PALETTE,
      VIEWPORT,
      SAFE,
      0,
    );
    expect(placed.orientation).toBe('above');
    expect(placed.tipClearance).toBe(SQUEEZE_TIP_CLEARANCE);
    // Palette bottom clears the tip; the tip stays visible below it.
    expect(placed.top + PALETTE.height).toBeLessThanOrEqual(
      384 - SQUEEZE_TIP_CLEARANCE,
    );
    expect(placed.center.x + placed.marker.x).toBe(512);
    expect(placed.center.y + placed.marker.y).toBe(384);
  });

  it('flips below near the top edge', () => {
    const placed = placeSqueezeCrescent(
      { x: 512, y: 30 },
      PALETTE,
      VIEWPORT,
      SAFE,
      0,
    );
    expect(placed.orientation).toBe('below');
    expect(placed.top).toBeGreaterThanOrEqual(30 + SQUEEZE_TIP_CLEARANCE);
  });

  it('stays above near the bottom edge and above the keyboard', () => {
    const bottom = placeSqueezeCrescent(
      { x: 512, y: 750 },
      PALETTE,
      VIEWPORT,
      SAFE,
      0,
    );
    expect(bottom.orientation).toBe('above');
    expect(bottom.top + PALETTE.height).toBeLessThanOrEqual(
      750 - SQUEEZE_TIP_CLEARANCE,
    );
    expect(bottom.top + PALETTE.height).toBeLessThanOrEqual(
      VIEWPORT.height - SAFE.bottom,
    );
    const keyboard = placeSqueezeCrescent(
      { x: 512, y: 500 },
      PALETTE,
      VIEWPORT,
      SAFE,
      300,
    );
    expect(keyboard.orientation).toBe('above');
    expect(keyboard.top + PALETTE.height).toBeLessThanOrEqual(768 - 20 - 300);
  });

  it.each([
    ['left edge', { x: 8, y: 384 }],
    ['right edge', { x: 1016, y: 384 }],
    ['top-left', { x: 8, y: 24 }],
    ['bottom-right', { x: 1016, y: 750 }],
  ])('keeps every target inside for %s', (_label, anchor) => {
    const placed = placeSqueezeCrescent(
      anchor as { x: number; y: number },
      PALETTE,
      VIEWPORT,
      SAFE,
      0,
    );
    expect(placed.left).toBeGreaterThanOrEqual(SAFE.left);
    expect(placed.left + PALETTE.width).toBeLessThanOrEqual(
      VIEWPORT.width - SAFE.right,
    );
    expect(placed.top).toBeGreaterThanOrEqual(SAFE.top);
    expect(placed.top + PALETTE.height).toBeLessThanOrEqual(
      VIEWPORT.height - SAFE.bottom,
    );
    // Marker still resolves back to the raw anchor after clamping.
    expect(placed.center.x + placed.marker.x).toBe(
      (anchor as { x: number }).x,
    );
    expect(placed.center.y + placed.marker.y).toBe(
      (anchor as { y: number }).y,
    );
  });

  it('moves to the roomier side when neither vertical gap fits', () => {
    const tiny = { width: 1024, height: 260 };
    const placed = placeSqueezeCrescent(
      { x: 512, y: 130 },
      PALETTE,
      tiny,
      { top: 0, bottom: 0, left: 0, right: 0 },
      0,
    );
    expect(['left', 'right']).toContain(placed.orientation);
    expect(placed.left).toBeGreaterThanOrEqual(0);
    expect(placed.left + PALETTE.width).toBeLessThanOrEqual(1024);
  });
});


describe('Pencil-centered circular arc', () => {
  it.each([{ x: 512, y: 384 }, { x: 50, y: 50 }, { x: 970, y: 50 }, { x: 50, y: 700 }, { x: 970, y: 700 }])('keeps the circle center at %j while choosing a usable quadrant', (anchor) => {
    const placed = placeCenteredSqueezeArc(anchor, VIEWPORT, SAFE);
    expect(placed.left + (placed.flipX ? 32 : 216)).toBe(anchor.x);
    expect(placed.top + (placed.flipY ? 32 : 216)).toBe(anchor.y);
    for (let i = 0; i < 7; i++) {
      const x = anchor.x + (placed.flipX ? 1 : -1) * 184 * Math.cos(i * Math.PI / 12);
      const y = anchor.y + (placed.flipY ? 1 : -1) * 184 * Math.sin(i * Math.PI / 12);
      expect(Math.hypot(x - anchor.x, y - anchor.y)).toBeCloseTo(184);
      expect(x - 22).toBeGreaterThanOrEqual(SAFE.left);
      expect(x + 22).toBeLessThanOrEqual(VIEWPORT.width - SAFE.right);
      expect(y - 22).toBeGreaterThanOrEqual(SAFE.top);
      expect(y + 22).toBeLessThanOrEqual(VIEWPORT.height - SAFE.bottom);
    }
  });
});
