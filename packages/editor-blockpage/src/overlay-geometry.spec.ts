import { describe, expect, it } from 'vitest';
import { computeBlockpageOverlayPosition } from './overlay-geometry.js';

const host = {
  left: 100,
  top: 50,
  right: 700,
  bottom: 550,
  width: 600,
  height: 500,
};

describe('computeBlockpageOverlayPosition', () => {
  it('converts viewport coordinates into scrolled host coordinates', () => {
    expect(
      computeBlockpageOverlayPosition({
        anchor: {
          left: 220,
          top: 150,
          right: 260,
          bottom: 170,
          width: 40,
          height: 20,
        },
        host,
        scrollLeft: 10,
        scrollTop: 300,
        clientWidth: 600,
        clientHeight: 500,
        overlayWidth: 240,
        overlayHeight: 180,
      }),
    ).toMatchObject({ left: 130, top: 426, placement: 'below' });
  });

  it('flips above near the visible bottom edge after substantial scroll', () => {
    const position = computeBlockpageOverlayPosition({
      anchor: {
        left: 300,
        top: 500,
        right: 340,
        bottom: 520,
        width: 40,
        height: 20,
      },
      host,
      scrollLeft: 0,
      scrollTop: 900,
      clientWidth: 600,
      clientHeight: 500,
      overlayWidth: 260,
      overlayHeight: 220,
    });
    expect(position.placement).toBe('above');
    expect(position.top).toBe(900 + (500 - 50) - 220 - 6);
  });

  it('shifts at both pane edges and caps an oversized overlay', () => {
    const right = computeBlockpageOverlayPosition({
      anchor: {
        left: 680,
        top: 100,
        right: 700,
        bottom: 120,
        width: 20,
        height: 20,
      },
      host,
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 600,
      clientHeight: 500,
      overlayWidth: 900,
      overlayHeight: 700,
    });
    expect(right.left).toBe(8);
    expect(right.top).toBe(8);
    expect(right.maxWidth).toBe(584);
    expect(right.maxHeight).toBe(484);
  });

  it('centers a block-action surface while preserving the inset', () => {
    const position = computeBlockpageOverlayPosition({
      anchor: {
        left: 105,
        top: 100,
        right: 149,
        bottom: 144,
        width: 44,
        height: 44,
      },
      host,
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 600,
      clientHeight: 500,
      overlayWidth: 240,
      overlayHeight: 180,
      align: 'center',
    });
    expect(position.left).toBe(8);
  });
});
