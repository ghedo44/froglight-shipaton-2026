import {
  retainInkSourceOutline,
  releaseInkSourceGeometry,
} from './ink/source-geometry.js';
import { cloneTemplateValue } from '../documents.js';
import {
  INK_SOURCE_TYPE,
  freezeInkValue,
  inkRegion,
  seedInkSourceOwnership,
  unusedInkSources,
  cloneInkRecord,
  bindInkSource,
  mapInkRegion,
  validInkVisible,
  type InkRegionTransform,
} from './ink/fragments.js';
import { regionOfContours } from './ink/erasure.js';
import type {
  ErasurePreparation,
  ErasureRefinement,
} from './ink/erasure-preparation.js';
import {
  atomicSurfaceTransaction,
  observeSurfaceTransactions,
  applySurfaceOrderEdits,
  registerSurfaceWorkRetry,
  ownSurfaceWork,
  clearSurfaceWorkError,
  hasSurfaceDraftObserver,
  publishSurfaceDraft,
  publishSurfaceObjects,
} from './transactions.js';
/**
 * Ink tools and the host-free tool/input controller. Normalized pointer
 * events — optionally carrying
 * pressure/tilt/twist from the hardware — are routed to the active tool;
 * tools commit model mutations through the controller context and may
 * publish ephemeral preview draw items that never touch canonical data.
 * Select gestures delegate to the shared SurfaceInteractionController so
 * ink participates in the existing selection/transform semantics.
 * Registration is effect-owned; the permission gate rides the
 * trusted-side facade (`workspace.surfaces.register`), not this module.
 */

import { ErrorCodes, FroglightError } from '../errors.js';
import type { DrawItem, LiveStrokeMeshView } from './draw.js';
import {
  boundsIntersect,
  centerOfBounds,
  finiteNumber,
  surfaceToView,
  textV2Lines,
  rotateAround,
  unrotateAround,
  viewToSurface,
  type Bounds,
  type Camera,
  type Point,
} from './geometry.js';
import {
  isValidRulerState,
  projectPointToRuler,
  rulerSnapThresholdSurface,
  rulerToDrawItems,
  shouldSnapToRuler,
  type SurfaceRulerState,
} from './ruler.js';
import {
  ellipseObject,
  groupObject,
  isKnownTextAlign,
  isKnownTextRole,
  isValidWrapWidth,
  isValidNamespacedTypeId,
  inkStrokeObject,
  lineObject,
  rectangleObject,
  SURFACE_MAX_SAMPLE_DT_MS,
  SURFACE_MAX_STROKE_POINTS,
  SURFACE_OBJECT_TYPES,
  logicalIdOf,
  chunkIndexOf,
  TEXT_DEFAULT_WRAP_WIDTH,
  rebaseLogicalChunkTiming,
  rebaseStrokeTiming,
  type InkBrushDescriptor,
  type InkSample,
  type ConnectorAnchor,
  type ConnectorEndpointBinding,
  type ConnectorPath,
  type LineArrows,
  type SurfaceModel,
  type SurfaceObjectId,
  type SurfaceObjectRecord,
} from './model.js';
import {
  brushPresetForKind,
  resolveBrushSpec,
  type InkBrushKind,
  type InkBrushOverrides,
  type InkBrushSpec,
} from './ink/brush.js';
import {
  addErasureBatch,
  capsuleFootprint,
  hitVisible,
  sweepHitsVisible,
  type InkErasure,
} from './ink/erasure.js';
import { compileInkStroke } from './ink/geometry.js';
import { LiveInkStrokeCompiler } from './ink/live-compiler.js';
import type {
  EraserPreset,
  InkPresetStore,
  InkToolPreset,
  LassoPreset,
} from './ink/presets.js';
import {
  packedCompiledForRecord,
  derivedTranslationOfRecord,
  retainPackedOnlyForRecord,
  groupMembersOf,
  groupOfMember,
  INK_DEFAULT_WIDTH,
  inkStrokeEnvelope,
  resolveGroupMembers,
  rotationOf,
  inkStrokeOutlineOfRecord,
  resolveInkInteractionGeometry,
  jointInkSourceRecord,
  logicalMembersOf,
  inkStrokeContoursOfRecord,
  captureGeometryOwnershipForIds,
} from './objects.js';
import {
  expandLogicalIds,
  groupLogicalChunks,
  logicalHead,
} from './logical-stroke.js';
import { matchesEraserFilter } from './ink/eraser-geometry.js';
import {
  recognizeCircle,
  recognizeScribble,
  recognizeShape,
  type CircleHit,
  type ShapeFit,
} from './ink/gestures.js';
import type { SurfaceObjectTypeRegistry } from './registry.js';
import {
  SurfaceInteractionController,
  type AlignEdge,
  type DistributeAxis,
  type NormalizedPointerEvent,
  type NormalizedWheelEvent,
} from './controller.js';
import { anchorPoint } from './ink/connectors.js';
import {
  collectInRegion,
  colorOfRecord,
  commonStyle,
  contentKindOf,
  isRecordLocked,
  isValidTextSize,
  opacityOfRecord,
  recordInRegion,
  rotateRecordAbout,
  scaleRecordAbout,
  selectionCenterOf,
  selectionEnvelope,
  selectionBoundsFor,
  selectionHandles,
  textAppearanceOf,
  widthOfRecord,
  writeTextAppearance,
  SELECTION_KIND_ORDER,
  type ReorderDirection,
  type SelectionContextSnapshot,
  type SelectionRegion,
  type SelectionStyle,
} from './selection.js';
export type {
  ReorderDirection,
  SelectionContextSnapshot,
  SelectionContentKind,
  SelectionHandle,
  SelectionRegion,
  SelectionStyle,
} from './selection.js';

/** Core v1 tool ids (namespace `froglight.*`). */
export const SURFACE_TOOL_IDS = {
  select: 'froglight.ink.select',
  pen: 'froglight.ink.pen',
  fountain: 'froglight.ink.fountain',
  brush: 'froglight.ink.brush',
  pencil: 'froglight.ink.pencil',
  highlighter: 'froglight.ink.highlighter',
  eraser: 'froglight.ink.eraser',
  lasso: 'froglight.ink.lasso',
} as const;

/** Highlighter preset written as ordinary stroke style members. */
export const HIGHLIGHTER_PRESET = {
  width: 14,
  opacity: 0.35,
  color: '#ffd54f',
} as const;

/** Default eraser radius in view units; products may register their own. */
export const DEFAULT_ERASER_RADIUS_VIEW = 10;

/**
 * Live pen styling shared with product UI. The reference is read at
 * capture time (preview and commit), so swatch/width changes apply to
 * the next gesture without re-registering tools.
 */
export interface PenStyleRef {
  color?: string;
  width?: number;
}

/**
 * Live eraser sizing, read per gesture event the same way as `PenStyleRef`;
 * when unset the registry's static radius applies.
 */
export interface EraserStyleRef {
  radius?: number;
}

/** What a tool sees for the duration of one event dispatch. */
export interface SurfaceToolContext {
  readonly model: SurfaceModel;
  /** Registry of object types, for hit predicates and erasure rules. */
  readonly objectRegistry: SurfaceObjectTypeRegistry;
  /** Live camera; conversions stay consistent with delegated gestures. */
  camera(): Camera;
  /** Conservative indexed broad phase; custom contexts may fall back to order. */
  queryRegion?(bounds: Bounds): readonly SurfaceObjectId[];
  /** Fresh unique object id for a commit-in-progress. */
  newObjectId(): SurfaceObjectId;
  /** Append a committed record at the end of paint order. */
  addObject(record: SurfaceObjectRecord): void;
  /** Remove an object entirely (whole-stroke erase). */
  removeObject(id: SurfaceObjectId): void;
  /**
   * Replace one record with zero or more records at its paint index
   * (precision erasing). An empty list removes without reordering.
   */
  replaceObject(
    id: SurfaceObjectId,
    replacements: readonly SurfaceObjectRecord[],
  ): void;
  addSource(record: SurfaceObjectRecord): void;
  stageErasure(record: SurfaceObjectRecord): void;
  finishErasure(records: readonly SurfaceObjectRecord[]): void;
  cancelErasure(): void;
  setSelection(ids: readonly SurfaceObjectId[]): void;
  selection(): readonly SurfaceObjectId[];
  /** Translate the current selection by a surface-space delta. */
  moveSelectionBy(delta: Point): readonly SurfaceObjectId[];
  /** Begin an ephemeral move (no canonical mutation until commit). */
  beginEphemeralMove(): boolean;
  /** Accumulate an incremental delta into the ephemeral move. */
  updateEphemeralMove(delta: Point): void;
  /** Commit the ephemeral move once (one canonical transform). */
  commitEphemeralMove(): readonly SurfaceObjectId[];
  /** Discard the ephemeral move without mutating canonical data. */
  cancelEphemeralMove(): void;
  /**
   * Restore the tool active before the last temporary entry (eraser
   * auto-return). False when no temporary tool is active.
   */
  exitTemporaryTool(): boolean;
  /** Replace the ephemeral preview overlay for the active gesture. */
  setPreview(items: readonly DrawItem[]): void;
}

export interface SurfaceTool {
  /** Dot-namespaced id per the surface object-type rule. */
  readonly toolId: string;
  /** Selection/manipulation retains context; authoring is the default. */
  readonly interactionRole?: 'selection' | 'authoring';
  readonly version?: number;
  onDown?(ctx: SurfaceToolContext, event: NormalizedPointerEvent): void;
  onMove?(ctx: SurfaceToolContext, event: NormalizedPointerEvent): void;
  onUp?(ctx: SurfaceToolContext, event: NormalizedPointerEvent): void;
  /** End/start a visible run while one physical pointer gesture remains owned. */
  onRunEnd?(ctx: SurfaceToolContext, event: NormalizedPointerEvent): void;
  onRunStart?(ctx: SurfaceToolContext, event: NormalizedPointerEvent): void;
  onRunsComplete?(ctx: SurfaceToolContext): void;
  /**
   * Consume one confirmed input batch in a single call (coalesced samples
   * share one dispatch). Tools without `onBatch` receive per-event
   * `onMove` calls from the controller fallback instead.
   */
  onBatch?(
    ctx: SurfaceToolContext,
    events: readonly NormalizedPointerEvent[],
  ): void;
  /**
   * Ephemeral predicted tail for the live gesture. Preview-only: it must
   * never append to canonical samples, history, or dirty state. Tools
   * without `onPredicted` simply show no tail.
   */
  onPredicted?(
    ctx: SurfaceToolContext,
    events: readonly NormalizedPointerEvent[],
  ): void;
  /**
   * Abort the active gesture without committing. Pen/shape cancellation
   * discards the capture gesture and clears preview; selection/resize
   * cancellation closes drag state so the next gesture works normally.
   */
  onCancel?(ctx: SurfaceToolContext): void;
  /**
   * Stillness signal mid-gesture (draw-and-hold): the provider fires
   * this when the pointer rests without lifting. Tools may arm a
   * conversion (shape, circle-to-lasso) that `onUp` finalizes, or
   * ignore it entirely. Never commits by itself.
   */
  onHold?(ctx: SurfaceToolContext): void;
}

export interface SurfaceToolRegistry {
  register(tool: SurfaceTool): { dispose(): void };
  get(toolId: string): SurfaceTool | null;
  list(): readonly SurfaceTool[];
}

export class InMemorySurfaceToolRegistry implements SurfaceToolRegistry {
  readonly #tools = new Map<string, SurfaceTool>();

  register(tool: SurfaceTool): { dispose(): void } {
    if (!isValidNamespacedTypeId(tool.toolId)) {
      throw new FroglightError(
        ErrorCodes.INVALID_SURFACE_TOOL_ID,
        `surface tool id must be dot-namespaced: ${tool.toolId}`,
      );
    }
    if (this.#tools.has(tool.toolId)) {
      throw new FroglightError(
        ErrorCodes.DUPLICATE_SURFACE_TOOL,
        `surface tool already registered: ${tool.toolId}`,
      );
    }
    this.#tools.set(tool.toolId, tool);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#tools.delete(tool.toolId);
      },
    };
  }

  get(toolId: string): SurfaceTool | null {
    return this.#tools.get(toolId) ?? null;
  }

  list(): readonly SurfaceTool[] {
    return [...this.#tools.values()];
  }
}

// --- Core tools ---

/**
 * Running min/max of one capture gesture's samples in surface space,
 * padded by half the stroke width. Preview bounds grow incrementally per
 * appended sample instead of rescanning the whole gesture per input event.
 */
export interface StrokeBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Fold one sample into the running preview bounds (pure, O(1)). */
export function extendStrokeBounds(
  current: StrokeBounds | null,
  point: Point,
  halfWidth: number,
): StrokeBounds {
  const pad = Number.isFinite(halfWidth) ? Math.max(halfWidth, 0) : 0;
  return {
    minX: Math.min(current?.minX ?? Infinity, point.x - pad),
    minY: Math.min(current?.minY ?? Infinity, point.y - pad),
    maxX: Math.max(current?.maxX ?? -Infinity, point.x + pad),
    maxY: Math.max(current?.maxY ?? -Infinity, point.y + pad),
  };
}

/** Gesture state carried between events of one capture stroke. */
/** Pen-gesture recognizers enabled per capture tool (slice 7, off by default). */
export interface PenGestureOptions {
  /** Draw-and-hold converts recognized line/rect/ellipse/arrow doodles. */
  readonly shape?: boolean;
  /** Deliberate scribbles erase intersected strokes, staying on pen. */
  readonly scribble?: boolean;
  /** A held closed loop becomes a selection instead of ink. */
  readonly circle?: boolean;
}

interface CaptureGesture {
  readonly objectId: SurfaceObjectId;
  readonly samples: InkSample[];
  protectedSamples: number;
  readonly protectedIds: string[];
  protectedDt: number;
  /** Monotonic start time (ms) for `dt` stamping; null when unknown. */
  readonly t0: number | null;
  /** `dt` of the last stored sample; the monotonic floor for the next. */
  lastDt: number | null;
  /** Style triple at the last preview publish (live edits republish). */
  publishedStyle: PreviewStyle | null;
  /** Serialized brush tuning at the last publish (tuning edits republish). */
  publishedTuningKey: string | null;
  /** Incremental live geometry (never a full recompile).*/
  live: LiveInkStrokeCompiler;
  /**
   * Resolved geometry-brush snapshot at pointer-down. One stroke uses one
   * brush: mid-gesture preset edits apply to the NEXT stroke, never to
   * this one (the live compiler freezes geometry under its begin brush,
   * so mutating it mid-gesture could only reshape the stroke at
   * pointer-up). The commit path stores this snapshot, never live
   * settings.
   */
  liveBrush: InkBrushSpec;
  /** Brush tuning snapshot at pointer-down (committed with the stroke). */
  liveTuning: InkBrushOverrides | undefined;
  /**
   * Presentation snapshot at pointer-down (width/color/opacity). The live
   * preview and the commit both render this snapshot, so mid-gesture
   * toolbar edits can never reshape or restyle the active stroke.
   */
  liveStyle: PreviewStyle;
  /** Hold-armed conversion, latched by `onHold`, consumed by `onUp`. */
  armed: ArmedGesture | null;
  bounds: StrokeBounds;
}

/** A latched gesture conversion plus the sample bbox it was armed on. */
type ArmedGesture =
  | { kind: 'shape'; fit: ShapeFit; bbox: Bounds }
  | { kind: 'circle'; hit: CircleHit; bbox: Bounds };

/**
 * Lift-jitter allowance: appended samples inside the armed bbox grown by
 * this margin keep the armed conversion; anything escaping it disarms.
 */
const ARM_DISARM_SLOP = 2;

function bboxOfSamples(samples: readonly InkSample[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function finiteEventTime(event: NormalizedPointerEvent): number | null {
  return typeof event.time === 'number' && Number.isFinite(event.time)
    ? event.time
    : null;
}

/** `dt` delta for one sample against the gesture start; null when unknown. */
function dtForEvent(
  event: NormalizedPointerEvent,
  t0: number | null,
): number | null {
  if (t0 === null) return null;
  const time = finiteEventTime(event);
  if (time === null) return null;
  // Clamp instead of rejecting: a runaway clock must never fail validation.
  return Math.min(Math.max(time - t0, 0), SURFACE_MAX_SAMPLE_DT_MS);
}

/**
 * Stamp `dt` for one sample, holding the stored sequence non-decreasing
 * even when the provider clock jumps backward mid-gesture. Advances the
 * gesture floor only for samples the caller actually stores.
 */
function stampDt(
  event: NormalizedPointerEvent,
  gesture: CaptureGesture,
): number | null {
  const dt = dtForEvent(event, gesture.t0);
  if (dt === null || gesture.lastDt === null) return dt;
  return Math.max(dt, gesture.lastDt);
}

function sampleFrom(
  event: NormalizedPointerEvent,
  surface: Point,
  dt: number | null,
): InkSample {
  // Clamp axes at capture so invalid ranges never become opaque on reload:
  // pressure to [0,1], tilt per-axis to [-π/2,π/2], twist to [-π,π].
  // Non-finite surface coords are dropped by the caller (never stored).
  const pressure =
    typeof event.pressure === 'number' && Number.isFinite(event.pressure)
      ? Math.min(Math.max(event.pressure, 0), 1)
      : undefined;
  let tilt: InkSample['tilt'] | undefined;
  if (event.tilt !== undefined) {
    const x = Number.isFinite(event.tilt.x)
      ? Math.max(-Math.PI / 2, Math.min(Math.PI / 2, event.tilt.x))
      : null;
    const y = Number.isFinite(event.tilt.y)
      ? Math.max(-Math.PI / 2, Math.min(Math.PI / 2, event.tilt.y))
      : null;
    if (x !== null && y !== null) tilt = { x, y };
  }
  const twist =
    typeof event.twist === 'number' && Number.isFinite(event.twist)
      ? Math.atan2(Math.sin(event.twist), Math.cos(event.twist))
      : undefined;
  return {
    x: surface.x,
    y: surface.y,
    ...(pressure !== undefined ? { pressure } : {}),
    ...(tilt !== undefined ? { tilt } : {}),
    ...(twist !== undefined ? { twist } : {}),
    ...(dt !== null ? { dt } : {}),
  };
}

function tiltEquals(a: InkSample['tilt'], b: InkSample['tilt']): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y;
}

function sampleEquals(a: InkSample, b: InkSample): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.pressure === b.pressure &&
    tiltEquals(a.tilt, b.tilt) &&
    a.twist === b.twist
  );
}

