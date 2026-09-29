/**
 * Frame-resize math.
 *
 * Owns resize hit testing, min/max clamping, coordinate conversion, and
 * frame mutation math as pure helpers. It must not own camera state or
 * rendering — callers pass cameras/frames in and apply the returned values.
 */

import type { Camera, Point, Size } from '@froglight/foundation';
import { clampFrameSize } from './camera.js';

export type ResizeMode = 'e' | 'w' | 'n' | 's' | 'ne' | 'nw' | 'se' | 'sw';

export const BORDER_GRAB_PX = 6;
export const CORNER_GRAB_PX = 12;
export const TOUCH_GRAB_PX = 22;
export const HANDLE_PX = 5;
export const HANDLE_CURSORS: Record<ResizeMode, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

export interface FrameRectView {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Map the bounded frame origin into view coordinates. */
export function frameRectView(
  camera: Camera,
  frame: Size | null,
): FrameRectView {
  if (frame === null) return { x: -1, y: -1, width: 0, height: 0 };
  return {
    x: (0 - camera.x) * camera.zoom,
    y: (0 - camera.y) * camera.zoom,
    width: frame.width * camera.zoom,
    height: frame.height * camera.zoom,
  };
}

/**
 * Paint-style hit test: the page border itself resizes the page.
 * Corners win over edges; the strip extends a few pixels outside the
 * frame so the grab zone is visible against the backdrop.
 */
export function borderHitMode(
  view: Point,
  rect: FrameRectView,
  frameResizable: boolean,
  pointerType = 'mouse',
): ResizeMode | null {
  if (!frameResizable) return null;
  if (rect.width === 0 && rect.height === 0) return null;
  const borderGrab = pointerType === 'touch' ? TOUCH_GRAB_PX : BORDER_GRAB_PX;
  const cornerGrab = pointerType === 'touch' ? TOUCH_GRAB_PX : CORNER_GRAB_PX;
  const near = (a: number, b: number, g: number) => Math.abs(a - b) <= g;
  const inSpanX =
    view.x >= rect.x - cornerGrab && view.x <= rect.x + rect.width + cornerGrab;
  const inSpanY =
    view.y >= rect.y - cornerGrab &&
    view.y <= rect.y + rect.height + cornerGrab;
  const nearLeft = near(view.x, rect.x, borderGrab) && inSpanY;
  const nearRight = near(view.x, rect.x + rect.width, borderGrab) && inSpanY;
  const nearTop = near(view.y, rect.y, borderGrab) && inSpanX;
  const nearBottom = near(view.y, rect.y + rect.height, borderGrab) && inSpanX;
  const cornerX =
    near(view.x, rect.x, cornerGrab) ||
    near(view.x, rect.x + rect.width, cornerGrab);
  const cornerY =
    near(view.y, rect.y, cornerGrab) ||
    near(view.y, rect.y + rect.height, cornerGrab);
  if (cornerX && cornerY) {
    const left = near(view.x, rect.x, cornerGrab);
    const top = near(view.y, rect.y, cornerGrab);
    return left ? (top ? 'nw' : 'sw') : top ? 'ne' : 'se';
  }
  if (nearLeft && nearTop) return 'nw';
  if (nearRight && nearTop) return 'ne';
  if (nearLeft && nearBottom) return 'sw';
  if (nearRight && nearBottom) return 'se';
  if (nearLeft) return 'w';
  if (nearRight) return 'e';
  if (nearTop) return 'n';
  if (nearBottom) return 's';
  return null;
}

export interface ResizedFrame {
  readonly frame: { width: number; height: number };
  readonly originAdjustX: number;
  readonly originAdjustY: number;
  readonly changed: boolean;
}

/**
 * Pure resize math: given the drag delta in surface units, compute the next
 * clamped frame plus the origin adjustment needed to keep the opposite edge
 * anchored while resizing west/north.
 */
export function computeResizedFrame(
  start: Size,
  mode: ResizeMode,
  dxUnits: number,
  dyUnits: number,
): ResizedFrame {
  const next = { width: start.width, height: start.height };
  if (mode.includes('e')) next.width = clampFrameSize(start.width + dxUnits);
  if (mode.includes('s')) next.height = clampFrameSize(start.height + dyUnits);
  if (mode.includes('w')) next.width = clampFrameSize(start.width - dxUnits);
  if (mode.includes('n')) next.height = clampFrameSize(start.height - dyUnits);
  const originAdjustX = mode.includes('w') ? start.width - next.width : 0;
  const originAdjustY = mode.includes('n') ? start.height - next.height : 0;
  return {
    frame: next,
    originAdjustX,
    originAdjustY,
    changed: next.width !== start.width || next.height !== start.height,
  };
}

/** Re-anchor the camera so the fixed edges stay put on screen. */
export function reanchorCameraForResize(
  startCamera: Camera,
  originAdjustX: number,
  originAdjustY: number,
): Camera {
  const originX = -startCamera.x + originAdjustX;
  const originY = -startCamera.y + originAdjustY;
  return { x: -originX, y: -originY, zoom: startCamera.zoom };
}
