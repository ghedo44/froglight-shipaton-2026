import { mapInkRegion } from './ink/fragments.js';
/**
 * Selection geometry and record appearance operations shared by Surface tools.
 *
 * This module owns the headless calculations for selecting, describing, and
 * transforming Surface records. `InkToolController` remains responsible for
 * editor history, mutation notifications, and gesture lifecycle.
 */

import {
  boundsIntersect,
  centerOfBounds,
  finiteNumber,
  pointInPolygon,
  pointSegmentDistance,
  rotateAround,
  segmentIntersectsPolygon,
  segmentsIntersect,
  type Bounds,
  type Point,
} from './geometry.js';
import {
  SURFACE_MAX_COORDINATE,
  SURFACE_OBJECT_TYPES,
  type ConnectorAnchor,
  type SurfaceModel,
  type SurfaceObjectId,
  type SurfaceObjectRecord,
} from './model.js';
import { hitVisible, type InkErasure } from './ink/erasure.js';
import {
  groupOfMember,
  inkInteractionRecord,
  inkStrokeContoursOfRecord,
  inkStrokeEnvelope,
  resolveGroupMembers,
  rotationOf,
  smoothSpineOfRecord,
} from './objects.js';
import {
  matchesEraserFilter,
  segmentIntersectsBox,
  type EraserFilter,
} from './ink/eraser-geometry.js';
import type { SurfaceObjectTypeRegistry } from './registry.js';
import { anchorPoint } from './ink/connectors.js';

interface SelectionContext {
  readonly model: SurfaceModel;
  readonly objectRegistry: SurfaceObjectTypeRegistry;
  selection(): readonly SurfaceObjectId[];
}

function strokePolylineOf(record: SurfaceObjectRecord): Point[] {
  // Lasso selection tests the rendered centerline, so sparse pointer samples
  // cannot hide visible ink from a region crossing it.
  return smoothSpineOfRecord(record);
}

export function selectionEnvelope(ctx: SelectionContext): Bounds | null {
  return selectionBoundsFor(ctx.model, ctx.objectRegistry, ctx.selection());
}

export function selectionBoundsFor(
  model: SurfaceModel,
  registry: SurfaceObjectTypeRegistry,
  ids: readonly SurfaceObjectId[],
  boundsOf: (record: SurfaceObjectRecord) => Bounds | null = (record) =>
    registry.get(record.type)?.boundsOf?.(record) ?? null,
): Bounds | null {
  let envelope: Bounds | null = null;
  const measuredInk = new Set<SurfaceObjectRecord>();
  // Groups carry no bounds: expand to members so group selections move.
  for (const id of resolveGroupMembers(model, ids)) {
    const record = model.objects[id];
    if (record === undefined) continue;
    const source =
      record.type === SURFACE_OBJECT_TYPES.stroke
        ? inkInteractionRecord(model, record)
        : record;
    if (
      source.type === SURFACE_OBJECT_TYPES.stroke &&
      source.erasure !== undefined
    ) {
      if (measuredInk.has(source)) continue;
      measuredInk.add(source);
      // Masks preserve the original samples and rotation pivot. Selection
      // follows only their surviving fill, in world coordinates.
      const originalBounds = inkStrokeEnvelope(source);
      if (originalBounds === null) continue;
      const pivot = centerOfBounds(originalBounds);
      const rotation = rotationOf(source);
      for (const contour of inkStrokeContoursOfRecord(source))
        for (const point of contour) {
          const p =
            rotation === 0 ? point : rotateAround(point, pivot, rotation);
          envelope = foldBounds(envelope, {
            x: p.x,
            y: p.y,
            width: 0,
            height: 0,
          });
        }
      continue;
    }
    const bounds = boundsOf(record);
    if (bounds === null) continue;
    envelope = foldBounds(envelope, bounds);
  }
  return envelope;
}