interface PreviewStyle {
  readonly width: number;
  readonly color?: string;
  readonly opacity?: number;
}

/**
 * Compiled fill outline for a live preview. Committed/reloaded strokes and
 * verification use the full `compileInkStroke()`; the live gesture path
 * below feeds `LiveInkStrokeCompiler` instead so previews never recompile
 * history per batch.
 */
function previewOutline(
  samples: readonly InkSample[],
  style: PreviewStyle,
  base: InkBrushSpec,
  tuning?: InkBrushOverrides,
): readonly Point[] | undefined {
  if (samples.length === 0) return undefined;
  const polygon = compileInkStroke(
    samples,
    resolveBrushSpec({ ...tuning, size: style.width }, base),
  ).polygon;
  return polygon.length >= 3 ? polygon : undefined;
}

function strokePreviewItem(
  objectId: string,
  samples: readonly InkSample[],
  style: PreviewStyle,
  bounds: StrokeBounds,
  options: {
    brush?: InkBrushSpec;
    tuning?: InkBrushOverrides;
    /** Pre-compiled live outline (incremental path; skips recompilation). */
    liveOutline?: readonly Point[];
    /** Authoritative live bounds (incremental path; skips re-derivation). */
    liveBounds?: Bounds;
    /**
     * Incremental live mesh chunks (hot path; skips full-ring
     * materialization AND the outline copy). When present the item
     * carries an empty outline and backends trace the chunks.
     */
    liveMesh?: LiveStrokeMeshView | null;
    /**
     * Prediction head-only clip (see StrokeItem.liveHeadUpTo): draw only
     * the prefix [0, liveHeadUpTo) with a butt seam, suppressing the old
     * mutable tail replaced by the predicted tail.
     */
    liveHeadUpTo?: number;
  } = {},
): DrawItem {
  // One authoritative smooth-stroke path: the outline always travels with
  // the item (live incremental tail when provided, otherwise a clean
  // compile of the same samples the commit path uses).
  const outline =
    options.liveMesh !== undefined && options.liveMesh !== null
      ? []
      : options.liveOutline !== undefined
        ? [...options.liveOutline]
        : (previewOutline(
            samples,
            style,
            options.brush ?? brushPresetForKind('ball'),
            options.tuning,
          ) ?? []);
  const itemBounds =
    options.liveBounds ??
    ({
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    } satisfies Bounds);
  return {
    kind: 'stroke',
    objectId,
    bounds: itemBounds,
    rotation: 0,
    // Shared reference, never a spread: canonical samples are append-only
    // during a gesture, preview items are replaced per publish, and
    // backends never reconstruct strokes from points.
    points: samples,
    width: style.width,
    ...(style.color !== undefined ? { color: style.color } : {}),
    ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
    outline,
    ...(options.liveMesh !== undefined && options.liveMesh !== null
      ? { liveMesh: options.liveMesh }
      : {}),
    ...(options.liveHeadUpTo !== undefined
      ? { liveHeadUpTo: options.liveHeadUpTo }
      : {}),
  };
}

function boundsOfSamples(
  samples: readonly Point[],
  halfWidth: number,
): StrokeBounds | null {
  let bounds: StrokeBounds | null = null;
  for (const p of samples) bounds = extendStrokeBounds(bounds, p, halfWidth);
  return bounds;
}

function polylinePreview(
  objectId: string,
  samples: readonly Point[],
  style: PreviewStyle,
): DrawItem[] {
  if (samples.length < 2) return [];
  const bounds = boundsOfSamples(samples, style.width / 2);
  if (bounds === null) return [];
  // Guide previews (lasso marquees, circle rings) are an explicit
  // polyline kind — never canonical ink, never the stroke fallback path.
  return [
    {
      kind: 'polyline',
      objectId,
      bounds: {
        x: bounds.minX,
        y: bounds.minY,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
      },
      rotation: 0,
      points: samples.map((p) => ({ x: p.x, y: p.y })),
      width: style.width,
      ...(style.color !== undefined ? { color: style.color } : {}),
      ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
    },
  ];
}

interface StrokePresetToolOptions {
  readonly toolId: string;
  /** Brush kind driving nib geometry; fixed per tool (slice 3). */
  readonly kind: InkBrushKind;
  readonly width?: number;
  readonly color?: string;
  readonly opacity?: number;
  /** Live styling (the pen reads the shared swatch/width state). */
  readonly styleSource?: () => PenStyleRef | undefined;
  /** Per-tool preset: color/size/opacity + brush tuning; wins over statics. */
  readonly presetSource?: () => InkToolPreset | undefined;
  /** Pen-gesture recognizers (slice 7); all off unless enabled here. */
  readonly gestures?: PenGestureOptions;
  /**
   * Live gesture preferences (product contract): read per hold/lift so
   * settings toggles propagate to mounted surfaces immediately without
   * recreating tools. Wins over static `gestures` when present.
   */
  readonly gestureSource?: () => PenGestureOptions | undefined;
}

/** All capture tools share one flow; kind + preset resolve the style. */
function strokePresetTool(options: StrokePresetToolOptions): SurfaceTool {
  let gesture: CaptureGesture | null = null;
  let continuation: {
    readonly style: PreviewStyle;
    readonly brush: InkBrushSpec;
    readonly tuning: InkBrushOverrides | undefined;
  } | null = null;
  let confirmedPreview: readonly DrawItem[] = [];
  let predictionVisible = false;
  const brushBase = brushPresetForKind(options.kind);
  const resolvePreset = (): InkToolPreset | undefined =>
    options.presetSource?.();
  const resolveStyle = (): PreviewStyle => {
    const preset = resolvePreset();
    const live = options.styleSource?.();
    const width =
      preset?.size ?? options.width ?? live?.width ?? INK_DEFAULT_WIDTH;
    const color = preset?.color ?? options.color ?? live?.color;
    const opacity = preset?.opacity ?? options.opacity;
    return {
      width,
      ...(color !== undefined ? { color } : {}),
      ...(opacity !== undefined ? { opacity } : {}),
    };
  };
  /** Fully resolved brush for the live compiler (style size + tuning). */
  const resolveLiveBrush = (style: PreviewStyle): InkBrushSpec => {
    const tuning = resolvePreset()?.brush;
    return resolveBrushSpec({ ...tuning, size: style.width }, brushBase);
  };
  const protectConfirmed = (
    ctx: SurfaceToolContext,
    active: CaptureGesture,
    force = false,
  ): void => {
    if (!hasSurfaceDraftObserver(ctx.model)) return;
    const pending = active.samples.length - active.protectedSamples;
    const dt = active.lastDt ?? 0;
    if (
      pending === 0 ||
      (!force && pending < 256 && dt - active.protectedDt < 1000)
    )
      return;
    while (active.protectedSamples < active.samples.length) {
      const part = active.protectedIds.length;
      const id = `${active.objectId}#recovery${part}`;
      const end = Math.min(
        active.samples.length,
        active.protectedSamples + 256,
      );
      const run = active.samples.slice(active.protectedSamples, end);
      const record = inkStrokeObject(id, {
        points: rebaseLogicalChunkTiming(run, part === 0) as InkSample[],
        ...active.liveStyle,
        brush: { ...active.liveTuning, kind: options.kind },
        logicalId: `${active.objectId}#recovery0`,
        chunkIndex: part,
      });
      active.protectedIds.push(id);
      active.protectedSamples = end;
      publishSurfaceDraft(ctx.model, id, record);
    }
    active.protectedDt = dt;
  };
  const clearProtected = (
    ctx: SurfaceToolContext,
    active: CaptureGesture,
  ): void => {
    for (const id of active.protectedIds)
      publishSurfaceDraft(ctx.model, id, null);
  };
  /** Append confirmed samples; one preview publish per call, bounds incremental. */
  const appendEvents = (
    ctx: SurfaceToolContext,
    events: readonly NormalizedPointerEvent[],
  ) => {
    if (gesture === null || events.length === 0) return;
    const active = gesture;
    const camera = ctx.camera();
    // One stroke, one style: preview everything under the pointer-down
    // snapshot, never under mid-gesture toolbar edits.
    const style = active.liveStyle;
    const halfWidth = style.width / 2;
    let bounds = active.bounds;
    const before = active.samples.length;
    // Collect genuinely new samples first (no per-sample copies: one push
    // loop into the canonical array, one slice into the compiler).
    const fresh: InkSample[] = [];
    for (const event of events) {
      const next = sampleFrom(
        event,
        viewToSurface(camera, event.point),
        stampDt(event, active),
      );
      const last =
        active.samples[active.samples.length - 1] ?? fresh[fresh.length - 1];
      // A tap re-reports the down position on up; stationary moves repeat
      // it too. Never store the same physical sample twice.
      if (last !== undefined && sampleEquals(last, next)) continue;
      active.samples.push(next);
      fresh.push(next);
      if (next.dt !== undefined) active.lastDt = next.dt;
      bounds = extendStrokeBounds(bounds, next, halfWidth);
    }
    active.bounds = bounds;
    protectConfirmed(ctx, active);
    // Drawing past an armed hold returns to ordinary ink — but only for
    // material new input: lift jitter inside the armed bbox (plus slop)
    // keeps the conversion.
    if (active.armed !== null && active.samples.length > before) {
      const bbox = active.armed.bbox;
      const escaped = active.samples
        .slice(before)
        .some(
          (s) =>
            s.x < bbox.x - ARM_DISARM_SLOP ||
            s.x > bbox.x + bbox.width + ARM_DISARM_SLOP ||
            s.y < bbox.y - ARM_DISARM_SLOP ||
            s.y > bbox.y + bbox.height + ARM_DISARM_SLOP,
        );
      if (escaped) active.armed = null;
    }
    // Duplicate-only batches change neither samples, style, nor tuning:
    // skip the republish entirely (hot-path requirement). Otherwise feed
    // only the fresh samples to the incremental compiler — history is
    // never recompiled per batch. The live compiler
    // runs under its pointer-down brush snapshot: mid-gesture preset
    // edits never reach it (one stroke, one brush).
    const added = active.samples.length - before;
    const tuning = active.liveTuning;
    const tuningKey = tuning === undefined ? '' : JSON.stringify(tuning);
    const published = active.publishedStyle;
    const styleChanged =
      published === null ||
      published.width !== style.width ||
      published.color !== style.color ||
      published.opacity !== style.opacity ||
      active.publishedTuningKey !== tuningKey;
    if (added === 0 && !styleChanged) return;
    active.publishedStyle = style;
    active.publishedTuningKey = tuningKey;
    const live = active.live.append(fresh);
    confirmedPreview =
      active.samples.length < 2
        ? []
        : [
            strokePreviewItem(active.objectId, active.samples, style, bounds, {
              brush: brushBase,
              ...(tuning !== undefined ? { tuning } : {}),
              // Chunk publish: no full-ring copy per batch (dots carry a
              // bounded O(1) ring instead of chunks).
              ...(live.mesh !== null
                ? { liveMesh: live.mesh }
                : { liveOutline: live.ring ?? [] }),
              liveBounds: live.bounds,
            }),
          ];
    predictionVisible = false;
    ctx.setPreview(confirmedPreview);
  };
  /** Ephemeral predicted tail: blends from the last confirmed sample, never commits. */
  const previewPredicted = (
    ctx: SurfaceToolContext,
    events: readonly NormalizedPointerEvent[],
  ) => {
    if (gesture === null) return;
    if (events.length === 0) {
      if (predictionVisible) ctx.setPreview(confirmedPreview);
      predictionVisible = false;
      return;
    }
    const active = gesture;
    if (active.samples.length === 0) return;
    const camera = ctx.camera();
    // Predicted tails render under the pointer-down snapshot like the
    // confirmed stroke they continue.
    const style = active.liveStyle;
    const tuning = active.liveTuning;
    const tail: InkSample[] = [
      { ...active.samples[active.samples.length - 1]! },
    ];
    for (const event of events) {
      const p = viewToSurface(camera, event.point);
      const lastTail = tail[tail.length - 1]!;
      if (lastTail.x === p.x && lastTail.y === p.y) continue;
      // Ephemeral only, but carry the full axes so the tail blends into
      // the confirmed stroke exactly as the next real samples would.
      tail.push(sampleFrom(event, p, stampDt(event, active)));
    }
    if (tail.length < 2) return;
    // Mutable-tail replacement prediction: the confirmed item republishes
    // only the stable head [0, replaceFrom) with a butt seam (O(1) view
    // copy, no geometry work — old mutable tail suppressed, never
    // repainted), and the predicted item carries the replacement tail
    // (revised mutable tail + continuation, butt seam at the head
    // boundary, live cap at tip). Head + replacement abut with no
    // overlapping area, so translucent tools cannot double-paint history.
    // Predicted data is ephemeral: never appended to canonical samples,
    // never marked dirty, never persisted (see live-compiler).
    const confirmedMesh = active.live.confirmedMesh();
    const predicted = active.live.appendPredicted(tail.slice(1));
    const confirmed =
      confirmedMesh === null
        ? []
        : [
            strokePreviewItem(
              active.objectId,
              active.samples,
              style,
              active.bounds,
              {
                brush: brushBase,
                ...(tuning !== undefined ? { tuning } : {}),
                liveMesh: { ...confirmedMesh, endCap: [] },
                liveHeadUpTo: predicted.replaceFromSpineIndex,
                liveBounds: active.live.confirmedBounds(),
              },
            ),
          ];
    const predictedItems =
      predicted.polygon.length === 0
        ? []
        : [
            strokePreviewItem(
              `${active.objectId}#predicted`,
              tail,
              style,
              boundsOfSamples(tail, style.width / 2) ?? active.bounds,
              {
                brush: brushBase,
                ...(tuning !== undefined ? { tuning } : {}),
                liveOutline: predicted.polygon,
                liveBounds: predicted.bounds,
              },
            ),
          ];
    predictionVisible = true;
    ctx.setPreview([...confirmed, ...predictedItems]);
  };
  const tool: SurfaceTool = {
    toolId: options.toolId,
    version: 1,
    onDown: (ctx, event) => {
      confirmedPreview = [];
      predictionVisible = false;
      const t0 = finiteEventTime(event);
      const first = sampleFrom(
        event,
        viewToSurface(ctx.camera(), event.point),
        t0 !== null ? 0 : null,
      );
      const continued = continuation;
      continuation = null;
      const style = continued?.style ?? resolveStyle();
      const live = new LiveInkStrokeCompiler();
      const liveBrush = continued?.brush ?? resolveLiveBrush(style);
      live.begin(first, liveBrush);
      gesture = {
        objectId: ctx.newObjectId(),
        samples: [first],
        protectedSamples: 0,
        protectedIds: [],
        protectedDt: 0,
        t0,
        lastDt: t0 !== null ? 0 : null,
        publishedStyle: null,
        publishedTuningKey: null,
        live,
        // One stroke, one brush: snapshot geometry inputs at pointer-down.
        // Later preset edits apply to the next stroke, never this one.
        liveBrush,
        liveTuning: continued?.tuning ?? resolvePreset()?.brush,
        liveStyle: style,
        armed: null,
        bounds: extendStrokeBounds(null, first, style.width / 2),
      };
      protectConfirmed(ctx, gesture, true);
      ctx.setPreview([]);
    },
    onMove: (ctx, event) => appendEvents(ctx, [event]),
    onBatch: (ctx, events) => appendEvents(ctx, events),
    onPredicted: (ctx, events) => previewPredicted(ctx, events),
    onHold: (ctx) => {
      if (gesture === null || gesture.armed !== null) return;
      const opts = options.gestureSource?.() ?? options.gestures;
      if (opts === undefined) return;
      const active = gesture;
      // A held closed loop becomes a selection; shapes only when the
      // loop is not round (circle wins ambiguous rounded rectangles —
      // selection is the cheaper mistake to undo by tapping away).
      if (opts.circle === true) {
        const hit = recognizeCircle(active.samples);
        const bbox = bboxOfSamples(active.samples);
        if (hit !== null && bbox !== null) {
          active.armed = { kind: 'circle', hit, bbox };
          const ring: Point[] = [];
          for (let i = 0; i <= 24; i++) {
            const angle = (i / 24) * Math.PI * 2;
            ring.push({
              x: hit.x + Math.cos(angle) * hit.radius,
              y: hit.y + Math.sin(angle) * hit.radius,
            });
          }
          ctx.setPreview(
            polylinePreview(
              `${active.objectId}#circle`,
              ring,
              LASSO_PREVIEW_STYLE,
            ),
          );
          return;
        }
      }
      if (opts.shape === true) {
        const fit = recognizeShape(active.samples);
        const bbox = bboxOfSamples(active.samples);
        if (fit !== null && bbox !== null) {
          active.armed = { kind: 'shape', fit, bbox };
          const style = resolveStyle();
          ctx.setPreview(
            previewShapeItems(
              ctx,
              shapeRecordForFit(fit, active.objectId, style),
            ),
          );
        }
      }
    },
    onUp: (ctx, event) => {
      if (gesture === null) return;
      appendEvents(ctx, [event]);
      const active = gesture;
      clearProtected(ctx, active);
      const armed = active.armed;
      const internalRunEnd = continuation !== null;
      if (!internalRunEnd && armed?.kind === 'shape') {
        ctx.addObject(
          shapeRecordForFit(armed.fit, active.objectId, resolveStyle()),
        );
        gesture = null;
        confirmedPreview = [];
        predictionVisible = false;
        ctx.setPreview([]);
        return;
      }
      if (!internalRunEnd && armed?.kind === 'circle') {
        ctx.setSelection(
          collectInRegion(
            ctx,
            {
              circle: {
                x: armed.hit.x,
                y: armed.hit.y,
                radius: armed.hit.radius,
              },
            },
            'all',
          ),
        );
        gesture = null;
        confirmedPreview = [];
        predictionVisible = false;
        ctx.setPreview([]);
        return;
      }
      if (
        !internalRunEnd &&
        (options.gestureSource?.() ?? options.gestures)?.scribble === true
      ) {
        const hit = recognizeScribble(active.samples);
        if (hit !== null) {
          // Conservative: strokes only (never images or shapes), one
          // gesture, one history transaction, still on the pen tool.
          // Segment intersection (not sample containment) so long spans
          // crossing the scribble zone erase even between samples.
          const region: SelectionRegion = {
            box: {
              x: hit.minX,
              y: hit.minY,
              width: hit.maxX - hit.minX,
              height: hit.maxY - hit.minY,
            },
          };
          const removed = new Set<SurfaceObjectId>();
          for (const group of groupLogicalChunks(ctx.model).values()) {
            if (
              group.records.some((record) =>
                recordInRegion(ctx, record, region, 'all'),
              )
            ) {
              for (const id of group.chunkIds) removed.add(id);
            }
          }
          for (const id of [...ctx.model.order]) {
            const record = ctx.model.objects[id];
            if (
              record?.type !== SURFACE_OBJECT_TYPES.stroke ||
              logicalIdOf(record) !== null
            )
              continue;
            if (recordInRegion(ctx, record, region, 'all')) removed.add(id);
          }
          for (const id of removed) ctx.removeObject(id);
          gesture = null;
          confirmedPreview = [];
          predictionVisible = false;
          ctx.setPreview([]);
          return;
        }
      }
      const style = active.liveStyle;
      const tuning = active.liveTuning;
      // Normal runtime creation must never emit a >10k-sample record:
      // split oversized gestures into sequential capped fragments BEFORE
      // canonical commit (same fragment contract as decode recovery —
      // head keeps the gesture id, tails take `${id}#part${n}`, timing
      // rebased per fragment). Decode recovery remains for older
      // documents only.
      const samples = gesture.samples;
      const brushMember: InkBrushDescriptor = {
        ...(tuning !== undefined ? { ...tuning } : {}),
        kind: options.kind,
      };
      const makeRecord = (
        id: SurfaceObjectId,
        points: readonly InkSample[],
        logical?: { logicalId: string; chunkIndex: number },
      ): SurfaceObjectRecord =>
        inkStrokeObject(id, {
          // `inkStrokeObject` takes the one owned array copy for the
          // canonical record. Spreading here too doubled that full-stroke
          // allocation on pointer-up.
          points,
          width: style.width,
          ...(style.color !== undefined ? { color: style.color } : {}),
          ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
          // Resolved appearance travels with the stroke: the pointer-down
          // snapshot is stored, so later preset edits never rewrite
          // committed handwriting and the commit derives exactly what the
          // preview drew. Kind always comes from tool identity, never from
          // preset tuning.
          brush: { ...brushMember },
          ...(logical !== undefined
            ? { logicalId: logical.logicalId, chunkIndex: logical.chunkIndex }
            : {}),
        });
      if (samples.length <= SURFACE_MAX_STROKE_POINTS) {
        ctx.addObject(
          makeRecord(
            gesture.objectId,
            rebaseStrokeTiming(samples) as InkSample[],
          ),
        );
      } else {
        // Logical-stroke chunking: one continuous gesture, canonical chunks
        // capped at the record limit sharing the head id as `logicalId`.
        // Internal boundaries are never stroke ends (joint derived
        // compilation supplies caps/taper/continuity); each chunk stays
        // below the sample limit; continuation chunks preserve boundary
        // timing so joint compilation restores the original sequence.
        const cap = SURFACE_MAX_STROKE_POINTS;
        const parts = Math.ceil(samples.length / cap);
        const logicalId = gesture.objectId;
        for (let part = 0; part < parts; part++) {
          const run = samples.slice(part * cap, (part + 1) * cap);
          let id: SurfaceObjectId =
            part === 0
              ? gesture.objectId
              : `${gesture.objectId}#part${part + 1}`;
          while (ctx.model.objects[id] !== undefined) id = `${id}#part`;
          ctx.addObject(
            makeRecord(
              id,
              rebaseLogicalChunkTiming(run, part === 0) as InkSample[],
              { logicalId, chunkIndex: part },
            ),
          );
        }
      }
      gesture = null;
      confirmedPreview = [];
      predictionVisible = false;
    },
    onCancel: (ctx) => {
      if (gesture !== null) clearProtected(ctx, gesture);
      gesture = null;
      continuation = null;
      confirmedPreview = [];
      predictionVisible = false;
      ctx.setPreview([]);
    },
  };
  tool.onRunEnd = (ctx, event) => {
    if (gesture === null) return;
    continuation = {
      style: gesture.liveStyle,
      brush: gesture.liveBrush,
      tuning: gesture.liveTuning,
    };
    tool.onUp?.(ctx, event);
  };
  tool.onRunStart = (ctx, event) => tool.onDown?.(ctx, event);
  tool.onRunsComplete = () => {
    continuation = null;
  };
  return tool;
}

