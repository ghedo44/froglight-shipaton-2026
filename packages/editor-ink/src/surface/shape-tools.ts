/**
 * Provider-owned shape tool construction.
 *
 * Rectangle/ellipse/line/text tool construction lives here instead of
 * interleaved with surface lifecycle. Tool registration remains
 * provider-local and uses the existing SurfaceToolRegistry contract.
 */

import {
  ellipseObject,
  lineObject,
  normalizeBox,
  rectangleObject,
  SURFACE_TOOL_IDS,
  viewToSurface,
  type DrawItem,
  type PenStyleRef,
  type Point,
  type SurfaceObjectRecord,
  type SurfaceTool,
} from '@froglight/foundation';

export const INK_TOOL_IDS = {
  ...SURFACE_TOOL_IDS,
  rect: 'froglight.ink.rect',
  triangle: 'froglight.ink.triangle',
  diamond: 'froglight.ink.diamond',
  ellipse: 'froglight.ink.ellipse',
  line: 'froglight.ink.line',
  text: 'froglight.ink.text',
} as const;

export const SHAPE_WIDTH_FALLBACK = 2;

export interface TwoPointToolOptions {
  readonly toolId: string;
  readonly penStyle: PenStyleRef;
  /**
   * Tap target size in surface units (Paint behavior: a tap without a drag
   * commits a small default object). Defaults to a 40x24 rectangle; the
   * whiteboard card passes its 200x120 default instead.
   */
  readonly tapSize?: { readonly width: number; readonly height: number };
  readonly commit: (
    id: string,
    a: Point,
    b: Point,
    style: PenStyleRef,
  ) => SurfaceObjectRecord;
  readonly previewItem: (
    objectId: string,
    a: Point,
    b: Point,
    style: PenStyleRef,
  ) => DrawItem;
}

export interface InkShapeToolOptions {
  readonly cornerRadius?: () => number;
  readonly shapeAppearance?: () => 'fill' | 'outline';
  readonly lineArrows?: () => 'none' | 'start' | 'end' | 'both';
}

function envelopeFor(
  box: { x: number; y: number; width: number; height: number },
  pad: number,
) {
  return {
    x: box.x - pad / 2,
    y: box.y - pad / 2,
    width: box.width + pad,
    height: box.height + pad,
  };
}

export function twoPointShapeTool(options: TwoPointToolOptions): SurfaceTool {
  let anchor: Point | null = null;
  const styleOf = (): PenStyleRef => ({
    width: options.penStyle.width ?? SHAPE_WIDTH_FALLBACK,
    color: options.penStyle.color,
  });
  return {
    toolId: options.toolId,
    version: 1,
    onDown: (ctx, event) => {
      anchor = viewToSurface(ctx.camera(), event.point);
      ctx.setPreview([]);
    },
    onMove: (ctx, event) => {
      if (anchor === null) return;
      const current = viewToSurface(ctx.camera(), event.point);
      ctx.setPreview([
        options.previewItem('@shape', anchor, current, styleOf()),
      ]);
    },
    onUp: (ctx, event) => {
      if (anchor === null) {
        return;
      }
      const current = viewToSurface(ctx.camera(), event.point);
      // A tap commits a small default object (Paint behavior).
      const tapped = Math.hypot(current.x - anchor.x, current.y - anchor.y) < 2;
      const tapSize = options.tapSize ?? { width: 40, height: 24 };
      const target = tapped
        ? { x: anchor.x + tapSize.width, y: anchor.y + tapSize.height }
        : current;
      const id = ctx.newObjectId();
      ctx.addObject(options.commit(id, anchor, target, styleOf()));
      anchor = null;
    },
    onCancel: (ctx) => {
      anchor = null;
      ctx.setPreview([]);
    },
  };
}

