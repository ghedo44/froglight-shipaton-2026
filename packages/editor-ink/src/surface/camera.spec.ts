/**
 * Camera/navigation math unit tests.
 *
 * Pure transform math separate from event binding. Zooming/panning must
 * never mutate committed stroke/object coordinates — these helpers return
 * new Camera values and leave inputs untouched.
 */

import { describe, expect, it } from 'vitest';
import { viewToSurface } from '@froglight/foundation';
import {
  boundedCamera,
  clampFrameSize,
  clampZoom,
  fitCameraToFrame,
  MAX_FRAME_SIZE,
  MAX_ZOOM,
  MIN_FRAME_SIZE,
  MIN_ZOOM,
  resistedCameraBeyondBounds,
  zoomCameraAroundPoint,
  zoomCameraAroundPointUnclamped,
} from './camera.js';
import { elasticZoom } from '../navigation/index.js';

describe('camera zoom clamping', () => {
  it('clamps zoom to the finite sheet range', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(
      MIN_FRAME_SIZE > 0 ? MIN_ZOOM : MIN_ZOOM,
    );
  });

  it('clamps frame sizes to the sheet limits', () => {
    expect(clampFrameSize(800)).toBe(800);
    expect(clampFrameSize(1)).toBe(MIN_FRAME_SIZE);
    expect(clampFrameSize(1_000_000)).toBe(MAX_FRAME_SIZE);
    expect(clampFrameSize(Number.NaN)).toBe(MIN_FRAME_SIZE);
  });
});

describe('zoom-around-point math', () => {
  it('keeps the surface point under the anchor fixed on screen', () => {
    const current = { x: 10, y: 20, zoom: 1 };
    const anchor = { x: 100, y: 50 };
    const next = zoomCameraAroundPoint(current, 2, anchor);
    expect(next.zoom).toBe(2);
    // surfaceAnchor = (100/1+10, 50/1+20) = (110, 70); next = anchor - point/nextZoom
    expect(next.x).toBeCloseTo(110 - 100 / 2, 10);
    expect(next.y).toBeCloseTo(70 - 50 / 2, 10);
  });

  it('clamps the resulting zoom and ignores non-finite input', () => {
    const current = { x: 0, y: 0, zoom: 1 };
    expect(zoomCameraAroundPoint(current, 100, { x: 0, y: 0 }).zoom).toBe(
      MAX_ZOOM,
    );
    expect(zoomCameraAroundPoint(current, 0.001, { x: 0, y: 0 }).zoom).toBe(
      MIN_ZOOM,
    );
    expect(zoomCameraAroundPoint(current, Number.NaN, { x: 5, y: 5 })).toEqual(
      current,
    );
  });

  it('does not mutate the input camera', () => {
    const current = { x: 5, y: 7, zoom: 1 };
    const frozen = { ...current };
    zoomCameraAroundPoint(current, 2, { x: 10, y: 10 });
    expect(current).toEqual(frozen);
  });

  it('supports finite combined translation and unclamped live zoom', () => {
    const current = { x: 10, y: 20, zoom: 1 };
    const next = zoomCameraAroundPointUnclamped(
      current,
      10,
      { x: 100, y: 50 },
      { x: 140, y: 80 },
    );
    expect(next.zoom).toBe(10);
    expect(next.x).toBeCloseTo(110 - 140 / 10, 10);
    expect(next.y).toBeCloseTo(70 - 80 / 10, 10);
    expect(
      zoomCameraAroundPointUnclamped(current, Number.NaN, { x: 0, y: 0 }),
    ).toEqual(current);
  });
});