/**
 * Build the canonical shape record for a recognized fit, styled like a
 * shape-tool commit (pen color as fill for closed shapes, stroke style
 * for lines; closed shapes carry no opacity member).
 */
function shapeRecordForFit(
  fit: ShapeFit,
  id: SurfaceObjectId,
  style: PreviewStyle,
): SurfaceObjectRecord {
  const color = style.color;
  switch (fit.kind) {
    case 'rectangle':
      return rectangleObject(id, {
        x: fit.x,
        y: fit.y,
        width: fit.width,
        height: fit.height,
        ...(color !== undefined ? { fill: color } : {}),
      });
    case 'ellipse':
      return ellipseObject(id, {
        x: fit.x,
        y: fit.y,
        width: fit.width,
        height: fit.height,
        ...(color !== undefined ? { fill: color } : {}),
      });
    case 'line':
      return lineObject(id, {
        x: fit.x,
        y: fit.y,
        x2: fit.x2,
        y2: fit.y2,
        width: style.width,
        ...(color !== undefined ? { color } : {}),
        ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
      });
    case 'arrow':
      return lineObject(id, {
        x: fit.x,
        y: fit.y,
        x2: fit.x2,
        y2: fit.y2,
        width: style.width,
        arrows: 'end',
        ...(color !== undefined ? { color } : {}),
        ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
      });
  }
}

/** Compile a shape record to preview items through the live registry. */
function previewShapeItems(
  ctx: SurfaceToolContext,
  record: SurfaceObjectRecord,
): DrawItem[] {
  try {
    const compiled = ctx.objectRegistry.get(record.type)?.compile?.(record);
    if (compiled === null || compiled === undefined) return [];
    return [...(Array.isArray(compiled) ? compiled : [compiled])];
  } catch {
    return [];
  }
}

function erasesRecord(
  ctx: SurfaceToolContext,
  record: SurfaceObjectRecord,
  surface: Point,
  radiusSurface: number,
  previous: Point | null = null,
): boolean {
  if (isRecordLocked(ctx, record)) return false;
  if (record.type === SURFACE_OBJECT_TYPES.stroke) {
    const envelope = inkStrokeEnvelope(record);
    if (envelope === null) return false;
    const local = unrotateAround(
      surface,
      centerOfBounds(envelope),
      rotationOf(record),
    );
    if (previous === null) {
      return hitVisible(
        inkStrokeContoursOfRecord(record),
        local,
        radiusSurface,
      );
    }
    const start = unrotateAround(
      previous,
      centerOfBounds(envelope),
      rotationOf(record),
    );
    if (
      !boundsIntersect(envelope, {
        x: Math.min(start.x, local.x) - radiusSurface,
        y: Math.min(start.y, local.y) - radiusSurface,
        width: Math.abs(start.x - local.x) + radiusSurface * 2,
        height: Math.abs(start.y - local.y) + radiusSurface * 2,
      })
    )
      return false;
    return sweepHitsVisible(
      inkStrokeContoursOfRecord(record),
      start,
      local,
      radiusSurface,
    );
  }
  // Non-stroke objects erase only on a direct registered hit.
  const descriptor = ctx.objectRegistry.get(record.type);
  if (descriptor?.hitTest !== undefined) {
    try {
      return descriptor.hitTest(record, surface.x, surface.y);
    } catch {
      return false;
    }
  }
  return false;
}

function eraserTool(
  radiusView: number,
  radiusRef?: EraserStyleRef,
  presetSource?: () => EraserPreset | undefined,
): SurfaceTool {
  /** Previous eraser position: all ink eraser modes sweep between events. */
  let last: Point | null = null;
  const radiusAt = (ctx: SurfaceToolContext): number => {
    const preset = presetSource?.();
    const viewRadius =
      preset?.mode === 'precision'
        ? (radiusRef?.radius ?? preset.radius ?? radiusView)
        : radiusView;
    return viewRadius / ctx.camera().zoom;
  };
  const eraseWholeAt = (
    ctx: SurfaceToolContext,
    surface: Point,
    radiusSurface: number,
  ) => {
    const filter = presetSource?.()?.filter ?? 'all';
    const removed: SurfaceObjectId[] = [];
    const handled = new Set<string>();
    for (const group of groupLogicalChunks(ctx.model).values()) {
      for (const id of group.chunkIds) handled.add(id);
      const head = logicalHead(group);
      if (
        matchesEraserFilter(head, filter) &&
        erasesRecord(
          ctx,
          jointInkSourceRecord(group),
          surface,
          radiusSurface,
          last,
        )
      )
        removed.push(...group.chunkIds);
    }
    for (const id of [...ctx.model.order]) {
      if (handled.has(id)) continue;
      const record = ctx.model.objects[id];
      if (record === undefined || !matchesEraserFilter(record, filter))
        continue;
      if (erasesRecord(ctx, record, surface, radiusSurface, last))
        removed.push(id);
    }
    // Whole-stroke erase removes the entire logical stroke when any chunk
    // is hit (one selection identity).
    const expanded = expandLogicalIds(ctx.model, removed);
    for (const id of expanded) ctx.removeObject(id);
  };
  const touched = new Map<string, SurfaceObjectRecord>();
  const progress = new Map<string, { base: InkErasure; mask: InkErasure }>();
  const eraseSplitBatch = (
    ctx: SurfaceToolContext,
    sweeps: readonly { start: Point; end: Point; radius: number }[],
  ) => {
    if (sweeps.length === 0) return;
    const preset = presetSource?.();
    const filter = preset?.filter ?? 'all';
    // Keep one semantic source and its original pivot. The mask describes
    // the eraser footprint, never a new input stream for the brush compiler.
    // Surface capsules are computed once per batch and shared verbatim by
    // rotation-free strokes: no per-stroke trig, no pivot-translation ulps,
    // and identical footprint sets hit the cut-union cache in erasure.ts.
    const surfaceCapsules: (Point[] | undefined)[] = sweeps.map(
      () => undefined,
    );
    const erase = (record: SurfaceObjectRecord, ids: readonly string[]) => {
      const envelope = inkStrokeEnvelope(record);
      if (envelope === null) return;
      const rotation = rotationOf(record);
      const pivot = centerOfBounds(envelope);
      const visible = inkStrokeContoursOfRecord(record);
      const footprints: Point[][] = [];
      for (let index = 0; index < sweeps.length; index++) {
        const sweep = sweeps[index]!;
        if (rotation === 0) {
          if (
            !boundsIntersect(envelope, {
              x: Math.min(sweep.start.x, sweep.end.x) - sweep.radius,
              y: Math.min(sweep.start.y, sweep.end.y) - sweep.radius,
              width: Math.abs(sweep.start.x - sweep.end.x) + sweep.radius * 2,
              height: Math.abs(sweep.start.y - sweep.end.y) + sweep.radius * 2,
            })
          )
            continue;
          if (!sweepHitsVisible(visible, sweep.start, sweep.end, sweep.radius))
            continue;
          let capsule = surfaceCapsules[index];
          if (capsule === undefined) {
            capsule = capsuleFootprint(sweep.start, sweep.end, sweep.radius);
            surfaceCapsules[index] = capsule;
          }
          footprints.push(capsule);
          continue;
        }
        const local = unrotateAround(sweep.end, pivot, rotation);
        const start = unrotateAround(sweep.start, pivot, rotation);
        if (
          !boundsIntersect(envelope, {
            x: Math.min(start.x, local.x) - sweep.radius,
            y: Math.min(start.y, local.y) - sweep.radius,
            width: Math.abs(start.x - local.x) + sweep.radius * 2,
            height: Math.abs(start.y - local.y) + sweep.radius * 2,
          })
        )
          continue;
        if (!sweepHitsVisible(visible, start, local, sweep.radius)) continue;
        footprints.push(capsuleFootprint(start, local, sweep.radius));
      }
      if (footprints.length === 0) return;
      const existingRegion = inkRegion(record);
      const draft = progress.get(ids[0]!);
      const base = draft?.base ?? existingRegion ?? regionOfContours(visible);
      const contact = addErasureBatch(
        [],
        draft?.mask,
        footprints,
        visible,
        base,
      );
      const result = {
        region: contact.changed ? regionOfContours(contact.contours) : [],
        changed: contact.changed,
      };
      if (contact.changed) {
        const world = (input: InkErasure): InkErasure =>
          rotation === 0
            ? input
            : input.map((poly) =>
                poly.map((ring) =>
                  ring.map((p) => rotateAround(p, pivot, rotation)),
                ),
              );
        progress.set(ids[0]!, {
          base: world(base),
          mask: world(contact.erasure),
        });
      }
      if (!result.changed) return;
      if (result.region.length === 0) {
        for (const id of ids) ctx.removeObject(id);
        touched.delete(ids[0]!);
        return;
      }
      // Bake the old rotation about its ORIGINAL source pivot into the fill.
      // Each new fragment then has its own transform and never recompiles a nib.
      const region = freezeInkValue(
        rotation === 0
          ? result.region
          : result.region.map((poly) =>
              poly.map((ring) =>
                ring.map((p) => rotateAround(p, pivot, rotation)),
              ),
            ),
      );
      const head = ctx.model.objects[ids[0]!]!;
      let sourceId = head.sourceId as string | undefined;
      if (sourceId === undefined) {
        sourceId = ctx.newObjectId();
        const chunks = ids.map((id) => {
          const original = ctx.model.objects[id]!;
          const chunk = cloneTemplateValue(original);
          const packed = packedCompiledForRecord(original),
            offset = derivedTranslationOfRecord(original);
          if (packed !== undefined && offset.tx === 0 && offset.ty === 0)
            retainPackedOnlyForRecord(chunk, packed);
          return chunk;
        });
        const original = inkStrokeOutlineOfRecord(record);
        const outline =
          rotation === 0
            ? original
            : original.map((p) => rotateAround(p, pivot, rotation));
        const provenance = resolveInkInteractionGeometry(record).kind;
        const source = freezeInkValue({
          id: sourceId,
          type: INK_SOURCE_TYPE,
          chunks,
          outlineLength: outline.length,
          ...(provenance === 'record-packed' ||
          provenance === 'logical-joint-packed'
            ? { sampleEncoding: 'packed' }
            : {}),
        });
        retainInkSourceOutline(source, outline);
        ctx.addSource(source);
      }
      const replacement: SurfaceObjectRecord = {
        ...head,
        sourceId,
        region,
        rotation: 0,
      };
      delete replacement.points;
      delete replacement.erasure;
      delete replacement.logicalId;
      delete replacement.chunkIndex;
      delete replacement.visible;
      if (head.visible !== undefined && rotation !== 0) {
        const transformed = { ...head };
        mapInkRegion(transformed, (p) => rotateAround(p, pivot, rotation));
        replacement.regionTransform = transformed.regionTransform;
      }
      bindInkSource(replacement, ctx.model.objects[sourceId]!);
      // Collapse logical chunks to one identity before separating components.
      for (const id of ids.slice(1)) ctx.removeObject(id);
      for (const groupId of ctx.model.order) {
        const group = ctx.model.objects[groupId];
        if (
          group?.type !== SURFACE_OBJECT_TYPES.group ||
          !Array.isArray(group.children) ||
          !group.children.some((child) => ids.includes(child))
        )
          continue;
        const children = [
          ...new Set(
            group.children.map((child) =>
              ids.includes(child) ? head.id : child,
            ),
          ),
        ];
        ctx.replaceObject(groupId, [{ ...group, children }]);
      }
      ctx.replaceObject(head.id, [replacement]);
      ctx.stageErasure(replacement);
      touched.set(head.id, replacement);
    };
    const nearby = new Set<SurfaceObjectId>();
    if (ctx.queryRegion === undefined) {
      for (const id of ctx.model.order) nearby.add(id);
    } else {
      for (const { start, end, radius } of sweeps) {
        for (const id of ctx.queryRegion({
          x: Math.min(start.x, end.x) - radius,
          y: Math.min(start.y, end.y) - radius,
          width: Math.abs(start.x - end.x) + radius * 2,
          height: Math.abs(start.y - end.y) + radius * 2,
        }))
          nearby.add(id);
      }
    }
    if (nearby.size === 0) return;
    const handled = new Set<SurfaceObjectId>();
    for (const id of nearby) {
      if (handled.has(id)) continue;
      const candidate = ctx.model.objects[id];
      const logicalId = candidate === undefined ? null : logicalIdOf(candidate);
      if (logicalId === null) continue;
      const records = logicalMembersOf(ctx.model, logicalId)
        .map((member) => ctx.model.objects[member]!)
        .filter(Boolean)
        .sort((a, b) => (chunkIndexOf(a) ?? 0) - (chunkIndexOf(b) ?? 0));
      const chunkIds = records.map((record) => record.id);
      for (const member of chunkIds) handled.add(member);
      const head = records[0];
      if (
        head === undefined ||
        !matchesEraserFilter(head, filter) ||
        isRecordLocked(ctx, head)
      )
        continue;
      erase(jointInkSourceRecord({ logicalId, records, chunkIds }), chunkIds);
    }
    for (const id of nearby) {
      if (handled.has(id)) continue;
      const record = ctx.model.objects[id];
      if (
        record === undefined ||
        !matchesEraserFilter(record, filter) ||
        isRecordLocked(ctx, record)
      )
        continue;
      if (record.type === SURFACE_OBJECT_TYPES.stroke) erase(record, [id]);
      else if (
        sweeps.some((sweep) =>
          erasesRecord(ctx, record, sweep.end, sweep.radius),
        )
      )
        ctx.removeObject(id);
    }
  };
  const eraseAt = (ctx: SurfaceToolContext, event: NormalizedPointerEvent) => {
    const surface = viewToSurface(ctx.camera(), event.point);
    const radiusSurface = radiusAt(ctx);
    const mode = presetSource?.()?.mode ?? 'stroke';
    if (mode === 'stroke') {
      eraseWholeAt(ctx, surface, radiusSurface);
    } else {
      eraseSplitBatch(ctx, [
        { start: last ?? surface, end: surface, radius: radiusSurface },
      ]);
    }
    last = surface;
  };
  return {
    toolId: SURFACE_TOOL_IDS.eraser,
    version: 1,
    onDown: eraseAt,
    onMove: eraseAt,
    onBatch: (ctx, events) => {
      if ((presetSource?.()?.mode ?? 'stroke') !== 'precision') {
        for (const event of events) eraseAt(ctx, event);
        return;
      }
      const sweeps: { start: Point; end: Point; radius: number }[] = [];
      for (const event of events) {
        const end = viewToSurface(ctx.camera(), event.point);
        const sweep = { start: last ?? end, end, radius: radiusAt(ctx) };
        const previous = sweeps[sweeps.length - 1];
        // Consecutive collinear capsules have exactly the same footprint
        // as their joined capsule. Bends and reversals stay separate.
        const ax =
          previous === undefined ? 0 : previous.end.x - previous.start.x;
        const ay =
          previous === undefined ? 0 : previous.end.y - previous.start.y;
        const bx = end.x - sweep.start.x;
        const by = end.y - sweep.start.y;
        if (
          previous !== undefined &&
          previous.radius === sweep.radius &&
          (ax !== 0 || ay !== 0) &&
          ax * by === ay * bx &&
          ax * bx + ay * by >= 0
        ) {
          previous.end = end;
        } else sweeps.push(sweep);
        last = end;
      }
      eraseSplitBatch(ctx, sweeps);
    },
    onUp: (ctx) => {
      const accepted = [...touched.values()];
      touched.clear();
      progress.clear();
      last = null;
      ctx.finishErasure(accepted);
      // Optional auto-return: a temporarily entered eraser restores the
      // previous tool at gesture end; a manually chosen eraser stays.
      if (presetSource?.()?.autoReturn === true) ctx.exitTemporaryTool();
    },
    onCancel: (ctx) => {
      touched.clear();
      progress.clear();
      last = null;
      ctx.cancelErasure();
      // A cancelled gesture ends the temporary entry exactly like an
      // explicit lift; manual selection is unaffected (no stack entry).
      if (presetSource?.()?.autoReturn === true) ctx.exitTemporaryTool();
      ctx.setPreview([]);
    },
  };
}