/** Fold one bounds into a running union (pure). */
export function foldBounds(acc: Bounds | null, next: Bounds): Bounds {
  if (acc === null) return { ...next };
  const maxX = Math.max(acc.x + acc.width, next.x + next.width);
  const maxY = Math.max(acc.y + acc.height, next.y + next.height);
  const x = Math.min(acc.x, next.x);
  const y = Math.min(acc.y, next.y);
  return { x, y, width: maxX - x, height: maxY - y };
}

/** Center of optional bounds; null when there is no geometry. */
export function selectionCenterOf(bounds: Bounds | null): Point | null {
  return bounds === null
    ? null
    : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/**
 * Draggable handles for exactly one selected, unlocked handle-owner:
 * both endpoints of a lone connector, or the four edge anchors of
 * a lone bounded shape. Anything else yields no handles.
 */
export function selectionHandles(
  model: SurfaceModel,
  registry: SurfaceObjectTypeRegistry,
  ids: readonly SurfaceObjectId[],
  zoom = 1,
): SelectionHandle[] {
  if (ids.length !== 1) return [];
  const id = ids[0]!;
  const record = model.objects[id];
  if (record === undefined || record.locked === true) return [];
  // Members shelter under a locked group: no drag handles.
  const shelter = groupOfMember(
    model as {
      order: readonly string[];
      objects: Record<
        string,
        { type?: unknown; children?: unknown } | undefined
      >;
    },
    id,
  );
  if (
    shelter !== null &&
    (model.objects[shelter] as SurfaceObjectRecord | undefined)?.locked === true
  ) {
    return [];
  }
  if (record.type === SURFACE_OBJECT_TYPES.line) {
    const x = finiteNumber(record.x);
    const y = finiteNumber(record.y);
    const x2 = finiteNumber(record.x2);
    const y2 = finiteNumber(record.y2);
    if (x === null || y === null || x2 === null || y2 === null) return [];
    return [
      { kind: 'connector-endpoint', objectId: id, end: 'source', x, y },
      { kind: 'connector-endpoint', objectId: id, end: 'target', x: x2, y: y2 },
    ];
  }
  const bounds = registry.get(record.type)?.boundsOf?.(record);
  if (bounds === undefined || bounds === null) return [];
  const anchors: ConnectorAnchor[] = ['n', 's', 'e', 'w'];
  const hook = registry.get(record.type)?.connectorAnchor;
  if (hook === undefined) return [];
  return anchors.map((anchor) => {
    let point: Point | null = null;
    if (hook !== undefined) {
      try {
        point = hook(record, anchor) ?? null;
      } catch {
        point = null;
      }
    }
    point ??= anchorPoint(bounds, anchor);
    const center = anchorPoint(bounds, 'center');
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const length = Math.hypot(dx, dy);
    if (length > 0) {
      const offset = 8 / Math.max(zoom, 1e-9);
      point = {
        x: point.x + (dx / length) * offset,
        y: point.y + (dy / length) * offset,
      };
    }
    return {
      kind: 'anchor',
      objectId: id,
      anchor,
      x: point.x,
      y: point.y,
    };
  });
}

/** Closed selection region: freehand path, marquee box, or fitted circle. */
export type SelectionRegion =
  | { readonly path: readonly Point[] }
  | { readonly box: Bounds }
  | {
      readonly circle: {
        readonly x: number;
        readonly y: number;
        readonly radius: number;
      };
    };

function pointInRegion(p: Point, region: SelectionRegion): boolean {
  if ('path' in region) return pointInPolygon(p, region.path as Point[]);
  if ('box' in region) {
    const box = region.box;
    return (
      p.x >= box.x &&
      p.x <= box.x + box.width &&
      p.y >= box.y &&
      p.y <= box.y + box.height
    );
  }
  const c = region.circle;
  return Math.hypot(p.x - c.x, p.y - c.y) <= c.radius;
}

function boundsInRegion(bounds: Bounds, region: SelectionRegion): boolean {
  if ('box' in region) return boundsIntersect(bounds, region.box);
  if ('circle' in region) {
    // Closest point on the rect to the center decides intersection.
    const c = region.circle;
    const nx = Math.min(Math.max(c.x, bounds.x), bounds.x + bounds.width);
    const ny = Math.min(Math.max(c.y, bounds.y), bounds.y + bounds.height);
    return Math.hypot(c.x - nx, c.y - ny) <= c.radius;
  }
  // Freehand over sized content: any corner inside the path, any path
  // vertex inside the bounds, or any edge crossing (covers thin shapes
  // sliced by the lasso with no corner/vertex inside).
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
  if (corners.some((corner) => pointInRegion(corner, region))) return true;
  const path = region.path as Point[];
  if (
    path.some(
      (p) =>
        p.x >= bounds.x &&
        p.x <= bounds.x + bounds.width &&
        p.y >= bounds.y &&
        p.y <= bounds.y + bounds.height,
    )
  ) {
    return true;
  }
  const edges: Array<[Point, Point]> = [
    [corners[0]!, corners[1]!],
    [corners[1]!, corners[3]!],
    [corners[3]!, corners[2]!],
    [corners[2]!, corners[0]!],
  ];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    for (const [c, d] of edges) {
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/**
 * True when a record is locked for interaction: directly flagged, or a
 * member sheltered under a locked group. Locked objects render normally
 * but are skipped by hit-testing, selection, erasing, moves, and handles.
 */
export function isRecordLocked(
  ctx: Pick<SelectionContext, 'model'>,
  record: SurfaceObjectRecord,
): boolean {
  if (record.locked === true) return true;
  const shelter = groupOfMember(
    ctx.model as {
      order: readonly string[];
      objects: Record<
        string,
        { type?: unknown; children?: unknown } | undefined
      >;
    },
    record.id,
  );
  if (shelter === null) return false;
  return (
    (ctx.model.objects[shelter] as SurfaceObjectRecord | undefined)?.locked ===
    true
  );
}

/**
 * True when a record falls in a closed region under a content filter.
 * Shared by the lasso tool and circle-to-lasso conversion. Strokes test
 * *segments* (not just stored samples) so sparse strokes crossing the
 * region select even when no sample falls inside it.
 * Locked records never select.
 */
export function recordInRegion(
  ctx: SelectionContext,
  record: SurfaceObjectRecord,
  region: SelectionRegion,
  filter: EraserFilter,
): boolean {
  if (isRecordLocked(ctx, record)) return false;
  if (!matchesEraserFilter(record, filter)) return false;
  if (record.type === SURFACE_OBJECT_TYPES.stroke) {
    record = inkInteractionRecord(ctx.model, record);
    if (record.erasure === undefined)
      return strokeInRegion(strokePolylineOf(record), region);
    const envelope = inkStrokeEnvelope(record);
    if (envelope === null) return false;
    const pivot = centerOfBounds(envelope);
    const contours = inkStrokeContoursOfRecord(record).map((ring) =>
      ring.map((p) => rotateAround(p, pivot, rotationOf(record))),
    );
    if (contours.some((ring) => strokeInRegion(ring, region))) return true;
    const probe =
      'box' in region
        ? { x: region.box.x, y: region.box.y }
        : 'circle' in region
          ? { x: region.circle.x, y: region.circle.y }
          : region.path[0];
    return probe !== undefined && hitVisible(contours, probe);
  }
  const bounds = ctx.objectRegistry.get(record.type)?.boundsOf?.(record);
  if (bounds === undefined || bounds === null) return false;
  return boundsInRegion(bounds, region);
}

/** Segment-correct stroke/region test for selection (see recordInRegion). */
function strokeInRegion(
  polyline: readonly Point[],
  region: SelectionRegion,
): boolean {
  if (polyline.length === 0) return false;
  if (polyline.length === 1) return pointInRegion(polyline[0]!, region);
  for (let i = 0; i < polyline.length; i++) {
    if (pointInRegion(polyline[i]!, region)) return true;
  }
  if ('box' in region) {
    const box = {
      minX: region.box.x,
      minY: region.box.y,
      maxX: region.box.x + region.box.width,
      maxY: region.box.y + region.box.height,
    };
    for (let i = 0; i + 1 < polyline.length; i++) {
      if (segmentIntersectsBox(polyline[i]!, polyline[i + 1]!, box))
        return true;
    }
    return false;
  }
  if ('circle' in region) {
    const c = region.circle;
    const center = { x: c.x, y: c.y };
    for (let i = 0; i + 1 < polyline.length; i++) {
      if (
        pointSegmentDistance(center, polyline[i]!, polyline[i + 1]!) <= c.radius
      ) {
        return true;
      }
    }
    return false;
  }
  const path = region.path as Point[];
  for (let i = 0; i + 1 < polyline.length; i++) {
    if (segmentIntersectsPolygon(polyline[i]!, polyline[i + 1]!, path)) {
      return true;
    }
  }
  return false;
}

/**
 * Collect paint-ordered ids inside a closed region under a filter.
 * Shared by the lasso tool and circle-to-lasso conversion.
 */
export function collectInRegion(
  ctx: SelectionContext,
  region: SelectionRegion,
  filter: EraserFilter,
): SurfaceObjectId[] {
  const selected: SurfaceObjectId[] = [];
  for (const id of ctx.model.order) {
    const record = ctx.model.objects[id];
    if (record === undefined) continue;
    if (recordInRegion(ctx, record, region, filter)) selected.push(id);
  }
  return selected;
}

export type SelectionContentKind =
  | 'ink'
  | 'highlighter'
  | 'shapes'
  | 'images'
  | 'text'
  | 'other';

export const SELECTION_KIND_ORDER: readonly SelectionContentKind[] = [
  'ink',
  'highlighter',
  'shapes',
  'images',
  'text',
  'other',
];

export function contentKindOf(
  record: SurfaceObjectRecord,
): SelectionContentKind {
  for (const kind of [
    'ink',
    'highlighter',
    'shapes',
    'images',
    'text',
  ] as const) {
    if (matchesEraserFilter(record, kind)) return kind;
  }
  return 'other';
}

/** Semantic selection snapshot: plain data for context UI (slice 6). */
export interface SelectionContextSnapshot {
  readonly card?: { readonly fill: string; readonly size: number };
  readonly connector?: { readonly path: string; readonly arrows: string };
  readonly shape?: string;
  readonly cornerRadius?: number;
  readonly canRoundCorners?: boolean;

  readonly ids: readonly SurfaceObjectId[];
  readonly bounds: Bounds;
  /** Stored rotation of one rotatable object, in radians. */
  readonly rotation?: number;
  readonly kinds: readonly SelectionContentKind[];
  readonly color?: string;
  readonly colorMixed: boolean;
  readonly width?: number;
  readonly widthMixed: boolean;
  readonly opacity?: number;
  readonly opacityMixed: boolean;
  readonly shapeAppearance?: 'fill' | 'outline' | 'mixed';
  /** Directly selected group records (for ungroup enablement). */
  readonly groups: readonly SurfaceObjectId[];
  /**
   * Draggable handles for the selection (slice 9): connector endpoints
   * for a single selected connector, envelope anchors for a single
   * selected shape. React renders these; the controller hit-tests and
   * drags them. Absent unless exactly one unlocked handle-owner exists.
   */
  readonly handles?: readonly SelectionHandle[];
}

/** One draggable selection handle (plain data for React chrome). */
export type SelectionHandle =
  | {
      readonly kind: 'connector-endpoint';
      readonly objectId: SurfaceObjectId;
      readonly end: 'source' | 'target';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: 'anchor';
      readonly objectId: SurfaceObjectId;
      readonly anchor: ConnectorAnchor;
      readonly x: number;
      readonly y: number;
    };

/** Paint-order move for `reorderSelection`. */
export type ReorderDirection = 'forward' | 'backward' | 'front' | 'back';

/**
 * Recolor/restyle payload for `setSelectionStyle`.
 *
 * Surface text additive: `textRole`/`textSize`/`textBold`/
 * `textItalic`/`textAlign`/`textWrap` mutate only `froglight.text`
 * `role`/`appearance` (+ top-level `size` for H1/H2), verbatim-preserving
 * (unknown roles/aligns/appearance members survive; no `formatVersion`
 * bump; never feed measured widths into canonical). Non-text records
 * ignore text fields; text records ignore color/width/opacity shape fields
 * except `color` (which still applies to text). All provided text fields
 * apply in one controller call so the provider commits one history gesture.
 */
export interface SelectionStyle {
  readonly fill?: string;
  readonly linePath?: 'straight' | 'orthogonal' | 'curved';
  readonly lineArrows?: 'none' | 'start' | 'end' | 'both';
  readonly cornerRadius?: number;
  readonly shape?: 'rectangle' | 'rounded' | 'triangle' | 'diamond';

  readonly color?: string;
  readonly width?: number;
  readonly opacity?: number;
  readonly shapeAppearance?: 'fill' | 'outline';
  /** Target text role (`body`/`heading`); unknown values are ignored. */
  readonly textRole?: string;
  /**
   * Target top-level `size` for H1/H2 (finite, > 0, within cap).
   * When absent, leave size unchanged. Body writes also leave size alone.
   * When `appearance` exists, its `size` is synced to the same value so
   * the appearance-first effective size never diverges from rendering.
   */
  readonly textSize?: number;
  /** Additive bold trait: true sets `appearance.bold`, false removes it. */
  readonly textBold?: boolean;
  /** Additive italic trait: true sets `appearance.italic`, false removes it. */
  readonly textItalic?: boolean;
  /** Target alignment; unknown values are ignored (verbatim preserved). */
  readonly textAlign?: string;
  /**
   * Wrap toggle: true ensures a valid `wrapWidth` (preserving an existing
   * valid width, else `TEXT_DEFAULT_WRAP_WIDTH`), false removes it.
   */
  readonly textWrap?: boolean;
}

export function colorOfRecord(record: SurfaceObjectRecord): string | undefined {
  switch (record.type) {
    case SURFACE_OBJECT_TYPES.stroke:
    case SURFACE_OBJECT_TYPES.text:
    case SURFACE_OBJECT_TYPES.line:
    case SURFACE_OBJECT_TYPES.card:
      return typeof record.color === 'string'
        ? record.color
        : record.type === SURFACE_OBJECT_TYPES.line ||
            record.type === SURFACE_OBJECT_TYPES.card
          ? '#37352f'
          : undefined;
    case SURFACE_OBJECT_TYPES.rectangle:
    case SURFACE_OBJECT_TYPES.ellipse:
      return typeof record.fill === 'string'
        ? record.fill
        : typeof record.stroke === 'string'
          ? record.stroke
          : undefined;
    default:
      return undefined;
  }
}

export function widthOfRecord(record: SurfaceObjectRecord): number | undefined {
  if (
    record.type === SURFACE_OBJECT_TYPES.rectangle ||
    record.type === SURFACE_OBJECT_TYPES.ellipse
  )
    return finiteNumber(record.strokeWidth) ?? 2;
  if (record.type === SURFACE_OBJECT_TYPES.line)
    return finiteNumber(record.width) ?? 2;
  if (
    record.type !== SURFACE_OBJECT_TYPES.stroke &&
    record.type !== SURFACE_OBJECT_TYPES.line &&
    record.type !== SURFACE_OBJECT_TYPES.rectangle &&
    record.type !== SURFACE_OBJECT_TYPES.ellipse
  ) {
    return undefined;
  }
  return (
    finiteNumber(
      record.type === SURFACE_OBJECT_TYPES.rectangle ||
        record.type === SURFACE_OBJECT_TYPES.ellipse
        ? record.strokeWidth
        : record.width,
    ) ?? undefined
  );
}

export function opacityOfRecord(
  record: SurfaceObjectRecord,
): number | undefined {
  if (
    record.type !== SURFACE_OBJECT_TYPES.stroke &&
    record.type !== SURFACE_OBJECT_TYPES.line
  ) {
    return undefined;
  }
  return (
    finiteNumber(record.opacity) ??
    (record.type === SURFACE_OBJECT_TYPES.line ? 1 : undefined)
  );
}

/**
 * Read the mutable appearance object of a text record, or null when it is
 * absent/malformed (never throws, never normalizes). Callers merge into a
 * shallow copy so unknown members survive verbatim.
 */
export function textAppearanceOf(
  record: SurfaceObjectRecord,
): Record<string, unknown> | null {
  const appearance = (record as { readonly appearance?: unknown }).appearance;
  return typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
    ? (appearance as Record<string, unknown>)
    : null;
}

/**
 * Write back a merged appearance object, deleting `appearance` entirely
 * when it ends up empty (returns to the legacy shape). Preserves unknown
 * members by construction — callers start from a spread of the existing
 * object and only set/delete known keys.
 */
export function writeTextAppearance(
  record: SurfaceObjectRecord,
  next: Record<string, unknown> | null,
): boolean {
  const mutable = record as Record<string, unknown>;
  const current = textAppearanceOf(record);
  if (next === null || Object.keys(next).length === 0) {
    if (current === null && mutable.appearance === undefined) return false;
    // Only report a change when something was actually present.
    const had =
      current !== null
        ? Object.keys(current).length > 0
        : mutable.appearance !== undefined;
    if (!had) return false;
    delete mutable.appearance;
    return true;
  }
  const before = current === null ? null : JSON.stringify(current);
  mutable.appearance = { ...next };
  return before !== JSON.stringify(mutable.appearance);
}

export function isValidTextSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= SURFACE_MAX_COORDINATE
  );
}

/**
 * Common style value across a selection: unanimous to report a value;
 * any disagreement — or a member missing anywhere it could apply —
 * reports mixed. Absent everywhere reports a quiet undefined.
 */
export function commonStyle<T>(values: readonly (T | undefined)[]): {
  value: T | undefined;
  mixed: boolean;
} {
  const defined = values.filter((value) => value !== undefined);
  if (defined.length === 0) return { value: undefined, mixed: false };
  if (defined.length !== values.length)
    return { value: undefined, mixed: true };
  const first = defined[0]!;
  return defined.every((value) => value === first)
    ? { value: first, mixed: false }
    : { value: undefined, mixed: true };
}

function finiteRecordNumber(
  record: SurfaceObjectRecord,
  key: string,
): number | null {
  return finiteNumber((record as Record<string, unknown>)[key]);
}

function writeRecordNumber(
  record: SurfaceObjectRecord,
  key: string,
  value: number,
): void {
  (record as Record<string, unknown>)[key] = value;
}

/** Scale one record about a pivot (selection-level geometric resize). */
export function scaleRecordAbout(
  record: SurfaceObjectRecord,
  factor: number,
  pivot: Point,
): void {
  if (record.type === SURFACE_OBJECT_TYPES.stroke) {
    if (record.sourceId !== undefined) {
      mapInkRegion(record, (p) => ({
        x: pivot.x + (p.x - pivot.x) * factor,
        y: pivot.y + (p.y - pivot.y) * factor,
      }));
      return;
    }
    const points = record.points;
    if (!Array.isArray(points)) return;
    for (const raw of points) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.x === 'number' && typeof s.y === 'number') {
        s.x = pivot.x + (s.x - pivot.x) * factor;
        s.y = pivot.y + (s.y - pivot.y) * factor;
      }
    }
    if (record.erasure !== undefined)
      record.erasure = (record.erasure as InkErasure).map((poly) =>
        poly.map((ring) =>
          ring.map((p) => ({
            x: pivot.x + (p.x - pivot.x) * factor,
            y: pivot.y + (p.y - pivot.y) * factor,
          })),
        ),
      );
    return;
  }
  const origin = (
    keys: readonly ['x' | 'y' | 'x2' | 'y2', 'x' | 'y' | 'x2' | 'y2'][],
  ): void => {
    for (const [kx, ky] of keys) {
      const x = finiteRecordNumber(record, kx);
      const y = finiteRecordNumber(record, ky);
      if (x === null || y === null) continue;
      writeRecordNumber(record, kx, pivot.x + (x - pivot.x) * factor);
      writeRecordNumber(record, ky, pivot.y + (y - pivot.y) * factor);
    }
  };
  const box = (): void => {
    const width = finiteRecordNumber(record, 'width');
    const height = finiteRecordNumber(record, 'height');
    if (width !== null) writeRecordNumber(record, 'width', width * factor);
    if (height !== null) writeRecordNumber(record, 'height', height * factor);
  };
  switch (record.type) {
    case SURFACE_OBJECT_TYPES.line:
      origin([
        ['x', 'y'],
        ['x2', 'y2'],
      ]);
      return;
    case SURFACE_OBJECT_TYPES.text: {
      origin([['x', 'y']]);
      const size = finiteRecordNumber(record, 'size');
      if (size !== null) writeRecordNumber(record, 'size', size * factor);
      return;
    }
    default:
      origin([['x', 'y']]);
      box();
  }
}

