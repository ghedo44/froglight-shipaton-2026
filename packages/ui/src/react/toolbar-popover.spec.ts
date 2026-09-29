// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { computeToolbarPopoverPosition } from './toolbar-popover.jsx';

const pane = { x: 0, y: 0, width: 800, height: 600 };

describe('computeToolbarPopoverPosition', () => {
  it('centers below a normal trigger', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(position.placement).toBe('below');
    expect(position.left).toBe(400 + 20 - 100);
    expect(position.top).toBe(100 + 40 + 8);
  });

  it('shifts left for a right-edge trigger instead of overflowing', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 760, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(position.left + 200).toBeLessThanOrEqual(800 - 8);
    expect(position.left).toBeGreaterThanOrEqual(8);
    // Centered would be 680, clamped to 592 (800-8-200).
    expect(position.left).toBe(800 - 8 - 200);
  });

  it('shifts right for a left-edge trigger', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 0, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(position.left).toBe(8);
  });

  it('flips above when there is not enough room below', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 540, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(position.placement).toBe('above');
    expect(position.top).toBe(540 - 100 - 8);
    expect(position.top).toBeGreaterThanOrEqual(8);
  });

  it('flips below when there is not enough room above', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 10, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'above',
      inset: 8,
    });
    expect(position.placement).toBe('below');
  });

  it('opens beside a left-docked trigger and flips at the right edge', () => {
    const fromLeft = computeToolbarPopoverPosition({
      trigger: { x: 8, y: 260, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 140 },
      preferred: 'right',
      inset: 8,
    });
    expect(fromLeft).toMatchObject({ placement: 'right', left: 56, top: 210 });

    const fromRight = computeToolbarPopoverPosition({
      trigger: { x: 752, y: 260, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 140 },
      preferred: 'right',
      inset: 8,
    });
    expect(fromRight).toMatchObject({ placement: 'left', left: 544, top: 210 });
  });

  it('respects safe-area insets', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 400, y: 100, width: 40, height: 40 },
      pane,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 24,
    });
    expect(position.left).toBeGreaterThanOrEqual(24);
    expect(position.left + 200).toBeLessThanOrEqual(800 - 24);
    expect(position.top).toBeGreaterThanOrEqual(24);
  });

  it('clamps to a resized (narrow) pane', () => {
    const narrow = { x: 0, y: 0, width: 320, height: 600 };
    const position = computeToolbarPopoverPosition({
      trigger: { x: 140, y: 100, width: 40, height: 40 },
      pane: narrow,
      popover: { width: 200, height: 100 },
      preferred: 'below',
      inset: 8,
    });
    expect(position.left).toBeGreaterThanOrEqual(8);
    expect(position.left + 200).toBeLessThanOrEqual(320 - 8);
  });

  it('constrains an oversized popover to the usable pane rectangle', () => {
    const position = computeToolbarPopoverPosition({
      trigger: { x: 20, y: 20, width: 40, height: 40 },
      pane: { x: 10, y: 10, width: 280, height: 180 },
      popover: { width: 420, height: 360 },
      preferred: 'below',
      inset: 8,
    });
    expect(position).toMatchObject({
      left: 18,
      top: 18,
      maxWidth: 264,
      maxHeight: 164,
    });
  });
});