/** Lasso marquee look: thin violet, screen-legible at any zoom. */
const LASSO_PREVIEW_STYLE: PreviewStyle = { width: 1.5, color: '#7c6cf0' };

function lassoTool(presetSource?: () => LassoPreset | undefined): SurfaceTool {
  type Drag =
    | { readonly kind: 'path'; readonly path: Point[] }
    | { readonly kind: 'box'; readonly anchor: Point; corner: Point }
    | { readonly kind: 'move'; readonly last: Point };
  let drag: Drag | null = null;
  const modeOf = (): 'freehand' | 'rectangle' =>
    presetSource?.()?.mode ?? 'freehand';
  const filterOf = () => presetSource?.()?.filter ?? 'all';
  const boxOf = (anchor: Point, corner: Point): Bounds => ({
    x: Math.min(anchor.x, corner.x),
    y: Math.min(anchor.y, corner.y),
    width: Math.abs(corner.x - anchor.x),
    height: Math.abs(corner.y - anchor.y),
  });
  const boxMarquee = (anchor: Point, corner: Point): DrawItem[] => {
    const box = boxOf(anchor, corner);
    // Closed-loop guide preview: the explicit polyline kind renders the
    // marquee outline (no fill), matching the freehand marquee look.
    const ring = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
      { x: box.x, y: box.y },
    ];
    return polylinePreview('froglight.ink.lasso-preview', ring, {
      ...LASSO_PREVIEW_STYLE,
    });
  };
  return {
    toolId: SURFACE_TOOL_IDS.lasso,
    interactionRole: 'selection',
    version: 1,
    onDown: (ctx, event) => {
      const surface = viewToSurface(ctx.camera(), event.point);
      const envelope = selectionEnvelope(ctx);
      // Down inside an existing selection drags it ephemerally (Slice 1):
      // no canonical mutation until onUp commits once. Anything else
      // starts a fresh marquee in the preset mode.
      if (
        envelope !== null &&
        surface.x >= envelope.x &&
        surface.x <= envelope.x + envelope.width &&
        surface.y >= envelope.y &&
        surface.y <= envelope.y + envelope.height
      ) {
        drag = { kind: 'move', last: surface };
        ctx.beginEphemeralMove();
        return;
      }
      drag =
        modeOf() === 'rectangle'
          ? { kind: 'box', anchor: surface, corner: surface }
          : { kind: 'path', path: [surface] };
      ctx.setPreview([]);
    },
    onMove: (ctx, event) => {
      if (drag === null) return;
      const surface = viewToSurface(ctx.camera(), event.point);
      if (drag.kind === 'move') {
        ctx.updateEphemeralMove({
          x: surface.x - drag.last.x,
          y: surface.y - drag.last.y,
        });
        drag = { kind: 'move', last: surface };
        return;
      }
      if (drag.kind === 'box') {
        drag = { kind: 'box', anchor: drag.anchor, corner: surface };
        ctx.setPreview(boxMarquee(drag.anchor, drag.corner));
        return;
      }
      drag.path.push(surface);
      ctx.setPreview(
        polylinePreview(
          'froglight.ink.lasso-preview',
          drag.path,
          LASSO_PREVIEW_STYLE,
        ),
      );
    },
    onUp: (ctx, event) => {
      if (drag === null) return;
      if (drag.kind === 'move') {
        ctx.commitEphemeralMove();
        drag = null;
        return;
      }
      const region =
        drag.kind === 'box'
          ? {
              box: boxOf(drag.anchor, viewToSurface(ctx.camera(), event.point)),
            }
          : (() => {
              const path = [
                ...drag.path,
                viewToSurface(ctx.camera(), event.point),
              ];
              let minX = Infinity;
              let minY = Infinity;
              let maxX = -Infinity;
              let maxY = -Infinity;
              for (const pt of path) {
                minX = Math.min(minX, pt.x);
                minY = Math.min(minY, pt.y);
                maxX = Math.max(maxX, pt.x);
                maxY = Math.max(maxY, pt.y);
              }
              return {
                path,
                tiny: path.length < 3 || (maxX - minX < 2 && maxY - minY < 2),
              };
            })();
      const tiny =
        'box' in region
          ? region.box.width < 2 && region.box.height < 2
          : region.tiny;
      if (!tiny) {
        ctx.setSelection(collectInRegion(ctx, region, filterOf()));
      } else if (
        ctx.selection().length > 0 &&
        !pointNearSelection(ctx, viewToSurface(ctx.camera(), event.point))
      ) {
        // A tap outside everything clears the selection.
        ctx.setSelection([]);
      }
      drag = null;
    },
    onCancel: (ctx) => {
      ctx.cancelEphemeralMove();
      drag = null;
      ctx.setPreview([]);
    },
  };
}

function pointNearSelection(ctx: SurfaceToolContext, p: Point): boolean {
  const envelope = selectionEnvelope(ctx);
  if (envelope === null) return false;
  return (
    p.x >= envelope.x &&
    p.x <= envelope.x + envelope.width &&
    p.y >= envelope.y &&
    p.y <= envelope.y + envelope.height
  );
}

export function createDefaultSurfaceToolRegistry(
  options: {
    eraserRadiusView?: number;
    penStyle?: PenStyleRef;
    eraserStyle?: EraserStyleRef;
    /** Per-tool presets; when set, tools read style from the store. */
    presets?: InkPresetStore;
    /** Pen-gesture recognizers (slice 7); wired to the pen tool only. */
    penGestures?: PenGestureOptions;
  } = {},
): SurfaceToolRegistry {
  const registry = new InMemorySurfaceToolRegistry();
  const presetFor = (
    tool: 'pen' | 'fountain' | 'brush' | 'pencil' | 'highlighter',
  ): Pick<StrokePresetToolOptions, 'presetSource'> =>
    options.presets !== undefined
      ? { presetSource: () => options.presets!.getTool(tool) }
      : {};
  for (const tool of [
    {
      toolId: SURFACE_TOOL_IDS.select,
      interactionRole: 'selection',
      version: 1,
    },
    strokePresetTool({
      toolId: SURFACE_TOOL_IDS.pen,
      kind: 'ball',
      ...(options.penStyle !== undefined
        ? { styleSource: () => options.penStyle }
        : {}),
      ...presetFor('pen'),
      ...(options.penGestures !== undefined
        ? { gestures: options.penGestures }
        : {}),
      // Live gesture prefs from the shared store (immediate propagation
      // to mounted surfaces); static penGestures remains the fallback.
      ...(options.presets !== undefined
        ? {
            gestureSource: () => {
              const prefs = options.presets!.getGestures();
              return {
                ...(prefs.drawAndHold === true ? { shape: true as const } : {}),
                ...(prefs.scribbleErase === true
                  ? { scribble: true as const }
                  : {}),
                ...(prefs.circleLasso === true
                  ? { circle: true as const }
                  : {}),
              };
            },
          }
        : {}),
    }),
    strokePresetTool({
      toolId: SURFACE_TOOL_IDS.fountain,
      kind: 'fountain',
      ...presetFor('fountain'),
    }),
    strokePresetTool({
      toolId: SURFACE_TOOL_IDS.brush,
      kind: 'brush',
      ...presetFor('brush'),
    }),
    strokePresetTool({
      toolId: SURFACE_TOOL_IDS.pencil,
      kind: 'pencil',
      ...presetFor('pencil'),
    }),
    strokePresetTool({
      toolId: SURFACE_TOOL_IDS.highlighter,
      kind: 'highlighter',
      width: HIGHLIGHTER_PRESET.width,
      opacity: HIGHLIGHTER_PRESET.opacity,
      ...(options.penStyle !== undefined
        ? {
            styleSource: () => {
              const live = options.penStyle?.color;
              return { color: live ?? HIGHLIGHTER_PRESET.color };
            },
          }
        : { color: HIGHLIGHTER_PRESET.color }),
      ...presetFor('highlighter'),
    }),
    eraserTool(
      options.eraserRadiusView ?? DEFAULT_ERASER_RADIUS_VIEW,
      options.eraserStyle,
      options.presets !== undefined
        ? () => options.presets!.getEraser()
        : undefined,
    ),
    lassoTool(
      options.presets !== undefined
        ? () => options.presets!.getLasso()
        : undefined,
    ),
  ] satisfies SurfaceTool[]) {
    registry.register(tool);
  }
  return registry;
}

// --- Selection transforms (slice 6) ---

/** Content categories for selection context snapshots. */
// --- Controller ---

export interface InkToolControllerOptions {
  readonly model: SurfaceModel;
  readonly objectRegistry: SurfaceObjectTypeRegistry;
  readonly toolRegistry?: SurfaceToolRegistry;
  readonly camera?: Camera;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /**
   * Snap threshold in view units for select-drag alignment (slice 9);
   * 0 or omitted disables. Guides merge into preview items.
   */
  readonly snapThresholdView?: number;
  /**
   * Ephemeral straightedge ruler (slice 10, notebook): visible rulers
   * snap pen-family gestures that start near the edge and render an
   * overlay guide. Never canonical, never dirty, never history.
   */
  readonly ruler?: SurfaceRulerState | null;
  readonly onMutate?: (mutatedIds: readonly SurfaceObjectId[]) => void;
  /**
   * Mutation-recorder seam for patch history: invoked BEFORE each
   * mutation batch with the ids about to change.
   */
  readonly onBeforeMutate?: (mutatedIds: readonly SurfaceObjectId[]) => void;
  /**
   * Command-history seam for pure translations (Slice 3): invoked INSTEAD
   * of onBeforeMutate for drag commits, so providers record {ids,dx,dy}
   * without cloning sample arrays.
   */
  readonly onBeforeTranslate?: (
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ) => void;
  /** Deterministic tests inject this; production ids only need uniqueness. */
  readonly idFactory?: () => SurfaceObjectId;
  /** Invoked at the start of every pointer gesture (provider-local
   *  history hooks snapshot here, before any mutation). */
  readonly erasurePreparation?: ErasurePreparation;
  readonly onErasureRefinement?: (
    refinement: ErasureRefinement,
    publish: () => void,
  ) => void;
  readonly onErasureError?: (error: unknown) => void;
  readonly onGestureStart?: () => void;
  /** Invoked after every completed pointer gesture (commit transaction). */
  readonly onGestureEnd?: () => void;
  /** Invoked after every cancelled pointer gesture (rollback transaction). */
  readonly onGestureCancel?: () => void;
  /**
   * Diagnostics: invoked on every tool preview publish (including empty
   * clears). Lets structural tests prove publish coalescing without
   * timing; production code leaves it unset.
   */
  readonly onPreviewPublish?: () => void;
  /**
   * Invoked whenever the active tool id changes through setTool or the
   * temporary-tool stack, so providers refresh toolbar snapshots.
   */
  readonly onActiveToolChange?: (toolId: string) => void;
}

