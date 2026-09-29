/**
 * Render-scene assembly.
 *
 * Owns committed-layer background assembly math, selection envelope
 * computation, page-rect mapping, and canvas affordance painting through the
 * existing renderer-backend seam. Backends consume draw items plus image
 * resolution only; this module never adds derived state to SurfaceModel,
 * never changes serialization, and never alters provider-local undo.
 */

import {
  viewportSurfaceRect,
  createDefaultSurfaceObjectTypeRegistry,
  type Bounds,
  type Camera,
  type Point,
  type Size,
  type SurfaceModel,
  type SurfaceObjectTypeRegistry,
} from '@froglight/foundation';

export interface PageViewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Map the bounded frame origin into view coordinates (pure). */
export function computePageViewRect(
  camera: Camera,
  frame: Size | null,
): PageViewRect | null {
  if (frame === null) return null;
  return {
    x: (0 - camera.x) * camera.zoom,
    y: (0 - camera.y) * camera.zoom,
    width: frame.width * camera.zoom,
    height: frame.height * camera.zoom,
  };
}

export interface DotGrid {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly dotRadius: number;
  readonly spacing: number;
}

/**
 * Orientation-dot lattice for the Paint stage (pure). Returns null when the
 * grid would be invisible (zoom * spacing < 9) or when inputs are degenerate.
 */
export function computeDotGrid(
  camera: Camera,
  frame: Size,
  viewportSize: Size,
  spacing: number,
): DotGrid | null {
  if (camera.zoom * spacing < 9) return null;
  if (frame.width <= 0 || frame.height <= 0) return null;
  const visible = viewportSurfaceRect(camera, viewportSize);
  const startX = Math.max(0, Math.floor(visible.x / spacing) * spacing);
  const startY = Math.max(0, Math.floor(visible.y / spacing) * spacing);
  const endX = Math.min(frame.width, visible.x + visible.width);
  const endY = Math.min(frame.height, visible.y + visible.height);
  return {
    startX,
    startY,
    endX,
    endY,
    dotRadius: 1.1 / camera.zoom,
    spacing,
  };
}

/**
 * Dashed union outline source: union of selected object bounds (pure).
 * Returns null when no selected object contributes bounds.
 */
export function computeSelectionEnvelope(
  model: SurfaceModel,
  ids: readonly string[],
  objectRegistry: SurfaceObjectTypeRegistry,
): Bounds | null {
  let envelope: Bounds | null = null;
  for (const id of ids) {
    const record = model.objects[id];
    if (record === undefined) continue;
    const bounds = objectRegistry.get(record.type)?.boundsOf?.(record);
    if (bounds === undefined || bounds === null) continue;
    const maxX = Math.max(
      envelope === null ? bounds.x : envelope.x + envelope.width,
      bounds.x + bounds.width,
    );
    const maxY = Math.max(
      envelope === null ? bounds.y : envelope.y + envelope.height,
      bounds.y + bounds.height,
    );
    envelope =
      envelope === null
        ? { ...bounds }
        : {
            x: Math.min(envelope.x, bounds.x),
            y: Math.min(envelope.y, bounds.y),
            width: maxX - Math.min(envelope.x, bounds.x),
            height: maxY - Math.min(envelope.y, bounds.y),
          };
  }
  return envelope;
}

export interface ImageObjectGeometry {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Single-image resize-handle hit test in view coordinates (pure). */
export function isImageResizeHandleHit(
  view: Point,
  camera: Camera,
  record: { x: number; y: number; width: number; height: number },
  tolerancePx = 10,
): boolean {
  const right = (record.x + record.width - camera.x) * camera.zoom;
  const bottom = (record.y + record.height - camera.y) * camera.zoom;
  return (
    Math.abs(view.x - right) <= tolerancePx &&
    Math.abs(view.y - bottom) <= tolerancePx
  );
}

export type TokenResolver = (name: string, fallback: string) => string;

interface CanvasLike {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(segments: number[]): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha?: number;
}

/** Subtle union outline: selection must be visible on every object kind. */
export function paintSelectionChrome(
  ctx: CanvasLike | null,
  dpr: number,
  token: TokenResolver,
  model: SurfaceModel,
  camera: Camera,
  ids: readonly string[],
  objectRegistry: SurfaceObjectTypeRegistry,
): void {
  if (ctx === null || ids.length === 0) return;
  const envelope = computeSelectionEnvelope(model, ids, objectRegistry);
  if (envelope === null) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = (envelope.x - camera.x) * camera.zoom;
  const y = (envelope.y - camera.y) * camera.zoom;
  ctx.strokeStyle = token('--fl-accent', '#7c6cf0');
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([]);
  ctx.strokeRect(
    x - 3,
    y - 3,
    envelope.width * camera.zoom + 6,
    envelope.height * camera.zoom + 6,
  );
  ctx.setLineDash([]);
  ctx.restore();
}

/** Single-image resize handle square at the object bottom-right. */
export function paintObjectResizeHandle(
  ctx: CanvasLike | null,
  dpr: number,
  token: TokenResolver,
  model: SurfaceModel,
  camera: Camera,
  ids: readonly string[],
  registry: SurfaceObjectTypeRegistry = createDefaultSurfaceObjectTypeRegistry(),
): void {
  if (ctx === null || ids.length !== 1) return;
  const id = ids[0];
  if (id === undefined) return;
  const record = model.objects[id];
  if (
    record === undefined ||
    record.locked === true ||
    ![
      'froglight.text',
      'froglight.card',
      'froglight.image',
      'froglight.rectangle',
      'froglight.ellipse',
    ].includes(record.type)
  )
    return;
  const bounds = registry.get(record.type)?.boundsOf?.(record);
  if (bounds == null) return;
  const right = (bounds.x + bounds.width - camera.x) * camera.zoom;
  const bottom = (bounds.y + bounds.height - camera.y) * camera.zoom;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = token('--fl-surface-raised', '#ffffff');
  ctx.strokeStyle = token('--fl-accent', '#7c6cf0');
  ctx.lineWidth = 1;
  ctx.fillRect(right - 3, bottom - 3, 6, 6);
  ctx.strokeRect(right - 3, bottom - 3, 6, 6);
  ctx.restore();
}

/** Corner squares over the bounded frame. */
export function paintResizeHandles(
  ctx: CanvasLike | null,
  dpr: number,
  token: TokenResolver,
  rect: PageViewRect | null,
  handlePx: number,
): void {
  if (ctx === null || rect === null) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const corners: Array<[number, number]> = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ];
  for (const [hx, hy] of corners) {
    ctx.fillStyle = token('--fl-surface-raised', '#ffffff');
    ctx.strokeStyle = token('--fl-accent', '#7c6cf0');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(hx - handlePx, hy - handlePx, handlePx * 2, handlePx * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