describe('boundedCamera', () => {
  it('keeps at least 70% of the available sheet area in the viewport for Ink', () => {
    const frame = { width: 800, height: 600 };
    const viewport = { width: 800, height: 600 };
    for (const camera of [
      { x: -10_000, y: -10_000, zoom: 1 },
      { x: 10_000, y: 10_000, zoom: 1 },
      { x: -10_000, y: 10_000, zoom: 2 },
    ]) {
      const next = boundedCamera(camera, frame, viewport, 0.7);
      const visibleX = Math.max(
        0,
        Math.min(frame.width, next.x + viewport.width / next.zoom) -
          Math.max(0, next.x),
      );
      const visibleY = Math.max(
        0,
        Math.min(frame.height, next.y + viewport.height / next.zoom) -
          Math.max(0, next.y),
      );
      const maximumArea =
        Math.min(frame.width, viewport.width / next.zoom) *
        Math.min(frame.height, viewport.height / next.zoom);
      expect(visibleX * visibleY).toBeGreaterThanOrEqual(
        0.7 * maximumArea - 0.001,
      );
    }
    const edge = boundedCamera(
      { x: 10_000, y: 0, zoom: 1 },
      frame,
      viewport,
      0.7,
    );
    expect(frame.width - edge.x).toBeCloseTo(frame.width * 0.7, 2);
  });
  it('returns the input when no bounded frame exists', () => {
    const camera = { x: 10, y: 20, zoom: 1 };
    expect(boundedCamera(camera, null, { width: 800, height: 600 })).toEqual({
      x: 10,
      y: 20,
      zoom: 1,
    });
    expect(
      boundedCamera({ x: 10, y: 20, zoom: 20 }, null, {
        width: 800,
        height: 600,
      }),
    ).toEqual({ x: 10, y: 20, zoom: MAX_ZOOM });
  });

  it('heals non-finite position to 0 on infinite/degenerate frames', () => {
    // A NaN-poisoned camera must never propagate or stick the infinite desk:
    // finite position passes through, non-finite heals to 0, zoom clamps.
    expect(boundedCamera({ x: NaN, y: NaN, zoom: 1 }, null, {
      width: 800,
      height: 600,
    })).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(
      boundedCamera(
        { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY, zoom: 1 },
        null,
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(
      boundedCamera({ x: NaN, y: 5, zoom: 1 }, { width: 800, height: 600 }, {
        width: 0,
        height: 0,
      }),
    ).toEqual({ x: 0, y: 5, zoom: 1 });
  });

  it('centers a small frame inside a large viewport', () => {
    const camera = { x: 9999, y: 9999, zoom: 1 };
    const next = boundedCamera(
      camera,
      { width: 800, height: 600 },
      { width: 1600, height: 1200 },
    );
    expect(next.x).toBeCloseTo(800 / 2 - 1600 / 2, 6);
    expect(next.y).toBeCloseTo(600 / 2 - 1200 / 2, 6);
  });

  it('clamps panning to the finite sheet without mutating object coords', () => {
    const camera = { x: 0, y: 0, zoom: 2 };
    const next = boundedCamera(
      camera,
      { width: 800, height: 600 },
      { width: 800, height: 600 },
    );
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.y)).toBe(true);
    expect(next.zoom).toBe(2);
    expect(camera).toEqual({ x: 0, y: 0, zoom: 2 });
  });

  it('returns finite centered output for non-finite pan input', () => {
    const frame = { width: 800, height: 600 };
    const viewport = { width: 800, height: 600 };
    const nan = boundedCamera({ x: NaN, y: NaN, zoom: 1 }, frame, viewport);
    expect(Number.isFinite(nan.x)).toBe(true);
    expect(Number.isFinite(nan.y)).toBe(true);
    expect(nan.x).toBeCloseTo(0, 6);
    expect(nan.y).toBeCloseTo(0, 6);
    const infinite = boundedCamera(
      { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY, zoom: 1 },
      frame,
      viewport,
    );
    expect(Number.isFinite(infinite.x)).toBe(true);
    expect(Number.isFinite(infinite.y)).toBe(true);
  });

  it('resists excess in CSS pixels while retaining a live elastic zoom', () => {
    const legal = { x: 100, y: -50, zoom: 8 };
    const live = resistedCameraBeyondBounds(
      { x: 200, y: -150, zoom: 9 },
      legal,
    );
    expect(live.x).toBeGreaterThan(legal.x);
    expect(live.x).toBeLessThan(200);
    expect(live.y).toBeLessThan(legal.y);
    expect(live.y).toBeGreaterThan(-150);
    expect(live.zoom).toBe(9);
  });
});

