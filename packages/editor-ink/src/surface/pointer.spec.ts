/**
 * Pointer/gesture routing unit tests.
 *
 * Palm/touch rejection and delegateTouchNavigation behavior are covered by
 * deterministic routing tests. Palm rejection must not live in render or
 * camera code.
 */

import { describe, expect, it } from 'vitest';
import {
  centroid,
  classifyPenButton,
  normalizePointerAxes,
  shouldIgnorePointerDown,
  shouldRejectTouchDuringDraw,
  spread,
  viewPointFromRect,
} from './pointer.js';

describe('viewPointFromRect', () => {
  it('maps client coordinates into canvas-local view points', () => {
    expect(
      viewPointFromRect({ clientX: 110, clientY: 60 }, { left: 10, top: 20 }),
    ).toEqual({ x: 100, y: 40 });
  });
});

describe('centroid/spread', () => {
  it('averages tracks and measures pinch spread', () => {
    expect(
      centroid([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual({ x: 5, y: 0 });
    expect(centroid([])).toEqual({ x: 0, y: 0 });
    expect(
      spread([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ]),
    ).toBe(5);
    expect(spread([{ x: 0, y: 0 }])).toBe(0);
  });
});

describe('normalizePointerAxes', () => {
  it('captures pressure/tilt/twist from pointer axes, preserving tilt direction', () => {
    const normalized = normalizePointerAxes(
      { x: 20, y: 0 },
      { pressure: 0.5, tiltX: 30, tiltY: 40, twistAngle: 90 },
    );
    expect(normalized.point).toEqual({ x: 20, y: 0 });
    expect(normalized.pressure).toBe(0.5);
    // 30°/40° per axis → radians, direction preserved (still v1).
    expect(normalized.tilt!.x).toBeCloseTo(30 * (Math.PI / 180), 6);
    expect(normalized.tilt!.y).toBeCloseTo(40 * (Math.PI / 180), 6);
    expect(normalized.twist).toBeCloseTo(Math.PI / 2, 6);
  });

  it('clamps each tilt axis independently without rescaling (frozen v1)', () => {
    const normalized = normalizePointerAxes(
      { x: 0, y: 0 },
      { tiltX: 100, tiltY: 100 },
    );
    // 100deg per axis clamps to π/2 each; no combined-magnitude rescale.
    expect(normalized.tilt!.x).toBeCloseTo(Math.PI / 2, 9);
    expect(normalized.tilt!.y).toBeCloseTo(Math.PI / 2, 9);
  });

  it('preserves signed tilt axes independently', () => {
    const normalized = normalizePointerAxes(
      { x: 0, y: 0 },
      { tiltX: -45, tiltY: 30 },
    );
    expect(normalized.tilt!.x).toBeCloseTo(-Math.PI / 4, 9);
    expect(normalized.tilt!.y).toBeCloseTo(Math.PI / 6, 9);
  });

  it('omits absent hardware axes', () => {
    const normalized = normalizePointerAxes({ x: 0, y: 0 }, {});
    expect(normalized.point).toEqual({ x: 0, y: 0 });
    expect('pressure' in normalized).toBe(false);
    expect('tilt' in normalized).toBe(false);
    expect('twist' in normalized).toBe(false);
  });

  it('preserves zero contact pressure and omits zero tilt', () => {
    const normalized = normalizePointerAxes(
      { x: 0, y: 0 },
      { pressure: 0, tiltX: 0, tiltY: 0 },
    );
    expect(normalized.pressure).toBe(0);
    expect('tilt' in normalized).toBe(false);
  });
});

describe('shouldIgnorePointerDown', () => {
  it('ignores everything once destroyed', () => {
    expect(
      shouldIgnorePointerDown({
        pointerType: 'pen',
        delegateTouchNavigation: false,
        destroyed: true,
      }),
    ).toBe(true);
  });

  it('allows pen, mouse, and touch to reach navigation', () => {
    expect(
      shouldIgnorePointerDown({
        pointerType: 'pen',
        delegateTouchNavigation: false,
        destroyed: false,
      }),
    ).toBe(false);
    expect(
      shouldIgnorePointerDown({
        pointerType: 'mouse',
        delegateTouchNavigation: false,
        destroyed: false,
      }),
    ).toBe(false);
    expect(
      shouldIgnorePointerDown({
        pointerType: 'touch',
        delegateTouchNavigation: false,
        destroyed: false,
      }),
    ).toBe(false);
  });

  it('delegates touch to the parent when delegateTouchNavigation is set', () => {
    expect(
      shouldIgnorePointerDown({
        pointerType: 'touch',
        delegateTouchNavigation: true,
        destroyed: false,
      }),
    ).toBe(true);
    expect(
      shouldIgnorePointerDown({
        pointerType: 'pen',
        delegateTouchNavigation: true,
        destroyed: false,
      }),
    ).toBe(false);
  });

  it('rejects a touch that arrives mid-draw (palm guard)', () => {
    // A stylus/mouse draws; fingers navigate. An incidental touch contact
    // must never join a pen stroke as a sample.
    expect(
      shouldRejectTouchDuringDraw({
        mode: 'draw',
        pointerType: 'touch',
        cameraInteractive: true,
      }),
    ).toBe(true);
    expect(
      shouldRejectTouchDuringDraw({
        mode: 'draw',
        pointerType: 'pen',
        cameraInteractive: true,
      }),
    ).toBe(false);
    expect(
      shouldRejectTouchDuringDraw({
        mode: 'pan',
        pointerType: 'touch',
        cameraInteractive: true,
      }),
    ).toBe(false);
  });
});

describe('classifyPenButton', () => {
  it('maps W3C pen buttons (0 contact, 2 barrel, 5 eraser)', () => {
    expect(classifyPenButton('pen', 0)).toBe('contact');
    expect(classifyPenButton('pen', 2)).toBe('barrel');
    expect(classifyPenButton('pen', 5)).toBe('eraser');
    expect(classifyPenButton('pen', 1)).toBe('middle');
    expect(classifyPenButton('pen', 3)).toBe('other');
  });

  it('never reports pen buttons for non-pen pointers', () => {
    expect(classifyPenButton('mouse', 0)).toBe('other');
    expect(classifyPenButton('mouse', 1)).toBe('middle');
    expect(classifyPenButton('touch', 0)).toBe('other');
  });
});
