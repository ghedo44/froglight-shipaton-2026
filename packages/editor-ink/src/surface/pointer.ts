/**
 * Pointer/gesture routing.
 *
 * Centralizes pen/mouse/touch classification, palm/touch delegation, and
 * normalized axis extraction. Palm rejection and embedded touch delegation
 * live here — never spread through render or camera code.
 */

import type { Point } from '@froglight/foundation';

export interface PointerTrack {
  readonly x: number;
  readonly y: number;
}

/** Map client coordinates into canvas-local view points (pure). */
export function viewPointFromRect(
  client: { readonly clientX: number; readonly clientY: number },
  rect: { readonly left: number; readonly top: number },
): Point {
  return { x: client.clientX - rect.left, y: client.clientY - rect.top };
}

export function centroid(points: Iterable<PointerTrack>): Point {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    count += 1;
  }
  return count === 0 ? { x: 0, y: 0 } : { x: sumX / count, y: sumY / count };
}

export function spread(points: readonly PointerTrack[]): number {
  if (points.length < 2) return 0;
  const [a, b] = points as [PointerTrack, PointerTrack];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface PointerAxes {
  readonly pressure?: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly twist?: number;
  readonly twistAngle?: number;
}

export interface NormalizedPointer {
  readonly point: Point;
  readonly pressure?: number;
  readonly tilt?: { readonly x: number; readonly y: number };
  readonly twist?: number;
}

/**
 * Extract pressure/tilt/twist from raw pointer axes (pure, DOM-free).
 * Mirrors the surface engine normalization: finite pressure in [0,1] is
 * preserved; tilt is `PointerEvent.tiltX/tiltY` degrees converted to radians
 * per axis, each clamped independently to [-π/2, π/2] (frozen v1);
 * twist is wrapped to [-π, π].
 */
export function normalizePointerAxes(
  point: Point,
  axes: PointerAxes,
): NormalizedPointer {
  const pressure =
    typeof axes.pressure === 'number' &&
    Number.isFinite(axes.pressure) &&
    axes.pressure >= 0 &&
    axes.pressure <= 1
      ? axes.pressure
      : undefined;
  let tilt: { readonly x: number; readonly y: number } | undefined;
  if (typeof axes.tiltX === 'number' && typeof axes.tiltY === 'number') {
    const clampTiltAxis = (degrees: number): number => {
      if (!Number.isFinite(degrees)) return Number.NaN;
      return Math.max(
        -Math.PI / 2,
        Math.min(Math.PI / 2, (degrees * Math.PI) / 180),
      );
    };
    const x = clampTiltAxis(axes.tiltX);
    const y = clampTiltAxis(axes.tiltY);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      // Zero vector means "no tilt data" (upright pen): omit rather than
      // storing a zero vector, preserving the absent-means-no-data rule.
      if (x !== 0 || y !== 0) tilt = { x, y };
    }
  }
  let twist: number | undefined;
  const twistAngle = axes.twist ?? axes.twistAngle;
  if (typeof twistAngle === 'number' && Number.isFinite(twistAngle)) {
    const raw = (twistAngle * Math.PI) / 180;
    // Wrap to [-π, π] with a single remainder — no unbounded loop for
    // pathological magnitudes, and non-finite inputs are already excluded.
    const twoPi = Math.PI * 2;
    twist = ((((raw + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
    if (!Number.isFinite(twist)) twist = undefined;
  }
  return {
    point,
    ...(pressure !== undefined ? { pressure } : {}),
    ...(tilt !== undefined ? { tilt } : {}),
    ...(twist !== undefined ? { twist } : {}),
  };
}

export type PointerType = 'pen' | 'mouse' | 'touch' | (string & {});
export type PointerMode =
  | 'idle'
  | 'draw'
  | 'pan'
  | 'pinch'
  | 'resize'
  | 'resize-object';

/**
 * W3C Pointer Events pen-button classification:
 * 0 pen contact, 1 barrel (auxiliary, some tablets), 2 barrel, 5 eraser.
 * Mouse middle (1) stays a pan affordance and is classified separately.
 */
export type PenButtonKind =
  | 'contact'
  | 'barrel'
  | 'eraser'
  | 'middle'
  | 'other';

export function classifyPenButton(
  pointerType: PointerType,
  button: number,
): PenButtonKind {
  if (pointerType !== 'pen') return button === 1 ? 'middle' : 'other';
  if (button === 0) return 'contact';
  if (button === 2) return 'barrel';
  if (button === 5) return 'eraser';
  if (button === 1) return 'middle';
  return 'other';
}

export interface PointerDownGate {
  readonly pointerType: PointerType;
  readonly delegateTouchNavigation?: boolean;
  readonly destroyed: boolean;
}

/**
 * Top-level pointerdown gate (pure). Returns true when the event must be
 * ignored entirely: destroyed surfaces or touch input delegated to an
 * embedding pager (Notebook vertical stack).
 */
export function shouldIgnorePointerDown(gate: PointerDownGate): boolean {
  if (gate.destroyed) return true;
  if (gate.pointerType === 'touch' && gate.delegateTouchNavigation === true) {
    return true;
  }
  return false;
}

/**
 * Mid-draw palm guard (pure). A stylus/mouse draws; fingers navigate. An
 * incidental touch contact arriving while mode === 'draw' must never join
 * the pen stroke as a sample.
 */
export function shouldRejectTouchDuringDraw(options: {
  readonly mode: PointerMode | (string & {});
  readonly pointerType: PointerType;
  readonly cameraInteractive: boolean;
}): boolean {
  return (
    options.pointerType === 'touch' &&
    options.cameraInteractive &&
    options.mode === 'draw'
  );
}