export class InkToolController {
  readonly #inner: SurfaceInteractionController;
  readonly #model: SurfaceModel;
  readonly #objectRegistry: SurfaceObjectTypeRegistry;
  readonly #toolRegistry: SurfaceToolRegistry;
  readonly #onMutate: ((ids: readonly SurfaceObjectId[]) => void) | null;
  readonly #onBeforeMutate: ((ids: readonly SurfaceObjectId[]) => void) | null;
  readonly #idFactory: () => SurfaceObjectId;
  readonly #onGestureStart: (() => void) | null;
  readonly #onGestureEnd: (() => void) | null;
  readonly #onGestureCancel: (() => void) | null;
  readonly #onPreviewPublish: (() => void) | null;
  readonly #onActiveToolChange: ((toolId: string) => void) | null;
  #activeToolId: string;
  #selectionGesture = false;
  readonly #erasurePreparation: ErasurePreparation | undefined;
  readonly #onErasureRefinement: InkToolControllerOptions['onErasureRefinement'];
  readonly #onErasureError: InkToolControllerOptions['onErasureError'];
  #erasureJob = 1;
  #erasurePublication: Promise<void> = Promise.resolve();
  readonly #erasurePositions = new WeakMap<SurfaceObjectRecord, number>();
  readonly #knownErasureSources = new Map<string, SurfaceObjectRecord>();
  readonly #stagedErasureRecords = new Set<SurfaceObjectRecord>();
  readonly #erasureFragmentIds = new WeakMap<object, string[]>();
  readonly #erasureJobs = new Set<Promise<void>>();
  #erasureError: unknown = null;
  #erasureOwnerReleased = false;
  readonly #erasureRetry: { dispose(): void };
  #gestureDone: (() => void) | null = null;
  #dispatchingGestureEnd = false;
  #eraserRollback: {
    before: Map<string, SurfaceObjectRecord | undefined>;
    order: import('./transactions.js').SurfaceOrderEdit[];
  } | null = null;
  readonly #eraserObservation: { dispose(): void };

  retryErasure(): void {
    if (this.#erasureError !== null) this.#erasurePreparation?.restart?.();
    clearSurfaceWorkError(this.#model);
    this.#erasureError = null;
    const records = Object.values(this.#model.objects).filter(
      (record) =>
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        record.region !== undefined,
    );
    for (const record of records) {
      this.#erasurePositions.set(record, this.#model.order.indexOf(record.id));
      this.#erasurePreparation?.stage(
        this.#erasureJob,
        record.id,
        inkRegion(record)!,
        this.#model.objects[record.sourceId as string]!,
        record.regionTransform as InkRegionTransform | undefined,
      );
    }
    this.#finishErasure(records);
  }
  async drainErasure(): Promise<void> {
    while (this.#erasureJobs.size > 0) await Promise.all(this.#erasureJobs);
    if (this.#erasureError !== null) throw this.#erasureError;
  }

  #usesSelection(): boolean {
    return (
      this.#selectionGesture || this.#activeToolId === SURFACE_TOOL_IDS.select
    );
  }
  /** Previous tools for temporary entry (double-tap, eraser end, …). */
  #temporaryStack: string[] = [];
  #preview: DrawItem[] = [];
  #snapGuides: DrawItem[] = [];
  /** Ephemeral straightedge (slice 10): never canonical, never dirty. */
  #ruler: SurfaceRulerState | null = null;
  /** Latched per-gesture: true when the stroke started against the ruler. */
  #rulerSnapping = false;
  #pendingMutations: SurfaceObjectId[] = [];
  #idCounter = 0;
  #destroyed = false;

  constructor(options: InkToolControllerOptions) {
    this.#model = options.model;
    seedInkSourceOwnership(this.#model);
    this.#objectRegistry = options.objectRegistry;
    this.#toolRegistry =
      options.toolRegistry ?? createDefaultSurfaceToolRegistry();
    this.#onMutate = (ids) => {
      const reclaimed = unusedInkSources(this.#model, ids);
      if (reclaimed.length > 0) {
        this.#onBeforeMutate?.(reclaimed);
        for (const id of reclaimed) {
          releaseInkSourceGeometry(this.#model.objects[id]!);
          this.#erasurePreparation?.releaseSource?.(id);
          delete this.#model.objects[id];
        }
      }
      const changed = [...ids, ...reclaimed];
      publishSurfaceObjects(this.#model, changed);
      options.onMutate?.(changed);
      if (
        this.#gestureDone === null &&
        !this.#destroyed &&
        this.#erasurePreparation !== undefined
      ) {
        const regions = changed
          .map((id) => this.#model.objects[id])
          .filter(
            (record): record is SurfaceObjectRecord =>
              record !== undefined &&
              record.type === SURFACE_OBJECT_TYPES.stroke &&
              record.region !== undefined,
          );
        for (const record of regions) {
          this.#erasurePositions.set(
            record,
            this.#model.order.indexOf(record.id),
          );
          this.#erasurePreparation.stage(
            this.#erasureJob,
            record.id,
            inkRegion(record)!,
            this.#model.objects[record.sourceId as string]!,
            record.regionTransform as InkRegionTransform | undefined,
          );
        }
        if (regions.length > 0) this.#finishErasure(regions);
      }
    };
    this.#onBeforeMutate = options.onBeforeMutate ?? null;
    this.#erasurePreparation = options.erasurePreparation;
    this.#erasureRetry = registerSurfaceWorkRetry(this.#model, () =>
      this.retryErasure(),
    );
    this.#onErasureRefinement = options.onErasureRefinement;
    this.#onErasureError = options.onErasureError;
    this.#onGestureStart = options.onGestureStart ?? null;
    this.#onGestureEnd = options.onGestureEnd ?? null;
    this.#onGestureCancel = options.onGestureCancel ?? null;
    this.#eraserObservation = observeSurfaceTransactions(this.#model, {
      objects: (ids) => {
        for (const id of ids) {
          const source = this.#knownErasureSources.get(id);
          if (source !== undefined && this.#model.objects[id] === undefined) {
            this.#knownErasureSources.delete(id);
            releaseInkSourceGeometry(source);
            this.#erasurePreparation?.releaseSource?.(id);
          }
        }
      },
      order: (edit) => {
        this.#eraserRollback?.order.push(edit);
        for (const record of this.#stagedErasureRecords) {
          const index = this.#erasurePositions.get(record)!;
          if (index >= edit.index + edit.removed.length)
            this.#erasurePositions.set(
              record,
              index + edit.inserted.length - edit.removed.length,
            );
          else if (index >= edit.index) {
            const inserted = edit.inserted.indexOf(record.id);
            if (inserted >= 0)
              this.#erasurePositions.set(record, edit.index + inserted);
            else this.#stagedErasureRecords.delete(record);
          }
        }
      },
    });
    this.#onPreviewPublish = options.onPreviewPublish ?? null;
    this.#onActiveToolChange = options.onActiveToolChange ?? null;
    this.#idFactory =
      options.idFactory ??
      (() => {
        this.#idCounter += 1;
        return `ink-${this.#idCounter}-${Math.random().toString(36).slice(2, 8)}`;
      });
    this.#activeToolId = SURFACE_TOOL_IDS.select;
    if (options.ruler !== undefined && options.ruler !== null) {
      this.#ruler = isValidRulerState(options.ruler) ? options.ruler : null;
    }
    this.#inner = new SurfaceInteractionController({
      model: options.model,
      registry: options.objectRegistry,
      ...(options.onBeforeTranslate !== undefined
        ? { onBeforeTranslate: options.onBeforeTranslate }
        : {}),
      ...(options.camera !== undefined ? { camera: options.camera } : {}),
      ...(options.minZoom !== undefined ? { minZoom: options.minZoom } : {}),
      ...(options.maxZoom !== undefined ? { maxZoom: options.maxZoom } : {}),
      ...(options.snapThresholdView !== undefined
        ? { snapThresholdView: options.snapThresholdView }
        : {}),
      onMutate: (ids) => this.#onMutate?.(ids),
      ...(options.onBeforeMutate !== undefined
        ? { onBeforeMutate: options.onBeforeMutate }
        : {}),
      onSnapGuides: (guides) => {
        this.#snapGuides = [...guides];
      },
    });
  }

  /** Mutation-recorder hook (patch history). */
  #before(ids: readonly SurfaceObjectId[]): void {
    if (ids.length === 0) return;
    for (const id of ids)
      if (this.#eraserRollback !== null && !this.#eraserRollback.before.has(id))
        this.#eraserRollback.before.set(id, this.#model.objects[id]);
    captureGeometryOwnershipForIds(this.#model, ids);
    this.#onBeforeMutate?.(ids);
  }

  /**
   * Keep the inner selection controller's spatial/connector/derived
   * indexes (and compiled-geometry invalidation) in sync after a verb
   * that writes canonical records directly. Best-effort: index refresh
   * never breaks mutation.
   */
  #synced(ids: readonly SurfaceObjectId[]): void {
    if (ids.length === 0) return;
    try {
      this.#inner.notifyExternalMutation(ids);
    } catch {
      // Index refresh never breaks mutation.
    }
  }

  // --- Tool management ---

  activeToolId(): string {
    return this.#activeToolId;
  }

  setTool(toolId: string): void {
    this.#assertAlive();
    if (this.#toolRegistry.get(toolId) === null) {
      throw new FroglightError(
        ErrorCodes.UNKNOWN_SURFACE_TOOL,
        `no registered surface tool: ${toolId}`,
      );
    }
    // An explicit choice wins over any temporary entry.
    this.#temporaryStack = [];
    this.#activate(toolId);
  }

  /**
   * Enter a tool temporarily (stylus double-tap, eraser end, barrel):
   * the current tool is pushed and restored by `exitTemporaryTool`.
   * Entering the already-active tool is a no-op.
   */
  enterTemporaryTool(toolId: string): void {
    this.#assertAlive();
    if (this.#toolRegistry.get(toolId) === null) {
      throw new FroglightError(
        ErrorCodes.UNKNOWN_SURFACE_TOOL,
        `no registered surface tool: ${toolId}`,
      );
    }
    if (toolId === this.#activeToolId) return;
    this.#temporaryStack.push(this.#activeToolId);
    this.#activate(toolId);
  }

  /**
   * Restore the tool active before the last temporary entry.
   * False (no switch) when no temporary tool is active.
   */
  exitTemporaryTool(): boolean {
    this.#assertAlive();
    const previous = this.#temporaryStack.pop();
    if (previous === undefined) return false;
    this.#activate(previous);
    return true;
  }

  #activate(toolId: string): void {
    if (toolId !== this.#activeToolId) {
      // Cancel the outgoing tool's in-flight gesture so a mid-gesture tool
      // switch never orphans a capture (old gesture drops, new tool starts
      // clean; history already no-ops for cancelled gestures).
      try {
        if (!this.#dispatchingGestureEnd) {
          if (this.#gestureDone !== null) this.pointerCancel();
          else if (this.#usesSelection()) this.#inner.pointerCancel();
          else
            this.#toolRegistry
              .get(this.#activeToolId)
              ?.onCancel?.(this.#context());
        }
      } catch {
        // Cancellation must never break the tool switch.
      }
      this.#pendingMutations = [];
    }
    this.#selectionGesture = false;
    this.#activeToolId = toolId;
    this.#preview = [];
    this.#snapGuides = [];
    this.#rulerSnapping = false;
    this.#onActiveToolChange?.(toolId);
  }

  // --- Straightedge ruler (slice 10, ephemeral) ---

  /** Current ruler state; `null` means hidden. Never canonical. */
  ruler(): SurfaceRulerState | null {
    return this.#ruler;
  }

  /**
   * Replace the ephemeral ruler. `null`/`undefined` hides it. Invalid
   * records hide it rather than breaking drawing. Never marks dirty,
   * never enters history or canonical data. A mid-gesture change never
   * retargets the in-flight stroke (it keeps its down-time decision).
   */
  setRuler(ruler: SurfaceRulerState | null | undefined): void {
    this.#assertAlive();
    if (ruler === null || ruler === undefined) {
      this.#ruler = null;
      return;
    }
    this.#ruler = isValidRulerState(ruler) ? ruler : null;
  }

  #isRulerCaptureTool(): boolean {
    return (
      this.#activeToolId === SURFACE_TOOL_IDS.pen ||
      this.#activeToolId === SURFACE_TOOL_IDS.fountain ||
      this.#activeToolId === SURFACE_TOOL_IDS.brush ||
      this.#activeToolId === SURFACE_TOOL_IDS.pencil ||
      this.#activeToolId === SURFACE_TOOL_IDS.highlighter
    );
  }

  #decideRulerSnap(event: NormalizedPointerEvent): void {
    this.#rulerSnapping = false;
    const ruler = this.#ruler;
    if (ruler === null || ruler.visible !== true) return;
    if (!isValidRulerState(ruler)) return;
    if (!this.#isRulerCaptureTool()) return;
    const camera = this.#inner.camera();
    const surface = viewToSurface(camera, event.point);
    // Finite-segment latch with a screen-constant tolerance: far beyond
    // the visible endpoints never snaps, and zoom never changes the feel.
    const threshold = rulerSnapThresholdSurface(camera.zoom);
    if (shouldSnapToRuler(surface, ruler, threshold)) {
      this.#rulerSnapping = true;
    }
  }

  #snapEvent(event: NormalizedPointerEvent): NormalizedPointerEvent {
    const ruler = this.#ruler;
    if (ruler === null) return event;
    const camera = this.#inner.camera();
    const projected = projectPointToRuler(
      viewToSurface(camera, event.point),
      ruler,
    );
    return { ...event, point: surfaceToView(camera, projected) };
  }

  #snapEvents(
    events: readonly NormalizedPointerEvent[],
  ): readonly NormalizedPointerEvent[] {
    if (!this.#rulerSnapping) return events;
    return events.map((event) => this.#snapEvent(event));
  }

  /**
   * Ephemeral preview overlay of the active gesture plus snap guides
   * plus the ruler guide when visible; gesture items empty when idle.
   * None of it ever enters canonical data.
   */
  previewItems(): readonly DrawItem[] {
    return [
      ...this.#preview,
      ...this.#snapGuides,
      ...rulerToDrawItems(this.#ruler),
    ];
  }

  // --- Pointer routing ---

  /**
   * Route selection without changing the chosen tool. Contextual touch keeps
   * the selected bounds as its drag target, including space between members.
   */
  pointerDown(
    event: NormalizedPointerEvent,
    selectionGesture: boolean | 'touch' = false,
  ): void {
    this.#assertAlive();
    if (
      selectionGesture === false &&
      this.#activeToolId === SURFACE_TOOL_IDS.eraser &&
      this.#erasureError !== null &&
      this.#erasureJobs.size === 0
    )
      this.retryErasure();
    this.#selectionGesture = selectionGesture !== false;
    this.#gestureDone?.();
    if (
      !this.#usesSelection() &&
      this.#activeToolId === SURFACE_TOOL_IDS.eraser
    ) {
      if (this.#onGestureCancel === null)
        this.#eraserRollback = { before: new Map(), order: [] };
      ownSurfaceWork(
        this.#model,
        new Promise<void>((resolve) => {
          this.#gestureDone = resolve;
        }),
      );
    }
    this.#onGestureStart?.();
    if (this.#usesSelection()) {
      this.#inner.pointerDown(event, selectionGesture === 'touch');
      return;
    }
    this.#pendingMutations = [];
    this.#preview = [];
    this.#decideRulerSnap(event);
    try {
      this.#dispatch(
        'onDown',
        this.#rulerSnapping ? this.#snapEvent(event) : event,
      );
      this.#flushMutations();
    } catch (error) {
      this.pointerCancel();
      throw error;
    }
  }

  pointerMove(event: NormalizedPointerEvent): void {
    this.#assertAlive();
    if (this.#usesSelection()) {
      this.#inner.pointerMove(event);
      return;
    }
    try {
      this.#dispatch(
        'onMove',
        this.#rulerSnapping ? this.#snapEvent(event) : event,
      );
      this.#flushMutations();
    } catch (error) {
      this.pointerCancel();
      throw error;
    }
  }

  /**
   * Dispatch one confirmed input batch to the active tool. Tools with
   * `onBatch` consume it in a single call (one preview publish); older
   * tools fall back to per-event `onMove`. Mid-gesture only: history
   * transactions still span down→up.
   */
  pointerBatch(events: readonly NormalizedPointerEvent[]): void {
    this.#assertAlive();
    if (this.#usesSelection()) {
      for (const event of events) this.#inner.pointerMove(event);
      return;
    }
    const snapped = this.#snapEvents(events);
    const tool = this.#toolRegistry.get(this.#activeToolId);
    try {
      if (tool?.onBatch !== undefined) {
        tool.onBatch(this.#context(), snapped);
      } else {
        for (const event of snapped) this.#dispatch('onMove', event);
      }
      this.#flushMutations();
    } catch (error) {
      this.pointerCancel();
      throw error;
    }
  }

  /** End one bounded-paper ink run without closing its physical gesture. */
  pointerRunEnd(event: NormalizedPointerEvent): void {
    this.#assertAlive();
    if (this.#usesSelection()) return;
    this.#toolRegistry
      .get(this.#activeToolId)
      ?.onRunEnd?.(this.#context(), this.#snapEvent(event));
    this.#flushMutations();
    this.#preview = [];
  }

  /** Begin a new bounded-paper ink run inside the same history gesture. */
  pointerRunStart(event: NormalizedPointerEvent): void {
    this.#assertAlive();
    if (this.#usesSelection()) return;
    this.#toolRegistry
      .get(this.#activeToolId)
      ?.onRunStart?.(this.#context(), this.#snapEvent(event));
    this.#flushMutations();
  }

  /** Commit a physical gesture whose last visible run ended before lift. */
  pointerRunsComplete(): void {
    this.#assertAlive();
    this.#toolRegistry
      .get(this.#activeToolId)
      ?.onRunsComplete?.(this.#context());
    this.#preview = [];
    this.#snapGuides = [];
    this.#rulerSnapping = false;
    this.#onGestureEnd?.();
  }

  /**
   * Ephemeral predicted tail for the live gesture. Preview-only: tools
   * without `onPredicted` ignore it, and it never reaches canonical
   * samples, history, or dirty state.
   */
  pointerPredicted(events: readonly NormalizedPointerEvent[]): void {
    this.#assertAlive();
    if (this.#usesSelection()) return;
    this.#toolRegistry
      .get(this.#activeToolId)
      ?.onPredicted?.(this.#context(), this.#snapEvents(events));
    this.#flushMutations();
  }

  /**
   * Hold signal for the active gesture (draw-and-hold): dispatches
   * `onHold` to the active non-select tool, which may arm a conversion
   * that `onUp` finalizes. Safe no-op without a gesture or hook.
   */
  gestureHold(): void {
    this.#assertAlive();
    if (this.#usesSelection()) return;
    this.#toolRegistry.get(this.#activeToolId)?.onHold?.(this.#context());
    this.#flushMutations();
  }

  pointerUp(event: NormalizedPointerEvent): void {
    this.#assertAlive();
    if (this.#usesSelection()) {
      // The browser may deliver the lift coordinate without a final
      // pointermove (notably touch/stylus and synthetic input). Apply that
      // last position before closing; the selection controller tracks its
      // applied delta, so an echoed endpoint is idempotent.
      this.#inner.pointerMove(event);
      this.#inner.pointerUp(event);
      this.#selectionGesture = false;
      this.#onGestureEnd?.();
      return;
    }
    try {
      this.#dispatch(
        'onUp',
        this.#rulerSnapping ? this.#snapEvent(event) : event,
      );
      this.#flushMutations();
      this.#onGestureEnd?.();
      this.#eraserRollback = null;
    } catch (error) {
      this.pointerCancel();
      throw error;
    } finally {
      this.#gestureDone?.();
      this.#gestureDone = null;
    }
    // Previews are strictly mid-gesture state; commits render through
    // the normal pipeline instead. The ruler overlay persists (it is
    // not gesture state); only the snap latch clears.
    this.#preview = [];
    this.#snapGuides = [];
    this.#rulerSnapping = false;
  }

  /** Abort the active gesture: never commits, always clears preview. */
  pointerCancel(): void {
    this.#assertAlive();
    if (this.#usesSelection()) {
      this.#inner.pointerCancel();
      this.#selectionGesture = false;
      this.#onGestureCancel?.();
      return;
    }
    try {
      this.#dispatch('onCancel');
    } finally {
      this.#gestureDone?.();
      this.#gestureDone = null;
      this.#pendingMutations = [];
      this.#preview = [];
      this.#snapGuides = [];
      this.#rulerSnapping = false;
      const rollback = this.#eraserRollback;
      this.#eraserRollback = null;
      if (rollback !== null) {
        for (const [id, record] of rollback.before) {
          if (record === undefined) delete this.#model.objects[id];
          else this.#model.objects[id] = record;
        }
        applySurfaceOrderEdits(this.#model.order, rollback.order, true);
        this.#inner.notifyExternalMutation([...rollback.before.keys()]);
        this.#onMutate?.([...rollback.before.keys()]);
      }
      this.#onGestureCancel?.();
    }
  }

  // --- Delegated camera/selection semantics ---

  wheel(event: NormalizedWheelEvent): Camera {
    return this.#inner.wheel(event);
  }

  panBy(deltaView: Point): void {
    this.#inner.panBy(deltaView);
  }

  zoomAtView(viewPoint: Point, factor: number): void {
    this.#inner.zoomAtView(viewPoint, factor);
  }

  camera(): Camera {
    return this.#inner.camera();
  }

  setCamera(camera: Camera): void {
    this.#inner.setCamera(camera);
  }

  isAuthoringTool(): boolean {
    return (
      this.#toolRegistry.get(this.#activeToolId)?.interactionRole !==
      'selection'
    );
  }

  touchSelectionTarget(
    viewPoint: Point,
  ): ReturnType<SurfaceInteractionController['touchSelectionTarget']> {
    return this.#inner.touchSelectionTarget(viewPoint);
  }

  selection(): readonly SurfaceObjectId[] {
    return this.#inner.selection();
  }

  setSelection(ids: readonly SurfaceObjectId[]): void {
    this.#inner.setSelection(ids);
  }

  /** Union bounds of the current selection; null when empty or boundless. */
  selectionBounds(): Bounds | null {
    return selectionBoundsFor(
      this.#model,
      this.#objectRegistry,
      this.#inner.selection(),
    );
  }

  /** Semantic selection snapshot for context UI; null without geometry. */
  selectionContext(): SelectionContextSnapshot | null {
    const ids = this.#inner.selection();
    const bounds = this.selectionBounds();
    if (ids.length === 0 || bounds === null) return null;
    const members = resolveGroupMembers(this.#model, ids);
    const records = members.map((id) => this.#model.objects[id]);
    const kinds = SELECTION_KIND_ORDER.filter((kind) =>
      records.some(
        (record) => record !== undefined && contentKindOf(record) === kind,
      ),
    );
    const color = commonStyle(records.map(colorOfRecord));
    const width = commonStyle(records.map(widthOfRecord));
    const opacity = commonStyle(records.map(opacityOfRecord));
    const groups = ids.filter((id) => {
      const record = this.#model.objects[id];
      return record?.type === SURFACE_OBJECT_TYPES.group;
    });
    const handles = selectionHandles(
      this.#model,
      this.#objectRegistry,
      ids,
      this.#inner.camera().zoom,
    );
    const shapes = records.filter(
      (record) =>
        record?.type === SURFACE_OBJECT_TYPES.rectangle ||
        record?.type === SURFACE_OBJECT_TYPES.ellipse,
    );
    const shapeModes = new Set(
      shapes.map((record) =>
        record?.stroke === undefined ? 'fill' : 'outline',
      ),
    );
    const shapeAppearance =
      shapes.length === 0
        ? undefined
        : shapeModes.size === 1
          ? shapeModes.values().next().value
          : 'mixed';
    const single =
      ids.length === 1 ? this.#model.objects[ids[0] ?? ''] : undefined;
    const singleRotatable =
      single !== undefined &&
      (single.type === SURFACE_OBJECT_TYPES.rectangle ||
        single.type === SURFACE_OBJECT_TYPES.ellipse ||
        single.type === SURFACE_OBJECT_TYPES.text ||
        single.type === SURFACE_OBJECT_TYPES.image ||
        single.type === SURFACE_OBJECT_TYPES.card);
    return {
      ids: [...ids],
      ...(single?.type === SURFACE_OBJECT_TYPES.card
        ? {
            card: {
              fill: typeof single.fill === 'string' ? single.fill : '#ffffff',
              size: typeof single.size === 'number' ? single.size : 14,
            },
          }
        : {}),
      ...(single?.type === SURFACE_OBJECT_TYPES.line
        ? {
            connector: {
              path: typeof single.path === 'string' ? single.path : 'straight',
              arrows:
                typeof single.arrows === 'string' ? single.arrows : 'none',
            },
          }
        : {}),
      ...(single?.type === SURFACE_OBJECT_TYPES.rectangle ||
      single?.type === SURFACE_OBJECT_TYPES.ellipse
        ? {
            cornerRadius:
              typeof single.cornerRadius === 'number'
                ? single.cornerRadius
                : single.shape === 'rounded'
                  ? 12
                  : 0,
            canRoundCorners: single.type === SURFACE_OBJECT_TYPES.rectangle,
          }
        : {}),
      ...(single?.type === SURFACE_OBJECT_TYPES.rectangle
        ? {
            shape:
              typeof single.shape === 'string' && single.shape !== 'rounded'
                ? single.shape
                : 'rectangle',
          }
        : {}),
      bounds,
      ...(singleRotatable ? { rotation: rotationOf(single) } : {}),
      kinds,
      ...(color.value !== undefined ? { color: color.value } : {}),
      colorMixed: color.mixed,
      ...(width.value !== undefined ? { width: width.value } : {}),
      widthMixed: width.mixed,
      ...(opacity.value !== undefined ? { opacity: opacity.value } : {}),
      opacityMixed: opacity.mixed,
      ...(shapeAppearance !== undefined ? { shapeAppearance } : {}),
      groups: [...groups],
      ...(handles.length > 0 ? { handles } : {}),
    };
  }

  /**
   * Duplicate the selection with fresh identities on top of paint order.
   * Groups duplicate structurally (members plus a rewired group); the
   * selection follows the copies. One mutation event per call.
   */
  duplicateSelection(): SurfaceObjectId[] {
    this.#assertAlive();
    const selection = this.#inner.selection();
    const copies: SurfaceObjectId[] = [];
    const remap = new Map<SurfaceObjectId, SurfaceObjectId>();
    const copyRecord = (id: SurfaceObjectId): SurfaceObjectId | null => {
      const record = this.#model.objects[id];
      if (record === undefined || record.type === SURFACE_OBJECT_TYPES.group) {
        return null;
      }
      const copyId = this.#idFactory();
      this.#before([copyId]);
      this.#model.objects[copyId] = {
        ...(JSON.parse(JSON.stringify(record)) as SurfaceObjectRecord),
        id: copyId,
      };
      this.#model.order.push(copyId);
      copies.push(copyId);
      remap.set(id, copyId);
      return copyId;
    };
    const newGroups: SurfaceObjectId[] = [];
    for (const id of selection) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      if (record.type !== SURFACE_OBJECT_TYPES.group) {
        if (!remap.has(id)) copyRecord(id);
        continue;
      }
      const children = Array.isArray(record.children)
        ? (record.children as unknown[])
        : [];
      const newChildren: SurfaceObjectId[] = [];
      for (const child of children) {
        if (typeof child !== 'string') continue;
        const existing = remap.get(child);
        if (existing !== undefined) {
          newChildren.push(existing);
          continue;
        }
        // Missing records and nested groups copy to nothing: the copy
        // must never rewire to original children (no dangling or shared
        // references between duplicate and source).
        const copy = copyRecord(child);
        if (copy !== null) newChildren.push(copy);
      }
      const groupId = this.#idFactory();
      this.#before([groupId]);
      this.#model.objects[groupId] = groupObject(groupId, {
        children: newChildren,
      });
      this.#model.order.push(groupId);
      newGroups.push(groupId);
    }
    const result = [...copies, ...newGroups];
    if (result.length === 0) return [];
    // Rewire copied connector bindings to the copies: a duplicated line
    // bound to a duplicated shape must follow the copy, never the original.
    for (const copyId of copies) {
      const copy = this.#model.objects[copyId] as
        | SurfaceObjectRecord
        | undefined;
      if (copy?.type !== SURFACE_OBJECT_TYPES.line) continue;
      const source = copy.source as { objectId?: unknown } | undefined;
      const target = copy.target as { objectId?: unknown } | undefined;
      let rewired = false;
      if (
        typeof source?.objectId === 'string' &&
        remap.has(source.objectId as SurfaceObjectId)
      ) {
        this.#before([copyId]);
        (copy as Record<string, unknown>).source = {
          ...(source as Record<string, unknown>),
          objectId: remap.get(source.objectId as SurfaceObjectId)!,
        };
        rewired = true;
      }
      if (
        typeof target?.objectId === 'string' &&
        remap.has(target.objectId as SurfaceObjectId)
      ) {
        if (!rewired) this.#before([copyId]);
        (copy as Record<string, unknown>).target = {
          ...(target as Record<string, unknown>),
          objectId: remap.get(target.objectId as SurfaceObjectId)!,
        };
      }
    }
    this.#inner.setSelection(result);
    this.#synced(result);
    this.#onMutate?.(result);
    return result;
  }

  /**
   * Delete the selection and clear it. Selected groups dissolve with
   * their members. One mutation event per call.
   */
  deleteSelection(): SurfaceObjectId[] {
    this.#assertAlive();
    const selection = this.#inner.selection();
    const members = new Set(resolveGroupMembers(this.#model, selection));
    const groups = selection.filter((id) => {
      const record = this.#model.objects[id];
      return record?.type === SURFACE_OBJECT_TYPES.group;
    });
    const doomed = new Set([...members, ...groups]);
    const deleted = this.#model.order.filter((id) => doomed.has(id));
    if (deleted.length === 0) return [];
    this.#before(deleted);
    for (const id of deleted) {
      delete this.#model.objects[id];
      const index = this.#model.order.indexOf(id);
      if (index >= 0) this.#model.order.splice(index, 1);
    }
    this.#inner.setSelection([]);
    this.#synced(deleted);
    this.#onMutate?.(deleted);
    return deleted;
  }

  /**
   * Recolor/restyle the selection by type (strokes and lines take color,
   * width, opacity; text and cards take color; rectangles and ellipses
   * recolor through fill). Inapplicable members and garbage values are
   * ignored, never corrupting records. One mutation event per call.
   */
  setSelectionStyle(style: SelectionStyle): SurfaceObjectId[] {
    this.#assertAlive();
    const targets = resolveGroupMembers(this.#model, this.#inner.selection());
    // History contract: record BEFORE images before ANY canonical
    // mutation (multi-record batch). Connector followers reconciled below
    // capture their own befores inside the inner reconcile seam before
    // they are rewritten.
    if (targets.length > 0) this.#before(targets);
    const mutated: SurfaceObjectId[] = [];
    for (const id of targets) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      let changed = false;
      if (
        record.type === SURFACE_OBJECT_TYPES.rectangle &&
        typeof style.cornerRadius === 'number' &&
        Number.isFinite(style.cornerRadius) &&
        style.cornerRadius >= 0
      ) {
        (record as Record<string, unknown>).cornerRadius = style.cornerRadius;
        changed = true;
      }
      if (record.type === SURFACE_OBJECT_TYPES.card) {
        if (typeof style.fill === 'string') {
          (record as Record<string, unknown>).fill = style.fill;
          changed = true;
        }
        if (
          typeof style.textSize === 'number' &&
          Number.isFinite(style.textSize) &&
          style.textSize > 0
        ) {
          const mutable = record as Record<string, unknown>;
          mutable.size = style.textSize;
          mutable.height = Math.max(
            Number(record.height),
            textV2Lines(
              String(record.text ?? ''),
              style.textSize,
              Math.max(24, Number(record.width) - 16),
            ).length *
              style.textSize *
              1.25 +
              16,
          );
          changed = true;
        }
      }
      if (
        record.type === SURFACE_OBJECT_TYPES.rectangle &&
        style.shape !== undefined &&
        ['rectangle', 'rounded', 'triangle', 'diamond'].includes(style.shape)
      ) {
        (record as Record<string, unknown>).shape = style.shape;
        changed = true;
      }
      if (record.type === SURFACE_OBJECT_TYPES.line) {
        if (style.linePath !== undefined) {
          (record as Record<string, unknown>).path = style.linePath;
          changed = true;
        }
        if (style.lineArrows !== undefined) {
          if (style.lineArrows === 'none')
            delete (record as Record<string, unknown>).arrows;
          else (record as Record<string, unknown>).arrows = style.lineArrows;
          changed = true;
        }
      }
      if (
        (style.shapeAppearance === 'fill' ||
          style.shapeAppearance === 'outline') &&
        (record.type === SURFACE_OBJECT_TYPES.rectangle ||
          record.type === SURFACE_OBJECT_TYPES.ellipse)
      ) {
        const color = colorOfRecord(record) ?? '#37352f';
        if (style.shapeAppearance === 'outline') {
          if (record.stroke !== color || record.fill !== undefined) {
            (record as Record<string, unknown>).stroke = color;
            delete (record as Record<string, unknown>).fill;
            if (finiteNumber(record.strokeWidth) === null)
              (record as Record<string, unknown>).strokeWidth = 2;
            changed = true;
          }
        } else if (record.fill !== color || record.stroke !== undefined) {
          (record as Record<string, unknown>).fill = color;
          delete (record as Record<string, unknown>).stroke;
          changed = true;
        }
      }
      if (typeof style.color === 'string') {
        if (
          record.type === SURFACE_OBJECT_TYPES.stroke ||
          record.type === SURFACE_OBJECT_TYPES.text ||
          record.type === SURFACE_OBJECT_TYPES.line ||
          record.type === SURFACE_OBJECT_TYPES.card
        ) {
          if (record.color !== style.color) {
            (record as Record<string, unknown>).color = style.color;
            changed = true;
          }
        } else if (
          record.type === SURFACE_OBJECT_TYPES.rectangle ||
          record.type === SURFACE_OBJECT_TYPES.ellipse
        ) {
          const colorKey = record.stroke === undefined ? 'fill' : 'stroke';
          if (record[colorKey] !== style.color) {
            (record as Record<string, unknown>)[colorKey] = style.color;
            changed = true;
          }
        }
      }
      if (
        typeof style.width === 'number' &&
        Number.isFinite(style.width) &&
        style.width > 0
      ) {
        if (
          (record.type === SURFACE_OBJECT_TYPES.stroke ||
            record.type === SURFACE_OBJECT_TYPES.line) &&
          record.width !== style.width
        ) {
          (record as Record<string, unknown>).width = style.width;
          changed = true;
        }
        if (
          (record.type === SURFACE_OBJECT_TYPES.rectangle ||
            record.type === SURFACE_OBJECT_TYPES.ellipse) &&
          record.stroke !== undefined &&
          record.strokeWidth !== style.width
        ) {
          (record as Record<string, unknown>).strokeWidth = style.width;
          changed = true;
        }
      }
      if (
        typeof style.opacity === 'number' &&
        Number.isFinite(style.opacity) &&
        style.opacity >= 0 &&
        style.opacity <= 1
      ) {
        if (
          (record.type === SURFACE_OBJECT_TYPES.stroke ||
            record.type === SURFACE_OBJECT_TYPES.line) &&
          record.opacity !== style.opacity
        ) {
          (record as Record<string, unknown>).opacity = style.opacity;
          changed = true;
        }
      }
      // Grouped surface-text write path: additive
      // role/appearance mutation for `froglight.text` only. Unknown
      // roles/aligns/appearance members survive verbatim (merge, never
      // replace); no `formatVersion` bump; never feed measured widths
      // (wrap-on uses the fixed default). Non-text records ignore text
      // fields. Body writes leave size alone.
      if (record.type === SURFACE_OBJECT_TYPES.text) {
        const mutable = record as Record<string, unknown>;
        if (
          typeof style.textRole === 'string' &&
          isKnownTextRole(style.textRole)
        ) {
          // Effective-role comparison so Body on an implicit-body legacy
          // record (no `role`) and Body on an unknown-role record (effective
          // body) are no-ops preserving bytes verbatim. Explicit heading
          // writes still replace unknowns intentionally.
          const currentRole = isKnownTextRole(mutable.role)
            ? (mutable.role as string)
            : 'body';
          if (currentRole !== style.textRole) {
            mutable.role = style.textRole;
            changed = true;
          }
        }
        if (isValidTextSize(style.textSize)) {
          if (mutable.size !== style.textSize) {
            mutable.size = style.textSize;
            changed = true;
          }
          // Sync appearance.size when an appearance object exists so the
          // appearance-first effective size never diverges from rendering.
          const currentAppearance = textAppearanceOf(record);
          if (currentAppearance !== null) {
            if (currentAppearance.size !== style.textSize) {
              const next = { ...currentAppearance, size: style.textSize };
              if (writeTextAppearance(record, next)) changed = true;
            }
          }
        }
        if (typeof style.textBold === 'boolean') {
          const currentAppearance = textAppearanceOf(record);
          const isActive = currentAppearance?.bold === true;
          if (style.textBold && !isActive) {
            const next = { ...(currentAppearance ?? {}), bold: true };
            if (writeTextAppearance(record, next)) changed = true;
          } else if (!style.textBold && isActive) {
            const next = { ...(currentAppearance ?? {}) };
            delete next.bold;
            if (writeTextAppearance(record, next)) changed = true;
          }
        }
        if (typeof style.textItalic === 'boolean') {
          const currentAppearance = textAppearanceOf(record);
          const isActive = currentAppearance?.italic === true;
          if (style.textItalic && !isActive) {
            const next = { ...(currentAppearance ?? {}), italic: true };
            if (writeTextAppearance(record, next)) changed = true;
          } else if (!style.textItalic && isActive) {
            const next = { ...(currentAppearance ?? {}) };
            delete next.italic;
            if (writeTextAppearance(record, next)) changed = true;
          }
        }
        if (
          typeof style.textAlign === 'string' &&
          isKnownTextAlign(style.textAlign)
        ) {
          const currentAppearance = textAppearanceOf(record);
          // Effective-align comparison: absent/unknown reads `start`, so
          // Align-start on a legacy record is a no-op (no invented bytes).
          const currentAlign =
            currentAppearance !== null &&
            isKnownTextAlign(currentAppearance.align)
              ? (currentAppearance.align as string)
              : 'start';
          if (currentAlign !== style.textAlign) {
            const next = {
              ...(currentAppearance ?? {}),
              align: style.textAlign,
            };
            if (writeTextAppearance(record, next)) changed = true;
          }
        }
        if (typeof style.textWrap === 'boolean') {
          const currentAppearance = textAppearanceOf(record);
          const currentWrap =
            currentAppearance !== null &&
            isValidWrapWidth(currentAppearance.wrapWidth)
              ? (currentAppearance.wrapWidth as number)
              : null;
          if (style.textWrap && currentWrap === null) {
            const next = {
              ...(currentAppearance ?? {}),
              wrapWidth: TEXT_DEFAULT_WRAP_WIDTH,
            };
            if (writeTextAppearance(record, next)) changed = true;
          } else if (!style.textWrap && currentWrap !== null) {
            const next = { ...(currentAppearance ?? {}) };
            delete next.wrapWidth;
            if (writeTextAppearance(record, next)) changed = true;
          }
        }
      }
      if (changed) mutated.push(id);
    }
    if (mutated.length > 0) {
      this.#synced(mutated);
      this.#onMutate?.(mutated);
    }
    return mutated;
  }

  /**
   * Move the selection in paint order (multi-selections travel as a
   * stable block). One mutation event per effective call.
   */
  reorderSelection(where: ReorderDirection): SurfaceObjectId[] {
    this.#assertAlive();
    const selected = new Set(
      resolveGroupMembers(this.#model, this.#inner.selection()).filter(
        (id) => this.#model.objects[id] !== undefined,
      ),
    );
    const ordered = this.#model.order.filter((id) => selected.has(id));
    if (ordered.length === 0) return [];
    const order = this.#model.order;
    let next: SurfaceObjectId[] | null = null;
    if (where === 'front' || where === 'back') {
      const rest = order.filter((id) => !selected.has(id));
      next = where === 'front' ? [...rest, ...ordered] : [...ordered, ...rest];
    } else {
      next = [...order];
      if (where === 'forward') {
        for (let i = next.length - 2; i >= 0; i--) {
          if (selected.has(next[i]!) && !selected.has(next[i + 1]!)) {
            [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
          }
        }
      } else {
        for (let i = 1; i < next.length; i++) {
          if (selected.has(next[i]!) && !selected.has(next[i - 1]!)) {
            [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
          }
        }
      }
    }
    if (next.every((id, i) => id === order[i])) {
      return [...this.#inner.selection()];
    }
    this.#model.order.splice(0, order.length, ...next);
    this.#onMutate?.([...this.#inner.selection()]);
    return [...this.#inner.selection()];
  }

  /**
   * Uniformly scale the selection about a pivot (default: selection
   * center). Strokes scale samples; boxes scale origin and size; text
   * scales origin and font size; lines scale endpoints. One mutation.
   */
  scaleSelection(factor: number, center?: Point): SurfaceObjectId[] {
    this.#assertAlive();
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new FroglightError(
        ErrorCodes.FORMAT_LIMIT_EXCEEDED,
        'scale factor must be a finite positive number',
      );
    }
    const pivot = center ?? selectionCenterOf(this.selectionBounds());
    if (pivot === null) return [];
    const targets = resolveGroupMembers(this.#model, this.#inner.selection());
    // History contract: BEFORE images for the whole batch precede ANY
    // canonical mutation. Followers capture inside the inner reconcile
    // seam before they are rewritten.
    if (targets.length > 0) this.#before(targets);
    const mutated: SurfaceObjectId[] = [];
    for (const id of targets) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      scaleRecordAbout(record, factor, pivot);
      mutated.push(id);
    }
    if (mutated.length > 0) {
      // Reconciliation is canonical work, not a notification side effect:
      // it must run even when no mutation listener is attached.
      // Indexed (Slice 5): only bound connectors, never a full scan.
      const followed = this.#inner
        .reconcileConnectors(mutated)
        .filter((id) => !mutated.includes(id));
      const all = [...mutated, ...followed];
      this.#inner.notifyExternalMutation(all);
      this.#onMutate?.(all);
    }
    return mutated;
  }

  /**
   * Rotate the selection about a pivot (default: selection center),
   * clockwise-positive like every stored rotation. Strokes retain their
   * nib orientation in source space and rotate as rigid objects; lines
   * carry rotation in their endpoints. One mutation.
   */
  rotateSelection(deltaRadians: number, center?: Point): SurfaceObjectId[] {
    this.#assertAlive();
    if (!Number.isFinite(deltaRadians)) {
      throw new FroglightError(
        ErrorCodes.FORMAT_LIMIT_EXCEEDED,
        'rotation delta must be finite',
      );
    }
    const pivot = center ?? selectionCenterOf(this.selectionBounds());
    if (pivot === null) return [];
    const targets = resolveGroupMembers(this.#model, this.#inner.selection());
    const sourceCenters = new Map<SurfaceObjectId, Point>();
    for (const group of groupLogicalChunks(this.#model).values()) {
      const envelope = inkStrokeEnvelope(jointInkSourceRecord(group));
      if (envelope !== null)
        for (const id of group.chunkIds)
          sourceCenters.set(id, centerOfBounds(envelope));
    }
    // History contract: BEFORE images for the whole batch precede ANY
    // canonical mutation (followers via the inner reconcile seam).
    if (targets.length > 0) this.#before(targets);
    const mutated: SurfaceObjectId[] = [];
    for (const id of targets) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      rotateRecordAbout(record, deltaRadians, pivot, sourceCenters.get(id));
      mutated.push(id);
    }
    if (mutated.length > 0) {
      // Reconciliation is canonical work, not a notification side effect:
      // it must run even when no mutation listener is attached.
      const followed = this.#inner
        .reconcileConnectors(mutated)
        .filter((id) => !mutated.includes(id));
      const all = [...mutated, ...followed];
      this.#inner.notifyExternalMutation(all);
      this.#onMutate?.(all);
    }
    return mutated;
  }

  hitTest(surfacePoint: Point): SurfaceObjectId | null {
    return this.#inner.hitTest(surfacePoint);
  }

  moveSelectionBy(delta: Point): readonly SurfaceObjectId[] {
    return this.#inner.moveSelectionBy(delta);
  }

  canTranslateAll(): boolean {
    return this.#inner.canTranslateAll();
  }

  translateAllBy(delta: Point): readonly SurfaceObjectId[] {
    return this.#inner.translateAllBy(delta);
  }

  /** Ephemeral drag session for rendering (Slice 1, null when idle). */
  selectionDrag(): import('./selection-drag.js').SelectionDragSession | null {
    return this.#inner.selectionDrag();
  }

  dragDelta(): Point {
    return this.#inner.dragDelta();
  }

  dragTranslatedBounds(): import('./geometry.js').Bounds | null {
    return this.#inner.dragTranslatedBounds();
  }

  dragAffectedConnectors(): readonly SurfaceObjectId[] {
    return this.#inner.dragAffectedConnectors();
  }

  selectionBoundsCached(): import('./geometry.js').Bounds | null {
    return this.#inner.selectionBoundsCached();
  }

  controllerStats(): import('./controller.js').SurfaceControllerStats {
    return this.#inner.controllerStats();
  }

  spatialIndexStats(): import('./spatial-index.js').SurfaceSpatialIndexStats {
    return this.#inner.spatialIndexStats();
  }

  connectorIndexStats(): import('./connector-index.js').ConnectorIndexStats {
    return this.#inner.connectorIndexStats();
  }

  ensureIndexes(): void {
    this.#inner.ensureIndexes();
  }

  rebuildIndexes(): void {
    this.#inner.rebuildIndexes();
  }

  spatialQuery(
    bounds: import('./geometry.js').Bounds,
  ): readonly SurfaceObjectId[] {
    return this.#inner.queryRegion(bounds);
  }

  notifyExternalMutation(ids: readonly SurfaceObjectId[]): void {
    unusedInkSources(this.#model, ids);
    this.#inner.notifyExternalMutation(ids);
  }

  /**
   * Geometry-preserving translation (item 1): shift derived/spatial caches
   * by `(dx,dy)` without rescans or recompiles. For pure
   * `TranslateObjectsCommand` undo/redo and provider direct translates.
   */
  notifyTranslated(
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ): void {
    this.#inner.notifyTranslated(ids, dx, dy);
  }

  /** Alias for `notifyTranslated` (repair-brief `translateDerived` seam). */
  translateDerived(
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ): void {
    this.#inner.translateDerived(ids, dx, dy);
  }

  /** Seed indexes from decode (item 5): no Ink sample rescans. */
  seedIndexesFromDecode(
    seedBounds: ReadonlyMap<string, import('./geometry.js').Bounds | null>,
  ): void {
    this.#inner.seedIndexesFromDecode(seedBounds);
  }

  reconcileConnectors(
    ids: readonly SurfaceObjectId[],
  ): readonly SurfaceObjectId[] {
    return this.#inner.reconcileConnectors(ids);
  }

  /** Align the selection to its union edge/center (slice 9). */
  alignSelection(edge: AlignEdge): SurfaceObjectId[] {
    return this.#inner.alignSelection(edge);
  }

  /** Distribute the selection with equal gaps along an axis (slice 9). */
  distributeSelection(axis: DistributeAxis): SurfaceObjectId[] {
    return this.#inner.distributeSelection(axis);
  }

  /** Set or clear the locked flag on objects (slice 9). */
  setLocked(
    ids: readonly SurfaceObjectId[],
    locked: boolean,
  ): SurfaceObjectId[] {
    return this.#inner.setLocked(ids, locked);
  }

  /**
   * Group the current selection into one flat group record (slice 9).
   * Requires at least two members with none already grouped (no
   * nesting in v1). Selects the new group. Null when not groupable.
   */
  groupSelection(): SurfaceObjectId | null {
    this.#assertAlive();
    const members = resolveGroupMembers(this.#model, this.#inner.selection());
    if (members.length < 2) return null;
    for (const id of members) {
      if (groupOfMember(this.#model, id) !== null) return null;
    }
    const groupId = this.#idFactory();
    // Creation records an absent before-marker (no clone) so undo removes it.
    this.#before([groupId]);
    this.#model.objects[groupId] = groupObject(groupId, {
      children: [...members],
    });
    this.#model.order.push(groupId);
    this.#inner.setSelection([groupId]);
    this.#synced([groupId]);
    this.#onMutate?.([groupId]);
    return groupId;
  }

  /**
   * Dissolve selected groups back to members in place (slice 9).
   * Returns the resulting selection (members replace groups).
   */
  ungroupSelection(): SurfaceObjectId[] {
    this.#assertAlive();
    const selection = this.#inner.selection();
    const groups = selection.filter((id) => {
      const record = this.#model.objects[id];
      return record?.type === SURFACE_OBJECT_TYPES.group;
    });
    if (groups.length === 0) return [...selection];
    // History contract: before-images for deleted groups precede deletion
    // (otherwise undo cannot restore them — order-diff alone drops them).
    this.#before(groups);
    const members: SurfaceObjectId[] = [];
    for (const id of selection) {
      const record = this.#model.objects[id];
      if (record?.type !== SURFACE_OBJECT_TYPES.group) {
        members.push(id);
        continue;
      }
      for (const child of groupMembersOf(this.#model, id)) {
        if (!members.includes(child)) members.push(child);
      }
      delete this.#model.objects[id];
      const index = this.#model.order.indexOf(id);
      if (index >= 0) this.#model.order.splice(index, 1);
    }
    this.#inner.setSelection(members);
    this.#synced([...members, ...groups]);
    this.#onMutate?.([...members, ...groups]);
    return members;
  }

  /**
   * Create a bound connector between two objects or free points
   * (slice 9, whiteboard quick-connect without the drag). Object ends
   * resolve to live anchor points; free ends keep given coordinates.
   */
  connectEndpoints(
    source:
      | { objectId: SurfaceObjectId; anchor?: ConnectorAnchor }
      | { point: Point },
    target:
      | { objectId: SurfaceObjectId; anchor?: ConnectorAnchor }
      | { point: Point },
    style: {
      path?: ConnectorPath;
      arrows?: LineArrows;
      color?: string;
      width?: number;
      opacity?: number;
    } = {},
  ): SurfaceObjectId {
    this.#assertAlive();
    const resolveEnd = (
      end:
        | { objectId: SurfaceObjectId; anchor?: ConnectorAnchor }
        | { point: Point },
      fallback: Point,
    ): { point: Point; binding?: ConnectorEndpointBinding } => {
      if ('point' in end) return { point: { ...end.point } };
      const record = this.#model.objects[end.objectId];
      if (record === undefined) {
        throw new FroglightError(
          ErrorCodes.INVALID_ID,
          `unknown surface object: ${end.objectId}`,
        );
      }
      const anchor = end.anchor ?? 'center';
      if (
        anchor !== 'center' &&
        anchor !== 'n' &&
        anchor !== 's' &&
        anchor !== 'e' &&
        anchor !== 'w'
      ) {
        throw new FroglightError(
          ErrorCodes.RECORD_FORMAT_MISMATCH,
          `unknown connector anchor: ${String(anchor)}`,
        );
      }
      // Rotation-aware anchor through the type hook (repair pass item
      // 10); unhookable geometry falls back to the endpoint coords.
      let point = { ...fallback };
      try {
        const hook = this.#objectRegistry.get(record.type)?.connectorAnchor;
        if (hook !== undefined) {
          point = hook(record, anchor) ?? point;
        } else {
          const bounds = this.#objectRegistry
            .get(record.type)
            ?.boundsOf?.(record);
          if (bounds !== undefined && bounds !== null) {
            point = anchorPoint(bounds, anchor);
          }
        }
      } catch {
        // Hook failures keep the fallback coords (never break creation).
      }
      return {
        point,
        binding: { objectId: end.objectId, anchor },
      };
    };
    const from = resolveEnd(source, { x: 0, y: 0 });
    const to = resolveEnd(target, { x: 0, y: 0 });
    const id = this.#idFactory();
    // Creation absent-marker so undo removes the connector.
    this.#before([id]);
    this.#model.objects[id] = lineObject(id, {
      x: from.point.x,
      y: from.point.y,
      x2: to.point.x,
      y2: to.point.y,
      ...(style.color !== undefined ? { color: style.color } : {}),
      ...(style.width !== undefined ? { width: style.width } : {}),
      ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
      ...(style.arrows !== undefined ? { arrows: style.arrows } : {}),
      ...(style.path !== undefined ? { path: style.path } : {}),
      ...(from.binding !== undefined ? { source: from.binding } : {}),
      ...(to.binding !== undefined ? { target: to.binding } : {}),
    });
    this.#model.order.push(id);
    this.#synced([id]);
    this.#onMutate?.([id]);
    return id;
  }

  /**
   * Rebind one connector end to an object anchor, a free point, or
   * unbound (coords kept). Returns false when the record is missing.
   */
  rebindConnector(
    id: SurfaceObjectId,
    end: 'source' | 'target',
    binding:
      | { objectId: SurfaceObjectId; anchor?: ConnectorAnchor }
      | { point: Point }
      | null,
  ): boolean {
    this.#assertAlive();
    const record = this.#model.objects[id];
    if (record === undefined || record.type !== SURFACE_OBJECT_TYPES.line) {
      return false;
    }
    // History contract: before-image precedes ANY endpoint/coords rewrite.
    // Validate the target first (when bound) so a failed rebind records
    // nothing and leaves no empty patch.
    if (binding !== null && !('point' in binding)) {
      if (this.#model.objects[binding.objectId] === undefined) return false;
    }
    this.#before([id]);
    if (binding === null) {
      delete (record as Record<string, unknown>)[end];
    } else if ('point' in binding) {
      delete (record as Record<string, unknown>)[end];
      const px = end === 'source' ? 'x' : 'x2';
      const py = end === 'source' ? 'y' : 'y2';
      (record as Record<string, unknown>)[px] = binding.point.x;
      (record as Record<string, unknown>)[py] = binding.point.y;
    } else {
      const target = this.#model.objects[binding.objectId];
      if (target === undefined) return false;
      const anchor = binding.anchor ?? 'center';
      // Rotation-aware anchor through the type hook (same as creation);
      // unhookable geometry falls back to the unrotated anchor point.
      let point: Point | null = null;
      try {
        const hook = this.#objectRegistry.get(target.type)?.connectorAnchor;
        if (hook !== undefined) point = hook(target, anchor) ?? null;
      } catch {
        point = null;
      }
      if (point === null) {
        const bounds = this.#objectRegistry
          .get(target.type)
          ?.boundsOf?.(target);
        if (bounds === undefined || bounds === null) return false;
        point = anchorPoint(bounds, anchor);
      }
      const px = end === 'source' ? 'x' : 'x2';
      const py = end === 'source' ? 'y' : 'y2';
      (record as Record<string, unknown>)[px] = point.x;
      (record as Record<string, unknown>)[py] = point.y;
      (record as Record<string, unknown>)[end] = {
        objectId: binding.objectId,
        anchor,
      };
    }
    this.#synced([id]);
    this.#onMutate?.([id]);
    return true;
  }

  /**
   * Connect the first two selected objects center-to-center (quick
   * connect without the drag). Null when fewer than two are selected.
   * Arrows default to end-anchored like the whiteboard connector tool.
   */
  connectSelected(
    style: {
      path?: ConnectorPath;
      arrows?: LineArrows;
      color?: string;
      width?: number;
      opacity?: number;
    } = {},
  ): SurfaceObjectId | null {
    this.#assertAlive();
    const ids = resolveGroupMembers(this.#model, this.#inner.selection())
      .filter((id) => {
        const record = this.#model.objects[id];
        return (
          record !== undefined &&
          record.type !== SURFACE_OBJECT_TYPES.line &&
          this.#objectRegistry.get(record.type)?.boundsOf?.(record) != null
        );
      })
      .slice(0, 2);
    if (ids.length < 2) return null;
    return this.connectEndpoints(
      { objectId: ids[0]! },
      { objectId: ids[1]! },
      { arrows: 'end', ...style },
    );
  }

  /** Resize one selected-capable object through the shared transform seam. */
  resizeObject(
    id: SurfaceObjectId,
    size: { readonly width?: number; readonly height?: number },
  ): void {
    this.#inner.resizeObject(id, size);
  }

  destroy(): void {
    this.#assertAlive();
    if (this.#gestureDone !== null) this.pointerCancel();
    this.#destroyed = true;
    this.#preview = [];
    this.#gestureDone?.();
    this.#gestureDone = null;
    // Accepted region jobs own their worker until they settle. Teardown never
    // discards a confirmed cut or leaves save waiting on an abandoned lane.
    void Promise.all([...this.#erasureJobs]).finally(() => {
      if (this.#erasureError === null) this.#releaseErasureOwner();
    });
    this.#eraserObservation.dispose();
    this.#inner.destroy();
  }

  #releaseErasureOwner(): void {
    if (this.#erasureOwnerReleased) return;
    this.#erasureOwnerReleased = true;
    this.#erasureRetry.dispose();
    this.#erasurePreparation?.dispose();
    this.#knownErasureSources.clear();
  }

  // --- Internals ---

  #dispatch(
    hook: 'onDown' | 'onMove' | 'onUp' | 'onCancel',
    event?: NormalizedPointerEvent,
  ): void {
    const tool = this.#toolRegistry.get(this.#activeToolId);
    const ending = this.#dispatchingGestureEnd;
    this.#dispatchingGestureEnd ||= hook === 'onUp' || hook === 'onCancel';
    try {
      if (hook === 'onCancel') {
        tool?.onCancel?.(this.#context());
        return;
      }
      const handler = tool?.[hook];
      if (handler === undefined || event === undefined) return;
      handler(this.#context(), event);
    } finally {
      this.#dispatchingGestureEnd = ending;
    }
  }

  #context(): SurfaceToolContext {
    return {
      model: this.#model,
      objectRegistry: this.#objectRegistry,
      camera: () => this.#inner.camera(),
      queryRegion: (bounds) => this.#inner.queryRegion(bounds),
      newObjectId: () => this.#idFactory(),
      addObject: (record) => {
        // Pre-mutation ownership capture: no-op for a brand-new id, but it
        // shares the one recorder seam so every canonical mutation path
        // captures before-images consistently.
        this.#before([record.id]);
        this.#model.objects[record.id] = record;
        this.#model.order.push(record.id);
        this.#pendingMutations.push(record.id);
      },
      removeObject: (id) => {
        // Capture the old record reference + logical ownership BEFORE the
        // delete so invalidation can advance the old logical and clear
        // retained joint geometry on surviving peers.
        this.#before([id]);
        delete this.#model.objects[id];
        const index = this.#model.order.indexOf(id);
        if (index >= 0) this.#model.order.splice(index, 1);
        this.#pendingMutations.push(id);
      },
      replaceObject: (id, replacements) => {
        const index = this.#model.order.indexOf(id);
        if (index < 0) return;
        const ids = replacements.map((record) => record.id);
        this.#before([id, ...ids]);
        if (ids.length !== 1 || ids[0] !== id) delete this.#model.objects[id];
        if (ids.length !== 1 || ids[0] !== id)
          this.#model.order.splice(index, 1, ...ids);
        for (const record of replacements) {
          this.#erasurePositions.set(record, index);
          this.#model.objects[record.id] = record;
        }
        this.#pendingMutations.push(id, ...ids);
      },
      addSource: (record) => {
        this.#knownErasureSources.set(record.id, record);
        if (Object.keys(this.#model.objects).length >= 100_000)
          throw new FroglightError(
            'FORMAT_LIMIT_EXCEEDED',
            'Precision eraser source exceeds the Surface object limit',
          );
        this.#before([record.id]);
        this.#model.objects[record.id] = record;
        this.#pendingMutations.push(record.id);
      },
      stageErasure: (record) => {
        for (const previous of this.#stagedErasureRecords)
          if (previous.id === record.id)
            this.#stagedErasureRecords.delete(previous);
        this.#stagedErasureRecords.add(record);
        const source = this.#model.objects[record.sourceId as string]!;
        this.#knownErasureSources.set(source.id, source);
        this.#erasurePreparation?.stage(
          this.#erasureJob,
          record.id,
          inkRegion(record)!,
          this.#model.objects[record.sourceId as string]!,
          record.regionTransform as InkRegionTransform | undefined,
        );
      },
      finishErasure: (records) => this.#finishErasure(records),
      cancelErasure: () => {
        this.#stagedErasureRecords.clear();
        this.#erasurePreparation?.cancel(this.#erasureJob++);
      },
      setSelection: (ids) => this.#inner.setSelection(ids),
      selection: () => this.#inner.selection(),
      moveSelectionBy: (delta) => this.#inner.moveSelectionBy(delta),
      beginEphemeralMove: () => this.#inner.beginEphemeralMove(),
      updateEphemeralMove: (delta) => this.#inner.updateEphemeralMove(delta),
      commitEphemeralMove: () => this.#inner.commitEphemeralMove(),
      cancelEphemeralMove: () => this.#inner.cancelEphemeralMove(),
      exitTemporaryTool: () => this.exitTemporaryTool(),
      setPreview: (items) => {
        this.#preview = [...items];
        this.#onPreviewPublish?.();
      },
    };
  }

  #finishErasure(records: readonly SurfaceObjectRecord[]): void {
    const jobId = this.#erasureJob++;
    if (records.length === 0) {
      this.#erasurePreparation?.cancel(jobId);
      return;
    }
    if (this.#erasurePreparation === undefined) {
      const error = new FroglightError(
        'UNSUPPORTED',
        'Precision eraser component preparation requires an installed worker',
      );
      this.#erasureError = error;
      ownSurfaceWork(this.#model, Promise.reject(error));
      this.#onErasureError?.(error);
      return;
    }
    const revisions = records
      .map((record) => ({
        record,
        region: record.region,
        transform: record.regionTransform,
        rotation: record.rotation,
        snapshot: { ...record },
        source: this.#model.objects[record.sourceId as string]!,
        index: this.#erasurePositions.get(record) ?? 0,
      }))
      .sort((a, b) => a.index - b.index);
    this.#stagedErasureRecords.clear();
    const prepared = this.#erasurePreparation.finish(jobId);
    void prepared.catch(() => undefined);
    const preparing = this.#erasurePublication
      .then(() => prepared)
      .then((components) => {
        const before: SurfaceObjectRecord[] = [];
        const after: SurfaceObjectRecord[] = [];
        const origins = new Map<string, string>();
        const currentIds = new Set<string>();
        const historyOrder: import('./transactions.js').SurfaceOrderEdit[] = [];
        let orderOffset = 0;
        for (const revision of revisions) {
          const record = revision.record;
          const regions = components[record.id];
          if (regions === undefined)
            throw new FroglightError(
              'IO',
              'Incomplete precision eraser result',
            );
          // A newer accepted region, transform, deletion or undo owns this id now.
          const isCurrent =
            this.#model.objects[record.id] === record &&
            record.region === revision.region &&
            record.regionTransform === revision.transform &&
            record.rotation === revision.rotation;
          if (isCurrent) currentIds.add(record.id);
          if (regions.length === 0)
            throw new FroglightError('IO', 'Empty precision eraser refinement');
          before.push(revision.snapshot);
          const ids = this.#erasureFragmentIds.get(
            revision.region as object,
          ) ?? [record.id];
          while (ids.length < regions.length) ids.push(this.#idFactory());
          this.#erasureFragmentIds.set(revision.region as object, ids);
          for (let i = 0; i < regions.length; i++) {
            const prepared = regions[i]!;
            const visible = freezeInkValue(prepared.visible);
            if (
              !validInkVisible(visible, revision.source.outlineLength as number)
            )
              throw new FroglightError(
                'FORMAT_LIMIT_EXCEEDED',
                'Invalid precision eraser result',
              );
            const id = ids[i]!;
            origins.set(id, record.id);
            const replacement: SurfaceObjectRecord = {
              ...cloneInkRecord(isCurrent ? record : revision.snapshot),
              id,
              visible,
            };
            delete replacement.region;
            let contours = prepared.contours;
            if (prepared.polygonIndices !== undefined) {
              const draft = revision.region as InkErasure;
              if (
                prepared.polygonIndices.some(
                  (index) =>
                    !Number.isInteger(index) ||
                    index < 0 ||
                    index >= draft.length,
                )
              )
                throw new FroglightError(
                  'RECORD_CORRUPT',
                  'Invalid precision eraser component ownership',
                );
              contours = prepared.polygonIndices.map((index) => draft[index]!);
            }
            bindInkSource(
              replacement,
              revision.source,
              contours === undefined ? undefined : freezeInkValue(contours),
            );
            after.push(replacement);
          }
          const inserted = after
            .filter((candidate) => origins.get(candidate.id) === record.id)
            .map((candidate) => candidate.id);
          if (inserted.length > 1) {
            historyOrder.push({
              index: revision.index + orderOffset,
              removed: [record.id],
              inserted,
            });
            orderOffset += inserted.length - 1;
          }
        }
        if (before.length === 0) return;
        if (
          Object.keys(this.#model.objects).length +
            after.length -
            before.length >
          100_000
        )
          throw new FroglightError(
            'FORMAT_LIMIT_EXCEEDED',
            'Precision eraser exceeds the Surface object limit',
          );
        // Prepare group patches before publishing any object or order edit.
        const groups: SurfaceObjectRecord[] = [];
        for (const id of this.#model.order) {
          const group = this.#model.objects[id];
          if (
            group?.type !== SURFACE_OBJECT_TYPES.group ||
            !Array.isArray(group.children)
          )
            continue;
          if (!group.children.some((child) => currentIds.has(child))) continue;
          const children = group.children.flatMap((child) => {
            const source = before.find(
              (record) => record.id === child && currentIds.has(record.id),
            );
            return source === undefined
              ? [child]
              : after
                  .filter(
                    (record) =>
                      record.sourceId === source.sourceId &&
                      regionsFor(record, source),
                  )
                  .map((record) => record.id);
          });
          groups.push({ ...group, children });
        }
        const publish = () => {
          for (const record of before) {
            if (!currentIds.has(record.id)) continue;
            const replacements = after.filter((candidate) =>
              regionsFor(candidate, record),
            );
            const index = this.#model.order.indexOf(record.id);
            this.#model.order.splice(
              index,
              1,
              ...replacements.map((record) => record.id),
            );
            for (const replacement of replacements)
              this.#model.objects[replacement.id] = replacement;
          }
          for (const group of groups) this.#model.objects[group.id] = group;
          const ids = [
            ...currentIds,
            ...after
              .filter((record) => currentIds.has(origins.get(record.id)!))
              .map((record) => record.id),
            ...groups.map((record) => record.id),
          ];
          if (!this.#destroyed) this.#inner.notifyExternalMutation(ids);
          if (this.#destroyed) publishSurfaceObjects(this.#model, ids);
          else this.#onMutate?.(ids);
        };
        const refinement = {
          order: historyOrder,
          before: [
            ...before,
            ...groups.map((group) => this.#model.objects[group.id]!),
          ],
          after: [...after, ...groups],
        };
        atomicSurfaceTransaction(
          this.#model,
          [...refinement.before, ...refinement.after].map(
            (record) => record.id,
          ),
          () => {
            if (this.#onErasureRefinement !== undefined)
              this.#onErasureRefinement(refinement, publish);
            else publish();
          },
        );
        function regionsFor(
          candidate: SurfaceObjectRecord,
          source: SurfaceObjectRecord,
        ): boolean {
          return origins.get(candidate.id) === source.id;
        }
      })
      .catch((error) => {
        this.#erasureError = error;
        this.#onErasureError?.(error);
      });
    this.#erasurePublication = preparing;
    const owned = preparing.then(() => {
      if (this.#erasureError !== null) throw this.#erasureError;
    });
    ownSurfaceWork(this.#model, owned);
    this.#erasureJobs.add(preparing);
    void preparing.finally(() => {
      this.#erasureJobs.delete(preparing);
      if (
        this.#destroyed &&
        this.#erasureError === null &&
        this.#erasureJobs.size === 0
      )
        this.#releaseErasureOwner();
    });
  }

  #flushMutations(): void {
    if (this.#pendingMutations.length === 0) return;
    const ids = this.#pendingMutations;
    this.#pendingMutations = [];
    // Keep the inner selection controller's spatial/connector/derived
    // indexes fresh for subsequent drags/snaps (no full rebuild).
    try {
      this.#inner.notifyExternalMutation(ids);
    } catch {
      // Index refresh never breaks mutation.
    }
    this.#onMutate?.(ids);
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new FroglightError(
        ErrorCodes.SERVICE_DISPOSED,
        'the ink tool controller has been destroyed',
      );
    }
  }
}
