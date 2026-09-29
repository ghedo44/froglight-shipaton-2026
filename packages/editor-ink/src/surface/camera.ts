/**
 * Camera/navigation math.
 *
 * Pure transform math separate from event binding. Zooming/panning returns
 * new Camera values and never mutates committed stroke/object coordinates.
 */

import {
  viewToSurface,
  type Camera,
  type Point,
  type Size,
} from '@froglight/foundation';
import { rubberBand } from '../navigation/index.js';

export const MIN_FRAME_SIZE = 64;
export const MAX_FRAME_SIZE = 20_000;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
export const CAMERA_EDGE_PX = 56;

/** Shared size vocabulary comes from foundation; local aliases keep seams readable. */
export type ViewportSize = Size;
export type FrameSize = Size;

export type PresentationKind =
  | 'paint-stage'
  | 'embedded-paper'
  | 'embedded-overlay';

/** Fit inset policy: Paint owns a sheet with breathing room, embedded fills. */
export function fitInsetForPresentation(
  presentation: PresentationKind,
): number {
  return presentation === 'paint-stage' ? 0.92 : 1;
}

/** Clamp a zoom factor to the finite sheet range. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

/** Clamp a frame dimension to the sheet limits (rounded). */
export function clampFrameSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_FRAME_SIZE;
  return Math.min(Math.max(Math.round(value), MIN_FRAME_SIZE), MAX_FRAME_SIZE);
}

/**
 * Zoom keeping the surface point under `anchorView` fixed on screen.
 * Non-finite targets leave the camera unchanged.
 */
export function zoomCameraAroundPoint(
  current: Camera,
  nextZoom: number,
  anchorView: Point,
): Camera {
  if (!Number.isFinite(nextZoom)) return current;
  const zoom = clampZoom(nextZoom);
  return zoomCameraAroundPointUnclamped(current, zoom, anchorView);
}

/**
 * Map the surface point under `anchorView` to `nextAnchorView` at an
 * unclamped positive zoom. This is the finite primitive used by live pinch
 * transforms; settled commands continue through `zoomCameraAroundPoint`.
 */
export function zoomCameraAroundPointUnclamped(
  current: Camera,
  nextZoom: number,
  anchorView: Point,
  nextAnchorView: Point = anchorView,
): Camera {
  if (
    !Number.isFinite(nextZoom) ||
    nextZoom <= 0 ||
    !Number.isFinite(anchorView.x) ||
    !Number.isFinite(anchorView.y) ||
    !Number.isFinite(nextAnchorView.x) ||
    !Number.isFinite(nextAnchorView.y)
  )
    return current;
  const surfaceAnchor = viewToSurface(current, anchorView);
  return {
    x: surfaceAnchor.x - nextAnchorView.x / nextZoom,
    y: surfaceAnchor.y - nextAnchorView.y / nextZoom,
    zoom: nextZoom,
  };
}

/** Resist camera displacement beyond a hard legal camera in CSS pixels. */
export function resistedCameraBeyondBounds(
  camera: Camera,
  legal: Camera,
): Camera {
  if (
    !Number.isFinite(camera.x) ||
    !Number.isFinite(camera.y) ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0
  )
    return legal;
  const resistAxis = (value: number, legalValue: number): number => {
    const excessPx = (value - legalValue) * camera.zoom;
    return legalValue + rubberBand(excessPx) / camera.zoom;
  };
  return {
    x: resistAxis(camera.x, legal.x),
    y: resistAxis(camera.y, legal.y),
    zoom: camera.zoom,
  };
}

/**
 * Keep a finite sheet reachable without permitting an infinite desk.
 * Pure: frame/viewport are passed in, the input camera is never mutated.
 */
export function boundedCamera(
  camera: Camera,
  frame: FrameSize | null,
  viewport: ViewportSize,
  minimumVisibleFraction?: number,
): Camera {
  const zoom = clampZoom(camera.zoom);
  if (frame === null || viewport.width <= 0 || viewport.height <= 0) {
    // Infinite or degenerate frames have no centered fallback, but
    // a NaN-poisoned camera must never propagate — fall back to finite 0 so
    // a NaN wheel delta cannot stick the infinite camera.
    const x = Number.isFinite(camera.x) ? camera.x : 0;
    const y = Number.isFinite(camera.y) ? camera.y : 0;
    return { x, y, zoom };
  }
  const clampAxis = (
    value: number,
    frameSize: number,
    viewportSize: number,
  ): number => {
    const visibleMargin = Math.min(CAMERA_EDGE_PX, viewportSize / 4);
    const min = -(viewportSize - visibleMargin) / zoom;
    const max = frameSize - visibleMargin / zoom;
    const centered = frameSize / 2 - viewportSize / (2 * zoom);
    if (frameSize * zoom <= viewportSize - visibleMargin * 2) {
      return centered;
    }
    if (!Number.isFinite(value)) {
      return Math.min(Math.max(centered, min), max);
    }
    return Math.min(Math.max(value, min), max);
  };
  const legal = {
    x: clampAxis(camera.x, frame.width, viewport.width),
    y: clampAxis(camera.y, frame.height, viewport.height),
    zoom,
  };
  if (minimumVisibleFraction === undefined) return legal;

  const visibleArea = (candidate: Camera): number => {
    const left = Math.max(0, candidate.x);
    const top = Math.max(0, candidate.y);
    const right = Math.min(frame.width, candidate.x + viewport.width / zoom);
    const bottom = Math.min(frame.height, candidate.y + viewport.height / zoom);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  };
  const maximumArea =
    Math.min(frame.width, viewport.width / zoom) *
    Math.min(frame.height, viewport.height / zoom);
  if (visibleArea(legal) >= minimumVisibleFraction * maximumArea) return legal;

  // The centered view shows the maximum possible sheet area. Move along
  // the requested pan until exactly the allowed fraction remains visible.
  const centered = {
    x: frame.width / 2 - viewport.width / (2 * zoom),
    y: frame.height / 2 - viewport.height / (2 * zoom),
    zoom,
  };
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const fraction = (low + high) / 2;
    const candidate = {
      x: centered.x + (legal.x - centered.x) * fraction,
      y: centered.y + (legal.y - centered.y) * fraction,
      zoom,
    };
    if (visibleArea(candidate) >= minimumVisibleFraction * maximumArea)
      low = fraction;
    else high = fraction;
  }
  return {
    x: centered.x + (legal.x - centered.x) * low,
    y: centered.y + (legal.y - centered.y) * low,
    zoom,
  };
}

/**
 * Scale and center the bounded page to fill the viewport (Paint model).
 * Returns null when the frame or viewport is degenerate.
 */
export function fitCameraToFrame(
  frame: FrameSize | null,
  viewport: ViewportSize,
  inset: number,
  scalePolicy: 'navigation' | 'embedded' = 'navigation',
): Camera | null {
  if (frame === null || viewport.width === 0 || viewport.height === 0) {
    return null;
  }
  if (frame.width <= 0 || frame.height <= 0) return null;
  const fittedScale =
    Math.min(viewport.width / frame.width, viewport.height / frame.height) *
    inset;
  if (!Number.isFinite(fittedScale) || fittedScale <= 0) return null;
  // Embedded scale converts document units to the full page layout; the
  // containing pager owns user zoom limits.
  const zoom =
    scalePolicy === 'embedded' ? fittedScale : clampZoom(fittedScale);
  return {
    x: frame.width / 2 - viewport.width / (2 * zoom),
    y: frame.height / 2 - viewport.height / (2 * zoom),
    zoom,
  };
}