/** Rotate one record about a pivot, clockwise-positive like storage. */
export function rotateRecordAbout(
  record: SurfaceObjectRecord,
  deltaRadians: number,
  pivot: Point,
  sourceCenter?: Point,
): void {
  if (record.type === SURFACE_OBJECT_TYPES.stroke) {
    const points = record.points;
    const envelope = inkStrokeEnvelope(record);
    if (envelope === null) return;
    if (record.sourceId !== undefined) {
      const center = centerOfBounds(envelope);
      const next = rotateAround(center, pivot, deltaRadians);
      mapInkRegion(record, (p) => ({
        x: p.x + next.x - center.x,
        y: p.y + next.y - center.y,
      }));
      writeRecordNumber(record, 'rotation', rotationOf(record) + deltaRadians);
      return;
    }
    if (!Array.isArray(points)) return;
    // Rotate the source as a rigid object. Rotating its raw path through a
    // fixed nib would restyle fountain/pencil ink during the transform.
    const center = sourceCenter ?? centerOfBounds(envelope);
    const next = rotateAround(center, pivot, deltaRadians);
    const dx = next.x - center.x,
      dy = next.y - center.y;
    for (const raw of points) {
      if (typeof raw !== 'object' || raw === null) continue;
      const sample = raw as Record<string, unknown>;
      if (typeof sample.x === 'number') sample.x += dx;
      if (typeof sample.y === 'number') sample.y += dy;
    }
    if (record.erasure !== undefined)
      record.erasure = (record.erasure as InkErasure).map((poly) =>
        poly.map((ring) => ring.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
      );
    writeRecordNumber(record, 'rotation', rotationOf(record) + deltaRadians);
    return;
  }
  const move = (kx: 'x' | 'x2', ky: 'y' | 'y2'): void => {
    const x = finiteRecordNumber(record, kx);
    const y = finiteRecordNumber(record, ky);
    if (x === null || y === null) return;
    const next = rotateAround({ x, y }, pivot, deltaRadians);
    writeRecordNumber(record, kx, next.x);
    writeRecordNumber(record, ky, next.y);
  };
  if (record.type === SURFACE_OBJECT_TYPES.line) {
    move('x', 'y');
    move('x2', 'y2');
    return;
  }
  move('x', 'y');
  // Lines carry rotation in their endpoints; every other type
  // accumulates the stored rotation member around its own center.
  const current = finiteNumber(record.rotation) ?? 0;
  writeRecordNumber(record, 'rotation', current + deltaRadians);
}