export function boxPreview(
  kind: 'rect' | 'ellipse',
  objectId: string,
  a: Point,
  b: Point,
  style: PenStyleRef,
): DrawItem {
  const box = normalizeBox(a, b);
  const bounds = envelopeFor(box, style.width ?? SHAPE_WIDTH_FALLBACK);
  const fill = style.color !== undefined ? { fill: style.color } : {};
  if (kind === 'rect') {
    return { kind, objectId, bounds, rotation: 0, ...fill };
  }
  return { kind, objectId, bounds, rotation: 0, ...fill };
}

/**
 * Provider-owned creation tools over the shared two-point seam.
 * Returns rect/ellipse/line plus the text placeholder entry.
 */
export function createInkShapeTools(
  penStyle: PenStyleRef,
  options: InkShapeToolOptions = {},
): SurfaceTool[] {
  const appearance = (style: PenStyleRef) =>
    options.shapeAppearance?.() === 'outline'
      ? {
          stroke: style.color ?? '#37352f',
          strokeWidth: style.width ?? 2,
          cornerRadius: options.cornerRadius?.() ?? 0,
        }
      : {
          fill: style.color ?? '#37352f',
          strokeWidth: style.width ?? 2,
          cornerRadius: options.cornerRadius?.() ?? 0,
        };
  const lineArrows = (): 'start' | 'end' | 'both' | undefined => {
    const arrows = options.lineArrows?.() ?? 'end';
    return arrows === 'none' ? undefined : arrows;
  };
  return [
    twoPointShapeTool({
      toolId: INK_TOOL_IDS.rect,
      penStyle,
      commit: (id, a, b, style) =>
        rectangleObject(id, {
          ...normalizeBox(a, b),
          ...appearance(style),
        }),
      previewItem: (id, a, b, style) => ({
        ...boxPreview('rect', id, a, b, style),
        fill: undefined,
        ...appearance(style),
      }),
    }),
    twoPointShapeTool({
      toolId: INK_TOOL_IDS.ellipse,
      penStyle,
      commit: (id, a, b, style) =>
        ellipseObject(id, {
          ...normalizeBox(a, b),
          ...appearance(style),
        }),
      previewItem: (id, a, b, style) => ({
        ...boxPreview('ellipse', id, a, b, style),
        fill: undefined,
        ...appearance(style),
      }),
    }),
    twoPointShapeTool({
      toolId: INK_TOOL_IDS.line,
      penStyle,
      commit: (id, a, b, style) =>
        (() => {
          const arrows = lineArrows();
          return lineObject(id, {
            x: a.x,
            y: a.y,
            x2: b.x,
            y2: b.y,
            ...(arrows === undefined ? {} : { arrows }),
            ...(style.width !== undefined ? { width: style.width } : {}),
            ...(style.color !== undefined ? { color: style.color } : {}),
          });
        })(),
      previewItem: (id, a, b, style): DrawItem => {
        const arrows = lineArrows();
        const pad = (style.width ?? 2) / 2 + 6;
        return {
          kind: 'line',
          objectId: id,
          bounds: {
            x: Math.min(a.x, b.x) - pad,
            y: Math.min(a.y, b.y) - pad,
            width: Math.abs(b.x - a.x) + pad * 2,
            height: Math.abs(b.y - a.y) + pad * 2,
          },
          rotation: 0,
          x: a.x,
          y: a.y,
          x2: b.x,
          y2: b.y,
          width: style.width ?? SHAPE_WIDTH_FALLBACK,
          ...(arrows === undefined ? {} : { arrows }),
          ...(style.color !== undefined ? { color: style.color } : {}),
        };
      },
    }),
    { toolId: INK_TOOL_IDS.text, version: 1 },
    ...(['triangle', 'diamond'] as const).map((shape) =>
      twoPointShapeTool({
        toolId: INK_TOOL_IDS[shape],
        penStyle,
        commit: (id, a, b, style) =>
          rectangleObject(id, {
            ...normalizeBox(a, b),
            shape,
            ...appearance(style),
          }),
        previewItem: (id, a, b, style): DrawItem => ({
          kind: 'rect',
          objectId: id,
          bounds: normalizeBox(a, b),
          rotation: 0,
          shape,
          ...appearance(style),
        }),
      }),
    ),
  ];
}