describe('fitCameraToFrame', () => {
  it.each([0.0525, 0.21, 10.5])(
    'fits embedded geometry at scale %s without navigation limits',
    (scale) => {
      const frame = { width: 1000, height: 1400 };
      const viewport = {
        width: frame.width * scale,
        height: frame.height * scale,
      };
      const camera = fitCameraToFrame(frame, viewport, 1, 'embedded')!;
      expect(camera.zoom).toBeCloseTo(scale, 10);
      expect(viewToSurface(camera, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
      const corner = viewToSurface(camera, {
        x: viewport.width,
        y: viewport.height,
      });
      expect(corner.x).toBeCloseTo(frame.width, 10);
      expect(corner.y).toBeCloseTo(frame.height, 10);
      const standalone = fitCameraToFrame(frame, viewport, 1)!;
      expect(standalone.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(standalone.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    },
  );

  it('scales and centers the bounded page to fill the viewport', () => {
    const camera = fitCameraToFrame(
      { width: 800, height: 600 },
      { width: 800, height: 600 },
      0.92,
    );
    expect(camera).not.toBeNull();
    const zoom = Math.min(800 / 800, 600 / 600) * 0.92;
    expect(camera!.zoom).toBeCloseTo(zoom, 10);
    expect(camera!.x).toBeCloseTo(800 / 2 - 800 / (2 * zoom), 10);
    expect(camera!.y).toBeCloseTo(600 / 2 - 600 / (2 * zoom), 10);
  });

  it('returns null when the frame or viewport is degenerate', () => {
    expect(fitCameraToFrame(null, { width: 800, height: 600 }, 1)).toBeNull();
    expect(
      fitCameraToFrame({ width: 800, height: 600 }, { width: 0, height: 0 }, 1),
    ).toBeNull();
  });
});

describe('elastic wheel-zoom composition parity with pinch', () => {
  const FRAME = { width: 800, height: 600 } as const;
  const VIEWPORT = { width: 800, height: 600 } as const;

  function wheelVisual(requestedZoom: number): number {
    return elasticZoom(requestedZoom, MIN_ZOOM, MAX_ZOOM).visualZoom;
  }

  function wheelTransient(
    current: { x: number; y: number; zoom: number },
    factor: number,
    anchor: { x: number; y: number },
    frame: { width: number; height: number } | null,
  ): { x: number; y: number; zoom: number } {
    const visual = wheelVisual(current.zoom * factor);
    const raw = zoomCameraAroundPointUnclamped(current, visual, anchor);
    const legal = boundedCamera(raw, frame, VIEWPORT);
    return resistedCameraBeyondBounds(raw, legal);
  }

  it('keeps an inside-bounds wheel zoom exactly cursor-anchored', () => {
    const current = { x: 0, y: 0, zoom: 1 };
    const anchor = { x: 400, y: 300 };
    const before = viewToSurface(current, anchor);
    const transient = wheelTransient(current, Math.exp(0.2), anchor, FRAME);
    expect(transient.zoom).toBeCloseTo(Math.exp(0.2), 9);
    const after = viewToSurface(transient, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    // Inside bounds the transient equals the legal camera (no resistance).
    const legal = boundedCamera(transient, FRAME, VIEWPORT);
    expect(transient).toEqual(legal);
  });

  it('shows diminishing visual gain for repeated overzoom ticks', () => {
    const current = { x: 0, y: 0, zoom: MAX_ZOOM };
    const factor = Math.exp(0.2);
    const first = wheelVisual(current.zoom * factor);
    // Second tick starts from the elastic visual (controller publishes the
    // transient), so its incremental gain is strictly smaller.
    const second = wheelVisual(first * factor);
    expect(first).toBeGreaterThan(MAX_ZOOM);
    expect(second).toBeGreaterThan(first);
    expect(second - first).toBeLessThan(first - MAX_ZOOM);
    // Both settle to the same clamped target.
    expect(Math.min(Math.max(first, MIN_ZOOM), MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(Math.min(Math.max(second, MIN_ZOOM), MAX_ZOOM)).toBe(MAX_ZOOM);
  });

  it('resists bounded position excess while leaving infinite position unclamped', () => {
    const anchor = { x: 400, y: 300 };
    // Bounded edge: raw beyond the sheet is resisted toward legal.
    const edge = { x: -744, y: 0, zoom: 1 };
    const edgeTransient = wheelTransient(edge, Math.exp(0.2), anchor, FRAME);
    const edgeRaw = zoomCameraAroundPointUnclamped(
      edge,
      wheelVisual(edge.zoom * Math.exp(0.2)),
      anchor,
    );
    const edgeLegal = boundedCamera(edgeRaw, FRAME, VIEWPORT);
    expect(edgeTransient.x).toBeGreaterThan(edgeRaw.x);
    expect(edgeTransient.x).toBeLessThan(edgeLegal.x + 100);
    // Infinite: position passes through unclamped, zoom still clamped.
    const far = { x: 10_000, y: -10_000, zoom: 1 };
    const farTransient = wheelTransient(far, Math.exp(0.2), anchor, null);
    const farRaw = zoomCameraAroundPointUnclamped(
      far,
      wheelVisual(far.zoom * Math.exp(0.2)),
      anchor,
    );
    expect(farTransient.x).toBeCloseTo(farRaw.x, 9);
    expect(farTransient.y).toBeCloseTo(farRaw.y, 9);
    expect(farTransient.zoom).toBeCloseTo(Math.exp(0.2), 9);
  });

  it('ignores non-finite wheel input without poisoning the camera', () => {
    const current = { x: 0, y: 0, zoom: 1 };
    expect(
      zoomCameraAroundPointUnclamped(current, Number.NaN, { x: 0, y: 0 }),
    ).toEqual(current);
    expect(
      zoomCameraAroundPointUnclamped(current, 2, {
        x: Number.NaN,
        y: 0,
      }),
    ).toEqual(current);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(wheelVisual(Number.NaN)).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(wheelVisual(Number.NaN)).toBeLessThanOrEqual(MAX_ZOOM);
  });
});
