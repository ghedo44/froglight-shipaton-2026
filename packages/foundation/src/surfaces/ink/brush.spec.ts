/**
 * Brush contract (writing-experience upgrade, slice 2): a headless,
 * serializable-by-value pen model. The ball pen is the first fully tuned
 * preset; every other kind resolves through the same contract so future
 * nib work never changes canonical sample semantics.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  BRUSH_PEN_BRUSH,
  FOUNTAIN_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  INK_BRUSH_KINDS,
  INK_BRUSH_PRESETS,
  PENCIL_BRUSH,
  brushPresetForKind,
  resolveBrushSpec,
} from './brush.js';

describe('ball pen preset', () => {
  it('ships a mostly-constant round nib with low stabilization', () => {
    expect(BALL_PEN_BRUSH.kind).toBe('ball');
    expect(BALL_PEN_BRUSH.size).toBe(3);
    expect(BALL_PEN_BRUSH.opacity).toBe(1);
    expect(BALL_PEN_BRUSH.tip.shape).toBe('round');
    // Mild pressure: ordinary writing never collapses the line.
    expect(BALL_PEN_BRUSH.pressure.enabled).toBe(true);
    expect(BALL_PEN_BRUSH.pressure.minFactor).toBeGreaterThanOrEqual(0.8);
    expect(BALL_PEN_BRUSH.pressure.maxFactor).toBeLessThanOrEqual(1.2);
    // Responsive handwriting default, not controlled line work.
    expect(BALL_PEN_BRUSH.stabilization).toBeLessThanOrEqual(0.25);
    expect(INK_BRUSH_KINDS).toContain('ball');
  });
});

describe('resolveBrushSpec', () => {
  it('fills overrides over the ball-pen base', () => {
    const spec = resolveBrushSpec({ size: 6, color: '#ff0000' });
    expect(spec.size).toBe(6);
    expect(spec.color).toBe('#ff0000');
    expect(spec.kind).toBe('ball');
    expect(spec.pressure).toEqual(BALL_PEN_BRUSH.pressure);
  });

  it('clamps every range into its documented bound', () => {
    const spec = resolveBrushSpec({
      size: -4,
      opacity: 3,
      stabilization: 9,
      streamline: -2,
      taperStart: 4,
      taperEnd: -1,
      pressure: { enabled: true, minFactor: 2, maxFactor: 0.5, curve: 0 },
    });
    expect(spec.size).toBe(BALL_PEN_BRUSH.size);
    expect(spec.opacity).toBe(1);
    expect(spec.stabilization).toBe(1);
    expect(spec.streamline).toBe(0);
    expect(spec.taperStart).toBeLessThanOrEqual(1);
    expect(spec.taperEnd).toBeGreaterThanOrEqual(0);
    // minFactor never exceeds maxFactor; curve stays positive and finite.
    expect(spec.pressure.minFactor).toBeLessThanOrEqual(
      spec.pressure.maxFactor,
    );
    expect(spec.pressure.curve).toBeGreaterThan(0);
    expect(Number.isFinite(spec.pressure.curve)).toBe(true);
  });

  it('rejects blank colors and unknown tip shapes back to the base', () => {
    const spec = resolveBrushSpec({
      color: '   ',
      tip: { shape: 'hex' as never },
    });
    expect(spec.color).toBe(BALL_PEN_BRUSH.color);
    expect(spec.tip.shape).toBe('round');
  });
});

describe('kind presets', () => {
  it('covers every brush kind with a tuned base', () => {
    expect(INK_BRUSH_KINDS).toEqual(
      expect.arrayContaining([
        'ball',
        'fountain',
        'brush',
        'pencil',
        'highlighter',
      ]),
    );
    for (const kind of INK_BRUSH_KINDS) {
      expect(INK_BRUSH_PRESETS[kind].kind).toBe(kind);
      expect(brushPresetForKind(kind)).toEqual(INK_BRUSH_PRESETS[kind]);
    }
  });

  it('gives the fountain pen nonlinear pressure and a flat stub nib', () => {
    expect(FOUNTAIN_PEN_BRUSH.pressure.curve).toBeGreaterThan(1);
    expect(FOUNTAIN_PEN_BRUSH.pressure.maxFactor).toBeGreaterThan(
      BALL_PEN_BRUSH.pressure.maxFactor,
    );
    expect(FOUNTAIN_PEN_BRUSH.tip.shape).toBe('flat');
    expect(FOUNTAIN_PEN_BRUSH.taperStart).toBe(0);
  });

  it('gives the brush pen strong pressure and smoothing without automatic taper', () => {
    expect(BRUSH_PEN_BRUSH.pressure.maxFactor).toBeGreaterThanOrEqual(2);
    expect(BRUSH_PEN_BRUSH.stabilization).toBeGreaterThan(
      BALL_PEN_BRUSH.stabilization,
    );
    expect(BRUSH_PEN_BRUSH.taperEnd).toBe(0);
    expect(BRUSH_PEN_BRUSH.velocityPressure).toBe(true);
  });

  it('gives the pencil tilt response and an elliptical nib', () => {
    expect(PENCIL_BRUSH.tiltEffect).toBeGreaterThan(0);
    expect(PENCIL_BRUSH.tip.shape).toBe('ellipse');
  });

  it('keeps the highlighter constant-width, translucent, and independent', () => {
    expect(HIGHLIGHTER_BRUSH.pressure.enabled).toBe(false);
    expect(HIGHLIGHTER_BRUSH.opacity).toBe(0.35);
    expect(HIGHLIGHTER_BRUSH.size).toBe(14);
  });

  it('clamps tip aspect and tilt effect into range', () => {
    const spec = resolveBrushSpec({
      tip: { shape: 'flat', aspect: 7 },
      tiltEffect: -3,
    });
    expect(spec.tip.aspect).toBeLessThanOrEqual(1);
    expect(spec.tip.aspect).toBeGreaterThanOrEqual(0);
    expect(spec.tiltEffect).toBeGreaterThanOrEqual(0);
  });
});
